import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";

/**
 * A personal build kept current by the t3code-diy kit, which the app finds through
 * `T3CODE_DIY_BIN`. Its `status --json` format is the kit's; fields this app doesn't know are
 * ignored, so the kit and the app can update separately.
 */
export const DIY_WS_METHODS = {
  diyStatus: "diy.status",
  diySetResolver: "diy.setResolver",
  diyRunNow: "diy.runNow",
  diyLog: "diy.log",
} as const;

export const DiyResolverProvider = Schema.Literals(["claude", "codex"]);
export type DiyResolverProvider = typeof DiyResolverProvider.Type;

/** The kit's own check, so a model name never needs quoting. Empty means the CLI's default. */
export const DIY_RESOLVER_MODEL_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127})?$/;
export const DiyResolverModel = Schema.String.check(Schema.isPattern(DIY_RESOLVER_MODEL_PATTERN));

const NullableString = Schema.NullOr(Schema.String);

export const DiyRunResult = Schema.Struct({
  /** ok, up_to_date, running, conflict_unresolved, tests_failed, ... (see the kit's README). */
  result: Schema.String,
  reason: Schema.String,
  startedAt: NullableString,
  endedAt: NullableString,
  version: NullableString,
  log: NullableString,
});
export type DiyRunResult = typeof DiyRunResult.Type;

export const DiyKitStatus = Schema.Struct({
  schema: Schema.Number,
  mode: Schema.String,
  app: Schema.Struct({
    name: Schema.String,
    installedVersion: NullableString,
    latestBuild: NullableString,
  }),
  fork: Schema.Struct({ url: Schema.String, branch: Schema.String }),
  upstream: Schema.Struct({ url: Schema.String, branch: Schema.String }),
  resolver: Schema.Struct({ provider: Schema.String, model: Schema.String }),
  schedule: Schema.Struct({ loaded: Schema.Boolean, nextRun: NullableString }),
  running: Schema.Boolean,
  lastRun: Schema.NullOr(DiyRunResult),
});
export type DiyKitStatus = typeof DiyKitStatus.Type;

export const DiyStatusResult = Schema.Union([
  Schema.Struct({ available: Schema.Literal(false) }),
  Schema.Struct({ available: Schema.Literal(true), status: DiyKitStatus }),
]);
export type DiyStatusResult = typeof DiyStatusResult.Type;

export const DiySetResolverInput = Schema.Struct({
  provider: DiyResolverProvider,
  model: DiyResolverModel,
});
export type DiySetResolverInput = typeof DiySetResolverInput.Type;

const DIY_LOG_MAX_LINES = 2_000;
export const DiyLogInput = Schema.Struct({
  lines: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: DIY_LOG_MAX_LINES })),
});
export type DiyLogInput = typeof DiyLogInput.Type;

export const DiyLogResult = Schema.Struct({ text: Schema.String });
export type DiyLogResult = typeof DiyLogResult.Type;

export class DiyKitError extends Schema.TaggedError<DiyKitError>()("DiyKitError", {
  /** One line from the kit (its stderr) or about running it; never more than a few hundred chars. */
  message: Schema.String,
}) {}

const DiyFailure = Schema.Union([DiyKitError, EnvironmentAuthorizationError]);

export const DiyRpcs = [
  Rpc.make(DIY_WS_METHODS.diyStatus, {
    payload: Schema.Void,
    success: DiyStatusResult,
    error: DiyFailure,
  }),
  Rpc.make(DIY_WS_METHODS.diySetResolver, {
    payload: DiySetResolverInput,
    success: Schema.Void,
    error: DiyFailure,
  }),
  Rpc.make(DIY_WS_METHODS.diyRunNow, {
    payload: Schema.Void,
    success: Schema.Void,
    error: DiyFailure,
  }),
  Rpc.make(DIY_WS_METHODS.diyLog, {
    payload: DiyLogInput,
    success: DiyLogResult,
    error: DiyFailure,
  }),
] as const;

// Starting a rebuild or changing who rewrites the branch is maintenance of this machine's install.
export const DIY_RPC_REQUIRED_SCOPES = {
  [DIY_WS_METHODS.diyStatus]: AuthDiagnosticsReadScope,
  [DIY_WS_METHODS.diySetResolver]: AuthEnvironmentMaintainScope,
  [DIY_WS_METHODS.diyRunNow]: AuthEnvironmentMaintainScope,
  [DIY_WS_METHODS.diyLog]: AuthDiagnosticsReadScope,
} as const;

export const DIY_CLIENT_GUARDED_RPC_SCOPES = {
  [DIY_WS_METHODS.diySetResolver]: AuthEnvironmentMaintainScope,
  [DIY_WS_METHODS.diyRunNow]: AuthEnvironmentMaintainScope,
} as const;
