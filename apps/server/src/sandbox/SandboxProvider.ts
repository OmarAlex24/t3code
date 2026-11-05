import {
  describeSandboxRetry,
  type SandboxCredentialEnvironment,
  type SandboxProviderErrorCode,
  type SandboxProviderInfo,
  type SandboxProviderLimits,
  SandboxProviderError,
  type SandboxProviderKind,
  type SandboxStage,
  type SandboxTemplate,
  type SandboxTemplateAllowance,
} from "@t3tools/contracts";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import { makeHttp1Dispatcher } from "../outboundHttp.ts";

export interface SandboxProviderConfig {
  readonly apiKey: string;
  /** Saved values of the driver's `info.settingsFields`, keyed by id; unset fields are absent. */
  readonly settings: Readonly<Record<string, string>>;
}

export interface CreatedSandbox {
  readonly id: string;
  readonly name: string;
  /** A public URL for `port`, when the provider can route it at creation time. */
  readonly publicUrl?: string;
  /** Settings the driver resolved (a detected team), kept so later calls reach this sandbox. */
  readonly settings?: Readonly<Record<string, string>>;
}

export interface SandboxExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The provider's view of one machine, normalized; `starting` is transitional and never recorded. */
export type SandboxProviderStatus =
  | "running"
  | "starting"
  | "stopped"
  | "error"
  | "expired"
  | "deleted";

export interface SandboxUsage {
  readonly dollars: number;
  readonly since: string;
}

/** Tags every create carries, so a sandbox can be traced to the server and record that made it. */
export interface SandboxTags {
  readonly host: string;
  readonly instance: string;
}

/** A sandbox the provider lists as tagged by this server. */
export interface ListedSandbox {
  readonly id: string;
  readonly name: string;
  readonly instance?: string | undefined;
  readonly createdAt?: string | undefined;
}

export interface SandboxProviderDriver {
  readonly info: Omit<
    SandboxProviderInfo,
    "configured" | "capabilities" | "settings" | "defaultSize"
  >;
  readonly defaultSize: string;
  readonly serverPort: number;
  /** Extra environment for `t3 serve` in the sandbox, for what the provider's routing needs. */
  readonly serveEnvironment?: Readonly<Record<string, string>>;
  readonly create: (input: {
    readonly config: SandboxProviderConfig;
    readonly name: string;
    readonly size: string;
    readonly ttlMinutes?: number | undefined;
    readonly environment?: string | undefined;
    /** One per provisioning attempt; providers that support it must not bill a retried create twice. */
    readonly idempotencyKey: string;
    /** Start from this saved template instead of a fresh machine. */
    readonly template?: string | undefined;
    readonly tags?: SandboxTags | undefined;
    /** False for a tailnet-only sandbox: the server port gets no public URL. */
    readonly publishPort?: boolean | undefined;
  }) => Effect.Effect<CreatedSandbox, SandboxProviderError, HttpClient.HttpClient>;
  /** Null when the account's limits are unreadable (for example a key without that scope). */
  readonly limits?: (input: {
    readonly config: SandboxProviderConfig;
  }) => Effect.Effect<SandboxProviderLimits | null, SandboxProviderError, HttpClient.HttpClient>;
  readonly listEnvironments?: (input: {
    readonly config: SandboxProviderConfig;
  }) => Effect.Effect<
    ReadonlyArray<SandboxCredentialEnvironment>,
    SandboxProviderError,
    HttpClient.HttpClient
  >;
  readonly execute: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
    readonly command: string;
    readonly timeoutSeconds: number;
    /**
     * Environment for the command that must never be part of its text: providers keep and list
     * command text (Boat for 90 days), so this reaches the sandbox through another channel.
     */
    readonly secrets?: Readonly<Record<string, string>> | undefined;
  }) => Effect.Effect<SandboxExecResult, SandboxProviderError, HttpClient.HttpClient>;
  /**
   * Writes a file the command text must never carry, such as an env file, through the provider's
   * files API. Without it, the provisioner pipes the content through `execute`'s `secrets`.
   */
  readonly uploadFile?: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
    readonly path: string;
    readonly content: string;
  }) => Effect.Effect<void, SandboxProviderError, HttpClient.HttpClient>;
  readonly exposePort: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
    readonly port: number;
  }) => Effect.Effect<string, SandboxProviderError, HttpClient.HttpClient>;
  readonly destroy: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
  }) => Effect.Effect<void, SandboxProviderError, HttpClient.HttpClient>;
  readonly stop?: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
  }) => Effect.Effect<void, SandboxProviderError, HttpClient.HttpClient>;
  readonly resume?: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
    readonly ttlMinutes?: number | undefined;
  }) => Effect.Effect<{ readonly publicUrl?: string }, SandboxProviderError, HttpClient.HttpClient>;
  /**
   * A machine the provider no longer has is `deleted`, not an error. Null for a provider state
   * T3 does not track, so the record is left alone.
   */
  readonly status?: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
  }) => Effect.Effect<SandboxProviderStatus | null, SandboxProviderError, HttpClient.HttpClient>;
  /**
   * Saves a stopped sandbox's disk under `name` and waits until it can start new sandboxes. The
   * provisioner scrubs T3's identity and stops the machine first; the driver waits for the
   * provider to finish stopping when its snapshot needs that.
   */
  readonly saveTemplate?: (input: {
    readonly config: SandboxProviderConfig;
    readonly sandboxId: string;
    readonly name: string;
  }) => Effect.Effect<SandboxTemplate, SandboxProviderError, HttpClient.HttpClient>;
  /** Only templates T3 saved, never the provider's own base images. */
  readonly listTemplates?: (input: { readonly config: SandboxProviderConfig }) => Effect.Effect<
    {
      readonly templates: ReadonlyArray<SandboxTemplate>;
      readonly templateAllowance?: SandboxTemplateAllowance;
    },
    SandboxProviderError,
    HttpClient.HttpClient
  >;
  readonly deleteTemplate?: (input: {
    readonly config: SandboxProviderConfig;
    readonly name: string;
  }) => Effect.Effect<void, SandboxProviderError, HttpClient.HttpClient>;
  /** Every sandbox this server tagged at create, so the sweep can flag ones no record tracks. */
  readonly listSandboxes?: (input: {
    readonly config: SandboxProviderConfig;
    readonly host: string;
  }) => Effect.Effect<ReadonlyArray<ListedSandbox>, SandboxProviderError, HttpClient.HttpClient>;
  /** This month's cost of every T3 sandbox on the account in one call, keyed by sandbox id. */
  readonly usage?: (input: {
    readonly config: SandboxProviderConfig;
  }) => Effect.Effect<
    ReadonlyMap<string, SandboxUsage>,
    SandboxProviderError,
    HttpClient.HttpClient
  >;
}

const PROVIDER_ERROR_CODES: Record<string, SandboxProviderErrorCode> = {
  rate_limited: "rate_limited",
  IP_RATE_LIMIT_EXCEEDED: "rate_limited",
  limit_reached: "concurrency_full",
  member_limit_reached: "concurrency_full",
  billing_required: "billing_required",
  credit_required: "billing_required",
  trial_compute_limit_reached: "billing_required",
  team_member_cap_reached: "billing_required",
  machine_class_plan_required: "size_unavailable",
  trial_machine_class_not_allowed: "size_unavailable",
  invalid_type: "size_unavailable",
  snapshot_data_expired: "snapshot_expired",
  no_ready_machine: "capacity_unavailable",
  out_of_capacity: "capacity_unavailable",
  trial_saved_snapshots_not_allowed: "templates_unavailable",
  save_in_progress: "template_saving",
  snapshot_not_found: "not_found",
  // Celesto: https://celesto.ai/docs/cloud/errors
  concurrency_limit_reached: "concurrency_full",
  trial_retained_sandbox_limit_reached: "concurrency_full",
  trial_expired: "billing_required",
  trial_credit_depleted: "billing_required",
  prepaid_credit_depleted: "billing_required",
  trial_not_started: "billing_required",
  usage_subscription_required: "billing_required",
  prepaid_credit_required: "billing_required",
  payment_failed: "billing_required",
  payment_pending: "billing_required",
  trial_micro_only: "size_unavailable",
  resource_overrides_unavailable: "size_unavailable",
  invalid_sandbox_size: "size_unavailable",
  promotional_size_not_allowed: "size_unavailable",
};

// Where the stable code's own wording would send the user the wrong way.
const PROVIDER_ERROR_DETAILS: Record<string, string> = {
  trial_retained_sandbox_limit_reached:
    "The Celesto trial keeps one sandbox, stopped ones included. Delete it or add credit first.",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveNumber = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const parseErrorBody = (body: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const nested = isRecord(parsed.error) ? parsed.error : {};
  const details = isRecord(nested.details) ? nested.details : {};
  // Celesto nests its code as `{"detail": {"error_code": …}}`; older errors carry a string there.
  const celesto = isRecord(parsed.detail) ? parsed.detail : {};
  const code = [parsed.code, nested.code, celesto.error_code].find(
    (value) => typeof value === "string",
  );
  const message = [details.message, parsed.message].find((value) => typeof value === "string");
  const window = [parsed.window, details.window].find(
    (value): value is string => value === "minute" || value === "hour" || value === "day",
  );
  return {
    code: typeof code === "string" ? code : undefined,
    message: typeof message === "string" ? message : undefined,
    window,
    retryAfterSeconds: [
      parsed.retryAfterSeconds,
      details.retryAfterSeconds,
      parsed.retryAfter,
      details.retryAfter,
    ]
      .map(positiveNumber)
      .find((value) => value !== undefined),
  };
};

// Boat sends `Retry-After`; Daytona sends one `Retry-After-<window>` header per rate limit.
const retryAfterHeader = (headers: Readonly<Record<string, string>>): number | undefined => {
  const values = Object.entries(headers)
    .filter(([name]) => name.toLowerCase().startsWith("retry-after"))
    .map(([, value]) => positiveNumber(value))
    .filter((value) => value !== undefined);
  return values.length === 0 ? undefined : Math.max(...values);
};

const providerName = (provider: SandboxProviderKind) =>
  `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;

const describeProviderFailure = (input: {
  readonly provider: SandboxProviderKind;
  readonly code: SandboxProviderErrorCode;
  readonly status: number;
  readonly window: string | undefined;
  readonly retryAfterSeconds: number | undefined;
}): string => {
  const name = providerName(input.provider);
  const retry = describeSandboxRetry(input.retryAfterSeconds);
  switch (input.code) {
    case "api_key_rejected":
      return "The provider rejected the API key.";
    case "rate_limited":
      return input.window === undefined
        ? `${name} is limiting requests right now.${retry}`
        : `${name}'s start limit for this ${input.window} is used up.${retry}`;
    case "concurrency_full":
      return `${name}'s limit on running sandboxes is reached. Stop or delete one first.`;
    case "billing_required":
      return `${name} needs a payment or a plan change before it starts another sandbox.`;
    case "size_unavailable":
      return `This machine size is not available on your ${name} plan.`;
    case "snapshot_expired":
      return `${name} no longer keeps this stopped sandbox's disk. Delete it and create a new one.`;
    case "capacity_unavailable":
      return `${name} has no free machines right now.${retry || " Try again in a few minutes."}`;
    case "not_found":
      return "The provider could not find this resource.";
    case "templates_unavailable":
      return `Your ${name} plan cannot save templates.`;
    case "template_saving":
      return "A template with this name is still being saved. Wait for it to finish.";
    // T3's own refusals, never read from a provider's response.
    case "tailscale_required":
    case "unknown":
      return `The provider responded with HTTP ${input.status}.`;
  }
};

/**
 * The provisioner's client. Boat and Daytona answer a command only when it ends, up to ten minutes
 * later, past fetch's 300 s header timeout. This one sets no header or body timeout, so every
 * request through `requestJson` and `requestText` carries its own deadline instead.
 */
export const layerHttpClient = NodeHttpClient.layerUndiciNoDispatcher.pipe(
  Layer.provide(
    Layer.effect(NodeHttpClient.Dispatcher)(
      Effect.acquireRelease(Effect.sync(makeHttp1Dispatcher), (dispatcher) =>
        Effect.promise(() => dispatcher.destroy()),
      ),
    ),
  ),
);

// Other calls keep the 300 s fetch gave them; a command gets its own run time plus a margin.
const DEFAULT_REQUEST_SECONDS = 300;
const COMMAND_MARGIN_SECONDS = 60;

/** The deadline for a request that runs a command for up to `timeoutSeconds`. */
export const commandRequestSeconds = (timeoutSeconds: number) =>
  timeoutSeconds + COMMAND_MARGIN_SECONDS;

const withDeadline =
  (input: {
    readonly provider: SandboxProviderKind;
    readonly stage: SandboxStage;
    readonly timeoutSeconds?: number | undefined;
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: `${input.timeoutSeconds ?? DEFAULT_REQUEST_SECONDS} seconds`,
        orElse: () =>
          Effect.fail(
            new SandboxProviderError({
              provider: input.provider,
              stage: input.stage,
              detail: "The sandbox provider did not answer in time.",
            }),
          ),
      }),
    );

interface FailedAttempt {
  readonly error: SandboxProviderError;
  /** The provider's own code and message, read only to decide whether to send the request again. */
  readonly providerCode?: string | undefined;
  readonly providerMessage?: string | undefined;
}

const MAX_RETRIES = 3;
// A longer wait is the user's to see, through the error's `retryAfterSeconds`.
const MAX_RETRY_WAIT_SECONDS = 20;
// Boat refuses these before anything runs: https://docs.boat.dev/api/v1.md#commands-files-and-processes
const NOT_RUN_CODES = new Set(["sandbox_starting", "idempotency_in_progress"]);

const repeatable = (request: HttpClientRequest.HttpClientRequest) =>
  request.method === "GET" ||
  request.method === "HEAD" ||
  request.method === "PUT" ||
  request.method === "DELETE" ||
  request.headers["idempotency-key"] !== undefined;

const shouldRetry = (request: HttpClientRequest.HttpClientRequest, failure: FailedAttempt) => {
  const { status, code } = failure.error;
  // Any other `sandbox_direct_failed` on a command means it possibly ran.
  if (
    failure.providerCode === "sandbox_direct_failed" &&
    failure.providerMessage === "sandbox_restoring"
  ) {
    return true;
  }
  if (failure.providerCode !== undefined && NOT_RUN_CODES.has(failure.providerCode)) return true;
  // Only a request-rate limit frees up by waiting; a full plan answers 429 too.
  if (status === 429)
    return code === "rate_limited" && failure.error.retryAfterSeconds !== undefined;
  // A 5xx T3 has a code for is a refusal the user can act on, such as no free machines.
  const transient = status === undefined || (status >= 500 && code === "unknown");
  return transient && repeatable(request);
};

const executeOnce = Effect.fnUntraced(function* (input: {
  readonly provider: SandboxProviderKind;
  readonly stage: SandboxStage;
  readonly request: HttpClientRequest.HttpClientRequest;
}) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(input.request).pipe(
    Effect.mapError((cause): FailedAttempt => ({
      error: new SandboxProviderError({
        provider: input.provider,
        stage: input.stage,
        // The transport message is bounded and does not include the request headers or body.
        detail: "The sandbox provider could not be reached.",
        cause,
      }),
    })),
  );
  if (response.status < 200 || response.status >= 300) {
    // Provider bodies can echo request values, so the reason stays structured and the body only
    // ever travels as the cause, never as an attribute or in the message shown to the client.
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const parsed = parseErrorBody(body);
    const providerCode = parsed.code === undefined ? undefined : PROVIDER_ERROR_CODES[parsed.code];
    const code: SandboxProviderErrorCode =
      providerCode ??
      (response.status === 401 || response.status === 403
        ? "api_key_rejected"
        : response.status === 404
          ? "not_found"
          : response.status === 429
            ? "rate_limited"
            : response.status === 402
              ? "billing_required"
              : "unknown");
    const retryAfterSeconds = parsed.retryAfterSeconds ?? retryAfterHeader(response.headers);
    return yield* Effect.fail<FailedAttempt>({
      error: new SandboxProviderError({
        provider: input.provider,
        stage: input.stage,
        status: response.status,
        code,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        detail:
          (parsed.code === undefined ? undefined : PROVIDER_ERROR_DETAILS[parsed.code]) ??
          describeProviderFailure({
            provider: input.provider,
            code,
            status: response.status,
            window: parsed.window,
            retryAfterSeconds,
          }),
        cause: new Error(body.slice(0, 2000)),
      }),
      providerCode: parsed.code,
      providerMessage: parsed.message,
    });
  }
  return response;
});

// Untraced: `requestJson` and `requestText` own the span for the request. Retries stay inside the
// caller's deadline, and only what the provider documents as safe to send again is sent again.
const executeChecked = (
  input: Parameters<typeof executeOnce>[0],
  attempt = 0,
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  SandboxProviderError,
  HttpClient.HttpClient
> =>
  executeOnce(input).pipe(
    Effect.catch((failure) =>
      Effect.gen(function* () {
        if (attempt >= MAX_RETRIES || !shouldRetry(input.request, failure)) {
          return yield* failure.error;
        }
        const wait =
          failure.error.retryAfterSeconds ?? 2 ** attempt * (yield* Random.nextBetween(0.5, 1));
        if (wait > MAX_RETRY_WAIT_SECONDS) return yield* failure.error;
        yield* Effect.sleep(`${Math.round(wait * 1000)} millis`);
        return yield* executeChecked(input, attempt + 1);
      }),
    ),
  );

/** A create that failed this way may still have made the machine: no answer, or a 5xx T3 has no code for. */
export const mayHaveCreated = (error: SandboxProviderError) =>
  error.status === undefined || (error.status >= 500 && error.code === "unknown");

/**
 * A provider name unique to one create attempt, so a create whose answer was lost can be found by
 * name: URL-safe, from the label, with the attempt id keeping two equal labels apart.
 */
export const attemptSandboxName = (label: string, idempotencyKey: string) => {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "sandbox";
  return `${slug}-${idempotencyKey.replace(/[^a-zA-Z0-9]/gu, "").slice(0, 8)}`;
};

export const requestJson = Effect.fn("SandboxProvider.requestJson")(function* <
  S extends Schema.Top,
>(input: {
  readonly provider: SandboxProviderKind;
  readonly stage: SandboxStage;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly schema: S;
  /** Covers the response body too; defaults to `DEFAULT_REQUEST_SECONDS`. */
  readonly timeoutSeconds?: number | undefined;
}): Effect.fn.Return<
  S["Type"],
  SandboxProviderError,
  HttpClient.HttpClient | S["DecodingServices"]
> {
  return yield* executeChecked(input).pipe(
    Effect.flatMap((response) =>
      HttpClientResponse.schemaBodyJson(input.schema)(response).pipe(
        Effect.mapError(
          () =>
            new SandboxProviderError({
              provider: input.provider,
              stage: input.stage,
              detail: "Unexpected response from the sandbox provider.",
            }),
        ),
      ),
    ),
    withDeadline(input),
  );
});

/** For bodies that are not one JSON document, such as an ND-JSON stream; errors map as above. */
export const requestText = Effect.fn("SandboxProvider.requestText")(function* (input: {
  readonly provider: SandboxProviderKind;
  readonly stage: SandboxStage;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly timeoutSeconds?: number | undefined;
}) {
  return yield* executeChecked(input).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.mapError(
          (cause) =>
            new SandboxProviderError({
              provider: input.provider,
              stage: input.stage,
              detail: "The sandbox provider's response could not be read.",
              cause,
            }),
        ),
      ),
    ),
    withDeadline(input),
  );
});

export const authorize = (
  request: HttpClientRequest.HttpClientRequest,
  apiKey: string,
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.setHeaders(request, { authorization: `Bearer ${apiKey}` });

export const jsonBody = (
  request: HttpClientRequest.HttpClientRequest,
  value: unknown,
): HttpClientRequest.HttpClientRequest => HttpClientRequest.bodyJsonUnsafe(request, value);

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
