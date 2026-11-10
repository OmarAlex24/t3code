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
  githubAppLoginScript,
  githubLoginScript,
  KEEP_ALIVE_SCRUB,
  MCP_SERVERS_SCRUB,
  mcpServersScript,
  parseEndpointReach,
  parseSetupScriptReport,
  setupScriptScript,
  parseMissingTools,
  parseRailwayCli,
  parseTailscaleReport,
  RAILWAY_LOGIN_SCRUB,
  railwayLoginScript,
  sandboxKeepAliveScript,
  type SandboxScript,
  tailscaleScript,
  tailscaleScrub,
} from "./sandboxSetup.ts";

const asScript = (script: string | SandboxScript): SandboxScript =>
  typeof script === "string" ? { command: script } : script;

// Providers keep command text, so a secret must not be in it, not even base64-encoded.
const revealsSecret = (text: string, secret: string) =>
  [text, ...(text.match(/[A-Za-z0-9+/=]{12,}/gu) ?? [])]
    .map((run) => (run === text ? run : Buffer.from(run, "base64").toString("utf8")))
    .some((candidate) => candidate.includes(secret));

// The scripts run in a throwaway HOME with this machine's sh and node, as they would in a sandbox,
// with their secrets in the environment the way drivers pass them.
const runIn = (home: string, script: string | SandboxScript) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) =>
      spawner.string(
        ChildProcess.make("sh", ["-c", asScript(script).command], {
          cwd: home,
          env: { PATH: process.env.PATH, HOME: home, ...asScript(script).secrets },
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
          const script = claudeSettingsScript(endpoint(token));
          expect(revealsSecret(script.command, token)).toBe(false);
          expect(yield* runIn(home, script)).toBe("");
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

  // A sandbox that just joined the tailnet can take a few seconds to get a route to the endpoint.
  it.live("tries again before calling an endpoint unreachable", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${home}/bin`);
        yield* fs.writeFileString(
          `${home}/bin/curl`,
          `#!/bin/sh
echo x >>"$HOME/curl.calls"
[ "$(wc -l <"$HOME/curl.calls")" -ge 2 ] && printf 200 || printf 000`,
        );
        yield* fs.chmod(`${home}/bin/curl`, 0o755);
        const output = yield* runIn(
          home,
          `PATH="$HOME/bin:$PATH"\n${endpointReachScript("https://100.92.23.53")}`,
        );
        expect(parseEndpointReach(output)).toBe("reachable");
      }),
    ),
  );
});

// Stand-ins for sudo and Tailscale's binaries, so the scripts run without root. The daemon never
// gets a TUN device, which is what a container gives tailscaled. `up` returns before the node has
// registered, as when its first register request hangs past the timeout and a retry succeeds.
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
      pending="$(cat "$T3_STUB/pending" 2>/dev/null || echo 0)"
      if [ "$pending" -gt 0 ]; then
        echo $((pending - 1)) >"$T3_STUB/pending"; state=Starting; id=
      elif [ -f "$T3_STUB/up" ]; then state=Running; id=nTESTCNTRL; else state=NeedsLogin; id=; fi
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
  echo 2 >"$T3_STUB/pending"
fi`,
};

const withTailscaleStubs = <A, E, R>(
  test: (
    run: (script: string | SandboxScript) => Effect.Effect<string>,
    stub: string,
  ) => Effect.Effect<A, E, R>,
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
      const run = (script: string | SandboxScript) =>
        spawner
          .string(
            ChildProcess.make("sh", ["-c", asScript(script).command], {
              cwd: home,
              env: {
                PATH: `${bin}:${process.env.PATH}`,
                HOME: home,
                T3_STUB: stub,
                ...asScript(script).secrets,
              },
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
          const join = tailscaleScript({ authKey, hostname: "t3-sandbox-web", root });
          expect(revealsSecret(join.command, authKey)).toBe(false);
          const joined = parseTailscaleReport(yield* run(join));
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
          const restart = tailscaleScript({ hostname: "t3-sandbox-web", root });
          expect(restart.secrets).toBeUndefined();
          const resumed = parseTailscaleReport(yield* run(restart));
          expect(resumed).toMatchObject({ mode: "userspace", state: "Running" });
          expect(yield* fs.readFileString(`${stub}/starts`)).toBe(starts);

          yield* run(`set -eu\n${tailscaleScrub(root)}`);
          expect(yield* fs.readFileString(`${stub}/tailscale.argv`)).toContain("logout");
          expect(yield* fs.exists(`${root}/var/lib/tailscale`)).toBe(false);
        }),
      ),
  );
});

describe("githubLoginScript", () => {
  it.live("pipes the token from the environment to gh and keeps it out of the command", () =>
    withTailscaleStubs((run, stub) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${stub}/../bin/gh`,
          `#!/bin/sh\necho "$*" >>"$T3_STUB/gh.argv"\ncase "$*" in *--with-token*) cat >"$T3_STUB/gh.stdin" ;; esac\n`,
        );
        yield* fs.chmod(`${stub}/../bin/gh`, 0o755);
        const token = "ghp_'$(touch pwned)\"";
        const script = githubLoginScript(token);
        expect(revealsSecret(script.command, token)).toBe(false);
        yield* run(script);
        expect(yield* fs.readFileString(`${stub}/gh.stdin`)).toBe(token);
        expect(yield* fs.readFileString(`${stub}/gh.argv`)).not.toContain("ghp_");
        expect(yield* fs.exists(`${stub}/pwned`)).toBe(false);
      }),
    ),
  );
});

describe("setupScriptScript", () => {
  it.live(
    "runs the script in the clone once, reports a failure's exit code, and prints no output",
    () =>
      withHome((home) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${home}/clone`);
          const script = "echo installing; touch ran-here; echo $((count+1)) >>$HOME/count";
          const run = setupScriptScript({ script, hash: "abc123", directory: `${home}/clone` });
          expect(run.command).not.toContain("installing");
          expect(parseSetupScriptReport(yield* runIn(home, run))).toEqual({ _tag: "ran" });
          expect(yield* fs.exists(`${home}/clone/ran-here`)).toBe(true);
          // A machine that already ran this script (a template made after it) skips it.
          expect(parseSetupScriptReport(yield* runIn(home, run))).toEqual({ _tag: "skipped" });
          expect((yield* fs.readFileString(`${home}/count`)).trim()).toBe("1");

          const failing = setupScriptScript({ script: "exit 7", hash: "def456", directory: home });
          const output = yield* runIn(home, failing);
          expect(parseSetupScriptReport(output)).toEqual({ _tag: "failed", exitCode: 7 });
          // A failed script leaves no marker, so the next sandbox tries again.
          expect(yield* fs.exists(`${home}/.t3/setup-scripts/def456`)).toBe(false);
        }),
      ),
  );
});

describe("mcpServersScript", () => {
  it.live("merges servers into ~/.claude.json, and the template scrub removes only those", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${home}/.claude.json`,
          JSON.stringify({
            numStartups: 3,
            mcpServers: { mine: { type: "http", url: "https://mine.test" } },
          }),
        );
        const secret = "maple_ak_'$(touch pwned)";
        const script = mcpServersScript({
          maple: {
            type: "http",
            url: "https://api.maple.dev/mcp",
            headers: { Authorization: `Bearer ${secret}` },
          },
        });
        expect(revealsSecret(script.command, secret)).toBe(false);
        expect(yield* runIn(home, script)).toBe("");
        expect(yield* fs.exists(`${home}/pwned`)).toBe(false);
        const merged = JSON.parse(yield* fs.readFileString(`${home}/.claude.json`));
        expect(merged.numStartups).toBe(3);
        expect(Object.keys(merged.mcpServers)).toEqual(["mine", "maple"]);
        expect(merged.mcpServers.maple.headers.Authorization).toBe(`Bearer ${secret}`);

        yield* runIn(home, MCP_SERVERS_SCRUB);
        const scrubbed = JSON.parse(yield* fs.readFileString(`${home}/.claude.json`));
        expect(Object.keys(scrubbed.mcpServers)).toEqual(["mine"]);
      }),
    ),
  );
});

describe("githubAppLoginScript", () => {
  it.live("writes the token to gh's hosts.yml without putting it in the command", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const token = "ghs_installation_TOKEN";
        const script = githubAppLoginScript(token);
        expect(revealsSecret(script.command, token)).toBe(false);
        // No gh here: the file is still written, then the script says gh is missing.
        yield* runIn(home, script).pipe(Effect.ignore);
        const hosts = yield* fs.readFileString(`${home}/.config/gh/hosts.yml`);
        expect(hosts).toContain(`oauth_token: ${token}`);
        expect(hosts).toContain("user: x-access-token");
        // Marked current, so gh never tries to migrate it by asking GitHub who the token is.
        expect(yield* fs.readFileString(`${home}/.config/gh/config.yml`)).toContain("version: 1");
        expect(((yield* fs.stat(`${home}/.config/gh/hosts.yml`)).mode & 0o777).toString(8)).toBe(
          "600",
        );
      }),
    ),
  );
});

describe("railwayLoginScript", () => {
  // Only node and the system tools, so a Railway CLI on this machine can't stand in for the stub.
  const runBare = (home: string, script: string | SandboxScript) =>
    ChildProcessSpawner.ChildProcessSpawner.pipe(
      Effect.flatMap((spawner) =>
        spawner.string(
          ChildProcess.make("sh", ["-c", asScript(script).command], {
            cwd: home,
            env: {
              PATH: `${process.execPath.replace(/\/[^/]+$/u, "")}:/usr/bin:/bin`,
              HOME: home,
              ...asScript(script).secrets,
            },
            stdin: "ignore",
          }),
        ),
      ),
    );

  // npm "installs" the CLI by dropping a stub where the script looks for it, or does nothing.
  const npmStub = (home: string, installs: boolean) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${home}/.local/bin`, { recursive: true });
      yield* fs.writeFileString(
        `${home}/.local/bin/npm`,
        `#!/bin/sh\necho "$*" >"$HOME/npm.argv"\n${installs ? `printf '#!/bin/sh\\n' >"$HOME/.local/bin/railway"\nchmod 755 "$HOME/.local/bin/railway"\n` : ""}`,
      );
      yield* fs.chmod(`${home}/.local/bin/npm`, 0o755);
    });

  it.live(
    "installs the CLI, puts the token in Claude's env without printing it, and the scrubs remove it",
    () =>
      withHome((home, file) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* npmStub(home, true);
          yield* fs.makeDirectory(`${home}/.claude`);
          yield* fs.writeFileString(file, JSON.stringify({ env: { DISABLE_TELEMETRY: "1" } }));
          const token = "railway-'$(touch pwned)\"";
          const script = railwayLoginScript(token);
          expect(revealsSecret(script.command, token)).toBe(false);
          const stdout = yield* runBare(home, script);
          expect(stdout).not.toContain("railway-");
          expect(parseRailwayCli(stdout)).toBe(`${home}/.local/bin/railway`);
          expect(yield* fs.readFileString(`${home}/npm.argv`)).toBe(
            `install -g --prefix ${home}/.local @railway/cli\n`,
          );
          expect(yield* fs.exists(`${home}/pwned`)).toBe(false);
          expect(JSON.parse(yield* fs.readFileString(file)).env).toEqual({
            DISABLE_TELEMETRY: "1",
            RAILWAY_API_TOKEN: token,
          });

          // A template keeps the user's settings but no Railway sign-in of either kind.
          yield* fs.makeDirectory(`${home}/.railway`);
          yield* fs.writeFileString(`${home}/.railway/config.json`, "{}");
          yield* runIn(home, `${CLAUDE_SETTINGS_SCRUB}\n${RAILWAY_LOGIN_SCRUB}`);
          expect(JSON.parse(yield* fs.readFileString(file)).env).toEqual({
            DISABLE_TELEMETRY: "1",
          });
          expect(yield* fs.exists(`${home}/.railway`)).toBe(false);
        }),
      ),
  );

  it.live("writes nothing when the CLI will not install", () =>
    withHome((home, file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* npmStub(home, false);
        const stdout = yield* runBare(home, railwayLoginScript("railway-TOKEN"));
        expect(parseRailwayCli(stdout)).toBeNull();
        expect(yield* fs.readFileString(`${home}/npm.argv`)).toContain("@railway/cli");
        expect(yield* fs.exists(file)).toBe(false);
        expect(parseRailwayCli("T3_RAILWAY_CLI:railway\n")).toBeNull();
      }),
    ),
  );
});

describe("sandboxKeepAliveScript", () => {
  const key = "boat_keepalive_KEY'$(touch pwned)";
  const mcpToken = "t3_mcp_TOKEN";
  const extendUrl = "https://boat.dev/api/v1/sandboxes/bx_abcdefgh";

  // Stand-ins for what the official T3 Code, curl and systemd do on a sandbox. curl logs each
  // call with the headers it read from files; the MCP server answers with the statuses in
  // `threads`, or not at all when `down` exists.
  const stubs = (home: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bin = `${home}/.local/bin`;
      yield* fs.makeDirectory(bin, { recursive: true });
      const write = (name: string, text: string) =>
        fs
          .writeFileString(`${bin}/${name}`, text)
          .pipe(Effect.andThen(fs.chmod(`${bin}/${name}`, 0o755)));
      yield* write("systemd-run", `#!/bin/sh\necho "$*" >"$HOME/systemd-run.argv"\n`);
      yield* write("systemctl", "#!/bin/sh\nexit 0\n");
      yield* write(
        "t3",
        `#!/bin/sh
case "$*" in
  "auth session issue"*) echo "$*" >>"$HOME/issued.argv"; printf '{\\n  "sessionId": "mcp-session-1",\\n  "token": "${mcpToken}",\\n  "method": "bearer-access-token"\\n}\\n' ;;
  "auth session revoke"*) ;;
  "thread list"*) cat "$HOME/cli-threads" ;;
  *) exit 64 ;;
esac
`,
      );
      yield* write(
        "curl",
        `#!${process.execPath}
const fs = require("node:fs");
const home = process.env.HOME;
const args = process.argv.slice(2);
const call = { argv: args, headers: [], method: "POST" };
let out, head, format;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-o") out = args[++i];
  else if (arg === "-D") head = args[++i];
  else if (arg === "-w") format = args[++i];
  else if (arg === "-X") call.method = args[++i];
  else if (arg === "-d") call.data = args[++i];
  else if (arg === "-m") i++;
  else if (arg === "-H") {
    const value = args[++i];
    call.headers.push(...(value.startsWith("@") ? fs.readFileSync(value.slice(1), "utf8").split("\\n").filter(Boolean) : [value]));
  } else if (!arg.startsWith("-")) call.url = arg;
}
fs.appendFileSync(home + "/curl.log", JSON.stringify(call) + "\\n");
let status = 200, body = "{}";
if (call.url.endsWith("/mcp")) {
  if (fs.existsSync(home + "/down")) process.exit(7);
  const data = call.data ?? "";
  if (data.includes('"initialize"')) {
    body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
    if (head) fs.writeFileSync(head, "HTTP/1.1 200 OK\\r\\nMcp-Session-Id: sid-1\\r\\n\\r\\n");
  } else if (data.includes("tools/call")) {
    const statuses = JSON.parse(fs.readFileSync(home + "/threads", "utf8"));
    const threads = statuses.map((status, index) => ({ threadId: "thread-" + index, status }));
    body = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ threads }) }], structuredContent: { threads, total: threads.length }, isError: false } });
  } else if (data.includes("notifications/initialized")) status = 202;
}
if (out) fs.writeFileSync(out, body);
if (format) process.stdout.write(String(status));
`,
      );
    });

  const once = (home: string) =>
    runIn(home, `sh "$HOME/.t3/userdata/sandbox-keepalive/loop.sh" once`).pipe(Effect.ignore);

  const curlCalls = (home: string) =>
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.readFileString(`${home}/curl.log`)),
      Effect.orElseSucceed(() => ""),
      Effect.map((text) =>
        text
          .split("\n")
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                argv: Array<string>;
                headers: Array<string>;
                method: string;
                url: string;
                data?: string;
              },
          ),
      ),
    );

  const extends_ = (home: string) =>
    curlCalls(home).pipe(Effect.map((calls) => calls.filter((call) => call.url === extendUrl)));

  it.live(
    "installs privately under systemd and moves the auto-stop only while a thread works",
    () =>
      withHome((home) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = `${home}/.t3/userdata/sandbox-keepalive`;
          yield* stubs(home);
          const script = sandboxKeepAliveScript({
            key,
            extend: { method: "PATCH", url: extendUrl },
            ttlSeconds: 2100,
            port: 3773,
            projectRoot: "/home/boat/work/hello",
          });
          expect(revealsSecret(script.command, key)).toBe(false);
          yield* runIn(home, script);
          expect(yield* fs.exists(`${home}/pwned`)).toBe(false);
          expect(yield* fs.readFileString(`${dir}/boat-auth`)).toBe(
            `Authorization: Bearer ${key}\n`,
          );
          const mode = (path: string) =>
            fs.stat(path).pipe(Effect.map((stat) => (stat.mode & 0o777).toString(8)));
          expect(yield* mode(`${dir}/boat-auth`)).toBe("600");
          expect(yield* mode(`${dir}/config`)).toBe("600");
          expect(yield* mode(`${dir}/loop.sh`)).toBe("700");
          // A transient user unit outlives the provider's command, where systemd runs T3 itself.
          expect(yield* fs.readFileString(`${home}/systemd-run.argv`)).toBe(
            `--user --quiet --collect --unit=t3-sandbox-keepalive sh ${dir}/loop.sh run\n`,
          );

          // A subagent counts: the server is asked for every busy thread, subagents included.
          yield* fs.writeFileString(`${home}/threads`, JSON.stringify(["running"]));
          yield* once(home);
          const calls = yield* curlCalls(home);
          const listed = calls.find((call) => call.data?.includes("tools/call"));
          expect(JSON.parse(listed!.data!).params.arguments).toEqual({
            allProjects: true,
            includeSubagents: true,
            statuses: ["queued", "preparing", "starting", "running"],
            limit: 1,
          });
          expect(listed!.headers).toContain(`Authorization: Bearer ${mcpToken}`);
          expect(listed!.headers).toContain("mcp-session-id: sid-1");
          expect(yield* fs.readFileString(`${home}/issued.argv`)).toBe(
            "auth session issue --subject mcp-client --scope orchestration:read --ttl 30d --label t3-sandbox-keepalive --json\n",
          );
          expect(yield* extends_(home)).toEqual([
            expect.objectContaining({
              method: "PATCH",
              data: '{"ttlSeconds":2100}',
              headers: expect.arrayContaining([`Authorization: Bearer ${key}`]),
            }),
          ]);
          expect(yield* mode(`${dir}/mcp-auth`)).toBe("600");
          // Neither key ever shows up in a process's arguments.
          for (const call of yield* curlCalls(home)) {
            expect(call.argv.join(" ")).not.toContain("boat_keepalive_KEY");
            expect(call.argv.join(" ")).not.toContain(mcpToken);
          }

          // Idle, or waiting on the user (which the server filters out): Boat's deadline stands.
          yield* fs.writeFileString(`${home}/threads`, JSON.stringify([]));
          yield* once(home);
          expect(yield* extends_(home)).toHaveLength(1);

          // A server that ignores the filter answers with any thread; only a busy one counts, and
          // the CLI's own list decides.
          yield* fs.writeFileString(`${home}/threads`, JSON.stringify(["completed"]));
          yield* fs.writeFileString(`${home}/cli-threads`, '[{"status":"waiting"}]');
          yield* once(home);
          expect(yield* extends_(home)).toHaveLength(1);

          // Without the MCP endpoint, the CLI's list of top-level threads is the fallback.
          yield* fs.writeFileString(`${home}/down`, "");
          yield* fs.writeFileString(`${home}/cli-threads`, '[{"status":"queued"}]');
          yield* once(home);
          expect(yield* extends_(home)).toHaveLength(2);

          // A template keeps neither the loop nor the key.
          yield* runIn(home, KEEP_ALIVE_SCRUB);
          expect(yield* fs.exists(dir)).toBe(false);
        }),
      ),
  );
});
