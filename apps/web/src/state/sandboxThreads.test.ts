import {
  EnvironmentId,
  ProjectId,
  type SandboxRecord,
  type SandboxSetupSnapshot,
  type ServerProvider,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { describe, expect, it } from "vite-plus/test";

import {
  providerInstanceEntriesFor,
  resolveProjectDefaultProviderModelSelection,
  resolveSelectableProviderInstanceEntry,
} from "../providerInstances";

import {
  copiesToSandboxMirror,
  findThreadSandbox,
  isSandboxlessBridgeThread,
  movesToSandboxChatAlias,
  sandboxChatAliases,
  sandboxChatAliasTarget,
  sandboxHostMirrors,
  sandboxMirrorOf,
  sandboxMirrorTitleUpdates,
  sandboxRowPhase,
  sandboxRowStates,
  sandboxRowThread,
  sandboxesToPair,
  withSandboxHostMirrors,
} from "./sandboxThreads";

const HOST = EnvironmentId.make("host");
const SANDBOX = EnvironmentId.make("sandbox");
const threadId = ThreadId.make("thread-1");

const record = (fields: Partial<SandboxRecord> = {}): SandboxRecord =>
  ({
    instanceId: "instance-1",
    environmentId: SANDBOX,
    threadId,
    state: "running",
    sandboxId: "bx_46wrabcd",
    ...fields,
  }) as SandboxRecord;

describe("findThreadSandbox", () => {
  it("matches the sandbox's own thread", () => {
    expect(findThreadSandbox([record()], { environmentId: SANDBOX, threadId }, HOST)).toBeDefined();
  });

  it("matches the host thread of a linked sandbox by its id", () => {
    const linked = record({ hostProjectId: ProjectId.make("project-host") });
    expect(findThreadSandbox([linked], { environmentId: HOST, threadId }, HOST)).toBe(linked);
  });

  it("ignores the host's thread id for a running sandbox its launch never linked", () => {
    const ref = { environmentId: HOST, threadId };
    expect(findThreadSandbox([record()], ref, HOST)).toBeUndefined();
    expect(findThreadSandbox([record({ state: "deleted" })], ref, HOST)).toBeUndefined();
  });

  it("matches the host thread while its sandbox launches, since the launch made that thread", () => {
    const ref = { environmentId: HOST, threadId };
    // The launch links the host project only at its end; the thread exists from the send.
    const starting = record({ state: "provisioning" });
    expect(findThreadSandbox([starting], ref, HOST)).toBe(starting);
  });

  it("never matches a thread on a third environment", () => {
    const linked = record({ hostProjectId: ProjectId.make("project-host") });
    const other = { environmentId: EnvironmentId.make("other"), threadId };
    expect(findThreadSandbox([linked], other, HOST)).toBeUndefined();
  });
});

describe("sandboxRowStates", () => {
  const hostRef = { environmentId: HOST, threadId };
  const sandboxRef = { environmentId: SANDBOX, threadId };
  const linked = (fields: Partial<SandboxRecord> = {}) =>
    record({ provider: "boat", hostProjectId: ProjectId.make("project-host"), ...fields });

  it("gives the sandbox's own thread and the host thread its bridge drives the same state", () => {
    const rows = sandboxRowStates([linked({ state: "stopped" })], HOST);
    const stopped = { provider: "boat", state: "stopped", resumingSince: null, onHost: false };
    expect(rows(sandboxRef)).toEqual(stopped);
    expect(rows(hostRef)).toEqual({ ...stopped, onHost: true });
    // Any thread on the sandbox, such as a subagent's, runs on that machine too.
    expect(rows({ environmentId: SANDBOX, threadId: ThreadId.make("child") })).toEqual(stopped);
  });

  it("carries a resume under way", () => {
    const rows = sandboxRowStates([linked({ resumingSince: "2026-11-10T00:00:00.000Z" })], HOST);
    expect(rows(hostRef)?.resumingSince).toBe("2026-11-10T00:00:00.000Z");
    expect(sandboxRowPhase(rows(hostRef))).toBe("starting");
  });

  it("leaves other threads, deleted sandboxes and unlinked host threads alone", () => {
    expect(sandboxRowStates([linked({ state: "deleted" })], HOST)(sandboxRef)).toBeNull();
    expect(sandboxRowStates([record({ provider: "boat" })], HOST)(hostRef)).toBeNull();
    // A launch's host thread shows its sandbox's provider from the send on.
    expect(
      sandboxRowStates([record({ provider: "boat", state: "provisioning" })], HOST)(hostRef),
    ).toEqual({ provider: "boat", state: "provisioning", resumingSince: null, onHost: true });
    const other = { environmentId: EnvironmentId.make("other"), threadId };
    expect(sandboxRowStates([linked()], HOST)(other)).toBeNull();
    // A record that answers as the host must not claim the host's own threads.
    const self = sandboxRowStates(
      [record({ environmentId: HOST, threadId: ThreadId.make("x") })],
      HOST,
    );
    expect(self({ environmentId: HOST, threadId: ThreadId.make("y") })).toBeNull();
  });
});

describe("sandboxRowThread", () => {
  const rows = sandboxRowStates(
    [record({ state: "running", hostProjectId: ProjectId.make("project-host") })],
    HOST,
  );
  const withRun = (status: string) => ({ runtime: { status } });

  it("drops a host mirror's queue, which can sit for days, and keeps the turns it runs", () => {
    const mirror = rows({ environmentId: HOST, threadId });
    expect(sandboxRowThread(withRun("queued"), mirror).runtime).toBeNull();
    for (const status of ["preparing", "starting", "running", "waiting", "idle", "failed"]) {
      const thread = withRun(status);
      expect(sandboxRowThread(thread, mirror)).toBe(thread);
    }
  });

  it("keeps the runs of the sandbox's own thread and of other threads", () => {
    const own = withRun("running");
    expect(sandboxRowThread(own, rows({ environmentId: SANDBOX, threadId }))).toBe(own);
    expect(sandboxRowThread(own, null)).toBe(own);
  });
});

describe("sandboxRowPhase", () => {
  const row = (state: SandboxRecord["state"], resumingSince: string | null = null) => ({
    provider: "boat" as const,
    state,
    resumingSince,
    onHost: false,
  });

  it("is starting during a resume, stopped while stopped, and nothing otherwise", () => {
    expect(sandboxRowPhase(row("stopped", "2026-11-10T00:00:00.000Z"))).toBe("starting");
    expect(sandboxRowPhase(row("stopped"))).toBe("stopped");
    expect(sandboxRowPhase(row("running"))).toBeNull();
    // An expired disk cannot resume, so it is not offered as a stopped thread.
    expect(sandboxRowPhase(row("expired"))).toBeNull();
    expect(sandboxRowPhase(null)).toBeNull();
  });
});

describe("sandboxHostMirrors", () => {
  const linked = (fields: Partial<SandboxRecord> = {}) =>
    record({ hostProjectId: ProjectId.make("project-host"), ...fields });
  const hostThread = { environmentId: HOST, id: threadId };
  const sandboxThread = { environmentId: SANDBOX, id: threadId };
  const mirrorKey = threadKey({ environmentId: HOST, threadId });

  it("pairs the host's mirror with the sandbox's own thread", () => {
    expect([...sandboxHostMirrors([linked()], [hostThread, sandboxThread], HOST)]).toEqual([
      [mirrorKey, { environmentId: SANDBOX, threadId }],
    ]);
  });

  it("keeps the mirror when it is the only copy listed, or the sandbox is gone", () => {
    expect(sandboxHostMirrors([linked()], [hostThread], HOST).size).toBe(0);
    expect(
      sandboxHostMirrors([linked({ state: "deleted" })], [hostThread, sandboxThread], HOST).size,
    ).toBe(0);
  });

  it("ignores a sandbox that was never linked, or that answers as the host itself", () => {
    expect(sandboxHostMirrors([record()], [hostThread, sandboxThread], HOST).size).toBe(0);
    expect(sandboxHostMirrors([linked({ environmentId: HOST })], [hostThread], HOST).size).toBe(0);
    expect(sandboxHostMirrors([linked()], [hostThread, sandboxThread], null).size).toBe(0);
  });
});

describe("sandboxChatAliases", () => {
  const linked = (fields: Partial<SandboxRecord> = {}) =>
    record({ hostProjectId: ProjectId.make("project-host"), ...fields });
  const hostThread = { environmentId: HOST, id: threadId };
  const sandboxThread = { environmentId: SANDBOX, id: threadId };
  const hostRef = { environmentId: HOST, threadId };
  const sandboxRef = { environmentId: SANDBOX, threadId };
  const both = [hostThread, sandboxThread];
  const aliases = (sandbox: SandboxRecord, threads: ReadonlyArray<typeof hostThread> = both) => [
    ...sandboxChatAliases([sandbox], threads, HOST),
  ];
  const showsSandbox = [[threadKey(hostRef), sandboxRef]];
  const showsMirror = [[threadKey(sandboxRef), hostRef]];

  it("shows the sandbox's own thread whatever the sandbox's state", () => {
    expect(aliases(linked())).toEqual(showsSandbox);
    // A launch's thread opens on the sandbox as soon as it lists.
    expect(aliases(linked({ state: "provisioning" }))).toEqual(showsSandbox);
    // Stopped or resuming, a send on its own thread resumes the sandbox and goes there.
    expect(aliases(linked({ state: "stopped" }))).toEqual(showsSandbox);
    expect(
      aliases(linked({ state: "stopped", resumingSince: "2026-11-10T00:00:00.000Z" })),
    ).toEqual(showsSandbox);
    expect(aliases(linked({ resumingSince: "2026-11-10T00:00:00.000Z" }))).toEqual(showsSandbox);
    expect(aliases(linked({ state: "error" }))).toEqual(showsSandbox);
  });

  it("keeps a launch's host thread as the chat until the sandbox's own thread lists", () => {
    // The launch links the host project at its end, so a starting sandbox moves nothing.
    expect(aliases(record({ state: "provisioning" }))).toEqual([]);
    // Linked, but the bridge has not made the sandbox's thread yet.
    expect(aliases(linked(), [hostThread])).toEqual([]);
    expect(aliases(linked())).toEqual(showsSandbox);
  });

  it("sends a route on a stopped sandbox's thread that never listed to the mirror", () => {
    expect(aliases(linked({ state: "stopped" }), [hostThread])).toEqual(showsMirror);
  });

  it("keeps the thread a chat has when the host has no mirror of it", () => {
    // A launch that could not link sends on its sandbox alone; its resume stays in this client.
    expect(aliases(linked({ state: "stopped" }), [sandboxThread])).toEqual([]);
    expect(aliases(record({ state: "stopped" }))).toEqual([]);
    expect(aliases(linked({ state: "deleted" }))).toEqual([]);
    expect([...sandboxChatAliases([linked()], both, null)]).toEqual([]);
  });
});

describe("movesToSandboxChatAlias", () => {
  const idle = { readingBack: false, sentThisVisit: false };

  it("moves a chat the user only opened, once they are at its end", () => {
    expect(movesToSandboxChatAlias(idle)).toBe(true);
    expect(movesToSandboxChatAlias({ ...idle, readingBack: true })).toBe(false);
  });

  // The two threads keep different histories: moving would swap what the user reads for another.
  it("never moves a chat the user sent in, though the send scrolls it to its end", () => {
    expect(movesToSandboxChatAlias({ ...idle, sentThisVisit: true })).toBe(false);
  });
});

describe("withSandboxHostMirrors and sandboxChatAliasTarget", () => {
  const sandboxRef = { environmentId: SANDBOX, threadId };
  const hostRef = { environmentId: HOST, threadId };
  const aliases = new Map([[threadKey(hostRef), sandboxRef]]);

  it("leaves the hidden thread out of lists as delegated tasks are, keeping the set when none is", () => {
    const delegated = new Set(["task"]);
    expect(withSandboxHostMirrors(delegated, new Map())).toBe(delegated);
    expect([...withSandboxHostMirrors(delegated, aliases)]).toEqual(["task", threadKey(hostRef)]);
  });

  it("finds the thread standing for a hidden one only", () => {
    expect(sandboxChatAliasTarget(aliases, hostRef)).toEqual(sandboxRef);
    expect(sandboxChatAliasTarget(aliases, sandboxRef)).toBeUndefined();
  });
});

describe("sandboxMirrorTitleUpdates", () => {
  const sandboxRef = { environmentId: SANDBOX, threadId };
  const hostRef = { environmentId: HOST, threadId };
  const mirrors = new Map([[threadKey(hostRef), sandboxRef]]);
  const sandbox = { environmentId: SANDBOX, id: threadId, title: "Greeting from boat.dev" };

  it("gives the mirror the sandbox thread's title", () => {
    const mirror = { environmentId: HOST, id: threadId, title: "say high from boat.dev:)" };
    expect(sandboxMirrorTitleUpdates(mirrors, [sandbox, mirror])).toEqual([
      { mirror: hostRef, title: "Greeting from boat.dev", mirrorTitle: "say high from boat.dev:)" },
    ]);
  });

  it("does nothing once they match, or while either thread is not loaded", () => {
    const mirror = { environmentId: HOST, id: threadId, title: "Greeting from boat.dev" };
    expect(sandboxMirrorTitleUpdates(mirrors, [sandbox, mirror])).toEqual([]);
    expect(sandboxMirrorTitleUpdates(mirrors, [sandbox])).toEqual([]);
    expect(sandboxMirrorTitleUpdates(mirrors, [{ ...mirror, title: "other" }])).toEqual([]);
  });
});

describe("sandboxMirrorOf", () => {
  it("mirrors a linked sandbox thread to the host thread with its id", () => {
    const hostProjectId = ProjectId.make("project-host");
    expect(
      sandboxMirrorOf([record({ hostProjectId })], { environmentId: SANDBOX, threadId }, HOST),
    ).toEqual({ mirror: { environmentId: HOST, threadId }, hostProjectId });
  });

  it("mirrors nothing for an unlinked sandbox, the host's own threads, or a deleted sandbox", () => {
    const ref = { environmentId: SANDBOX, threadId };
    expect(sandboxMirrorOf([record()], ref, HOST)).toBeNull();
    const linked = record({ hostProjectId: ProjectId.make("p") });
    expect(sandboxMirrorOf([linked], { environmentId: HOST, threadId }, HOST)).toBeNull();
    expect(sandboxMirrorOf([{ ...linked, state: "deleted" }], ref, HOST)).toBeNull();
  });
});

describe("copiesToSandboxMirror", () => {
  it("copies messages but not commands the mirror's bridge run cannot run", () => {
    expect(copiesToSandboxMirror("Fix the build")).toBe(true);
    expect(copiesToSandboxMirror("/Users/omar/app.ts fails to build")).toBe(true);
    for (const command of [
      "/compact",
      "  /COMPACT ",
      "/autocompact on",
      "/goal ship it",
      "/plugin:run x",
    ]) {
      expect(copiesToSandboxMirror(command)).toBe(false);
    }
  });
});

describe("isSandboxlessBridgeThread", () => {
  const onHost = (
    sandboxes: ReadonlyArray<SandboxRecord> | null,
    instanceId = "sandboxes",
    launch: { readonly phase: SandboxSetupSnapshot["phase"] } | null = null,
  ) =>
    isSandboxlessBridgeThread({
      sandboxes,
      threadRef: { environmentId: HOST, threadId },
      instanceId,
      provisionerEnvironmentId: HOST,
      launch,
    });

  it("marks a bridge chat read-only once its sandbox is deleted", () => {
    expect(onHost([])).toBe(true);
    expect(onHost([record({ state: "deleted" })])).toBe(true);
    // A launch that ended without a sandbox leaves nothing to send to either.
    expect(onHost([], "sandboxes", { phase: "cancelled" })).toBe(true);
  });

  it("leaves a chat alone while its sandbox lives, the list loads, or it is no bridge chat", () => {
    expect(onHost([record({ state: "stopped" })])).toBe(false);
    expect(onHost(null)).toBe(false);
    expect(onHost([], "codex")).toBe(false);
    expect(
      isSandboxlessBridgeThread({
        sandboxes: [],
        threadRef: { environmentId: SANDBOX, threadId },
        instanceId: "sandboxes",
        provisionerEnvironmentId: HOST,
        launch: null,
      }),
    ).toBe(false);
  });

  it("leaves a chat alone while its launch loads, runs, or failed and can be retried", () => {
    // The host thread lists before the launch saves its sandbox's record.
    expect(
      isSandboxlessBridgeThread({
        sandboxes: [],
        threadRef: { environmentId: HOST, threadId },
        instanceId: "sandboxes",
        provisionerEnvironmentId: HOST,
        launch: undefined,
      }),
    ).toBe(false);
    expect(onHost([], "sandboxes", { phase: "running" })).toBe(false);
    expect(onHost([], "sandboxes", { phase: "failed" })).toBe(false);
  });
});

describe("the sandbox bridge as an internal provider instance", () => {
  const projectId = ProjectId.make("project-host");
  const provider = (instanceId: string, driver: string, slug: string) =>
    ({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      status: "ready",
      models: [{ slug, name: slug, isCustom: false, capabilities: null }],
    }) as unknown as ServerProvider;
  // The bridge listed first, as it would be if the server reported it before anything else.
  const providers = [
    provider("sandboxes", "acpRegistry", "sandbox"),
    provider("claudeAgent", "claudeAgent", "opus"),
  ];
  const settings = {
    providerInstances: { sandboxes: { driver: "acpRegistry", enabled: false } },
    projectSettingsOverrides: {
      [projectId]: { providerInstances: { sandboxes: { enabled: true } } },
    },
  } as unknown as ServerSettings;
  const entries = providerInstanceEntriesFor(providers, settings, projectId);

  it("still resolves for a thread that asks for it", () => {
    expect(resolveSelectableProviderInstanceEntry(entries, "sandboxes" as never)?.instanceId).toBe(
      "sandboxes",
    );
  });

  it("is never what a new thread in a host project falls back to", () => {
    expect(resolveSelectableProviderInstanceEntry(entries, undefined)?.instanceId).toBe(
      "claudeAgent",
    );
    expect(
      resolveProjectDefaultProviderModelSelection(providers, settings as never, projectId),
    ).toEqual({ instanceId: "claudeAgent", model: "opus" });
  });
});

describe("sandboxesToPair", () => {
  const linked = (fields: Partial<SandboxRecord> = {}) =>
    record({
      hostProjectId: ProjectId.make("project-host"),
      bridge: {
        sessionId: "bridge-session-1",
        secret: "sandbox-bridge-1",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
      ...fields,
    });

  it("pairs with a linked, running sandbox this app has not paired with", () => {
    const sandbox = linked();
    expect(sandboxesToPair([sandbox], HOST, new Set())).toEqual([sandbox]);
    expect(sandboxesToPair([sandbox], HOST, new Set([SANDBOX]))).toEqual([]);
  });

  it("waits for a launch to finish, a stopped sandbox to run, and a link to exist", () => {
    expect(sandboxesToPair([linked({ state: "provisioning" })], HOST, new Set())).toEqual([]);
    expect(sandboxesToPair([linked({ state: "stopped" })], HOST, new Set())).toEqual([]);
    expect(sandboxesToPair([record()], HOST, new Set())).toEqual([]);
    // One that answers as the host, or with no host to pair through.
    expect(sandboxesToPair([linked({ environmentId: HOST })], HOST, new Set())).toEqual([]);
    expect(sandboxesToPair([linked()], null, new Set())).toEqual([]);
  });
});
