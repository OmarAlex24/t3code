// @effect-diagnostics nodeBuiltinImport:off - drives the helper and its scripts as subprocesses in a temp HOME.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { SandboxScript } from "./sandboxSetup.ts";
import {
  parseSubSandboxPoll,
  SUB_SANDBOX_HELPER_SCRUB,
  SUB_SANDBOX_HELPER_SOURCE,
  SUB_SANDBOX_POLL_SCRIPT,
  subSandboxHelperScript,
  subSandboxRespondScript,
} from "./subSandboxHelper.ts";

// Everything runs in a throwaway HOME with this machine's sh and node, as it would on a sandbox,
// with a script's secrets in its environment the way drivers pass them.
let home = "";
const dir = () => NodePath.join(home, ".t3/userdata/sub-sandbox");
const at = (...parts: Array<string>) => NodePath.join(dir(), ...parts);

beforeEach(() => {
  home = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sub-sandbox-")));
});
afterEach(() => {
  NodeFS.rmSync(home, { recursive: true, force: true });
});

const sh = (script: string | SandboxScript) => {
  const { command, secrets } = typeof script === "string" ? { command: script } : script;
  const result = NodeChildProcess.spawnSync("sh", ["-c", command], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, ...secrets },
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
};

const readJson = (file: string) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const listed = (folder: string) =>
  NodeFS.existsSync(at(folder)) ? NodeFS.readdirSync(at(folder)).toSorted() : [];
/** Resolves once `file` exists, on its folder's change events. */
const appears = (file: string) =>
  new Promise<void>((resolve) => {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    const watcher = NodeFS.watch(NodePath.dirname(file), () => {
      if (!NodeFS.existsSync(file)) return;
      watcher.close();
      resolve();
    });
    if (NodeFS.existsSync(file)) {
      watcher.close();
      resolve();
    }
  });

interface RpcMessage {
  readonly id: number;
  readonly result: {
    readonly content: ReadonlyArray<{ readonly text: string }>;
    readonly isError?: boolean;
    readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string }>;
    readonly serverInfo: { readonly name: string };
  };
}

/** Runs the helper as Claude would, over stdio, and returns a JSON-RPC caller. */
const startHelper = () => {
  NodeFS.mkdirSync(dir(), { recursive: true });
  NodeFS.writeFileSync(at("mcp.mjs"), SUB_SANDBOX_HELPER_SOURCE);
  const child = NodeChildProcess.spawn(process.execPath, [at("mcp.mjs")], {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      T3CODE_THREAD_ID: "thread-on-sandbox",
      T3_SUB_SANDBOX_POLL_MS: "50",
      T3_SUB_SANDBOX_ACK_SECONDS: "4",
      T3_SUB_SANDBOX_STALE_ACK_SECONDS: "1",
    },
  });
  let buffered = "";
  const waiting = new Map<number, (message: RpcMessage) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const message = JSON.parse(buffered.slice(0, newline)) as RpcMessage;
      buffered = buffered.slice(newline + 1);
      waiting.get(message.id)?.(message);
      newline = buffered.indexOf("\n");
    }
  });
  let next = 0;
  const request = (method: string, params?: unknown) =>
    new Promise<RpcMessage>((resolve) => {
      next += 1;
      waiting.set(next, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
    });
  const call = async (name: string, args: unknown) => {
    const message = await request("tools/call", { name, arguments: args });
    return { text: message.result.content[0]!.text, isError: message.result.isError === true };
  };
  return { request, call, stop: () => child.kill() };
};

const TERMINAL = ["completed", "failed", "cancelled"];

/** What the host's response write leaves for the helper. */
const respond = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  sh(
    subSandboxRespondScript(
      id,
      { version: 1, id, status, message: `${status} message`, updatedAt: "now", ...extra },
      TERMINAL.includes(status),
    ),
  );

describe("sub-sandbox helper", () => {
  it("lists its two tools with short descriptions", async () => {
    const helper = startHelper();
    try {
      const initialized = await helper.request("initialize", { protocolVersion: "2025-06-18" });
      expect(initialized.result.serverInfo.name).toBe("t3-sub-sandbox");
      const { result } = await helper.request("tools/list");
      expect(result.tools.map((tool) => tool.name)).toEqual([
        "sandbox_delegate",
        "sandbox_task_status",
      ]);
      for (const tool of result.tools) expect(tool.description.length).toBeLessThan(450);
      expect(result.tools[0]!.description).toContain("CPU, RAM and disk");
    } finally {
      helper.stop();
    }
  });

  it("writes a request with the caller's thread, then withdraws it and says to work here when the host does not answer", async () => {
    const helper = startHelper();
    try {
      const answer = await helper.call("sandbox_delegate", {
        task: "Run the whole test suite",
        size: "large",
        requestId: "req-1",
      });
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain("did not pick up request req-1");
      expect(answer.text).toContain("may be asleep or offline");
      expect(answer.text).toContain("Run this work here, on this sandbox");
      // Withdrawn, so a host that wakes later never starts it; nothing half-written is left.
      expect(listed("requests")).toEqual([]);
      expect(listed("withdrawn")).toEqual(["req-1.json"]);
      expect(readJson(at("withdrawn", "req-1.json"))).toMatchObject({
        version: 1,
        id: "req-1",
        task: "Run the whole test suite",
        size: "large",
        threadId: "thread-on-sandbox",
        cwd: home,
      });
      const status = await helper.call("sandbox_task_status", { id: "req-1" });
      expect(status.text).toContain("status: withdrawn");
      // The same id is not asked again.
      const again = await helper.call("sandbox_delegate", { task: "x", requestId: "req-1" });
      expect(again.text).toContain("Ask again with a new requestId");
    } finally {
      helper.stop();
    }
  });

  it("answers with the host's response, once per id, and hands back the result", async () => {
    const helper = startHelper();
    // A host that polled lately gets the full wait.
    sh(SUB_SANDBOX_POLL_SCRIPT);
    try {
      const written = appears(at("requests", "req-2.json"));
      const asked = helper.call("sandbox_delegate", { task: "Build it", requestId: "req-2" });
      await written;
      // The host's poll claims it and answers.
      expect(parseSubSandboxPoll(sh(SUB_SANDBOX_POLL_SCRIPT).stdout)?.requests).toMatchObject([
        { id: "req-2" },
      ]);
      respond("req-2", "queued");
      const answer = await asked;
      expect(answer.isError).toBe(false);
      expect(answer.text).toContain("Request req-2 is queued");
      expect(answer.text).toContain("status: queued");

      // Asking again with the same id returns the same request and writes nothing new.
      const again = await helper.call("sandbox_delegate", { task: "Build it", requestId: "req-2" });
      expect(again.text).toContain("status: queued");
      expect(listed("requests")).toEqual([]);
      expect(listed("claimed")).toEqual(["req-2.json"]);

      // A status call waits for the next change, and the result comes with the last one.
      const waited = helper.call("sandbox_task_status", { id: "req-2", waitSeconds: 10 });
      respond("req-2", "completed", {
        result:
          "All 812 tests passed.\n\n[Sub-sandbox] Its sandbox held no unpushed work and was deleted.",
        subSandbox: { label: "app subagent on Boat", sandboxId: "bx_sub", environmentId: "env" },
      });
      const done = await waited;
      expect(done.text).toContain("Request req-2 completed.");
      expect(done.text).toContain("All 812 tests passed.");
      expect(done.text).toContain("was deleted");
      expect(done.text).toContain("app subagent on Boat (bx_sub)");
      expect(done.text).toContain("status: completed");
      expect(listed("done")).toEqual(["req-2.json"]);
    } finally {
      helper.stop();
    }
  });

  it("refuses a request it cannot pass on", async () => {
    const helper = startHelper();
    try {
      expect((await helper.call("sandbox_delegate", { task: " " })).isError).toBe(true);
      expect((await helper.call("sandbox_delegate", { task: "x", size: "a b" })).isError).toBe(
        true,
      );
      expect(
        (await helper.call("sandbox_delegate", { task: "x", requestId: "../x" })).isError,
      ).toBe(true);
      expect((await helper.call("sandbox_task_status", { id: "nope" })).text).toContain(
        "No request nope",
      );
      expect(listed("requests")).toEqual([]);
    } finally {
      helper.stop();
    }
  });
});

describe("subSandboxHelperScript", () => {
  it("writes the helper and registers it in Claude's MCP list next to the user's servers", () => {
    NodeFS.writeFileSync(
      NodePath.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { mine: { command: "mine" } }, theme: "dark" }),
    );
    const script = subSandboxHelperScript();
    expect(script.command).not.toContain(Buffer.from(SUB_SANDBOX_HELPER_SOURCE).toString("base64"));
    expect(sh(script).status).toBe(0);
    // A resume runs it again; nothing doubles.
    expect(sh(script).status).toBe(0);
    expect(NodeFS.readFileSync(at("mcp.mjs"), "utf8")).toBe(SUB_SANDBOX_HELPER_SOURCE);
    const config = readJson(NodePath.join(home, ".claude.json"));
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.mine).toEqual({ command: "mine" });
    expect(config.mcpServers["t3-sub-sandbox"]).toMatchObject({
      type: "stdio",
      args: [at("mcp.mjs")],
    });
    expect(NodePath.isAbsolute(config.mcpServers["t3-sub-sandbox"].command)).toBe(true);
    // Named among the servers T3 wrote, so a template save removes the entry.
    expect(readJson(NodePath.join(home, ".t3/mcp-servers.json"))).toEqual(["t3-sub-sandbox"]);
    for (const folder of ["requests", "claimed", "responses", "withdrawn", "done"]) {
      expect(NodeFS.existsSync(at(folder))).toBe(true);
    }
  });

  it("fails without Node and writes nothing", () => {
    const script = subSandboxHelperScript();
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", script.command], {
      cwd: home,
      env: { PATH: "/usr/bin:/bin", HOME: home, ...script.secrets },
      encoding: "utf8",
    });
    // Only meaningful where this machine's Node is not in the system folders.
    if (
      NodeChildProcess.spawnSync("/bin/sh", ["-c", "PATH=/usr/bin:/bin command -v node"]).status ===
      0
    )
      return;
    expect(result.status).toBe(3);
    expect(NodeFS.existsSync(at("mcp.mjs"))).toBe(false);
  });
});

describe("sub-sandbox poll", () => {
  const request = (id: string) =>
    NodeFS.writeFileSync(
      at("requests", `${id}.json`),
      JSON.stringify({ version: 1, id, task: id }),
    );

  it("says when the helper is not there", () => {
    expect(parseSubSandboxPoll(sh(SUB_SANDBOX_POLL_SCRIPT).stdout)).toEqual({
      installed: false,
      requests: [],
      open: [],
    });
  });

  it("claims new requests once, then lists them as open until the last response", () => {
    expect(sh(subSandboxHelperScript()).status).toBe(0);
    request("a");
    request("b");
    const first = parseSubSandboxPoll(sh(SUB_SANDBOX_POLL_SCRIPT).stdout)!;
    expect(first.requests.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(JSON.parse(first.requests[0]!.json)).toMatchObject({ id: "a", task: "a" });
    expect(listed("requests")).toEqual([]);
    expect(listed("claimed")).toEqual(["a.json", "b.json"]);
    expect(Number(NodeFS.readFileSync(at("host-seen"), "utf8"))).toBeGreaterThan(0);

    respond("a", "running", { taskId: "task-a" });
    const second = parseSubSandboxPoll(sh(SUB_SANDBOX_POLL_SCRIPT).stdout)!;
    expect(second.requests.map((entry) => entry.id)).toEqual(["b"]);
    expect(second.open.map((entry) => entry.id)).toEqual(["a"]);
    expect(JSON.parse(second.open[0]!.json)).toMatchObject({ status: "running", taskId: "task-a" });

    respond("a", "completed", { result: "done" });
    respond("b", "failed", { code: "concurrency_full" });
    expect(parseSubSandboxPoll(sh(SUB_SANDBOX_POLL_SCRIPT).stdout)).toEqual({
      installed: true,
      requests: [],
      open: [],
    });
    expect(listed("done")).toEqual(["a.json", "b.json"]);
    expect(readJson(at("responses", "b.json"))).toMatchObject({ code: "concurrency_full" });
    // Written by rename, so no temp file is ever left for the helper to read.
    expect(listed("responses")).toEqual(["a.json", "b.json"]);
  });

  it("reads a cut-off poll as nothing", () => {
    expect(parseSubSandboxPoll("T3_SUB_REQUEST a e30=\n")).toBeNull();
  });

  it("refuses a response id it would put in a path", () => {
    expect(() => subSandboxRespondScript("../x", {}, false)).toThrow();
  });

  it("goes with a template save, pending requests included", () => {
    expect(sh(subSandboxHelperScript()).status).toBe(0);
    request("pending");
    expect(sh(SUB_SANDBOX_HELPER_SCRUB).status).toBe(0);
    expect(NodeFS.existsSync(dir())).toBe(false);
  });
});
