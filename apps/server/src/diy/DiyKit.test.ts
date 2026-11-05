import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { WS_METHODS } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";
import * as DiyKit from "./DiyKit.ts";

// Answers like the kit does, and writes the argv it got (one per line) next to itself.
const FAKE_KIT = `#!/bin/sh
dir="$(dirname "$0")"
printf '%s\\n' "$@" > "$dir/argv"
case "$1" in
  status) cat "$dir/status.json" ;;
  config) [ "$4" = codex ] && { echo "error: can't switch the resolver to codex: the codex CLI is not logged in (run: codex login)" >&2; exit 1; }; echo saved ;;
  run) echo started ;;
  log) printf 'line one\\nline two\\n' ;;
esac
`;

const KIT_STATUS = {
  schema: 1,
  kit: { bin: "/kit/bin/t3code-diy", home: "/kit" },
  mode: "side-by-side",
  app: {
    name: "T3 Code Custom",
    path: "/Applications/T3 Code Custom.app",
    installedVersion: "0.1.8-nightly.20261105.900004",
    forkBuild: true,
    latestBuild: "0.1.8-nightly.20261105.900005",
  },
  fork: { url: "git@github.com:you/t3code.git", branch: "my-changes" },
  upstream: { url: "https://github.com/pingdotgg/t3code.git", branch: "main" },
  resolver: { provider: "claude", model: "opus", effort: "high", timeoutMinutes: 90 },
  schedule: {
    loaded: true,
    hour: 5,
    minute: 0,
    atLogin: true,
    nextRun: "2026-11-05T05:00:00-06:00",
  },
  running: false,
  lastRun: {
    result: "tests_failed",
    reason: "your fork's tests failed",
    startedAt: "2026-11-04T17:45:28-06:00",
    endedAt: "2026-11-04T17:49:16-06:00",
    version: null,
    log: "/kit/logs/update-20261104-174528.log",
    somethingNewer: true,
  },
};

const kitLayer = (env: Record<string, string>) =>
  DiyKit.layer.pipe(
    Layer.provide(ProcessRunner.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

/** A temp dir holding the fake kit (mode 0755 unless `mode` says otherwise). */
const makeFakeKit = Effect.fn("DiyKit.test.makeFakeKit")(function* (mode = 0o755) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-diy-kit-" });
  const bin = `${dir}/t3code-diy`;
  yield* fs.writeFileString(bin, FAKE_KIT);
  yield* fs.chmod(bin, mode);
  yield* fs.writeFileString(`${dir}/status.json`, JSON.stringify(KIT_STATUS));
  const argv = fs.readFileString(`${dir}/argv`).pipe(
    Effect.map((text) => Option.some(text.split("\n").slice(0, -1))),
    Effect.orElseSucceed(() => Option.none<ReadonlyArray<string>>()),
  );
  return { bin, argv };
});

const withKit = <A, E>(
  env: Record<string, string>,
  body: Effect.Effect<A, E, DiyKit.DiyKit>,
): Effect.Effect<A, E> =>
  body.pipe(Effect.provide(kitLayer(env).pipe(Layer.provide(NodeServices.layer))));

describe("DiyKit", () => {
  it.live("reports no kit when T3CODE_DIY_BIN is unset, relative or not executable", () =>
    Effect.gen(function* () {
      const plain = yield* makeFakeKit(0o644);
      for (const env of [{}, { T3CODE_DIY_BIN: "t3code-diy" }, { T3CODE_DIY_BIN: plain.bin }]) {
        const result = yield* withKit(
          env,
          Effect.gen(function* () {
            const kit = yield* DiyKit.DiyKit;
            return {
              status: yield* kit.status,
              run: yield* kit.runNow.pipe(Effect.flip),
            };
          }),
        );
        expect(result.status).toEqual({ available: false });
        expect(result.run._tag).toBe("DiyKitError");
      }
      expect(yield* plain.argv).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reads status --json and ignores fields it doesn't know", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeKit();
      const result = yield* withKit(
        { T3CODE_DIY_BIN: fake.bin },
        DiyKit.DiyKit.use((kit) => kit.status),
      );
      expect(yield* fake.argv).toEqual(Option.some(["status", "--json"]));
      expect(result).toMatchObject({
        available: true,
        status: {
          fork: { branch: "my-changes" },
          resolver: { provider: "claude", model: "opus", effort: "high" },
          lastRun: { result: "tests_failed", reason: "your fork's tests failed" },
        },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("passes a checked resolver as argv and reports the kit's own error", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeKit();
      const env = { T3CODE_DIY_BIN: fake.bin };

      const invalid = yield* withKit(
        env,
        DiyKit.DiyKit.use((kit) =>
          kit.setResolver({ provider: "claude", model: "opus; rm -rf ~" }).pipe(Effect.flip),
        ),
      );
      expect(invalid.message).toBe("That resolver or model isn't valid.");
      expect(yield* fake.argv).toEqual(Option.none());

      yield* withKit(
        env,
        DiyKit.DiyKit.use((kit) =>
          kit.setResolver({ provider: "claude", model: "claude-opus-4-6[1m]" }),
        ),
      );
      expect(yield* fake.argv).toEqual(
        Option.some([
          "config",
          "set",
          "RESOLVER_PROVIDER",
          "claude",
          "RESOLVER_MODEL",
          "claude-opus-4-6[1m]",
        ]),
      );

      // An effort goes along only when given, so a kit that predates RESOLVER_EFFORT still answers.
      yield* withKit(
        env,
        DiyKit.DiyKit.use((kit) =>
          kit.setResolver({ provider: "claude", model: "opus", effort: "xhigh" }),
        ),
      );
      expect(yield* fake.argv).toEqual(
        Option.some([
          "config",
          "set",
          "RESOLVER_PROVIDER",
          "claude",
          "RESOLVER_MODEL",
          "opus",
          "RESOLVER_EFFORT",
          "xhigh",
        ]),
      );
      const ultracode = yield* withKit(
        env,
        DiyKit.DiyKit.use((kit) =>
          kit
            .setResolver({ provider: "claude", model: "opus", effort: "ultracode" })
            .pipe(Effect.flip),
        ),
      );
      expect(ultracode.message).toBe("That resolver or model isn't valid.");

      const refused = yield* withKit(
        env,
        DiyKit.DiyKit.use((kit) =>
          kit.setResolver({ provider: "codex", model: "" }).pipe(Effect.flip),
        ),
      );
      expect(refused.message).toBe(
        "can't switch the resolver to codex: the codex CLI is not logged in (run: codex login)",
      );

      const log = yield* withKit(
        env,
        DiyKit.DiyKit.use((kit) => kit.log({ lines: 40 })),
      );
      expect(log.text).toBe("line one\nline two\n");
      expect(yield* fake.argv).toEqual(Option.some(["log", "--tail", "40"]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("never runs the kit for a paired or remote session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeKit();
      const result = yield* withKit(
        { T3CODE_DIY_BIN: fake.bin },
        Effect.gen(function* () {
          const handlers = yield* DiyKit.rpcHandlers({ subject: "one-time-token" });
          return {
            status: yield* handlers[WS_METHODS.diyStatus](),
            run: yield* handlers[WS_METHODS.diyRunNow]().pipe(Effect.flip),
          };
        }),
      );
      expect(result.status).toEqual({ available: false });
      expect(result.run.message).toBe("Only this Mac's own app can manage its custom build.");
      expect(yield* fake.argv).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
