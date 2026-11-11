import type { ChatImageAttachment } from "@t3tools/contracts";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";

import type { LinkRequestItem } from "../linkRequest.ts";
import type { SecretRequestItem } from "../secretRequest.ts";
import type { ThreadStructureTurnItem, ThreadStructureVisibleTurnItem } from "./models.ts";

type UserMessageItem = Extract<ThreadStructureTurnItem, { readonly type: "user_message" }>;

/** What a milestone collects while it runs: the agent's posts, its visuals, and your comments. */
export type MilestoneBoardItem =
  | {
      readonly kind: "post";
      readonly id: string;
      readonly text: string | null;
      readonly attachments: ReadonlyArray<ChatImageAttachment>;
    }
  | { readonly kind: "visual"; readonly id: string; readonly title: string }
  | { readonly kind: "comment"; readonly id: string; readonly text: string };

/** Board key for what was posted before any milestone existed. */
export const MILESTONE_BOARD_ROOT = "root";

const COMMENT_PATTERN = /^Re: milestone (m[1-9]\d*)(?: \(([^\n]*)\))?\n\n([\s\S]*)$/u;

/**
 * The text a comment on a milestone is sent with. The coordinator reads it as a plain message;
 * `parseMilestoneComment` reads it back so the comment stays on the milestone it was about.
 */
export function formatMilestoneCommentPrefix(milestone: {
  readonly id: string;
  readonly title: string;
}): string {
  return `Re: milestone ${milestone.id} (${milestone.title.replace(/\s+/gu, " ")})\n\n`;
}

export function parseMilestoneComment(
  text: string,
): { readonly milestoneId: string; readonly body: string } | null {
  const match = COMMENT_PATTERN.exec(text);
  const body = match?.[3]?.trim();
  return match && body ? { milestoneId: match[1]!, body } : null;
}

/**
 * Hangs loaded turn items on the milestone they belong to. Posts and comments name their
 * milestone; a visual belongs to the milestone running where it appears in the turn order.
 * Only loaded history shows: older pages add their items when they load.
 */
export function deriveMilestoneBoards(
  items: ReadonlyArray<ThreadStructureTurnItem>,
  textOf: (item: UserMessageItem) => string,
): ReadonlyMap<string, ReadonlyArray<MilestoneBoardItem>> {
  const boards = new Map<string, Array<MilestoneBoardItem>>();
  const add = (key: string, entry: MilestoneBoardItem) =>
    boards.set(key, [...(boards.get(key) ?? []), entry]);
  let running: string = MILESTONE_BOARD_ROOT;
  for (const item of items) {
    if (item.type === "milestone") {
      if (item.event === "plan") running = item.planned?.[0]?.id ?? running;
      else if (item.event === "started" && item.milestoneId !== null) running = item.milestoneId;
      else if (item.event === "post") {
        add(item.milestoneId ?? MILESTONE_BOARD_ROOT, {
          kind: "post",
          id: item.id,
          text: item.note ?? null,
          attachments: item.attachments ?? [],
        });
      }
    } else if (item.type === "dynamic_tool" && item.status === "completed") {
      const render = htmlRenderFromToolItem(item);
      if (render !== undefined) add(running, { kind: "visual", id: item.id, title: render.title });
    } else if (item.type === "user_message") {
      const comment = parseMilestoneComment(textOf(item));
      if (comment !== null) {
        add(comment.milestoneId, { kind: "comment", id: item.id, text: comment.body });
      }
    }
  }
  return boards;
}

/** The latest secret or link card of this thread that still waits on you. */
export function pendingAskCard(
  items: ReadonlyArray<ThreadStructureVisibleTurnItem>,
): SecretRequestItem | LinkRequestItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const { item, visibility } = items[index]!;
    if (visibility !== "local") continue;
    if (item.type === "secret_request" && item.secretStatus === "pending") return item;
    if (item.type === "link_request" && item.linkStatus === "pending") return item;
  }
  return null;
}
