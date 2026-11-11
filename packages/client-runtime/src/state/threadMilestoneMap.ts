import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2LatestActionSummary,
  OrchestrationV2Milestone,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";
import { fileBasename } from "@t3tools/shared/path";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";

import type { ThreadStructureTurnItem } from "./models.ts";
import { plainSubagentDetail, subagentDetailPreview } from "./subagentDisplay.ts";
import { isActiveSubagentStatus } from "./subagentRuntime.ts";
import { MILESTONE_BOARD_ROOT } from "./threadMilestoneBoard.ts";
import { deriveThreadMilestoneGraph } from "./threadMilestoneGraph.ts";
import { resolveActiveThreadRun } from "./threadWorkflows.ts";

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "subagents" | "milestones" | "messages"
>;
type Run = Projection["runs"][number];
type Subagent = OrchestrationV2Subagent;
type MilestoneItem = Extract<ThreadStructureTurnItem, { readonly type: "milestone" }>;

export interface GraphMilestone {
  readonly id: string;
  readonly setId: string;
  /** In its set's plan; false for one the coordinator started by title. */
  readonly planned: boolean;
  /** Dropped, or left over from a plan that a new one replaced. */
  readonly dropped: boolean;
  readonly startMs: number | null;
}

export interface GraphSet {
  readonly id: string;
  /** The milestone that was current when this plan replaced the last one. */
  readonly from: string | null;
  /** What you wrote that started this plan, when you did. */
  readonly you: string | null;
}

export interface GraphNode {
  readonly kind: "you" | "milestone";
  readonly id: string;
  readonly row: number;
  readonly col: number;
  /** Your message, for a `you` node. */
  readonly text: string | null;
}

export type GraphEdgeStyle = "live" | "future" | "dropped";

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly style: GraphEdgeStyle;
}

interface Lane {
  readonly key: string;
  readonly kind: "plan" | "detour";
  readonly setId: string;
  readonly from: string | null;
  readonly members: Array<GraphNode & { row: number }>;
  col: number;
  parent: string | null;
}

/**
 * Rows in the order work started, the first plan on lane 0. Work outside the plan branches one lane
 * out and rejoins at the plan's next milestone; a new plan forks from the milestone that was
 * current into the first free lane other than its parent's. Leftovers of an abandoned plan sit one
 * row past the work that replaced them, and the latest plan's unstarted milestones go last.
 */
export function layoutMilestoneGraph(input: {
  /** In creation order. */
  readonly milestones: ReadonlyArray<GraphMilestone>;
  /** In order; the first is the first plan. */
  readonly sets: ReadonlyArray<GraphSet>;
  /** Your first message, shown above the first plan. */
  readonly request: string | null;
  /** A node for the work done before any plan, right after your first message. */
  readonly before?: string | null;
}): { readonly nodes: ReadonlyArray<GraphNode>; readonly edges: ReadonlyArray<GraphEdge> } {
  const { milestones, sets } = input;
  const setById = new Map(sets.map((set) => [set.id, set]));
  const byId = new Map(milestones.map((milestone) => [milestone.id, milestone]));
  const lanes = new Map<string, Lane>();
  const laneOf = new Map<string, Lane>();
  const lane = (key: string, kind: Lane["kind"], setId: string, from: string | null) => {
    let existing = lanes.get(key);
    if (existing === undefined) {
      existing = { key, kind, setId, from, members: [], col: 0, parent: null };
      lanes.set(key, existing);
    }
    return existing;
  };
  const planLane = (setId: string) => lane(`P:${setId}`, "plan", setId, null);

  const started = copySorted(
    milestones.filter((milestone) => milestone.startMs !== null),
    (left, right) => left.startMs! - right.startMs!,
  );
  let detour: Lane | null = null;
  started.forEach((milestone, index) => {
    const previous = started[index - 1] ?? null;
    if (milestone.planned) {
      detour = null;
      laneOf.set(milestone.id, planLane(milestone.setId));
      return;
    }
    if (
      detour === null ||
      detour.setId !== milestone.setId ||
      (previous !== null && laneOf.get(previous.id) !== detour)
    ) {
      detour = lane(`D:${milestone.id}`, "detour", milestone.setId, previous?.id ?? null);
    }
    laneOf.set(milestone.id, detour);
  });
  for (const milestone of milestones) {
    if (milestone.startMs === null) laneOf.set(milestone.id, planLane(milestone.setId));
  }

  const latestSetId = sets.at(-1)?.id ?? null;
  const slots = [...started];
  for (const candidate of lanes.values()) {
    const pending = milestones.filter(
      (milestone) => milestone.startMs === null && laneOf.get(milestone.id) === candidate,
    );
    if (pending.length === 0) continue;
    if (candidate.setId === latestSetId) {
      slots.push(...pending);
      continue;
    }
    const anchor = Math.max(
      -1,
      ...slots.flatMap((slot, index) => (laneOf.get(slot.id) === candidate ? [index] : [])),
    );
    slots.splice(Math.min(slots.length, anchor + 2), 0, ...pending);
  }

  const firstSetId = sets[0]?.id ?? milestones[0]?.setId ?? "s1";
  const first = planLane(firstSetId);
  const placed: Array<{ node: GraphNode & { row: number }; lane: Lane }> = [];
  const place = (kind: GraphNode["kind"], id: string, text: string | null, into: Lane) => {
    const node = { kind, id, row: placed.length, col: 0, text };
    placed.push({ node, lane: into });
    into.members.push(node);
  };
  if (input.request !== null) place("you", "you", input.request, first);
  if (input.before != null) place("milestone", input.before, null, first);
  const seenSets = new Set<string>();
  for (const milestone of slots) {
    const into = laneOf.get(milestone.id)!;
    if (into.kind === "plan" && !seenSets.has(milestone.setId)) {
      seenSets.add(milestone.setId);
      const you = setById.get(milestone.setId)?.you ?? null;
      if (you !== null) place("you", `you-${milestone.setId}`, you, into);
    }
    place("milestone", milestone.id, null, into);
  }

  const occupied = new Map<number, Array<readonly [number, number]>>();
  const span = (candidate: Lane): readonly [number, number] => [
    Math.min(...candidate.members.map(({ row }) => row)),
    Math.max(...candidate.members.map(({ row }) => row)),
  ];
  const free = (col: number, [start, end]: readonly [number, number]) =>
    (occupied.get(col) ?? []).every(([from, to]) => end < from || start > to);
  const take = (candidate: Lane, col: number) => {
    candidate.col = col;
    occupied.set(col, [...(occupied.get(col) ?? []), span(candidate)]);
  };
  const placedLanes = [...lanes.values()].filter((candidate) => candidate.members.length > 0);
  if (first.members.length > 0) take(first, 0);
  for (const candidate of copySorted(
    placedLanes,
    (left, right) => span(left)[0] - span(right)[0],
  )) {
    if (candidate === first) continue;
    const parentId =
      candidate.kind === "detour" ? candidate.from : (setById.get(candidate.setId)?.from ?? null);
    candidate.parent = parentId !== null && laneOf.has(parentId) ? parentId : null;
    const parentCol = candidate.parent === null ? 0 : laneOf.get(candidate.parent)!.col;
    let col = candidate.kind === "plan" ? 0 : parentCol + 1;
    while (!free(col, span(candidate)) || (candidate.kind === "plan" && col === parentCol)) col++;
    take(candidate, col);
  }

  const nodes = placed.map(({ node, lane: owner }) => ({ ...node, col: owner.col }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const styleOf = (node: GraphNode): GraphEdgeStyle => {
    if (node.kind === "you") return "live";
    const milestone = byId.get(node.id);
    if (milestone === undefined) return "live";
    return milestone.startMs !== null ? "live" : milestone.dropped ? "dropped" : "future";
  };
  const edges: Array<GraphEdge> = [];
  const link = (from: string, to: GraphNode) => edges.push({ from, to: to.id, style: styleOf(to) });
  for (const candidate of placedLanes) {
    const members = candidate.members.map(({ id }) => nodeById.get(id)!);
    for (let index = 1; index < members.length; index++) {
      link(members[index - 1]!.id, members[index]!);
    }
    if (candidate !== first && candidate.parent !== null) link(candidate.parent, members[0]!);
    if (candidate.kind === "detour") {
      const last = members.at(-1)!;
      const next = placedLanes
        .find((home) => home.kind === "plan" && home.setId === candidate.setId)
        ?.members.find(
          (member) =>
            member.row > last.row &&
            member.kind === "milestone" &&
            byId.get(member.id)?.dropped === false,
        );
      const forks = sets.some((set) => set.from === last.id);
      if (next !== undefined && !forks) link(last.id, nodeById.get(next.id)!);
    }
  }
  return { nodes, edges };
}

export type MapStatus =
  | "running"
  | "done"
  | "needs-you"
  | "failed"
  | "planned"
  | "dropped"
  | "stopped";

export type AgentAsk =
  | { readonly kind: "secret"; readonly label: string }
  | { readonly kind: "approval"; readonly command: string | null }
  | { readonly kind: "input" };

export interface MapAgent {
  readonly agent: Subagent;
  readonly status: MapStatus;
  readonly ask: AgentAsk | null;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly children: ReadonlyArray<MapAgent>;
}

export interface MapGroup {
  readonly name: string | null;
  readonly agents: ReadonlyArray<MapAgent>;
  readonly done: number;
  readonly total: number;
  /** Two or more of its agents ran at the same time. */
  readonly parallel: boolean;
}

export type MapRollupTone = "needs-you" | "running" | "none" | "failed" | "done";

export interface MapMilestone {
  readonly kind: "milestone";
  readonly id: string;
  readonly row: number;
  readonly col: number;
  /** Null for a turn on a thread that never planned, and for the work before the first plan. */
  readonly milestone: OrchestrationV2Milestone | null;
  readonly title: string;
  readonly subtitle: string;
  readonly status: MapStatus;
  readonly started: boolean;
  /** Why it was dropped. */
  readonly why: string | null;
  readonly revision: { readonly previousTitle: string; readonly reason: string } | null;
  /** The milestone's result, or the turn's last reply. */
  readonly note: string | null;
  /** Live: the coordinator is working on it now, so its line follows the coordinator. */
  readonly live: boolean;
  readonly rollup: { readonly tone: MapRollupTone; readonly text: string };
  readonly groups: ReadonlyArray<MapGroup>;
  readonly agentCount: number;
  readonly drivers: ReadonlyArray<ProviderDriverKind>;
  readonly startMs: number | null;
  readonly endMs: number | null;
}

export interface MapBubble {
  readonly kind: "you";
  readonly id: string;
  readonly row: number;
  readonly col: number;
  readonly text: string;
}

export interface MilestoneMap {
  readonly mode: "milestones" | "turns";
  readonly title: string | null;
  readonly nodes: ReadonlyArray<MapMilestone | MapBubble>;
  readonly edges: ReadonlyArray<GraphEdge>;
  readonly maxCol: number;
  readonly live: boolean;
  readonly coordinatorRun: Run | null;
  readonly stats: {
    readonly done: number;
    readonly total: number;
    readonly agents: number;
    readonly running: number;
    readonly needsYou: number;
    /** Null only when nothing has run yet. */
    readonly startMs: number | null;
    /** Null while the thread is live. */
    readonly endMs: number | null;
  };
}

const ms = (value: DateTime.Utc) => DateTime.toEpochMillis(value);
const msOrNull = (value: DateTime.Utc | null) => (value === null ? null : ms(value));
const firstLine = (text: string) => text.trim().split("\n")[0]?.trim() ?? "";
const plainNote = (text: string | null) =>
  text === null ? null : plainSubagentDetail(text) || null;
const plural = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;
const NEW_PLAN_GAP_MS = 10 * 60_000;
/** The node for agents that ran before the first plan. */
export const BEFORE_PLAN_NODE_ID = MILESTONE_BOARD_ROOT;

export const flattenAgents = (agents: ReadonlyArray<MapAgent>): ReadonlyArray<MapAgent> =>
  agents.flatMap((agent) => [agent, ...flattenAgents(agent.children)]);

/** Where an agent's own thread lives: here, or in the linked environment it was delegated to. */
export function agentThreadRef(
  agent: Subagent,
  environmentId: EnvironmentId,
): ScopedThreadRef | null {
  if (agent.remoteChild !== undefined) {
    return scopeThreadRef(agent.remoteChild.environmentId, agent.remoteChild.threadId);
  }
  return agent.childThreadId === null ? null : scopeThreadRef(environmentId, agent.childThreadId);
}

/**
 * An agent's one line: its ask while it needs you, else what it did last, else its result (its
 * progress while it runs) as plain text.
 */
export function agentLine(
  ask: AgentAsk | null,
  latestAction: Pick<OrchestrationV2LatestActionSummary, "summary" | "detail"> | null | undefined,
  agent: Pick<Subagent, "status" | "result" | "progress">,
  workspaceRoot?: string | null,
): string | null {
  if (ask !== null) {
    switch (ask.kind) {
      case "secret":
        return `Asks you for ${ask.label}`;
      case "approval":
        return ask.command === null ? "Wants your approval" : `Wants to run ${ask.command}`;
      case "input":
        return "Has a question for you";
    }
  }
  const plain = (text: string | null | undefined) =>
    text == null ? null : plainSubagentDetail(text);
  return (
    actionLine(latestAction, workspaceRoot) ??
    subagentDetailPreview({
      status: agent.status,
      result: plain(agent.result),
      progress: plain(agent.progress),
    })
  );
}

/** A thread's latest step, with paths under its workspace shown as `<workspace>/<relative>`. */
export function actionLine(
  action: Pick<OrchestrationV2LatestActionSummary, "summary" | "detail"> | null | undefined,
  workspaceRoot?: string | null,
): string | null {
  if (action == null) return null;
  const line =
    action.detail === undefined ? action.summary : `${action.summary} · ${action.detail}`;
  const root = workspaceRoot?.replace(/[/\\]+$/, "");
  return root ? line.replaceAll(`${root}/`, `${fileBasename(root)}/`) : line;
}

function agentStatus(agent: Subagent, ask: AgentAsk | null): MapStatus {
  switch (agent.status) {
    case "completed":
    case "idle":
      return "done";
    case "running":
    case "waiting":
      return ask === null ? "running" : "needs-you";
    case "pending":
      return agent.startedAt === null ? "planned" : "running";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

function overlaps(agents: ReadonlyArray<MapAgent>): boolean {
  return agents.some((left, index) =>
    agents.some(
      (right, other) =>
        other > index &&
        left.startMs !== null &&
        right.startMs !== null &&
        left.startMs < (right.endMs ?? Infinity) &&
        right.startMs < (left.endMs ?? Infinity),
    ),
  );
}

/** Agents nested by their real parent link, in start order. */
function buildAgents(
  subagents: ReadonlyArray<Subagent>,
  asks: ReadonlyMap<string, AgentAsk>,
  environmentId: EnvironmentId,
): ReadonlyArray<MapAgent> {
  const ids = new Set(subagents.map(({ id }) => id));
  const build = (agent: Subagent): MapAgent => {
    const ref = agentThreadRef(agent, environmentId);
    const ask = ref === null ? null : (asks.get(scopedThreadKey(ref)) ?? null);
    const status = agentStatus(agent, ask);
    const startMs = msOrNull(agent.startedAt);
    const live = status === "running" || status === "needs-you";
    const endMs = live
      ? null
      : (msOrNull(agent.completedAt) ?? (startMs === null ? null : ms(agent.updatedAt)));
    return {
      agent,
      status,
      ask,
      startMs,
      endMs,
      children: subagents.filter((child) => child.parentNodeId === agent.id).map(build),
    };
  };
  return subagents.filter((agent) => !ids.has(agent.parentNodeId)).map(build);
}

function groupsOf(agents: ReadonlyArray<MapAgent>): ReadonlyArray<MapGroup> {
  const groups = new Map<string, Array<MapAgent>>();
  for (const agent of agents) {
    const key = agent.agent.group ?? "";
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  return [...groups].map(([name, members]) => {
    const all = flattenAgents(members);
    return {
      name: name === "" ? null : name,
      agents: members,
      done: all.filter(({ status }) => status === "done").length,
      total: all.length,
      parallel: members.length > 1 && overlaps(members),
    };
  });
}

function rollup(status: MapStatus, agents: ReadonlyArray<MapAgent>): MapMilestone["rollup"] {
  const all = flattenAgents(agents);
  if (status === "running" || status === "needs-you") {
    const needs = all.filter(({ status }) => status === "needs-you").length;
    if (needs > 0) return { tone: "needs-you", text: `${needs} need${needs === 1 ? "s" : ""} you` };
    const running = all.filter((agent) => agent.status === "running").length;
    return {
      tone: "running",
      text: all.length > 0 ? `${running} of ${all.length} running` : "Working",
    };
  }
  if (all.length === 0) return { tone: "none", text: "No agents" };
  const failed = all.filter((agent) => agent.status === "failed").length;
  if (failed > 0) {
    return { tone: "failed", text: `${failed} failed · ${plural(all.length, "agent")}` };
  }
  return { tone: "done", text: all.length === 1 ? "1 agent done" : `All ${all.length} done` };
}

function drivers(agents: ReadonlyArray<MapAgent>): ReadonlyArray<ProviderDriverKind> {
  return [...new Set(flattenAgents(agents).map(({ agent }) => agent.driver))].slice(0, 3);
}

/** Older sets keep their notes and revisions only in their turn items. */
function milestoneDetail(milestone: OrchestrationV2Milestone, items: ReadonlyArray<MilestoneItem>) {
  if (milestone.detailInTurnItem !== true) {
    return { note: plainNote(milestone.note ?? null), revision: milestone.revision ?? null };
  }
  const own = items.filter((item) => item.milestoneId === milestone.id);
  const changed = own.findLast((item) => item.event === "changed");
  const closing = items.findLast(
    (item) =>
      (item.milestoneId === milestone.id && (item.event === "done" || item.event === "dropped")) ||
      ((item.event === "started" || item.event === "plan") &&
        item.closedMilestoneId === milestone.id),
  );
  return {
    note: plainNote(
      closing?.event === "dropped" ? (closing.reason ?? null) : (closing?.note ?? null),
    ),
    revision:
      changed?.previousTitle !== undefined && changed.reason !== undefined
        ? { previousTitle: changed.previousTitle, reason: changed.reason }
        : null,
  };
}

const runText = (projection: Projection, run: Run): string | null => {
  const message = projection.messages.find(({ id }) => id === run.userMessageId);
  return message === undefined ? null : message.text.trim() || null;
};

const lastReply = (projection: Projection, run: Run): string | null => {
  const reply = projection.messages.findLast(
    (message) => message.runId === run.id && message.role === "assistant" && !message.streaming,
  );
  return reply === undefined ? null : plainNote(firstLine(reply.text));
};

/**
 * The thread as a graph of milestones in the order work started, each with its agents grouped as
 * the coordinator grouped them; one row per turn on a thread that never planned. `asks` holds what
 * each agent's thread (by the `scopedThreadKey` of `agentThreadRef`) waits on you for.
 */
export function deriveMilestoneMap(input: {
  readonly environmentId: EnvironmentId;
  readonly projection: Projection;
  readonly turnItems: ReadonlyArray<ThreadStructureTurnItem>;
  readonly asks: ReadonlyMap<string, AgentAsk>;
  /** The coordinator itself waits on you. */
  readonly coordinatorAsks: boolean;
}): MilestoneMap | null {
  const { projection, asks, environmentId } = input;
  const graph = deriveThreadMilestoneGraph(projection);
  if (graph.mode === "empty") return null;
  const activeRun = resolveActiveThreadRun(projection);
  const runs = copySorted(
    projection.runs.filter((run) => run.status !== "rolled_back"),
    (left, right) => left.ordinal - right.ordinal,
  );
  const live = activeRun !== null || graph.coordinator.liveAgents > 0;
  const coordinatorFailed = graph.coordinator.status === "failed";

  const card = (fields: {
    readonly id: string;
    readonly milestone: OrchestrationV2Milestone | null;
    readonly title: string;
    readonly subtitle: string;
    readonly state: "done" | "active" | "planned" | "dropped";
    readonly why?: string | null;
    readonly revision?: MapMilestone["revision"];
    readonly note: string | null;
    readonly agents: ReadonlyArray<Subagent>;
    readonly startMs: number | null;
    readonly endMs: number | null;
  }): Omit<MapMilestone, "row" | "col"> => {
    const agents = buildAgents(fields.agents, asks, environmentId);
    const asking = flattenAgents(agents).some(({ status }) => status === "needs-you");
    const status: MapStatus =
      fields.state === "active"
        ? !live
          ? coordinatorFailed
            ? "failed"
            : "stopped"
          : asking || input.coordinatorAsks
            ? "needs-you"
            : "running"
        : fields.state;
    return {
      kind: "milestone",
      id: fields.id,
      milestone: fields.milestone,
      title: fields.title,
      subtitle: fields.subtitle,
      status,
      started: fields.startMs !== null,
      why: fields.why ?? null,
      revision: fields.revision ?? null,
      note: fields.note,
      live: fields.state === "active" && live,
      rollup: rollup(status, agents),
      groups: groupsOf(agents),
      agentCount: flattenAgents(agents).length,
      drivers: drivers(agents),
      startMs: fields.startMs,
      endMs: fields.state === "active" && live ? null : fields.endMs,
    };
  };

  let nodes: Array<MapMilestone | MapBubble>;
  let edges: ReadonlyArray<GraphEdge>;
  if (graph.mode === "turns") {
    nodes = graph.turns.map(({ run, agents }, index) => {
      const startMs = msOrNull(run.startedAt);
      const state =
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "interrupted" ||
        run.status === "cancelled"
          ? "done"
          : startMs === null
            ? "planned"
            : "active";
      const base = card({
        id: run.id,
        milestone: null,
        title: firstLine(runText(projection, run) ?? "") || `Turn ${index + 1}`,
        subtitle: `Turn ${index + 1}`,
        state,
        note: lastReply(projection, run),
        agents,
        startMs,
        endMs: msOrNull(run.completedAt) ?? startMs,
      });
      return {
        ...base,
        status:
          run.status === "failed"
            ? "failed"
            : run.status === "interrupted" || run.status === "cancelled"
              ? "stopped"
              : base.status,
        row: index,
        col: 0,
      };
    });
    edges = nodes.slice(1).map((node, index) => ({
      from: nodes[index]!.id,
      to: node.id,
      style: node.kind === "milestone" && node.started ? "live" : "future",
    }));
  } else {
    const rootAgents = graph.root?.agents ?? [];
    const milestoneItems = input.turnItems.filter(
      (item): item is MilestoneItem => item.type === "milestone",
    );
    const setIds = [...new Set(projection.milestones.map(({ setId }) => setId))];
    const currentSetId = setIds.at(-1)!;
    const agentsOf = new Map(
      graph.milestones.map(({ milestone, agents }) => [milestone.id, agents]),
    );
    const dropped = (milestone: OrchestrationV2Milestone) =>
      milestone.status === "dropped" ||
      (milestone.setId !== currentSetId &&
        milestone.status !== "done" &&
        milestone.startedAt === null);
    const runById = new Map(runs.map((run) => [run.id, run]));
    const planRunOf = (setId: string) =>
      projection.milestones.find((milestone) => milestone.setId === setId)?.anchors.planned
        ?.runId ?? null;
    const sets: Array<GraphSet & { atMs: number | null }> = setIds.map((setId, index) => {
      const planItem = milestoneItems.find((item) => item.event === "plan" && item.setId === setId);
      const firstOfSet = projection.milestones.find((milestone) => milestone.setId === setId)!;
      const atMs =
        msOrNull(planItem?.startedAt ?? null) ??
        msOrNull(firstOfSet.startedAt) ??
        msOrNull(runById.get(planRunOf(setId) ?? ("" as never))?.requestedAt ?? null);
      const lastDone =
        atMs === null
          ? undefined
          : copySorted(
              projection.milestones.filter(
                (milestone) =>
                  milestone.setId !== setId &&
                  milestone.completedAt !== null &&
                  ms(milestone.completedAt) <= atMs,
              ),
              (left, right) => ms(left.completedAt!) - ms(right.completedAt!),
            ).at(-1);
      const from = index === 0 ? null : (planItem?.closedMilestoneId ?? lastDone?.id ?? null);
      const planRunId = planRunOf(setId);
      const previousPlanRunId = index === 0 ? null : planRunOf(setIds[index - 1]!);
      const planRun = planRunId === null ? undefined : runById.get(planRunId);
      const message =
        planRun === undefined || index === 0 || planRunId === previousPlanRunId
          ? undefined
          : projection.messages.find(
              ({ id, createdBy }) => id === planRun.userMessageId && createdBy === "user",
            );
      return { id: setId, from, you: message?.text.trim() || null, atMs };
    });
    const layout = layoutMilestoneGraph({
      milestones: projection.milestones.map((milestone) => ({
        id: milestone.id,
        setId: milestone.setId,
        planned: milestone.anchors.planned !== undefined,
        dropped: dropped(milestone),
        startMs: msOrNull(milestone.startedAt),
      })),
      sets,
      request: runs[0] === undefined ? null : runText(projection, runs[0]),
      before: rootAgents.length > 0 ? BEFORE_PLAN_NODE_ID : null,
    });
    const byId = new Map(projection.milestones.map((milestone) => [milestone.id, milestone]));
    const setIndex = new Map(setIds.map((setId, index) => [setId, index]));
    const subtitleOf = (
      milestone: OrchestrationV2Milestone,
      revision: MapMilestone["revision"],
    ) => {
      if (revision !== null) return `Changed from “${revision.previousTitle}”`;
      if (milestone.anchors.planned === undefined) return "Not in the plan";
      if (setIndex.get(milestone.setId) === 0) return "In the plan";
      const firstOfSet = projection.milestones.find(({ setId }) => setId === milestone.setId);
      if (firstOfSet !== milestone) return "In the new plan";
      const set = sets[setIndex.get(milestone.setId)!]!;
      const parent = set.from === null ? undefined : byId.get(set.from);
      const parentEnd = msOrNull(parent?.completedAt ?? null) ?? set.atMs;
      const gap = set.atMs === null || parentEnd === null ? 0 : set.atMs - parentEnd;
      return gap >= NEW_PLAN_GAP_MS ? `New plan, ${Math.round(gap / 60_000)}m later` : "New plan";
    };
    nodes = layout.nodes.map((node): MapMilestone | MapBubble => {
      if (node.kind === "you") {
        return { kind: "you", id: node.id, row: node.row, col: node.col, text: node.text ?? "" };
      }
      if (node.id === BEFORE_PLAN_NODE_ID) {
        const run = graph.root!.run;
        const startMs = msOrNull(run.startedAt);
        const busy = rootAgents.some(({ status }) => isActiveSubagentStatus(status));
        return {
          ...card({
            id: node.id,
            milestone: null,
            title: "Before the plan",
            subtitle: "Not in the plan",
            state: busy ? "active" : "done",
            note: null,
            agents: rootAgents,
            startMs,
            endMs:
              Math.max(
                startMs ?? 0,
                ...rootAgents.map((agent) => msOrNull(agent.completedAt) ?? 0),
              ) || null,
          }),
          row: node.row,
          col: node.col,
        };
      }
      const milestone = byId.get(node.id)!;
      const { note, revision } = milestoneDetail(milestone, milestoneItems);
      const isDropped = dropped(milestone);
      const startMs = msOrNull(milestone.startedAt);
      const state = isDropped
        ? "dropped"
        : milestone.status === "dropped"
          ? "dropped"
          : milestone.status === "active" && milestone.setId !== currentSetId
            ? "done"
            : milestone.status;
      return {
        ...card({
          id: milestone.id,
          milestone,
          title: milestone.title,
          subtitle: subtitleOf(milestone, revision),
          state,
          why: isDropped
            ? milestone.status === "dropped"
              ? note
              : "Replaced by the new plan"
            : null,
          revision,
          note: isDropped ? null : note,
          agents: agentsOf.get(milestone.id) ?? [],
          startMs,
          endMs: msOrNull(milestone.completedAt) ?? startMs,
        }),
        row: node.row,
        col: node.col,
      };
    });
    edges = layout.edges;
  }

  const milestones = nodes.filter((node): node is MapMilestone => node.kind === "milestone");
  const counted = milestones.filter(
    (node) => node.status !== "dropped" && (graph.mode === "turns" || node.milestone !== null),
  );
  const agents = milestones.flatMap(({ groups }) =>
    flattenAgents(groups.flatMap(({ agents: members }) => members)),
  );
  const recorded = [
    ...runs.flatMap((run) => [msOrNull(run.startedAt), msOrNull(run.completedAt)]),
    ...projection.subagents.flatMap((agent) => [
      msOrNull(agent.startedAt),
      msOrNull(agent.completedAt),
    ]),
    ...projection.milestones.flatMap((milestone) => [
      msOrNull(milestone.startedAt),
      msOrNull(milestone.completedAt),
    ]),
  ].filter((value) => value !== null);
  const firstRun = runs[0];
  const startMs =
    msOrNull(firstRun?.startedAt ?? null) ??
    msOrNull(firstRun?.requestedAt ?? null) ??
    (recorded.length > 0 ? Math.min(...recorded) : null);
  return {
    mode: graph.mode,
    title: firstRun === undefined ? null : firstLine(runText(projection, firstRun) ?? "") || null,
    nodes,
    edges,
    maxCol: Math.max(0, ...nodes.map(({ col }) => col)),
    live,
    coordinatorRun: activeRun ?? runs.at(-1) ?? null,
    stats: {
      done: counted.filter(({ status }) => status === "done").length,
      total: counted.length,
      agents: agents.length,
      running: agents.filter(({ status }) => status === "running" || status === "needs-you").length,
      needsYou: agents.filter(({ status }) => status === "needs-you").length,
      startMs,
      endMs: live ? null : recorded.length > 0 ? Math.max(...recorded) : startMs,
    },
  };
}
