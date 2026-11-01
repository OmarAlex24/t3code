import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import { CLAUDE_SETTINGS_SCRUB, claudeSettingsScript } from "./sandboxSetup.ts";

// The scripts run in a throwaway HOME with this machine's sh and node, as they would in a sandbox.
const runIn = (home: string, script: string) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) =>
      spawner.string(
        ChildProcess.make("sh", ["-c", script], {
          cwd: home,
          env: { PATH: process.env.PATH, HOME: home },
          stdin: "ignore",
        }),
      ),
    ),
  );

const withHome = <A, E, R>(test: (home: string, settingsFile: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-settings-" });
    return yield* test(home, path.join(home, ".claude", "settings.json"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const endpoint = (token: string) => ({
  ANTHROPIC_BASE_URL: "https://example.invalid",
  ANTHROPIC_AUTH_TOKEN: token,
});

describe("claudeSettingsScript", () => {
  it.live(
    "merges the endpoint into Claude's settings, keeps every other key, and prints nothing",
    () =>
      withHome((home, file) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${home}/.claude`);
          yield* fs.writeFileString(
            file,
            JSON.stringify({
              model: "opus",
              env: { DISABLE_TELEMETRY: "1", ANTHROPIC_BASE_URL: "x" },
            }),
          );
          const token = "t3-sandbox-test-'$(touch pwned)\"";
          expect(yield* runIn(home, claudeSettingsScript(endpoint(token)))).toBe("");
          // The token is data, never shell: nothing in it ran.
          expect(yield* fs.exists(`${home}/pwned`)).toBe(false);
          expect(JSON.parse(yield* fs.readFileString(file))).toEqual({
            model: "opus",
            env: { DISABLE_TELEMETRY: "1", ...endpoint(token) },
          });
          expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);

          // A template copy keeps the user's settings but not the endpoint or its token.
          yield* runIn(home, CLAUDE_SETTINGS_SCRUB);
          expect(JSON.parse(yield* fs.readFileString(file))).toEqual({
            model: "opus",
            env: { DISABLE_TELEMETRY: "1" },
          });
        }),
      ),
  );

  it.live("creates the settings file when the sandbox has none", () =>
    withHome((home, file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* runIn(home, claudeSettingsScript(endpoint("t3-sandbox-test-0")));
        expect(JSON.parse(yield* fs.readFileString(file))).toEqual({
          env: endpoint("t3-sandbox-test-0"),
        });
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
      }),
    ),
  );
});
