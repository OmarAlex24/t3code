import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import { bridgeCredentialScript, readBridgeCredential } from "./sandboxBridgeCredential.ts";
import { makePairingKey } from "./sandboxPairing.ts";

// Longer than one RSA-OAEP block holds, as real bearer tokens are.
// Read once outside Effect code; the stubbed shell only needs the machine's PATH.
const HOST_PATH = process.env.PATH ?? "";

const TOKEN = `t3b_${"Q7xK2m9RtW4h".repeat(30)}`;
const SESSION_ID = "session-bridge-1";
const EXPIRES_AT = "2027-11-05T10:00:00.000Z";

const ISSUE_JSON = JSON.stringify(
  {
    sessionId: SESSION_ID,
    token: TOKEN,
    method: "bearer-session-token",
    scopes: ["orchestration:read", "orchestration:operate"],
    subject: "t3-sandbox-bridge",
    client: { label: "t3-sandbox-bridge" },
    expiresAt: EXPIRES_AT,
  },
  null,
  2,
);

/** Runs the script with sh in a throwaway HOME whose `t3` is `stub`, as the pair script's tests do. */
const runMint = (stub: string, previousSessionId?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bridge-" });
    const bin = `${home}/.local/bin`;
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.writeFileString(`${bin}/t3`, `#!/bin/sh\necho "$*" >>"$HOME/calls"\n${stub}\n`);
    yield* fs.chmod(`${bin}/t3`, 0o755);
    const key = yield* makePairingKey;
    const command = bridgeCredentialScript(key.publicKeyPem, previousSessionId);
    const output = yield* spawner
      .string(
        ChildProcess.make("/bin/sh", ["-c", `exec 2>&1\n${command}`], {
          cwd: home,
          env: { PATH: HOST_PATH, HOME: home },
          stdin: "ignore",
        }),
      )
      .pipe(Effect.orDie);
    const calls = yield* fs.readFileString(`${home}/calls`).pipe(Effect.orElseSucceed(() => ""));
    return { command, output, key, calls };
  });

const inSandbox = <A, E>(
  test: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >,
) => test.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("bridgeCredentialScript", () => {
  it.live("mints a scoped, long-lived bearer and prints it only sealed", () =>
    inSandbox(
      Effect.gen(function* () {
        const { command, output, key, calls } = yield* runMint(`case "$*" in
  "auth session issue "*) cat <<'EOF'
${ISSUE_JSON}
EOF
  ;;
  *) exit 64 ;;
esac`);
        expect(command).not.toContain(TOKEN);
        expect(output).not.toContain(TOKEN.slice(0, 40));
        expect(calls.trim()).toBe(
          "auth session issue --scope orchestration:read --scope orchestration:operate --ttl 365d --label t3-sandbox-bridge --json",
        );
        expect(readBridgeCredential(output, key.privateKey)).toEqual({
          _tag: "issued",
          sessionId: SESSION_ID,
          token: TOKEN,
          expiresAt: EXPIRES_AT,
        });
        const other = yield* makePairingKey;
        expect(readBridgeCredential(output, other.privateKey)).toEqual({
          _tag: "failed",
          reason: "unreadable",
        });
      }),
    ),
  );

  it.live("revokes the bearer it replaces before minting", () =>
    inSandbox(
      Effect.gen(function* () {
        const { calls } = yield* runMint(
          `case "$*" in "auth session issue "*) cat <<'EOF'
${ISSUE_JSON}
EOF
;; esac`,
          "session-old",
        );
        expect(calls.split("\n")[0]).toBe("auth session revoke session-old");
      }),
    ),
  );

  it.live("reports a failed issue with its exit status and sealed stderr", () =>
    inSandbox(
      Effect.gen(function* () {
        const { output, key } = yield* runMint(`echo "No running T3 Code server found." >&2
exit 3`);
        const report = readBridgeCredential(output, key.privateKey);
        expect(report).toMatchObject({ _tag: "failed", reason: "issue", exitCode: 3 });
        expect(report._tag === "failed" ? report.stderr : "").toContain("No running T3 Code");
      }),
    ),
  );
});
