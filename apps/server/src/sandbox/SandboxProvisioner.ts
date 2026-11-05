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
  type SandboxCheckWorkResult,
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
  type SandboxTailscaleCheckInput,
  type SandboxTailscaleCheckResult,
  SANDBOX_TAILSCALE_SCOPES,
  tailscaleClientIdFromSecret,
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
  githubRepositoryOf,
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
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxRecords from "../persistence/SandboxRecords.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
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
  parseWorkCheck,
  repositoryScript,
  type SandboxScript,
  type SandboxTool,
  GITHUB_LOGIN_SCRUB,
  githubLoginScript,
  TAILSCALE_PROXY_URL,
  tailscaleProxyEnv,
  tailscaleScript,
  tailscaleScrub,
  workCheckScript,
  writeFileScript,
} from "./sandboxSetup.ts";
import { makePairingKey, pairScript, type PairReport, readPairReport } from "./sandboxPairing.ts";
import {
  type BridgeCredentialReport,
  bridgeCredentialScript,
  readBridgeCredential,
} from "./sandboxBridgeCredential.ts";
import {
  bridgeLinkSecretName,
  type SandboxBridgeLink,
  SandboxBridgeLinkJson,
} from "@t3tools/sandbox-bridge/link";
import { makeSandboxLaunchTracker } from "./sandboxLaunches.ts";
import { makeTailscaleApi, type TailscaleOAuthClient } from "./tailscaleApi.ts";
import {
  type AgentEnvironment,
  layerHttpClient,
  requestJson,
  type SandboxAgentAccess,
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

// Long enough for git on a large clone, short enough that a delete never waits on a stuck machine.
const WORK_CHECK_SECONDS = 10;

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

const BRIDGE_FAILURES: Record<
  Exclude<BridgeCredentialReport, { _tag: "issued" }>["reason"],
  string
> = {
  seal: "The sandbox has neither the openssl CLI nor Node.js, which T3 Code needs to receive the bridge's credential safely.",
  issue: "t3 auth session issue failed on the sandbox.",
  token: "The sandbox did not return a credential for the bridge.",
  unreadable: "The sandbox did not return a credential for the bridge.",
};

const decodeBridgeLink = Schema.decodeEffect(SandboxBridgeLinkJson);
const encodeBridgeLink = Schema.encodeEffect(SandboxBridgeLinkJson);

// A bridge credential this close to its expiry is replaced the next time it is linked or resumed.
const BRIDGE_RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

// How long a launch waits on its client, to pair and start the thread or to retry a failed stage,
// before it gives up and releases the machine. Every pairing or retry starts the wait again.
const LAUNCH_CLIENT_WAIT = "10 minutes";
const LAUNCH_CLIENT_TIMEOUT =
  "Nothing connected to this sandbox for 10 minutes, so T3 Code deleted it. Start a new sandbox to try again.";
const LAUNCH_DELETED_OUTSIDE =
  "The sandbox was deleted outside T3 Code before it finished starting. Start a new sandbox to try again.";
// A record left `provisioning` with no launch to finish it: T3 Code stopped mid-launch.
const LAUNCH_ABANDONED =
  "T3 Code stopped before this sandbox finished starting. Start a new sandbox to replace it, or delete it under Settings → Connections → Sandboxes.";

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
  /** Set when the agent gets its own provider key; checked before anything bills. */
  readonly agentAccess: SandboxAgentAccess | undefined;
}

/** What a provisioning attempt made so far; a failure or cancel releases all of it. */
interface Owned {
  sandbox?: { readonly id: string; readonly config: SandboxProviderConfig };
  deviceId?: string;
  agentEnvironment?: AgentEnvironment;
  agentKeyId?: string;
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

/** The https clone URL of a github.com remote, or null; a credential in the URL is dropped. */
const githubCloneUrl = (remoteUrl: string) => {
  const repository = githubRepositoryOf(remoteUrl);
  return repository === null
    ? null
    : { url: repository.cloneUrl, name: repository.name, owner: repository.owner };
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
    readonly checkWork: (
      input: SandboxLifecycleInput,
    ) => Effect.Effect<SandboxCheckWorkResult, SandboxProviderError>;
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
    /** Signs in with a Tailscale OAuth client and says whether it can do what T3 needs. */
    readonly checkTailscale: (
      input: SandboxTailscaleCheckInput,
    ) => Effect.Effect<SandboxTailscaleCheckResult>;
    /** Stops sandboxes past their running limit and syncs every other record with its provider. */
    readonly sweep: Effect.Effect<void>;
    /**
     * Readies the host's sandbox bridge for a launched thread: keeps (or mints) the bearer it uses
     * on the sandbox and records the host project the thread is served from.
     */
    readonly linkBridge: (input: {
      readonly threadId: ThreadId;
      readonly hostProjectId: ProjectId;
    }) => Effect.Effect<SandboxRecord, SandboxProviderError>;
  }
>()("t3/sandbox/SandboxProvisioner") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const records = yield* SandboxRecords.SandboxRecordRepository;
  const configStore = yield* SandboxRecords.SandboxConfigRepository;
  const environmentIdentity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const workspaceFiles = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
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
    const { clientSecret, tag } = value.sandboxTailscale;
    // The one-field form leaves the ID to the secret it is part of.
    const clientId =
      value.sandboxTailscale.clientId || (tailscaleClientIdFromSecret(clientSecret) ?? "");
    if (clientId === "" || clientSecret === "") return undefined;
    return {
      clientId,
      clientSecret: Redacted.make(clientSecret),
      tag: tag === "" ? DEFAULT_SANDBOX_TAILSCALE_TAG : tag,
    };
  };

  const tailscaleToken = (client: TailscaleOAuthClient) => tailscaleApi.accessToken(client);

  const checkTailscale = Effect.fn("SandboxProvisioner.checkTailscale")(function* (
    input: SandboxTailscaleCheckInput,
  ) {
    const clientId = input.clientId ?? tailscaleClientIdFromSecret(input.clientSecret);
    if (clientId === null) {
      return {
        clientId: "",
        scopes: [],
        problem:
          "This does not look like a Tailscale OAuth client secret (tskey-client-…). If yours has another form, enter its client ID under Advanced.",
      } satisfies SandboxTailscaleCheckResult;
    }
    const tag = input.tag ?? DEFAULT_SANDBOX_TAILSCALE_TAG;
    const signedIn = yield* tailscaleApi
      .signIn({ clientId, clientSecret: Redacted.make(input.clientSecret) }, [tag])
      .pipe(Effect.result);
    if (signedIn._tag === "Failure") {
      // The steps refer to the setup guide in the Tailscale card.
      const problem =
        signedIn.failure.status === 400
          ? `Tailscale won't give this client ${tag}. Add the tag to tagOwners in your policy file (step 1), then make an OAuth client with it selected for both scopes (step 2).`
          : signedIn.failure.status === 401
            ? "Tailscale did not accept this secret. Copy it again, or make a new OAuth client (step 2)."
            : signedIn.failure.detail;
      return { clientId, scopes: [], problem };
    }
    const { scopes } = signedIn.success;
    // `all` is the older scope that covers every other, and `devices` the older `devices:core`.
    const granted = (id: string) =>
      scopes.includes("all") ||
      scopes.includes(id) ||
      (id === "devices:core" && scopes.includes("devices"));
    // Named the way Tailscale's Scopes step shows them; Read alone cannot mint keys.
    const missing = SANDBOX_TAILSCALE_SCOPES.filter((scope) => !granted(scope.id)).map(
      (scope) =>
        `${scope.label}: Write${scopes.includes(`${scope.id}:read`) ? " (it has Read)" : ""}`,
    );
    return {
      clientId,
      scopes,
      problem:
        missing.length === 0
          ? null
          : `Missing ${missing.join(" and ")} for ${tag}. Make an OAuth client that has ${missing.length === 1 ? "it" : "them"} (step 2) and paste its secret.`,
    } satisfies SandboxTailscaleCheckResult;
  });

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
    const tailnetAddress = yield* hostAccess.endpointTailnetAddress(claude.baseUrl);
    return {
      claude: {
        baseUrl: claude.baseUrl,
        key: hub === undefined ? "copy" : "hub",
        privateNetwork: yield* hostAccess.endpointIsPrivate(claude.baseUrl),
        ...(tailnetAddress === null ? {} : { tailnetAddress }),
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
          agentProviderAccess: driver.agentAccess !== undefined,
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

  // The agent's key needs an environment of the sandbox's own, which passes no credentials.
  const agentAccessRefusal = (driver: SandboxProviderDriver, environment: string | undefined) =>
    driver.agentAccess === undefined
      ? `${driver.info.label} cannot give a sandbox's agent a key of its own.`
      : environment !== undefined
        ? `Letting the agent use ${driver.info.label} needs a sandbox without a ${driver.info.label} environment. Pick No credentials, or turn it off.`
        : null;

  // One name for the sandbox's environment and its key, so either says which sandbox it is for.
  const agentAccessName = Effect.fn("SandboxProvisioner.agentAccessName")(function* (
    label: string,
  ) {
    const hex = (yield* secureRandom.uuidV4()).replaceAll("-", "");
    return `t3-sandbox-${labelSlug(label)}-${hex.slice(0, 8)}`;
  });

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
    const agentAccess = input.agentProviderAccess === true ? driver.agentAccess : undefined;
    if (input.agentProviderAccess === true) {
      const refusal = agentAccessRefusal(driver, input.environment);
      if (refusal !== null) return yield* configError(input.provider, refusal);
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
    // A key that cannot mint the agent's key is refused here, not after a machine is billed.
    if (agentAccess !== undefined) yield* onHttp(agentAccess.check({ config }));
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
      agentAccess,
    } satisfies Prepared;
  });

  // Instances with a fiber still provisioning them; the sweep leaves their records alone.
  const liveInstances = new Map<string, Fiber.Fiber<unknown, unknown>>();

  // A machine that costs money must not survive a failure or an interruption, and neither may the
  // hub key, the tailnet device, or the record that point at it.
  const releaseOwned = (prepared: Prepared, owned: Owned, instanceId: string) =>
    Effect.all(
      [
        // The sandbox's own environment goes only once the sandbox in it is gone.
        Effect.gen(function* () {
          const destroyed =
            owned.sandbox === undefined
              ? true
              : Exit.isSuccess(
                  yield* onHttp(
                    prepared.driver.destroy({
                      config: owned.sandbox.config,
                      sandboxId: owned.sandbox.id,
                    }),
                  ).pipe(
                    // Deleted outside T3 Code: it is gone all the same.
                    Effect.catchIf(
                      (error) => error.code === "not_found",
                      () => Effect.void,
                    ),
                    Effect.exit,
                  ),
                );
          if (
            destroyed &&
            prepared.agentAccess !== undefined &&
            owned.agentEnvironment !== undefined
          ) {
            yield* onHttp(
              prepared.agentAccess.deleteEnvironment({
                config: prepared.config,
                environmentId: owned.agentEnvironment.id,
              }),
            ).pipe(Effect.ignore);
          }
        }),
        prepared.agentAccess === undefined || owned.agentKeyId === undefined
          ? Effect.void
          : onHttp(
              prepared.agentAccess.revokeKey({ config: prepared.config, keyId: owned.agentKeyId }),
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
      /**
       * Fails instead of warning when the sandbox cannot reach Claude's endpoint: a thread handed
       * a sandbox like that would sit on Thinking while Claude retries.
       */
      readonly requireClaudeReach?: boolean;
    },
  ) {
    const { driver, config, label, size, input, claude, githubToken, tailnet } = prepared;
    const { report, owned } = context;
    const hostEnvironmentId = yield* environmentIdentity.getEnvironmentId;

    yield* report.stage("create", "running");
    // Made for this sandbox alone and passing no credentials, so its forks land there.
    const agentEnvironment =
      prepared.agentAccess === undefined
        ? undefined
        : yield* onHttp(
            prepared.agentAccess.createEnvironment({
              config,
              name: yield* agentAccessName(label),
            }),
          );
    if (agentEnvironment !== undefined) owned.agentEnvironment = agentEnvironment;
    const sandbox = yield* onHttp(
      driver.create({
        config,
        name: label,
        size,
        ttlMinutes: prepared.maxRunningMinutes,
        environment: agentEnvironment?.name ?? input.environment,
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
      ...(agentEnvironment === undefined
        ? {}
        : {
            agentProviderAccess: {
              environmentId: agentEnvironment.id,
              environmentName: agentEnvironment.name,
            },
          }),
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
    let unreachableClaude: string | null = null;
    const claudeState: SandboxSetupState =
      claude === undefined || claudeInstalled !== "ready"
        ? claudeInstalled
        : yield* run(
            endpointReachScript(claude.baseUrl, viaProxy ? TAILSCALE_PROXY_URL : undefined),
            60,
          ).pipe(
            Effect.map((result) => parseEndpointReach(result.stdout)),
            Effect.orElseSucceed(() => null),
            Effect.flatMap((reach) =>
              reach !== "unreachable"
                ? Effect.succeed<SandboxSetupState>("ready")
                : hostAccess.endpointIsPrivate(claude.baseUrl).pipe(
                    Effect.flatMap((isPrivate) => {
                      unreachableClaude = unreachableEndpointWarning(
                        claude.baseUrl,
                        isPrivate,
                        tailnetJoined === null ? undefined : tailnet?.client.tag,
                      );
                      return warn(unreachableClaude);
                    }),
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
    if (context.requireClaudeReach === true && unreachableClaude !== null) {
      return yield* new SandboxProviderError({
        provider: input.provider,
        stage: "start",
        detail: unreachableClaude,
      });
    }
    // The key is scoped to this sandbox's id, so it is minted only now. T3 never keeps it: the
    // CLI's own config on the sandbox does, and the record names it by id to revoke it.
    if (prepared.agentAccess !== undefined && agentEnvironment !== undefined) {
      const agentAccess = prepared.agentAccess;
      const environment = {
        environmentId: agentEnvironment.id,
        environmentName: agentEnvironment.name,
      };
      const minted = yield* onHttp(
        agentAccess.mintKey({
          config: sandboxConfig,
          name: agentEnvironment.name,
          sandboxId: sandbox.id,
          environmentId: agentEnvironment.id,
          ttlMinutes: prepared.maxRunningMinutes,
        }),
      ).pipe(Effect.option);
      if (Option.isNone(minted)) {
        yield* warn(
          `T3 Code could not make a ${driver.info.label} key for the agent, so it cannot use ${driver.info.label} on this sandbox.`,
        );
      } else {
        owned.agentKeyId = minted.value.id;
        yield* save({ agentProviderAccess: { ...environment, keyId: minted.value.id } });
        const login = yield* run(
          agentAccess.loginScript(Redacted.value(minted.value.secret)),
          120,
        ).pipe(Effect.exit);
        if (Exit.isFailure(login)) {
          yield* onHttp(
            agentAccess.revokeKey({ config: sandboxConfig, keyId: minted.value.id }),
          ).pipe(Effect.ignore);
          delete owned.agentKeyId;
          yield* save({ agentProviderAccess: environment });
          yield* warn(
            `The ${driver.info.label} CLI could not be signed in on the sandbox, so the agent cannot use ${driver.info.label}. T3 Code revoked its key.`,
          );
        }
      }
    }
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

  const runOnRecord =
    (record: SandboxRecord) => (script: string | SandboxScript, timeoutSeconds: number) => {
      const driver = findDriver(record.provider);
      return recordConfig(driver, record).pipe(
        Effect.flatMap((config) =>
          onHttp(
            driver.execute({
              config,
              sandboxId: record.sandboxId,
              timeoutSeconds,
              ...asScript(script),
            }),
          ),
        ),
      );
    };

  /**
   * Writes the link the host's sandbox bridge reads for `record`'s thread. The bearer it carries is
   * minted on the sandbox only when there is none, its secret is gone, or it is near expiry; the
   * link itself is rewritten every time, since a resumed sandbox can come back at a new address.
   */
  const ensureBridge = Effect.fn("SandboxProvisioner.ensureBridge")(function* (
    record: SandboxRecord,
    run: Machine["run"],
  ) {
    const failed = (detail: string, cause?: unknown) =>
      new SandboxProviderError({
        provider: record.provider,
        stage: "pair",
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    if (record.threadId === undefined || record.sandboxProjectId === undefined) {
      return yield* failed("This sandbox was not launched for a thread.");
    }
    const secret = bridgeLinkSecretName(record.threadId);
    const stored =
      record.bridge === undefined
        ? Option.none<SandboxBridgeLink>()
        : yield* secrets.get(secret).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeedNone,
                onSome: (bytes) =>
                  decodeBridgeLink(new TextDecoder().decode(bytes)).pipe(Effect.asSome),
              }),
            ),
            Effect.orElseSucceed(Option.none<SandboxBridgeLink>),
          );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const fresh =
      record.bridge !== undefined &&
      Option.isSome(stored) &&
      Date.parse(record.bridge.expiresAt) - now > BRIDGE_RENEW_BEFORE_MS;
    let token: string;
    let bridge: NonNullable<SandboxRecord["bridge"]>;
    if (fresh && Option.isSome(stored) && record.bridge !== undefined) {
      token = stored.value.token;
      bridge = record.bridge;
    } else {
      const key = yield* makePairingKey;
      const minted = yield* run(
        bridgeCredentialScript(key.publicKeyPem, record.bridge?.sessionId),
        60,
      );
      const report = readBridgeCredential(minted.stdout, key.privateKey);
      if (report._tag === "failed") {
        const status = report.exitCode === undefined ? "" : ` It exited with ${report.exitCode}.`;
        return yield* failed(
          `${BRIDGE_FAILURES[report.reason]}${status}`,
          report.stderr === undefined ? undefined : new Error(report.stderr),
        );
      }
      token = report.token;
      bridge = { sessionId: report.sessionId, secret, expiresAt: report.expiresAt };
    }
    const link: SandboxBridgeLink = {
      threadId: record.threadId,
      instanceId: record.instanceId,
      sandboxId: record.sandboxId,
      label: record.label,
      httpBaseUrl: record.httpBaseUrl,
      sandboxProjectId: record.sandboxProjectId,
      token,
    };
    const encoded = yield* encodeBridgeLink(link).pipe(Effect.orDie);
    yield* secrets
      .set(secret, new TextEncoder().encode(encoded))
      .pipe(
        Effect.mapError((cause) =>
          failed("Could not save the sandbox bridge's credential on this server.", cause),
        ),
      );
    return bridge;
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

  /**
   * Whether a launch joins the tailnet: when its config asks to, and on its own when Claude's
   * endpoint only resolves to private or tailnet addresses, since Claude there could not reach it
   * otherwise. Decided at each launch, so a config saved before Tailscale was set up still works.
   * Refused before anything bills when the endpoint is private and there is no Tailscale to join.
   */
  const launchJoinsTailnet = Effect.fn("SandboxProvisioner.launchJoinsTailnet")(function* (
    config: SandboxEnvironmentConfig,
  ) {
    if (config.joinTailnet || config.access === "tailnet") return true;
    const baseUrl = config.claude?.baseUrl;
    if (baseUrl === undefined || !(yield* hostAccess.endpointIsPrivate(baseUrl))) return false;
    if (tailscaleClient(yield* settings.getSettings.pipe(Effect.orDie)) !== undefined) return true;
    const host = URL.parse(baseUrl)?.host ?? baseUrl;
    return yield* new SandboxProviderError({
      provider: config.provider,
      stage: "config",
      code: "tailscale_required",
      detail: `The sandbox can't reach ${host}, which only your private network or tailnet reaches. Set up Tailscale under Sandboxes in Settings → Connections so sandboxes can join your tailnet.`,
    });
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
    /** Bumped by each pairing or retry, so the client wait starts over. */
    activity: number;
    /** Set when T3 stops the launch for a reason the card shows; a plain cancel leaves it null. */
    stopReason: string | null;
  }
  const launches = new Map<ThreadId, Launch>();

  // Waits on the client, starting over while it pairs or retries; past the wait the launch fails
  // and releases what it made, so a client that never comes back leaves nothing billing.
  const awaitClient = Effect.fn("SandboxProvisioner.awaitClient")(function* <A>(
    launch: Launch,
    wait: Effect.Effect<A>,
  ) {
    while (true) {
      const seen = launch.activity;
      const result = yield* Effect.timeoutOption(wait, LAUNCH_CLIENT_WAIT);
      if (Option.isSome(result)) return result.value;
      if (launch.activity === seen) {
        return yield* new SandboxProviderError({
          provider: launch.config.provider,
          stage: "pair",
          detail: LAUNCH_CLIENT_TIMEOUT,
        });
      }
    }
  });

  const stopLaunch = (launch: Launch, reason: string | null) =>
    Effect.suspend(() => {
      launch.stopReason = reason;
      return Fiber.interrupt(launch.fiber);
    });

  const launchConfigError = (detail: string, provider: SandboxProviderKind = "boat") =>
    new SandboxProviderError({ provider, stage: "config", detail });

  const createInputFor = (
    config: SandboxEnvironmentConfig,
    project: SandboxLaunchInput["project"],
    joinTailnet: boolean,
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
    ...(joinTailnet ? { joinTailnet: true } : {}),
    ...(config.agentProviderAccess === true ? { agentProviderAccess: true } : {}),
  });

  const copyEnvFiles = Effect.fn("SandboxProvisioner.copyEnvFiles")(function* (
    machine: Machine,
    workspaceRoot: string,
    directory: string,
    selected: ReadonlyArray<string> | undefined,
  ) {
    const listed =
      selected !== undefined
        ? null
        : yield* workspaceEntries.listIgnoredFiles({ cwd: workspaceRoot }).pipe(Effect.option);
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
        .readFile({ cwd: workspaceRoot, relativePath: path })
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
    launch: Launch,
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
      yield* awaitClient(launch, Queue.take(launch.retries));
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
      const joinTailnet = yield* launchJoinsTailnet(config);
      const prepared = yield* prepare(createInputFor(config, input.project, joinTailnet));
      yield* reporter.stage("preflight", "done");
      const owned: Owned = {};
      yield* Effect.gen(function* () {
        const machine = yield* provisionMachine(prepared, {
          instanceId,
          owned,
          report: reporter,
          requireClaudeReach: true,
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
        const repository = githubRepositoryOf(input.project.remoteUrl);
        yield* machine.save({
          repoDir: cloned.directory,
          // The host's sandbox bridge creates the thread in this project on the sandbox.
          sandboxProjectId: cloned.projectId,
          ...(repository === null ? {} : { repository: repository.label }),
        });
        yield* reporter.stage("repo", "done", cloned.directory.replace(/^.*\/work\//u, "~/work/"));

        yield* reporter.stage("env-files", "running");
        const hostCopy = yield* verifiedHostCopy(input.project);
        if (hostCopy !== null) yield* machine.save({ hostProjectId: hostCopy.projectId });
        const repositoryKey = repository?.key;
        const copied =
          hostCopy === null
            ? { copied: 0, failed: [] as ReadonlyArray<string> }
            : yield* copyEnvFiles(
                machine,
                hostCopy.workspaceRoot,
                cloned.directory,
                (repositoryKey === undefined ? undefined : config.envFiles[repositoryKey]) ??
                  config.envFiles[hostCopy.projectId],
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
        yield* awaitClient(launch, Deferred.await(handoff));
        yield* machine.save({ state: "running" });
        // Only the host's bridge (and so the phone) needs this; the client's own pairing is done.
        yield* ensureBridge(machine.record(), machine.run).pipe(
          Effect.flatMap((bridge) => machine.save({ bridge })),
          Effect.catch((error) =>
            reporter.warn(`Phones cannot drive this thread yet: ${error.detail}`),
          ),
        );
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
            ? state.launch?.stopReason == null
              ? tracker.finish(threadId, "cancelled")
              : tracker.finish(threadId, "failed", {
                  error: state.launch.stopReason,
                  recovery: "relaunch",
                })
            : tracker.finish(threadId, "failed", {
                error: Option.match(Exit.findErrorOption(exit), {
                  onNone: () => "The sandbox could not be set up.",
                  onSome: (error) => error.detail,
                }),
                // A refusal that a new sandbox would hit again points at its fix instead.
                recovery: Option.match(Exit.findErrorOption(exit), {
                  onNone: () => "relaunch" as const,
                  onSome: (error) =>
                    error.code === "tailscale_required"
                      ? ("set-up-tailscale" as const)
                      : ("relaunch" as const),
                }),
              }),
      ),
    );
    const fiber = yield* tracked(instanceId, run);
    const launch: Launch = {
      input,
      config,
      instanceId,
      fiber,
      retries,
      handoff,
      ready: null,
      activity: 0,
      stopReason: null,
    };
    state.launch = launch;
    launches.set(threadId, launch);
    return { instanceId } satisfies SandboxLaunchResult;
  });

  /**
   * The project's copy on this server, when the client named one and it is an active project here
   * at that directory; env files are read from nowhere else.
   */
  const verifiedHostCopy = Effect.fn("SandboxProvisioner.verifiedHostCopy")(function* (
    project: SandboxLaunchInput["project"],
  ) {
    const claimed = project.hostCopy;
    if (claimed === undefined) return null;
    const found = yield* projectStore.get(claimed.projectId).pipe(Effect.option);
    if (Option.isNone(found) || Option.isNone(found.value)) return null;
    const row = found.value.value;
    return row.deletedAt === null && row.workspaceRoot === claimed.workspaceRoot
      ? { projectId: row.projectId, workspaceRoot: row.workspaceRoot }
      : null;
  });

  // What the provider says of a record's machine; null when it cannot say or does not answer.
  const providerStatus = Effect.fn("SandboxProvisioner.providerStatus")(function* (
    record: SandboxRecord,
  ) {
    const driver = findDriver(record.provider);
    if (driver.status === undefined) return null;
    const config = yield* recordConfig(driver, record).pipe(Effect.option);
    if (Option.isNone(config)) return null;
    return yield* onHttp(driver.status({ config: config.value, sandboxId: record.sandboxId })).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("sandbox status check failed", {
          instanceId: record.instanceId,
          sandboxId: record.sandboxId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
  });

  // A thread has one sandbox, so a new launch replaces what an earlier, unfinished one left.
  const releaseAbandoned = Effect.fn("SandboxProvisioner.releaseAbandoned")(function* (
    threadId: ThreadId,
  ) {
    const all = yield* records.list.pipe(Effect.orDie);
    for (const record of all) {
      if (record.threadId !== threadId || liveInstances.has(record.instanceId)) continue;
      if (record.state !== "provisioning" && record.abandonedAt === undefined) continue;
      yield* removeSandbox(
        { provider: record.provider, sandboxId: record.sandboxId, instanceId: record.instanceId },
        false,
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("abandoned sandbox cleanup failed", {
            instanceId: record.instanceId,
            sandboxId: record.sandboxId,
            cause,
          }),
        ),
      );
    }
  });

  const launch = Effect.fn("SandboxProvisioner.launch")(function* (input: SandboxLaunchInput) {
    const current = runningLaunch(input.threadId);
    if (current !== null) {
      // A send while the thread's sandbox starts follows that launch instead of failing; one that
      // failed, or whose machine the provider no longer has, gives way to a new one.
      const snapshot = yield* tracker.get(input.threadId);
      const record = yield* records.get(current.instanceId).pipe(Effect.orDie);
      const gone = Option.isSome(record) && (yield* providerStatus(record.value)) === "deleted";
      if (snapshot?.phase !== "failed" && !gone) {
        return { instanceId: current.instanceId } satisfies SandboxLaunchResult;
      }
      yield* stopLaunch(current, gone ? LAUNCH_DELETED_OUTSIDE : null);
    }
    const found = yield* configStore.get(input.configId).pipe(Effect.orDie);
    if (Option.isNone(found)) {
      return yield* launchConfigError("This sandbox config no longer exists.");
    }
    const config = found.value;
    // The sandbox clones from GitHub, so the project may live on any machine the client reaches.
    if (githubRepositoryOf(input.project.remoteUrl) === null) {
      return yield* launchConfigError(
        "Only projects with a github.com remote can start in a sandbox.",
        config.provider,
      );
    }
    yield* releaseAbandoned(input.threadId);
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
    current.activity += 1;
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
    if (snapshot.recovery === "relaunch" || snapshot.recovery === "set-up-tailscale") {
      // A new sandbox follows the config as saved now, which may have changed since.
      const saved = yield* configStore.get(current.config.id).pipe(Effect.orDie);
      if (Option.isNone(saved)) {
        return yield* launchConfigError(
          "This sandbox config no longer exists.",
          current.config.provider,
        );
      }
      yield* startLaunch(current.input, saved.value);
      return;
    }
    current.activity += 1;
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
    if (input.config.agentProviderAccess === true) {
      const refusal = agentAccessRefusal(driver, input.config.credentialEnvironment);
      if (refusal !== null) return yield* configError(provider, refusal);
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

  // Revokes the agent's key first, so no fork starts while the rest goes. Forks are deleted only
  // when the user deletes their sandbox; the environment goes only once nothing is left in it,
  // since it is the only way to find a fork again.
  const releaseAgentAccess = Effect.fn("SandboxProvisioner.releaseAgentAccess")(function* (
    driver: SandboxProviderDriver,
    config: SandboxProviderConfig,
    record: SandboxRecord,
    deleteForks: boolean,
  ) {
    const reference = record.agentProviderAccess;
    const agentAccess = driver.agentAccess;
    if (reference === undefined || agentAccess === undefined) {
      return { warnings: [] as Array<string>, finish: () => Effect.succeed<string | null>(null) };
    }
    const name = driver.info.label;
    const warnings: Array<string> = [];
    if (reference.keyId !== undefined) {
      const revoked = yield* onHttp(agentAccess.revokeKey({ config, keyId: reference.keyId })).pipe(
        Effect.exit,
      );
      if (Exit.isFailure(revoked)) {
        warnings.push(
          `The ${name} key T3 Code made for ${record.label}'s agent could not be revoked. Revoke the key named ${reference.environmentName} in ${name}.`,
        );
      }
    }
    const listed = yield* onHttp(
      agentAccess.listSandboxes({ config, environmentName: reference.environmentName }),
    ).pipe(Effect.option);
    const forks = Option.isNone(listed)
      ? null
      : listed.value.filter((sandbox) => sandbox.id !== record.sandboxId);
    const survivors: Array<string> = [];
    for (const fork of forks ?? []) {
      const deleted = deleteForks
        ? Exit.isSuccess(
            yield* onHttp(driver.destroy({ config, sandboxId: fork.id })).pipe(
              Effect.catchIf(
                (error) => error.code === "not_found",
                () => Effect.void,
              ),
              Effect.exit,
            ),
          )
        : false;
      if (!deleted) survivors.push(fork.id);
      else yield* Ref.update(orphans, (current) => current.filter((o) => o.sandboxId !== fork.id));
    }
    if (deleteForks && survivors.length > 0) {
      warnings.push(
        `${survivors.length === 1 ? "A fork" : `${survivors.length} forks`} of ${record.label} could not be deleted: ${survivors.join(", ")}. Delete ${survivors.length === 1 ? "it" : "them"} in ${name}.`,
      );
    }
    // Runs after the sandbox itself is deleted.
    const finish = () =>
      forks === null || survivors.length > 0
        ? Effect.succeed<string | null>(null)
        : onHttp(
            agentAccess.deleteEnvironment({ config, environmentId: reference.environmentId }),
          ).pipe(
            Effect.as<string | null>(null),
            Effect.orElseSucceed(
              () =>
                `The ${name} environment ${reference.environmentName} could not be deleted. It holds nothing; delete it in ${name}.`,
            ),
          );
    return { warnings, finish };
  });

  const remove = (input: SandboxDeleteInput) => removeSandbox(input, true);

  const linkBridge = Effect.fn("SandboxProvisioner.linkBridge")(function* (input: {
    readonly threadId: ThreadId;
    readonly hostProjectId: ProjectId;
  }) {
    const starting = runningLaunch(input.threadId);
    if (starting !== null) {
      return yield* new SandboxProviderError({
        provider: starting.config.provider,
        stage: "pair",
        detail: "This thread's sandbox is still starting.",
      });
    }
    const all = yield* records.list.pipe(Effect.orDie);
    const record = all.find(
      (candidate) => candidate.threadId === input.threadId && candidate.state !== "deleted",
    );
    if (record === undefined) {
      return yield* new SandboxProviderError({
        provider: "boat",
        stage: "pair",
        detail: "No sandbox belongs to this thread.",
      });
    }
    const bridge = yield* ensureBridge(record, runOnRecord(record));
    const updated: SandboxRecord = {
      ...record,
      hostProjectId: input.hostProjectId,
      bridge,
      updatedAt: yield* nowIso,
    };
    yield* records.put(updated).pipe(Effect.orDie);
    return updated;
  });

  const removeSandbox = Effect.fn("SandboxProvisioner.delete")(function* (
    input: SandboxDeleteInput,
    deleteForks: boolean,
  ) {
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
    const driver = findDriver(input.provider);
    // A sandbox the provider already deleted needs no key to clear from the list.
    const machineGone = Option.isSome(record) && record.value.state === "deleted";
    const config = Option.isNone(record)
      ? Option.some(yield* resolveConfig(driver))
      : machineGone
        ? yield* recordConfig(driver, record.value).pipe(Effect.option)
        : Option.some(yield* recordConfig(driver, record.value));
    const agent =
      Option.isNone(record) || Option.isNone(config)
        ? null
        : yield* releaseAgentAccess(driver, config.value, record.value, deleteForks);
    if (!machineGone && Option.isSome(config)) {
      yield* onHttp(driver.destroy({ config: config.value, sandboxId: input.sandboxId })).pipe(
        // Deleted from the provider's dashboard before the sweep noticed: the record still goes.
        Effect.catchIf(
          (error) => error.code === "not_found",
          () => Effect.void,
        ),
      );
    }
    const environmentWarning = agent === null ? null : yield* agent.finish();
    if (instanceId !== undefined) yield* records.remove(instanceId).pipe(Effect.orDie);
    // The bearer dies with the machine; only this server's copy is left to clear.
    if (Option.isSome(record) && record.value.bridge !== undefined) {
      yield* secrets.remove(record.value.bridge.secret).pipe(Effect.ignore);
    }
    yield* Ref.update(orphans, (current) =>
      current.filter((orphan) => orphan.sandboxId !== input.sandboxId),
    );
    // A sandbox deleted outside T3 still has its key on the hub, so this runs for every record.
    const warnings = Option.isNone(record)
      ? []
      : [
          ...(agent?.warnings ?? []),
          environmentWarning,
          yield* releaseHubKey(record.value),
          yield* releaseTailnetDevice(record.value),
        ].filter((warning): warning is string => warning !== null);
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

  // A short check before a delete. A stopped sandbox is not woken for it: on Boat a command
  // restores the machine, which counts as a start.
  const checkWork = Effect.fn("SandboxProvisioner.checkWork")(function* (
    input: SandboxLifecycleInput,
  ) {
    const record = yield* readRecord(input.instanceId);
    const unknown = (detail: string): SandboxCheckWorkResult => ({
      status: "unknown",
      uncommittedFiles: 0,
      unpushedCommits: 0,
      detail,
    });
    if (record.state !== "running") {
      return unknown("The sandbox is not running, so its work could not be checked.");
    }
    if (record.repoDir === undefined) {
      return unknown("T3 Code does not know where this sandbox's repository is.");
    }
    const driver = findDriver(record.provider);
    const config = yield* recordConfig(driver, record);
    const report = yield* onHttp(
      driver.execute({
        config,
        sandboxId: record.sandboxId,
        command: workCheckScript(record.repoDir),
        timeoutSeconds: WORK_CHECK_SECONDS,
      }),
    ).pipe(
      Effect.map((result) => parseWorkCheck(result.stdout)),
      Effect.timeoutOrElse({
        duration: `${WORK_CHECK_SECONDS + 5} seconds`,
        orElse: () => Effect.succeed(null),
      }),
      Effect.orElseSucceed(() => null),
    );
    if (report === null) return unknown("The sandbox did not answer in time.");
    return {
      status: report.files === 0 && report.commits === 0 ? "clean" : "dirty",
      uncommittedFiles: report.files,
      unpushedCommits: report.commits,
    } satisfies SandboxCheckWorkResult;
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
    // The bridge reads the sandbox's address from its link, and its bearer may be near expiry.
    const bridged =
      updated.bridge === undefined
        ? { record: updated, warning: null }
        : yield* ensureBridge(updated, runOnRecord(updated)).pipe(
            Effect.map((bridge) => ({ record: { ...updated, bridge }, warning: null })),
            Effect.catch((error) =>
              Effect.succeed({
                record: updated,
                warning: `Phones may not reach this thread: ${error.detail}`,
              }),
            ),
          );
    if (bridged.record !== updated) yield* records.put(bridged.record).pipe(Effect.orDie);
    const warnings = [rejoined.warning, bridged.warning].filter(
      (warning): warning is string => warning !== null,
    );
    return {
      sandbox: bridged.record,
      httpBaseUrl: bridged.record.httpBaseUrl,
      ...(warnings.length === 0 ? {} : { warnings }),
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
    // An abandoned launch's machine that is gone leaves only its keys, which go with the record.
    if (state === "deleted" && record.abandonedAt !== undefined) {
      return yield* releaseRecord(record);
    }
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
    // Forks carry no tag of this server; the environment made for their sandbox finds them.
    for (const record of all) {
      const reference = record.agentProviderAccess;
      const config = configs.get(record.provider);
      const { agentAccess } = findDriver(record.provider);
      if (reference === undefined || config === undefined || agentAccess === undefined) continue;
      const listed = yield* onHttp(
        agentAccess.listSandboxes({
          config: withSettings(config, record.providerSettings),
          environmentName: reference.environmentName,
        }),
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("sandbox fork listing failed", {
            instanceId: record.instanceId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (listed === null) {
        found.push(
          ...(yield* Ref.get(orphans)).filter((orphan) => orphan.forkOf === record.instanceId),
        );
        continue;
      }
      for (const sandbox of listed) {
        if (tracked.has(`${record.provider}:${sandbox.id}`)) continue;
        if (found.some((orphan) => orphan.sandboxId === sandbox.id)) continue;
        found.push({
          provider: record.provider,
          sandboxId: sandbox.id,
          name: sandbox.name,
          forkOf: record.instanceId,
          ...(sandbox.createdAt === undefined ? {} : { createdAt: sandbox.createdAt }),
        });
      }
    }
    yield* Ref.set(orphans, found);
  });

  // Releases a record's machine, hub key, tailnet device and scoped key. Forks are the user's to
  // delete, never the sweep's.
  const releaseRecord = (record: SandboxRecord) =>
    removeSandbox(
      { provider: record.provider, sandboxId: record.sandboxId, instanceId: record.instanceId },
      false,
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("abandoned sandbox cleanup failed", {
          instanceId: record.instanceId,
          sandboxId: record.sandboxId,
          cause,
        }),
      ),
    );

  // A machine still up after its launch was lost is the user's call: it shows as failed, with
  // Delete in the list and a new launch on its card.
  const abandonLaunch = Effect.fn("SandboxProvisioner.abandonLaunch")(function* (
    record: SandboxRecord,
    now: string,
  ) {
    yield* putIfUnchanged(record, { ...withState(record, "error", now), abandonedAt: now });
    const { threadId, configId } = record;
    if (threadId === undefined || configId === undefined) return;
    if ((yield* tracker.get(threadId)) !== null) return;
    yield* tracker.begin({
      threadId,
      instanceId: record.instanceId,
      configId,
      label: record.label,
      provider: record.provider,
    });
    yield* tracker.finish(threadId, "failed", { error: LAUNCH_ABANDONED, recovery: "relaunch" });
  });

  const sweepProvisioning = Effect.fn("SandboxProvisioner.sweepProvisioning")(function* (
    record: SandboxRecord,
    now: string,
  ) {
    // An unreachable provider says nothing about the machine, so the record waits for a later sweep.
    const status = yield* providerStatus(record);
    if (status === null) return;
    const live = [...launches.values()].find(
      (candidate) =>
        candidate.instanceId === record.instanceId && candidate.fiber.pollUnsafe() === undefined,
    );
    if (live !== undefined || liveInstances.has(record.instanceId)) {
      // Deleted at the provider mid-launch: stopping the launch releases everything it made.
      if (status !== "deleted") return;
      if (live !== undefined) yield* stopLaunch(live, LAUNCH_DELETED_OUTSIDE);
      else yield* Fiber.interrupt(liveInstances.get(record.instanceId)!);
      return;
    }
    // A launch lost with its server (a restart mid-launch) has nobody left to finish it.
    if (status === "deleted") return yield* releaseRecord(record);
    yield* abandonLaunch(record, now);
  });

  const sweep = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const all = yield* records.list.pipe(Effect.orDie);
    yield* Effect.forEach(
      all.filter((record) => record.state === "provisioning"),
      (record) => sweepProvisioning(record, DateTime.formatIso(now)),
      { concurrency: 4, discard: true },
    );
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
    checkWork,
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
    checkTailscale,
    sweep,
    linkBridge,
  });
});

export const layer = Layer.effect(SandboxProvisioner, make);

/** The provisioner with the host access, provider HTTP client and record stores only it uses. */
export const layerRuntime = layer.pipe(
  Layer.provide(SandboxHostAccess.layer),
  Layer.provide(ProjectStore.layer),
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
    [WS_METHODS.sandboxesCheckWork]: (input: SandboxLifecycleInput) => sandboxes.checkWork(input),
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
    [WS_METHODS.sandboxesCheckTailscale]: (input: SandboxTailscaleCheckInput) =>
      sandboxes.checkTailscale(input),
  };
});
