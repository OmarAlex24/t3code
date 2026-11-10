import type { MilestoneBoardItem } from "@t3tools/client-runtime/state/thread-milestone-board";
import type { ChatImageAttachment, EnvironmentId } from "@t3tools/contracts";
import {
  AppWindowIcon,
  CornerDownLeftIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  StickyNoteIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { Button } from "../ui/button";

/** What the coordinator is asking you right now, shown on the milestone it is working on. */
export type CoordinatorAsk =
  | { readonly kind: "input"; readonly question: string | null }
  | { readonly kind: "approval" };

/** How many board items show before the older ones fold. */
const BOARD_LIMIT = 4;

const BOARD_KINDS = [
  { kind: "post", icon: StickyNoteIcon, label: "post" },
  { kind: "visual", icon: AppWindowIcon, label: "visual" },
  { kind: "comment", icon: MessageSquareIcon, label: "comment" },
] as const;

/** Counts per kind, such as "3 posts · 1 visual", for headers and folded milestones. */
export function boardCounts(items: ReadonlyArray<MilestoneBoardItem>) {
  return BOARD_KINDS.flatMap(({ kind, icon, label }) => {
    const count = items.filter((item) => item.kind === kind).length;
    return count === 0
      ? []
      : [{ kind, icon, text: `${count} ${count === 1 ? label : `${label}s`}` }];
  });
}

export function CoordinatorAskCard(props: {
  readonly ask: CoordinatorAsk;
  readonly onAnswerInChat: () => void;
}) {
  const question = props.ask.kind === "input" ? props.ask.question : null;
  return (
    <div className="rounded-xl border border-warning/40 bg-warning/6 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-warning">
        <TriangleAlertIcon className="size-3.5" />
        Coordinator asks you
      </div>
      {question === null ? null : <p className="mt-1 text-sm text-foreground">{question}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        {props.ask.kind === "approval" ? (
          <>
            <span>It needs your approval to continue.</span>
            <Button size="xs" variant="outline" onClick={props.onAnswerInChat}>
              Answer in chat
            </Button>
          </>
        ) : (
          <span>Answer in the composer below.</span>
        )}
      </div>
    </div>
  );
}

function PostImages(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ChatImageAttachment>;
}) {
  const urls = useAssetUrls(
    props.environmentId,
    props.attachments.map((attachment) => ({
      _tag: "attachment" as const,
      attachmentId: attachment.id,
    })),
  );
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {props.attachments.map((attachment, index) => {
        const url = urls[index];
        return (
          <a
            key={attachment.id}
            href={url ?? undefined}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${attachment.name}`}
            className="block h-20 w-32 overflow-hidden rounded-lg border bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
          >
            {url ? (
              <img src={url} alt={attachment.name} className="size-full object-cover" />
            ) : null}
          </a>
        );
      })}
    </div>
  );
}

type Block =
  | {
      readonly kind: "visuals";
      readonly items: ReadonlyArray<MilestoneBoardItem & { kind: "visual" }>;
    }
  | { readonly kind: "single"; readonly item: MilestoneBoardItem };

/** Visuals in a row share a grid; posts and comments stand alone. */
function blocksOf(items: ReadonlyArray<MilestoneBoardItem>): ReadonlyArray<Block> {
  const blocks: Array<Block> = [];
  for (const item of items) {
    const last = blocks.at(-1);
    if (item.kind === "visual" && last?.kind === "visuals") {
      blocks[blocks.length - 1] = { kind: "visuals", items: [...last.items, item] };
    } else if (item.kind === "visual") {
      blocks.push({ kind: "visuals", items: [item] });
    } else {
      blocks.push({ kind: "single", item });
    }
  }
  return blocks;
}

/**
 * A milestone's board: the coordinator's posts and visuals and your comments, newest last, with
 * older items folded. Visuals open where they rendered in Chat rather than mounting a frame here.
 */
export function MilestoneBoard(props: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<MilestoneBoardItem>;
  readonly onJump: (entryId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (props.items.length === 0) return null;
  const hidden = showAll ? 0 : Math.max(0, props.items.length - BOARD_LIMIT);
  return (
    <div className="grid gap-2">
      {props.items.length > BOARD_LIMIT ? (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className="rounded-lg py-1 text-center text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
        >
          {showAll ? "Show fewer" : `Show ${hidden} earlier`}
        </button>
      ) : null}
      {blocksOf(props.items.slice(hidden)).map((block) =>
        block.kind === "visuals" ? (
          <div key={block.items[0]!.id} className="@container">
            <div className="grid gap-2 @sm:grid-cols-2">
              {block.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => props.onJump(item.id)}
                  className="group/visual flex min-w-0 items-center gap-2.5 rounded-xl border bg-card px-2.5 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                    <AppWindowIcon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{item.title}</span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <CornerDownLeftIcon className="size-3" />
                      Show in chat
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : block.item.kind === "post" ? (
          <div key={block.item.id} className="rounded-xl border bg-card px-3 py-2">
            <div className="mb-0.5 text-xs font-medium text-muted-foreground">Coordinator</div>
            {block.item.text === null ? null : (
              <p className="text-sm whitespace-pre-wrap text-foreground">{block.item.text}</p>
            )}
            {block.item.attachments.length === 0 ? null : (
              <PostImages
                environmentId={props.environmentId}
                attachments={block.item.attachments}
              />
            )}
          </div>
        ) : block.item.kind === "comment" ? (
          <div
            key={block.item.id}
            className="w-fit max-w-[85%] justify-self-end rounded-2xl bg-message px-3 py-1.5 text-message-foreground"
          >
            <div className="text-2xs text-muted-foreground">You · sent to the coordinator</div>
            <p className="text-sm whitespace-pre-wrap">{block.item.text}</p>
          </div>
        ) : null,
      )}
    </div>
  );
}

export function CommentButton(props: { readonly onComment: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onComment}
      className="flex w-full items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-left text-sm text-muted-foreground/80 hover:bg-accent hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
    >
      <MessageSquarePlusIcon className="size-3.5 shrink-0" />
      Comment on this milestone…
    </button>
  );
}
