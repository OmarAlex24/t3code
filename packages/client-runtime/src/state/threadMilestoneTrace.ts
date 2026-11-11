import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2Milestone,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";

import type { ThreadStructureTurnItem } from "./models.ts";
import { isActiveSubagentStatus } from "./subagentRuntime.ts";
import { MILESTONE_BOARD_ROOT, type MilestoneBoardItem } from "./threadMilestoneBoard.ts";
import {
  deriveThreadMilestoneGraph,
  type MilestoneCoordinator,
  type MilestoneGraphTurn,
} from "./threadMilestoneGraph.ts";
import { resolveActiveThreadRun } from "./threadWorkflows.ts";

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "subagents" | "milestones" | "messages"
>;
type Run = Projection["runs"][number];
type Subagent = OrchestrationV2Subagent;

/** Stretches where nothing ran for longer than this collapse to a break on the axis. */
const TRACE_IDLE_GAP_MS = 10 * 60_000;
const MIN_ESTIMATE_MS = 2 * 60_000;
const MIN_HEADROOM_MS = 60_000;

export type TraceAgentStatus = "done" | "running" | "needs-you" | "failed" | "queued" | "stopped";
export type TraceRowStatus = "done" | "active" | "planned" | "dropped" | "failed" | "stopped";

export interface TraceCounts {
  readonly done: number;
  readonly running: number;
  readonly needsYou: number;
  readonly failed: number;
  readonly queued: number;
  readonly stopped: number;
}

/** Times are epoch ms. `endMs` is null while the span still runs and ends at now. */
export interface TraceSpan {
  readonly startMs: number;
  readonly endMs: number | null;
}

export interface TraceAgent {
  readonly agent: Subagent;
  readonly status: TraceAgentStatus;
  /** Null for a queued agent that has not started. */
  readonly span: TraceSpan | null;
}

export interface TraceGroup {
  /** Null for agents the coordinator did not group. */
  readonly name: string | null;
  readonly agents: ReadonlyArray<TraceAgent>;
  readonly counts: TraceCounts;
  readonly span: TraceSpan | null;
}

interface TracePin {
  readonly id: string;
  readonly kind: "post" | "visual";
  readonly title: string;
  readonly atMs: number;
}

export interface TraceRow {
  /** The milestone id, the run id of a turn, or `root` for agents that ran before the plan. */
  readonly id: string;
  readonly title: string;
  readonly status: TraceRowStatus;
  readonly milestone: OrchestrationV2Milestone | null;
  /** False for a milestone of an earlier plan. */
  readonly current: boolean;
  /** Null for a row that has not started, or a dropped one that never ran. */
  readonly span: TraceSpan | null;
  /** Where a planned row would run, measured from now, by the average time a row took. */
  readonly estimate: { readonly offsetMs: number; readonly durationMs: number } | null;
  readonly groups: ReadonlyArray<TraceGroup>;
  readonly agentCount: number;
  /** The most agents that ran at the same time. */
  readonly peakParallel: number;
  readonly counts: TraceCounts;
  readonly pins: ReadonlyArray<TracePin>;
}

export interface ThreadTrace {
  readonly kind: "milestones" | "turns";
  /** The first line of the thread's first request. */
  readonly title: string | null;
  readonly rows: ReadonlyArray<TraceRow>;
  readonly coordinator: MilestoneCoordinator & {
    readonly runs: ReadonlyArray<TraceSpan>;
    /** The active run, else the latest one. */
    readonly run: Run | null;
  };
  /** Whether the coordinator or an agent still runs; only then does now move. */
  readonly live: boolean;
  /** Wall-clock now while live, else the last recorded moment. */
  readonly nowMs: number;
  readonly startMs: number;
  /** 1-based position of the active row, or how many are done, among counted rows. */
  readonly position: number;
  readonly total: number;
  readonly counts: TraceCounts;
  readonly agentCount: number;
  readonly firstFailed: { readonly rowId: string; readonly agentId: string } | null;
  readonly needsYou: ReadonlyArray<{
    readonly rowId: string;
    readonly group: string | null;
    readonly agent: Subagent;
  }>;
  /** Merged spans where the coordinator or an agent ran, for idle gaps. */
  readonly activity: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>;
}

export interface TraceDomain {
  readonly startMs: number;
  /** The real moment at the right edge, before planned estimates. */
  readonly endMs: number;
  /** A live chart is recomputed once now passes this; Infinity when nothing runs. */
  readonly horizonMs: number;
  /** Collapsed length of the axis in ms, planned estimates included. */
  readonly length: number;
  /** The real time at the left edge that tick labels count from. */
  readonly originMs: number;
  readonly gaps: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>;
}

const ms = (value: DateTime.Utc) => DateTime.toEpochMillis(value);
const msOrNull = (value: DateTime.Utc | null) => (value === null ? null : ms(value));
const firstLine = (text: string) => text.trim().split("\n")[0]?.trim() ?? "";

const zeroCounts = (): { -readonly [K in keyof TraceCounts]: number } => ({
  done: 0,
  running: 0,
  needsYou: 0,
  failed: 0,
  queued: 0,
  stopped: 0,
});

const COUNT_KEY: Record<TraceAgentStatus, keyof TraceCounts> = {
  done: "done",
  running: "running",
  "needs-you": "needsYou",
  failed: "failed",
  queued: "queued",
  stopped: "stopped",
};

function countAgents(agents: ReadonlyArray<TraceAgent>): TraceCounts {
  const counts = zeroCounts();
  for (const { status } of agents) counts[COUNT_KEY[status]] += 1;
  return counts;
}

function agentStatus(agent: Subagent, needsYou: ReadonlySet<string>): TraceAgentStatus {
  switch (agent.status) {
    case "completed":
    case "idle":
      return "done";
    case "running":
    case "waiting":
      return agent.childThreadId !== null && needsYou.has(agent.childThreadId)
        ? "needs-you"
        : "running";
    case "pending":
      return agent.startedAt === null ? "queued" : "running";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

function spanEnvelope(spans: ReadonlyArray<TraceSpan>): TraceSpan | null {
  if (spans.length === 0) return null;
  const startMs = Math.min(...spans.map((span) => span.startMs));
  const ends = spans.map((span) => span.endMs);
  return { startMs, endMs: ends.includes(null) ? null : Math.max(...(ends as Array<number>)) };
}

function peakParallel(spans: ReadonlyArray<TraceSpan>, nowMs: number): number {
  const edges = spans.flatMap(({ startMs, endMs }) => [
    [startMs, 1] as const,
    [Math.max(startMs, endMs ?? nowMs), -1] as const,
  ]);
  edges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let current = 0;
  let peak = 0;
  for (const [, step] of edges) {
    current += step;
    peak = Math.max(peak, current);
  }
  return peak;
}

function mergeSpans(
  spans: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>,
): ReadonlyArray<{ readonly startMs: number; readonly endMs: number }> {
  const sorted = copySorted(spans, (left, right) => left.startMs - right.startMs);
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && span.startMs <= last.endMs)
      last.endMs = Math.max(last.endMs, span.endMs);
    else merged.push({ ...span });
  }
  return merged;
}

function runTitle(projection: Projection, run: Run): string | null {
  const message = projection.messages.find(({ id }) => id === run.userMessageId);
  const line = message === undefined ? "" : firstLine(message.text);
  return line ? line : null;
}

/**
 * The thread on one time axis: a row per milestone (or per turn on a thread that never planned)
 * with its agents grouped as the coordinator grouped them, the coordinator's runs, and what
 * waits on you. `needsYou` holds the child threads that wait on an approval or answer.
 */
export function deriveThreadTrace(input: {
  readonly projection: Projection;
  readonly turnItems: ReadonlyArray<ThreadStructureTurnItem>;
  readonly boards: ReadonlyMap<string, ReadonlyArray<MilestoneBoardItem>>;
  readonly needsYou: ReadonlySet<string>;
  readonly nowMs: number;
}): ThreadTrace | null {
  const { projection } = input;
  const graph = deriveThreadMilestoneGraph(projection);
  if (graph.mode === "empty") return null;

  const activeRun = resolveActiveThreadRun(projection);
  const runs = copySorted(
    projection.runs.filter((run) => run.status !== "rolled_back"),
    (left, right) => left.ordinal - right.ordinal,
  );
  const live =
    activeRun !== null ||
    projection.subagents.some((agent) => isActiveSubagentStatus(agent.status));
  const recorded = [
    ...runs.flatMap((run) => [
      ms(run.requestedAt),
      msOrNull(run.startedAt),
      msOrNull(run.completedAt),
    ]),
    ...projection.subagents.flatMap((agent) => [
      msOrNull(agent.startedAt),
      msOrNull(agent.completedAt),
    ]),
    ...projection.milestones.flatMap((milestone) => [
      msOrNull(milestone.startedAt),
      msOrNull(milestone.completedAt),
    ]),
  ].filter((value) => value !== null);
  const newest = recorded.length === 0 ? input.nowMs : Math.max(...recorded);
  // A stopped thread ends at its last recorded moment, however long ago that was.
  const nowMs = live ? Math.max(input.nowMs, newest) : newest;

  const itemTimes = new Map<string, number>();
  for (const item of input.turnItems) {
    const at = item.completedAt ?? item.startedAt;
    if (at !== null) itemTimes.set(item.id, ms(at));
  }

  const traceAgent = (agent: Subagent): TraceAgent => {
    const status = agentStatus(agent, input.needsYou);
    const startMs = msOrNull(agent.startedAt);
    if (status === "queued" || startMs === null) return { agent, status, span: null };
    const live = status === "running" || status === "needs-you";
    return {
      agent,
      status,
      span: {
        startMs,
        endMs: live
          ? null
          : (msOrNull(agent.completedAt) ?? Math.max(startMs, ms(agent.updatedAt))),
      },
    };
  };

  const pinsOf = (boardKey: string): ReadonlyArray<TracePin> =>
    (input.boards.get(boardKey) ?? []).flatMap((item) => {
      const atMs = itemTimes.get(item.id);
      if (atMs === undefined || item.kind === "comment") return [];
      const title = item.kind === "visual" ? item.title : firstLine(item.text ?? "") || "Post";
      return [{ id: item.id, kind: item.kind, title, atMs }];
    });

  const draft = (fields: {
    readonly id: string;
    readonly title: string;
    readonly status: TraceRowStatus;
    readonly milestone: OrchestrationV2Milestone | null;
    readonly current: boolean;
    readonly span: TraceSpan | null;
    readonly agents: ReadonlyArray<Subagent>;
    readonly boardKey: string | null;
  }): TraceRow => {
    const agents = fields.agents.map(traceAgent);
    const groups = new Map<string | null, Array<TraceAgent>>();
    for (const agent of agents) {
      const key = agent.agent.group ?? null;
      groups.set(key, [...(groups.get(key) ?? []), agent]);
    }
    const spans = agents.flatMap(({ span }) => (span === null ? [] : [span]));
    return {
      id: fields.id,
      title: fields.title,
      status: fields.status,
      milestone: fields.milestone,
      current: fields.current,
      span: fields.span,
      estimate: null,
      groups: [...groups].map(([name, members]) => ({
        name,
        agents: members,
        counts: countAgents(members),
        span: spanEnvelope(members.flatMap(({ span }) => (span === null ? [] : [span]))),
      })),
      agentCount: agents.length,
      peakParallel: peakParallel(spans, nowMs),
      counts: countAgents(agents),
      pins: fields.boardKey === null ? [] : pinsOf(fields.boardKey),
    };
  };

  const liveEnd = (completedAt: DateTime.Utc | null, running: boolean, fallback: number) =>
    completedAt !== null ? ms(completedAt) : running ? (live ? null : nowMs) : fallback;

  let rows: Array<TraceRow>;
  if (graph.mode === "turns") {
    rows = graph.turns.map(({ run, agents }: MilestoneGraphTurn, index) => {
      const started = msOrNull(run.startedAt);
      const status: TraceRowStatus =
        run.status === "completed"
          ? "done"
          : run.status === "failed"
            ? "failed"
            : run.status === "interrupted" || run.status === "cancelled"
              ? "stopped"
              : started === null
                ? "planned"
                : "active";
      return draft({
        id: run.id,
        title: runTitle(projection, run) ?? `Turn ${index + 1}`,
        status,
        milestone: null,
        current: true,
        span:
          started === null
            ? null
            : { startMs: started, endMs: liveEnd(run.completedAt, status === "active", started) },
        agents,
        boardKey: null,
      });
    });
  } else {
    rows = [];
    if (graph.root !== null && graph.root.agents.length > 0) {
      const agents = graph.root.agents.map(traceAgent);
      const span = spanEnvelope(agents.flatMap(({ span }) => (span === null ? [] : [span])));
      rows.push(
        draft({
          id: MILESTONE_BOARD_ROOT,
          title: "Before the plan",
          status: agents.some(({ span }) => span !== null && span.endMs === null)
            ? "active"
            : "done",
          milestone: null,
          current: true,
          span,
          agents: graph.root.agents,
          boardKey: MILESTONE_BOARD_ROOT,
        }),
      );
    }
    for (const { milestone, agents, current } of graph.milestones) {
      const started = msOrNull(milestone.startedAt);
      // A milestone an earlier plan never finished was replaced along with that plan.
      const status: TraceRowStatus =
        !current && milestone.status !== "done" ? "dropped" : milestone.status;
      const droppedAt =
        milestone.anchors.dropped === undefined
          ? undefined
          : itemTimes.get(milestone.anchors.dropped.itemId);
      const span: TraceSpan | null =
        started !== null
          ? {
              startMs: started,
              endMs: liveEnd(milestone.completedAt, status === "active", droppedAt ?? started),
            }
          : status === "dropped" && droppedAt !== undefined
            ? { startMs: droppedAt, endMs: droppedAt }
            : null;
      rows.push(
        draft({
          id: milestone.id,
          title: milestone.title,
          status,
          milestone,
          current,
          span: status === "planned" ? null : span,
          agents,
          boardKey: milestone.id,
        }),
      );
    }
  }

  const coordinatorRuns = runs.flatMap((run): Array<TraceSpan> => {
    const started = msOrNull(run.startedAt);
    if (started === null) return [];
    return [{ startMs: started, endMs: liveEnd(run.completedAt, run === activeRun, started) }];
  });
  const startCandidates = [
    ...coordinatorRuns.map(({ startMs }) => startMs),
    ...rows.flatMap(({ span }) => (span === null ? [] : [span.startMs])),
  ];
  const startMs = startCandidates.length === 0 ? nowMs : Math.min(...startCandidates);

  const finished = rows.flatMap(({ status, span }) =>
    status === "done" && span !== null && span.endMs !== null ? [span.endMs - span.startMs] : [],
  );
  const estimateMs =
    finished.length > 0
      ? Math.max(1000, finished.reduce((sum, value) => sum + value, 0) / finished.length)
      : Math.max(MIN_ESTIMATE_MS, (nowMs - startMs) / 4);
  let offsetMs = 0;
  rows = rows.map((row) => {
    if (row.status !== "planned") return row;
    const estimate = { offsetMs, durationMs: estimateMs };
    offsetMs += estimateMs;
    return { ...row, estimate };
  });

  const activity = mergeSpans(
    [
      ...coordinatorRuns,
      ...rows.flatMap(({ groups }) =>
        groups.flatMap(({ agents }) => agents.flatMap(({ span }) => (span === null ? [] : [span]))),
      ),
    ].map((span) => ({ startMs: span.startMs, endMs: span.endMs ?? nowMs })),
  );

  const counted = rows.filter(
    ({ current, status, id }) => current && status !== "dropped" && id !== MILESTONE_BOARD_ROOT,
  );
  const activeIndex = counted.findIndex(({ status }) => status === "active");
  const allAgents = rows.flatMap(({ groups }) => groups.flatMap(({ agents }) => agents));
  const failedRow = rows.find(({ counts }) => counts.failed > 0);
  return {
    kind: graph.mode,
    title: runs[0] === undefined ? null : runTitle(projection, runs[0]),
    rows,
    coordinator: {
      ...graph.coordinator,
      runs: coordinatorRuns,
      run: activeRun ?? runs.at(-1) ?? null,
    },
    live,
    nowMs,
    startMs,
    position:
      graph.mode === "milestones"
        ? graph.summary.position
        : activeIndex === -1
          ? counted.filter(({ status }) => status !== "planned").length
          : activeIndex + 1,
    total: graph.mode === "milestones" ? graph.summary.total : counted.length,
    counts: countAgents(allAgents),
    agentCount: allAgents.length,
    firstFailed:
      failedRow === undefined
        ? null
        : {
            rowId: failedRow.id,
            agentId: failedRow.groups
              .flatMap(({ agents }) => agents)
              .find(({ status }) => status === "failed")!.agent.id,
          },
    needsYou: rows.flatMap((row) =>
      row.groups.flatMap((group) =>
        group.agents
          .filter(({ status }) => status === "needs-you")
          .map(({ agent }) => ({ rowId: row.id, group: group.name, agent })),
      ),
    ),
    activity,
  };
}

function buildDomain(input: {
  readonly trace: ThreadTrace;
  readonly startMs: number;
  readonly contentEndMs: number;
  readonly headroomMs: number;
  readonly plannedMs: number;
  readonly originMs: number;
}): TraceDomain {
  const { trace, startMs } = input;
  const endMs = Math.max(input.contentEndMs, startMs) + input.headroomMs;
  const gaps: Array<{ startMs: number; endMs: number }> = [];
  for (const [index, span] of trace.activity.entries()) {
    const next = trace.activity[index + 1];
    if (next === undefined) break;
    const gapStart = Math.max(span.endMs, startMs);
    const gapEnd = Math.min(next.startMs, endMs);
    if (gapEnd - gapStart > TRACE_IDLE_GAP_MS) gaps.push({ startMs: gapStart, endMs: gapEnd });
  }
  const removed = gaps.reduce((sum, gap) => sum + gap.endMs - gap.startMs, 0);
  return {
    startMs,
    endMs,
    horizonMs: trace.live ? endMs : Number.POSITIVE_INFINITY,
    length: Math.max(1000, endMs - startMs - removed + input.plannedMs),
    originMs: input.originMs,
    gaps,
  };
}

/** The whole thread, with headroom past now so a live chart is recomputed only now and then. */
export function threadTraceDomain(trace: ThreadTrace): TraceDomain {
  const span = trace.nowMs - trace.startMs;
  const plannedMs = trace.rows.reduce((sum, row) => sum + (row.estimate?.durationMs ?? 0), 0);
  return buildDomain({
    trace,
    startMs: trace.startMs,
    contentEndMs: trace.nowMs,
    headroomMs: trace.live ? Math.max(MIN_HEADROOM_MS, span * 0.15) : span * 0.03,
    plannedMs,
    originMs: trace.startMs,
  });
}

/** One row's own span, with labels counted from its start. Null for a row that never ran. */
export function traceRowDomain(trace: ThreadTrace, row: TraceRow): TraceDomain | null {
  if (row.span === null) return null;
  const agentEnds = row.groups.flatMap(({ agents }) =>
    agents.flatMap(({ span }) => (span === null ? [] : [span.endMs ?? trace.nowMs])),
  );
  const endMs = Math.max(row.span.endMs ?? trace.nowMs, ...agentEnds);
  const span = Math.max(1000, endMs - row.span.startMs);
  const running = row.span.endMs === null;
  return buildDomain({
    trace: running ? trace : { ...trace, live: false },
    startMs: row.span.startMs - span * 0.04,
    contentEndMs: endMs,
    headroomMs: running ? Math.max(MIN_HEADROOM_MS / 2, span * 0.18) : span * 0.06,
    plannedMs: 0,
    originMs: row.span.startMs,
  });
}

const collapsedAt = (domain: TraceDomain, atMs: number) => {
  const clamped = Math.max(domain.startMs, atMs);
  let removed = 0;
  for (const gap of domain.gaps) {
    if (clamped >= gap.endMs) removed += gap.endMs - gap.startMs;
    else if (clamped > gap.startMs) removed += clamped - gap.startMs;
  }
  return clamped - domain.startMs - removed;
};

/** Where `atMs` sits on the axis, from 0 to 1; idle gaps take no width. */
export function tracePosition(domain: TraceDomain, atMs: number): number {
  return Math.min(1, collapsedAt(domain, atMs) / domain.length);
}

/** A duration as a share of the axis, for planned estimates placed after now. */
export function traceFraction(domain: TraceDomain, durationMs: number): number {
  return durationMs / domain.length;
}

const TICK_STEPS = [
  5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400,
].map((seconds) => seconds * 1000);

/**
 * Tick marks at round collapsed steps, labelled with the real time since the origin, so a tick
 * after a gap counts the idle time too. Ticks crowding a gap break are left out.
 */
export function traceTicks(
  domain: TraceDomain,
): ReadonlyArray<{ readonly position: number; readonly elapsedMs: number }> {
  const step = TICK_STEPS.find((candidate) => domain.length / candidate <= 6) ?? 172_800_000;
  const gapPositions = domain.gaps.map((gap) => tracePosition(domain, gap.startMs));
  const originCollapsed = collapsedAt(domain, domain.originMs);
  const ticks: Array<{ position: number; elapsedMs: number }> = [];
  for (let value = originCollapsed + step; ; value += step) {
    if (value > domain.length) break;
    const position = value / domain.length;
    if (gapPositions.some((gap) => Math.abs(gap - position) < 0.1)) continue;
    let real = domain.startMs + value;
    for (const gap of domain.gaps) {
      if (collapsedAt(domain, gap.startMs) < value) real += gap.endMs - gap.startMs;
    }
    ticks.push({ position, elapsedMs: real - domain.originMs });
  }
  return ticks;
}

/** "45s", "3m 05s", "1h 20m". */
export function formatTraceDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Axis labels: "30s", "12m", "1h", "1h 20m". */
export function formatTraceClock(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}
