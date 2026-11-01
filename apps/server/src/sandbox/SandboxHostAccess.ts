// @effect-diagnostics nodeBuiltinImport:off - Effect has no DNS lookup.
import * as NodeDnsPromises from "node:dns/promises";

import { ClaudeSettings, defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { isPrivateNetworkHost, normalizeHostname } from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { readClaudeSettingsEndpoint } from "../provider/Drivers/ClaudeSkills.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlDrivers from "../sourceControl/builtInDrivers.ts";

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
  }
>()("t3/sandbox/SandboxHostAccess") {}

/**
 * True when every address is loopback, RFC 1918, link-local, shared CGNAT (Tailscale's
 * 100.64.0.0/10), or IPv6 ULA or link-local. Names are not judged: a `*.ts.net` Funnel host is
 * public. No addresses means the lookup failed, which says nothing about reachability.
 */
export const resolvesOnlyToPrivateNetwork = (addresses: ReadonlyArray<string>): boolean =>
  addresses.length > 0 && addresses.every((address) => isPrivateNetworkHost(address));

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

  // Resolved the way the default Claude instance resolves its endpoint (ClaudeProvider), so a
  // sandbox gets exactly what `claude` on this machine uses.
  const claude = Effect.gen(function* () {
    const instance = (yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null)))
      ?.providerInstances[CLAUDE_INSTANCE];
    const config = yield* decodeClaudeSettings(instance?.config ?? {}).pipe(
      Effect.orElseSucceed(() => ({ homePath: "" })),
    );
    const environment = yield* mergeProviderInstanceEnvironment(instance?.environment);
    const fromSettings = yield* readClaudeSettingsEndpoint(config, undefined, environment);
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

  const endpointIsPrivate = Effect.fn("SandboxHostAccess.endpointIsPrivate")(function* (
    baseUrl: string,
  ) {
    const hostname = hostnameOf(baseUrl);
    if (hostname === null) return false;
    // An IP literal resolves to itself.
    const addresses = yield* Effect.tryPromise(() =>
      NodeDnsPromises.lookup(hostname, { all: true, verbatim: true }),
    ).pipe(
      Effect.timeout(Duration.seconds(3)),
      Effect.map((entries) => entries.map((entry) => entry.address)),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    return resolvesOnlyToPrivateNetwork(addresses);
  });

  return SandboxHostAccess.of({ claude, githubToken, endpointIsPrivate });
});

export const layer = Layer.effect(SandboxHostAccess, make);

export const layerTest = (
  host: { readonly claude?: SandboxHostClaude; readonly githubToken?: string } = {},
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
        return hostname !== null && resolvesOnlyToPrivateNetwork([hostname]);
      }),
    }),
  );
