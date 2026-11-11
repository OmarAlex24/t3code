// The MCP helper T3 Code installs on a chat's sandbox, which runs the official T3 Code: requests
// and answers are files under ~/.t3/userdata/sub-sandbox that the host reads and writes with the
// provider's exec. Each side writes by rename, and the poll claims a request by moving it, so a
// withdrawn one never starts. The layout is in docs/internals/sandbox-environments.md.

import { shellQuote } from "./SandboxProvider.ts";
import type { SandboxScript } from "./sandboxSetup.ts";

const SUB_SANDBOX_DIR = "$HOME/.t3/userdata/sub-sandbox";

/** The helper's name in Claude's MCP list, so its tools are `mcp__t3-sub-sandbox__…`. */
const SUB_SANDBOX_MCP_NAME = "t3-sub-sandbox";

/** A request id: what the helper makes, and all the host accepts before using one in a path. */
export const SUB_SANDBOX_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/u;

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

/**
 * The helper itself: Node built-ins only, no install step. Written without template literals so
 * it can live in this one.
 */
export const SUB_SANDBOX_HELPER_SOURCE = String.raw`// T3 Code sub-sandbox helper. Installed and kept up to date by T3 Code on the user's computer.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const dir = process.env.T3_SUB_SANDBOX_DIR || path.join(os.homedir(), ".t3", "userdata", "sub-sandbox");
const ACK_SECONDS = number(process.env.T3_SUB_SANDBOX_ACK_SECONDS, 45);
// A host that has not polled for a while is most likely asleep; it gets a shorter wait.
const STALE_ACK_SECONDS = number(process.env.T3_SUB_SANDBOX_STALE_ACK_SECONDS, 20);
const HOST_STALE_SECONDS = 180;
const POLL_MS = number(process.env.T3_SUB_SANDBOX_POLL_MS, 1000);
// Every call stays well under the minute some MCP clients give a tool.
const MAX_WAIT_SECONDS = 30;
const LATE_SECONDS = 10;
const MAX_TASK_LENGTH = 60000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SIZE = /^[A-Za-z0-9._-]{1,64}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const folder = (name) => path.join(dir, name);
const fileOf = (name, id) => path.join(folder(name), id + ".json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const writeAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), "." + path.basename(file) + "." + process.pid + ".tmp");
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
};
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const exists = (file) => fs.existsSync(file);
const where = (id) => {
  if (exists(fileOf("responses", id))) return "responded";
  if (exists(fileOf("withdrawn", id))) return "withdrawn";
  if (exists(fileOf("claimed", id)) || exists(fileOf("done", id))) return "claimed";
  if (exists(fileOf("requests", id))) return "requested";
  return null;
};
const hostSeenSecondsAgo = () => {
  let seen = NaN;
  try {
    seen = Number(fs.readFileSync(path.join(dir, "host-seen"), "utf8").trim());
  } catch {}
  return Number.isFinite(seen) && seen > 0 ? Math.max(0, Math.round(Date.now() / 1000 - seen)) : null;
};
const run = (command, args, options) =>
  new Promise((resolve) => {
    const env = { ...process.env, PATH: path.join(os.homedir(), ".local", "bin") + ":" + (process.env.PATH || "") };
    execFile(command, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024, env, ...options }, (error, stdout) =>
      resolve(error ? null : String(stdout)),
    );
  });

// What the host needs to start the subagent like the caller: its thread, model and pushed branch.
const callerContext = async () => {
  const threadId = process.env.T3CODE_THREAD_ID || undefined;
  const cwd = process.cwd();
  const upstream = ((await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd })) || "").trim();
  let model;
  if (threadId) {
    const shown = await run("t3", ["thread", "show", threadId, "--json", "--messages", "0"], { cwd });
    try {
      const thread = JSON.parse(shown || "null")?.thread;
      if (typeof thread?.providerInstanceId === "string" && typeof thread?.model === "string") {
        model = { instanceId: thread.providerInstanceId, model: thread.model };
      }
    } catch {}
  }
  return {
    ...(threadId ? { threadId } : {}),
    cwd,
    ...(upstream && !upstream.includes(" ") ? { upstream } : {}),
    ...(model ? { model } : {}),
  };
};

const STATUS_WORDS = {
  queued: "is queued on the user's computer",
  starting_sandbox: "is starting a new sandbox, which takes a few minutes",
  running: "is running on its sandbox",
  completed: "completed",
  failed: "failed",
  cancelled: "was cancelled",
};
const describe = (id, response) => {
  const lines = ["Request " + id + " " + (STATUS_WORDS[response.status] || response.status) + "."];
  if (response.message) lines.push(response.message);
  if (response.subSandbox?.label) lines.push("Sandbox: " + response.subSandbox.label + (response.subSandbox.sandboxId ? " (" + response.subSandbox.sandboxId + ")" : "") + ".");
  if (typeof response.result === "string" && response.result.trim() !== "") lines.push("", "Result:", response.result);
  if (!TERMINAL.has(response.status)) lines.push("", "Check again with sandbox_task_status (waitSeconds up to 30).");
  lines.push("", "status: " + response.status);
  return lines.join("\n");
};
const text = (value, isError = false) => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });
const notAnswering = (id, seconds) =>
  text(
    "Not started: T3 Code on the user's computer did not pick up request " + id + " within " + seconds +
      " seconds. That computer holds the sandbox configs and keys, so it must be awake and running T3 Code, and it may be asleep or offline. Nothing was started and the request was withdrawn. Run this work here, on this sandbox, instead.",
    true,
  );

const waitFor = async (seconds, done) => {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = done();
    if (value) return value;
    await sleep(POLL_MS);
  }
  return done();
};

const delegate = async (args) => {
  const task = typeof args?.task === "string" ? args.task.trim() : "";
  if (task === "") return text("Pass task: the full brief for the subagent.", true);
  if (task.length > MAX_TASK_LENGTH) return text("task is too long (at most " + MAX_TASK_LENGTH + " characters).", true);
  const size = typeof args?.size === "string" && args.size.trim() !== "" ? args.size.trim() : undefined;
  if (size !== undefined && !SIZE.test(size)) return text("size is a machine size id such as large.", true);
  const asked = typeof args?.requestId === "string" && args.requestId.trim() !== "" ? args.requestId.trim() : undefined;
  if (asked !== undefined && !ID.test(asked)) return text("requestId takes letters, digits, - and _ (at most 64).", true);
  const id = asked || "sr_" + crypto.randomBytes(8).toString("hex");
  const found = where(id);
  if (found === "responded") return text(describe(id, readJson(fileOf("responses", id)) || { status: "queued" }));
  if (found === "withdrawn") return text("Request " + id + " was withdrawn because the user's computer did not answer. Ask again with a new requestId.", true);
  if (found === null) {
    writeAtomic(fileOf("requests", id), {
      version: 1,
      id,
      task,
      ...(size ? { size } : {}),
      ...(await callerContext()),
      createdAt: new Date().toISOString(),
    });
  }
  const seen = hostSeenSecondsAgo();
  const seconds = seen !== null && seen <= HOST_STALE_SECONDS ? ACK_SECONDS : STALE_ACK_SECONDS;
  const answered = await waitFor(seconds, () => readJson(fileOf("responses", id)));
  if (answered) return text(describe(id, answered));
  try {
    fs.mkdirSync(folder("withdrawn"), { recursive: true, mode: 0o700 });
    fs.renameSync(fileOf("requests", id), fileOf("withdrawn", id));
    return notAnswering(id, seconds);
  } catch {}
  // The host took it just now.
  const late = await waitFor(LATE_SECONDS, () => readJson(fileOf("responses", id)));
  return late
    ? text(describe(id, late))
    : text("Request " + id + " was picked up by the user's computer. Check it with sandbox_task_status.\n\nstatus: queued");
};

const status = async (args) => {
  const id = typeof args?.id === "string" ? args.id.trim() : "";
  if (!ID.test(id)) return text("Pass id: the request id sandbox_delegate returned.", true);
  const wait = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(args?.waitSeconds) || 0));
  const first = exists(fileOf("responses", id)) ? fs.readFileSync(fileOf("responses", id), "utf8") : null;
  const firstStatus = first === null ? null : readJson(fileOf("responses", id))?.status;
  if (wait > 0 && !TERMINAL.has(firstStatus)) {
    await waitFor(wait, () => {
      try {
        return fs.readFileSync(fileOf("responses", id), "utf8") !== first;
      } catch {
        return where(id) === "withdrawn";
      }
    });
  }
  const response = readJson(fileOf("responses", id));
  if (response) return text(describe(id, response));
  const found = where(id);
  if (found === null) return text("No request " + id + " on this sandbox.", true);
  if (found === "withdrawn") return text("Request " + id + " was withdrawn: the user's computer did not pick it up, and nothing was started.\n\nstatus: withdrawn");
  const seen = hostSeenSecondsAgo();
  return text(
    "Request " + id + " is waiting for the user's computer" + (found === "claimed" ? ", which picked it up." : " to pick it up") +
      (seen === null ? "" : " (last heard from " + seen + " s ago)") + ".\n\nstatus: waiting",
  );
};

const TOOLS = [
  {
    name: "sandbox_delegate",
    description:
      "Run a task as a subagent on a new sandbox with its own CPU, RAM and disk. Use it when this sandbox is too small: heavy or parallel builds, large test runs, more memory or disk. The subagent starts from a fresh clone at your pushed branch, so push first. Needs the user's computer awake; if it does not answer, do the work here. Returns a request id for sandbox_task_status.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Full brief for the subagent: what to do and what to report back." },
        size: { type: "string", description: "Machine size id, at most one step above this sandbox's. Omit for the same size." },
        requestId: { type: "string", description: "Your own id; asking again with it never starts a second sandbox." },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "sandbox_task_status",
    description: "Status of a sandbox_delegate request, and its result once it ends. waitSeconds (max 30) waits for a change.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, waitSeconds: { type: "number" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const handle = async (message) => {
  const { id, method, params } = message;
  if (id === undefined || id === null) return;
  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "t3-sub-sandbox", version: "1" },
      },
    });
  }
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    const name = params?.name;
    const call = name === "sandbox_delegate" ? delegate : name === "sandbox_task_status" ? status : null;
    if (call === null) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool " + name } });
    try {
      return send({ jsonrpc: "2.0", id, result: await call(params?.arguments ?? {}) });
    } catch (error) {
      return send({ jsonrpc: "2.0", id, result: text("The helper failed: " + (error?.message || error), true) });
    }
  }
  return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
};

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    void handle(message);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/**
 * Writes the helper and registers it in Claude's user-scope MCP list with the Node that ran the
 * install, so a resume refreshes both. The name is added to the list of servers T3 wrote, so a
 * template save removes the entry. Exits 3 without Node, which the MCP entry would need too.
 */
export const subSandboxHelperScript = (): SandboxScript => ({
  // Kept out of the command text only for its size.
  secrets: { T3_SUB_SANDBOX_HELPER: base64(SUB_SANDBOX_HELPER_SOURCE) },
  command: `set -eu
umask 077
export PATH="$HOME/.local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  unset T3_SUB_SANDBOX_HELPER
  echo "Node is not installed." >&2
  exit 3
fi
dir="${SUB_SANDBOX_DIR}"
mkdir -p "$dir/requests" "$dir/claimed" "$dir/responses" "$dir/withdrawn" "$dir/done"
printf '%s' "$T3_SUB_SANDBOX_HELPER" | base64 -d >"$dir/mcp.mjs.tmp"
unset T3_SUB_SANDBOX_HELPER
mv "$dir/mcp.mjs.tmp" "$dir/mcp.mjs"
node -e '
const fs = require("node:fs");
const [file, written, helper, name] = process.argv.slice(1);
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
config.mcpServers = { ...current, [name]: { type: "stdio", command: process.execPath, args: [helper] } };
fs.writeFileSync(file + ".t3-tmp", JSON.stringify(config, null, 2) + "\\n", { mode: 0o600 });
fs.renameSync(file + ".t3-tmp", file);
let names = [];
try { names = JSON.parse(fs.readFileSync(written, "utf8")); } catch {}
fs.writeFileSync(written, JSON.stringify([...new Set([...names, name])]) + "\\n", { mode: 0o600 });
' "\${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json" "$HOME/.t3/mcp-servers.json" "$dir/mcp.mjs" ${SUB_SANDBOX_MCP_NAME}`,
});

const POLL_PREFIX = "T3_SUB_";

/**
 * The host's poll: says it was here, claims every new request by moving it to `claimed/`, and
 * prints each claimed request without a response (new) or with one (open, for after a restart).
 * Prints `T3_SUB_NONE` when the helper is not installed.
 */
export const SUB_SANDBOX_POLL_SCRIPT = `dir="${SUB_SANDBOX_DIR}"
if [ ! -f "$dir/mcp.mjs" ]; then
  echo ${POLL_PREFIX}NONE
  exit 0
fi
date +%s >"$dir/.host-seen.tmp" && mv "$dir/.host-seen.tmp" "$dir/host-seen"
mkdir -p "$dir/claimed"
for f in "$dir"/requests/*.json; do
  [ -f "$f" ] || continue
  mv "$f" "$dir/claimed/" 2>/dev/null || true
done
for f in "$dir"/claimed/*.json; do
  [ -f "$f" ] || continue
  id="$(basename "$f" .json)"
  if [ -f "$dir/responses/$id.json" ]; then
    printf '${POLL_PREFIX}OPEN %s %s\\n' "$id" "$(base64 <"$dir/responses/$id.json" | tr -d '\\n')"
  else
    printf '${POLL_PREFIX}REQUEST %s %s\\n' "$id" "$(base64 <"$f" | tr -d '\\n')"
  fi
done
echo ${POLL_PREFIX}END
exit 0`;

export interface SubSandboxPoll {
  /** False when the sandbox has no helper, as one made before it existed. */
  readonly installed: boolean;
  /** Claimed requests with no response yet, as their JSON text. */
  readonly requests: ReadonlyArray<{ readonly id: string; readonly json: string }>;
  /** Claimed requests that have a response, as that response's JSON text. */
  readonly open: ReadonlyArray<{ readonly id: string; readonly json: string }>;
}

/** What the poll printed, or null when it did not finish (cut-off output reads as nothing). */
export const parseSubSandboxPoll = (stdout: string): SubSandboxPoll | null => {
  const lines = stdout.split("\n").map((line) => line.trim());
  if (lines.includes(`${POLL_PREFIX}NONE`)) return { installed: false, requests: [], open: [] };
  if (!lines.includes(`${POLL_PREFIX}END`)) return null;
  const requests: Array<{ id: string; json: string }> = [];
  const open: Array<{ id: string; json: string }> = [];
  for (const line of lines) {
    const match = /^T3_SUB_(REQUEST|OPEN) (\S+) ([A-Za-z0-9+/=]*)$/u.exec(line);
    if (match === null || !SUB_SANDBOX_REQUEST_ID.test(match[2]!)) continue;
    const entry = { id: match[2]!, json: Buffer.from(match[3]!, "base64").toString("utf8") };
    (match[1] === "REQUEST" ? requests : open).push(entry);
  }
  return { installed: true, requests, open };
};

/**
 * Writes one response for the helper to read, atomically; the last one also moves the request to
 * `done/`, so later polls skip it. The response rides in `secrets` only for its size.
 */
export const subSandboxRespondScript = (
  id: string,
  response: unknown,
  final: boolean,
): SandboxScript => {
  if (!SUB_SANDBOX_REQUEST_ID.test(id)) throw new Error(`Invalid sub-sandbox request id: ${id}`);
  const quoted = shellQuote(id);
  return {
    secrets: { T3_SUB_RESPONSE: base64(`${JSON.stringify(response, null, 2)}\n`) },
    command: `set -eu
umask 077
dir="${SUB_SANDBOX_DIR}"
mkdir -p "$dir/responses"
printf '%s' "$T3_SUB_RESPONSE" | base64 -d >"$dir/responses/.${id}.json.tmp"
unset T3_SUB_RESPONSE
mv "$dir/responses/.${id}.json.tmp" "$dir/responses/"${quoted}.json${
      final
        ? `
mkdir -p "$dir/done"
if [ -f "$dir/claimed/"${quoted}.json ]; then mv "$dir/claimed/"${quoted}.json "$dir/done/"; fi`
        : ""
    }`,
  };
};

// Run before a template save, before T3's userdata is removed: a copy must not inherit the helper's
// queue or a pending request. Its MCP entry goes with the other servers T3 wrote.
export const SUB_SANDBOX_HELPER_SCRUB = `rm -rf "${SUB_SANDBOX_DIR}"`;
