import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { LinkRequestItem } from "@t3tools/client-runtime/link-request";
import type { SecretRequestItem } from "@t3tools/client-runtime/secret-request";
import { agentThreadRef, type AgentAsk } from "@t3tools/client-runtime/state/thread-milestone-map";
import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import { fullAccessOverrideExplanation } from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type OrchestrationV2Milestone,
  type OrchestrationV2Subagent,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { useState } from "react";
import { flushSync } from "react-dom";
import { create } from "zustand";

import { cn } from "~/lib/utils";
import { useChildThreadInputs } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import {
  childThreadApprovalsAtom,
  childThreadSecretRequestsAtom,
  threadEnvironment,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { LinkRequestCard } from "./LinkRequestCard";
import { ProviderTile } from "./MilestoneMapCards";
import { SecretRequestCard, type SecretRequestAttribution } from "./SecretRequestCard";

/** What the coordinator is asking you right now, shown on the milestone it is working on. */
export type CoordinatorAsk =
  | { readonly kind: "input"; readonly question: string | null }
  | { readonly kind: "approval" }
  /** A secret or link card is answered in place, never in the composer. */
  | { readonly kind: "card"; readonly item: SecretRequestItem | LinkRequestItem };

/** The ask an agent card's Answer picked, so the dock opens and flashes it. */
const useAskFocusStore = create<{ readonly key: string | null; readonly nonce: number }>(() => ({
  key: null,
  nonce: 0,
}));

/** Opens the ask of the agent thread `key` in the dock and moves focus to its answer. */
export function focusAgentAsk(key: string) {
  flushSync(() => useAskFocusStore.setState((state) => ({ key, nonce: state.nonce + 1 })));
  const row = document.querySelector(`[data-agent-ask="${CSS.escape(key)}"]`);
  row
    ?.querySelector<HTMLElement>("input:not(:disabled), [data-ask-actions] button:not(:disabled)")
    ?.focus();
}

/** What each of the thread's agents waits on you for, by the agent thread's key. */
export function useAgentAsks(threadRef: ScopedThreadRef): ReadonlyMap<string, AgentAsk> {
  const inputs = useChildThreadInputs(threadRef);
  const approvals = useAtomValue(childThreadApprovalsAtom(threadRef));
  const secrets = useAtomValue(childThreadSecretRequestsAtom(threadRef));
  const asks = new Map<string, AgentAsk>();
  for (const child of inputs) {
    if (child.hasPendingUserInput) {
      asks.set(scopedThreadKey({ environmentId: child.environmentId, threadId: child.id }), {
        kind: "input",
      });
    }
  }
  for (const { thread, approval } of approvals) {
    asks.set(scopedThreadKey(thread), { kind: "approval", command: approval.detail || null });
  }
  for (const { thread, item } of secrets) {
    asks.set(scopedThreadKey(thread), { kind: "secret", label: item.label });
  }
  return asks;
}

type Attribution = SecretRequestAttribution;

function attributionOf(
  thread: ScopedThreadRef,
  fallbackTitle: string,
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  milestones: ReadonlyArray<OrchestrationV2Milestone>,
): Attribution {
  const key = scopedThreadKey(thread);
  const subagent =
    subagents.findLast((agent) => {
      const ref = agentThreadRef(agent, thread.environmentId);
      return ref !== null && scopedThreadKey(ref) === key;
    }) ?? null;
  const milestone =
    subagent?.milestoneId === undefined
      ? undefined
      : milestones.find(({ id }) => id === subagent.milestoneId);
  return {
    icon: <ProviderTile driver={subagent?.driver ?? null} size="sm" />,
    title: subagent?.title ?? fallbackTitle,
    subtitle: [subagent?.model ? formatModelSlugName(subagent.model) : null, milestone?.title]
      .filter(Boolean)
      .join(" · "),
  };
}

function ApprovalRow({
  entry,
  attribution,
  flash,
}: {
  entry: ChildThreadApproval;
  attribution: Attribution;
  flash: boolean;
}) {
  const canRespond = useEnvironmentScope(entry.thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { approval } = entry;
  const notes = [
    approval.appName ?? null,
    approval.responseCapability === "live"
      ? null
      : "Provider process is gone. Interrupt or restart the child thread to respond.",
    approval.reason ?? null,
    approval.fullAccessOverride ? fullAccessOverrideExplanation(approval.fullAccessOverride) : null,
  ].filter((note) => note !== null);
  return (
    <section
      aria-label={`Approval from ${attribution.title}`}
      className={cn(
        "grid w-full max-w-140 gap-1.5 rounded-xl border bg-card py-1.75 pr-2 pl-2.25 text-sm shadow-lg/5",
        flash && "border-warning/60",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.25">
        {attribution.icon}
        <span className="min-w-0 flex-1 wrap-anywhere text-foreground/80">
          <b className="font-semibold text-foreground">{attribution.title}</b>{" "}
          {approval.detail ? (
            <>
              wants to run{" "}
              <code className="rounded-sm bg-muted px-1.25 py-px font-mono text-xs">
                {approval.detail}
              </code>
            </>
          ) : (
            <>needs approval for {approval.requestKind}</>
          )}
        </span>
        <span data-ask-actions className="flex shrink-0 items-center gap-1.5">
          <ComposerPendingApprovalActions
            requestId={approval.requestId}
            isResponding={responding}
            canRespond={approval.responseCapability === "live"}
            disabled={!canRespond}
            options={approval.options}
            onRespondToApproval={async (requestId, decision) => {
              if (!canRespond || responding) return;
              setResponding(true);
              setError(null);
              const result = await respond({
                environmentId: entry.thread.environmentId,
                input: { threadId: entry.thread.threadId, requestId, decision },
              });
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                const failure = squashAtomCommandFailure(result);
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Failed to submit approval decision.",
                );
              }
              setResponding(false);
              return result;
            }}
          />
        </span>
      </div>
      {notes.map((note) => (
        <p key={note} className="pl-9 text-xs text-muted-foreground">
          {note}
        </p>
      ))}
      {error !== null ? (
        <p role="alert" className="pl-9 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function AgentSecret(props: {
  readonly askKey: string;
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly item: SecretRequestItem;
  readonly attribution: Attribution;
  readonly flash: boolean;
}) {
  const nonce = useAskFocusStore((state) => (state.key === props.askKey ? state.nonce : 0));
  const [collapsedAt, setCollapsedAt] = useState<number | null>(null);
  return (
    <SecretRequestCard
      environmentId={props.environmentId}
      item={props.item}
      visibility="local"
      attribution={props.attribution}
      flash={props.flash}
      collapsed={collapsedAt !== null && nonce <= collapsedAt}
      onCollapse={() => setCollapsedAt(useAskFocusStore.getState().nonce)}
      onExpand={() => focusAgentAsk(props.askKey)}
    />
  );
}

/**
 * Asks waiting on you above the composer: each agent's secret, then each approval as one row,
 * named after the agent and its milestone. A coordinator card joins them while Chat is hidden.
 */
export function AgentAsks(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly milestones: ReadonlyArray<OrchestrationV2Milestone>;
  readonly coordinatorCard: SecretRequestItem | LinkRequestItem | null;
}) {
  const approvals = useAtomValue(childThreadApprovalsAtom(props.threadRef));
  const secrets = useAtomValue(childThreadSecretRequestsAtom(props.threadRef));
  const flashKey = useAskFocusStore((state) => state.key);
  const card = props.coordinatorCard;
  if (approvals.length === 0 && secrets.length === 0 && card === null) return null;
  const attribution = (thread: ScopedThreadRef, title: string) =>
    attributionOf(thread, title, props.subagents, props.milestones);
  return (
    <div className="scrollbar-gutter-both mb-2 flex max-h-80 flex-col items-center gap-2 overflow-auto">
      {card === null || props.threadRef === null ? null : card.type === "secret_request" ? (
        <SecretRequestCard
          environmentId={props.threadRef.environmentId}
          item={card}
          visibility="local"
        />
      ) : (
        <LinkRequestCard
          environmentId={props.threadRef.environmentId}
          item={card}
          visibility="local"
        />
      )}
      {secrets.map((entry) => {
        const key = scopedThreadKey(entry.thread);
        return (
          <div
            key={JSON.stringify([key, entry.item.id])}
            data-agent-ask={key}
            className="w-full max-w-140"
          >
            <AgentSecret
              askKey={key}
              environmentId={entry.thread.environmentId}
              item={entry.item}
              attribution={attribution(entry.thread, entry.title)}
              flash={flashKey === key}
            />
          </div>
        );
      })}
      {approvals.map((entry) => {
        const key = scopedThreadKey(entry.thread);
        return (
          <div
            key={JSON.stringify([key, entry.approval.requestId])}
            data-agent-ask={key}
            className="flex w-full justify-center"
          >
            <ApprovalRow
              entry={entry}
              attribution={attribution(entry.thread, entry.title)}
              flash={flashKey === key}
            />
          </div>
        );
      })}
    </div>
  );
}
