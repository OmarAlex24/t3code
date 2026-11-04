import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import {
  CLAUDE_SETTINGS_SCRUB,
  claudeSettingsScript,
  endpointReachScript,
  ENSURE_TOOLS_SCRIPT,
  parseEndpointReach,
  parseMissingTools,
} from "./sandboxSetup.ts";

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

describe("ENSURE_TOOLS_SCRIPT", () => {
  it.live("does nothing on an image that ships every tool", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = `${home}/bin`;
        yield* fs.makeDirectory(bin);
        for (const tool of ["git", "gh", "claude"]) {
          yield* fs.writeFileString(`${bin}/${tool}`, "#!/bin/sh\n");
          yield* fs.chmod(`${bin}/${tool}`, 0o755);
        }
        // Any download would go through curl, which leaves a mark here.
        yield* fs.writeFileString(`${bin}/curl`, `#!/bin/sh\ntouch "${home}/downloaded"\n`);
        yield* fs.chmod(`${bin}/curl`, 0o755);
        const output = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
          Effect.flatMap((spawner) =>
            spawner.string(
              ChildProcess.make("/bin/sh", ["-c", ENSURE_TOOLS_SCRIPT], {
                cwd: home,
                env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
                stdin: "ignore",
              }),
            ),
          ),
        );
        expect(parseMissingTools(output)).toEqual([]);
        expect(yield* fs.exists(`${home}/downloaded`)).toBe(false);
      }),
    ),
  );
});

describe("endpointReachScript", () => {
  it.live("reports an endpoint nothing answers on as unreachable", () =>
    withHome((home) =>
      // Port 9 (discard) refuses at once, the way a tailnet address fails from a cloud machine.
      Effect.gen(function* () {
        const output = yield* runIn(
          home,
          endpointReachScript("http://127.0.0.1:9/'$(touch pwned)"),
        );
        expect(parseEndpointReach(output)).toBe("unreachable");
        expect(yield* (yield* FileSystem.FileSystem).exists(`${home}/pwned`)).toBe(false);
      }),
    ),
  );
});
