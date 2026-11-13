// Scripts that set up what a sandbox gets beyond T3 Code. Secrets reach them only as environment
// variables the driver delivers outside the command text, and none of them print what they write.

import { shellQuote } from "./SandboxProvider.ts";

/** A command and the secrets it reads from its environment, for `SandboxProviderDriver.execute`. */
export interface SandboxScript {
  readonly command: string;
  readonly secrets?: Readonly<Record<string, string>>;
}

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

// Merges the JSON object in the named secret into Claude's own settings `env`, which `claude`, its
// tools and T3's Claude provider read, keeping every other key (Boat ships defaults there).
const mergeClaudeEnv = (variable: string) => `dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$dir"
node -e '
const fs = require("node:fs");
const file = process.argv[1];
const env = JSON.parse(process.env.${variable});
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

// Node is on every supported image.
export const claudeSettingsScript = (env: {
  readonly ANTHROPIC_BASE_URL: string;
  readonly ANTHROPIC_AUTH_TOKEN: string;
  readonly HTTPS_PROXY?: string;
  readonly HTTP_PROXY?: string;
  readonly NO_PROXY?: string;
}): SandboxScript => ({
  secrets: { T3_CLAUDE_ENV: JSON.stringify(env) },
  command: `set -eu
umask 077
export PATH="$HOME/.local/bin:$PATH"
${mergeClaudeEnv("T3_CLAUDE_ENV")}`,
});

/** Where tailscaled's HTTP proxy listens when the sandbox cannot create a TUN device. */
export const TAILSCALE_PROXY_URL = "http://localhost:1055";

/** What Claude needs to reach a tailnet endpoint through tailscaled's userspace proxy. */
export const tailscaleProxyEnv = {
  HTTPS_PROXY: TAILSCALE_PROXY_URL,
  HTTP_PROXY: TAILSCALE_PROXY_URL,
  NO_PROXY: "localhost,127.0.0.1,::1",
} as const;

// Run before a template save: a copy must not inherit the source's Claude token, or the proxy that
// only works while this sandbox's tailscaled runs. A proxy the user set to something else stays.
export const CLAUDE_SETTINGS_SCRUB = `dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if [ -f "$dir/settings.json" ] && command -v node >/dev/null 2>&1; then
  node -e '
const fs = require("node:fs");
const file = process.argv[1];
const settings = JSON.parse(fs.readFileSync(file, "utf8"));
if (settings && settings.env && typeof settings.env === "object") {
  delete settings.env.ANTHROPIC_AUTH_TOKEN;
  delete settings.env.ANTHROPIC_BASE_URL;
  delete settings.env.RAILWAY_API_TOKEN;
  for (const [name, value] of Object.entries(${JSON.stringify(tailscaleProxyEnv)})) {
    if (settings.env[name] === value) delete settings.env[name];
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\\n", { mode: 0o600 });
}
' "$dir/settings.json" >/dev/null 2>&1 || true
fi`;

export const githubLoginScript = (token: string): SandboxScript => ({
  secrets: { T3_GITHUB_TOKEN: token },
  command: `set -eu
export PATH="$HOME/.local/bin:$PATH"
if ! command -v gh >/dev/null 2>&1; then
  echo "The GitHub CLI is not installed." >&2
  exit 3
fi
printf '%s' "$T3_GITHUB_TOKEN" | gh auth login --hostname github.com --git-protocol https --with-token
unset T3_GITHUB_TOKEN
gh auth setup-git --hostname github.com`,
});

/**
 * Merges the host's followed settings (`sandboxSettingsSeed`) into T3's own settings.json before
 * `t3 serve`, keeping what setup wrote there, such as Pi's provider instance.
 */
export const t3SettingsSeedScript = (seed: Readonly<Record<string, unknown>>): SandboxScript => ({
  secrets: { T3_SETTINGS_SEED: JSON.stringify(seed) },
  command: `set -eu
umask 077
export PATH="$HOME/.local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  unset T3_SETTINGS_SEED
  echo "Node is not installed." >&2
  exit 3
fi
mkdir -p "$HOME/.t3/userdata"
node -e '
const fs = require("node:fs");
const file = process.argv[1];
const seed = JSON.parse(process.env.T3_SETTINGS_SEED);
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw new Error("settings.json is not valid JSON");
}
if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
  throw new Error("settings.json is not an object");
}
fs.writeFileSync(file + ".t3-tmp", JSON.stringify({ ...settings, ...seed }, null, 2) + "\\n", { mode: 0o600 });
fs.renameSync(file + ".t3-tmp", file);
' "$HOME/.t3/userdata/settings.json"
unset T3_SETTINGS_SEED`,
});

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

const ENDPOINT_STATUS_PREFIX = "T3_ENDPOINT_STATUS:";

// Any HTTP answer means the sandbox can reach the endpoint; curl prints 000 when it cannot connect.
// Through tailscaled's userspace proxy when that is how Claude reaches it.
// A sandbox that just joined the tailnet can need a few seconds for a route to the endpoint, so a
// failed connection is tried again for about half a minute before it counts as unreachable.
export const endpointReachScript = (
  baseUrl: string,
  proxy?: string,
) => `url="$(printf '%s' '${base64(baseUrl)}' | base64 -d)"
code=""
if command -v curl >/dev/null 2>&1; then
  for attempt in 1 2 3 4; do
    code="$(curl -s -m 8 ${proxy === undefined ? "" : `--proxy '${proxy}' `}-o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"
    [ "$code" != 000 ] && break
    [ "$attempt" -lt 4 ] && sleep 3
  done
fi
printf '${ENDPOINT_STATUS_PREFIX}%s\\n' "$code"
exit 0`;

/** Whether the sandbox reached the endpoint, or null when it could not tell (no curl, no report). */
export const parseEndpointReach = (stdout: string): "reachable" | "unreachable" | null => {
  const status = stdout
    .split("\n")
    .find((line) => line.startsWith(ENDPOINT_STATUS_PREFIX))
    ?.slice(ENDPOINT_STATUS_PREFIX.length)
    .trim();
  if (status === undefined || !/^\d{3}$/u.test(status)) return null;
  return status === "000" ? "unreachable" : "reachable";
};

const WORK_PREFIX = "T3_WORK:";

/**
 * Counts changed or untracked files and commits no remote has, in the thread's clone. Read-only:
 * it never fetches, so a commit counts as pushed only when a remote branch this clone saw has it.
 */
export const workCheckScript = (
  directory: string,
) => `cd ${shellQuote(directory)} 2>/dev/null || { printf '${WORK_PREFIX}none\n'; exit 0; }
files="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
commits="$(git rev-list --count HEAD --not --remotes 2>/dev/null || echo x)"
printf '${WORK_PREFIX}%s:%s\n' "$files" "$commits"
exit 0`;

/** Files and commits a delete would lose, or null when the check could not tell. */
export const parseWorkCheck = (
  stdout: string,
): { readonly files: number; readonly commits: number } | null => {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith(WORK_PREFIX))
    ?.slice(WORK_PREFIX.length)
    .trim();
  const match = line === undefined ? null : /^(\d+):(\d+)$/u.exec(line);
  return match === null ? null : { files: Number(match[1]), commits: Number(match[2]) };
};

const TAILSCALE_PREFIX = "T3_TAILSCALE_";

const AS_ROOT = `as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
  else
    return 1
  fi
}`;

// `root` prefixes every system path, so tests can run the scripts without root.
const tailscalePaths = (root: string) => ({
  run: `${root}/run/tailscale`,
  socket: `${root}/run/tailscale/tailscaled.sock`,
  pidFile: `${root}/run/tailscale/t3-tailscaled.pid`,
  state: `${root}/var/lib/tailscale`,
  defaults: `${root}/etc/default/tailscaled`,
  logDir: `${root}/var/log`,
  log: `${root}/var/log/t3-tailscaled.log`,
});

// Stops a tailscaled T3 started under nohup, by the PID it recorded and only if that is tailscaled.
const stopNohupTailscaled = (paths: ReturnType<typeof tailscalePaths>) => `{
  pid="$(as_root cat ${paths.pidFile} 2>/dev/null || true)"
  if [ -n "$pid" ] && tr '\\000' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q tailscaled; then
    as_root kill "$pid" >/dev/null 2>&1 || true
  fi
  as_root rm -f ${paths.pidFile} >/dev/null 2>&1 || true
}`;

// Installs Tailscale when missing, starts tailscaled (systemd where it is PID 1, else nohup), and
// joins with the key passed as a 0600 file, never an argument (printf is a shell builtin). Kernel TUN first; without one,
// userspace with a local HTTP proxy for Claude. Exits 0 and reports `T3_TAILSCALE_*` lines.
export const tailscaleScript = (options: {
  readonly authKey?: string;
  readonly hostname: string;
  readonly root?: string;
}): SandboxScript => {
  const paths = tailscalePaths(options.root ?? "");
  const join =
    options.authKey === undefined
      ? ""
      : `key_file="$(mktemp)"
chmod 600 "$key_file"
trap 'rm -f "$key_file"' EXIT
printf '%s' "$T3_TAILSCALE_AUTH_KEY" >"$key_file"
unset T3_TAILSCALE_AUTH_KEY
ts up --auth-key="file:$key_file" --hostname=${shellQuote(options.hostname)} --accept-dns=false --reset --timeout=60s >/dev/null 2>&1 || true
rm -f "$key_file"
# A register request can hang past up's timeout and then succeed on tailscaled's own retry.
i=0
while [ "$i" -lt 90 ] && [ "$(backend)" != Running ]; do
  i=$((i + 1))
  sleep 1
done
`;
  const command = `export PATH="$HOME/.local/bin:$PATH:/usr/local/sbin:/usr/sbin:/sbin"
${AS_ROOT}
report() { printf '${TAILSCALE_PREFIX}%s: %s\\n' "$1" "$2"; }
if ! as_root true; then
  report ERROR root
  exit 0
fi
if ! command -v tailscaled >/dev/null 2>&1; then
  mkdir -p "$HOME/.t3"
  installer="$(mktemp)"
  if curl -fsSL -o "$installer" https://tailscale.com/install.sh >/dev/null 2>&1; then
    as_root sh "$installer" >"$HOME/.t3/tailscale-install.log" 2>&1 || true
  fi
  rm -f "$installer"
fi
if ! command -v tailscaled >/dev/null 2>&1 || ! command -v tailscale >/dev/null 2>&1; then
  report ERROR install
  exit 0
fi
ts() { as_root tailscale --socket=${paths.socket} "$@"; }
status_json() { ts status --json --peers=false 2>/dev/null; }
backend() {
  status_json | sed -n 's/^ *"BackendState": *"\\([^"]*\\)".*/\\1/p' | head -n 1
}
answering() { [ -n "$(backend)" ]; }
# tailscaled says whether it got a TUN device, whatever it was started with.
has_tun() { status_json | grep -q '"TUN": *true'; }
wait_answering() {
  i=0
  while [ "$i" -lt 15 ]; do
    if answering; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}
uses_systemd() {
  [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && systemctl cat tailscaled >/dev/null 2>&1
}
start() {
  flags=""
  if [ "$1" = userspace ]; then
    flags="--tun=userspace-networking --outbound-http-proxy-listen=localhost:1055"
  fi
  if uses_systemd; then
    printf 'PORT="41641"\\nFLAGS="%s"\\n' "$flags" | as_root tee ${paths.defaults} >/dev/null
    as_root systemctl enable tailscaled >/dev/null 2>&1 || true
    as_root systemctl restart tailscaled >/dev/null 2>&1 || true
  else
    ${stopNohupTailscaled(paths).replaceAll("\n", "\n    ")}
    as_root mkdir -p ${paths.state} ${paths.run} ${paths.logDir}
    # Vercel's eth0 has only link-local addresses, which tailscaled reads as offline and pauses.
    as_root sh -c "nohup env TS_ASSUME_NETWORK_UP_FOR_TEST=1 tailscaled --state=${paths.state}/tailscaled.state --socket=${paths.socket} $flags >${paths.log} 2>&1 &
echo \\$! >${paths.pidFile}"
  fi
  wait_answering
}
stop() {
  if uses_systemd; then
    as_root systemctl stop tailscaled >/dev/null 2>&1 || true
  else
    ${stopNohupTailscaled(paths).replaceAll("\n", "\n    ")}
  fi
}
recorded="$(as_root cat ${paths.state}/t3-mode 2>/dev/null || true)"
mode=""
if answering; then
  if has_tun; then
    mode=kernel
  elif [ "$recorded" = userspace ]; then
    mode=userspace
  fi
fi
if [ -z "$mode" ]; then
  if [ -c /dev/net/tun ] && start kernel && has_tun; then
    mode=kernel
  else
    stop
    if start userspace; then mode=userspace; fi
  fi
  if [ -n "$mode" ]; then
    as_root mkdir -p ${paths.state}
    printf '%s\\n' "$mode" | as_root tee ${paths.state}/t3-mode >/dev/null
  fi
fi
if [ -z "$mode" ]; then
  report ERROR start
  exit 0
fi
if uses_systemd && systemctl is-active --quiet tailscaled; then
  report DAEMON systemd
else
  report DAEMON nohup
fi
report MODE "$mode"
${join}report STATE "$(backend)"
report NODE "$(status_json | sed -n 's/^ *"ID": *"\\([^"]*\\)".*/\\1/p' | head -n 1)"
report IP "$(ts ip -4 2>/dev/null | head -n 1)"
exit 0`;
  return options.authKey === undefined
    ? { command }
    : { command, secrets: { T3_TAILSCALE_AUTH_KEY: options.authKey } };
};

export interface TailscaleReport {
  /** Why nothing could be checked: no root, no install, or a daemon that would not start. */
  readonly error?: "root" | "install" | "start";
  readonly mode?: "kernel" | "userspace";
  readonly daemon?: "systemd" | "nohup";
  /** tailscaled's BackendState: `Running` once joined, `NeedsLogin` without a key. */
  readonly state?: string;
  /** The node's stable id, which the Tailscale API accepts as the device id. */
  readonly nodeId?: string;
  /** The node's tailnet IPv4 address, where a tailnet-only sandbox serves T3. */
  readonly ip?: string;
}

/** What `tailscaleScript` reported, or null when it printed nothing T3 recognizes. */
export const parseTailscaleReport = (stdout: string): TailscaleReport | null => {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^T3_TAILSCALE_([A-Z]+): ?(.*)$/u.exec(line.trim());
    if (match !== null) values.set(match[1]!, match[2]!.trim());
  }
  if (values.size === 0) return null;
  const pick = <T extends string>(key: string, allowed: ReadonlyArray<T>) => {
    const value = values.get(key);
    return allowed.find((candidate) => candidate === value);
  };
  const error = pick("ERROR", ["root", "install", "start"] as const);
  const mode = pick("MODE", ["kernel", "userspace"] as const);
  const daemon = pick("DAEMON", ["systemd", "nohup"] as const);
  const state = values.get("STATE") || undefined;
  const nodeId = values.get("NODE") || undefined;
  const ip = /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(values.get("IP") ?? "")
    ? values.get("IP")
    : undefined;
  return {
    ...(error === undefined ? {} : { error }),
    ...(mode === undefined ? {} : { mode }),
    ...(daemon === undefined ? {} : { daemon }),
    ...(state === undefined ? {} : { state }),
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(ip === undefined ? {} : { ip }),
  };
};

// Run before a template save, with the other scrubs: logging out removes the node at once, and the
// state goes so a copy starts without one. The binary stays, so a copy that joins skips the install.
export const tailscaleScrub = (root = "") => {
  const paths = tailscalePaths(root);
  return `${AS_ROOT}
if command -v tailscale >/dev/null 2>&1; then
  as_root tailscale --socket=${paths.socket} logout >/dev/null 2>&1 || true
  if command -v systemctl >/dev/null 2>&1; then
    as_root systemctl disable --now tailscaled >/dev/null 2>&1 || true
  fi
  ${stopNohupTailscaled(paths).replaceAll("\n", "\n  ")}
  as_root rm -rf ${paths.state} >/dev/null 2>&1 || true
fi`;
};

const REPO_PREFIX = "T3_REPO_";

/**
 * Clones the project into `~/work/<directory>` and registers it with the running T3 server. A
 * retry starts from a fresh clone, and a project an earlier attempt registered is replaced, since
 * nothing has run in it yet. The clone URL never carries a credential: `gh auth setup-git` from the
 * credentials step answers for private repositories.
 */
export const repositoryScript = (input: {
  readonly cloneUrl: string;
  readonly directory: string;
  readonly title: string;
  readonly branch?: string | undefined;
}) => `set -eu
export PATH="$HOME/.local/bin:$PATH"
dir="$HOME/work/${input.directory}"
mkdir -p "$HOME/work"
rm -rf "$dir"
GIT_TERMINAL_PROMPT=0 git clone --quiet${input.branch === undefined ? "" : ` --branch ${shellQuote(input.branch)}`} -- ${shellQuote(input.cloneUrl)} "$dir"
printf '${REPO_PREFIX}DIR: %s\\n' "$dir"
if ! added="$(t3 project add "$dir" --title ${shellQuote(input.title)} 2>&1)"; then
  t3 project remove "$dir" >/dev/null 2>&1 || true
  added="$(t3 project add "$dir" --title ${shellQuote(input.title)} 2>&1)"
fi
printf '%s\\n' "$added" | sed -n 's/^Added project \\([^ ]*\\) .*/${REPO_PREFIX}PROJECT: \\1/p'`;

/** The clone's directory and the project id `t3 project add` printed, or null for either. */
export const parseRepositoryReport = (stdout: string) => {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^T3_REPO_([A-Z]+): (.+)$/u.exec(line.trim());
    if (match !== null) values.set(match[1]!, match[2]!.trim());
  }
  return { directory: values.get("DIR") ?? null, projectId: values.get("PROJECT") ?? null };
};

/**
 * Writes a file whose content must not appear in command text, for drivers without a files API.
 * The content travels base64-encoded in `secrets`, which every driver keeps out of the command.
 */
export const writeFileScript = (path: string, content: string): SandboxScript => ({
  secrets: { T3_FILE_CONTENT: base64(content) },
  command: `set -eu
umask 077
mkdir -p "$(dirname -- ${shellQuote(path)})"
printf '%s' "$T3_FILE_CONTENT" | base64 -d >${shellQuote(path)}
unset T3_FILE_CONTENT`,
});

/** Sets git's global name and email, so the agent can commit as the user. */
export const gitIdentityScript = (identity: { readonly name: string; readonly email: string }) =>
  `set -eu
export PATH="$HOME/.local/bin:$PATH"
git config --global user.name ${shellQuote(identity.name)}
git config --global user.email ${shellQuote(identity.email)}`;

// gh reads a token kept in hosts.yml and never asks GitHub who it belongs to, which an installation
// token could not answer. Rewriting the file is also how a fresh token replaces an expired one.
export const githubAppLoginScript = (token: string): SandboxScript => ({
  secrets: { T3_GITHUB_TOKEN: token },
  command: `set -eu
umask 077
export PATH="$HOME/.local/bin:$PATH"
dir="\${GH_CONFIG_DIR:-$HOME/.config/gh}"
mkdir -p "$dir"
printf 'github.com:\\n    users:\\n        x-access-token:\\n            oauth_token: %s\\n    oauth_token: %s\\n    git_protocol: https\\n    user: x-access-token\\n' "$T3_GITHUB_TOKEN" "$T3_GITHUB_TOKEN" >"$dir/hosts.yml.t3-tmp"
unset T3_GITHUB_TOKEN
mv "$dir/hosts.yml.t3-tmp" "$dir/hosts.yml"
# Without a version, gh "migrates" hosts.yml by asking GitHub who the token is, which fails.
grep -qs '^version:' "$dir/config.yml" || printf '\nversion: 1\n' >>"$dir/config.yml"
if ! command -v gh >/dev/null 2>&1; then
  echo "The GitHub CLI is not installed." >&2
  exit 3
fi
gh auth setup-git --hostname github.com`,
});

const SETUP_PREFIX = "T3_SETUP:";

/**
 * Runs the config's setup script in the clone once per machine: a marker named by the script's
 * hash makes a sandbox from a template that already ran it skip it. Prints how it went and never
 * the script's own output, which can carry anything the script touched.
 */
export const setupScriptScript = (input: {
  readonly script: string;
  readonly hash: string;
  readonly directory: string;
}): SandboxScript => ({
  secrets: { T3_SETUP_SCRIPT: base64(input.script) },
  command: `export PATH="$HOME/.local/bin:$PATH"
marker="$HOME/.t3/setup-scripts/${input.hash}"
if [ -f "$marker" ]; then
  unset T3_SETUP_SCRIPT
  printf '${SETUP_PREFIX}skipped\\n'
  exit 0
fi
mkdir -p "$HOME/.t3/setup-scripts"
script="$(mktemp)"
printf '%s' "$T3_SETUP_SCRIPT" | base64 -d >"$script"
unset T3_SETUP_SCRIPT
cd ${shellQuote(input.directory)} 2>/dev/null || cd "$HOME"
status=0
bash "$script" >"$HOME/.t3/setup-script.log" 2>&1 </dev/null || status=$?
rm -f "$script"
if [ "$status" -eq 0 ]; then
  : >"$marker"
  printf '${SETUP_PREFIX}ran\\n'
else
  printf '${SETUP_PREFIX}failed %s\\n' "$status"
fi
exit 0`,
});

export type SetupScriptReport =
  | { readonly _tag: "ran" }
  | { readonly _tag: "skipped" }
  | { readonly _tag: "failed"; readonly exitCode: number };

/** How the setup script went, or null when it printed nothing T3 recognizes. */
export const parseSetupScriptReport = (stdout: string): SetupScriptReport | null => {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith(SETUP_PREFIX))
    ?.slice(SETUP_PREFIX.length)
    .trim();
  if (line === "ran" || line === "skipped") return { _tag: line };
  const failed = line === undefined ? null : /^failed (\d+)$/u.exec(line);
  return failed === null ? null : { _tag: "failed", exitCode: Number(failed[1]) };
};

// Names of the MCP servers T3 wrote, so a template save removes exactly those (their headers).
const MCP_WRITTEN = `"$HOME/.t3/mcp-servers.json"`;

/**
 * Merges MCP servers into the user-scope list of Claude's ~/.claude.json, keeping everything else.
 * Header values ride in `secrets`, never in the command.
 */
export const mcpServersScript = (servers: Readonly<Record<string, unknown>>): SandboxScript => ({
  secrets: { T3_MCP_SERVERS: JSON.stringify(servers) },
  command: `set -eu
umask 077
export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.t3"
file="\${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
node -e '
const fs = require("node:fs");
const [file, written] = process.argv.slice(1);
const servers = JSON.parse(process.env.T3_MCP_SERVERS);
let config = {};
try {
  config = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw new Error(".claude.json is not valid JSON");
}
if (config === null || typeof config !== "object" || Array.isArray(config)) {
  throw new Error(".claude.json is not an object");
}
const current = config.mcpServers !== null && typeof config.mcpServers === "object" ? config.mcpServers : {};
config.mcpServers = { ...current, ...servers };
fs.writeFileSync(file + ".t3-tmp", JSON.stringify(config, null, 2) + "\\n", { mode: 0o600 });
fs.renameSync(file + ".t3-tmp", file);
let names = [];
try { names = JSON.parse(fs.readFileSync(written, "utf8")); } catch {}
fs.writeFileSync(written, JSON.stringify([...new Set([...names, ...Object.keys(servers)])]) + "\\n", { mode: 0o600 });
' "$file" ${MCP_WRITTEN}
unset T3_MCP_SERVERS`,
});

// Run before a template save: the MCP servers T3 copied carry header values from this machine.
export const MCP_SERVERS_SCRUB = `file="\${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
if [ -f ${MCP_WRITTEN} ] && [ -f "$file" ] && command -v node >/dev/null 2>&1; then
  node -e '
const fs = require("node:fs");
const [file, written] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(file, "utf8"));
for (const name of JSON.parse(fs.readFileSync(written, "utf8"))) delete config.mcpServers?.[name];
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\\n", { mode: 0o600 });
' "$file" ${MCP_WRITTEN} >/dev/null 2>&1 || true
fi
rm -f ${MCP_WRITTEN}`;

// The CLI keeps the token in its own config, so a failed install or login leaves nothing behind.
export const northflankLoginScript = (token: string): SandboxScript => ({
  secrets: { T3_NORTHFLANK_TOKEN: token },
  command: `set -eu
export PATH="$HOME/.local/bin:$PATH"
if ! command -v northflank >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  npm install -g --prefix "$HOME/.local" @northflank/cli >/dev/null 2>&1 || true
fi
if ! command -v northflank >/dev/null 2>&1; then
  unset T3_NORTHFLANK_TOKEN
  echo "The Northflank CLI could not be installed." >&2
  exit 3
fi
umask 077
northflank login -n t3-sandbox -t "$T3_NORTHFLANK_TOKEN" >/dev/null 2>&1
unset T3_NORTHFLANK_TOKEN`,
});

// Run before a template save: a copy must not inherit the Northflank login.
export const NORTHFLANK_LOGIN_SCRUB = `rm -rf "\${NF_CONFIG_DIR:-$HOME/.northflank}"`;

const RAILWAY_CLI_PREFIX = "T3_RAILWAY_CLI:";

// The CLI reads RAILWAY_API_TOKEN before its own login, never refreshes it, and Claude hands its
// settings env to every tool it runs. Nothing is written when the CLI will not install.
export const railwayLoginScript = (token: string): SandboxScript => ({
  secrets: { T3_RAILWAY_ENV: JSON.stringify({ RAILWAY_API_TOKEN: token }) },
  command: `set -eu
export PATH="$HOME/.local/bin:$PATH"
if ! command -v railway >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  npm install -g --prefix "$HOME/.local" @railway/cli >/dev/null 2>&1 || true
fi
if ! command -v railway >/dev/null 2>&1; then
  unset T3_RAILWAY_ENV
  echo "The Railway CLI could not be installed." >&2
  exit 3
fi
umask 077
${mergeClaudeEnv("T3_RAILWAY_ENV")}
unset T3_RAILWAY_ENV
printf '${RAILWAY_CLI_PREFIX}%s\\n' "$(command -v railway)"`,
});

/** Where the Railway CLI is on the sandbox, for the MCP entry; null when the script did not say. */
export const parseRailwayCli = (stdout: string): string | null => {
  const path = stdout
    .split("\n")
    .find((line) => line.startsWith(RAILWAY_CLI_PREFIX))
    ?.slice(RAILWAY_CLI_PREFIX.length)
    .trim();
  return path === undefined || !path.startsWith("/") ? null : path;
};

// Run before a template save, with the Claude scrub that drops RAILWAY_API_TOKEN: a login an agent
// made with \`railway login\` lives here.
export const RAILWAY_LOGIN_SCRUB = `rm -rf "$HOME/.railway"`;

const KEEP_ALIVE_DIR = `$HOME/.t3/userdata/sandbox-keepalive`;
/** How often the sandbox checks for work; the provider's deadline is the idle window past a check. */
export const KEEP_ALIVE_INTERVAL_SECONDS = 300;

// A thread in one of these is working; `waiting` waits on the user, so it counts as idle.
const BUSY_STATUSES = ["queued", "preparing", "starting", "running"] as const;

// A check extends when a thread is busy or was updated since the last check, so a short turn
// between two checks counts. The official server's MCP endpoint, through an `mcp-client` session
// the CLI mints, sees subagents; `t3 thread list` does not and is the fallback. With neither, the
// running limit applies. Tokens go in `curl -H @file`, never in argv.
const keepAliveLoop = (port: number) => `#!/bin/sh
dir="${KEEP_ALIVE_DIR}"
export PATH="$HOME/.local/bin:$PATH"
umask 077
origin="http://127.0.0.1:${port}"
loop_pid() {
  pid="$(cat "$dir/pid" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null &&
    tr '\\000' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'sandbox-keepalive/loop.sh run' &&
    printf '%s' "$pid"
}
note() {
  printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$dir/log"
  tail -n 100 "$dir/log" >"$dir/log.tmp" 2>/dev/null && mv "$dir/log.tmp" "$dir/log"
}
mint_session() {
  old="$(cat "$dir/mcp-session" 2>/dev/null || true)"
  if [ -n "$old" ]; then t3 auth session revoke "$old" >/dev/null 2>&1 || true; fi
  rm -f "$dir/mcp-auth" "$dir/mcp-session"
  t3 auth session issue --subject mcp-client --scope orchestration:read --ttl 30d \\
    --label t3-sandbox-keepalive --json >"$dir/issued" 2>/dev/null || { rm -f "$dir/issued"; return 1; }
  token="$(sed -n 's/^  "token": "\\([^"]*\\)".*/\\1/p' "$dir/issued" | head -n 1)"
  sed -n 's/^  "sessionId": "\\([^"]*\\)".*/\\1/p' "$dir/issued" | head -n 1 >"$dir/mcp-session"
  rm -f "$dir/issued"
  [ -n "$token" ] || return 1
  printf 'Authorization: Bearer %s\\n' "$token" >"$dir/mcp-auth"
}
mcp() {
  curl -sS -m 30 -o "$dir/out" -D "$dir/head" -w '%{http_code}' -H @"$dir/mcp-auth" -H @"$dir/mcp-headers" \\
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\
    -d "$1" "$origin/mcp" 2>/dev/null
}
listed() { [ "$1" = 200 ] && grep -q '"isError":false' "$dir/out"; }
# Whether a thread in $dir/out was updated at or after the last check, both in UTC seconds.
worked_since() {
  since="$(cat "$dir/last-check" 2>/dev/null || true)"
  case "$since" in ''|*[!0-9]*) return 1 ;; esac
  newest="$(grep -o '"updatedAt":"[^"]*"' "$dir/out" | cut -d'"' -f4 | cut -c1-19 | tr -d 'T:-' | sort | tail -n 1)"
  case "$newest" in ''|*[!0-9]*) return 1 ;; esac
  [ "$newest" -ge "$since" ]
}
# Prints busy, active or idle, or fails when the server cannot say.
mcp_ask() {
  listed "$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"t3_thread_list","arguments":{"allProjects":true,"includeSubagents":true,"statuses":${JSON.stringify(BUSY_STATUSES)},"limit":1}}}')" || return 1
  if ! grep -q '"threads":\\[\\]' "$dir/out"; then
    # A server that ignores the status filter answers with any thread; only a busy one counts.
    first="$(grep -o '"status":"[a-z_]*"' "$dir/out" | head -n 1 | cut -d'"' -f4)"
    case "$first" in ${BUSY_STATUSES.join("|")}) echo busy; return 0 ;; *) return 1 ;; esac
  fi
  # The server lists threads newest-updated first.
  listed "$(mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"t3_thread_list","arguments":{"allProjects":true,"includeSubagents":true,"limit":1}}}')" || return 1
  if worked_since; then echo active; else echo idle; fi
}
mcp_state() {
  [ -s "$dir/mcp-auth" ] || mint_session || return 1
  : >"$dir/mcp-headers"
  init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t3-sandbox-keepalive","version":"1"}}}'
  code="$(mcp "$init")"
  if [ "$code" = 401 ]; then
    mint_session || return 1
    code="$(mcp "$init")"
  fi
  [ "$code" = 200 ] || return 1
  sid="$(sed -n 's/^[Mm][Cc][Pp]-[Ss][Ee][Ss][Ss][Ii][Oo][Nn]-[Ii][Dd]: *\\([^[:space:]]*\\).*/\\1/p' "$dir/head" | head -n 1)"
  version="$(grep -o '"protocolVersion":"[^"]*"' "$dir/out" | head -n 1 | cut -d'"' -f4)"
  printf 'mcp-session-id: %s\\nmcp-protocol-version: %s\\n' "$sid" "\${version:-2025-06-18}" >"$dir/mcp-headers"
  mcp '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
  state="$(mcp_ask)" || state=""
  [ -n "$sid" ] && curl -sS -m 10 -o /dev/null -X DELETE -H @"$dir/mcp-auth" -H @"$dir/mcp-headers" "$origin/mcp" >/dev/null 2>&1
  [ -n "$state" ] && echo "$state"
}
cli_state() {
  [ -n "\${PROJECT_ROOT:-}" ] || return 1
  t3 thread list --project "$PROJECT_ROOT" --json >"$dir/out" 2>/dev/null || return 1
  if grep -Eq '"status":"(${BUSY_STATUSES.join("|")})"' "$dir/out"; then echo busy
  elif worked_since; then echo active
  else echo idle; fi
}
extend() {
  curl -sS -m 30 -o /dev/null -w '%{http_code}' -X "$EXTEND_METHOD" -H @"$dir/boat-auth" \\
    -H 'content-type: application/json' -d "{\\"ttlSeconds\\":$TTL_SECONDS}" "$EXTEND_URL" 2>/dev/null
}
# Whether this loop, which starts with T3 on every resume, has run less than the running limit.
within_running_limit() {
  started="$(cat "$dir/started" 2>/dev/null || true)"
  case "$started" in ''|*[!0-9]*) return 1 ;; esac
  [ "$(( $(date +%s) - started ))" -lt "$(( \${MAX_RUNNING_MINUTES:-0} * 60 ))" ]
}
tick() {
  [ -s "$dir/boat-auth" ] && [ -s "$dir/config" ] || return 1
  . "$dir/config"
  now="$(date -u +%Y%m%d%H%M%S)"
  state="$(mcp_state || cli_state || echo unknown)"
  rm -f "$dir/out" "$dir/head"
  # A T3 that answers neither way (a changed CLI, say) must not stop a sandbox that may be working,
  # so it stays up as it would have before keep-alive: until the running limit.
  if [ "$state" = unknown ]; then
    if within_running_limit; then note "unknown extend $(extend)"; else note unknown; fi
    return 0
  fi
  if [ "$state" = idle ]; then
    note idle
    echo "$now" >"$dir/last-check"
    return 0
  fi
  code="$(extend)"
  note "$state extend $code"
  # A failed extend leaves the last check where it was, so the next one tries again.
  case "$code" in 2??) echo "$now" >"$dir/last-check" ;; esac
}
case "\${1:-}" in
start)
  [ -n "$(loop_pid)" ] && exit 0
  # A transient user unit outlives the command that starts it where systemd runs T3 itself.
  if command -v systemd-run >/dev/null 2>&1; then
    [ -n "\${XDG_RUNTIME_DIR:-}" ] || export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    # Started a moment ago and not yet at its pidfile.
    systemctl --user is-active --quiet t3-sandbox-keepalive.service 2>/dev/null && exit 0
    systemctl --user reset-failed t3-sandbox-keepalive.service >/dev/null 2>&1 || true
    if systemd-run --user --quiet --collect --unit=t3-sandbox-keepalive sh "$dir/loop.sh" run >/dev/null 2>&1; then
      exit 0
    fi
  fi
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid sh "$dir/loop.sh" run >/dev/null 2>&1 &
  else
    nohup sh "$dir/loop.sh" run >/dev/null 2>&1 &
  fi
  ;;
stop)
  pid="$(loop_pid)"
  systemctl --user stop t3-sandbox-keepalive.service >/dev/null 2>&1 || true
  [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  ;;
once) tick ;;
run)
  other="$(loop_pid)"
  [ -n "$other" ] && [ "$other" != "$$" ] && exit 0
  echo "$$" >"$dir/pid"
  date +%s >"$dir/started"
  date -u +%Y%m%d%H%M%S >"$dir/last-check"
  while tick; do sleep "\${INTERVAL_SECONDS:-${KEEP_ALIVE_INTERVAL_SECONDS}}"; done
  ;;
*) exit 64 ;;
esac
`;

// Written on every install and every start of T3, so a sandbox picks up a newer loop when it resumes.
const writeKeepAliveLoop = (port: number, orElse: string) =>
  `cat >"${KEEP_ALIVE_DIR}/loop.sh.tmp" <<'T3_KEEPALIVE_LOOP' && chmod 700 "${KEEP_ALIVE_DIR}/loop.sh.tmp" && mv "${KEEP_ALIVE_DIR}/loop.sh.tmp" "${KEEP_ALIVE_DIR}/loop.sh" || ${orElse}
${keepAliveLoop(port)}T3_KEEPALIVE_LOOP`;

/**
 * Writes the keep-alive's key, settings, and loop under T3's userdata, then starts the loop. The
 * key arrives in `secrets` and lands only in a header file; `startScript` starts the loop again
 * on every resume, and starting it twice is a no-op.
 */
export const sandboxKeepAliveScript = (input: {
  readonly key: string;
  readonly extend: { readonly method: string; readonly url: string };
  readonly ttlSeconds: number;
  /** How long the loop keeps the sandbox up after a start while it cannot tell whether work runs. */
  readonly maxRunningMinutes: number;
  readonly port: number;
  readonly projectRoot?: string | undefined;
}): SandboxScript => ({
  secrets: { T3_KEEPALIVE_KEY: input.key },
  command: `set -eu
umask 077
dir="${KEEP_ALIVE_DIR}"
mkdir -p "$dir"
printf 'Authorization: Bearer %s\\n' "$T3_KEEPALIVE_KEY" >"$dir/boat-auth.tmp"
unset T3_KEEPALIVE_KEY
mv "$dir/boat-auth.tmp" "$dir/boat-auth"
cat >"$dir/config.tmp" <<'T3_KEEPALIVE_CONFIG'
EXTEND_METHOD=${shellQuote(input.extend.method)}
EXTEND_URL=${shellQuote(input.extend.url)}
TTL_SECONDS=${Math.max(60, Math.round(input.ttlSeconds))}
MAX_RUNNING_MINUTES=${Math.max(0, Math.round(input.maxRunningMinutes))}
PROJECT_ROOT=${shellQuote(input.projectRoot ?? "")}
T3_KEEPALIVE_CONFIG
mv "$dir/config.tmp" "$dir/config"
${writeKeepAliveLoop(input.port, "exit 1")}
sh "$dir/loop.sh" start`,
});

/** Updates and starts the keep-alive loop when it is installed; part of every start of T3 on the sandbox. */
export const keepAliveStart = (port: number) => `if [ -f "${KEEP_ALIVE_DIR}/loop.sh" ]; then
${writeKeepAliveLoop(port, "true")}
  sh "${KEEP_ALIVE_DIR}/loop.sh" start >/dev/null 2>&1 || true
fi`;

// Run before a template save, before T3's userdata (and the key in it) is removed.
export const KEEP_ALIVE_SCRUB = `if [ -f "${KEEP_ALIVE_DIR}/loop.sh" ]; then
  sh "${KEEP_ALIVE_DIR}/loop.sh" stop >/dev/null 2>&1 || true
fi
rm -rf "${KEEP_ALIVE_DIR}"`;

/** The skill every sandbox's Claude gets from T3 Code, named so it never replaces one of the user's. */
export const SANDBOX_FILES_SKILL_NAME = "t3-sandbox-files";

const SANDBOX_LIFETIME =
  "It stops when idle (emptying /tmp) and is deleted when its chat ends. Nothing on it outlives that.";

/**
 * What every agent on a sandbox always has in its global instructions. The skill is loaded only
 * when Claude decides to, and no other provider gets it, so the facts that lose work live here.
 */
export const SANDBOX_AGENT_INSTRUCTIONS = `## This machine is a disposable sandbox
- ${SANDBOX_LIFETIME}
- Anything the user needs (handoffs, summaries, plans, findings) goes in your reply, never only in a file.
- Deliver code by committing and pushing a branch. Uncommitted work is lost with the machine.
- Don't commit scratch notes or handoff files, and don't cite local paths as deliverables.
`;

export const SANDBOX_INSTRUCTIONS_START = "<!-- t3code:sandbox-instructions:start -->";
export const SANDBOX_INSTRUCTIONS_END = "<!-- t3code:sandbox-instructions:end -->";

/**
 * Tells agents on a sandbox to keep what they need later out of `/tmp`, which a stop empties. The
 * description is what makes Claude load it, so it names every moment an agent reaches for `/tmp`.
 */
export const SANDBOX_FILES_SKILL = `---
name: ${SANDBOX_FILES_SKILL_NAME}
description: Where to save files on this T3 Code sandbox, whose /tmp is wiped every time the sandbox stops and which is deleted when its chat ends. Use before writing anything that must still exist later (screenshots or images you embed in a reply, logs you will point the user to, downloads, PR or doc drafts, extra git worktrees, build artifacts), and whenever you would reach for /tmp or $TMPDIR.
---

# Files on a sandbox

This machine is a T3 Code sandbox. ${SANDBOX_LIFETIME} It also stops at its running limit or when the user stops it. Resuming it boots the machine again, and the boot empties \`/tmp\`. Until the chat ends, everything under \`$HOME\` survives a stop, including the project under \`~/work\`, \`~/.t3\` and \`~/.claude\`.

## Rules

- **Never put anything in \`/tmp\` that someone needs after your current command finishes.** Use a folder under \`$HOME\` instead: an existing work folder the user already uses (such as \`~/work\`), or \`~/scratch/<task>/\`.
- **Deliverables never live only in a file**, not even under \`$HOME\`: it goes with the machine. Put what the user needs in your reply, and push code on a branch.
- **Images you show the user:** save screenshots and generated images under \`$HOME\` before embedding them. An image embedded from \`/tmp\` breaks for the user after the next stop.
- **Extra git worktrees:** create them under \`$HOME\`, for example \`~/scratch/worktrees/<name>\`, not in \`/tmp\`. A worktree in \`/tmp\` leaves stale git metadata behind; \`git worktree prune\` cleans it up.
- **Logs and long outputs** you will cite later go to a file under \`$HOME\`, for example with \`tee ~/scratch/<task>/run.log\`.
- **Delegated agents:** when you brief one, tell it the same, and give it the folder to use.
- **Throwaway files** that nothing reads after the command ends, such as a pipe's temporary file, may stay in \`/tmp\`.
- **Large downloads and build outputs** under \`~/scratch\` count against the sandbox's disk. Delete them when the task is done.
`;

// Each agent's global instructions folder, its file names in the order the agent picks one (the
// first that exists is the one it reads), and the one to create. Pi: docs/configuration.md and
// getAgentDir in @earendil-works/pi-coding-agent. Codex reads AGENTS.override.md over AGENTS.md.
const AGENT_INSTRUCTION_FILES = [
  { dir: "${CLAUDE_CONFIG_DIR:-$HOME/.claude}", names: ["CLAUDE.md"], create: "CLAUDE.md" },
  {
    dir: "${CODEX_HOME:-$HOME/.codex}",
    names: ["AGENTS.override.md", "AGENTS.md"],
    create: "AGENTS.md",
  },
  {
    dir: "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}",
    names: ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"],
    create: "AGENTS.md",
  },
] as const;

/**
 * Writes T3 Code's skill into Claude's skills folder and replaces the marked block in Claude's,
 * Codex's and Pi's global instructions, keeping the rest of each file. Runs on every launch, after
 * the user's CLAUDE.md is copied, and on every resume. Tries every target, then exits nonzero when
 * any failed.
 */
export const sandboxAgentGuidanceScript = () => `export PATH="$HOME/.local/bin:$PATH"
failed=0
skill="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/${SANDBOX_FILES_SKILL_NAME}"
{ mkdir -p "$skill" &&
  printf '%s' '${base64(SANDBOX_FILES_SKILL)}' | base64 -d >"$skill/SKILL.md.t3-tmp" &&
  mv "$skill/SKILL.md.t3-tmp" "$skill/SKILL.md"; } || failed=1
node -e '
const fs = require("node:fs");
const [block, ...targets] = process.argv.slice(1);
const start = ${JSON.stringify(SANDBOX_INSTRUCTIONS_START)};
const end = ${JSON.stringify(SANDBOX_INSTRUCTIONS_END)};
const section = start + "\\n" + Buffer.from(block, "base64").toString("utf8") + end + "\\n";
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
let failed = false;
for (let i = 0; i < targets.length; i += 3) {
  const [dir, names, create] = targets.slice(i, i + 3);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = names.split(",").find((candidate) => isFile(dir + "/" + candidate)) ?? create;
    const file = isFile(dir + "/" + name) ? fs.realpathSync(dir + "/" + name) : dir + "/" + name;
    const text = isFile(file) ? fs.readFileSync(file, "utf8") : "";
    const from = text.indexOf(start);
    const to = from === -1 ? -1 : text.indexOf(end, from);
    const next =
      to === -1
        ? (text === "" ? "" : text.replace(/\\n*$/u, "\\n\\n")) + section
        : text.slice(0, from) + section + text.slice(to + end.length).replace(/^\\n/u, "");
    if (next === text) continue;
    fs.writeFileSync(file + ".t3-tmp", next);
    fs.renameSync(file + ".t3-tmp", file);
  } catch {
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
' '${base64(SANDBOX_AGENT_INSTRUCTIONS)}' ${AGENT_INSTRUCTION_FILES.map(
  (target) => `"${target.dir}" ${target.names.join(",")} ${target.create}`,
).join(" ")} || failed=1
exit "$failed"`;
