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
