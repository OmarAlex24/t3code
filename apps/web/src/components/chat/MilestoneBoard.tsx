import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { MilestoneBoardItem } from "@t3tools/client-runtime/state/thread-milestone-board";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import type {
  ChatImageAttachment,
  EnvironmentId,
  OrchestrationV2Subagent,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { AppWindowIcon, MessageSquarePlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { useQuietThreadShell } from "../../state/entities";
import { Button } from "../ui/button";

/** What the coordinator is asking you right now, shown on the milestone it is working on. */
export type CoordinatorAsk =
  | { readonly kind: "input"; readonly question: string | null }
  | { readonly kind: "approval" };

/** A board entry hangs off the spine by a short tick. */
function Pin(props: { readonly by: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="relative min-w-0">
      <span aria-hidden className="absolute top-2 -left-6.5 h-px w-2.25 bg-muted-foreground/35" />
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">{props.by}</div>
      {props.children}
    </div>
  );
}

function AskCard(props: {
  readonly who: string;
  readonly question: string | null;
  readonly hint: string;
  readonly action?: { readonly label: string; readonly run: () => void } | undefined;
}) {
  return (
    <Pin
      by={
        <>
          <span className="font-medium text-foreground">{props.who}</span> asks you · blocking
        </>
      }
    >
      <div className="rounded-xl border border-warning/35 bg-warning/5 px-3 py-2.5">
        {props.question === null ? null : (
          <p className="mb-2 text-sm text-foreground">{props.question}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
          <span>{props.hint}</span>
          {props.action === undefined ? null : (
            <Button size="xs" variant="outline" onClick={props.action.run}>
              {props.action.label}
            </Button>
          )}
        </div>
      </div>
    </Pin>
  );
}

/** A subagent waiting on you; its own chat holds the answer panel. */
function SubagentAsk(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: OrchestrationV2Subagent;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const childThreadId = props.agent.childThreadId;
  const shell = useQuietThreadShell(
    childThreadId === null ? null : scopeThreadRef(props.environmentId, childThreadId),
  );
  if (childThreadId === null || shell === null) return null;
  const approval = shell.hasPendingApprovals;
  if (!approval && !shell.hasPendingUserInput) return null;
  return (
    <AskCard
      who={formatSubagentDisplayTitle(props.agent.title ?? "Subagent")}
      question={null}
      hint={approval ? "It needs your approval to continue." : "It has a question for you."}
      action={{ label: "Answer", run: () => props.onOpenThread(childThreadId) }}
    />
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
    <div className="mt-2 flex flex-wrap gap-2">
      {props.attachments.map((attachment, index) => {
        const url = urls[index];
        return (
          <a
            key={attachment.id}
            href={url ?? undefined}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${attachment.name}`}
            className="block h-27 w-42 overflow-hidden rounded-lg border bg-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
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

/**
 * A milestone's board: questions waiting on you, the coordinator's posts and visuals, and your
 * comments. Visuals open where they rendered in Chat rather than mounting a frame here.
 */
export function MilestoneBoard(props: {
  readonly threadRef: ScopedThreadRef;
  readonly items: ReadonlyArray<MilestoneBoardItem>;
  readonly agents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly coordinatorAsk: CoordinatorAsk | null;
  readonly onAnswerInChat: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onJump: (entryId: string) => void;
  readonly onComment: (() => void) | null;
}) {
  const asking = props.agents.filter((agent) => agent.status === "waiting");
  const empty =
    props.items.length === 0 &&
    props.coordinatorAsk === null &&
    asking.length === 0 &&
    props.onComment === null;
  if (empty) return null;
  return (
    <div className="mt-2 grid gap-2.5">
      {props.coordinatorAsk === null ? null : props.coordinatorAsk.kind === "approval" ? (
        <AskCard
          who="Coordinator"
          question={null}
          hint="It needs your approval to continue."
          action={{ label: "Answer in chat", run: props.onAnswerInChat }}
        />
      ) : (
        <AskCard
          who="Coordinator"
          question={props.coordinatorAsk.question}
          hint="Answer in the panel below."
        />
      )}
      {asking.map((agent) => (
        <SubagentAsk
          key={agent.id}
          environmentId={props.threadRef.environmentId}
          agent={agent}
          onOpenThread={props.onOpenThread}
        />
      ))}
      {props.items.map((item) =>
        item.kind === "post" ? (
          <Pin key={item.id} by={<span className="font-medium text-foreground">Coordinator</span>}>
            {item.text === null ? null : (
              <p className="max-w-152 text-sm whitespace-pre-wrap text-foreground">{item.text}</p>
            )}
            {item.attachments.length === 0 ? null : (
              <PostImages
                environmentId={props.threadRef.environmentId}
                attachments={item.attachments}
              />
            )}
          </Pin>
        ) : item.kind === "visual" ? (
          <Pin key={item.id} by={<span className="font-medium text-foreground">Coordinator</span>}>
            <button
              type="button"
              onClick={() => props.onJump(item.id)}
              className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
            >
              <AppWindowIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{item.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">Show in chat</span>
            </button>
          </Pin>
        ) : (
          <Pin
            key={item.id}
            by={
              <>
                <span className="font-medium text-foreground">You</span> · sent to the coordinator
              </>
            }
          >
            <p className="w-fit max-w-152 rounded-xl border bg-card px-3 py-1.5 text-sm whitespace-pre-wrap text-foreground">
              {item.text}
            </p>
          </Pin>
        ),
      )}
      {props.onComment === null ? null : (
        <button
          type="button"
          onClick={props.onComment}
          className="relative flex w-full max-w-120 items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-left text-sm text-muted-foreground/80 hover:bg-accent hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
        >
          <span
            aria-hidden
            className="absolute top-3.5 -left-6.5 h-px w-2.25 bg-muted-foreground/35"
          />
          <MessageSquarePlusIcon className="size-3.5 shrink-0" />
          Comment on this milestone…
        </button>
      )}
    </div>
  );
}
