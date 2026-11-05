// Scripts that set up what a sandbox gets beyond T3 Code. Secrets reach them only as environment
// variables the driver delivers outside the command text, and none of them print what they write.

import { shellQuote } from "./SandboxProvider.ts";

/** A command and the secrets it reads from its environment, for `SandboxProviderDriver.execute`. */
export interface SandboxScript {
  readonly command: string;
  readonly secrets?: Readonly<Record<string, string>>;
}

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

// Merges into Claude's own settings `env`, which `claude` and T3's Claude provider both read, and
// keeps every other key (Boat ships defaults there). Node is on every supported image.
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
dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$dir"
node -e '
const fs = require("node:fs");
const file = process.argv[1];
const env = JSON.parse(process.env.T3_CLAUDE_ENV);
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
chmod 600 "$dir/settings.json"`,
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
