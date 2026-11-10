import * as Schema from "effect/Schema";

import { RunId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";
import { ChatImageAttachment } from "./chatAttachment.ts";

export const MILESTONE_TITLE_MAX_CHARS = 120;
export const MILESTONE_NOTE_MAX_CHARS = 280;
export const MILESTONE_POST_MAX_CHARS = 4_000;
export const MILESTONE_POST_MAX_IMAGES = 8;

/** Short and unique within a thread: `m1`, `m2`… Numbers keep counting across sets. */
export const MilestoneId = TrimmedNonEmptyString.check(Schema.isPattern(/^m[1-9]\d*$/));
export type MilestoneId = typeof MilestoneId.Type;

/** Each `plan` opens a set: `s1`, `s2`… */
export const MilestoneSetId = TrimmedNonEmptyString.check(Schema.isPattern(/^s[1-9]\d*$/));
export type MilestoneSetId = typeof MilestoneSetId.Type;

export const MilestoneTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MILESTONE_TITLE_MAX_CHARS),
);
export const MilestoneNote = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MILESTONE_NOTE_MAX_CHARS),
);

export const OrchestrationV2MilestoneStatus = Schema.Literals([
  "planned",
  "active",
  "done",
  "dropped",
]);
export type OrchestrationV2MilestoneStatus = typeof OrchestrationV2MilestoneStatus.Type;

/** The run and `milestone` turn item of one transition; clients jump to the item. */
export const OrchestrationV2MilestoneAnchor = Schema.Struct({
  runId: RunId,
  itemId: TurnItemId,
});
export type OrchestrationV2MilestoneAnchor = typeof OrchestrationV2MilestoneAnchor.Type;

export const OrchestrationV2MilestoneAnchors = Schema.Struct({
  planned: Schema.optional(OrchestrationV2MilestoneAnchor),
  started: Schema.optional(OrchestrationV2MilestoneAnchor),
  /** The latest change. */
  changed: Schema.optional(OrchestrationV2MilestoneAnchor),
  done: Schema.optional(OrchestrationV2MilestoneAnchor),
  dropped: Schema.optional(OrchestrationV2MilestoneAnchor),
});
export type OrchestrationV2MilestoneAnchors = typeof OrchestrationV2MilestoneAnchors.Type;

const milestoneFields = <DateTime extends Schema.Top>(dateTime: DateTime) =>
  ({
    id: MilestoneId,
    setId: MilestoneSetId,
    title: MilestoneTitle,
    status: OrchestrationV2MilestoneStatus,
    /** The result when done, or the reason when dropped. */
    note: Schema.optional(MilestoneNote),
    revision: Schema.optional(
      Schema.Struct({ previousTitle: MilestoneTitle, reason: MilestoneNote }),
    ),
    startedAt: Schema.NullOr(dateTime),
    completedAt: Schema.NullOr(dateTime),
    anchors: OrchestrationV2MilestoneAnchors,
    /** Older sets travel without `note` and `revision`; their turn items keep them. */
    detailInTurnItem: Schema.optional(Schema.Literal(true)),
  }) as const;

export const OrchestrationV2Milestone = Schema.Struct(milestoneFields(Schema.DateTimeUtc));
export type OrchestrationV2Milestone = typeof OrchestrationV2Milestone.Type;

export const OrchestrationV2MilestoneJson = Schema.Struct(
  milestoneFields(Schema.DateTimeUtcFromString),
);

export const OrchestrationV2MilestoneEventKind = Schema.Literals([
  "plan",
  "started",
  "changed",
  "done",
  "dropped",
  "post",
]);
export type OrchestrationV2MilestoneEventKind = typeof OrchestrationV2MilestoneEventKind.Type;

/** Fields of the `milestone` turn item; its base `title` carries the milestone title. */
export const OrchestrationV2MilestoneTurnItemFields = {
  type: Schema.Literal("milestone"),
  event: OrchestrationV2MilestoneEventKind,
  /** `null` only for a post made before any milestone existed. */
  milestoneId: Schema.NullOr(MilestoneId),
  setId: Schema.NullOr(MilestoneSetId),
  /** `plan`: the milestones it opened, in order; the first one starts. */
  planned: Schema.optional(Schema.Array(Schema.Struct({ id: MilestoneId, title: MilestoneTitle }))),
  /** `plan` or `started`: the milestone that was active and became done. */
  closedMilestoneId: Schema.optional(MilestoneId),
  /** The closing result (`started`, `done`) or the post text. */
  note: Schema.optional(Schema.String),
  /** Why it changed or was dropped. */
  reason: Schema.optional(MilestoneNote),
  previousTitle: Schema.optional(MilestoneTitle),
  attachments: Schema.optional(Schema.Array(ChatImageAttachment)),
} as const;

export const OrchestrationV2MilestoneAction = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("plan"),
    titles: Schema.NonEmptyArray(MilestoneTitle),
  }),
  Schema.Struct({
    action: Schema.Literal("start"),
    id: Schema.optional(MilestoneId),
    title: Schema.optional(MilestoneTitle),
    note: Schema.optional(MilestoneNote),
  }),
  Schema.Struct({
    action: Schema.Literal("done"),
    id: Schema.optional(MilestoneId),
    note: Schema.optional(MilestoneNote),
  }),
  Schema.Struct({
    action: Schema.Literal("change"),
    id: MilestoneId,
    title: Schema.optional(MilestoneTitle),
    reason: MilestoneNote,
  }),
  Schema.Struct({
    action: Schema.Literal("drop"),
    id: MilestoneId,
    reason: MilestoneNote,
  }),
  Schema.Struct({
    action: Schema.Literal("post"),
    text: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(MILESTONE_POST_MAX_CHARS)),
    ),
    attachments: Schema.Array(ChatImageAttachment).check(
      Schema.isMaxLength(MILESTONE_POST_MAX_IMAGES),
    ),
  }),
]);
export type OrchestrationV2MilestoneAction = typeof OrchestrationV2MilestoneAction.Type;

/** `replace` carries every milestone (after a rollback); otherwise only the changed ones. */
export const OrchestrationV2MilestonesUpdate = Schema.Struct({
  milestones: Schema.Array(OrchestrationV2Milestone),
  replace: Schema.optional(Schema.Literal(true)),
});
export type OrchestrationV2MilestonesUpdate = typeof OrchestrationV2MilestonesUpdate.Type;

export const OrchestrationV2MilestonesUpdateJson = Schema.Struct({
  milestones: Schema.Array(OrchestrationV2MilestoneJson),
  replace: Schema.optional(Schema.Literal(true)),
});

export function milestoneNumber(id: string): number {
  return Number(id.slice(1));
}

/** Milestones in creation order, which is also set order. */
export function applyMilestonesUpdate(
  current: ReadonlyArray<OrchestrationV2Milestone>,
  update: OrchestrationV2MilestonesUpdate,
): ReadonlyArray<OrchestrationV2Milestone> {
  if (update.replace === true) return update.milestones;
  const byId = new Map(current.map((milestone) => [milestone.id, milestone]));
  for (const milestone of update.milestones) byId.set(milestone.id, milestone);
  return [...byId.values()].sort(
    (left, right) => milestoneNumber(left.id) - milestoneNumber(right.id),
  );
}

export function activeMilestoneId(
  milestones: ReadonlyArray<Pick<OrchestrationV2Milestone, "id" | "status">>,
): MilestoneId | undefined {
  return milestones.find((milestone) => milestone.status === "active")?.id;
}

/**
 * A subagent belongs to the milestone that was active when the thread first recorded it, and
 * keeps it through later updates, which never carry it.
 */
export function stampSubagentMilestone<
  Subagent extends { readonly milestoneId?: MilestoneId | undefined },
>(previous: Subagent | undefined, next: Subagent, active: MilestoneId | undefined): Subagent {
  const milestoneId = previous === undefined ? active : previous.milestoneId;
  if (milestoneId === next.milestoneId) return next;
  if (milestoneId !== undefined) return { ...next, milestoneId };
  const { milestoneId: _dropped, ...rest } = next;
  return rest as Subagent;
}

/**
 * `t3_milestone` input. Flat and unbounded on purpose: every field costs the model context on
 * each turn, so the service checks fit and lengths and answers with a short fix.
 */
export const ThreadMilestoneMcpInput = Schema.Struct({
  action: Schema.Literals(["plan", "start", "done", "change", "drop", "post"]),
  titles: Schema.optionalKey(Schema.Array(Schema.String)),
  id: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  images: Schema.optionalKey(Schema.Array(Schema.String)),
  clientRequestId: Schema.optionalKey(Schema.String),
});
export type ThreadMilestoneMcpInput = typeof ThreadMilestoneMcpInput.Type;

/** e.g. `m3 active · 3/6 · next m4 m5 m6`. */
export const ThreadMilestoneMcpResult = Schema.Struct({ state: Schema.String });
export type ThreadMilestoneMcpResult = typeof ThreadMilestoneMcpResult.Type;
