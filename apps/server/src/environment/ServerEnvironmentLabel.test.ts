import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ProcessRunner from "../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

const neverExits = ChildProcessSpawner.make(() =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.never,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.never,
      stderr: Stream.never,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
  ),
);

it.effect("falls back to the hostname when hostnamectl never answers", () =>
  Effect.gen(function* () {
    // Without /etc/machine-info the label comes from hostnamectl, which waits on D-Bus.
    const label = yield* resolveServerEnvironmentLabel({ cwdBaseName: "project" }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Hostname, "devbox"),
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
          Path.layer,
          ProcessRunner.layer.pipe(
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, neverExits)),
          ),
        ),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("5 seconds");
    assert.equal(yield* Fiber.join(label), "devbox");
  }),
);

const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

it.effect("prefers the label provisioning writes into the base directory", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-label-" });
    yield* fileSystem.writeFileString(path.join(baseDir, "environment-label"), "  Boat sandbox\n");

    // No sudo, systemd, or writable /etc is needed for this path, which is why provisioning uses it.
    const label = yield* resolveServerEnvironmentLabel({ cwdBaseName: "workspace", baseDir });

    expect(label).toBe("Boat sandbox");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("uses the desktop's display name ahead of the computer name", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-label-" });

    // A renamed side-by-side build would otherwise share the computer name with the official app.
    const label = yield* resolveServerEnvironmentLabel({
      cwdBaseName: "workspace",
      baseDir,
      displayName: "  T3 Code Custom ",
    });

    expect(label).toBe("T3 Code Custom");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps the provisioned label file ahead of the desktop's display name", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-label-" });
    yield* fileSystem.writeFileString(path.join(baseDir, "environment-label"), "Boat sandbox\n");

    const label = yield* resolveServerEnvironmentLabel({
      cwdBaseName: "workspace",
      baseDir,
      displayName: "T3 Code Custom",
    });

    expect(label).toBe("Boat sandbox");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("falls back to the host name when no display name is set or it is blank", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-label-" });

    const withoutName = yield* resolveServerEnvironmentLabel({ cwdBaseName: "workspace", baseDir });
    const blankName = yield* resolveServerEnvironmentLabel({
      cwdBaseName: "workspace",
      baseDir,
      displayName: "   ",
    });

    expect(withoutName).toBe("omars-macbook-pro");
    expect(blankName).toBe("omars-macbook-pro");
  }).pipe(
    // No friendly-name probe runs off macOS and Linux, so the host name decides.
    Effect.provideService(HostProcess.Platform, "freebsd"),
    Effect.provideService(HostProcess.Hostname, "omars-macbook-pro"),
    Effect.provide(TestLayer),
  ),
);
