import {
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  RunId,
  type SandboxRecord,
  type SandboxThreadMirror,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  queueSandboxStartRun,
  sandboxMirrorModelSource,
  sandboxMirrorModelSourceOf,
  sandboxMirrorPickerSource,
  sandboxStartRunId,
} from "./sandboxMirror.ts";
import { deriveThreadQueueWorkflowState } from "./threadWorkflows.ts";

const sandboxClaude = {
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  enabled: true,
  installed: true,
  status: "ready",
  models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: null }],
} as unknown as ServerProvider;
const running = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "xhigh" }],
} as ModelSelection;

describe("sandboxMirrorModelSource", () => {
  // The host's bridge lists one set of models and options for every sandbox, so its picker read
  // "Sandboxes" with another chat's effort.
  it("shows the sandbox's own provider and selection, under the bridge the mirror sends on", () => {
    expect(sandboxMirrorModelSource(running, [sandboxClaude])).toEqual({
      providers: [{ ...sandboxClaude, instanceId: "sandboxes" }],
      modelSelection: { ...running, instanceId: ProviderInstanceId.make("sandboxes") },
    });
  });

  it("leaves the bridge's list while the sandbox's provider is unknown here", () => {
    expect(sandboxMirrorModelSource(running, [])).toBeNull();
  });

  // The phone reads the same through the host, kept while the sandbox is stopped.
  it("reads the same source from what the host read of the sandbox, available or not", () => {
    const mirror = {
      available: false,
      provider: sandboxClaude,
      modelSelection: running,
      runs: [],
      subagents: [],
    } satisfies SandboxThreadMirror;
    expect(sandboxMirrorModelSourceOf(mirror)).toEqual(
      sandboxMirrorModelSource(running, [sandboxClaude]),
    );
    expect(sandboxMirrorModelSourceOf({ ...mirror, provider: null })).toBeNull();
  });
});

describe("sandboxMirrorPickerSource", () => {
  const bridge = {
    ...sandboxClaude,
    instanceId: "sandboxes",
    driver: "acpRegistry",
  } as ServerProvider;
  const hostCodex = { ...sandboxClaude, instanceId: "codex", driver: "codex" } as ServerProvider;
  const mirrorSelection = {
    instanceId: ProviderInstanceId.make("sandboxes"),
    model: "claude-opus-5-5",
  } as ModelSelection;
  const hostMirror = {
    available: false,
    provider: sandboxClaude,
    modelSelection: running,
    runs: [],
    subagents: [],
  } satisfies SandboxThreadMirror;
  const input = {
    paired: null,
    hostMirror: null,
    mirrorSelection,
    hostProviders: [sandboxClaude, bridge, hostCodex],
  };

  it("prefers the paired sandbox's thread, then what the host read of it", () => {
    const paired = sandboxMirrorModelSource(running, [sandboxClaude]);
    expect(sandboxMirrorPickerSource({ ...input, paired, hostMirror })).toEqual({
      ...paired,
      readOnly: false,
    });
    expect(sandboxMirrorPickerSource({ ...input, hostMirror })).toEqual({
      ...sandboxMirrorModelSourceOf(hostMirror),
      readOnly: false,
    });
  });

  // Picking the host's Claude on a stopped sandbox's mirror was refused by the host.
  it("never offers the host's own providers while neither has read the sandbox", () => {
    expect(sandboxMirrorPickerSource(input)).toEqual({
      providers: [bridge],
      modelSelection: mirrorSelection,
      readOnly: true,
    });
    expect(
      sandboxMirrorPickerSource({ ...input, hostMirror: { ...hostMirror, provider: null } }),
    ).toEqual({ providers: [bridge], modelSelection: mirrorSelection, readOnly: true });
  });
});

describe("sandboxStartRunId and queueSandboxStartRun", () => {
  const sandbox = (state: SandboxRecord["state"], resumingSince?: string) =>
    ({
      instanceId: "instance-1",
      threadId: "thread",
      state,
      ...(resumingSince === undefined ? {} : { resumingSince }),
    }) as SandboxRecord;
  const projection = {
    thread: {
      id: "thread",
      activeProviderThreadId: null,
      providerInstanceId: "sandboxes",
      modelSelection: { instanceId: "sandboxes", model: "sandbox" },
    },
    messages: [{ id: "message-waiting", text: "Fix the build" }],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [
      { id: "done", status: "completed", ordinal: 1, providerInstanceId: "sandboxes" },
      {
        id: "waiting",
        status: "running",
        ordinal: 2,
        userMessageId: "message-waiting",
        providerInstanceId: "sandboxes",
      },
      {
        id: "later",
        status: "queued",
        ordinal: 3,
        queuePosition: 1,
        providerInstanceId: "sandboxes",
      },
    ],
    turnItems: [
      { id: "answer", runId: "done" },
      { id: "message", runId: "waiting" },
      { id: "starting-thought", runId: "waiting" },
    ],
    visibleTurnItems: [
      { item: { id: "answer", runId: "done" } },
      { item: { id: "message", runId: "waiting" } },
      { item: { id: "starting-thought", runId: "waiting" } },
    ],
  } as unknown as OrchestrationV2ThreadProjection;

  // The host's run resumes the sandbox and waits at the bridge until it answers; it showed as
  // "Working · Thinking" for as long as the sandbox took to start.
  it("finds the mirror's run waiting on its sandbox while that sandbox is stopped or resuming", () => {
    expect(sandboxStartRunId(projection, [sandbox("stopped")])).toBe("waiting");
    expect(sandboxStartRunId(projection, [sandbox("stopped", "2026-11-13T10:00:00.000Z")])).toBe(
      "waiting",
    );
    // Once the sandbox runs, the bridge sends the message and streams the turn.
    expect(sandboxStartRunId(projection, [sandbox("running")])).toBeNull();
    expect(sandboxStartRunId(projection, [])).toBeNull();
    // Only the host's mirror has a run at the bridge; the sandbox's own thread runs its turns.
    expect(
      sandboxStartRunId(
        {
          ...projection,
          thread: {
            ...projection.thread,
            modelSelection: { ...projection.thread.modelSelection, instanceId: "claudeAgent" },
          },
        } as OrchestrationV2ThreadProjection,
        [sandbox("stopped")],
      ),
    ).toBeNull();
  });

  it("shows the waiting run as the first queued message, with none of its items yet", () => {
    const queued = queueSandboxStartRun(projection, RunId.make("waiting"));
    const workflow = deriveThreadQueueWorkflowState(queued as never);
    expect(workflow.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["waiting", "Fix the build"],
      ["later", "Queued message"],
    ]);
    expect(queued.turnItems.map((item) => item.id)).toEqual(["answer"]);
    expect(queued.visibleTurnItems.map(({ item }) => item.id)).toEqual(["answer"]);
    expect(workflow.activeRun).toBeNull();
  });
});
