// Providers keep every command's text and output (Boat for 90 days), so the pairing token leaves the
// sandbox only sealed to a key pair this server makes for one pairing. Only the public half is in
// the command, and nothing `t3 pair` prints reaches stdout or stderr in clear.

// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no RSA key pairs.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";

export interface PairingKey {
  readonly publicKeyPem: string;
  readonly privateKey: NodeCrypto.KeyObject;
}

export const makePairingKey = Effect.callback<PairingKey>((resume) => {
  NodeCrypto.generateKeyPair("rsa", { modulusLength: 2048 }, (error, publicKey, privateKey) => {
    resume(
      error
        ? Effect.die(error)
        : Effect.succeed({
            publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString().trim(),
            privateKey,
          }),
    );
  });
});

export const OAEP = {
  padding: NodeCrypto.constants.RSA_PKCS1_OAEP_PADDING,
  oaepHash: "sha256",
} as const;

// The fallback for an image without the openssl CLI; the fork already relies on Node for Claude.
const NODE_SEAL = `const c = require("node:crypto"), f = require("node:fs");
process.stdout.write(c.publicEncrypt({ key: f.readFileSync(process.argv[1]), padding: c.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, f.readFileSync(process.argv[2])).toString("base64"));`;

/**
 * The shell both sandbox scripts start with: a private temp dir holding the public key, and
 * `seal FILE`, which leaves FILE sealed to that key in `$sealed` (one RSA block, about 190 bytes).
 */
export const sealPreamble = (publicKeyPem: string) => `export PATH="$HOME/.local/bin:$PATH"
umask 077
dir="$(mktemp -d)" || exit 1
trap 'rm -rf "$dir"' EXIT
cat >"$dir/key.pem" <<'T3_PAIR_KEY'
${publicKeyPem.trim()}
T3_PAIR_KEY
seal() {
  sealed=""
  if command -v openssl >/dev/null 2>&1; then
    sealed="$(openssl pkeyutl -encrypt -pubin -inkey "$dir/key.pem" -in "$1" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 2>/dev/null | openssl base64 -A 2>/dev/null)" || sealed=""
  fi
  if [ -z "$sealed" ] && command -v node >/dev/null 2>&1; then
    sealed="$(node -e '${NODE_SEAL}' "$dir/key.pem" "$1" 2>/dev/null)" || sealed=""
  fi
  [ -n "$sealed" ]
}`;

/**
 * Mints a 30-minute pairing token and prints only `T3_PAIR_TOKEN: <sealed>`, or `T3_PAIR_ERROR:`
 * with a reason (and, for a failed `t3 pair`, its exit status and sealed stderr tail). Exits 0.
 */
export const pairScript = (publicKeyPem: string) => `${sealPreamble(publicKeyPem)}
report() { printf 'T3_PAIR_%s: %s\\n' "$1" "$2"; }
printf 'probe' >"$dir/probe"
if ! seal "$dir/probe"; then
  report ERROR seal
  exit 0
fi
if t3 pair --ttl 30m >"$dir/out" 2>"$dir/err"; then :; else
  status=$?
  detail=""
  if [ -s "$dir/err" ]; then
    tail -c 160 "$dir/err" >"$dir/tail"
    if seal "$dir/tail"; then detail=" $sealed"; fi
  fi
  report ERROR "pair $status$detail"
  exit 0
fi
awk '$1 == "Token:" { printf "%s", $2; exit }' "$dir/out" >"$dir/token"
if [ ! -s "$dir/token" ]; then
  report ERROR token
  exit 0
fi
if seal "$dir/token"; then
  report TOKEN "$sealed"
else
  report ERROR seal
fi`;

export type PairReport =
  | { readonly _tag: "token"; readonly token: string }
  | {
      readonly _tag: "failed";
      /** `seal`: no working openssl or Node; `pair`: `t3 pair` failed; `token`: it printed none. */
      readonly reason: "seal" | "pair" | "token" | "unreadable";
      readonly exitCode?: number;
      /** The end of `t3 pair`'s stderr, for the error's cause only. */
      readonly stderr?: string;
    };

export const unseal = (sealed: string, privateKey: NodeCrypto.KeyObject): string | null => {
  try {
    return NodeCrypto.privateDecrypt(
      { key: privateKey, ...OAEP },
      Buffer.from(sealed, "base64"),
    ).toString("utf8");
  } catch {
    return null;
  }
};

export const readPairReport = (stdout: string, privateKey: NodeCrypto.KeyObject): PairReport => {
  const sealed = /^T3_PAIR_TOKEN: (\S+)\s*$/mu.exec(stdout)?.[1];
  if (sealed !== undefined) {
    const token = unseal(sealed, privateKey);
    return token !== null && /^\S{1,256}$/u.test(token)
      ? { _tag: "token", token }
      : { _tag: "failed", reason: "unreadable" };
  }
  const error = /^T3_PAIR_ERROR: (seal|pair|token)(?: (\d+))?(?: (\S+))?\s*$/mu.exec(stdout);
  if (error === null) return { _tag: "failed", reason: "unreadable" };
  const stderr = error[3] === undefined ? null : unseal(error[3], privateKey);
  return {
    _tag: "failed",
    reason: error[1] as "seal" | "pair" | "token",
    ...(error[2] === undefined ? {} : { exitCode: Number(error[2]) }),
    ...(stderr === null ? {} : { stderr }),
  };
};
