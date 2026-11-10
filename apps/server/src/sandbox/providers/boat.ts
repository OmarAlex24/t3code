import {
  type SandboxProviderLimits,
  SandboxProviderError,
  type SandboxTemplate,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Schema from "effect/Schema";

import {
  AGENT_ENVIRONMENT_PREFIX,
  type AgentEnvironment,
  authorize,
  commandRequestSeconds,
  type CreatedSandbox,
  jsonBody,
  mayHaveCreated,
  requestJson,
  type SandboxAgentAccess,
  type SandboxKeepAlive,
  type SandboxProviderDriver,
  type SandboxProviderStatus,
  type SandboxUsage,
  shellQuote,
} from "../SandboxProvider.ts";

const BOAT_API_BASE = "https://boat.dev/api/v1";
const BOAT_BILLING_URL = "https://boat.dev/dashboard?tab=billing";
// Trial accounts must auto-stop within two hours (`400 trial_auto_stop_required`).
const TRIAL_MAX_TTL_MINUTES = 120;
const MAX_TTL_MINUTES = 43200;
// Tags every sandbox T3 creates, so one filtered list call can read all their costs.
const ROLE_LABEL = { key: "t3.code/role", value: "environment" } as const;
// Which T3 server and record a sandbox belongs to, so the sweep can find ones no record tracks.
const HOST_LABEL = "t3.code/host";
const INSTANCE_LABEL = "t3.code/instance";

const BoatSandbox = Schema.Struct({
  sandbox: Schema.Struct({
    id: Schema.String,
    name: Schema.optionalKey(Schema.String),
  }),
  hostedPorts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        port: Schema.Number,
        url: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

const BoatCommand = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.String,
  stderr: Schema.String,
});

const BoatHostedPort = Schema.Struct({ url: Schema.String });

const BoatLifecycle = Schema.Struct({
  sandbox: Schema.Struct({
    id: Schema.String,
    state: Schema.String,
    error: Schema.optionalKey(Schema.NullOr(Schema.String)),
    dataExpiredAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
    /** When the auto-stop fires; null while it is off. */
    archiveAfter: Schema.optionalKey(Schema.NullOr(Schema.String)),
    ttlSeconds: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  }),
});

// Boat drops a stopped sandbox's disk 14 days after the stop; resume then fails.
const lifecycleStatus = (
  sandbox: typeof BoatLifecycle.Type.sandbox,
): SandboxProviderStatus | null =>
  sandbox.state === "archived" && sandbox.dataExpiredAt
    ? "expired"
    : (BOAT_STATUS[sandbox.state] ?? null);

const BoatSandboxList = Schema.Struct({
  sandboxes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optionalKey(Schema.NullOr(Schema.String)),
      state: Schema.optionalKey(Schema.String),
      createdAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
      labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
      /** The environment's name. */
      environment: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

const BoatCostList = Schema.Struct({
  sandboxes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      cost: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ since: Schema.String, dollars: Schema.Number })),
      ),
    }),
  ),
});

const BOAT_STATUS: Record<string, SandboxProviderStatus> = {
  ready: "running",
  idle: "running",
  running: "running",
  init: "starting",
  provisioning: "starting",
  provisioned: "starting",
  cloning: "starting",
  archiving: "starting",
  archived: "stopped",
  error: "error",
  cancelled: "deleted",
};

const BoatSavedSnapshot = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  type: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sizeBytes: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  createdAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const BoatSavedSnapshots = Schema.Struct({
  snapshots: Schema.Array(BoatSavedSnapshot),
  allowance: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        included: Schema.Number,
        used: Schema.Number,
        extra: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        pricePerExtraDailyDollars: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
});

const toTemplate = (snapshot: typeof BoatSavedSnapshot.Type): SandboxTemplate => ({
  name: snapshot.name,
  ...(snapshot.createdAt ? { createdAt: snapshot.createdAt } : {}),
  ...(typeof snapshot.sizeBytes === "number" ? { sizeBytes: snapshot.sizeBytes } : {}),
  ...(snapshot.type ? { size: snapshot.type } : {}),
});

const savedSnapshotUrl = (name: string) =>
  `${BOAT_API_BASE}/saved-snapshots/${encodeURIComponent(name)}`;

const getLifecycle = (apiKey: string, sandboxId: string) =>
  requestJson({
    provider: "boat",
    stage: "start",
    schema: BoatLifecycle,
    request: authorize(
      HttpClientRequest.get(`${BOAT_API_BASE}/sandboxes/${encodeURIComponent(sandboxId)}`),
      apiKey,
    ),
  });

const waitUntilRunning = Effect.fn("Boat.waitUntilRunning")(function* (
  apiKey: string,
  sandboxId: string,
  stage: "start" | "expose",
) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const { sandbox } = yield* getLifecycle(apiKey, sandboxId);
    if (sandbox.state === "ready" || sandbox.state === "idle" || sandbox.state === "running") {
      return;
    }
    if (sandbox.state === "error" || sandbox.state === "archived") {
      return yield* new SandboxProviderError({
        provider: "boat",
        stage,
        detail: sandbox.error?.trim() || `The sandbox stayed ${sandbox.state}.`,
      });
    }
    if (attempt < 89) yield* Effect.sleep("2 seconds");
  }
  return yield* new SandboxProviderError({
    provider: "boat",
    stage,
    detail: "Timed out waiting for the sandbox to start.",
  });
});

const STOP_POLL_ATTEMPTS = 90;
// A save of a stopped sandbox pins its last snapshot; Boat says a live capture can take minutes.
const SAVE_POLL_ATTEMPTS = 120;

const BoatStartWindow = Schema.NullOr(
  Schema.Struct({ limit: Schema.Number, used: Schema.Number, remaining: Schema.Number }),
);

// `/limits` returns dozens of plan, wallet, and upgrade fields; only these feed the preflight.
const BoatLimits = Schema.Struct({
  canStart: Schema.Boolean,
  startBlockedReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  blockedReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  checkoutRequired: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  accessTier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sandboxPlanKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sandboxPlanDollars: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  activeSandboxes: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  maxActiveSandboxes: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  nextStartDollars: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  starts: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        minute: Schema.optionalKey(BoatStartWindow),
        hour: Schema.optionalKey(BoatStartWindow),
        day: Schema.optionalKey(BoatStartWindow),
      }),
    ),
  ),
  startWindowFull: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        window: Schema.optionalKey(Schema.NullOr(Schema.String)),
        freesAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  machineTypes: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          type: Schema.String,
          available: Schema.Boolean,
          reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});

const boundedText = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed.slice(0, 300);
};

const toLimits = (raw: typeof BoatLimits.Type): SandboxProviderLimits => {
  const isTrial = raw.accessTier === "trial" || raw.sandboxPlanKey === "trial";
  const blockedReason = boundedText(raw.startBlockedReason) ?? boundedText(raw.blockedReason);
  const starts = (["minute", "hour", "day"] as const).flatMap((window) => {
    const entry = raw.starts?.[window];
    if (entry === undefined || entry === null) return [];
    const freesAt = raw.startWindowFull?.window === window ? raw.startWindowFull.freesAt : null;
    return [
      {
        window,
        limit: entry.limit,
        used: entry.used,
        remaining: entry.remaining,
        ...(freesAt ? { resetsAt: freesAt } : {}),
      },
    ];
  });
  const plan = isTrial
    ? "Trial"
    : typeof raw.sandboxPlanDollars === "number" && raw.sandboxPlanDollars > 0
      ? `$${raw.sandboxPlanDollars} plan`
      : boundedText(raw.accessTier);
  return {
    canStart: raw.canStart,
    ...(blockedReason === undefined ? {} : { blockedReason }),
    ...(starts.length === 0 ? {} : { starts }),
    ...(typeof raw.activeSandboxes === "number" && typeof raw.maxActiveSandboxes === "number"
      ? { concurrency: { active: raw.activeSandboxes, max: raw.maxActiveSandboxes } }
      : {}),
    // Boat's own encoding: 0 is inside the plan, more is a paid burst, null is a refusal.
    ...(raw.nextStartDollars === undefined
      ? {}
      : raw.nextStartDollars === null
        ? { startCost: "refused" as const }
        : raw.nextStartDollars > 0
          ? { startCost: "paid" as const, startDollars: raw.nextStartDollars }
          : { startCost: "included" as const }),
    maxTtlMinutes: isTrial ? TRIAL_MAX_TTL_MINUTES : MAX_TTL_MINUTES,
    // Trials get `403 trial_saved_snapshots_not_allowed`.
    canSaveTemplates: !isTrial,
    ...(raw.machineTypes === undefined || raw.machineTypes === null
      ? {}
      : {
          sizes: raw.machineTypes.map((machine) => {
            const reason = boundedText(machine.reason);
            return {
              id: machine.type,
              available: machine.available,
              ...(reason === undefined ? {} : { reason }),
            };
          }),
        }),
    ...(plan === undefined ? {} : { plan }),
    ...(raw.checkoutRequired === true || !raw.canStart ? { billingUrl: BOAT_BILLING_URL } : {}),
  };
};

// Only flags, never `envContents` or `secretFiles`: those hold real credential values and must
// not leave the server that owns the provider key.
const BoatEnvironment = Schema.Struct({
  name: Schema.String,
  isDefault: Schema.Boolean,
  safeForThirdParties: Schema.Boolean,
  passGithub: Schema.Boolean,
  passSecrets: Schema.Boolean,
  passSandboxCredentials: Schema.Boolean,
  passAgentsCredentials: Schema.Boolean,
  proxyAiCredentials: Schema.Boolean,
});

const BoatEnvironments = Schema.Struct({
  environments: Schema.Array(BoatEnvironment),
});

const BoatAgentEnvironments = Schema.Struct({
  environments: Schema.Array(Schema.Struct({ ...BoatEnvironment.fields, id: Schema.String })),
});

const BoatScopedKey = Schema.Struct({
  secret: Schema.String,
  apiKey: Schema.Struct({
    id: Schema.String,
    // `"*"` when a key reaches every sandbox, which a sandbox's own key must never do. A key
    // scoped to sandboxes alone may come back without `environments`.
    scope: Schema.Struct({
      sandboxes: Schema.Unknown,
      environments: Schema.optionalKey(Schema.Unknown),
    }),
  }),
});

// What the agent's key may do. Forking makes a sandbox, so it needs `sandbox.create` in the
// sandbox's own environment; `sandbox.delete-own` reaches only the forks the key made.
const AGENT_KEY_ACTIONS = [
  "sandbox.create",
  "sandbox.read",
  "sandbox.stop",
  "sandbox.fork",
  "sandbox.delete-own",
  "exec",
  "file.read",
  "file.write",
  "host",
] as const;

// No account has this sandbox, so an admin key gets `api_key_sandbox_forbidden` and makes nothing.
const SCOPED_KEY_PROBE_SANDBOX = "bx_t3probe0";

const info = {
  kind: "boat",
  label: "Boat",
  detail: "Full Ubuntu VMs with a public HTTPS URL per port.",
  apiKeyLabel: "Boat API key",
  apiKeyPlaceholder: "boat_...",
  docsUrl: "https://docs.boat.dev/api-keys",
  sizes: [
    { id: "small", label: "Small", detail: "2 vCPU · 4 GB · 51 GB" },
    { id: "default", label: "Default", detail: "4 vCPU · 8 GB · 51 GB" },
    { id: "large", label: "Large", detail: "8 vCPU · 16 GB · 111 GB" },
    { id: "xlarge", label: "Extra large", detail: "16 vCPU · 32 GB · 251 GB" },
  ],
  // https://docs.boat.dev/api/v1.md: an archived sandbox's data expires 14 days after the stop.
  diskRetentionDays: 14,
} satisfies SandboxProviderDriver["info"];

const sandboxUrl = (sandboxId: string, path: string) =>
  `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(sandboxId)}/${path}`;

const runCommand = (apiKey: string, sandboxId: string, command: string, timeoutSeconds: number) => {
  const seconds = Math.min(Math.max(timeoutSeconds, 1), 600);
  return requestJson({
    provider: "boat",
    stage: "install",
    schema: BoatCommand,
    request: jsonBody(
      authorize(HttpClientRequest.post(sandboxUrl(sandboxId, "commands")), apiKey),
      // An `exit` in Boat's login shell runs ~/.bash_logout (clear_console), which fails it.
      { command: `sh -c ${shellQuote(command)}`, timeoutSeconds: seconds },
    ),
    timeoutSeconds: commandRequestSeconds(seconds),
  }).pipe(
    Effect.filterOrFail(
      (result) => result.exitCode === 0,
      (result) =>
        new SandboxProviderError({
          provider: "boat",
          stage: "install",
          // Only the exit status is an attribute. The raw output can contain secrets, so it is
          // kept in the cause for diagnostics and never shown to the client or logged.
          detail: `The command exited with ${result.exitCode ?? "an unknown status"}.`,
          cause: new Error(
            [result.stderr, result.stdout]
              .map((part) => part.trim())
              .filter((part) => part !== "")
              .join("\n")
              .slice(-4000),
          ),
        }),
    ),
    Effect.map((result) => ({ ...result, exitCode: result.exitCode ?? 0 })),
  );
};

// The files API carries content in a request body, which Boat does not keep with its command history.
const writeFile = (apiKey: string, sandboxId: string, path: string, content: string) =>
  requestJson({
    provider: "boat",
    stage: "install",
    schema: Schema.Unknown,
    request: jsonBody(authorize(HttpClientRequest.put(sandboxUrl(sandboxId, "files")), apiKey), {
      path,
      content,
    }),
  }).pipe(Effect.asVoid);

const bodyCode = (body: unknown) =>
  typeof body === "object" && body !== null && "code" in body && typeof body.code === "string"
    ? body.code
    : undefined;

const scopedKeyId = (body: unknown) => {
  if (typeof body !== "object" || body === null || !("apiKey" in body)) return undefined;
  const { apiKey } = body;
  return typeof apiKey === "object" && apiKey !== null && "id" in apiKey
    ? typeof apiKey.id === "string"
      ? apiKey.id
      : undefined
    : undefined;
};

const revokeScopedKey = (apiKey: string, keyId: string) =>
  requestJson({
    provider: "boat",
    stage: "delete",
    schema: Schema.Unknown,
    request: authorize(
      HttpClientRequest.delete(`${BOAT_API_BASE}/api-keys/${encodeURIComponent(keyId)}`),
      apiKey,
    ),
  }).pipe(
    Effect.asVoid,
    Effect.catchIf(
      (error) => error.code === "not_found",
      () => Effect.void,
    ),
  );

const deleteEnvironment = (apiKey: string, environmentId: string) =>
  requestJson({
    provider: "boat",
    stage: "delete",
    schema: Schema.Unknown,
    request: authorize(
      HttpClientRequest.delete(
        `${BOAT_API_BASE}/environments/${encodeURIComponent(environmentId)}`,
      ),
      apiKey,
    ),
  }).pipe(
    Effect.asVoid,
    Effect.catchIf(
      (error) => error.code === "not_found",
      () => Effect.void,
    ),
  );

const listAgentEnvironments = (apiKey: string) =>
  requestJson({
    provider: "boat",
    stage: "create",
    schema: BoatAgentEnvironments,
    request: authorize(HttpClientRequest.get(`${BOAT_API_BASE}/environments`), apiKey),
  });

const agentAccess: SandboxAgentAccess = {
  check: Effect.fn("Boat.checkAgentAccess")(function* (input) {
    const client = yield* HttpClient.HttpClient;
    const failed = (detail: string, code?: "scoped_keys_unavailable") =>
      new SandboxProviderError({
        provider: "boat",
        stage: "config",
        detail,
        ...(code === undefined ? {} : { code }),
      });
    const response = yield* client
      .execute(
        jsonBody(
          authorize(
            HttpClientRequest.post(`${BOAT_API_BASE}/api-keys/scoped`),
            input.config.apiKey,
          ),
          {
            name: "t3-sandbox-check",
            ttl: "60s",
            actions: ["sandbox.read"],
            sandboxIds: [SCOPED_KEY_PROBE_SANDBOX],
          },
        ),
      )
      .pipe(
        Effect.mapError(() => failed("Boat could not be reached to check its key.")),
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.fail(failed("Boat did not answer when T3 Code checked its key.")),
        }),
      );
    const body: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => null));
    // Only a key that may mint scoped keys gets as far as checking the sandbox it names.
    if (response.status === 403 && bodyCode(body) === "api_key_sandbox_forbidden") return;
    if (response.status >= 200 && response.status < 300) {
      const keyId = scopedKeyId(body);
      if (keyId !== undefined)
        yield* revokeScopedKey(input.config.apiKey, keyId).pipe(Effect.ignore);
      return;
    }
    if (response.status === 401 || response.status === 403) {
      return yield* failed(
        "Your Boat key can't create scoped keys; use an admin key or turn off Let the agent use Boat.",
        "scoped_keys_unavailable",
      );
    }
    return yield* failed(`Boat answered HTTP ${response.status} when T3 Code checked its key.`);
  }),
  createEnvironment: Effect.fn("Boat.createAgentEnvironment")(function* (input) {
    const { apiKey } = input.config;
    // The answer lists every environment; the name, unique per sandbox, finds the new one.
    const created = yield* requestJson({
      provider: "boat",
      stage: "create",
      schema: BoatAgentEnvironments,
      request: jsonBody(
        authorize(HttpClientRequest.post(`${BOAT_API_BASE}/environments`), apiKey),
        {
          name: input.name,
        },
      ),
    });
    const found = created.environments.find((environment) => environment.name === input.name);
    if (found === undefined) {
      return yield* new SandboxProviderError({
        provider: "boat",
        stage: "create",
        detail: "Boat did not return the environment T3 Code made for this sandbox.",
      });
    }
    // A new environment passes the account's GitHub token, secrets and agent logins. It is
    // locked down and read back before any sandbox starts in it.
    const locked = Effect.gen(function* () {
      yield* requestJson({
        provider: "boat",
        stage: "create",
        schema: Schema.Unknown,
        request: jsonBody(
          authorize(
            HttpClientRequest.put(`${BOAT_API_BASE}/environments/${encodeURIComponent(found.id)}`),
            apiKey,
          ),
          {
            safeForThirdParties: true,
            passGithub: false,
            passSecrets: false,
            passSandboxCredentials: false,
            passAgentsCredentials: false,
          },
        ),
      });
      const current = (yield* listAgentEnvironments(apiKey)).environments.find(
        (environment) => environment.id === found.id,
      );
      const closed =
        current !== undefined &&
        current.safeForThirdParties &&
        !current.passGithub &&
        !current.passSecrets &&
        !current.passSandboxCredentials &&
        !current.passAgentsCredentials &&
        !current.proxyAiCredentials;
      if (!closed) {
        return yield* new SandboxProviderError({
          provider: "boat",
          stage: "create",
          detail:
            "Boat kept passing credentials to the environment made for this sandbox, so T3 Code deleted it.",
        });
      }
    });
    yield* locked.pipe(
      Effect.tapError(() => deleteEnvironment(apiKey, found.id).pipe(Effect.ignore)),
    );
    return { id: found.id, name: found.name } satisfies AgentEnvironment;
  }),
  deleteEnvironment: (input) => deleteEnvironment(input.config.apiKey, input.environmentId),
  mintKey: Effect.fn("Boat.mintAgentKey")(function* (input) {
    const { apiKey } = input.config;
    // An empty list would scope the key to every sandbox on the account.
    if (input.sandboxId.trim() === "" || input.environmentId.trim() === "") {
      return yield* new SandboxProviderError({
        provider: "boat",
        stage: "install",
        detail: "T3 Code has no sandbox to scope the agent's key to.",
      });
    }
    const minted = yield* requestJson({
      provider: "boat",
      stage: "install",
      schema: BoatScopedKey,
      request: jsonBody(
        authorize(HttpClientRequest.post(`${BOAT_API_BASE}/api-keys/scoped`), apiKey),
        {
          name: input.name,
          ttl: `${input.ttlMinutes}m`,
          actions: AGENT_KEY_ACTIONS,
          sandboxIds: [input.sandboxId],
          environmentIds: [input.environmentId],
        },
      ),
    });
    const { sandboxes, environments } = minted.apiKey.scope;
    const scoped =
      Array.isArray(sandboxes) &&
      sandboxes.length === 1 &&
      sandboxes[0] === input.sandboxId &&
      Array.isArray(environments) &&
      environments.length === 1 &&
      environments[0] === input.environmentId;
    if (!scoped) {
      yield* revokeScopedKey(apiKey, minted.apiKey.id).pipe(Effect.ignore);
      return yield* new SandboxProviderError({
        provider: "boat",
        stage: "install",
        detail: "Boat made the agent's key wider than this sandbox, so T3 Code revoked it.",
      });
    }
    return { id: minted.apiKey.id, secret: Redacted.make(minted.secret) };
  }),
  revokeKey: (input) => revokeScopedKey(input.config.apiKey, input.keyId),
  listSandboxes: Effect.fn("Boat.listAgentSandboxes")(function* (input) {
    const listed = yield* requestJson({
      provider: "boat",
      stage: "config",
      schema: BoatSandboxList,
      request: authorize(
        HttpClientRequest.get(`${BOAT_API_BASE}/sandboxes`).pipe(
          HttpClientRequest.setUrlParams({ environment: input.environmentName, limit: "200" }),
        ),
        input.config.apiKey,
      ),
    });
    const live = listed.sandboxes.filter((sandbox) => sandbox.state !== "cancelled");
    // Without each sandbox's environment, a fork could be missed and its environment deleted.
    if (live.some((sandbox) => typeof sandbox.environment !== "string")) {
      return yield* new SandboxProviderError({
        provider: "boat",
        stage: "config",
        detail: "Boat did not say which environment its sandboxes are in.",
      });
    }
    return live
      .filter((sandbox) => sandbox.environment === input.environmentName)
      .map((sandbox) => ({
        id: sandbox.id,
        name: sandbox.name ?? sandbox.id,
        createdAt: sandbox.createdAt ?? undefined,
      }));
  }),
  // `boat login` keeps the key in its own config, readable by the sandbox's user only.
  loginScript: (secret) => ({
    secrets: { T3_BOAT_KEY: secret },
    command: `set -eu
umask 077
export PATH="$HOME/.ascii/bin:$HOME/.local/bin:$PATH"
if ! command -v boat >/dev/null 2>&1; then
  echo "The boat CLI is not installed." >&2
  exit 3
fi
printf '%s' "$T3_BOAT_KEY" | boat login --key-stdin --json >/dev/null
boat info self --json >/dev/null`,
  }),
};

// What the sandbox's own keep-alive key may do: read itself and move its auto-stop, nothing else.
const KEEP_ALIVE_KEY_ACTIONS = ["sandbox.read", "sandbox.update"] as const;

const sandboxPath = (sandboxId: string) =>
  `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(sandboxId)}`;

const keepAlive: SandboxKeepAlive = {
  mintKey: Effect.fn("Boat.mintKeepAliveKey")(function* (input) {
    const { apiKey } = input.config;
    // An empty list would scope the key to every sandbox on the account.
    if (input.sandboxId.trim() === "") {
      return yield* new SandboxProviderError({
        provider: "boat",
        stage: "install",
        detail: "T3 Code has no sandbox to scope the keep-alive key to.",
      });
    }
    const minted = yield* requestJson({
      provider: "boat",
      stage: "install",
      schema: BoatScopedKey,
      request: jsonBody(
        authorize(HttpClientRequest.post(`${BOAT_API_BASE}/api-keys/scoped`), apiKey),
        {
          name: input.name,
          ttl: `${input.ttlMinutes}m`,
          actions: KEEP_ALIVE_KEY_ACTIONS,
          sandboxIds: [input.sandboxId],
        },
      ),
    });
    const { sandboxes, environments } = minted.apiKey.scope;
    const scoped =
      Array.isArray(sandboxes) &&
      sandboxes.length === 1 &&
      sandboxes[0] === input.sandboxId &&
      (environments === null ||
        environments === undefined ||
        (Array.isArray(environments) && environments.length === 0));
    if (!scoped) {
      yield* revokeScopedKey(apiKey, minted.apiKey.id).pipe(Effect.ignore);
      return yield* new SandboxProviderError({
        provider: "boat",
        stage: "install",
        detail: "Boat made the keep-alive key wider than this sandbox, so T3 Code revoked it.",
      });
    }
    return { id: minted.apiKey.id, secret: Redacted.make(minted.secret) };
  }),
  revokeKey: (input) => revokeScopedKey(input.config.apiKey, input.keyId),
  // https://docs.boat.dev/api/v1.md: `ttlSeconds` sets the auto-stop to that long from now.
  extend: (input) =>
    requestJson({
      provider: "boat",
      stage: "start",
      schema: Schema.Unknown,
      request: jsonBody(
        authorize(HttpClientRequest.patch(sandboxPath(input.sandboxId)), input.config.apiKey),
        { ttlSeconds: input.ttlMinutes * 60 },
      ),
    }).pipe(Effect.asVoid),
  extendRequest: (sandboxId) => ({ method: "PATCH", url: sandboxPath(sandboxId) }),
  status: (input) =>
    getLifecycle(input.config.apiKey, input.sandboxId).pipe(
      Effect.map(({ sandbox }) => ({
        status: lifecycleStatus(sandbox),
        ...(sandbox.archiveAfter === undefined ? {} : { autoStopAt: sandbox.archiveAfter }),
      })),
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.succeed({ status: "deleted" as const }),
      ),
    ),
};

export const boatDriver: SandboxProviderDriver = {
  info,
  defaultSize: "default",
  serverPort: 3773,
  create: Effect.fn("Boat.create")(function* (input) {
    const send = requestJson({
      provider: "boat",
      stage: "create",
      schema: BoatSandbox,
      request: jsonBody(
        HttpClientRequest.setHeaders(
          authorize(HttpClientRequest.post(`${BOAT_API_BASE}/sandboxes`), input.config.apiKey),
          { "Idempotency-Key": input.idempotencyKey },
        ),
        {
          name: input.name,
          // A saved snapshot keeps the size it was saved from; omitting `type` inherits it.
          ...(input.template === undefined ? { type: input.size } : { from: input.template }),
          // A sandbox created by T3 must never inherit the account's GitHub token,
          // secrets, or agent logins by default. Credentials are opt-in per environment.
          ...(input.environment === undefined
            ? { noEnv: true }
            : { environment: input.environment }),
          // The provisioner picks the auto-stop: T3's running limit, which setup and a sandbox
          // without keep-alive need, or the idle window once the sandbox keeps itself up.
          ttlSeconds: (input.ttlMinutes ?? 480) * 60,
          labels: {
            [ROLE_LABEL.key]: ROLE_LABEL.value,
            ...(input.tags === undefined
              ? {}
              : { [HOST_LABEL]: input.tags.host, [INSTANCE_LABEL]: input.tags.instance }),
          },
          // `localhost` keeps the port reachable whether t3 binds 0.0.0.0 or the
          // background service's loopback default. A tailnet-only sandbox hosts no port.
          ...(input.publishPort === false
            ? {}
            : { hostedPorts: [{ port: 3773, public: true, localhost: true, title: "T3 Code" }] }),
        },
      ),
    });
    // The same key and body return the sandbox a create whose answer was lost made.
    const created = yield* send.pipe(Effect.catchIf(mayHaveCreated, () => send));
    // A sandbox started from a saved snapshot does not relay the hosted port to loopback until
    // the port is hosted again, so the provisioner exposes it once the machine runs.
    const url =
      input.template === undefined && input.publishPort !== false
        ? created.hostedPorts?.find((port) => port.port === 3773)?.url
        : undefined;
    return {
      id: created.sandbox.id,
      name: created.sandbox.name ?? input.name,
      ...(url === undefined ? {} : { publicUrl: url }),
    } satisfies CreatedSandbox;
  }),
  agentAccess,
  keepAlive,
  limits: (input) =>
    requestJson({
      provider: "boat",
      stage: "config",
      schema: BoatLimits,
      request: authorize(HttpClientRequest.get(`${BOAT_API_BASE}/limits`), input.config.apiKey),
    }).pipe(Effect.map(toLimits)),
  listEnvironments: Effect.fn("Boat.listEnvironments")(function* (input) {
    const listed = yield* requestJson({
      provider: "boat",
      stage: "config",
      schema: BoatEnvironments,
      request: authorize(
        HttpClientRequest.get(`${BOAT_API_BASE}/environments`),
        input.config.apiKey,
      ),
    });
    // The ones T3 makes for a sandbox's agent pass no credentials and belong to that sandbox.
    return listed.environments.filter(
      (environment) => !environment.name.startsWith(AGENT_ENVIRONMENT_PREFIX),
    );
  }),
  execute: Effect.fn("Boat.execute")(function* (input) {
    const { apiKey } = input.config;
    if (input.secrets === undefined) {
      return yield* runCommand(apiKey, input.sandboxId, input.command, input.timeoutSeconds);
    }
    // Boat has no per-command env, and keeps every command's text, so secrets go in a private file.
    // `mkdir` without -p fails on a name someone else took, and the name needs no quoting.
    const dir = `/tmp/t3-secrets-${(yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER)).toString(36)}`;
    const file = `${dir}/env`;
    yield* runCommand(apiKey, input.sandboxId, `umask 077\nmkdir ${dir}\n: >${file}`, 30);
    return yield* writeFile(
      apiKey,
      input.sandboxId,
      file,
      Object.entries(input.secrets)
        .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
        .join(""),
    ).pipe(
      Effect.andThen(
        runCommand(
          apiKey,
          input.sandboxId,
          `. ${file}\nrm -rf ${dir}\n${input.command}`,
          input.timeoutSeconds,
        ),
      ),
      Effect.onError(() =>
        requestJson({
          provider: "boat",
          stage: "install",
          schema: Schema.Unknown,
          request: authorize(
            HttpClientRequest.delete(sandboxUrl(input.sandboxId, "files")).pipe(
              HttpClientRequest.setUrlParams({ path: dir, recursive: "true" }),
            ),
            apiKey,
          ),
        }).pipe(Effect.ignore),
      ),
    );
  }),
  uploadFile: (input) => writeFile(input.config.apiKey, input.sandboxId, input.path, input.content),
  // Boat refuses to host a port on a machine that is not running.
  exposePort: (input) =>
    waitUntilRunning(input.config.apiKey, input.sandboxId, "expose").pipe(
      Effect.andThen(
        requestJson({
          provider: "boat",
          stage: "expose",
          schema: BoatHostedPort,
          request: jsonBody(
            authorize(
              HttpClientRequest.post(
                `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}/host`,
              ),
              input.config.apiKey,
            ),
            { port: input.port, public: true, localhost: true, title: "T3 Code" },
          ),
        }),
      ),
      Effect.map((result) => result.url),
    ),
  stop: (input) =>
    requestJson({
      provider: "boat",
      stage: "delete",
      schema: Schema.Struct({ ok: Schema.optionalKey(Schema.Boolean) }),
      request: authorize(
        HttpClientRequest.post(
          `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}/stop`,
        ),
        input.config.apiKey,
      ),
    }).pipe(Effect.asVoid),
  resume: Effect.fn("Boat.resume")(function* (input) {
    yield* requestJson({
      provider: "boat",
      stage: "start",
      schema: Schema.Struct({ ok: Schema.optionalKey(Schema.Boolean) }),
      request: jsonBody(
        authorize(
          HttpClientRequest.post(
            `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}/resume`,
          ),
          input.config.apiKey,
        ),
        input.ttlMinutes === undefined ? {} : { ttlSeconds: input.ttlMinutes * 60 },
      ),
    });
    yield* waitUntilRunning(input.config.apiKey, input.sandboxId, "start");
    return {};
  }),
  status: (input) =>
    getLifecycle(input.config.apiKey, input.sandboxId).pipe(
      Effect.map(({ sandbox }) => lifecycleStatus(sandbox)),
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.succeed("deleted" as const),
      ),
    ),
  saveTemplate: Effect.fn("Boat.saveTemplate")(function* (input) {
    // Saving a stopped sandbox pins its last snapshot, so the stop must have finished first, or the
    // save could capture the disk from before T3's state was removed.
    for (let attempt = 0; ; attempt++) {
      const { sandbox } = yield* getLifecycle(input.config.apiKey, input.sandboxId);
      if (sandbox.state === "archived") break;
      if (sandbox.state === "error" || attempt >= STOP_POLL_ATTEMPTS - 1) {
        return yield* new SandboxProviderError({
          provider: "boat",
          stage: "template",
          detail: "The sandbox did not finish stopping, so the template was not saved.",
        });
      }
      yield* Effect.sleep("2 seconds");
    }
    yield* requestJson({
      provider: "boat",
      stage: "template",
      schema: Schema.Struct({ status: Schema.optionalKey(Schema.String) }),
      request: jsonBody(
        authorize(HttpClientRequest.post(`${BOAT_API_BASE}/saved-snapshots`), input.config.apiKey),
        { sandboxId: input.sandboxId, name: input.name },
      ),
    });
    for (let attempt = 0; attempt < SAVE_POLL_ATTEMPTS; attempt++) {
      yield* Effect.sleep("5 seconds");
      const { snapshot } = yield* requestJson({
        provider: "boat",
        stage: "template",
        schema: Schema.Struct({ snapshot: BoatSavedSnapshot }),
        request: authorize(
          HttpClientRequest.get(savedSnapshotUrl(input.name)),
          input.config.apiKey,
        ),
      });
      if (snapshot.status === "ready") return toTemplate(snapshot);
      if (snapshot.status === "failed") {
        return yield* new SandboxProviderError({
          provider: "boat",
          stage: "template",
          detail: "Boat could not save the template.",
          ...(snapshot.error ? { cause: new Error(snapshot.error.slice(0, 2000)) } : {}),
        });
      }
    }
    return yield* new SandboxProviderError({
      provider: "boat",
      stage: "template",
      detail: "Timed out waiting for Boat to save the template. It may still appear in a while.",
    });
  }),
  listTemplates: (input) =>
    requestJson({
      provider: "boat",
      stage: "template",
      schema: BoatSavedSnapshots,
      request: authorize(
        HttpClientRequest.get(`${BOAT_API_BASE}/saved-snapshots`),
        input.config.apiKey,
      ),
    }).pipe(
      Effect.map(({ snapshots, allowance }) => ({
        // Only a ready snapshot can start a sandbox.
        templates: snapshots.filter((snapshot) => snapshot.status === "ready").map(toTemplate),
        ...(allowance === undefined || allowance === null
          ? {}
          : {
              templateAllowance: {
                included: allowance.included,
                used: allowance.used,
                ...(typeof allowance.extra === "number" ? { extra: allowance.extra } : {}),
                ...(typeof allowance.pricePerExtraDailyDollars === "number"
                  ? { pricePerExtraDailyDollars: allowance.pricePerExtraDailyDollars }
                  : {}),
              },
            }),
      })),
    ),
  deleteTemplate: (input) =>
    requestJson({
      provider: "boat",
      stage: "template",
      schema: Schema.Struct({ ok: Schema.optionalKey(Schema.Boolean) }),
      request: authorize(
        HttpClientRequest.delete(savedSnapshotUrl(input.name)),
        input.config.apiKey,
      ),
    }).pipe(Effect.asVoid),
  listSandboxes: (input) =>
    requestJson({
      provider: "boat",
      stage: "config",
      schema: BoatSandboxList,
      request: authorize(
        HttpClientRequest.get(`${BOAT_API_BASE}/sandboxes`).pipe(
          HttpClientRequest.setUrlParams({ label: `${HOST_LABEL}=${input.host}`, limit: "200" }),
        ),
        input.config.apiKey,
      ),
    }).pipe(
      Effect.map((listed) =>
        listed.sandboxes
          .filter((sandbox) => sandbox.state !== "cancelled")
          .map((sandbox) => ({
            id: sandbox.id,
            name: sandbox.name ?? sandbox.id,
            instance: sandbox.labels?.[INSTANCE_LABEL],
            createdAt: sandbox.createdAt ?? undefined,
          })),
      ),
    ),
  usage: (input) =>
    requestJson({
      provider: "boat",
      stage: "config",
      schema: BoatCostList,
      request: authorize(
        HttpClientRequest.get(`${BOAT_API_BASE}/sandboxes`).pipe(
          HttpClientRequest.setUrlParams({
            include: "cost",
            label: `${ROLE_LABEL.key}=${ROLE_LABEL.value}`,
            limit: "200",
          }),
        ),
        input.config.apiKey,
      ),
    }).pipe(
      Effect.map(
        (listed) =>
          new Map(
            listed.sandboxes.flatMap((sandbox): Array<[string, SandboxUsage]> =>
              sandbox.cost === undefined || sandbox.cost === null
                ? []
                : [[sandbox.id, { dollars: sandbox.cost.dollars, since: sandbox.cost.since }]],
            ),
          ),
      ),
    ),
  destroy: (input) => {
    const request = HttpClientRequest.delete(
      `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}`,
    );
    return requestJson({
      provider: "boat",
      stage: "delete",
      schema: Schema.Struct({ ok: Schema.optionalKey(Schema.Boolean) }),
      request: HttpClientRequest.setHeaders(authorize(request, input.config.apiKey), {
        "X-Ascii-Confirm-Delete": input.sandboxId,
      }),
    }).pipe(Effect.asVoid);
  },
};
