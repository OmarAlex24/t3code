import {
  DiyKitError,
  DiyKitStatus,
  DiyLogInput,
  type DiyLogResult,
  DiySetResolverInput,
  type DiyStatusResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

/**
 * The t3code-diy kit that builds this app, when the app was built by it. The kit puts
 * `T3CODE_DIY_BIN` in the app's Info.plist; without it every method reports the kit unavailable.
 */
export class DiyKit extends Context.Service<
  DiyKit,
  {
    readonly status: Effect.Effect<DiyStatusResult, DiyKitError>;
    readonly setResolver: (input: DiySetResolverInput) => Effect.Effect<void, DiyKitError>;
    readonly runNow: Effect.Effect<void, DiyKitError>;
    readonly log: (input: DiyLogInput) => Effect.Effect<DiyLogResult, DiyKitError>;
  }
>()("t3/diy/DiyKit") {}

const DiyBinConfig = Config.String("T3CODE_DIY_BIN").pipe(
  Config.option,
  Config.map(Option.flatMap((value) => Option.liftPredicate(value.trim(), (bin) => bin !== ""))),
);

const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(DiyKitStatus));
const decodeResolver = Schema.decodeUnknownEffect(DiySetResolverInput);
const decodeLogInput = Schema.decodeUnknownEffect(DiyLogInput);

// `status` reads launchd and codesign; `config set` asks the resolver CLI whether it is logged in.
const STATUS_TIMEOUT = Duration.seconds(15);
const CONFIG_TIMEOUT = Duration.seconds(30);
const RUN_TIMEOUT = Duration.seconds(15);
const LOG_TIMEOUT = Duration.seconds(10);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_MESSAGE_LENGTH = 300;

const unavailable = new DiyKitError({ message: "This app was not built by t3code-diy." });

/** The kit's last stderr line ("error: ..." from its die), short enough for a toast. */
const kitMessage = (stderr: string, fallback: string) => {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .findLast((entry) => entry !== "");
  const message = (line ?? fallback).replace(/^error:\s*/, "");
  return message.length > MAX_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : message;
};

const make = Effect.gen(function* () {
  const configuredBin = yield* DiyBinConfig.pipe(Effect.orElseSucceed(() => Option.none()));
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;

  // Checked on every call: the kit can be uninstalled while the app runs.
  const executable = Effect.fn("DiyKit.executable")(function* () {
    if (Option.isNone(configuredBin) || !path.isAbsolute(configuredBin.value)) {
      return Option.none<string>();
    }
    const info = yield* fileSystem.stat(configuredBin.value).pipe(Effect.option);
    return Option.isSome(info) && info.value.type === "File" && (info.value.mode & 0o111) !== 0
      ? Option.some(configuredBin.value)
      : Option.none<string>();
  });

  const run = Effect.fn("DiyKit.run")(function* (
    args: ReadonlyArray<string>,
    timeout: Duration.Duration,
  ) {
    const bin = yield* executable();
    if (Option.isNone(bin)) return yield* unavailable;
    yield* Effect.annotateCurrentSpan({ "diy.command": args[0] ?? "" });
    const output = yield* runner
      .run({
        command: bin.value,
        args,
        timeout,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: MAX_OUTPUT_BYTES,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError((cause) => new DiyKitError({ message: kitMessage("", cause.message) })),
      );
    if (output.timedOut) {
      return yield* new DiyKitError({
        message: `t3code-diy ${args[0]} did not answer within ${Duration.format(timeout)}.`,
      });
    }
    if (output.code !== 0) {
      return yield* new DiyKitError({
        message: kitMessage(output.stderr, `t3code-diy ${args[0]} exited with ${output.code}.`),
      });
    }
    return output.stdout;
  });

  const status = Effect.gen(function* () {
    if (Option.isNone(yield* executable())) return { available: false } as const;
    const stdout = yield* run(["status", "--json"], STATUS_TIMEOUT);
    const kitStatus = yield* decodeStatus(stdout).pipe(
      Effect.mapError(
        () =>
          new DiyKitError({
            message: "t3code-diy status --json printed something this app can't read.",
          }),
      ),
    );
    return { available: true, status: kitStatus } as const;
  }).pipe(Effect.withSpan("DiyKit.status"));

  // Decoded again here: these values become a child's argv, so nothing unchecked gets there.
  const setResolver: DiyKit["Service"]["setResolver"] = Effect.fn("DiyKit.setResolver")(
    function* (input) {
      const { provider, model, effort } = yield* decodeResolver(input).pipe(
        Effect.mapError(() => new DiyKitError({ message: "That resolver or model isn't valid." })),
      );
      // Only when given: a kit from before RESOLVER_EFFORT refuses the key, and it leaves the
      // effort alone otherwise (clearing one the new provider lacks).
      yield* run(
        [
          "config",
          "set",
          "RESOLVER_PROVIDER",
          provider,
          "RESOLVER_MODEL",
          model,
          ...(effort === undefined ? [] : ["RESOLVER_EFFORT", effort]),
        ],
        CONFIG_TIMEOUT,
      );
    },
  );

  const runNow = run(["run"], RUN_TIMEOUT).pipe(Effect.asVoid, Effect.withSpan("DiyKit.runNow"));

  const log: DiyKit["Service"]["log"] = Effect.fn("DiyKit.log")(function* (input) {
    const { lines } = yield* decodeLogInput(input).pipe(
      Effect.mapError(() => new DiyKitError({ message: "That many log lines can't be shown." })),
    );
    return { text: yield* run(["log", "--tail", String(lines)], LOG_TIMEOUT) };
  });

  return DiyKit.of({ status, setResolver, runNow, log });
});

export const layer = Layer.effect(DiyKit, make);

/**
 * Sessions of clients the machine's owner started here: the desktop shell, the startup link the
 * server prints, and the dev token. Paired devices, T3 Connect and MCP clients never see the kit.
 */
const LOCAL_OWNER_SUBJECTS: ReadonlySet<string> = new Set([
  "desktop-bootstrap",
  "administrative-bootstrap",
  "reusable-dev-token",
  "reusable-dev-token-child",
]);

const notLocal = new DiyKitError({
  message: "Only this Mac's own app can manage its custom build.",
});

/** The DIY WebSocket RPC handlers, each a call to one kit method. */
export const rpcHandlers = Effect.fn("DiyKit.rpcHandlers")(function* (session: {
  readonly subject: string;
}) {
  const kit = yield* DiyKit;
  const local = LOCAL_OWNER_SUBJECTS.has(session.subject);
  return {
    [WS_METHODS.diyStatus]: () =>
      local ? kit.status : Effect.succeed<DiyStatusResult>({ available: false }),
    [WS_METHODS.diySetResolver]: (input: DiySetResolverInput) =>
      local ? kit.setResolver(input) : Effect.fail(notLocal),
    [WS_METHODS.diyRunNow]: () => (local ? kit.runNow : Effect.fail(notLocal)),
    [WS_METHODS.diyLog]: (input: DiyLogInput) => (local ? kit.log(input) : Effect.fail(notLocal)),
  };
});
