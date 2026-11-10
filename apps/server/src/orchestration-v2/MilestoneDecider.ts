import {
  type MilestoneId,
  type MilestoneSetId,
  milestoneNumber,
  type OrchestrationV2Milestone,
  type OrchestrationV2MilestoneAction,
  type OrchestrationV2MilestoneAnchor,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

export type MilestoneTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "milestone" }>;

/** What a milestone item adds to the turn-item base fields. */
export type MilestoneItemDetail = Pick<
  MilestoneTurnItem,
  | "type"
  | "event"
  | "milestoneId"
  | "setId"
  | "title"
  | "planned"
  | "closedMilestoneId"
  | "note"
  | "reason"
  | "previousTitle"
  | "attachments"
>;

export interface MilestoneState {
  /** In creation order, which is also set order. */
  readonly milestones: ReadonlyArray<OrchestrationV2Milestone>;
  /** Highest numbers ever used, rolled-back runs included, so no id is reused. */
  readonly lastMilestoneNumber: number;
  readonly lastSetNumber: number;
}

const EMPTY_MILESTONE_STATE: MilestoneState = {
  milestones: [],
  lastMilestoneNumber: 0,
  lastSetNumber: 0,
};

const isOpen = (milestone: OrchestrationV2Milestone) =>
  milestone.status === "planned" || milestone.status === "active";

function anchorOf(item: MilestoneTurnItem): OrchestrationV2MilestoneAnchor | undefined {
  return item.runId === null ? undefined : { runId: item.runId, itemId: item.id };
}

/** Replays one transition. Decisions and rollback replays share it, so they cannot disagree. */
export function applyMilestoneItem(
  milestones: ReadonlyArray<OrchestrationV2Milestone>,
  item: MilestoneTurnItem,
): ReadonlyArray<OrchestrationV2Milestone> {
  const anchor = anchorOf(item);
  if (anchor === undefined || item.event === "post") return milestones;
  const at = item.startedAt ?? item.updatedAt;
  const close = (
    milestone: OrchestrationV2Milestone,
    status: "done" | "dropped",
    note: string | undefined,
  ): OrchestrationV2Milestone => {
    const { note: _previousNote, ...rest } = milestone;
    return {
      ...rest,
      status,
      ...(note === undefined ? {} : { note }),
      completedAt: at,
      anchors: { ...milestone.anchors, [status]: anchor },
    };
  };
  const update =
    (
      id: MilestoneId | null | undefined,
      change: (milestone: OrchestrationV2Milestone) => OrchestrationV2Milestone,
    ) =>
    (milestone: OrchestrationV2Milestone) =>
      milestone.id === id ? change(milestone) : milestone;

  switch (item.event) {
    case "plan": {
      const closed = milestones.map((milestone) =>
        milestone.status === "active"
          ? close(milestone, "done", undefined)
          : milestone.status === "planned"
            ? close(milestone, "dropped", undefined)
            : milestone,
      );
      const opened = (item.planned ?? []).map(({ id, title }, index): OrchestrationV2Milestone => ({
        id,
        setId: item.setId!,
        title,
        status: index === 0 ? "active" : "planned",
        startedAt: index === 0 ? at : null,
        completedAt: null,
        anchors: index === 0 ? { planned: anchor, started: anchor } : { planned: anchor },
      }));
      return [...closed, ...opened];
    }
    case "started": {
      const closed = milestones.map(
        update(item.closedMilestoneId, (milestone) => close(milestone, "done", item.note)),
      );
      if (closed.some((milestone) => milestone.id === item.milestoneId)) {
        return closed.map(
          update(item.milestoneId, (milestone) => ({
            ...milestone,
            status: "active",
            startedAt: at,
            anchors: { ...milestone.anchors, started: anchor },
          })),
        );
      }
      return [
        ...closed,
        {
          id: item.milestoneId!,
          setId: item.setId!,
          title: item.title!,
          status: "active",
          startedAt: at,
          completedAt: null,
          anchors: { started: anchor },
        },
      ];
    }
    case "done":
      return milestones.map(
        update(item.milestoneId, (milestone) => close(milestone, "done", item.note)),
      );
    case "dropped":
      return milestones.map(
        update(item.milestoneId, (milestone) => close(milestone, "dropped", item.reason)),
      );
    case "changed":
      return milestones.map(
        update(item.milestoneId, (milestone) => ({
          ...milestone,
          title: item.title ?? milestone.title,
          revision: { previousTitle: item.previousTitle ?? milestone.title, reason: item.reason! },
          anchors: { ...milestone.anchors, changed: anchor },
        })),
      );
  }
}

/** Rebuilds state from a thread's `milestone` turn items, skipping those of `excludedRunIds`. */
export function foldMilestoneItems(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  excludedRunIds: ReadonlySet<RunId>,
): MilestoneState {
  let state = EMPTY_MILESTONE_STATE;
  for (const item of items.toSorted((left, right) => left.ordinal - right.ordinal)) {
    if (item.type !== "milestone") continue;
    const ids = [item.milestoneId, ...(item.planned ?? []).map(({ id }) => id)];
    const lastMilestoneNumber = Math.max(
      state.lastMilestoneNumber,
      ...ids.flatMap((id) => (id === null ? [] : [milestoneNumber(id)])),
    );
    const lastSetNumber = Math.max(
      state.lastSetNumber,
      item.setId === null ? 0 : milestoneNumber(item.setId),
    );
    state = {
      milestones:
        item.runId !== null && excludedRunIds.has(item.runId)
          ? state.milestones
          : applyMilestoneItem(state.milestones, item),
      lastMilestoneNumber,
      lastSetNumber,
    };
  }
  return state;
}

/** Runs whose items no longer count: rolled back, or about to be. */
export function excludedMilestoneRunIds(
  runs: ReadonlyArray<{ readonly id: RunId; readonly status: string }>,
  rollingBack: Iterable<RunId> = [],
): ReadonlySet<RunId> {
  return new Set([
    ...runs.flatMap((run) => (run.status === "rolled_back" ? [run.id] : [])),
    ...rollingBack,
  ]);
}

/**
 * Every milestone once `rollingBack` no longer counts, or `undefined` when none of those runs
 * marked a milestone and nothing changes.
 */
export function milestonesAfterRollback(input: {
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly runs: ReadonlyArray<{ readonly id: RunId; readonly status: string }>;
  readonly rollingBack: ReadonlyArray<RunId>;
}): ReadonlyArray<OrchestrationV2Milestone> | undefined {
  const rollingBack = new Set(input.rollingBack);
  const touched = input.items.some(
    (item) => item.type === "milestone" && item.runId !== null && rollingBack.has(item.runId),
  );
  if (!touched) return undefined;
  return foldMilestoneItems(input.items, excludedMilestoneRunIds(input.runs, rollingBack))
    .milestones;
}

function currentMilestoneSetId(
  milestones: ReadonlyArray<OrchestrationV2Milestone>,
): MilestoneSetId | undefined {
  return milestones.at(-1)?.setId;
}

export type MilestoneDecision =
  | { readonly _tag: "accepted"; readonly detail: MilestoneItemDetail }
  | { readonly _tag: "rejected"; readonly message: string };

const rejected = (message: string): MilestoneDecision => ({ _tag: "rejected", message });
const accepted = (detail: Omit<MilestoneItemDetail, "type">): MilestoneDecision => ({
  _tag: "accepted",
  detail: { type: "milestone", ...detail },
});

/** Validates one action against the current state. Pure: the caller builds and applies the item. */
export function decideMilestoneAction(
  state: MilestoneState,
  action: OrchestrationV2MilestoneAction,
): MilestoneDecision {
  const { milestones } = state;
  const active = milestones.find((milestone) => milestone.status === "active");
  const setId = currentMilestoneSetId(milestones);
  const nextId = (offset = 0) => `m${state.lastMilestoneNumber + 1 + offset}` as MilestoneId;
  const find = (id: MilestoneId) => milestones.find((milestone) => milestone.id === id);
  const unknown = (id: MilestoneId) => rejected(`No milestone ${id}.`);

  switch (action.action) {
    case "plan":
      return accepted({
        event: "plan",
        milestoneId: nextId(),
        setId: `s${state.lastSetNumber + 1}` as MilestoneSetId,
        title: action.titles[0],
        planned: action.titles.map((title, index) => ({ id: nextId(index), title })),
        ...(active === undefined ? {} : { closedMilestoneId: active.id }),
      });
    case "start": {
      if (action.id !== undefined && action.title !== undefined) {
        return rejected("Pass `id` or `title`, not both.");
      }
      const closing = {
        ...(active === undefined ? {} : { closedMilestoneId: active.id }),
        ...(action.note === undefined ? {} : { note: action.note }),
      };
      if (action.title !== undefined) {
        return accepted({
          event: "started",
          milestoneId: nextId(),
          setId: setId ?? (`s${state.lastSetNumber + 1}` as MilestoneSetId),
          title: action.title,
          ...closing,
        });
      }
      const target =
        action.id === undefined
          ? milestones.find((milestone) => milestone.status === "planned")
          : find(action.id);
      if (target === undefined) {
        return action.id === undefined
          ? rejected("Nothing planned. Pass `title`, or `plan` first.")
          : unknown(action.id);
      }
      if (target.status !== "planned") {
        return rejected(`${target.id} is ${target.status}; start a planned one or pass \`title\`.`);
      }
      return accepted({
        event: "started",
        milestoneId: target.id,
        setId: target.setId,
        title: target.title,
        ...closing,
      });
    }
    case "done": {
      const target = action.id === undefined ? active : find(action.id);
      if (target === undefined) {
        return action.id === undefined
          ? rejected("No active milestone. Pass `id`.")
          : unknown(action.id);
      }
      if (!isOpen(target)) return rejected(`${target.id} is already ${target.status}.`);
      return accepted({
        event: "done",
        milestoneId: target.id,
        setId: target.setId,
        title: target.title,
        ...(action.note === undefined ? {} : { note: action.note }),
      });
    }
    case "change":
    case "drop": {
      const target = find(action.id);
      if (target === undefined) return unknown(action.id);
      if (!isOpen(target)) {
        return rejected(`${target.id} is ${target.status}; only planned or active ones change.`);
      }
      return action.action === "drop"
        ? accepted({
            event: "dropped",
            milestoneId: target.id,
            setId: target.setId,
            title: target.title,
            reason: action.reason,
          })
        : accepted({
            event: "changed",
            milestoneId: target.id,
            setId: target.setId,
            title: action.title ?? target.title,
            previousTitle: target.title,
            reason: action.reason,
          });
    }
    case "post":
      if (action.text === undefined && action.attachments.length === 0) {
        return rejected("A post needs `note` or `images`.");
      }
      return accepted({
        event: "post",
        milestoneId: active?.id ?? null,
        setId: active?.setId ?? null,
        title: active?.title ?? null,
        ...(action.text === undefined ? {} : { note: action.text }),
        ...(action.attachments.length === 0 ? {} : { attachments: action.attachments }),
      });
  }
}

/** Milestones the item changed or added, by identity after `applyMilestoneItem`. */
export function changedMilestones(
  before: ReadonlyArray<OrchestrationV2Milestone>,
  after: ReadonlyArray<OrchestrationV2Milestone>,
): ReadonlyArray<OrchestrationV2Milestone> {
  const previous = new Set(before);
  return after.filter((milestone) => !previous.has(milestone));
}

/** The agent's whole view of its progress, e.g. `m3 active · 3/6 · next m4 m5 m6`. */
export function summarizeMilestones(
  milestones: ReadonlyArray<OrchestrationV2Milestone>,
  posted?: MilestoneId | null,
): string {
  if (posted !== undefined) return posted === null ? "posted" : `posted to ${posted}`;
  const setId = currentMilestoneSetId(milestones);
  const set = milestones.filter(
    (milestone) => milestone.setId === setId && milestone.status !== "dropped",
  );
  const done = set.filter((milestone) => milestone.status === "done").length;
  const active = set.find((milestone) => milestone.status === "active");
  const next = set.filter((milestone) => milestone.status === "planned").map(({ id }) => id);
  const head =
    active === undefined
      ? `${done}/${set.length} done`
      : `${active.id} active · ${done + 1}/${set.length}`;
  return next.length === 0 ? head : `${head} · next ${next.join(" ")}`;
}

/** A completed `milestone` turn item, stamped at `now`. */
export function milestoneTurnItem(input: {
  readonly base: Pick<
    MilestoneTurnItem,
    "id" | "threadId" | "runId" | "nodeId" | "providerThreadId" | "providerTurnId" | "ordinal"
  >;
  readonly detail: MilestoneItemDetail;
  readonly now: DateTime.Utc;
}): MilestoneTurnItem {
  return {
    ...input.base,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed",
    startedAt: input.now,
    completedAt: input.now,
    updatedAt: input.now,
    ...input.detail,
  };
}
