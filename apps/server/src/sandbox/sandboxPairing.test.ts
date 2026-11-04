import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import { makePairingKey, pairScript, readPairReport } from "./sandboxPairing.ts";

const TOKEN = "7KQ2M9XRTW4H";
const PAIR_URL = `https://sandbox.example/pair#token=${TOKEN}`;

// Shaped like `t3 pair`'s real output: a QR code of the URL, the URL, an app link, and the token.
const PAIR_OUTPUT = `Pairing with sandbox (https://sandbox.example).

█▀▀▀▀▀█ ▄▀▄ █▀▀▀▀▀█
█ ███ █ ▀▄▀ █ ███ █

Pairing URL: ${PAIR_URL}
App link: t3code://pair?url=${encodeURIComponent(PAIR_URL)}
Token: ${TOKEN}
Expires: 2026-11-04T13:30:00.000Z
`;

const SHELL_TOOLS = ["mktemp", "cat", "rm", "awk", "tail", "touch"];

const leaks = (text: string) =>
  [TOKEN, "Token:", "Pairing URL", "█", "stderr-detail"].filter((part) => text.includes(part));

/**
 * Runs the pair script with sh in a throwaway HOME whose `t3` is `stub`, and returns its stdout and
 * stderr together, as a provider keeps them. `tools` limits PATH to those commands.
 */
const runPair = (stub: string, tools?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pair-" });
    const bin = `${home}/.local/bin`;
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.writeFileString(`${bin}/t3`, `#!/bin/sh\n${stub}\n`);
    yield* fs.chmod(`${bin}/t3`, 0o755);
    const sh = (command: string, path: string) =>
      spawner
        .string(
          ChildProcess.make("/bin/sh", ["-c", `exec 2>&1\n${command}`], {
            cwd: home,
            env: { PATH: path, HOME: home },
            stdin: "ignore",
          }),
        )
        .pipe(Effect.orDie);
    let path = process.env.PATH ?? "";
    if (tools !== undefined) {
      yield* sh(
        `mkdir "$HOME/tools"
for tool in ${tools.join(" ")}; do
  found="$(command -v "$tool")" && ln -s "$found" "$HOME/tools/$tool"
done`,
        path,
      );
      path = `${home}/tools`;
    }
    const key = yield* makePairingKey;
    const command = pairScript(key.publicKeyPem);
    const output = yield* sh(command, path);
    return { command, output, key, home };
  });

const inSandbox = <A, E>(
  test: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >,
) => test.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("pairScript", () => {
  it.live("prints only the sealed token, which this server alone can read", () =>
    inSandbox(
      Effect.gen(function* () {
        const { command, output, key } = yield* runPair(`[ "$*" = "pair --ttl 30m" ] || exit 64
cat <<'EOF'
${PAIR_OUTPUT}EOF`);
        expect(command).not.toContain(TOKEN);
        expect(leaks(output)).toEqual([]);
        expect(output).toMatch(/^T3_PAIR_TOKEN: [A-Za-z0-9+/=]+\n$/u);
        expect(readPairReport(output, key.privateKey)).toEqual({ _tag: "token", token: TOKEN });
        // Another pairing's key cannot read it.
        const other = yield* makePairingKey;
        expect(readPairReport(output, other.privateKey)).toEqual({
          _tag: "failed",
          reason: "unreadable",
        });
      }),
    ),
  );

  it.live("seals a failed pair's stderr and reports its exit status", () =>
    inSandbox(
      Effect.gen(function* () {
        const { output, key } = yield* runPair(`echo "Token: ${TOKEN}"
echo "No running T3 Code server found. stderr-detail" >&2
exit 3`);
        expect(leaks(output)).toEqual([]);
        const report = readPairReport(output, key.privateKey);
        expect(report).toMatchObject({ _tag: "failed", reason: "pair", exitCode: 3 });
        expect(report._tag === "failed" ? report.stderr : "").toContain("stderr-detail");
      }),
    ),
  );

  it.live("never mints a token on an image that cannot seal one", () =>
    inSandbox(
      Effect.gen(function* () {
        const { output, key, home } = yield* runPair(
          `touch "$HOME/paired"\ncat <<'EOF'\n${PAIR_OUTPUT}EOF`,
          SHELL_TOOLS,
        );
        expect(output).toBe("T3_PAIR_ERROR: seal\n");
        expect(readPairReport(output, key.privateKey)).toEqual({ _tag: "failed", reason: "seal" });
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${home}/paired`)).toBe(false);
      }),
    ),
  );

  it.live("seals with Node where the image has no openssl", () =>
    inSandbox(
      Effect.gen(function* () {
        const { output, key } = yield* runPair(`cat <<'EOF'\n${PAIR_OUTPUT}EOF`, [
          ...SHELL_TOOLS,
          "node",
        ]);
        expect(leaks(output)).toEqual([]);
        expect(readPairReport(output, key.privateKey)).toEqual({ _tag: "token", token: TOKEN });
      }),
    ),
  );
});
