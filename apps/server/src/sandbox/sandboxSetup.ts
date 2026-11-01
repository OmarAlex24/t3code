// Scripts that set up what a sandbox gets beyond T3 Code. Secrets reach them only as base64 inside
// single quotes, so no value is ever parsed by the shell, and none of them print what they write.

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

// Merges into Claude's own settings `env`, which `claude` and T3's Claude provider both read, and
// keeps every other key (Boat ships defaults there). Node is on every supported image.
export const claudeSettingsScript = (env: {
  readonly ANTHROPIC_BASE_URL: string;
  readonly ANTHROPIC_AUTH_TOKEN: string;
}) => `set -eu
umask 077
export PATH="$HOME/.local/bin:$PATH"
dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$dir"
T3_CLAUDE_ENV='${base64(JSON.stringify(env))}' node -e '
const fs = require("node:fs");
const file = process.argv[1];
const env = JSON.parse(Buffer.from(process.env.T3_CLAUDE_ENV, "base64").toString("utf8"));
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw new Error("settings.json is not valid JSON");
}
if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
  throw new Error("settings.json is not an object");
}
const current = settings.env !== null && typeof settings.env === "object" ? settings.env : {};
settings.env = { ...current, ...env };
fs.writeFileSync(file + ".t3-tmp", JSON.stringify(settings, null, 2) + "\\n", { mode: 0o600 });
fs.renameSync(file + ".t3-tmp", file);
' "$dir/settings.json"
chmod 600 "$dir/settings.json"`;

// Run before a template save: a copy must not inherit the source's Claude token.
export const CLAUDE_SETTINGS_SCRUB = `dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if [ -f "$dir/settings.json" ] && command -v node >/dev/null 2>&1; then
  node -e '
const fs = require("node:fs");
const file = process.argv[1];
const settings = JSON.parse(fs.readFileSync(file, "utf8"));
if (settings && settings.env && typeof settings.env === "object") {
  delete settings.env.ANTHROPIC_AUTH_TOKEN;
  delete settings.env.ANTHROPIC_BASE_URL;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\\n", { mode: 0o600 });
}
' "$dir/settings.json" >/dev/null 2>&1 || true
fi`;

export const githubLoginScript = (token: string) => `set -eu
export PATH="$HOME/.local/bin:$PATH"
if ! command -v gh >/dev/null 2>&1; then
  echo "The GitHub CLI is not installed." >&2
  exit 3
fi
printf '%s' '${base64(token)}' | base64 -d | gh auth login --hostname github.com --git-protocol https --with-token
gh auth setup-git --hostname github.com`;

// Run before a template save, with the Claude scrub: a copy must not inherit the GitHub login.
export const GITHUB_LOGIN_SCRUB = `rm -f "\${GH_CONFIG_DIR:-$HOME/.config/gh}/hosts.yml"`;

const SANDBOX_TOOLS = ["git", "gh", "claude"] as const;
export type SandboxTool = (typeof SANDBOX_TOOLS)[number];

const MISSING_PREFIX = "T3_TOOLS_MISSING:";

// Installs only what the image lacks, so it is a no-op where everything ships (Boat). Always exits 0:
// a tool that will not install must not cost a working sandbox, so what is still missing is printed
// for the provisioner to report.
export const ENSURE_TOOLS_SCRIPT = `export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local/bin"
missing() {
  for tool in ${SANDBOX_TOOLS.join(" ")}; do
    command -v "$tool" >/dev/null 2>&1 || printf '%s ' "$tool"
  done
}
as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
  else
    return 1
  fi
}
if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y -q git >/dev/null 2>&1 || true
  fi
fi
if ! command -v gh >/dev/null 2>&1; then
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) arch="" ;;
  esac
  version="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest 2>/dev/null | sed 's#.*/tag/v##')"
  if [ -n "$arch" ] && [ -n "$version" ]; then
    unpacked="$(mktemp -d)"
    if curl -fsSL "https://github.com/cli/cli/releases/download/v\${version}/gh_\${version}_linux_\${arch}.tar.gz" 2>/dev/null | tar -xz -C "$unpacked" 2>/dev/null; then
      cp "$unpacked/gh_\${version}_linux_\${arch}/bin/gh" "$HOME/.local/bin/gh" 2>/dev/null && chmod 755 "$HOME/.local/bin/gh"
    fi
    rm -rf "$unpacked"
  fi
fi
if ! command -v claude >/dev/null 2>&1; then
  if command -v bash >/dev/null 2>&1; then
    curl -fsSL https://claude.ai/install.sh 2>/dev/null | bash >/dev/null 2>&1 || true
  fi
  if ! command -v claude >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || true
  fi
fi
echo "${MISSING_PREFIX} $(missing)"
exit 0`;

/** The tools still missing after `ENSURE_TOOLS_SCRIPT`, or null when it did not report. */
export const parseMissingTools = (stdout: string): ReadonlyArray<SandboxTool> | null => {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(MISSING_PREFIX));
  if (line === undefined) return null;
  const reported = new Set(line.slice(MISSING_PREFIX.length).trim().split(/\s+/u));
  return SANDBOX_TOOLS.filter((tool) => reported.has(tool));
};
