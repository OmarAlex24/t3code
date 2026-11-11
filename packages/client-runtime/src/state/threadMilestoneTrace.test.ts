import { describe, expect, it } from "vite-plus/test";
import {
  type OrchestrationV2Milestone,
  type OrchestrationV2Subagent,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deriveThreadTrace,
  threadTraceDomain,
  traceFraction,
  tracePosition,
  traceRowDomain,
  traceTicks,
} from "./threadMilestoneTrace.ts";

const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const MIN = 60_000;
const at = (minute: number) => DateTime.makeUnsafe(T0 + minute * MIN);

type Span = readonly [number, number | null];

const run = (
  ordinal: number,
  [start, end]: Span,
  status = end === null ? "running" : "completed",
) =>
  ({
    id: RunId.make(`run-${ordinal}`),
    ordinal,
    status,
    userMessageId: MessageId.make(`msg-${ordinal}`),
    providerInstanceId: ProviderInstanceId.make("claude"),
    requestedAt: at(start),
    startedAt: at(start),
    completedAt: end === null ? null : at(end),
  }) as never;

function milestone(
  id: string,
  status: OrchestrationV2Milestone["status"],
  span: Span | null,
  extra: Partial<OrchestrationV2Milestone> = {},
): OrchestrationV2Milestone {
  return {
    id,
    setId: "s1",
    title: `Milestone ${id}`,
    status,
    startedAt: span === null ? null : at(span[0]),
    completedAt: span === null || span[1] === null ? null : at(span[1]),
    anchors: {},
    ...extra,
  } as OrchestrationV2Milestone;
}

function agent(
  id: string,
  status: OrchestrationV2Subagent["status"],
  span: Span | null,
  extra: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
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
    startedAt: span === null ? null : at(span[0]),
    completedAt: span === null || span[1] === null ? null : at(span[1]),
    updatedAt: at(span?.[1] ?? span?.[0] ?? 0),
    ...extra,
  } as OrchestrationV2Subagent;
}

function trace(input: {
  readonly runs: ReadonlyArray<unknown>;
  readonly milestones?: ReadonlyArray<OrchestrationV2Milestone>;
  readonly subagents?: ReadonlyArray<OrchestrationV2Subagent>;
  readonly messages?: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  readonly turnItems?: ReadonlyArray<unknown>;
  readonly needsYou?: ReadonlyArray<string>;
  readonly now: number;
}) {
  const result = deriveThreadTrace({
    projection: {
      runs: input.runs,
      milestones: input.milestones ?? [],
      subagents: input.subagents ?? [],
      messages: input.messages ?? [],
    } as never,
    turnItems: (input.turnItems ?? []) as never,
    boards: new Map(),
    needsYou: new Set(input.needsYou ?? []),
    nowMs: T0 + input.now * MIN,
  });
  if (result === null) throw new Error("expected a trace");
  return result;
}

const minutes = (value: number) => Math.round((value / MIN) * 1000) / 1000;

describe("threadTraceDomain", () => {
  it.each([
    {
      name: "collapses an 80 minute idle stretch and labels ticks after it with real time",
      runs: [run(1, [0, 10]), run(2, [90, 100])],
      gaps: [[10, 90]],
      // 100 minutes, 80 idle, plus 3% headroom on a stopped thread.
      length: 23,
      ticks: [5, 95, 100],
    },
    {
      name: "keeps a 9 minute pause on the axis",
      runs: [run(1, [0, 10]), run(2, [19, 30])],
      gaps: [],
      length: 30.9,
      ticks: [10, 20, 30],
    },
  ])("$name", ({ runs, gaps, length, ticks }) => {
    const domain = threadTraceDomain(trace({ runs, now: 500 }));
    expect(domain.gaps.map((gap) => [minutes(gap.startMs - T0), minutes(gap.endMs - T0)])).toEqual(
      gaps,
    );
    expect(minutes(domain.length)).toBe(length);
    expect(traceTicks(domain).map(({ elapsedMs }) => minutes(elapsedMs))).toEqual(ticks);
    for (const [start, end] of gaps) {
      expect(tracePosition(domain, T0 + start! * MIN)).toBe(tracePosition(domain, T0 + end! * MIN));
    }
  });

  it("draws a milestone across a collapsed gap from its real start to its real end", () => {
    const result = trace({
      runs: [run(1, [0, 10]), run(2, [90, 100])],
      milestones: [milestone("m1", "done", [5, 95])],
      now: 100,
    });
    const domain = threadTraceDomain(result);
    const { span } = result.rows[0]!;
    const width = tracePosition(domain, span!.endMs!) - tracePosition(domain, span!.startMs);
    expect(minutes(width * domain.length)).toBe(10);
  });

  it.each([
    {
      name: "a live thread gets 15% headroom past now",
      runs: [run(1, [0, null])],
      now: 40,
      expected: { nowMin: 40, horizonMin: 46 },
    },
    {
      name: "a short live thread gets at least a minute",
      runs: [run(1, [0, null])],
      now: 2,
      expected: { nowMin: 2, horizonMin: 3 },
    },
    {
      name: "a clock behind the data counts from the newest record",
      runs: [run(1, [0, null]), run(2, [30, 50], "completed")],
      now: 20,
      expected: { nowMin: 50, horizonMin: 57.5 },
    },
    {
      name: "a thread stopped a day ago ends at its last record and never recomputes",
      runs: [run(1, [0, 20], "interrupted")],
      now: 24 * 60,
      expected: { nowMin: 20, horizonMin: Number.POSITIVE_INFINITY },
    },
  ])("$name", ({ runs, now, expected }) => {
    const result = trace({ runs, now });
    const domain = threadTraceDomain(result);
    expect({
      nowMin: minutes(result.nowMs - T0),
      horizonMin: Number.isFinite(domain.horizonMs)
        ? minutes(domain.horizonMs - T0)
        : domain.horizonMs,
    }).toEqual(expected);
  });

  it("rescales a zoomed milestone to its own span, with labels from its start", () => {
    const result = trace({
      runs: [run(1, [0, 60])],
      milestones: [milestone("m1", "done", [0, 10]), milestone("m2", "done", [10, 60])],
      now: 60,
    });
    // A finished milestone ends at its own end, not at the thread's now.
    expect(minutes(traceRowDomain(result, result.rows[0]!)!.endMs - T0)).toBe(10.6);
    const domain = traceRowDomain(result, result.rows[1]!)!;
    expect(minutes(domain.originMs - T0)).toBe(10);
    expect(tracePosition(domain, T0 + 10 * MIN)).toBeCloseTo(0.04 / 1.1);
    expect(traceTicks(domain).map(({ elapsedMs }) => minutes(elapsedMs))).toEqual([
      10, 20, 30, 40, 50,
    ]);
  });
});

describe("deriveThreadTrace", () => {
  it.each([
    {
      name: "the mean of done milestones",
      milestones: [
        milestone("m1", "done", [0, 4]),
        milestone("m2", "done", [4, 12]),
        milestone("m3", "active", [12, null]),
        milestone("m4", "planned", null),
        milestone("m5", "planned", null),
      ],
      estimates: [null, null, null, [0, 6], [6, 6]],
    },
    {
      name: "a quarter of the elapsed time when nothing is done yet",
      milestones: [milestone("m1", "active", [0, null]), milestone("m2", "planned", null)],
      estimates: [null, [0, 10]],
    },
  ])("estimates planned milestones from $name", ({ milestones, estimates }) => {
    const result = trace({ runs: [run(1, [0, null])], milestones, now: 40 });
    expect(
      result.rows.map(({ estimate }) =>
        estimate === null ? null : [minutes(estimate.offsetMs), minutes(estimate.durationMs)],
      ),
    ).toEqual(estimates);
    const domain = threadTraceDomain(result);
    expect(minutes(domain.length)).toBe(
      minutes(domain.endMs - domain.startMs) +
        estimates.reduce((sum, value) => sum + (value?.[1] ?? 0), 0),
    );
    expect(traceFraction(domain, domain.length)).toBe(1);
  });

  it.each([
    {
      name: "named groups in order of first start",
      agents: [
        agent("api", "completed", [1, 5], { group: "Backend" }),
        agent("page", "running", [2, null], { group: "UI" }),
        agent("db", "failed", [3, 4], { group: "Backend" }),
        agent("pdf", "waiting", [4, null], { group: "UI" }),
        agent("e2e", "pending", null, { group: "Tests", updatedAt: at(9) }),
      ],
      groups: [
        ["Backend", ["api", "db"], { done: 1, failed: 1 }],
        ["UI", ["page", "pdf"], { running: 1, needsYou: 1 }],
        ["Tests", ["e2e"], { queued: 1 }],
      ],
      // db ends as pdf starts, so at most three ran at once.
      peak: 3,
    },
    {
      name: "ungrouped agents alone",
      agents: [agent("a", "completed", [1, 3]), agent("b", "completed", [4, 6])],
      groups: [[null, ["a", "b"], { done: 2 }]],
      peak: 1,
    },
    {
      name: "ungrouped agents beside named ones",
      agents: [
        agent("solo", "completed", [1, 3]),
        agent("ui", "cancelled", [2, 5], { group: "UI" }),
      ],
      groups: [
        [null, ["solo"], { done: 1 }],
        ["UI", ["ui"], { stopped: 1 }],
      ],
      peak: 2,
    },
  ])("groups agents: $name", ({ agents, groups, peak }) => {
    const result = trace({
      runs: [run(1, [0, null])],
      milestones: [milestone("m1", "active", [0, null])],
      subagents: agents.map(
        (entry) => ({ ...entry, milestoneId: "m1" }) as OrchestrationV2Subagent,
      ),
      needsYou: ["child-pdf"],
      now: 10,
    });
    const [row] = result.rows;
    const zero = { done: 0, running: 0, needsYou: 0, failed: 0, queued: 0, stopped: 0 };
    expect(
      row!.groups.map((group) => [
        group.name,
        group.agents.map(({ agent }) => agent.id),
        group.counts,
      ]),
    ).toEqual(groups.map(([name, ids, counts]) => [name, ids, { ...zero, ...(counts as object) }]));
    expect(row!.peakParallel).toBe(peak);
    expect(row!.agentCount).toBe(agents.length);
  });

  it("points at the first failed agent and lists agents waiting on you", () => {
    const result = trace({
      runs: [run(1, [0, null])],
      milestones: [milestone("m1", "done", [0, 5]), milestone("m2", "active", [5, null])],
      subagents: [
        agent("ok", "completed", [1, 2], { milestoneId: "m1" }),
        agent("broke", "failed", [6, 7], { milestoneId: "m2", group: "Backend" }),
        agent("asks", "waiting", [6, null], { milestoneId: "m2", group: "UI" }),
      ],
      needsYou: ["child-asks"],
      now: 10,
    });
    expect(result.firstFailed).toEqual({ rowId: "m2", agentId: "broke" });
    expect(result.needsYou.map(({ rowId, group, agent }) => [rowId, group, agent.id])).toEqual([
      ["m2", "UI", "asks"],
    ]);
    expect(result.counts).toMatchObject({ done: 1, failed: 1, needsYou: 1 });
    expect([result.position, result.total]).toEqual([2, 2]);
  });

  it("lays out one row per turn on a thread that never planned", () => {
    const result = trace({
      runs: [run(1, [0, 6]), run(2, [9, null]), run(3, [12, 12], "failed")],
      messages: [{ id: "msg-1", text: "Fix the flaky checkout test\nIt fails one in five runs" }],
      subagents: [agent("retry", "completed", [1, 3])],
      now: 12.5,
    });
    expect(result.kind).toBe("turns");
    expect(result.title).toBe("Fix the flaky checkout test");
    expect(result.rows.map(({ title, status, agentCount }) => [title, status, agentCount])).toEqual(
      [
        ["Fix the flaky checkout test", "done", 1],
        ["Turn 2", "active", 0],
        ["Turn 3", "failed", 0],
      ],
    );
    expect([result.position, result.total]).toEqual([2, 3]);
  });

  it("keeps earlier plans and dropped milestones as rows", () => {
    const dropItem = TurnItemId.make("drop-m4");
    const result = trace({
      runs: [run(1, [0, null])],
      milestones: [
        milestone("m1", "done", [0, 3], { setId: "s1" } as never),
        milestone("m2", "active", [3, null], { setId: "s1" } as never),
        milestone("m3", "active", [6, null], { setId: "s2" } as never),
        milestone("m4", "dropped", null, {
          setId: "s2",
          anchors: { dropped: { runId: RunId.make("run-1"), itemId: dropItem } },
        } as never),
        milestone("m5", "planned", null, { setId: "s2" } as never),
      ],
      turnItems: [{ id: dropItem, startedAt: at(8), completedAt: at(8) }],
      now: 10,
    });
    expect(
      result.rows.map(({ id, status, current, span }) => [
        id,
        status,
        current,
        span === null
          ? null
          : [minutes(span.startMs - T0), span.endMs === null ? null : minutes(span.endMs - T0)],
      ]),
    ).toEqual([
      ["m1", "done", false, [0, 3]],
      // The replaced plan's unfinished milestone shows as dropped where it stopped.
      ["m2", "dropped", false, [3, 3]],
      ["m3", "active", true, [6, null]],
      ["m4", "dropped", true, [8, 8]],
      ["m5", "planned", true, null],
    ]);
    expect([result.position, result.total]).toEqual([1, 2]);
  });
});
