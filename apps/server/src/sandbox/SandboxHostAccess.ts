// @effect-diagnostics nodeBuiltinImport:off - Effect has no DNS lookup.
import * as NodeDnsPromises from "node:dns/promises";

import {
  ClaudeSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type SandboxHostTooling,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  isPrivateNetworkHost,
  isSharedAddressSpaceHost,
  isTailnetHost,
  normalizeHostname,
} from "@t3tools/shared/hostClassification";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  readClaudeSettingsEnv,
  resolveClaudeConfigDirPath,
} from "../provider/Drivers/ClaudeSkills.ts";
import * as ServerSettings from "../serverSettings.ts";
import { railwayCredentialsOf } from "./railwayApi.ts";
import * as SourceControlDrivers from "../sourceControl/builtInDrivers.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  type ClaudeFile,
  type HostMcpEntry,
  listHostMcpServers,
  listHostSkills,
  parseClaudeMcpServers,
  pickHostMcpEntries,
  readClaudeFiles,
} from "./sandboxHostTooling.ts";

/** Swallowed by its caller: an unresolvable host is simply not private. */
class HostLookupError extends Schema.TaggedError<HostLookupError>()("HostLookupError", {
  hostname: Schema.String,
}) {}

export interface SandboxHostClaude {
  /** The endpoint this server's own Claude talks to, from Claude's settings or its env. */
  readonly baseUrl?: string;
  readonly authToken?: Redacted.Redacted<string>;
}

/** What this server's own machine can share with a sandbox it provisions. Never sent to clients. */
export class SandboxHostAccess extends Context.Service<
  SandboxHostAccess,
  {
    readonly claude: Effect.Effect<SandboxHostClaude>;
    /** github.com's token as this server resolves it for its own GitHub calls. */
    readonly githubToken: Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
    /** The endpoint resolves only to private addresses, so a cloud sandbox likely cannot reach it. */
    readonly endpointIsPrivate: (baseUrl: string) => Effect.Effect<boolean>;
    /** The endpoint's Tailscale address, for an access rule that lets sandboxes reach it. */
    readonly endpointTailnetAddress: (baseUrl: string) => Effect.Effect<string | null>;
    /** What this machine has for an agent, as the config form lists it. Never a header value. */
    readonly tooling: Effect.Effect<SandboxHostTooling>;
    /** Git's global name and email here, or null when either is unset. */
    readonly gitIdentity: Effect.Effect<{ readonly name: string; readonly email: string } | null>;
    /** The MCP entries a sandbox gets for `names`, headers included; see `pickHostMcpEntries`. */
    readonly mcpEntries: (
      names: ReadonlyArray<string>,
      projectRoot: string | undefined,
    ) => Effect.Effect<ReadonlyArray<HostMcpEntry>>;
    /** CLAUDE.md and chosen skills as files relative to the Claude folder. */
    readonly claudeFiles: (input: {
      readonly claudeMd: boolean;
      readonly skills: ReadonlyArray<string>;
    }) => Effect.Effect<{
      readonly files: ReadonlyArray<ClaudeFile>;
      readonly skipped: ReadonlyArray<string>;
      readonly skills: ReadonlyArray<string>;
    }>;
  }
>()("t3/sandbox/SandboxHostAccess") {}

/**
 * True when every address is loopback, RFC 1918, link-local, shared CGNAT (Tailscale's
 * 100.64.0.0/10), or IPv6 ULA or link-local. Names are not judged: a `*.ts.net` Funnel host is
 * public. No addresses means the lookup failed, which says nothing about reachability.
 */
export const resolvesOnlyToPrivateNetwork = (addresses: ReadonlyArray<string>): boolean =>
  addresses.length > 0 && addresses.every((address) => isPrivateNetworkHost(address));

/** The first Tailscale address (100.64.0.0/10, then fd7a:115c:a1e0::/48), or null. */
export const tailnetAddressOf = (addresses: ReadonlyArray<string>): string | null =>
  addresses.find((address) => isSharedAddressSpaceHost(address)) ??
  addresses.find((address) => address.includes(":") && isTailnetHost(address)) ??
  null;

const hostnameOf = (baseUrl: string) => {
  const url = URL.parse(baseUrl);
  return url === null ? null : normalizeHostname(url.hostname);
};

const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const CLAUDE_INSTANCE = defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));

const nonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
};

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const drivers = yield* SourceControlDrivers.SourceControlDrivers;
  const git = yield* GitVcsDriver.GitVcsDriver;

  // Resolved the way the default Claude instance resolves its endpoint (ClaudeProvider), so a
  // sandbox gets exactly what `claude` on this machine uses.
  const claude = Effect.gen(function* () {
    const instance = (yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null)))
      ?.providerInstances[CLAUDE_INSTANCE];
    const config = yield* decodeClaudeSettings(instance?.config ?? {}).pipe(
      Effect.orElseSucceed(() => ({ homePath: "" })),
    );
    const environment = yield* mergeProviderInstanceEnvironment(instance?.environment);
    const fromSettings = yield* readClaudeSettingsEnv(config, undefined, environment);
    const baseUrl = nonEmpty(fromSettings.ANTHROPIC_BASE_URL ?? environment.ANTHROPIC_BASE_URL);
    const authToken = nonEmpty(
      fromSettings.ANTHROPIC_AUTH_TOKEN ?? environment.ANTHROPIC_AUTH_TOKEN,
    );
    return {
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(authToken === undefined ? {} : { authToken: Redacted.make(authToken) }),
    } satisfies SandboxHostClaude;
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  const credentialToken = drivers.find(({ driver }) => driver.kind === "github")?.instance
    .credentialToken;
  const githubToken =
    credentialToken === undefined
      ? Effect.succeed(Option.none<Redacted.Redacted<string>>())
      : credentialToken("github.com");

  const addressesOf = Effect.fn("SandboxHostAccess.addressesOf")(function* (baseUrl: string) {
    const hostname = hostnameOf(baseUrl);
    if (hostname === null) return [];
    // An IP literal resolves to itself.
    return yield* Effect.tryPromise({
      try: () => NodeDnsPromises.lookup(hostname, { all: true, verbatim: true }),
      catch: () => new HostLookupError({ hostname }),
    }).pipe(
      Effect.timeout(Duration.seconds(3)),
      Effect.map((entries) => entries.map((entry) => entry.address)),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
  });

  const endpointIsPrivate = Effect.fn("SandboxHostAccess.endpointIsPrivate")(function* (
    baseUrl: string,
  ) {
    return resolvesOnlyToPrivateNetwork(yield* addressesOf(baseUrl));
  });
  const endpointTailnetAddress = Effect.fn("SandboxHostAccess.endpointTailnetAddress")(function* (
    baseUrl: string,
  ) {
    return tailnetAddressOf(yield* addressesOf(baseUrl));
  });

  // Claude keeps ~/.claude.json next to its folder, or inside CLAUDE_CONFIG_DIR when one is set.
  const claudePaths = Effect.gen(function* () {
    const instance = (yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null)))
      ?.providerInstances[CLAUDE_INSTANCE];
    const config = yield* decodeClaudeSettings(instance?.config ?? {}).pipe(
      Effect.orElseSucceed(() => ({ homePath: "" })),
    );
    const environment = yield* mergeProviderInstanceEnvironment(instance?.environment);
    const configDirectory = yield* resolveClaudeConfigDirPath(config, environment);
    const home = yield* HostProcess.HomeDirectory;
    const stateFile =
      configDirectory === path.join(home, ".claude")
        ? path.join(home, ".claude.json")
        : path.join(configDirectory, ".claude.json");
    return { configDirectory, stateFile, home };
  }).pipe(Effect.provideService(Path.Path, path));

  const readMcpEntries = Effect.gen(function* () {
    const { stateFile } = yield* claudePaths;
    const text = yield* fileSystem.readFileString(stateFile).pipe(Effect.orElseSucceed(() => ""));
    return parseClaudeMcpServers(text);
  });

  const gitIdentity = Effect.gen(function* () {
    const { home } = yield* claudePaths;
    const read = (key: string) =>
      git.readConfigValue(home, key).pipe(
        Effect.map((value) => value?.trim() ?? ""),
        Effect.orElseSucceed(() => ""),
      );
    const name = yield* read("user.name");
    const email = yield* read("user.email");
    return name === "" || email === "" ? null : { name, email };
  });

  const tooling = Effect.gen(function* () {
    const { configDirectory } = yield* claudePaths;
    const saved = (yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null)))
      ?.sandboxTooling;
    const mapleReady = (saved?.mapleAdminKey ?? "") !== "";
    const railwayReady = saved !== undefined && railwayCredentialsOf(saved) !== undefined;
    const identity = yield* gitIdentity;
    return {
      ...(identity === null ? {} : { gitIdentity: identity }),
      claudeMd: yield* fileSystem
        .exists(path.join(configDirectory, "CLAUDE.md"))
        .pipe(Effect.orElseSucceed(() => false)),
      skills: yield* listHostSkills(path.join(configDirectory, "skills")),
      mcpServers: listHostMcpServers(yield* readMcpEntries, { mapleReady, railwayReady }),
    } satisfies SandboxHostTooling;
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  const mcpEntries = Effect.fn("SandboxHostAccess.mcpEntries")(function* (
    names: ReadonlyArray<string>,
    projectRoot: string | undefined,
  ) {
    return pickHostMcpEntries(yield* readMcpEntries, names, projectRoot);
  });

  const claudeFiles = Effect.fn("SandboxHostAccess.claudeFiles")(function* (input: {
    readonly claudeMd: boolean;
    readonly skills: ReadonlyArray<string>;
  }) {
    const { configDirectory } = yield* claudePaths;
    return yield* readClaudeFiles(configDirectory, input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  });

  return SandboxHostAccess.of({
    claude,
    githubToken,
    endpointIsPrivate,
    endpointTailnetAddress,
    tooling,
    gitIdentity,
    mcpEntries,
    claudeFiles,
  });
});

export const layer = Layer.effect(SandboxHostAccess, make);

export const layerTest = (
  host: {
    readonly claude?: SandboxHostClaude;
    readonly githubToken?: string;
    readonly tooling?: SandboxHostTooling;
    readonly gitIdentity?: { readonly name: string; readonly email: string };
    readonly mcpEntries?: ReadonlyArray<HostMcpEntry>;
    readonly claudeFiles?: ReadonlyArray<ClaudeFile>;
  } = {},
) =>
  Layer.succeed(
    SandboxHostAccess,
    SandboxHostAccess.of({
      claude: Effect.succeed(host.claude ?? {}),
      githubToken: Effect.succeed(
        Option.map(Option.fromUndefinedOr(host.githubToken), Redacted.make),
      ),
      // Tests never resolve DNS, so only an IP literal can be private.
      endpointIsPrivate: Effect.fn("SandboxHostAccess.endpointIsPrivate")(function* (
        baseUrl: string,
      ) {
        const hostname = hostnameOf(baseUrl);
        return yield* Effect.succeed(hostname !== null && resolvesOnlyToPrivateNetwork([hostname]));
      }),
      endpointTailnetAddress: Effect.fn("SandboxHostAccess.endpointTailnetAddress")(function* (
        baseUrl: string,
      ) {
        const hostname = hostnameOf(baseUrl);
        return yield* Effect.succeed(hostname === null ? null : tailnetAddressOf([hostname]));
      }),
      tooling: Effect.succeed(host.tooling ?? { claudeMd: false, skills: [], mcpServers: [] }),
      gitIdentity: Effect.succeed(host.gitIdentity ?? null),
      mcpEntries: Effect.fn("SandboxHostAccess.mcpEntries")(function* (
        names: ReadonlyArray<string>,
        projectRoot: string | undefined,
      ) {
        return yield* Effect.succeed(pickHostMcpEntries(host.mcpEntries ?? [], names, projectRoot));
      }),
      claudeFiles: Effect.fn("SandboxHostAccess.claudeFiles")(function* (input: {
        readonly claudeMd: boolean;
        readonly skills: ReadonlyArray<string>;
      }) {
        const files = (host.claudeFiles ?? []).filter(
          (file) =>
            (input.claudeMd && file.path === "CLAUDE.md") ||
            input.skills.some((skill) => file.path.startsWith(`skills/${skill}/`)),
        );
        return yield* Effect.succeed({
          files,
          skipped: input.skills.filter(
            (skill) => !files.some((file) => file.path.startsWith(`skills/${skill}/`)),
          ),
          skills: input.skills.filter((skill) =>
            files.some((file) => file.path.startsWith(`skills/${skill}/`)),
          ),
        });
      }),
    }),
  );
