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
  parseTailscaleReport,
  tailscaleScript,
  tailscaleScrub,
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

// Stand-ins for sudo and Tailscale's binaries, so the scripts run without root. The daemon never
// gets a TUN device, which is what a container gives tailscaled.
const TAILSCALE_STUBS = {
  sudo: `#!/bin/sh
[ "$1" = -n ] && shift
exec "$@"`,
  tailscaled: `#!/bin/sh
echo "$*" >"$T3_STUB/tailscaled.args"
echo "$TS_ASSUME_NETWORK_UP_FOR_TEST" >"$T3_STUB/tailscaled.assume-up"
echo start >>"$T3_STUB/starts"`,
  tailscale: `#!/bin/sh
echo "$*" >>"$T3_STUB/tailscale.argv"
for arg in "$@"; do
  case "$arg" in
    status)
      [ -f "$T3_STUB/tailscaled.args" ] || exit 1
      if [ -f "$T3_STUB/up" ]; then state=Running; id=nTESTCNTRL; else state=NeedsLogin; id=; fi
      printf '{\\n  "TUN": false,\\n  "BackendState": "%s",\\n  "Self": {\\n    "ID": "%s",\\n    "NodeID": 7\\n  }\\n}\\n' "$state" "$id"
      exit 0 ;;
    up) up=1 ;;
    logout) rm -f "$T3_STUB/up"; exit 0 ;;
    --auth-key=file:*) key="\${arg#--auth-key=file:}" ;;
  esac
done
if [ -n "$up" ]; then
  cat "$key" >"$T3_STUB/key.seen"
  find "$key" -perm 600 >"$T3_STUB/key.mode"
  touch "$T3_STUB/up"
fi`,
};

const withTailscaleStubs = <A, E, R>(
  test: (run: (script: string) => Effect.Effect<string>, stub: string) => Effect.Effect<A, E, R>,
) =>
  withHome((home) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bin = `${home}/bin`;
      const stub = `${home}/stub`;
      yield* fs.makeDirectory(bin);
      yield* fs.makeDirectory(stub);
      for (const [name, body] of Object.entries(TAILSCALE_STUBS)) {
        yield* fs.writeFileString(`${bin}/${name}`, `${body}\n`);
        yield* fs.chmod(`${bin}/${name}`, 0o755);
      }
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const run = (script: string) =>
        spawner
          .string(
            ChildProcess.make("sh", ["-c", script], {
              cwd: home,
              env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, T3_STUB: stub },
              stdin: "ignore",
            }),
          )
          .pipe(Effect.orDie);
      return yield* test(run, stub);
    }),
  );

describe("tailscaleScript", () => {
  it.live(
    "falls back to userspace, joins with the key as a 0600 file, and the scrub logs out",
    () =>
      withTailscaleStubs((run, stub) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = `${stub}/root`;
          const authKey = "tskey-auth-'$(touch pwned)\"";
          const joined = parseTailscaleReport(
            yield* run(tailscaleScript({ authKey, hostname: "t3-sandbox-web", root })),
          );
          expect(joined).toEqual({
            daemon: "nohup",
            mode: "userspace",
            state: "Running",
            nodeId: "nTESTCNTRL",
          });
          expect(yield* fs.readFileString(`${stub}/tailscaled.args`)).toBe(
            `--state=${root}/var/lib/tailscale/tailscaled.state --socket=${root}/run/tailscale/tailscaled.sock --tun=userspace-networking --outbound-http-proxy-listen=localhost:1055\n`,
          );
          // Vercel's eth0 has only link-local addresses; without this tailscaled pauses as offline.
          expect(yield* fs.readFileString(`${stub}/tailscaled.assume-up`)).toBe("1\n");
          // The key is data in a private file: never an argument, never shell.
          expect(yield* fs.readFileString(`${stub}/key.seen`)).toBe(authKey);
          expect((yield* fs.readFileString(`${stub}/key.mode`)).trim()).not.toBe("");
          const argv = yield* fs.readFileString(`${stub}/tailscale.argv`);
          expect(argv).not.toContain("tskey-auth");
          expect(argv).toContain("--hostname=t3-sandbox-web --accept-dns=false");
          expect(yield* fs.exists(`${stub}/pwned`)).toBe(false);

          // A daemon that still answers in the recorded mode is left running.
          const starts = yield* fs.readFileString(`${stub}/starts`);
          const resumed = parseTailscaleReport(
            yield* run(tailscaleScript({ hostname: "t3-sandbox-web", root })),
          );
          expect(resumed).toMatchObject({ mode: "userspace", state: "Running" });
          expect(yield* fs.readFileString(`${stub}/starts`)).toBe(starts);

          yield* run(`set -eu\n${tailscaleScrub(root)}`);
          expect(yield* fs.readFileString(`${stub}/tailscale.argv`)).toContain("logout");
          expect(yield* fs.exists(`${root}/var/lib/tailscale`)).toBe(false);
        }),
      ),
  );
});
