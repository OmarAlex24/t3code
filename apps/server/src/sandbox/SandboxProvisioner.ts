import {
  assessSandboxStart,
  ExecutionEnvironmentDescriptor,
  type EnvironmentId,
  type SandboxCreateInput,
  type SandboxCreateResult,
  type SandboxCredentialEnvironment,
  type SandboxCredentialEnvironmentsInput,
  type SandboxCredentialEnvironmentsResult,
  type SandboxDeleteInput,
  type SandboxDeleteResult,
  type SandboxHostAccess as SandboxHostAccessFacts,
  type SandboxSetupState,
  type ServerSettings as ServerSettingsValue,
  type UsageLimitSourceConfig,
  UsageLimitSourceId,
  type SandboxExtendInput,
  type SandboxExtendResult,
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
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest } from "effect/http";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxRecords from "../persistence/SandboxRecords.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { makeCliproxyApi } from "../usage/cliproxyApi.ts";
import * as SandboxHostAccess from "./SandboxHostAccess.ts";
import {
  CLAUDE_SETTINGS_SCRUB,
  claudeSettingsScript,
  endpointReachScript,
  ENSURE_TOOLS_SCRIPT,
  parseEndpointReach,
  parseMissingTools,
  type SandboxTool,
  GITHUB_LOGIN_SCRUB,
  githubLoginScript,
} from "./sandboxSetup.ts";
import {
  requestJson,
  shellQuote,
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
tail -50 "$HOME/.t3/sandbox-server.log" >&2 || true
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

const unreachableEndpointWarning = (baseUrl: string, isPrivate: boolean) => {
  const host = URL.parse(baseUrl)?.host ?? baseUrl;
  return isPrivate
    ? `The sandbox cannot reach ${host}. It is only reachable from your private network or tailnet; expose it publicly (for example with Tailscale Funnel or Cloudflare Tunnel) or use another endpoint.`
    : `The sandbox cannot reach ${host}. Check that it accepts connections from the internet, or use another endpoint.`;
};

interface HubKey {
  readonly sourceId: string;
  readonly source: UsageLimitSourceConfig;
  readonly value: Redacted.Redacted<string>;
}

const PAIR_SCRIPT = `set -eu
export PATH="$HOME/.local/bin:$PATH"
t3 pair --ttl 30m`;

const parsePairingToken = (output: string): string | null => {
  const match = /^\s*Token:\s*(\S+)\s*$/mu.exec(output);
  return match?.[1] ?? null;
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

export class SandboxProvisioner extends Context.Service<
  SandboxProvisioner,
  {
    readonly providers: Effect.Effect<SandboxProvidersResult>;
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
    readonly extend: (
      input: SandboxExtendInput,
    ) => Effect.Effect<SandboxExtendResult, SandboxProviderError>;
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
    /** Stops sandboxes past their deadline and syncs every other record with its provider. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/sandbox/SandboxProvisioner") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const records = yield* SandboxRecords.SandboxRecordRepository;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const hostAccess = yield* SandboxHostAccess.SandboxHostAccess;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const hubApi = yield* makeCliproxyApi;
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
  const readRecord = (environmentId: EnvironmentId) =>
    records
      .get(environmentId)
      .pipe(
        Effect.orDie,
        Effect.map(
          Option.getOrThrowWith(
            () => new Error(`No sandbox record exists for environment ${environmentId}.`),
          ),
        ),
      );

  // The first enabled CLIProxyAPI usage source with a management key is the hub new Claude keys go on.
  const hubSource = (value: ServerSettingsValue) =>
    Object.entries(value.usageLimitSources).find(
      ([, source]) => source.enabled && source.kind === "cliproxy" && source.managementKey !== "",
    );

  const hostAccessFacts = Effect.gen(function* () {
    const claude = yield* hostAccess.claude;
    const hub = hubSource(yield* settings.getSettings.pipe(Effect.orDie));
    const github = Option.isSome(yield* hostAccess.githubToken);
    if (claude.baseUrl === undefined || (hub === undefined && claude.authToken === undefined)) {
      return { github } satisfies SandboxHostAccessFacts;
    }
    return {
      claude: {
        baseUrl: claude.baseUrl,
        key: hub === undefined ? "copy" : "hub",
        privateNetwork: yield* hostAccess.endpointIsPrivate(claude.baseUrl),
      },
      github,
    } satisfies SandboxHostAccessFacts;
  });

  const providers = Effect.gen(function* () {
    const value = yield* settings.getSettings.pipe(Effect.orDie);
    return {
      providers: SANDBOX_PROVIDER_DRIVERS.map((driver): SandboxProviderInfo => ({
        ...driver.info,
        configured: (value.sandboxProviders[driver.info.kind]?.apiKey.trim() ?? "") !== "",
        ...(driver.info.settingsFields === undefined
          ? {}
          : { settings: value.sandboxProviders[driver.info.kind]?.settings ?? {} }),
        capabilities: {
          limits: driver.limits !== undefined,
          stopResume: driver.stop !== undefined && driver.resume !== undefined,
          credentialEnvironments: driver.listEnvironments !== undefined,
          extend: driver.extend !== undefined,
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
    const hex = (yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError(() => configError(provider, "Could not generate a key for the sandbox.")),
      )).replaceAll("-", "");
    // A UUIDv4's version and variant digits are fixed, so they are left out.
    const random = `${hex.slice(0, 12)}${hex.slice(13, 16)}${hex.slice(17, 18)}`;
    const value = `t3-sandbox-${labelSlug(label)}-${random}`;
    yield* hubApi
      .addApiKey(source, value)
      .pipe(
        Effect.mapError((error) =>
          configError(
            provider,
            `Could not add a key for this sandbox on the CLIProxyAPI hub. ${error.detail}`,
          ),
        ),
      );
    return { sourceId, source, value: Redacted.make(value) } satisfies HubKey;
  });

  const revokeHubKey = (key: HubKey) =>
    hubApi.removeApiKey(key.source, Redacted.value(key.value)).pipe(
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
  ) {
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

  const create = Effect.fn("SandboxProvisioner.create")(function* (input: SandboxCreateInput) {
    const driver = findDriver(input.provider);
    const config = yield* resolveConfig(driver, { apiKey: input.apiKey, settings: input.settings });
    const label = input.label?.trim() || `${driver.info.label} sandbox`;
    if (input.environment !== undefined && input.allowCredentials !== true) {
      return yield* new SandboxProviderError({
        provider: input.provider,
        stage: "config",
        detail:
          "This sandbox would receive the credential environment's secrets. Confirm that explicitly first.",
      });
    }
    const template = input.template?.trim() || undefined;
    let size = input.size?.trim() || driver.defaultSize;
    if (template !== undefined) {
      if (driver.listTemplates === undefined) {
        return yield* new SandboxProviderError({
          provider: input.provider,
          stage: "config",
          detail: "This provider cannot start a sandbox from a template.",
        });
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
    // The record keeps the clamped lifetime, so its deadline matches what the provider enforces.
    const ttlMinutes = Math.min(input.ttlMinutes ?? 480, limits?.maxTtlMinutes ?? Infinity);
    // Built before the machine exists, so a bad driver definition cannot strand a billed sandbox.
    const installCommand = installScript(label);
    const startCommand = startScript(driver.serveEnvironment);
    const githubToken =
      input.passGithubToken === true ? yield* hostAccess.githubToken : Option.none();
    if (input.passGithubToken === true && Option.isNone(githubToken)) {
      return yield* configError(input.provider, "This server has no GitHub token to share.");
    }
    // Minted before anything bills, so a hub that refuses costs nothing; revoked on any failure.
    const claude = yield* resolveClaudeAccess(input, label);

    return yield* provision({
      input,
      driver,
      config,
      label,
      size,
      ttlMinutes,
      template,
      installCommand,
      startCommand,
      claude,
      githubToken: Option.getOrUndefined(githubToken),
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) || claude?.hubKey === undefined
          ? Effect.void
          : revokeHubKey(claude.hubKey).pipe(Effect.ignore),
      ),
    );
  });

  const provision = Effect.fn("SandboxProvisioner.provision")(function* ({
    input,
    driver,
    config,
    label,
    size,
    ttlMinutes,
    template,
    installCommand,
    startCommand,
    claude,
    githubToken,
  }: {
    readonly input: SandboxCreateInput;
    readonly driver: SandboxProviderDriver;
    readonly config: SandboxProviderConfig;
    readonly label: string;
    readonly size: string;
    readonly ttlMinutes: number;
    readonly template: string | undefined;
    readonly installCommand: string;
    readonly startCommand: string;
    readonly claude:
      | {
          readonly baseUrl: string;
          readonly token: Redacted.Redacted<string>;
          readonly hubKey: HubKey | undefined;
        }
      | undefined;
    readonly githubToken: Redacted.Redacted<string> | undefined;
  }) {
    const idempotencyKey = yield* crypto.randomUUIDv4().pipe(
      Effect.mapError(
        (cause) =>
          new SandboxProviderError({
            provider: input.provider,
            stage: "create",
            detail: "Could not generate a request id for the provider.",
            cause,
          }),
      ),
    );
    const sandbox = yield* onHttp(
      driver.create({
        config,
        name: label,
        size,
        ttlMinutes,
        environment: input.environment,
        idempotencyKey,
        template,
      }),
    );
    const sandboxConfig = withSettings(config, sandbox.settings);

    // A machine that costs money must not survive a failure or an interruption (a client
    // disconnecting mid-install interrupts this fiber), so cleanup runs on every non-success exit.
    const stopOnFailure = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
      onHttp(effect).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : onHttp(driver.destroy({ config: sandboxConfig, sandboxId: sandbox.id })).pipe(
                Effect.ignore,
              ),
        ),
      );
    const run = (command: string, timeoutSeconds: number) =>
      driver.execute({ config: sandboxConfig, sandboxId: sandbox.id, command, timeoutSeconds });

    const httpBaseUrl = yield* stopOnFailure(
      sandbox.publicUrl === undefined
        ? driver.exposePort({
            config: sandboxConfig,
            sandboxId: sandbox.id,
            port: driver.serverPort,
          })
        : Effect.succeed(sandbox.publicUrl),
    );

    yield* stopOnFailure(run(installCommand, 600));

    // Tools and agent setup run before T3 starts, so T3's first provider check already sees them.
    // A step that fails leaves a working sandbox and a warning; a command that carried a secret
    // keeps neither its request nor its output.
    const warnings: Array<string> = [];
    const missingTools = yield* stopOnFailure(
      run(ENSURE_TOOLS_SCRIPT, 300).pipe(
        Effect.map((result) => parseMissingTools(result.stdout)),
        Effect.orElseSucceed(() => null),
      ),
    );
    if (missingTools === null) {
      warnings.push(
        "T3 Code could not check the sandbox for git, the GitHub CLI, and Claude Code.",
      );
    } else {
      for (const tool of missingTools) {
        warnings.push(`${TOOL_LABELS[tool]} could not be installed on the sandbox.`);
      }
    }
    const missing = (tool: SandboxTool) => missingTools?.includes(tool) === true;

    const claudeWritten: SandboxSetupState =
      claude === undefined
        ? "skipped"
        : yield* stopOnFailure(
            run(
              claudeSettingsScript({
                ANTHROPIC_BASE_URL: claude.baseUrl,
                ANTHROPIC_AUTH_TOKEN: Redacted.value(claude.token),
              }),
              60,
            ).pipe(
              Effect.as<SandboxSetupState>("ready"),
              Effect.catch(() =>
                Effect.sync((): SandboxSetupState => {
                  warnings.push(
                    "Claude's settings could not be written on the sandbox. Set up Claude in its Providers settings.",
                  );
                  return "failed";
                }),
              ),
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
        : yield* stopOnFailure(
            run(endpointReachScript(claude.baseUrl), 30).pipe(
              Effect.map((result) => parseEndpointReach(result.stdout)),
              Effect.orElseSucceed(() => null),
            ),
          ).pipe(
            Effect.flatMap((reach) =>
              reach !== "unreachable"
                ? Effect.succeed<SandboxSetupState>("ready")
                : hostAccess.endpointIsPrivate(claude.baseUrl).pipe(
                    Effect.map((isPrivate): SandboxSetupState => {
                      warnings.push(unreachableEndpointWarning(claude.baseUrl, isPrivate));
                      return "failed";
                    }),
                  ),
            ),
          );

    const githubState: SandboxSetupState =
      githubToken === undefined
        ? "skipped"
        : missing("gh")
          ? "failed"
          : yield* stopOnFailure(
              run(githubLoginScript(Redacted.value(githubToken)), 60).pipe(
                Effect.as<SandboxSetupState>("ready"),
                Effect.catch(() =>
                  Effect.sync((): SandboxSetupState => {
                    warnings.push(
                      "GitHub could not be signed in on the sandbox. Run gh auth login in its terminal.",
                    );
                    return "failed";
                  }),
                ),
              ),
            );

    yield* stopOnFailure(run(startCommand, 180));

    // A sandbox that answers with an id T3 already tracks was cloned with another environment's
    // identity and sessions; it must never be paired.
    const descriptor = yield* stopOnFailure(
      requestJson({
        provider: input.provider,
        stage: "pair",
        schema: ExecutionEnvironmentDescriptor,
        request: HttpClientRequest.get(
          `${httpBaseUrl.replace(/\/+$/, "")}/.well-known/t3/environment`,
        ),
      }).pipe(
        Effect.tap((described) =>
          records.get(described.environmentId).pipe(
            Effect.orDie,
            Effect.flatMap((existing) =>
              Option.isNone(existing)
                ? Effect.void
                : Effect.fail(
                    new SandboxProviderError({
                      provider: input.provider,
                      stage: "pair",
                      detail:
                        "The new sandbox answered as an environment that already exists, so it was deleted. Save the template again from a sandbox T3 Code set up.",
                    }),
                  ),
            ),
          ),
        ),
      ),
    );

    const pairingCode = yield* stopOnFailure(
      run(PAIR_SCRIPT, 60).pipe(
        Effect.flatMap((paired) => {
          const code = parsePairingToken(paired.stdout);
          return code === null
            ? Effect.fail(
                new SandboxProviderError({
                  provider: input.provider,
                  stage: "pair",
                  detail: "The sandbox did not return a pairing code.",
                }),
              )
            : Effect.succeed(code);
        }),
      ),
    );

    // The record names where the key is kept; the key itself stays in this server's secrets.
    const claudeHubKey =
      claude?.hubKey === undefined
        ? undefined
        : yield* stopOnFailure(storeHubKey(input.provider, claude.hubKey));

    const createdAt = yield* nowIso;
    const record: SandboxRecord = {
      environmentId: descriptor.environmentId,
      provider: input.provider,
      sandboxId: sandbox.id,
      label,
      size,
      state: "running",
      createdAt,
      updatedAt: createdAt,
      hardDeadlineAt: DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(createdAt), { minutes: ttlMinutes }),
      ),
      ttlMinutes,
      httpBaseUrl,
      ...(input.environment === undefined ? {} : { credentialEnvironment: input.environment }),
      ...(template === undefined ? {} : { template }),
      ...(Object.keys(sandboxConfig.settings).length === 0
        ? {}
        : { providerSettings: sandboxConfig.settings }),
      ...(claudeHubKey === undefined ? {} : { claudeHubKey }),
    };
    yield* records.put(record).pipe(Effect.orDie);

    return {
      provider: input.provider,
      sandboxId: sandbox.id,
      environmentId: descriptor.environmentId,
      label,
      httpBaseUrl,
      pairingCode,
      setup: { claude: claudeState, github: githubState, warnings },
    } satisfies SandboxCreateResult;
  });

  const storeHubKey = Effect.fn("SandboxProvisioner.storeHubKey")(function* (
    provider: SandboxProviderKind,
    key: HubKey,
  ) {
    const failed = () =>
      configError(provider, "Could not save the sandbox's hub key on this server.");
    const secret = `sandbox-hub-key-${yield* crypto.randomUUIDv4().pipe(Effect.mapError(failed))}`;
    yield* secrets
      .set(secret, new TextEncoder().encode(Redacted.value(key.value)))
      .pipe(Effect.mapError(failed));
    return { sourceId: key.sourceId, secret };
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
    if (Option.isNone(stored) || source === undefined || source.managementKey === "") {
      yield* Effect.logWarning("sandbox hub key cannot be revoked", {
        environmentId: record.environmentId,
        sourceId: reference.sourceId,
        keyFound: Option.isSome(stored),
        sourceFound: source !== undefined,
      });
      return warning;
    }
    const revoked = yield* revokeHubKey({
      sourceId: reference.sourceId,
      source,
      value: Redacted.make(new TextDecoder().decode(stored.value)),
    }).pipe(Effect.exit);
    yield* secrets.remove(reference.secret).pipe(Effect.ignore);
    return Exit.isSuccess(revoked) ? null : warning;
  });

  const remove = Effect.fn("SandboxProvisioner.delete")(function* (input: SandboxDeleteInput) {
    const record = yield* records.get(input.environmentId).pipe(Effect.orDie);
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
    yield* records.remove(input.environmentId).pipe(Effect.orDie);
    // A sandbox deleted outside T3 still has its key on the hub, so this runs for every record.
    const warning = Option.isNone(record) ? null : yield* releaseHubKey(record.value);
    return { warnings: warning === null ? [] : [warning] } satisfies SandboxDeleteResult;
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

  const list = records.list.pipe(
    Effect.orDie,
    Effect.map((sandboxes): SandboxListResult => ({ sandboxes })),
  );

  const stop = Effect.fn("SandboxProvisioner.stop")(function* (input: SandboxLifecycleInput) {
    const record = yield* readRecord(input.environmentId);
    const driver = findDriver(record.provider);
    if (driver.stop === undefined) {
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "config",
        detail: "This provider cannot stop a sandbox.",
      });
    }
    const config = yield* recordConfig(driver, record);
    yield* onHttp(driver.stop({ config, sandboxId: record.sandboxId }));
    const updated: SandboxRecord = {
      ...record,
      state: "stopped",
      updatedAt: yield* nowIso,
    };
    yield* records.put(updated).pipe(Effect.orDie);
    return { sandbox: updated } satisfies SandboxStopResult;
  });

  const resume = Effect.fn("SandboxProvisioner.resume")(function* (input: SandboxLifecycleInput) {
    const record = yield* readRecord(input.environmentId);
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
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "config",
        detail: "This provider cannot resume a sandbox.",
      });
    }
    // The deadline is the sandbox's lifetime, not a per-resume window: stopping and resuming must
    // not hand back another full TTL, or the hard limit would never bind.
    const now = yield* nowIso;
    if (
      record.hardDeadlineAt !== null &&
      DateTime.toEpochMillis(DateTime.makeUnsafe(record.hardDeadlineAt)) <=
        DateTime.toEpochMillis(DateTime.makeUnsafe(now))
    ) {
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "start",
        detail: `This sandbox reached its ${Math.round((record.ttlMinutes / 60) * 10) / 10}-hour limit. Delete it and create a new one.`,
      });
    }
    const remainingMinutes =
      record.hardDeadlineAt === null
        ? record.ttlMinutes
        : Math.max(
            1,
            Math.ceil(
              (DateTime.toEpochMillis(DateTime.makeUnsafe(record.hardDeadlineAt)) -
                DateTime.toEpochMillis(DateTime.makeUnsafe(now))) /
                60_000,
            ),
          );
    const config = yield* recordConfig(driver, record);
    // Providers such as Boat count a resume as a start, so it gets the same preflight as create.
    const limits = yield* preflightStart(driver, config, undefined);
    const resumed = yield* onHttp(
      driver.resume({
        config,
        sandboxId: record.sandboxId,
        // The provider's own TTL is a backstop; it must not outlive the record's deadline.
        ttlMinutes: Math.min(remainingMinutes, limits?.maxTtlMinutes ?? Infinity),
      }),
    );
    const httpBaseUrl = resumed.publicUrl ?? record.httpBaseUrl;
    yield* onHttp(
      driver.execute({
        config,
        sandboxId: record.sandboxId,
        command: startScript(driver.serveEnvironment),
        timeoutSeconds: 180,
      }),
    ).pipe(
      Effect.catch((cause) =>
        records.put({ ...record, state: "error", updatedAt: now, httpBaseUrl }).pipe(
          Effect.orDie,
          Effect.andThen(
            Effect.fail(
              new SandboxProviderError({
                provider: record.provider,
                stage: "start",
                detail: "The sandbox resumed, but T3 Code did not start on it.",
                cause,
              }),
            ),
          ),
        ),
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
      yield* records
        .put({ ...record, state: "error", updatedAt: now, httpBaseUrl })
        .pipe(Effect.orDie);
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "start",
        detail:
          "T3 Code on this sandbox was reset, so it cannot reconnect as this environment. Delete it.",
      });
    }
    const updated: SandboxRecord = {
      ...record,
      state: "running",
      updatedAt: now,
      httpBaseUrl,
    };
    yield* records.put(updated).pipe(Effect.orDie);
    return { sandbox: updated, httpBaseUrl: updated.httpBaseUrl } satisfies SandboxResumeResult;
  });

  const extend = Effect.fn("SandboxProvisioner.extend")(function* (input: SandboxExtendInput) {
    const record = yield* readRecord(input.environmentId);
    const driver = findDriver(record.provider);
    const refuse = (detail: string) =>
      Effect.fail(new SandboxProviderError({ provider: record.provider, stage: "config", detail }));
    if (driver.extend === undefined) {
      return yield* refuse("This provider cannot extend a sandbox.");
    }
    if (record.state !== "running" && record.state !== "stopped") {
      return yield* refuse("Only a running or stopped sandbox can be extended.");
    }
    if (record.hardDeadlineAt === null) {
      return yield* refuse("This sandbox has no lifetime limit to extend.");
    }
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const deadlineMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(record.hardDeadlineAt));
    if (deadlineMillis <= nowMillis) {
      return yield* refuse(
        `This sandbox reached its ${Math.round((record.ttlMinutes / 60) * 10) / 10}-hour limit. Delete it and create a new one.`,
      );
    }
    const cap = (yield* settings.getSettings.pipe(Effect.orDie)).sandboxLifetimeCapMinutes;
    // `ttlMinutes` is the lifetime from creation to the deadline, so the cap bounds it directly.
    const granted = Math.min(input.minutes, cap - record.ttlMinutes);
    if (granted <= 0) {
      return yield* refuse(
        `This sandbox is at the ${Math.round((cap / 60) * 10) / 10}-hour lifetime limit set in Settings.`,
      );
    }
    const deadline = deadlineMillis + granted * 60_000;
    const config = yield* recordConfig(driver, record);
    const limits =
      driver.limits === undefined
        ? null
        : yield* onHttp(driver.limits({ config })).pipe(Effect.orElseSucceed(() => null));
    yield* onHttp(
      driver.extend({
        config,
        sandboxId: record.sandboxId,
        // A plan that caps auto-stop lower stops the machine early; T3's deadline still stands.
        ttlMinutes: Math.min(
          Math.ceil((deadline - nowMillis) / 60_000),
          limits?.maxTtlMinutes ?? Infinity,
        ),
        running: record.state === "running",
      }),
    );
    const updated: SandboxRecord = {
      ...record,
      ttlMinutes: record.ttlMinutes + granted,
      hardDeadlineAt: DateTime.formatIso(DateTime.makeUnsafe(deadline)),
      updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMillis)),
    };
    yield* records.put(updated).pipe(Effect.orDie);
    return { sandbox: updated } satisfies SandboxExtendResult;
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
    const record = yield* readRecord(input.environmentId);
    const driver = findDriver(record.provider);
    const { saveTemplate: save, stop: stopMachine } = driver;
    if (save === undefined || stopMachine === undefined) {
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "config",
        detail: "This provider cannot save templates.",
      });
    }
    // The reset runs on the machine. Resuming here would spend a start nobody confirmed.
    if (record.state !== "running") {
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "config",
        detail: "Only a running sandbox can be saved as a template. Resume it first.",
      });
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
    yield* records
      .put({ ...record, state: "stopped", updatedAt: yield* nowIso })
      .pipe(Effect.orDie);
    const template = yield* onHttp(
      save({ config, sandboxId: record.sandboxId, name: input.name }),
    ).pipe(Effect.mapError(afterReset));
    yield* onHttp(driver.destroy({ config, sandboxId: record.sandboxId })).pipe(
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.void,
      ),
      Effect.andThen(records.remove(record.environmentId).pipe(Effect.orDie)),
      // The scrub removed the token from the disk; the key on the hub goes with its sandbox.
      Effect.andThen(releaseHubKey(record)),
      // The template is saved either way; a sandbox that survives stays listed for a manual delete.
      Effect.catch((cause) =>
        Effect.logWarning("sandbox delete after saving a template failed", {
          environmentId: record.environmentId,
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
      return yield* new SandboxProviderError({
        provider: input.provider,
        stage: "config",
        detail: "This provider cannot delete templates.",
      });
    }
    const config = yield* resolveConfig(driver);
    yield* onHttp(driver.deleteTemplate({ config, name: input.name }));
  });

  // The sweep reads records, then waits on the provider; a user action in between wins.
  const putIfUnchanged = Effect.fn("SandboxProvisioner.putIfUnchanged")(function* (
    read: SandboxRecord,
    next: SandboxRecord,
  ) {
    const current = yield* records.get(read.environmentId);
    if (Option.isNone(current)) return;
    if (current.value.updatedAt !== read.updatedAt || current.value.state !== read.state) return;
    yield* records.put(next);
  }, Effect.orDie);

  const sweepRecord = Effect.fn("SandboxProvisioner.sweepRecord")(function* (
    record: SandboxRecord,
    config: SandboxProviderConfig,
    cost: SandboxUsage | undefined,
    now: DateTime.Utc,
  ) {
    const driver = findDriver(record.provider);
    const withCost: SandboxRecord =
      cost === undefined ? record : { ...record, costDollars: cost.dollars, costSince: cost.since };
    const pastDeadline =
      record.hardDeadlineAt !== null &&
      DateTime.toEpochMillis(DateTime.makeUnsafe(record.hardDeadlineAt)) <=
        DateTime.toEpochMillis(now);
    // A resume that could not start T3 leaves the machine running (and billing) as `error`.
    if (pastDeadline && (record.state === "running" || record.state === "error") && driver.stop) {
      return yield* onHttp(driver.stop({ config, sandboxId: record.sandboxId })).pipe(
        Effect.andThen(
          putIfUnchanged(record, {
            ...withCost,
            state: "stopped",
            updatedAt: DateTime.formatIso(now),
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("sandbox deadline stop failed", {
            environmentId: record.environmentId,
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
                environmentId: record.environmentId,
                sandboxId: record.sandboxId,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
    const state = reconcileState(record.state, status);
    if (state !== record.state) {
      yield* putIfUnchanged(record, { ...withCost, state, updatedAt: DateTime.formatIso(now) });
    } else if (
      withCost.costDollars !== record.costDollars ||
      withCost.costSince !== record.costSince
    ) {
      // Cost alone is not a lifecycle change, so it keeps `updatedAt` and the list order.
      yield* putIfUnchanged(record, withCost);
    }
  });

  const sweep = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const live = (yield* records.list.pipe(Effect.orDie)).filter(
      (record) => record.state !== "deleted",
    );
    const current = new Map<SandboxProviderKind, SandboxProviderConfig>();
    for (const provider of new Set(live.map((record) => record.provider))) {
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
    extend,
    templates,
    saveTemplate,
    deleteTemplate,
    sweep,
  });
});

export const layer = Layer.effect(SandboxProvisioner, make);

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
