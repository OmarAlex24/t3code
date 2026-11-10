import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2Milestone,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";

import { commandDisplayText } from "../work-log/commandLabel.ts";
import type { ThreadStructureTurnItem } from "./models.ts";
import { isActiveSubagentStatus } from "./subagentRuntime.ts";
import { resolveActiveThreadRun } from "./threadWorkflows.ts";

type Projection = Pick<OrchestrationV2ThreadProjection, "runs" | "subagents" | "milestones">;
type Run = Projection["runs"][number];
type Subagent = OrchestrationV2Subagent;

/** A user turn on the spine, with the agents it started that no milestone claims. */
export interface MilestoneGraphTurn {
  readonly run: Run;
  readonly agents: ReadonlyArray<Subagent>;
}

export interface MilestoneGraphNode {
  readonly milestone: OrchestrationV2Milestone;
  readonly agents: ReadonlyArray<Subagent>;
  /** Turns the user started while this milestone was active, in order. */
  readonly turns: ReadonlyArray<MilestoneGraphTurn>;
}

export interface MilestoneGraphEarlierSet {
  readonly setId: OrchestrationV2Milestone["setId"];
  readonly milestones: ReadonlyArray<OrchestrationV2Milestone>;
  readonly agentCount: number;
}

export type MilestoneCoordinatorStatus = "working" | "waiting" | "idle" | "failed" | "interrupted";

export interface MilestoneCoordinator {
  readonly status: MilestoneCoordinatorStatus;
  readonly liveAgents: number;
}

export type ThreadMilestoneGraph =
  | { readonly mode: "empty" }
  | {
      readonly mode: "turns";
      readonly turns: ReadonlyArray<MilestoneGraphTurn>;
      readonly coordinator: MilestoneCoordinator;
    }
  | {
      readonly mode: "milestones";
      /** The first turn, with the agents that ran before any plan. */
      readonly root: MilestoneGraphTurn | null;
      readonly earlierSets: ReadonlyArray<MilestoneGraphEarlierSet>;
      readonly milestones: ReadonlyArray<MilestoneGraphNode>;
      readonly coordinator: MilestoneCoordinator;
      readonly summary: {
        /** 1-based position of the active milestone, or how many are done. */
        readonly position: number;
        readonly total: number;
        readonly changes: number;
        readonly startedAt: DateTime.Utc | null;
      };
    };

const startKey = (subagent: Subagent) =>
  DateTime.toEpochMillis(subagent.startedAt ?? subagent.updatedAt);

function coordinatorOf(projection: Projection, live: number): MilestoneCoordinator {
  if (resolveActiveThreadRun(projection) !== null) {
    return { status: live > 0 ? "waiting" : "working", liveAgents: live };
  }
  const latest = projection.runs.reduce<Run | null>(
    (current, run) =>
      run.status !== "rolled_back" && (current === null || run.ordinal > current.ordinal)
        ? run
        : current,
    null,
  );
  const status: MilestoneCoordinatorStatus =
    latest?.status === "failed"
      ? "failed"
      : latest?.status === "interrupted" || latest?.status === "cancelled"
        ? "interrupted"
        : "idle";
  return { status, liveAgents: live };
}

/** The milestone that was active when `at` happened, by its start and end. */
function milestoneActiveAt(
  milestones: ReadonlyArray<OrchestrationV2Milestone>,
  at: DateTime.Utc,
): OrchestrationV2Milestone | undefined {
  const time = DateTime.toEpochMillis(at);
  return milestones.findLast(
    (milestone) =>
      milestone.startedAt !== null && DateTime.toEpochMillis(milestone.startedAt) <= time,
  );
}

/**
 * The coordinator's spine: milestones with the agents and user turns that belong to each, or one
 * node per user turn on a thread that never planned. Subagents keep the milestone they were
 * stamped with; one whose milestone is gone (rolled back) falls to its turn.
 */
export function deriveThreadMilestoneGraph(projection: Projection): ThreadMilestoneGraph {
  const rolledBack = new Set(
    projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  const runs = copySorted(
    projection.runs.filter((run) => !rolledBack.has(run.id)),
    (left, right) => left.ordinal - right.ordinal,
  );
  const subagents = copySorted(
    projection.subagents.filter(
      (subagent) => subagent.runId === null || !rolledBack.has(subagent.runId),
    ),
    (left, right) => startKey(left) - startKey(right) || left.id.localeCompare(right.id),
  );
  const live = subagents.filter((subagent) => isActiveSubagentStatus(subagent.status)).length;
  const coordinator = coordinatorOf(projection, live);
  if (runs.length === 0 && projection.milestones.length === 0) return { mode: "empty" };

  const milestoneIds = new Set(projection.milestones.map((milestone) => milestone.id));
  const byMilestone = new Map<string, Array<Subagent>>();
  const byRun = new Map<string, Array<Subagent>>();
  for (const subagent of subagents) {
    if (subagent.milestoneId !== undefined && milestoneIds.has(subagent.milestoneId)) {
      byMilestone.set(subagent.milestoneId, [
        ...(byMilestone.get(subagent.milestoneId) ?? []),
        subagent,
      ]);
    } else if (subagent.runId !== null) {
      byRun.set(subagent.runId, [...(byRun.get(subagent.runId) ?? []), subagent]);
    }
  }
  const turnOf = (run: Run): MilestoneGraphTurn => ({ run, agents: byRun.get(run.id) ?? [] });

  if (projection.milestones.length === 0) {
    return { mode: "turns", turns: runs.map(turnOf), coordinator };
  }

  const currentSetId = projection.milestones.at(-1)!.setId;
  const current = projection.milestones.filter((milestone) => milestone.setId === currentSetId);
  const [rootRun, ...laterRuns] = runs;
  const turnsByMilestone = new Map<string, Array<MilestoneGraphTurn>>();
  const rootAgents = rootRun === undefined ? [] : [...turnOf(rootRun).agents];
  for (const run of laterRuns) {
    const owner = milestoneActiveAt(projection.milestones, run.requestedAt);
    if (owner === undefined) {
      rootAgents.push(...turnOf(run).agents);
    } else if (owner.setId === currentSetId) {
      turnsByMilestone.set(owner.id, [...(turnsByMilestone.get(owner.id) ?? []), turnOf(run)]);
    }
  }

  const earlierSets: Array<MilestoneGraphEarlierSet> = [];
  for (const milestone of projection.milestones) {
    if (milestone.setId === currentSetId) continue;
    const last = earlierSets.at(-1);
    const agentCount = byMilestone.get(milestone.id)?.length ?? 0;
    if (last?.setId === milestone.setId) {
      earlierSets[earlierSets.length - 1] = {
        ...last,
        milestones: [...last.milestones, milestone],
        agentCount: last.agentCount + agentCount,
      };
    } else {
      earlierSets.push({ setId: milestone.setId, milestones: [milestone], agentCount });
    }
  }

  const counted = current.filter((milestone) => milestone.status !== "dropped");
  const activeIndex = counted.findIndex((milestone) => milestone.status === "active");
  return {
    mode: "milestones",
    root: rootRun === undefined ? null : { run: rootRun, agents: rootAgents },
    earlierSets,
    milestones: current.map((milestone) => ({
      milestone,
      agents: byMilestone.get(milestone.id) ?? [],
      turns: turnsByMilestone.get(milestone.id) ?? [],
    })),
    coordinator,
    summary: {
      position:
        activeIndex === -1
          ? counted.filter((milestone) => milestone.status === "done").length
          : activeIndex + 1,
      total: counted.length,
      changes: current.filter((milestone) => milestone.revision !== undefined).length,
      startedAt: current[0]?.startedAt ?? rootRun?.startedAt ?? null,
    },
  };
}

/**
 * Relative widths for the plan strip: the time each milestone took, the active one's time so far,
 * and the average for those not started. A floor keeps an instant milestone visible and clickable.
 */
export function milestoneStripWeights(
  milestones: ReadonlyArray<Pick<OrchestrationV2Milestone, "startedAt" | "completedAt">>,
  nowMs: number,
): ReadonlyArray<number> {
  const spans = milestones.map(({ startedAt, completedAt }) =>
    startedAt === null
      ? null
      : Math.max(
          0,
          (completedAt === null ? nowMs : DateTime.toEpochMillis(completedAt)) -
            DateTime.toEpochMillis(startedAt),
        ),
  );
  const known = spans.filter((span) => span !== null);
  const typical =
    known.length === 0 ? 1 : known.reduce((sum, span) => sum + span, 0) / known.length || 1;
  const raw = spans.map((span) => span ?? typical);
  const floor = raw.reduce((sum, span) => sum + span, 0) * 0.1;
  return raw.map((span) => Math.max(span, floor));
}

const shortenPaths = (text: string) =>
  text.replace(/(?:~|\.{0,2})?(?:\/[^\s/]+)+\/([^\s/]+)/gu, "$1");
const firstLine = (text: string) => text.trim().split("\n")[0]?.trim() ?? "";

/**
 * What the coordinator is doing right now, from its latest running item: a short phrase for the
 * spine, or null when nothing of its own is running. Nested items belong to a subagent.
 */
export function deriveCoordinatorActivity(
  items: ReadonlyArray<ThreadStructureTurnItem>,
): string | null {
  const item = items.findLast(
    (candidate) => candidate.status === "running" && candidate.parentItemId === null,
  );
  switch (item?.type) {
    case "reasoning":
      return "Thinking";
    case "command_execution": {
      const command = firstLine(commandDisplayText(item.input));
      return command ? `Running ${command}` : "Running a command";
    }
    case "file_change":
      return `Editing ${shortenPaths(item.fileName)}`;
    case "file_search":
      return item.pattern ? `Searching for ${item.pattern}` : "Searching files";
    case "web_search":
      return "Searching the web";
    case "dynamic_tool": {
      const label = firstLine(item.title ?? item.toolName ?? "");
      return label ? shortenPaths(label) : null;
    }
    default:
      return null;
  }
}
