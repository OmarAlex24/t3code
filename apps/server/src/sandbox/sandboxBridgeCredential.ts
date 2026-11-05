// The sandbox bridge reaches a sandbox's T3 server with a bearer session minted there. Like the
// pairing token, it leaves the sandbox only sealed to a key this server makes for one mint; it is
// longer than one RSA block, so it travels as ordered sealed parts.

// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no RSA key pairs.
import type * as NodeCrypto from "node:crypto";

import { sealPreamble, unseal } from "./sandboxPairing.ts";

const BRIDGE_CREDENTIAL_LABEL = "t3-sandbox-bridge";
const BRIDGE_CREDENTIAL_SCOPES = ["orchestration:read", "orchestration:operate"] as const;
// The longest the CLI allows is unbounded; a year outlives any sandbox, which dies with its token.
const BRIDGE_CREDENTIAL_TTL = "365d";

const issueArgs = [
  ...BRIDGE_CREDENTIAL_SCOPES.flatMap((scope) => ["--scope", scope]),
  "--ttl",
  BRIDGE_CREDENTIAL_TTL,
  "--label",
  BRIDGE_CREDENTIAL_LABEL,
  "--json",
].join(" ");

const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

/**
 * Mints the bridge's bearer (revoking `previousSessionId` first, when given) and prints its id and
 * expiry in clear, the token only as `T3_BRIDGE_PART:` lines sealed in order, then `T3_BRIDGE_END`;
 * or `T3_BRIDGE_ERROR:` with a reason. Exits 0.
 */
export const bridgeCredentialScript = (publicKeyPem: string, previousSessionId?: string) => {
  const revoke =
    previousSessionId !== undefined && SESSION_ID.test(previousSessionId)
      ? `t3 auth session revoke ${previousSessionId} >/dev/null 2>&1 || true\n`
      : "";
  return `${sealPreamble(publicKeyPem)}
report() { printf 'T3_BRIDGE_%s: %s\\n' "$1" "$2"; }
printf 'probe' >"$dir/probe"
if ! seal "$dir/probe"; then
  report ERROR seal
  exit 0
fi
${revoke}if t3 auth session issue ${issueArgs} >"$dir/out" 2>"$dir/err"; then :; else
  status=$?
  detail=""
  if [ -s "$dir/err" ]; then
    tail -c 160 "$dir/err" >"$dir/tail"
    if seal "$dir/tail"; then detail=" $sealed"; fi
  fi
  report ERROR "issue $status$detail"
  exit 0
fi
field() { sed -n "s/^  \\"$1\\": \\"\\([^\\"]*\\)\\".*/\\1/p" "$dir/out" | head -n 1; }
session="$(field sessionId)"
expires="$(field expiresAt)"
field token | tr -d '\\n' >"$dir/token"
if [ ! -s "$dir/token" ] || [ -z "$session" ]; then
  report ERROR token
  exit 0
fi
split -b 180 "$dir/token" "$dir/part."
parts=""
for part in "$dir"/part.*; do
  if ! seal "$part"; then
    report ERROR seal
    exit 0
  fi
  parts="$parts$sealed
"
done
report SESSION "$session"
report EXPIRES "$expires"
printf '%s' "$parts" | while IFS= read -r line; do report PART "$line"; done
printf 'T3_BRIDGE_END\\n'`;
};

export type BridgeCredentialReport =
  | {
      readonly _tag: "issued";
      readonly sessionId: string;
      readonly token: string;
      readonly expiresAt: string;
    }
  | {
      readonly _tag: "failed";
      /** `seal`: no openssl or Node; `issue`: the CLI failed; `token`: it printed none. */
      readonly reason: "seal" | "issue" | "token" | "unreadable";
      readonly exitCode?: number;
      readonly stderr?: string;
    };

export const readBridgeCredential = (
  stdout: string,
  privateKey: NodeCrypto.KeyObject,
): BridgeCredentialReport => {
  const error = /^T3_BRIDGE_ERROR: (seal|issue|token)(?: (\d+))?(?: (\S+))?\s*$/mu.exec(stdout);
  if (error !== null) {
    const stderr = error[3] === undefined ? null : unseal(error[3], privateKey);
    return {
      _tag: "failed",
      reason: error[1] as "seal" | "issue" | "token",
      ...(error[2] === undefined ? {} : { exitCode: Number(error[2]) }),
      ...(stderr === null ? {} : { stderr }),
    };
  }
  const sessionId = /^T3_BRIDGE_SESSION: (\S+)\s*$/mu.exec(stdout)?.[1];
  const expiresAt = /^T3_BRIDGE_EXPIRES: (\S+)\s*$/mu.exec(stdout)?.[1];
  const sealedParts = [...stdout.matchAll(/^T3_BRIDGE_PART: (\S+)\s*$/gmu)].map(
    (match) => match[1]!,
  );
  // Without the end marker the output was cut short, and a partial token is no token.
  if (
    sessionId === undefined ||
    expiresAt === undefined ||
    sealedParts.length === 0 ||
    !/^T3_BRIDGE_END\s*$/mu.test(stdout)
  ) {
    return { _tag: "failed", reason: "unreadable" };
  }
  const parts = sealedParts.map((part) => unseal(part, privateKey));
  if (parts.some((part) => part === null)) return { _tag: "failed", reason: "unreadable" };
  const token = parts.join("");
  return /^\S{1,4096}$/u.test(token) && !Number.isNaN(Date.parse(expiresAt))
    ? { _tag: "issued", sessionId, token, expiresAt }
    : { _tag: "failed", reason: "unreadable" };
};
