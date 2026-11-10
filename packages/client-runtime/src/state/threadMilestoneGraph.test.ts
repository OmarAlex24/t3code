import { describe, expect, it } from "vite-plus/test";
import {
  type OrchestrationV2Milestone,
  type OrchestrationV2Subagent,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deriveCoordinatorActivity,
  deriveThreadMilestoneGraph,
  milestoneStripWeights,
} from "./threadMilestoneGraph.ts";

const at = (minute: number) =>
  DateTime.makeUnsafe(`2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z`);

const run = (ordinal: number, status: string, minute: number) =>
  ({
    id: RunId.make(`run-${ordinal}`),
    ordinal,
    status,
    requestedAt: at(minute),
    startedAt: at(minute),
  }) as never;

function milestone(
  id: string,
  setId: string,
  status: OrchestrationV2Milestone["status"],
  minute: number | null,
  extra: Partial<OrchestrationV2Milestone> = {},
): OrchestrationV2Milestone {
  return {
    id,
    setId,
    title: `Milestone ${id}`,
    status,
    startedAt: minute === null ? null : at(minute),
    completedAt: status === "done" ? at((minute ?? 0) + 1) : null,
    anchors: { planned: { runId: RunId.make("run-1"), itemId: TurnItemId.make(`item-${id}`) } },
    ...extra,
  };
}

function subagent(
  id: string,
  runOrdinal: number,
  status: OrchestrationV2Subagent["status"],
  milestoneId?: string,
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make(`run-${runOrdinal}`),
    parentNodeId: NodeId.make("node-1"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: ThreadId.make(`child-${id}`),
    nativeTaskRef: null,
    prompt: id,
    title: id,
    model: null,
    status,
    result: null,
    startedAt: at(runOrdinal),
    completedAt: null,
    updatedAt: at(runOrdinal),
    ...(milestoneId === undefined ? {} : { milestoneId }),
  };
}

const ids = (agents: ReadonlyArray<{ readonly id: string }>) => agents.map(({ id }) => id);

describe("deriveThreadMilestoneGraph", () => {
  it("hangs agents off their milestone, and unstamped or orphaned ones off their turn", () => {
    const graph = deriveThreadMilestoneGraph({
      runs: [run(1, "running", 0), run(2, "completed", 6), run(3, "rolled_back", 7)],
      milestones: [
        milestone("m1", "s1", "done", 2, { note: "mapped" }),
        milestone("m2", "s1", "active", 5),
        milestone("m3", "s1", "planned", null, {
          revision: { previousTitle: "Old", reason: "why" },
        }),
      ],
      subagents: [
        subagent("scout", 1, "completed"),
        subagent("mapper", 1, "completed", "m1"),
        subagent("builder", 1, "running", "m2"),
        // m9 was rolled back: the agent falls back to its own turn.
        subagent("orphan", 2, "completed", "m9"),
        subagent("discarded", 3, "running", "m2"),
      ],
    });

    expect(graph.mode).toBe("milestones");
    if (graph.mode !== "milestones") return;
    expect(ids(graph.root!.agents)).toEqual(["scout"]);
    expect(graph.milestones.map((node) => ids(node.agents))).toEqual([["mapper"], ["builder"], []]);
    // The user's second turn landed while m2 was active.
    expect(graph.milestones[1]!.turns.map((turn) => [turn.run.id, ids(turn.agents)])).toEqual([
      ["run-2", ["orphan"]],
    ]);
    expect(graph.coordinator).toEqual({ status: "waiting", liveAgents: 1 });
    expect(graph.summary).toMatchObject({ position: 2, total: 3, changes: 1 });
  });

  it("collapses earlier sets and counts only the current one", () => {
    const graph = deriveThreadMilestoneGraph({
      runs: [run(1, "completed", 0)],
      milestones: [
        { ...milestone("m1", "s1", "done", 1), detailInTurnItem: true },
        { ...milestone("m2", "s1", "dropped", null), detailInTurnItem: true },
        milestone("m3", "s2", "done", 3),
        milestone("m4", "s2", "dropped", null),
        milestone("m5", "s2", "done", 4),
      ],
      subagents: [subagent("early", 1, "completed", "m1")],
    });

    if (graph.mode !== "milestones") throw new Error(graph.mode);
    expect(graph.earlierSets).toEqual([expect.objectContaining({ setId: "s1", agentCount: 1 })]);
    expect(graph.earlierSets[0]!.milestones.map(({ id }) => id)).toEqual(["m1", "m2"]);
    expect(graph.milestones.map(({ milestone }) => milestone.id)).toEqual(["m3", "m4", "m5"]);
    expect(graph.summary).toMatchObject({ position: 2, total: 2 });
    expect(graph.coordinator.status).toBe("idle");
  });

  it("falls back to one node per turn on a thread that never planned", () => {
    const graph = deriveThreadMilestoneGraph({
      runs: [run(2, "failed", 5), run(1, "completed", 0)],
      milestones: [],
      subagents: [subagent("a", 1, "completed"), subagent("b", 2, "failed")],
    });

    expect(graph).toMatchObject({ mode: "turns", coordinator: { status: "failed" } });
    if (graph.mode !== "turns") return;
    expect(graph.turns.map((turn) => [turn.run.id, ids(turn.agents)])).toEqual([
      ["run-1", ["a"]],
      ["run-2", ["b"]],
    ]);
    expect(deriveThreadMilestoneGraph({ runs: [], milestones: [], subagents: [] })).toEqual({
      mode: "empty",
    });
  });
});

describe("deriveCoordinatorActivity", () => {
  const item = (fields: Record<string, unknown>) =>
    ({ status: "running", parentItemId: null, title: null, ...fields }) as never;
  it.each([
    ["thinking", [item({ type: "reasoning" })], "Thinking"],
    [
      "a command, first line only",
      [item({ type: "command_execution", input: "vp test run src/a.test.ts\necho done" })],
      "Running vp test run src/a.test.ts",
    ],
    [
      "a tool, with paths cut to the file name",
      [item({ type: "dynamic_tool", toolName: "Read", title: "Read /home/user/app/src/auth.ts" })],
      "Read auth.ts",
    ],
    [
      "a file edit",
      [item({ type: "file_change", fileName: "/home/user/app/src/a.ts" })],
      "Editing a.ts",
    ],
    [
      "the latest running item",
      [item({ type: "reasoning" }), item({ type: "web_search" })],
      "Searching the web",
    ],
    ["nothing running", [item({ type: "reasoning", status: "completed" })], null],
    ["a subagent's nested item", [item({ type: "reasoning", parentItemId: "agent-1" })], null],
  ])("labels %s", (_case, items, expected) => {
    expect(deriveCoordinatorActivity(items)).toBe(expected);
  });
});

describe("milestoneStripWeights", () => {
  it("sizes milestones by time spent, the active one by time so far, and the rest by the average", () => {
    const now = DateTime.toEpochMillis(at(20));
    const weights = milestoneStripWeights(
      [
        milestone("m1", "s1", "done", 0, { completedAt: at(4) }),
        milestone("m2", "s1", "done", 4, { completedAt: at(12) }),
        milestone("m3", "s1", "active", 12),
        milestone("m4", "s1", "planned", null),
      ],
      now,
    ).map((weight) => weight / 60_000);
    expect(weights).toEqual([4, 8, 8, 20 / 3]);
  });

  it("keeps a sliver for a milestone that took no time", () => {
    const weights = milestoneStripWeights(
      [
        milestone("m1", "s1", "done", 0, { completedAt: at(0) }),
        milestone("m2", "s1", "done", 0, { completedAt: at(30) }),
      ],
      0,
    );
    expect(weights[0]).toBeGreaterThan(0);
    expect(weights[0]! / weights[1]!).toBeGreaterThan(0.09);
  });
});
