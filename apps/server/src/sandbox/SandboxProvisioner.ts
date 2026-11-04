import {
  assessSandboxStart,
  DEFAULT_SANDBOX_MAX_RUNNING_MINUTES,
  DEFAULT_SANDBOX_TAILSCALE_TAG,
  ExecutionEnvironmentDescriptor,
  isSecretReference,
  ProjectId,
  WS_METHODS,
  type EnvironmentId,
  type SandboxAccess,
  type SandboxConfigsResult,
  type SandboxCreateInput,
  type SandboxCreateResult,
  type SandboxCredentialEnvironment,
  type SandboxCredentialEnvironmentsInput,
  type SandboxCredentialEnvironmentsResult,
  type SandboxDeleteConfigInput,
  type SandboxDeleteInput,
  type SandboxDeleteResult,
  type SandboxEnvironmentConfig,
  type SandboxHostAccess as SandboxHostAccessFacts,
  type SandboxLaunchCancelResult,
  type SandboxLaunchInput,
  type SandboxLaunchPairResult,
  type SandboxLaunchResult,
  type SandboxLaunchThreadInput,
  type SandboxOrphan,
  type SandboxSaveConfigInput,
  type SandboxSaveConfigResult,
  type SandboxSetupSnapshot,
  type SandboxSetupStageId,
  type SandboxSetupState,
  type ServerSettings as ServerSettingsValue,
  settingsSecretLiteral,
  type ThreadId,
  type UsageLimitSourceConfig,
  UsageLimitSourceId,
  type SandboxLifecycleInput,
  type SandboxLimitsInput,
  type SandboxLimitsResult,
  type SandboxListResult,
  type SandboxRecord,
  type SandboxResumeResult,
  type SandboxSaveTemplateInput,
  type SandboxSaveTemplateResult,
  type SandboxDeleteTemplateInput,
  type SandboxStopResult,
  type SandboxTemplatesInput,
  type SandboxTemplatesResult,
  SandboxProviderError,
  type SandboxProviderInfo,
  type SandboxProviderKind,
  type SandboxProvidersResult,
  type WorktreeSetupStageStatus,
} from "@t3tools/contracts";
import { COPYABLE_FILE_MAX_BYTES, isDefaultCopiedFile } from "@t3tools/shared/copiedFiles";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxRecords from "../persistence/SandboxRecords.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { type CliproxyHub, makeCliproxyApi } from "../usage/cliproxyApi.ts";
import * as SandboxHostAccess from "./SandboxHostAccess.ts";
import {
  CLAUDE_SETTINGS_SCRUB,
  claudeSettingsScript,
  endpointReachScript,
  ENSURE_TOOLS_SCRIPT,
  parseEndpointReach,
  parseMissingTools,
  parseRepositoryReport,
  parseTailscaleReport,
  repositoryScript,
  type SandboxScript,
  type SandboxTool,
  GITHUB_LOGIN_SCRUB,
  githubLoginScript,
  TAILSCALE_PROXY_URL,
  tailscaleProxyEnv,
  tailscaleScript,
  tailscaleScrub,
  writeFileScript,
} from "./sandboxSetup.ts";
import { makePairingKey, pairScript, type PairReport, readPairReport } from "./sandboxPairing.ts";
import { makeSandboxLaunchTracker } from "./sandboxLaunches.ts";
import { makeTailscaleApi, type TailscaleOAuthClient } from "./tailscaleApi.ts";
import {
  layerHttpClient,
  requestJson,
  shellQuote,
  type SandboxExecResult,
  type SandboxProviderConfig,
  type SandboxProviderDriver,
  type SandboxProviderStatus,
  type SandboxUsage,
} from "./SandboxProvider.ts";
import { SANDBOX_PROVIDER_DRIVERS } from "./providers/index.ts";

const SERVE_ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/u;

const serveEnvironmentPrefix = (environment: Readonly<Record<string, string>> | undefined) => {
  const entries = Object.entries(environment ?? {});
  if (entries.length === 0) return "";
  for (const [name] of entries) {
    if (!SERVE_ENVIRONMENT_NAME.test(name)) {
      throw new Error(`Invalid sandbox serve environment variable name '${name}'.`);
    }
  }
  return `env ${entries.map(([name, value]) => `${name}=${shellQuote(value)}`).join(" ")} `;
};

// Starts `t3 serve` only when nothing answers on its port, then waits for it. Shared by install and
// resume because providers without systemd do not bring the server back after a stop. The service
// unit cannot carry a serve environment, so a driver that sets one always runs under nohup.
const serveScript = (serveEnvironment: Readonly<Record<string, string>> | undefined) => {
  const nohup = `nohup ${serveEnvironmentPrefix(serveEnvironment)}t3 serve --host 0.0.0.0 --port 3773 >"$HOME/.t3/sandbox-server.log" 2>&1 &
    echo "$!" >"$HOME/.t3/sandbox-server.pid"`;
  const start =
    Object.keys(serveEnvironment ?? {}).length > 0
      ? `  ${nohup}`
      : `  if command -v systemctl >/dev/null 2>&1 && t3 service install >/dev/null 2>&1; then
    sudo -n loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
    t3 service restart >/dev/null 2>&1 || true
  else
    ${nohup}
  fi`;
  return `if ! curl -fsS http://127.0.0.1:3773/.well-known/t3/environment >/dev/null 2>&1; then
${start}
fi
i=0
while [ "$i" -lt 90 ]; do
  if curl -fsS http://127.0.0.1:3773/.well-known/t3/environment >/dev/null 2>&1; then
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
# Headless serve logs a pairing token, URL, and QR code; providers keep this output.
tail -50 "$HOME/.t3/sandbox-server.log" | grep -v -i -e token -e pair -e 'app link' -e '█' -e '▀' -e '▄' >&2 || true
exit 1`;
};

const installScript = (label: string) => `set -eu
export PATH="$HOME/.local/bin:$PATH"
# The label file is read by \`t3 serve\` itself, so it works on providers without sudo, systemd,
# or a writable /etc/machine-info. The hostname is only a convenience for the machine's UI.
mkdir -p "$HOME/.t3"
printf '%s\n' ${shellQuote(label)} >"$HOME/.t3/environment-label"
if command -v hostnamectl >/dev/null 2>&1; then
  sudo -n hostnamectl set-hostname --pretty ${shellQuote(label)} 2>/dev/null || true
fi
if ! command -v t3 >/dev/null 2>&1; then
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL -o "$installer" https://t3.codes/install.sh
  sh "$installer"
  rm -f "$installer"
  trap - EXIT
fi
export PATH="$HOME/.local/bin:$PATH"
if ! command -v t3 >/dev/null 2>&1; then
  echo "The t3 CLI did not install." >&2
  exit 1
fi`;

const startScript = (serveEnvironment: Readonly<Record<string, string>> | undefined) => `set -eu
export PATH="$HOME/.local/bin:$PATH"
if ! command -v t3 >/dev/null 2>&1; then
  echo "The t3 CLI is missing." >&2
  exit 1
fi
${serveScript(serveEnvironment)}`;

// A template copies the disk, and T3's userdata holds the environment id, auth sessions, and secrets:
// a sandbox started from it would answer as the source with the source's valid bearer sessions.
// So the server stops, by the PID it started or the owner of its port, and its state is removed.
// The installed binary stays, so install on the new sandbox skips the download.
const SCRUB_SCRIPT = `set -eu
export PATH="$HOME/.local/bin:$PATH"
answering() { curl -fsS http://127.0.0.1:3773/.well-known/t3/environment >/dev/null 2>&1; }
# Uninstalling the unit also keeps it from starting T3 on every sandbox made from the template.
if command -v t3 >/dev/null 2>&1; then
  t3 service uninstall >/dev/null 2>&1 || true
fi
pids=""
if command -v ss >/dev/null 2>&1; then
  pids="$(ss -H -ltnp 'sport = :3773' 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 || true)"
fi
if [ -f "$HOME/.t3/sandbox-server.pid" ]; then
  pids="$pids $(cat "$HOME/.t3/sandbox-server.pid")"
fi
for pid in $pids; do
  if tr '\\000' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'serve'; then
    kill "$pid" 2>/dev/null || true
  fi
done
i=0
while answering; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "T3 Code is still running, so its state was not removed." >&2
    exit 1
  fi
  sleep 1
done
rm -rf "$HOME/.t3/userdata" "$HOME/.t3/environment-label" "$HOME/.t3/usage-host-id"
${CLAUDE_SETTINGS_SCRUB}
${GITHUB_LOGIN_SCRUB}
${tailscaleScrub()}
rm -f "$HOME/.t3/sandbox-server.log" "$HOME/.t3/sandbox-server.pid"`;

// Lowercase words joined by dashes, so a hub key says which sandbox it belongs to.
const labelSlug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, 32)
    .replace(/-+$/u, "") || "sandbox";

const TOOL_LABELS: Record<SandboxTool, string> = {
  git: "git",
  gh: "The GitHub CLI",
  claude: "Claude Code",
};

const tailnetHostname = (label: string) => `t3-sandbox-${labelSlug(label)}`;

const unreachableEndpointWarning = (
  baseUrl: string,
  isPrivate: boolean,
  tailnetTag: string | undefined,
) => {
  const host = URL.parse(baseUrl)?.host ?? baseUrl;
  if (tailnetTag !== undefined) {
    return `The sandbox joined your tailnet but cannot reach ${host}. Check that your tailnet policy lets ${tailnetTag} reach it.`;
  }
  return isPrivate
    ? `The sandbox cannot reach ${host}. It is only reachable from your private network or tailnet; let the sandbox join your tailnet, expose it publicly (for example with Tailscale Funnel or Cloudflare Tunnel), or use another endpoint.`
    : `The sandbox cannot reach ${host}. Check that it accepts connections from the internet, or use another endpoint.`;
};

// The join handles the key, so a failure keeps neither the driver's detail nor its output.
const TAILNET_JOIN_FAILED = "The sandbox could not join your tailnet.";

interface TailnetJoin {
  readonly client: TailscaleOAuthClient;
  readonly token: Redacted.Redacted<string>;
}

interface TailnetJoined {
  readonly deviceId: string;
  readonly proxy: boolean;
  readonly ip: string | undefined;
}

interface HubKey {
  readonly sourceId: string;
  readonly hub: CliproxyHub;
  readonly value: Redacted.Redacted<string>;
}

const asScript = (script: string | SandboxScript): SandboxScript =>
  typeof script === "string" ? { command: script } : script;

const PAIR_FAILURES: Record<Exclude<PairReport, { _tag: "token" }>["reason"], string> = {
  seal: "The sandbox has neither the openssl CLI nor Node.js, which T3 Code needs to receive its pairing code safely. Install openssl in the sandbox image.",
  pair: "t3 pair failed on the sandbox.",
  token: "The sandbox did not return a pairing code.",
  unreadable: "The sandbox did not return a pairing code.",
};

// An empty value is an unset field, which drivers see as absent.
const withSettings = (
  config: SandboxProviderConfig,
  overrides: Readonly<Record<string, string>> = {},
): SandboxProviderConfig => ({
  apiKey: config.apiKey,
  settings: Object.fromEntries(
    Object.entries({ ...config.settings, ...overrides }).filter(([, value]) => value !== ""),
  ),
});

// `starting` has no record state, and an `error` record means T3 is not serving on a machine the
// provider reports running, so neither overwrites what the record says.
const reconcileState = (
  current: SandboxRecord["state"],
  status: SandboxProviderStatus | null,
): SandboxRecord["state"] =>
  status === null || status === "starting" || (current === "error" && status === "running")
    ? current
    : status;

const findDriver = (kind: SandboxProviderKind): SandboxProviderDriver => {
  const driver = SANDBOX_PROVIDER_DRIVERS.find((candidate) => candidate.info.kind === kind);
  if (driver === undefined) {
    throw new Error(`No sandbox provider driver is registered for '${kind}'.`);
  }
  return driver;
};

interface ClaudeAccess {
  readonly baseUrl: string;
  readonly token: Redacted.Redacted<string>;
  readonly hubKey: HubKey | undefined;
}

/** Everything a create needs, settled before anything bills. */
interface Prepared {
  readonly input: SandboxCreateInput;
  readonly driver: SandboxProviderDriver;
  readonly config: SandboxProviderConfig;
  readonly label: string;
  readonly size: string;
  readonly maxRunningMinutes: number;
  readonly template: string | undefined;
  readonly access: SandboxAccess;
  readonly installCommand: string;
  readonly startCommand: string;
  readonly claude: ClaudeAccess | undefined;
  /** Where the hub key is kept, so the record written right after create can name it. */
  readonly hubKeySecret: string | undefined;
  readonly githubToken: Redacted.Redacted<string> | undefined;
  readonly tailnet: TailnetJoin | undefined;
}

/** What a provisioning attempt made so far; a failure or cancel releases all of it. */
interface Owned {
  sandbox?: { readonly id: string; readonly config: SandboxProviderConfig };
  deviceId?: string;
}

interface Reporter {
  readonly stage: (
    id: SandboxSetupStageId,
    status: WorktreeSetupStageStatus,
    detail?: string | null,
  ) => Effect.Effect<void>;
  readonly warn: (warning: string) => Effect.Effect<void>;
}

const silentReporter: Reporter = { stage: () => Effect.void, warn: () => Effect.void };

type RecordExtras = Pick<SandboxRecord, "configId" | "threadId" | "projectId" | "projectTitle">;

interface Machine {
  readonly prepared: Prepared;
  readonly sandboxId: string;
  readonly config: SandboxProviderConfig;
  readonly httpBaseUrl: string;
  readonly environmentId: EnvironmentId;
  readonly setup: SandboxCreateResult["setup"];
  readonly run: (
    script: string | SandboxScript,
    timeoutSeconds: number,
  ) => Effect.Effect<SandboxExecResult, SandboxProviderError>;
  readonly record: () => SandboxRecord;
  readonly save: (patch: Partial<SandboxRecord>) => Effect.Effect<SandboxRecord>;
}

const GITHUB_REMOTE =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/u;

/** The https clone URL of a github.com remote, or null; a credential in the URL is dropped. */
const githubCloneUrl = (remoteUrl: string) => {
  const match = GITHUB_REMOTE.exec(remoteUrl.trim());
  if (match === null) return null;
  return {
    url: `https://github.com/${match[1]}/${match[2]}.git`,
    name: match[2]!,
    owner: match[1]!,
  };
};

const sameDirectory = (path: string) =>
  path.length > 0 && !path.startsWith("/") && !path.split("/").some((part) => part === "..");

export class SandboxProvisioner extends Context.Service<
  SandboxProvisioner,
  {
    readonly providers: Effect.Effect<SandboxProvidersResult>;
    /**
     * Creates a sandbox that belongs to no thread, such as the one a template is saved from, and
     * returns a pairing code for the client that asked.
     */
    readonly create: (
      input: SandboxCreateInput,
    ) => Effect.Effect<SandboxCreateResult, SandboxProviderError>;
    readonly delete: (
      input: SandboxDeleteInput,
    ) => Effect.Effect<SandboxDeleteResult, SandboxProviderError>;
    readonly environments: (
      input: SandboxCredentialEnvironmentsInput,
    ) => Effect.Effect<SandboxCredentialEnvironmentsResult, SandboxProviderError>;
    readonly limits: (
      input: SandboxLimitsInput,
    ) => Effect.Effect<SandboxLimitsResult, SandboxProviderError>;
    readonly list: Effect.Effect<SandboxListResult, SandboxProviderError>;
    readonly stop: (
      input: SandboxLifecycleInput,
    ) => Effect.Effect<SandboxStopResult, SandboxProviderError>;
    readonly resume: (
      input: SandboxLifecycleInput,
    ) => Effect.Effect<SandboxResumeResult, SandboxProviderError>;
    readonly templates: (
      input: SandboxTemplatesInput,
    ) => Effect.Effect<SandboxTemplatesResult, SandboxProviderError>;
    /**
     * Resets T3 on the sandbox, saves its disk as a template, and deletes it: the sandbox's T3
     * identity is gone, so it could only come back as a different environment.
     */
    readonly saveTemplate: (
      input: SandboxSaveTemplateInput,
    ) => Effect.Effect<SandboxSaveTemplateResult, SandboxProviderError>;
    readonly deleteTemplate: (
      input: SandboxDeleteTemplateInput,
    ) => Effect.Effect<void, SandboxProviderError>;
    readonly configs: Effect.Effect<SandboxConfigsResult, SandboxProviderError>;
    readonly saveConfig: (
      input: SandboxSaveConfigInput,
    ) => Effect.Effect<SandboxSaveConfigResult, SandboxProviderError>;
    readonly deleteConfig: (
      input: SandboxDeleteConfigInput,
    ) => Effect.Effect<void, SandboxProviderError>;
    /** Starts provisioning a thread's sandbox on this server and returns at once. */
    readonly launch: (
      input: SandboxLaunchInput,
    ) => Effect.Effect<SandboxLaunchResult, SandboxProviderError>;
    readonly subscribeLaunch: (
      input: SandboxLaunchThreadInput,
    ) => Stream.Stream<SandboxSetupSnapshot | null>;
    /** Stops a launch and deletes what it made, or dismisses one that already failed. */
    readonly cancelLaunch: (
      input: SandboxLaunchThreadInput,
    ) => Effect.Effect<SandboxLaunchCancelResult>;
    readonly retryLaunch: (
      input: SandboxLaunchThreadInput,
    ) => Effect.Effect<void, SandboxProviderError>;
    /** Runs `t3 pair` on the launched sandbox; the code goes only to the caller. */
    readonly pairLaunch: (
      input: SandboxLaunchThreadInput,
    ) => Effect.Effect<SandboxLaunchPairResult, SandboxProviderError>;
    /** The client paired and holds the thread's project, so the launch is done. */
    readonly completeLaunch: (
      input: SandboxLaunchThreadInput,
    ) => Effect.Effect<void, SandboxProviderError>;
    /** Stops sandboxes past their running limit and syncs every other record with its provider. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/sandbox/SandboxProvisioner") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const records = yield* SandboxRecords.SandboxRecordRepository;
  const configStore = yield* SandboxRecords.SandboxConfigRepository;
  const environmentIdentity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const workspaceFiles = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  // Launches outlive the request that started them: a client disconnecting must not strand a
  // half-made machine, so they run in the server's own scope.
  const launchScope = yield* Effect.scope;
  const tracker = yield* makeSandboxLaunchTracker;
  const httpClient = yield* HttpClient.HttpClient;
  const secureRandom = yield* SecureRandom.SecureRandom;
  const hostAccess = yield* SandboxHostAccess.SandboxHostAccess;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const secretResolver = yield* SecretResolver.SecretResolver;
  const hubApi = yield* makeCliproxyApi;
  const tailscaleApi = yield* makeTailscaleApi;
  const onHttp = Effect.provideService(HttpClient.HttpClient, httpClient);

  // A settings patch needs the key, and merges `settings` per field, so a save writes the key and
  // every declared field; an empty value is how a field is cleared.
  const resolveConfig = Effect.fn("SandboxProvisioner.resolveConfig")(function* (
    driver: SandboxProviderDriver,
    provided: {
      readonly apiKey?: string | undefined;
      readonly settings?: Readonly<Record<string, string>> | undefined;
    } = {},
  ) {
    const provider = driver.info.kind;
    const saved = (yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new SandboxProviderError({
            provider,
            stage: "config",
            detail: "Could not read the provider API key from this server's settings.",
            cause,
          }),
      ),
    )).sandboxProviders[provider];
    const providedKey = provided.apiKey?.trim() ?? "";
    const apiKey = providedKey || (saved?.apiKey.trim() ?? "");
    const fields = driver.info.settingsFields ?? [];
    const savedValue = (id: string) => saved?.settings[id]?.trim() ?? "";
    const values = Object.fromEntries(
      fields.map((field) => [
        field.id,
        (provided.settings?.[field.id] ?? savedValue(field.id)).trim(),
      ]),
    );
    if (apiKey === "") {
      return yield* new SandboxProviderError({
        provider,
        stage: "config",
        detail: `Add a ${driver.info.label} API key to create this sandbox.`,
      });
    }
    if (providedKey !== "" || fields.some((field) => values[field.id] !== savedValue(field.id))) {
      yield* settings
        .updateSettings({ sandboxProviders: { [provider]: { apiKey, settings: values } } })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SandboxProviderError({
                provider,
                stage: "config",
                detail: "Could not save the provider API key on this server.",
                cause,
              }),
          ),
        );
    }
    return withSettings({ apiKey, settings: {} }, values);
  });

  // A sandbox stays where it was created (Vercel's team and project) after the settings change;
  // a record without settings follows the current ones.
  const recordConfig = (driver: SandboxProviderDriver, record: SandboxRecord) =>
    resolveConfig(driver).pipe(
      Effect.map((config) => withSettings(config, record.providerSettings)),
    );

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const readRecord = (instanceId: string) =>
    records
      .get(instanceId)
      .pipe(
        Effect.orDie,
        Effect.map(
          Option.getOrThrowWith(() => new Error(`No sandbox record exists for ${instanceId}.`)),
        ),
      );

  // A key named by a secret reference that cannot be read fails, so Claude never falls back to a
  // copy of this machine's token.
  const cliproxyHub = (source: UsageLimitSourceConfig) =>
    requireSettingsSecret(secretResolver, source.managementKey).pipe(
      Effect.map((managementKey): CliproxyHub => ({ url: source.url, managementKey })),
    );

  const hasManagementKey = (source: UsageLimitSourceConfig) =>
    isSecretReference(source.managementKey) || settingsSecretLiteral(source.managementKey) !== "";

  // The first enabled CLIProxyAPI usage source with a management key is the hub new Claude keys go on.
  const hubSource = (value: ServerSettingsValue) =>
    Object.entries(value.usageLimitSources).find(
      ([, source]) => source.enabled && source.kind === "cliproxy" && hasManagementKey(source),
    );

  const tailscaleClient = (value: ServerSettingsValue): TailscaleOAuthClient | undefined => {
    const { clientId, clientSecret, tag } = value.sandboxTailscale;
    if (clientId === "" || clientSecret === "") return undefined;
    return {
      clientId,
      clientSecret: Redacted.make(clientSecret),
      tag: tag === "" ? DEFAULT_SANDBOX_TAILSCALE_TAG : tag,
    };
  };

  const tailscaleToken = (client: TailscaleOAuthClient) => tailscaleApi.accessToken(client);

  // Mints a single-use key and runs the join. A warning means it did not end up connected; `joined`
  // is set whenever the sandbox registered, so a failure can still remove the device.
  const joinTailnet = Effect.fn("SandboxProvisioner.joinTailnet")(function* (
    join: TailnetJoin,
    label: string,
    run: (
      script: string | SandboxScript,
      timeoutSeconds: number,
    ) => Effect.Effect<{ readonly stdout: string }, SandboxProviderError, HttpClient.HttpClient>,
  ): Effect.fn.Return<
    { readonly joined: TailnetJoined | null; readonly warning: string | null },
    never,
    HttpClient.HttpClient
  > {
    const authKey = yield* tailscaleApi
      .createAuthKey(join.token, {
        tag: join.client.tag,
        description: `T3 Code sandbox ${labelSlug(label)}`.slice(0, 50),
      })
      .pipe(Effect.result);
    if (authKey._tag === "Failure") {
      return { joined: null, warning: `${TAILNET_JOIN_FAILED} ${authKey.failure.detail}` };
    }
    const report = yield* run(
      tailscaleScript({
        authKey: Redacted.value(authKey.success),
        hostname: tailnetHostname(label),
      }),
      420,
    ).pipe(
      Effect.map((result) => parseTailscaleReport(result.stdout)),
      Effect.orElseSucceed(() => null),
    );
    const nodeId = report?.nodeId;
    const joined =
      nodeId === undefined
        ? null
        : { deviceId: nodeId, proxy: report?.mode === "userspace", ip: report?.ip };
    if (report?.state === "Running" && joined !== null) return { joined, warning: null };
    const reason =
      report?.error === "root"
        ? " Installing Tailscale needs root or passwordless sudo on the sandbox."
        : report?.error === "install"
          ? " Tailscale did not install."
          : report?.error === "start"
            ? " tailscaled did not start."
            : "";
    return { joined, warning: `${TAILNET_JOIN_FAILED}${reason}` };
  });

  // An ephemeral node is removed once it has been offline for a while, so a resumed sandbox may
  // need a new one. tailscaled is restarted first; only a sandbox that is not connected gets a key.
  const rejoinTailnet = Effect.fn("SandboxProvisioner.rejoinTailnet")(function* (
    record: SandboxRecord,
    run: (
      script: string | SandboxScript,
      timeoutSeconds: number,
    ) => Effect.Effect<{ readonly stdout: string }, SandboxProviderError, HttpClient.HttpClient>,
  ): Effect.fn.Return<
    { readonly tailscale: SandboxRecord["tailscale"]; readonly warning: string | null },
    never,
    HttpClient.HttpClient
  > {
    const current = record.tailscale;
    if (current === undefined) return { tailscale: undefined, warning: null };
    const status = yield* run(
      tailscaleScript({ hostname: tailnetHostname(record.label) }),
      420,
    ).pipe(
      Effect.map((result) => parseTailscaleReport(result.stdout)),
      Effect.orElseSucceed(() => null),
    );
    if (status?.state === "Running") return { tailscale: current, warning: null };
    const client = tailscaleClient(yield* settings.getSettings.pipe(Effect.orDie));
    if (client === undefined) {
      return {
        tailscale: current,
        warning:
          "The sandbox is no longer on your tailnet, and no Tailscale OAuth client is saved to rejoin it.",
      };
    }
    const token = yield* tailscaleToken(client).pipe(Effect.result);
    if (token._tag === "Failure") {
      return {
        tailscale: current,
        warning: `The sandbox could not rejoin your tailnet. ${token.failure.detail}`,
      };
    }
    const join = yield* joinTailnet({ client, token: token.success }, record.label, run);
    if (join.joined === null) return { tailscale: current, warning: join.warning };
    if (join.joined.deviceId !== current.deviceId) {
      yield* tailscaleApi.deleteDevice(token.success, current.deviceId).pipe(Effect.ignore);
    }
    return { tailscale: { deviceId: join.joined.deviceId }, warning: join.warning };
  });

  // Never blocks a delete: a device that cannot be removed becomes a warning naming it.
  const releaseTailnetDevice = Effect.fn("SandboxProvisioner.releaseTailnetDevice")(function* (
    record: Pick<SandboxRecord, "label" | "tailscale">,
  ) {
    const deviceId = record.tailscale?.deviceId;
    if (deviceId === undefined) return null;
    const warning = `T3 Code could not remove ${tailnetHostname(record.label)} from your tailnet. Remove it in the Tailscale admin console.`;
    const client = tailscaleClient(yield* settings.getSettings.pipe(Effect.orDie));
    if (client === undefined) return warning;
    const removed = yield* tailscaleToken(client).pipe(
      Effect.flatMap((token) => tailscaleApi.deleteDevice(token, deviceId)),
      Effect.tapError((error) =>
        Effect.logWarning("sandbox tailnet device removal failed", { detail: error.detail }),
      ),
      Effect.exit,
    );
    return Exit.isSuccess(removed) ? null : warning;
  });

  const hostAccessFacts = Effect.gen(function* () {
    const claude = yield* hostAccess.claude;
    const current = yield* settings.getSettings.pipe(Effect.orDie);
    const hub = hubSource(current);
    const github = Option.isSome(yield* hostAccess.githubToken);
    const tailscale = tailscaleClient(current) !== undefined;
    if (claude.baseUrl === undefined || (hub === undefined && claude.authToken === undefined)) {
      return { github, tailscale } satisfies SandboxHostAccessFacts;
    }
    return {
      claude: {
        baseUrl: claude.baseUrl,
        key: hub === undefined ? "copy" : "hub",
        privateNetwork: yield* hostAccess.endpointIsPrivate(claude.baseUrl),
      },
      github,
      tailscale,
    } satisfies SandboxHostAccessFacts;
  });

  const providers = Effect.gen(function* () {
    const value = yield* settings.getSettings.pipe(Effect.orDie);
    return {
      providers: SANDBOX_PROVIDER_DRIVERS.map((driver): SandboxProviderInfo => ({
        ...driver.info,
        defaultSize: driver.defaultSize,
        configured: (value.sandboxProviders[driver.info.kind]?.apiKey.trim() ?? "") !== "",
        ...(driver.info.settingsFields === undefined
          ? {}
          : { settings: value.sandboxProviders[driver.info.kind]?.settings ?? {} }),
        capabilities: {
          limits: driver.limits !== undefined,
          stopResume: driver.stop !== undefined && driver.resume !== undefined,
          credentialEnvironments: driver.listEnvironments !== undefined,
          templates:
            driver.saveTemplate !== undefined &&
            driver.listTemplates !== undefined &&
            driver.deleteTemplate !== undefined &&
            driver.stop !== undefined,
        },
      })),
      host: yield* hostAccessFacts,
    } satisfies SandboxProvidersResult;
  });

  // Refuses a start the provider would refuse or that cannot fit, before anything bills. Limits that
  // cannot be read never block: the provider stays the authority and reports its own error.
  const preflightStart = Effect.fn("SandboxProvisioner.preflightStart")(function* (
    driver: SandboxProviderDriver,
    config: SandboxProviderConfig,
    size: string | undefined,
  ) {
    if (driver.limits === undefined) return null;
    const limits = yield* onHttp(driver.limits({ config })).pipe(Effect.orElseSucceed(() => null));
    if (limits === null) return null;
    const { blocked } = assessSandboxStart(limits, {
      providerLabel: driver.info.label,
      nowMillis: DateTime.toEpochMillis(yield* DateTime.now),
      ...(size === undefined ? {} : { size }),
    });
    if (blocked !== null) {
      return yield* new SandboxProviderError({
        provider: driver.info.kind,
        stage: "config",
        code: blocked.code,
        detail: blocked.reason,
        ...(blocked.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: blocked.retryAfterSeconds }),
      });
    }
    return limits;
  });

  const configError = (provider: SandboxProviderKind, detail: string) =>
    new SandboxProviderError({ provider, stage: "config", detail });

  // Named after the sandbox so the hub's key list says where each key went.
  const mintHubKey = Effect.fn("SandboxProvisioner.mintHubKey")(function* (
    provider: SandboxProviderKind,
    label: string,
    [sourceId, source]: readonly [string, UsageLimitSourceConfig],
  ) {
    const hex = (yield* secureRandom.uuidV4()).replaceAll("-", "");
    // A UUIDv4's version and variant digits are fixed, so they are left out.
    const random = `${hex.slice(0, 12)}${hex.slice(13, 16)}${hex.slice(17, 18)}`;
    const value = `t3-sandbox-${labelSlug(label)}-${random}`;
    const failed = (detail: string) =>
      configError(
        provider,
        `Could not add a key for this sandbox on the CLIProxyAPI hub. ${detail}`,
      );
    const hub = yield* cliproxyHub(source).pipe(Effect.mapError((error) => failed(error.message)));
    yield* hubApi.addApiKey(hub, value).pipe(Effect.mapError((error) => failed(error.detail)));
    return { sourceId, hub, value: Redacted.make(value) } satisfies HubKey;
  });

  const revokeHubKey = (key: HubKey) =>
    hubApi.removeApiKey(key.hub, Redacted.value(key.value)).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("sandbox hub key revoke failed", {
          sourceId: key.sourceId,
          detail: error.detail,
        }),
      ),
    );

  const resolveClaudeAccess = Effect.fn("SandboxProvisioner.resolveClaudeAccess")(function* (
    input: SandboxCreateInput,
    label: string,
  ): Effect.fn.Return<ClaudeAccess | undefined, SandboxProviderError> {
    const requested = input.agentAccess?.claude;
    if (requested === undefined) return undefined;
    const endpoint = URL.parse(requested.baseUrl);
    if (endpoint === null || (endpoint.protocol !== "https:" && endpoint.protocol !== "http:")) {
      return yield* configError(input.provider, "Enter an http or https URL for Claude.");
    }
    const hub = hubSource(yield* settings.getSettings.pipe(Effect.orDie));
    // With a hub, every sandbox gets its own key, so deleting one never cuts off this machine.
    if (hub !== undefined) {
      const hubKey = yield* mintHubKey(input.provider, label, hub);
      return { baseUrl: requested.baseUrl, token: hubKey.value, hubKey };
    }
    const host = yield* hostAccess.claude;
    if (host.authToken === undefined) {
      return yield* configError(input.provider, "This server has no Claude token to share.");
    }
    return { baseUrl: requested.baseUrl, token: host.authToken, hubKey: undefined };
  });

  const resolveTailnet = Effect.fn("SandboxProvisioner.resolveTailnet")(function* (
    provider: SandboxProviderKind,
  ) {
    const client = tailscaleClient(yield* settings.getSettings.pipe(Effect.orDie));
    if (client === undefined) {
      return yield* configError(
        provider,
        "Add a Tailscale OAuth client under Sandboxes in Settings → Connections first.",
      );
    }
    const token = yield* tailscaleToken(client).pipe(
      Effect.mapError((error) =>
        configError(provider, `Could not sign in to Tailscale. ${error.detail}`),
      ),
    );
    return { client, token } satisfies TailnetJoin;
  });

  const storeHubKey = Effect.fn("SandboxProvisioner.storeHubKey")(function* (
    provider: SandboxProviderKind,
    key: HubKey,
  ) {
    const failed = () =>
      configError(provider, "Could not save the sandbox's hub key on this server.");
    const secret = `sandbox-hub-key-${yield* secureRandom.uuidV4()}`;
    yield* secrets
      .set(secret, new TextEncoder().encode(Redacted.value(key.value)))
      .pipe(Effect.mapError(failed));
    return secret;
  });

  // Every check that can refuse a create runs here, before the provider bills anything.
  const prepare = Effect.fn("SandboxProvisioner.prepare")(function* (input: SandboxCreateInput) {
    const driver = findDriver(input.provider);
    const config = yield* resolveConfig(driver, { apiKey: input.apiKey, settings: input.settings });
    const label = input.label?.trim() || `${driver.info.label} sandbox`;
    if (input.environment !== undefined && input.allowCredentials !== true) {
      return yield* configError(
        input.provider,
        "This sandbox would receive the credential environment's secrets. Confirm that explicitly first.",
      );
    }
    const access = input.access ?? "public";
    if (access === "tailnet" && input.joinTailnet !== true) {
      return yield* configError(
        input.provider,
        "A tailnet-only sandbox has to join your tailnet to be reachable.",
      );
    }
    const template = input.template?.trim() || undefined;
    let size = input.size?.trim() || driver.defaultSize;
    if (template !== undefined) {
      if (driver.listTemplates === undefined) {
        return yield* configError(
          input.provider,
          "This provider cannot start a sandbox from a template.",
        );
      }
      // Fails before anything bills when the template is gone, and the template decides the size.
      const listed = yield* onHttp(driver.listTemplates({ config }));
      const found = listed.templates.find((candidate) => candidate.name === template);
      if (found === undefined) {
        return yield* new SandboxProviderError({
          provider: input.provider,
          stage: "template",
          code: "not_found",
          detail: `${driver.info.label} has no template named ${template}.`,
        });
      }
      size = found.size ?? size;
    }
    const limits = yield* preflightStart(driver, config, size);
    // The provider's own auto-stop is the backstop, so a plan maximum below the limit lowers it.
    const maxRunningMinutes = Math.min(
      input.maxRunningMinutes ?? DEFAULT_SANDBOX_MAX_RUNNING_MINUTES,
      limits?.maxTtlMinutes ?? Infinity,
    );
    // Built before the machine exists, so a bad driver definition cannot strand a billed sandbox.
    const installCommand = installScript(label);
    const startCommand = startScript(driver.serveEnvironment);
    const githubToken =
      input.passGithubToken === true ? yield* hostAccess.githubToken : Option.none();
    if (input.passGithubToken === true && Option.isNone(githubToken)) {
      return yield* configError(input.provider, "This server has no GitHub token to share.");
    }
    // Signed in before anything bills, so a bad OAuth client costs nothing. The key itself is minted
    // just before the join, since it expires in minutes.
    const tailnet = input.joinTailnet === true ? yield* resolveTailnet(input.provider) : undefined;
    // Minted before anything bills, so a hub that refuses costs nothing; revoked on any failure.
    const claude = yield* resolveClaudeAccess(input, label);
    const hubKey = claude?.hubKey;
    const hubKeySecret =
      hubKey === undefined
        ? undefined
        : yield* storeHubKey(input.provider, hubKey).pipe(
            Effect.tapError(() => revokeHubKey(hubKey).pipe(Effect.ignore)),
          );
    return {
      input,
      driver,
      config,
      label,
      size,
      maxRunningMinutes,
      template,
      access,
      installCommand,
      startCommand,
      claude,
      hubKeySecret,
      githubToken: Option.getOrUndefined(githubToken),
      tailnet,
    } satisfies Prepared;
  });

  // Instances with a fiber still provisioning them; the sweep leaves their records alone.
  const liveInstances = new Map<string, Fiber.Fiber<unknown, unknown>>();

  // A machine that costs money must not survive a failure or an interruption, and neither may the
  // hub key, the tailnet device, or the record that point at it.
  const releaseOwned = (prepared: Prepared, owned: Owned, instanceId: string) =>
    Effect.all(
      [
        owned.sandbox === undefined
          ? Effect.void
          : onHttp(
              prepared.driver.destroy({
                config: owned.sandbox.config,
                sandboxId: owned.sandbox.id,
              }),
            ).pipe(Effect.ignore),
        prepared.claude?.hubKey === undefined
          ? Effect.void
          : revokeHubKey(prepared.claude.hubKey).pipe(Effect.ignore),
        prepared.hubKeySecret === undefined
          ? Effect.void
          : secrets.remove(prepared.hubKeySecret).pipe(Effect.ignore),
        prepared.tailnet === undefined || owned.deviceId === undefined
          ? Effect.void
          : tailscaleApi.deleteDevice(prepared.tailnet.token, owned.deviceId).pipe(Effect.ignore),
        records.remove(instanceId).pipe(Effect.ignore),
      ],
      { concurrency: "unbounded", discard: true },
    );

  // Create through start: the record exists from the moment the provider made the machine.
  const provisionMachine = Effect.fn("SandboxProvisioner.provisionMachine")(function* (
    prepared: Prepared,
    context: {
      readonly instanceId: string;
      readonly owned: Owned;
      readonly report: Reporter;
      readonly extras: RecordExtras;
    },
  ) {
    const { driver, config, label, size, input, claude, githubToken, tailnet } = prepared;
    const { report, owned } = context;
    const hostEnvironmentId = yield* environmentIdentity.getEnvironmentId;

    yield* report.stage("create", "running");
    const sandbox = yield* onHttp(
      driver.create({
        config,
        name: label,
        size,
        ttlMinutes: prepared.maxRunningMinutes,
        environment: input.environment,
        idempotencyKey: yield* secureRandom.uuidV4(),
        template: prepared.template,
        tags: { host: hostEnvironmentId, instance: context.instanceId },
        publishPort: prepared.access === "public",
      }),
    );
    const sandboxConfig = withSettings(config, sandbox.settings);
    owned.sandbox = { id: sandbox.id, config: sandboxConfig };
    const createdAt = yield* nowIso;
    let record: SandboxRecord = {
      instanceId: context.instanceId,
      environmentId: null,
      ...context.extras,
      provider: input.provider,
      sandboxId: sandbox.id,
      label,
      size,
      state: "provisioning",
      createdAt,
      updatedAt: createdAt,
      httpBaseUrl: prepared.access === "public" ? (sandbox.publicUrl ?? "") : "",
      access: prepared.access,
      runningSince: createdAt,
      maxRunningMinutes: prepared.maxRunningMinutes,
      ...(input.environment === undefined ? {} : { credentialEnvironment: input.environment }),
      ...(prepared.template === undefined ? {} : { template: prepared.template }),
      ...(Object.keys(sandboxConfig.settings).length === 0
        ? {}
        : { providerSettings: sandboxConfig.settings }),
      ...(claude?.hubKey === undefined || prepared.hubKeySecret === undefined
        ? {}
        : { claudeHubKey: { sourceId: claude.hubKey.sourceId, secret: prepared.hubKeySecret } }),
    };
    yield* records.put(record).pipe(Effect.orDie);
    const save = (patch: Partial<SandboxRecord>) =>
      nowIso.pipe(
        Effect.map((updatedAt) => {
          record = { ...record, ...patch, updatedAt };
          return record;
        }),
        Effect.tap((next) => records.put(next).pipe(Effect.orDie)),
      );
    const run = (script: string | SandboxScript, timeoutSeconds: number) =>
      onHttp(
        driver.execute({
          config: sandboxConfig,
          sandboxId: sandbox.id,
          timeoutSeconds,
          ...asScript(script),
        }),
      );

    const publicUrl =
      prepared.access === "tailnet"
        ? null
        : (sandbox.publicUrl ??
          (yield* onHttp(
            driver.exposePort({
              config: sandboxConfig,
              sandboxId: sandbox.id,
              port: driver.serverPort,
            }),
          )));
    yield* report.stage("create", "done");

    yield* report.stage("install", "running");
    yield* run(prepared.installCommand, 600);
    // Tools and agent setup run before T3 starts, so T3's first provider check already sees them.
    // A step that fails leaves a working sandbox and a warning; a command that carried a secret
    // keeps neither its request nor its output.
    const warnings: Array<string> = [];
    const warn = (warning: string) =>
      Effect.sync(() => warnings.push(warning)).pipe(Effect.andThen(report.warn(warning)));
    const missingTools = yield* run(ENSURE_TOOLS_SCRIPT, 300).pipe(
      Effect.map((result) => parseMissingTools(result.stdout)),
      Effect.orElseSucceed(() => null),
    );
    if (missingTools === null) {
      yield* warn("T3 Code could not check the sandbox for git, the GitHub CLI, and Claude Code.");
    } else {
      for (const tool of missingTools) {
        yield* warn(`${TOOL_LABELS[tool]} could not be installed on the sandbox.`);
      }
    }
    yield* report.stage("install", "done");
    const missing = (tool: SandboxTool) => missingTools?.includes(tool) === true;

    yield* report.stage("credentials", "running");
    const credentialWarnings = warnings.length;
    // Joined before Claude's settings are written, since a userspace tailnet needs Claude's proxy.
    const tailnetJoin =
      tailnet === undefined ? null : yield* onHttp(joinTailnet(tailnet, label, run));
    if (tailnetJoin !== null && tailnetJoin.joined !== null) {
      owned.deviceId = tailnetJoin.joined.deviceId;
      yield* save({ tailscale: { deviceId: tailnetJoin.joined.deviceId } });
    }
    if (tailnetJoin !== null && tailnetJoin.warning !== null) yield* warn(tailnetJoin.warning);
    const tailnetJoined =
      tailnetJoin !== null && tailnetJoin.warning === null ? tailnetJoin.joined : null;
    const tailscaleState: SandboxSetupState =
      tailnet === undefined ? "skipped" : tailnetJoined === null ? "failed" : "ready";
    const viaProxy = tailnetJoined?.proxy === true;

    const claudeWritten: SandboxSetupState =
      claude === undefined
        ? "skipped"
        : yield* run(
            claudeSettingsScript({
              ANTHROPIC_BASE_URL: claude.baseUrl,
              ANTHROPIC_AUTH_TOKEN: Redacted.value(claude.token),
              ...(viaProxy ? tailscaleProxyEnv : {}),
            }),
            60,
          ).pipe(
            Effect.as<SandboxSetupState>("ready"),
            Effect.catch(() =>
              warn(
                "Claude's settings could not be written on the sandbox. Set up Claude in its Providers settings.",
              ).pipe(Effect.as<SandboxSetupState>("failed")),
            ),
          );
    // The settings still go in without Claude Code, so installing it by hand later just works.
    const claudeInstalled: SandboxSetupState =
      claudeWritten === "ready" && missing("claude") ? "failed" : claudeWritten;
    // A private endpoint (a tailnet or LAN address) passes every check on this machine and then
    // times out in the sandbox. The hub key stays: fixing the network makes it work as is.
    const claudeState: SandboxSetupState =
      claude === undefined || claudeInstalled !== "ready"
        ? claudeInstalled
        : yield* run(
            endpointReachScript(claude.baseUrl, viaProxy ? TAILSCALE_PROXY_URL : undefined),
            30,
          ).pipe(
            Effect.map((result) => parseEndpointReach(result.stdout)),
            Effect.orElseSucceed(() => null),
            Effect.flatMap((reach) =>
              reach !== "unreachable"
                ? Effect.succeed<SandboxSetupState>("ready")
                : hostAccess.endpointIsPrivate(claude.baseUrl).pipe(
                    Effect.flatMap((isPrivate) =>
                      warn(
                        unreachableEndpointWarning(
                          claude.baseUrl,
                          isPrivate,
                          tailnetJoined === null ? undefined : tailnet?.client.tag,
                        ),
                      ),
                    ),
                    Effect.as<SandboxSetupState>("failed"),
                  ),
            ),
          );
    const githubState: SandboxSetupState =
      githubToken === undefined
        ? "skipped"
        : missing("gh")
          ? "failed"
          : yield* run(githubLoginScript(Redacted.value(githubToken)), 60).pipe(
              Effect.as<SandboxSetupState>("ready"),
              Effect.catch(() =>
                warn(
                  "GitHub could not be signed in on the sandbox. Run gh auth login in its terminal.",
                ).pipe(Effect.as<SandboxSetupState>("failed")),
              ),
            );
    // A tailnet-only sandbox has no other address, so without the join nothing can reach it.
    const tailnetIp = tailnetJoined?.ip;
    if (prepared.access === "tailnet" && tailnetIp === undefined) {
      return yield* new SandboxProviderError({
        provider: input.provider,
        stage: "start",
        detail:
          "The sandbox did not join your tailnet, so a tailnet-only sandbox cannot be reached. Check the Tailscale setup in Settings and try again.",
      });
    }
    const httpBaseUrl = publicUrl ?? `http://${tailnetIp}:${driver.serverPort}`;
    yield* report.stage(
      "credentials",
      warnings.length > credentialWarnings ? "warning" : "done",
      warnings.length > credentialWarnings ? "Finished with warnings" : null,
    );

    yield* report.stage("start", "running");
    yield* run(prepared.startCommand, 180);
    // A sandbox that answers with an id T3 already tracks was cloned with another environment's
    // identity and sessions; it must never be paired.
    const descriptor = yield* onHttp(
      requestJson({
        provider: input.provider,
        stage: "pair",
        schema: ExecutionEnvironmentDescriptor,
        request: HttpClientRequest.get(
          `${httpBaseUrl.replace(/\/+$/, "")}/.well-known/t3/environment`,
        ),
      }),
    );
    const existing = yield* records
      .findByEnvironmentId(descriptor.environmentId)
      .pipe(Effect.orDie);
    if (Option.isSome(existing) && existing.value.instanceId !== context.instanceId) {
      return yield* new SandboxProviderError({
        provider: input.provider,
        stage: "pair",
        detail:
          "The new sandbox answered as an environment that already exists, so it was deleted. Save the template again from a sandbox T3 Code set up.",
      });
    }
    yield* save({ environmentId: descriptor.environmentId, httpBaseUrl });
    yield* report.stage("start", "done");
    return {
      prepared,
      sandboxId: sandbox.id,
      config: sandboxConfig,
      httpBaseUrl,
      environmentId: descriptor.environmentId,
      setup: { claude: claudeState, github: githubState, tailscale: tailscaleState, warnings },
      run,
      record: () => record,
      save,
    } satisfies Machine;
  });

  const pairMachine = Effect.fn("SandboxProvisioner.pairMachine")(function* (machine: Machine) {
    const key = yield* makePairingKey;
    const paired = yield* machine.run(pairScript(key.publicKeyPem), 60);
    const report = readPairReport(paired.stdout, key.privateKey);
    if (report._tag === "token") return report.token;
    const status = report.exitCode === undefined ? "" : ` It exited with ${report.exitCode}.`;
    return yield* new SandboxProviderError({
      provider: machine.prepared.input.provider,
      stage: "pair",
      detail: `${PAIR_FAILURES[report.reason]}${status}`,
      ...(report.stderr === undefined ? {} : { cause: new Error(report.stderr) }),
    });
  });

  // Fiber bookkeeping for one provisioning attempt: the sweep skips its record while it runs.
  const tracked = Effect.fn("SandboxProvisioner.tracked")(function* <A, E>(
    instanceId: string,
    effect: Effect.Effect<A, E>,
  ) {
    const fiber = yield* effect.pipe(
      Effect.ensuring(Effect.sync(() => liveInstances.delete(instanceId))),
      Effect.forkIn(launchScope),
    );
    // A fiber that already finished has run its `ensuring`, so it is not live.
    if (fiber.pollUnsafe() === undefined) liveInstances.set(instanceId, fiber);
    return fiber;
  });

  const create = Effect.fn("SandboxProvisioner.create")(function* (input: SandboxCreateInput) {
    const prepared = yield* prepare(input);
    const instanceId = yield* secureRandom.uuidV4();
    const owned: Owned = {};
    const fiber = yield* tracked(
      instanceId,
      Effect.gen(function* () {
        const machine = yield* provisionMachine(prepared, {
          instanceId,
          owned,
          report: silentReporter,
          extras: {},
        });
        const pairingCode = yield* pairMachine(machine);
        yield* machine.save({ state: "running" });
        return {
          instanceId,
          provider: input.provider,
          sandboxId: machine.sandboxId,
          environmentId: machine.environmentId,
          label: prepared.label,
          httpBaseUrl: machine.httpBaseUrl,
          pairingCode,
          setup: machine.setup,
        } satisfies SandboxCreateResult;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : releaseOwned(prepared, owned, instanceId),
        ),
      ),
    );
    return yield* Fiber.join(fiber);
  });

  // One thread's launch: its fiber, and the signals the client sends it.
  interface Launch {
    readonly input: SandboxLaunchInput;
    readonly config: SandboxEnvironmentConfig;
    readonly instanceId: string;
    readonly fiber: Fiber.Fiber<void, SandboxProviderError>;
    /** Retries a stage that failed but kept its machine. */
    readonly retries: Queue.Queue<void>;
    readonly handoff: Deferred.Deferred<void>;
    ready: { readonly machine: Machine; readonly projectId: ProjectId } | null;
  }
  const launches = new Map<ThreadId, Launch>();

  const launchConfigError = (detail: string, provider: SandboxProviderKind = "boat") =>
    new SandboxProviderError({ provider, stage: "config", detail });

  const createInputFor = (
    config: SandboxEnvironmentConfig,
    project: SandboxLaunchInput["project"],
  ): SandboxCreateInput => ({
    provider: config.provider,
    label: `${project.title} on ${config.label}`,
    size: config.size,
    maxRunningMinutes: config.maxRunningMinutes,
    access: config.access,
    ...(config.template === undefined ? {} : { template: config.template }),
    ...(config.credentialEnvironment === undefined
      ? {}
      : { environment: config.credentialEnvironment, allowCredentials: true }),
    ...(config.claude === undefined ? {} : { agentAccess: { claude: config.claude } }),
    ...(config.passGithubToken ? { passGithubToken: true } : {}),
    ...(config.joinTailnet ? { joinTailnet: true } : {}),
  });

  const copyEnvFiles = Effect.fn("SandboxProvisioner.copyEnvFiles")(function* (
    machine: Machine,
    project: SandboxLaunchInput["project"],
    directory: string,
    selected: ReadonlyArray<string> | undefined,
  ) {
    const listed =
      selected !== undefined
        ? null
        : yield* workspaceEntries
            .listIgnoredFiles({ cwd: project.workspaceRoot })
            .pipe(Effect.option);
    const paths = (
      selected ??
      (listed === null || Option.isNone(listed)
        ? []
        : listed.value.files
            .filter(
              (file) =>
                file.byteLength <= COPYABLE_FILE_MAX_BYTES && isDefaultCopiedFile(file.path),
            )
            .map((file) => file.path))
    ).filter(sameDirectory);
    if (paths.length === 0) return { copied: 0, failed: [] as ReadonlyArray<string> };
    const failed: Array<string> = [];
    const { driver } = machine.prepared;
    const destination = (path: string) => `${directory}/${path}`;
    // The files API writes into existing directories with the provider's default mode.
    if (driver.uploadFile !== undefined) {
      const parents = [...new Set(paths.map((path) => destination(path).replace(/\/[^/]+$/u, "")))];
      yield* machine.run(`mkdir -p ${parents.map(shellQuote).join(" ")}`, 30).pipe(Effect.ignore);
    }
    for (const path of paths) {
      const read = yield* workspaceFiles
        .readFile({ cwd: project.workspaceRoot, relativePath: path })
        .pipe(Effect.option);
      if (Option.isNone(read) || read.value.truncated || read.value.exists === false) {
        failed.push(path);
        continue;
      }
      const content = read.value.contents;
      const written = yield* (
        driver.uploadFile === undefined
          ? machine.run(writeFileScript(destination(path), content), 60).pipe(Effect.asVoid)
          : onHttp(
              driver.uploadFile({
                config: machine.config,
                sandboxId: machine.sandboxId,
                path: destination(path),
                content,
              }),
            ).pipe(
              Effect.andThen(machine.run(`chmod 600 ${shellQuote(destination(path))}`, 30)),
              Effect.asVoid,
            )
      ).pipe(Effect.exit);
      if (Exit.isFailure(written)) failed.push(path);
    }
    return { copied: paths.length - failed.length, failed: failed as ReadonlyArray<string> };
  });

  const cloneProject = Effect.fn("SandboxProvisioner.cloneProject")(function* (
    machine: Machine,
    project: SandboxLaunchInput["project"],
  ) {
    const provider = machine.prepared.input.provider;
    const repository = githubCloneUrl(project.remoteUrl);
    if (repository === null) {
      return yield* new SandboxProviderError({
        provider,
        stage: "repo",
        detail: "Only projects with a github.com remote can start in a sandbox.",
      });
    }
    const cloned = yield* machine
      .run(
        repositoryScript({
          cloneUrl: repository.url,
          directory: repository.name,
          title: project.title,
          branch: project.baseRef,
        }),
        600,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new SandboxProviderError({
              provider,
              stage: "repo",
              detail: `Could not clone ${repository.owner}/${repository.name} on the sandbox.${machine.prepared.githubToken === undefined ? " A private repository needs the config to sign GitHub in." : ""}`,
              cause,
            }),
        ),
      );
    const report = parseRepositoryReport(cloned.stdout);
    if (report.directory === null || report.projectId === null) {
      return yield* new SandboxProviderError({
        provider,
        stage: "repo",
        detail:
          "The repository was cloned, but T3 Code on the sandbox did not add it as a project.",
      });
    }
    return { directory: report.directory, projectId: ProjectId.make(report.projectId) };
  });

  // Runs `effect` until it succeeds; each failure keeps the machine and waits for a retry. A cancel
  // interrupts the wait like any other stage.
  const untilRetried = Effect.fn("SandboxProvisioner.untilRetried")(function* <A, R>(
    launch: Pick<Launch, "retries">,
    threadId: ThreadId,
    stage: SandboxSetupStageId,
    effect: Effect.Effect<A, SandboxProviderError, R>,
  ) {
    while (true) {
      yield* tracker.stage(threadId, stage, "running", null);
      const result = yield* Effect.result(effect);
      if (result._tag === "Success") return result.success;
      yield* tracker.stage(threadId, stage, "failed", null);
      yield* tracker.update(threadId, {
        phase: "failed",
        error: result.failure.detail,
        recovery: "retry",
      });
      yield* Queue.take(launch.retries);
      yield* tracker.update(threadId, { phase: "running", error: null, recovery: null });
    }
  });

  const startLaunch = Effect.fn("SandboxProvisioner.startLaunch")(function* (
    input: SandboxLaunchInput,
    config: SandboxEnvironmentConfig,
  ) {
    const threadId = input.threadId;
    const instanceId = yield* secureRandom.uuidV4();
    const retries = yield* Queue.unbounded<void>();
    const handoff = yield* Deferred.make<void>();
    const reporter: Reporter = {
      stage: (id, status, detail) => tracker.stage(threadId, id, status, detail),
      warn: (warning) => tracker.warn(threadId, warning),
    };
    const state: { launch: Launch | null } = { launch: null };
    yield* tracker.begin({
      threadId,
      instanceId,
      configId: config.id,
      label: config.label,
      provider: config.provider,
    });
    const run = Effect.gen(function* () {
      yield* reporter.stage("preflight", "running");
      const prepared = yield* prepare(createInputFor(config, input.project));
      yield* reporter.stage("preflight", "done");
      const owned: Owned = {};
      yield* Effect.gen(function* () {
        const machine = yield* provisionMachine(prepared, {
          instanceId,
          owned,
          report: reporter,
          extras: {
            configId: config.id,
            threadId,
            projectId: input.project.id,
            projectTitle: input.project.title,
          },
        });
        const launch = state.launch!;
        const cloned = yield* untilRetried(
          launch,
          threadId,
          "repo",
          cloneProject(machine, input.project),
        );
        yield* reporter.stage("repo", "done", cloned.directory.replace(/^.*\/work\//u, "~/work/"));

        yield* reporter.stage("env-files", "running");
        const copied = yield* copyEnvFiles(
          machine,
          input.project,
          cloned.directory,
          config.envFiles[input.project.id],
        );
        if (copied.failed.length > 0) {
          yield* reporter.warn(`Could not copy ${copied.failed.join(", ")} to the sandbox.`);
        }
        yield* reporter.stage(
          "env-files",
          copied.failed.length > 0 ? "warning" : copied.copied === 0 ? "skipped" : "done",
          copied.failed.length > 0
            ? `${copied.failed.length} not copied`
            : copied.copied === 0
              ? "None to copy"
              : `${copied.copied} ${copied.copied === 1 ? "file" : "files"}`,
        );

        // The client pairs through `pairLaunch`, opens the project, and then completes the launch.
        launch.ready = { machine, projectId: cloned.projectId };
        yield* reporter.stage("pair", "running", null);
        yield* tracker.update(threadId, { awaitingHandoff: true });
        yield* Deferred.await(handoff);
        yield* machine.save({ state: "running" });
        yield* tracker.finish(threadId, "done");
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : releaseOwned(prepared, owned, instanceId),
        ),
      );
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Exit.hasInterrupts(exit)
            ? tracker.finish(threadId, "cancelled")
            : tracker.finish(threadId, "failed", {
                error: Option.match(Exit.findErrorOption(exit), {
                  onNone: () => "The sandbox could not be set up.",
                  onSome: (error) => error.detail,
                }),
                recovery: "relaunch",
              }),
      ),
    );
    const fiber = yield* tracked(instanceId, run);
    const launch: Launch = { input, config, instanceId, fiber, retries, handoff, ready: null };
    state.launch = launch;
    launches.set(threadId, launch);
    return { instanceId } satisfies SandboxLaunchResult;
  });

  const launch = Effect.fn("SandboxProvisioner.launch")(function* (input: SandboxLaunchInput) {
    const current = launches.get(input.threadId);
    if (current !== undefined && current.fiber.pollUnsafe() === undefined) {
      return yield* launchConfigError(
        "A sandbox is already starting for this thread.",
        current.config.provider,
      );
    }
    const found = yield* configStore.get(input.configId).pipe(Effect.orDie);
    if (Option.isNone(found)) {
      return yield* launchConfigError("This sandbox config no longer exists.");
    }
    const config = found.value;
    if (config.projectIds.length > 0 && !config.projectIds.includes(input.project.id)) {
      return yield* launchConfigError(
        `${config.label} is not set up for this project.`,
        config.provider,
      );
    }
    if (githubCloneUrl(input.project.remoteUrl) === null) {
      return yield* launchConfigError(
        "Only projects with a github.com remote can start in a sandbox.",
        config.provider,
      );
    }
    return yield* startLaunch(input, config);
  });

  const runningLaunch = (threadId: ThreadId) => {
    const current = launches.get(threadId);
    return current !== undefined && current.fiber.pollUnsafe() === undefined ? current : null;
  };

  const notReady = (provider: SandboxProviderKind) =>
    new SandboxProviderError({
      provider,
      stage: "pair",
      detail: "This sandbox is not ready to connect yet.",
    });

  const pairLaunch = Effect.fn("SandboxProvisioner.pairLaunch")(function* (
    input: SandboxLaunchThreadInput,
  ) {
    const current = runningLaunch(input.threadId);
    if (current === null || current.ready === null) {
      return yield* notReady(current?.config.provider ?? "boat");
    }
    const { machine, projectId } = current.ready;
    const pairingCode = yield* pairMachine(machine).pipe(
      Effect.tapError((error) =>
        tracker.stage(input.threadId, "pair", "failed", null).pipe(
          Effect.andThen(
            tracker.update(input.threadId, {
              phase: "failed",
              error: error.detail,
              recovery: "retry",
            }),
          ),
        ),
      ),
    );
    return {
      environmentId: machine.environmentId,
      httpBaseUrl: machine.httpBaseUrl,
      pairingCode,
      projectId,
    } satisfies SandboxLaunchPairResult;
  });

  const completeLaunch = Effect.fn("SandboxProvisioner.completeLaunch")(function* (
    input: SandboxLaunchThreadInput,
  ) {
    const current = runningLaunch(input.threadId);
    if (current === null || current.ready === null) {
      return yield* notReady(current?.config.provider ?? "boat");
    }
    yield* Deferred.succeed(current.handoff, undefined);
    yield* Fiber.join(current.fiber);
  });

  const retryLaunch = Effect.fn("SandboxProvisioner.retryLaunch")(function* (
    input: SandboxLaunchThreadInput,
  ) {
    const snapshot = yield* tracker.get(input.threadId);
    const current = launches.get(input.threadId);
    if (snapshot === null || snapshot.phase !== "failed" || current === undefined) return;
    if (snapshot.recovery === "relaunch") {
      yield* startLaunch(current.input, current.config);
      return;
    }
    // The machine is kept; a failed pairing goes back to waiting for the client to pair again.
    if (current.ready !== null) {
      yield* tracker.stage(input.threadId, "pair", "running", null);
      yield* tracker.update(input.threadId, { phase: "running", error: null, recovery: null });
      return;
    }
    yield* Queue.offer(current.retries, undefined);
  });

  const cancelLaunch = Effect.fn("SandboxProvisioner.cancelLaunch")(function* (
    input: SandboxLaunchThreadInput,
  ) {
    const current = runningLaunch(input.threadId);
    if (current !== null) {
      yield* Fiber.interrupt(current.fiber);
      return { cancelled: true } satisfies SandboxLaunchCancelResult;
    }
    // A launch that failed and kept nothing has only its card left to dismiss.
    const snapshot = yield* tracker.get(input.threadId);
    if (snapshot !== null && snapshot.phase !== "running") yield* tracker.remove(input.threadId);
    return { cancelled: false } satisfies SandboxLaunchCancelResult;
  });

  const configs = configStore.list.pipe(
    Effect.orDie,
    Effect.map((list): SandboxConfigsResult => ({ configs: list })),
  );

  const saveConfig = Effect.fn("SandboxProvisioner.saveConfig")(function* (
    input: SandboxSaveConfigInput,
  ) {
    const driver = findDriver(input.config.provider);
    const provider = driver.info.kind;
    // Saving the key with the config is how the key gets in: no machine is made here.
    yield* resolveConfig(driver, { apiKey: input.apiKey, settings: input.settings });
    const label = input.config.label.trim();
    if (label === "") return yield* configError(provider, "Enter a name for this sandbox config.");
    if (
      input.config.template === undefined &&
      !driver.info.sizes.some((size) => size.id === input.config.size)
    ) {
      return yield* configError(
        provider,
        `${driver.info.label} has no machine size ${input.config.size}.`,
      );
    }
    if (input.config.access === "tailnet" && !input.config.joinTailnet) {
      return yield* configError(provider, "A tailnet-only sandbox has to join your tailnet.");
    }
    if (input.config.claude !== undefined) {
      const endpoint = URL.parse(input.config.claude.baseUrl);
      if (endpoint === null || (endpoint.protocol !== "https:" && endpoint.protocol !== "http:")) {
        return yield* configError(provider, "Enter an http or https URL for Claude.");
      }
    }
    const now = yield* nowIso;
    const id = input.config.id ?? (yield* secureRandom.uuidV4());
    const previous =
      input.config.id === undefined
        ? Option.none<SandboxEnvironmentConfig>()
        : yield* configStore.get(input.config.id).pipe(Effect.orDie);
    const config: SandboxEnvironmentConfig = {
      ...input.config,
      id,
      label,
      createdAt: Option.match(previous, { onNone: () => now, onSome: (saved) => saved.createdAt }),
      updatedAt: now,
    };
    yield* configStore.put(config).pipe(Effect.orDie);
    return { config } satisfies SandboxSaveConfigResult;
  });

  // Sandboxes launched from a deleted config keep running and stay listed; they name the config id.
  const deleteConfig = Effect.fn("SandboxProvisioner.deleteConfig")(function* (
    input: SandboxDeleteConfigInput,
  ) {
    yield* configStore.remove(input.configId).pipe(Effect.orDie);
  });

  // Never blocks a delete: a key that cannot be revoked becomes a warning naming it by its prefix.
  const releaseHubKey = Effect.fn("SandboxProvisioner.releaseHubKey")(function* (
    record: SandboxRecord,
  ) {
    const reference = record.claudeHubKey;
    if (reference === undefined) return null;
    const warning = `The key T3 Code added for ${record.label} on the CLIProxyAPI hub could not be revoked. Remove the key starting with t3-sandbox-${labelSlug(record.label)}- from the hub.`;
    const stored = yield* secrets.get(reference.secret).pipe(Effect.orElseSucceed(Option.none));
    const source = (yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null)))
      ?.usageLimitSources[UsageLimitSourceId.make(reference.sourceId)];
    const hub =
      source === undefined || !hasManagementKey(source)
        ? Option.none<CliproxyHub>()
        : yield* cliproxyHub(source).pipe(Effect.option);
    if (Option.isNone(stored) || Option.isNone(hub)) {
      yield* Effect.logWarning("sandbox hub key cannot be revoked", {
        instanceId: record.instanceId,
        sourceId: reference.sourceId,
        keyFound: Option.isSome(stored),
        sourceFound: source !== undefined,
        managementKeyRead: Option.isSome(hub),
      });
      return warning;
    }
    const revoked = yield* revokeHubKey({
      sourceId: reference.sourceId,
      hub: hub.value,
      value: Redacted.make(new TextDecoder().decode(stored.value)),
    }).pipe(Effect.exit);
    yield* secrets.remove(reference.secret).pipe(Effect.ignore);
    return Exit.isSuccess(revoked) ? null : warning;
  });

  const orphans = yield* Ref.make<ReadonlyArray<SandboxOrphan>>([]);

  const remove = Effect.fn("SandboxProvisioner.delete")(function* (input: SandboxDeleteInput) {
    const instanceId = input.instanceId;
    // A sandbox still provisioning belongs to its launch; stopping the launch deletes it.
    const live = instanceId === undefined ? undefined : liveInstances.get(instanceId);
    if (live !== undefined) {
      yield* Fiber.interrupt(live);
      return { warnings: [] } satisfies SandboxDeleteResult;
    }
    const record =
      instanceId === undefined
        ? Option.none<SandboxRecord>()
        : yield* records.get(instanceId).pipe(Effect.orDie);
    if (Option.isNone(record) || record.value.state !== "deleted") {
      const driver = findDriver(input.provider);
      const config = Option.isNone(record)
        ? yield* resolveConfig(driver)
        : yield* recordConfig(driver, record.value);
      yield* onHttp(driver.destroy({ config, sandboxId: input.sandboxId })).pipe(
        // Deleted from the provider's dashboard before the sweep noticed: the record still goes.
        Effect.catchIf(
          (error) => error.code === "not_found",
          () => Effect.void,
        ),
      );
    }
    if (instanceId !== undefined) yield* records.remove(instanceId).pipe(Effect.orDie);
    yield* Ref.update(orphans, (current) =>
      current.filter((orphan) => orphan.sandboxId !== input.sandboxId),
    );
    // A sandbox deleted outside T3 still has its key on the hub, so this runs for every record.
    const warnings = Option.isNone(record)
      ? []
      : [yield* releaseHubKey(record.value), yield* releaseTailnetDevice(record.value)].filter(
          (warning): warning is string => warning !== null,
        );
    return { warnings } satisfies SandboxDeleteResult;
  });

  const environments = Effect.fn("SandboxProvisioner.environments")(function* (
    input: SandboxCredentialEnvironmentsInput,
  ) {
    const driver = findDriver(input.provider);
    if (driver.listEnvironments === undefined) {
      return { environments: [] as ReadonlyArray<SandboxCredentialEnvironment> };
    }
    const config = yield* resolveConfig(driver);
    const listed = yield* onHttp(driver.listEnvironments({ config }));
    return { environments: listed };
  });

  const limits = Effect.fn("SandboxProvisioner.limits")(function* (input: SandboxLimitsInput) {
    const driver = findDriver(input.provider);
    if (driver.limits === undefined) return { limits: null } satisfies SandboxLimitsResult;
    const config = yield* resolveConfig(driver).pipe(Effect.option);
    if (Option.isNone(config)) return { limits: null } satisfies SandboxLimitsResult;
    return {
      limits: yield* onHttp(driver.limits({ config: config.value })),
    } satisfies SandboxLimitsResult;
  });

  const list = Effect.gen(function* () {
    const sandboxes = yield* records.list.pipe(Effect.orDie);
    return { sandboxes, orphans: yield* Ref.get(orphans) } satisfies SandboxListResult;
  });

  const stop = Effect.fn("SandboxProvisioner.stop")(function* (input: SandboxLifecycleInput) {
    const record = yield* readRecord(input.instanceId);
    const driver = findDriver(record.provider);
    if (driver.stop === undefined) {
      return yield* configError(record.provider, "This provider cannot stop a sandbox.");
    }
    const config = yield* recordConfig(driver, record);
    yield* onHttp(driver.stop({ config, sandboxId: record.sandboxId }));
    const now = yield* nowIso;
    const updated: SandboxRecord = {
      ...record,
      state: "stopped",
      runningSince: null,
      stoppedAt: now,
      updatedAt: now,
    };
    yield* records.put(updated).pipe(Effect.orDie);
    return { sandbox: updated } satisfies SandboxStopResult;
  });

  const resume = Effect.fn("SandboxProvisioner.resume")(function* (input: SandboxLifecycleInput) {
    const record = yield* readRecord(input.instanceId);
    const driver = findDriver(record.provider);
    if (record.state === "expired" || record.state === "deleted") {
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "start",
        code: record.state === "expired" ? "snapshot_expired" : "not_found",
        detail:
          record.state === "expired"
            ? `${driver.info.label} no longer keeps this stopped sandbox's disk. Delete it and create a new one.`
            : `${driver.info.label} no longer has this sandbox. Delete it and create a new one.`,
      });
    }
    if (driver.resume === undefined) {
      return yield* configError(record.provider, "This provider cannot resume a sandbox.");
    }
    const now = yield* nowIso;
    const config = yield* recordConfig(driver, record);
    // Providers such as Boat count a resume as a start, so it gets the same preflight as create.
    const limits = yield* preflightStart(driver, config, undefined);
    const resumed = yield* onHttp(
      driver.resume({
        config,
        sandboxId: record.sandboxId,
        // The running limit restarts with the sandbox; the provider's own TTL backs it up.
        ttlMinutes: Math.min(record.maxRunningMinutes, limits?.maxTtlMinutes ?? Infinity),
      }),
    );
    const httpBaseUrl =
      record.access === "tailnet" ? record.httpBaseUrl : (resumed.publicUrl ?? record.httpBaseUrl);
    const errored = (detail: string, cause?: unknown) =>
      records
        .put({ ...record, state: "error", runningSince: now, updatedAt: now, httpBaseUrl })
        .pipe(
          Effect.orDie,
          Effect.andThen(
            Effect.fail(
              new SandboxProviderError({
                provider: record.provider,
                stage: "start",
                detail,
                ...(cause === undefined ? {} : { cause }),
              }),
            ),
          ),
        );
    const rejoined = yield* onHttp(
      rejoinTailnet(record, (script, timeoutSeconds) =>
        driver.execute({
          config,
          sandboxId: record.sandboxId,
          timeoutSeconds,
          ...asScript(script),
        }),
      ),
    );
    yield* onHttp(
      driver.execute({
        config,
        sandboxId: record.sandboxId,
        command: startScript(driver.serveEnvironment),
        timeoutSeconds: 180,
      }),
    ).pipe(
      Effect.catch((cause) =>
        errored("The sandbox resumed, but T3 Code did not start on it.", cause),
      ),
    );
    // Saving a template resets T3 on its source; one that failed to save comes back as a different
    // environment, which the client's saved connection cannot reach.
    const described = yield* onHttp(
      requestJson({
        provider: record.provider,
        stage: "start",
        schema: ExecutionEnvironmentDescriptor,
        request: HttpClientRequest.get(
          `${httpBaseUrl.replace(/\/+$/, "")}/.well-known/t3/environment`,
        ),
      }),
    ).pipe(Effect.option);
    if (Option.isSome(described) && described.value.environmentId !== record.environmentId) {
      return yield* errored(
        "T3 Code on this sandbox was reset, so it cannot reconnect as this environment. Delete it.",
      );
    }
    const { stoppedAt: _stoppedAt, ...rest } = record;
    const updated: SandboxRecord = {
      ...rest,
      state: "running",
      runningSince: now,
      updatedAt: now,
      httpBaseUrl,
      ...(rejoined.tailscale === undefined ? {} : { tailscale: rejoined.tailscale }),
    };
    yield* records.put(updated).pipe(Effect.orDie);
    return {
      sandbox: updated,
      httpBaseUrl: updated.httpBaseUrl,
      ...(rejoined.warning === null ? {} : { warnings: [rejoined.warning] }),
    } satisfies SandboxResumeResult;
  });

  const templates = Effect.fn("SandboxProvisioner.templates")(function* (
    input: SandboxTemplatesInput,
  ) {
    const driver = findDriver(input.provider);
    if (driver.listTemplates === undefined)
      return { templates: [] } satisfies SandboxTemplatesResult;
    const config = yield* resolveConfig(driver).pipe(Effect.option);
    if (Option.isNone(config)) return { templates: [] } satisfies SandboxTemplatesResult;
    const listed = yield* onHttp(driver.listTemplates({ config: config.value }));
    return listed satisfies SandboxTemplatesResult;
  });

  const saveTemplate = Effect.fn("SandboxProvisioner.saveTemplate")(function* (
    input: SandboxSaveTemplateInput,
  ) {
    const record = yield* readRecord(input.instanceId);
    const driver = findDriver(record.provider);
    const { saveTemplate: save, stop: stopMachine } = driver;
    if (save === undefined || stopMachine === undefined) {
      return yield* configError(record.provider, "This provider cannot save templates.");
    }
    // Saving deletes the source, which would take a thread's machine and its work with it.
    if (record.threadId !== undefined) {
      return yield* configError(
        record.provider,
        "A thread's sandbox cannot be saved as a template. Start a template sandbox from Templates instead.",
      );
    }
    // The reset runs on the machine. Resuming here would spend a start nobody confirmed.
    if (record.state !== "running") {
      return yield* configError(
        record.provider,
        "Only a running sandbox can be saved as a template. Resume it first.",
      );
    }
    const config = yield* recordConfig(driver, record);
    // The provider refuses a save only after the reset would have run, so a plan that cannot save
    // is refused here first. Unknown limits let the save through, as with starts.
    const limits =
      driver.limits === undefined
        ? null
        : yield* onHttp(driver.limits({ config })).pipe(Effect.orElseSucceed(() => null));
    if (limits?.canSaveTemplates === false) {
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "config",
        code: "templates_unavailable",
        detail: `Your ${driver.info.label} plan cannot save templates. Nothing on this sandbox changed.`,
      });
    }
    yield* onHttp(
      driver.execute({
        config,
        sandboxId: record.sandboxId,
        command: SCRUB_SCRIPT,
        timeoutSeconds: 120,
      }),
    );
    // From here T3's identity on the machine is gone, and resume refuses the different one it gets.
    const afterReset = (error: SandboxProviderError) =>
      new SandboxProviderError({
        provider: error.provider,
        stage: error.stage,
        detail: `${error.detail} T3 Code on this sandbox was already reset, so it cannot reconnect. Delete it.`,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.code === undefined ? {} : { code: error.code }),
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: error.retryAfterSeconds }),
        cause: error,
      });
    yield* onHttp(stopMachine({ config, sandboxId: record.sandboxId })).pipe(
      Effect.mapError(afterReset),
    );
    const stoppedAt = yield* nowIso;
    yield* records
      .put({ ...record, state: "stopped", runningSince: null, stoppedAt, updatedAt: stoppedAt })
      .pipe(Effect.orDie);
    const template = yield* onHttp(
      save({ config, sandboxId: record.sandboxId, name: input.name }),
    ).pipe(Effect.mapError(afterReset));
    yield* onHttp(driver.destroy({ config, sandboxId: record.sandboxId })).pipe(
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.void,
      ),
      Effect.andThen(records.remove(record.instanceId).pipe(Effect.orDie)),
      // The scrub removed the token from the disk; the key on the hub goes with its sandbox.
      Effect.andThen(releaseHubKey(record)),
      // The scrub logged the node out; this covers a logout that never reached Tailscale.
      Effect.andThen(releaseTailnetDevice(record)),
      // The template is saved either way; a sandbox that survives stays listed for a manual delete.
      Effect.catch((cause) =>
        Effect.logWarning("sandbox delete after saving a template failed", {
          instanceId: record.instanceId,
          sandboxId: record.sandboxId,
          cause,
        }),
      ),
    );
    return { template } satisfies SandboxSaveTemplateResult;
  });

  const deleteTemplate = Effect.fn("SandboxProvisioner.deleteTemplate")(function* (
    input: SandboxDeleteTemplateInput,
  ) {
    const driver = findDriver(input.provider);
    if (driver.deleteTemplate === undefined) {
      return yield* configError(input.provider, "This provider cannot delete templates.");
    }
    const config = yield* resolveConfig(driver);
    yield* onHttp(driver.deleteTemplate({ config, name: input.name }));
  });

  // The sweep reads records, then waits on the provider; a user action in between wins.
  const putIfUnchanged = Effect.fn("SandboxProvisioner.putIfUnchanged")(function* (
    read: SandboxRecord,
    next: SandboxRecord,
  ) {
    const current = yield* records.get(read.instanceId);
    if (Option.isNone(current)) return;
    if (current.value.updatedAt !== read.updatedAt || current.value.state !== read.state) return;
    yield* records.put(next);
  }, Effect.orDie);

  // A state change from the provider moves the running clock and the stopped disk's age with it.
  const withState = (
    record: SandboxRecord,
    state: SandboxRecord["state"],
    now: string,
  ): SandboxRecord => {
    if (state === record.state) return record;
    if (state === "running") {
      const { stoppedAt: _stoppedAt, ...rest } = record;
      return { ...rest, state, runningSince: record.runningSince ?? now, updatedAt: now };
    }
    if (state === "stopped") {
      return {
        ...record,
        state,
        runningSince: null,
        stoppedAt: record.stoppedAt ?? now,
        updatedAt: now,
      };
    }
    return { ...record, state, updatedAt: now };
  };

  // Idle stop (each config's `idleMinutes`) lands next to this check; it needs the sandbox's own
  // activity, which the host does not see yet.
  const pastRunningLimit = (record: SandboxRecord, now: DateTime.Utc) =>
    record.runningSince !== null &&
    DateTime.toEpochMillis(now) -
      DateTime.toEpochMillis(DateTime.makeUnsafe(record.runningSince)) >=
      record.maxRunningMinutes * 60_000;

  const sweepRecord = Effect.fn("SandboxProvisioner.sweepRecord")(function* (
    record: SandboxRecord,
    config: SandboxProviderConfig,
    cost: SandboxUsage | undefined,
    now: DateTime.Utc,
  ) {
    const driver = findDriver(record.provider);
    const nowText = DateTime.formatIso(now);
    const withCost: SandboxRecord =
      cost === undefined ? record : { ...record, costDollars: cost.dollars, costSince: cost.since };
    // A resume that could not start T3 leaves the machine running (and billing) as `error`.
    if (
      pastRunningLimit(record, now) &&
      (record.state === "running" || record.state === "error") &&
      driver.stop
    ) {
      return yield* onHttp(driver.stop({ config, sandboxId: record.sandboxId })).pipe(
        Effect.andThen(putIfUnchanged(record, withState(withCost, "stopped", nowText))),
        Effect.catch((cause) =>
          Effect.logWarning("sandbox running limit stop failed", {
            instanceId: record.instanceId,
            sandboxId: record.sandboxId,
            cause,
          }),
        ),
      );
    }
    // An unreachable provider says nothing about the machine, so the record keeps its state.
    const status =
      driver.status === undefined
        ? null
        : yield* onHttp(driver.status({ config, sandboxId: record.sandboxId })).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("sandbox status check failed", {
                instanceId: record.instanceId,
                sandboxId: record.sandboxId,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
    const state = reconcileState(record.state, status);
    if (state !== record.state) {
      yield* putIfUnchanged(record, withState(withCost, state, nowText));
    } else if (
      withCost.costDollars !== record.costDollars ||
      withCost.costSince !== record.costSince
    ) {
      // Cost alone is not a lifecycle change, so it keeps `updatedAt` and the list order.
      yield* putIfUnchanged(record, withCost);
    }
  });

  // Tagged sandboxes no record tracks are only reported: a user may have made them by hand.
  const sweepOrphans = Effect.fn("SandboxProvisioner.sweepOrphans")(function* (
    all: ReadonlyArray<SandboxRecord>,
    configs: ReadonlyMap<SandboxProviderKind, SandboxProviderConfig>,
  ) {
    const host = yield* environmentIdentity.getEnvironmentId;
    const tracked = new Set(all.map((record) => `${record.provider}:${record.sandboxId}`));
    const found: Array<SandboxOrphan> = [];
    for (const [provider, config] of configs) {
      const { listSandboxes } = findDriver(provider);
      if (listSandboxes === undefined) continue;
      const listed = yield* onHttp(listSandboxes({ config, host })).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("sandbox orphan listing failed", { provider, cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      if (listed === null) {
        found.push(...(yield* Ref.get(orphans)).filter((orphan) => orphan.provider === provider));
        continue;
      }
      for (const sandbox of listed) {
        if (tracked.has(`${provider}:${sandbox.id}`)) continue;
        if (sandbox.instance !== undefined && liveInstances.has(sandbox.instance)) continue;
        found.push({
          provider,
          sandboxId: sandbox.id,
          name: sandbox.name,
          ...(sandbox.instance === undefined ? {} : { instanceId: sandbox.instance }),
          ...(sandbox.createdAt === undefined ? {} : { createdAt: sandbox.createdAt }),
        });
      }
    }
    yield* Ref.set(orphans, found);
  });

  const sweep = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const all = yield* records.list.pipe(Effect.orDie);
    // A provisioning record whose launch is gone (the server restarted mid-launch) has nobody left
    // to finish or clean it up, so the sweep deletes its machine.
    for (const record of all) {
      if (record.state !== "provisioning" || liveInstances.has(record.instanceId)) continue;
      yield* remove({
        provider: record.provider,
        sandboxId: record.sandboxId,
        instanceId: record.instanceId,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("abandoned sandbox cleanup failed", {
            instanceId: record.instanceId,
            sandboxId: record.sandboxId,
            cause,
          }),
        ),
      );
    }
    const live = all.filter(
      (record) => record.state !== "deleted" && record.state !== "provisioning",
    );
    const current = new Map<SandboxProviderKind, SandboxProviderConfig>();
    const providersInUse = new Set([
      ...live.map((record) => record.provider),
      ...(yield* configStore.list.pipe(Effect.orElseSucceed(() => []))).map(
        (config) => config.provider,
      ),
    ]);
    for (const provider of providersInUse) {
      const resolved = yield* resolveConfig(findDriver(provider)).pipe(Effect.option);
      if (Option.isSome(resolved)) current.set(provider, resolved.value);
    }
    const targets = live.flatMap((record) => {
      const base = current.get(record.provider);
      if (base === undefined) return [];
      const config = withSettings(base, record.providerSettings);
      // Usage is read once per provider and settings, since settings can scope the account.
      const scope = `${record.provider}:${JSON.stringify(Object.entries(config.settings).toSorted())}`;
      return [{ record, config, scope }];
    });
    const costs = new Map<string, ReadonlyMap<string, SandboxUsage>>();
    const scopes = new Map(targets.map((target) => [target.scope, target]));
    for (const { record, config, scope } of scopes.values()) {
      const { usage } = findDriver(record.provider);
      if (usage === undefined) continue;
      yield* onHttp(usage({ config })).pipe(
        Effect.tap((read) => Effect.sync(() => costs.set(scope, read))),
        Effect.catch((cause) =>
          Effect.logWarning("sandbox usage read failed", { provider: record.provider, cause }),
        ),
      );
    }
    yield* Effect.forEach(
      targets,
      ({ record, config, scope }) =>
        sweepRecord(record, config, costs.get(scope)?.get(record.sandboxId), now),
      { concurrency: 4, discard: true },
    );
    yield* sweepOrphans(yield* records.list.pipe(Effect.orDie), current);
  });

  return SandboxProvisioner.of({
    providers,
    create,
    delete: remove,
    environments,
    limits,
    list,
    stop,
    resume,
    templates,
    saveTemplate,
    deleteTemplate,
    configs,
    saveConfig,
    deleteConfig,
    launch,
    subscribeLaunch: (input) => tracker.stream(input.threadId),
    cancelLaunch,
    retryLaunch,
    pairLaunch,
    completeLaunch,
    sweep,
  });
});

export const layer = Layer.effect(SandboxProvisioner, make);

/** The provisioner with the host access, provider HTTP client and record stores only it uses. */
export const layerRuntime = layer.pipe(
  Layer.provide(SandboxHostAccess.layer),
  Layer.provide(layerHttpClient),
  Layer.provide(Layer.merge(SandboxRecords.layer, SandboxRecords.layerConfigs)),
);

export const layerSweep = Layer.effectDiscard(
  Effect.gen(function* () {
    const provisioner = yield* SandboxProvisioner;
    yield* forkParked(
      provisioner.sweep.pipe(
        Effect.catchCause((cause) => Effect.logWarning("sandbox sweep failed", { cause })),
        Effect.repeat(Schedule.spaced("1 minute")),
      ),
    );
  }),
);

/** The sandbox WebSocket RPC handlers, each a call to one provisioner method. */
export const rpcHandlers = Effect.gen(function* () {
  const sandboxes = yield* SandboxProvisioner;
  return {
    [WS_METHODS.sandboxesProviders]: () => sandboxes.providers,
    [WS_METHODS.sandboxesEnvironments]: (input: SandboxCredentialEnvironmentsInput) =>
      sandboxes.environments(input),
    [WS_METHODS.sandboxesLimits]: (input: SandboxLimitsInput) => sandboxes.limits(input),
    [WS_METHODS.sandboxesCreate]: (input: SandboxCreateInput) => sandboxes.create(input),
    [WS_METHODS.sandboxesDelete]: (input: SandboxDeleteInput) => sandboxes.delete(input),
    [WS_METHODS.sandboxesList]: () => sandboxes.list,
    [WS_METHODS.sandboxesStop]: (input: SandboxLifecycleInput) => sandboxes.stop(input),
    [WS_METHODS.sandboxesResume]: (input: SandboxLifecycleInput) => sandboxes.resume(input),
    [WS_METHODS.sandboxesTemplates]: (input: SandboxTemplatesInput) => sandboxes.templates(input),
    [WS_METHODS.sandboxesSaveTemplate]: (input: SandboxSaveTemplateInput) =>
      sandboxes.saveTemplate(input),
    [WS_METHODS.sandboxesDeleteTemplate]: (input: SandboxDeleteTemplateInput) =>
      sandboxes.deleteTemplate(input),
    [WS_METHODS.sandboxesConfigs]: () => sandboxes.configs,
    [WS_METHODS.sandboxesSaveConfig]: (input: SandboxSaveConfigInput) =>
      sandboxes.saveConfig(input),
    [WS_METHODS.sandboxesDeleteConfig]: (input: SandboxDeleteConfigInput) =>
      sandboxes.deleteConfig(input),
    [WS_METHODS.sandboxesLaunch]: (input: SandboxLaunchInput) => sandboxes.launch(input),
    [WS_METHODS.sandboxesSubscribeLaunch]: (input: SandboxLaunchThreadInput) =>
      sandboxes.subscribeLaunch(input),
    [WS_METHODS.sandboxesCancelLaunch]: (input: SandboxLaunchThreadInput) =>
      sandboxes.cancelLaunch(input),
    [WS_METHODS.sandboxesRetryLaunch]: (input: SandboxLaunchThreadInput) =>
      sandboxes.retryLaunch(input),
    [WS_METHODS.sandboxesPairLaunch]: (input: SandboxLaunchThreadInput) =>
      sandboxes.pairLaunch(input),
    [WS_METHODS.sandboxesCompleteLaunch]: (input: SandboxLaunchThreadInput) =>
      sandboxes.completeLaunch(input),
  };
});
