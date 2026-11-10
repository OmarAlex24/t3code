import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  formatSubagentDisplayTitle,
  summarizeSubagentStatuses,
} from "@t3tools/client-runtime/state/subagent-display";
import {
  deriveWorkflowGroups,
  isActiveSubagentStatus,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationV2Subagent, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";
import { formatModelSlugName } from "@t3tools/shared/model";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import {
  EnvironmentSubagentAvatar,
  SubagentHoverCard,
  subagentDetailLine,
  SubagentTimelineLink,
  useSubagentLink,
} from "./V2LifecycleRow";

/** How many agents a tray shows before folding the rest. */
const TRAY_LIMIT = 6;

const linkProps = (
  threadRef: ScopedThreadRef,
  agent: OrchestrationV2Subagent,
  onOpenThread: (threadId: ThreadId) => void,
) => ({
  parentRef: threadRef,
  subagentId: agent.id,
  providerInstanceId: agent.providerInstanceId,
  origin: agent.origin,
  status: agent.status,
  driver: agent.driver,
  title: formatSubagentDisplayTitle(agent.title ?? "Subagent"),
  result: agent.result,
  progress: agent.progress,
  startedAt: agent.startedAt,
  completedAt: agent.completedAt,
  threadId: agent.childThreadId,
  remote: agent.remoteChild,
  onOpenThread,
});

type Tone = "info" | "success" | "error" | "warning" | "outline";

function statusBadge(status: OrchestrationV2Subagent["status"]): {
  readonly label: string;
  readonly tone: Tone;
} {
  switch (status) {
    case "running":
      return { label: "Running", tone: "info" };
    case "waiting":
      return { label: "Waiting", tone: "info" };
    case "pending":
      return { label: "Queued", tone: "outline" };
    case "idle":
      return { label: "Idle", tone: "outline" };
    case "completed":
      return { label: "Done", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "error" };
    case "cancelled":
    case "interrupted":
      return { label: "Stopped", tone: "outline" };
  }
}

function WorkflowBar(props: { readonly agent: OrchestrationV2Subagent }) {
  const group = deriveWorkflowGroups(projectedSubagentsToRuntime([props.agent]))[0];
  if (group === undefined || group.phases.length === 0) return null;
  const done = group.phases.filter((phase) => phase.state === "done").length;
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="flex w-16 gap-0.5">
        {group.phases.map((phase) => (
          <span
            key={phase.index}
            className={cn(
              "h-1 flex-1 rounded-full",
              phase.state === "done"
                ? "bg-success/60"
                : phase.state === "running"
                  ? "bg-info"
                  : "bg-border",
            )}
          />
        ))}
      </span>
      {done}/{group.phases.length} phases
    </span>
  );
}

/** A subagent as a card: who it is, its state, the line it last reported, and its time. */
function AgentCard(props: {
  readonly threadRef: ScopedThreadRef;
  readonly agent: OrchestrationV2Subagent;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { agent } = props;
  const link = useSubagentLink(linkProps(props.threadRef, agent, props.onOpenThread));
  const status = link.liveStatus;
  // "waiting" alone can mean waiting on its own tools; only a pending request is waiting on you.
  const shell = useQuietThreadShell(
    status === "waiting" && agent.childThreadId !== null
      ? scopeThreadRef(props.threadRef.environmentId, agent.childThreadId)
      : null,
  );
  const approval = shell?.hasPendingApprovals === true;
  const needsYou = approval || shell?.hasPendingUserInput === true;
  const badge = needsYou ? { label: "Needs you", tone: "warning" as const } : statusBadge(status);
  const failed = status === "failed";
  const settled = badge.tone === "success" || badge.tone === "outline";
  const detail = needsYou
    ? approval
      ? "It needs your approval to continue."
      : "It has a question for you."
    : subagentDetailLine(status, link.result, link.progress);
  const subtitle = [
    agent.workflow === undefined ? null : "Workflow",
    agent.model ? formatModelSlugName(agent.model) : null,
    link.remote === undefined ? null : `on ${link.remote.label}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const title = formatSubagentDisplayTitle(agent.title ?? "Subagent");
  const action = needsYou ? "Answer" : failed ? "Open" : null;
  const className = cn(
    "flex size-full min-w-0 flex-col gap-1.5 rounded-xl border bg-card px-2.5 py-2 text-left shadow-xs/5",
    needsYou ? "border-warning/45" : failed ? "border-destructive/30" : null,
  );
  const content = (
    <>
      <span className="flex min-w-0 items-start gap-2.5">
        <EnvironmentSubagentAvatar
          environmentId={props.threadRef.environmentId}
          providerInstanceId={agent.providerInstanceId}
          driver={agent.driver}
          remote={link.remote}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{title}</span>
          {subtitle ? (
            <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
          ) : null}
        </span>
      </span>
      <span
        className={cn(
          "line-clamp-2 min-h-8 text-xs leading-4",
          failed ? "text-destructive" : settled ? "text-muted-foreground" : "text-foreground/85",
        )}
      >
        {detail}
      </span>
      <span className="mt-auto flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Badge variant={badge.tone}>
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {badge.label}
        </Badge>
        {agent.workflow === undefined ? null : <WorkflowBar agent={agent} />}
        <span className="flex-1" />
        <AgentElapsed agent={link.timing} />
        {action !== null && link.open !== null ? (
          <span className="rounded-md border bg-background px-1.5 py-px font-medium text-foreground group-hover/agent:bg-accent">
            {action}
          </span>
        ) : null}
      </span>
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger
        delay={500}
        render={
          link.open === null ? (
            <div aria-description={badge.label} className={className}>
              {content}
            </div>
          ) : (
            <button
              type="button"
              aria-label={`Open ${title}`}
              aria-description={badge.label}
              onClick={link.open}
              className={cn(
                className,
                "group/agent cursor-pointer transition-colors hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
              )}
            >
              {content}
            </button>
          )
        }
      />
      <SubagentHoverCard {...linkProps(props.threadRef, agent, props.onOpenThread)} link={link} />
    </Tooltip>
  );
}

/** Agents that need a look come first, then live ones, then settled ones, each in start order. */
const trayRank = ({ status }: OrchestrationV2Subagent) =>
  status === "waiting" || status === "failed" ? 0 : isActiveSubagentStatus(status) ? 1 : 2;

export function agentTraySummary(agents: ReadonlyArray<OrchestrationV2Subagent>) {
  return summarizeSubagentStatuses(agents.map(({ status }) => status));
}

/**
 * A milestone's agents in a tray: cards while the work is live, compact rows once it settled.
 * Past {@link TRAY_LIMIT} the rest fold behind a button.
 */
export function AgentTray(props: {
  readonly threadRef: ScopedThreadRef;
  readonly agents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly layout: "cards" | "rows";
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (props.agents.length === 0) return null;
  const sorted = copySorted(props.agents, (left, right) => trayRank(left) - trayRank(right));
  const visible = showAll ? sorted : sorted.slice(0, TRAY_LIMIT);
  const hidden = sorted.length - visible.length;
  return (
    <div className="@container rounded-xl bg-muted/45 p-1.5">
      <ul className={cn("grid gap-1.5", props.layout === "cards" ? "@md:grid-cols-2" : "gap-1")}>
        {visible.map((agent) => (
          <li
            key={agent.id}
            data-milestone-agent={agent.id}
            className={cn(
              "min-w-0 scroll-mt-12",
              props.layout === "rows" && "rounded-lg border bg-card",
            )}
          >
            {props.layout === "cards" ? (
              <AgentCard
                threadRef={props.threadRef}
                agent={agent}
                onOpenThread={props.onOpenThread}
              />
            ) : (
              <SubagentTimelineLink {...linkProps(props.threadRef, agent, props.onOpenThread)} />
            )}
          </li>
        ))}
      </ul>
      {sorted.length > TRAY_LIMIT ? (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className="mt-1 w-full rounded-lg py-1 text-center text-xs text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
        >
          {showAll ? "Show fewer" : `Show ${hidden} more ${hidden === 1 ? "agent" : "agents"}`}
        </button>
      ) : null}
    </div>
  );
}

/** A few overlapping provider tiles for a folded milestone. */
export function AgentStack(props: {
  readonly threadRef: ScopedThreadRef;
  readonly agents: ReadonlyArray<OrchestrationV2Subagent>;
}) {
  return (
    <span className="flex">
      {props.agents.slice(0, 3).map((agent, index) => (
        <span key={agent.id} className={cn(index > 0 && "-ml-2")}>
          <EnvironmentSubagentAvatar
            environmentId={props.threadRef.environmentId}
            providerInstanceId={agent.providerInstanceId}
            driver={agent.driver}
            remote={agent.remoteChild}
          />
        </span>
      ))}
    </span>
  );
}
