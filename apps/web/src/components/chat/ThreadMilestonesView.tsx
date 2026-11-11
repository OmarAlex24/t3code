import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import { deriveMilestoneBoards } from "@t3tools/client-runtime/state/thread-milestone-board";
import {
  deriveCoordinatorActivity,
  type MilestoneCoordinator,
} from "@t3tools/client-runtime/state/thread-milestone-graph";
import {
  deriveThreadTrace,
  formatTraceDuration,
  threadTraceDomain,
  type ThreadTrace,
  type TraceAgent,
  type TraceCounts,
  type TraceDomain,
  type TraceGroup,
  type TraceRow,
  traceRowDomain,
} from "@t3tools/client-runtime/state/thread-milestone-trace";
import type {
  OrchestrationV2Milestone,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { type MilestoneZoom, useThreadViewModeStore } from "../../threadViewModeStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import {
  boardCounts,
  CommentButton,
  type CoordinatorAsk,
  CoordinatorAskCard,
  MilestoneBoard,
} from "./MilestoneBoard";
import {
  afterNowStyle,
  atNowStyle,
  atStyle,
  MilestoneStatusIcon,
  spanStyle,
  TraceBar,
  TraceChart,
  traceCoverClass,
  TraceLabel,
  TraceLegendSwatch,
  TracePin,
  TracePlot,
  traceRowClass,
  TraceStrand,
  TraceText,
  useAgentsWaitingOnYou,
} from "./MilestoneTrace";
import {
  EnvironmentSubagentAvatar,
  SubagentHoverCard,
  subagentDetailLine,
  useSubagentLink,
} from "./V2LifecycleRow";

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "subagents" | "milestones" | "messages"
>;
type Tone = "info" | "success" | "error" | "warning" | "outline";

const iso = (ms: number | null) =>
  ms === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));
const plural = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;

/** Zooming in, from the view or the Plan panel, takes focus so Esc and the arrows reach the view. */
function focusZoomedPanel(node: HTMLDivElement | null) {
  const active = document.activeElement;
  if (
    node === null ||
    (active instanceof HTMLElement &&
      (active.isContentEditable || active.closest("input, textarea, select") !== null))
  )
    return;
  node.focus({ preventScroll: true });
}

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

function coordinatorPhrase(
  coordinator: MilestoneCoordinator,
  awaitingUser: boolean,
  activity: string | null,
): string {
  if (awaitingUser) return "Waiting for you";
  switch (coordinator.status) {
    case "waiting":
      return activity ?? `Waiting on ${plural(coordinator.liveAgents, "agent")}`;
    case "working":
      return activity ?? "Working";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Stopped";
    case "idle":
      return "Idle";
  }
}

function overallBadge(
  coordinator: MilestoneCoordinator,
  awaitingUser: boolean,
  allDone: boolean,
): { readonly label: string; readonly tone: Tone } {
  if (awaitingUser) return { label: "Needs you", tone: "warning" };
  switch (coordinator.status) {
    case "working":
    case "waiting":
      return { label: "Working", tone: "info" };
    case "failed":
      return { label: "Failed", tone: "error" };
    case "interrupted":
      return { label: "Stopped", tone: "warning" };
    case "idle":
      return allDone ? { label: "Done", tone: "success" } : { label: "Idle", tone: "outline" };
  }
}

function rowBadge(status: TraceRow["status"]): { readonly label: string; readonly tone: Tone } {
  switch (status) {
    case "active":
      return { label: "In progress", tone: "info" };
    case "done":
      return { label: "Done", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "error" };
    case "stopped":
      return { label: "Stopped", tone: "outline" };
    case "dropped":
      return { label: "Dropped", tone: "outline" };
    case "planned":
      return { label: "Planned", tone: "outline" };
  }
}

const AGENT_BADGE: Record<TraceAgent["status"], { readonly label: string; readonly tone: Tone }> = {
  running: { label: "Running", tone: "info" },
  "needs-you": { label: "Needs you", tone: "warning" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  queued: { label: "Queued", tone: "outline" },
  stopped: { label: "Stopped", tone: "outline" },
};

function StatusBadge(props: {
  readonly label: string;
  readonly tone: Tone;
  readonly dot?: boolean;
}) {
  return (
    <Badge variant={props.tone}>
      {props.dot === false ? null : (
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
      )}
      {props.label}
    </Badge>
  );
}

const live = (counts: TraceCounts) => counts.running + counts.needsYou;

/** "1 of 3 done · 1 failed · needs you" for a group sub-row. */
function groupSummary(group: TraceGroup): ReactNode {
  const { counts } = group;
  return (
    <>
      {counts.done} of {group.agents.length} done
      {counts.failed > 0 ? (
        <span className="text-destructive"> · {counts.failed} failed</span>
      ) : null}
      {counts.needsYou > 0 ? <span className="text-warning"> · needs you</span> : null}
    </>
  );
}

/** "1 running · 1/3 done · 1 failed" for a group header in a zoomed milestone. */
function groupDetail(group: TraceGroup): ReactNode {
  const { counts } = group;
  return (
    <>
      {live(counts) > 0 ? `${live(counts)} running · ` : ""}
      {counts.done}/{group.agents.length} done
      {counts.failed > 0 ? (
        <span className="text-destructive"> · {counts.failed} failed</span>
      ) : null}
      {counts.needsYou > 0 ? (
        <span className="text-warning"> · {counts.needsYou} needs you</span>
      ) : null}
    </>
  );
}

function RowDuration(props: { readonly row: TraceRow }) {
  const { span } = props.row;
  if (span === null) return null;
  return span.endMs === null ? (
    <AgentElapsed agent={{ status: "running", startedAt: iso(span.startMs), completedAt: null }} />
  ) : (
    <span className="tabular-nums">{formatTraceDuration(span.endMs - span.startMs)}</span>
  );
}

function rowMeta(row: TraceRow, trace: ThreadTrace, posts: number): ReactNode {
  if (row.status === "planned") return trace.kind === "turns" ? "Queued" : "Planned";
  const parts: Array<ReactNode> = [
    row.status === "dropped" ? "Dropped" : <RowDuration key="time" row={row} />,
  ];
  if (row.agentCount > 0) {
    parts.push(plural(row.agentCount, "agent"));
    if (live(row.counts) > 1) {
      parts.push(
        <span key="parallel" className="text-info">
          {live(row.counts)} in parallel
        </span>,
      );
    } else if (row.counts.failed > 0) {
      parts.push(
        <span key="failed" className="text-destructive">
          {row.counts.failed} failed
        </span>,
      );
    } else if (row.peakParallel > 1) {
      parts.push(`${row.peakParallel} in parallel`);
    }
  }
  if (posts > 0 && parts.length < 3) parts.push(`${posts} on the board`);
  return parts.flatMap((part, index) => (index === 0 ? [part] : [" · ", part]));
}

function Revision(props: { readonly milestone: OrchestrationV2Milestone }) {
  const { milestone } = props;
  if (milestone.revision !== undefined) {
    return (
      <p className="mt-1.5 max-w-152 border-l-2 border-warning/45 pl-2.5 text-xs text-muted-foreground">
        <span className="font-medium text-warning">Changed</span> from{" "}
        <s className="text-muted-foreground/70">{milestone.revision.previousTitle}</s>
        <br />
        {milestone.revision.reason}
      </p>
    );
  }
  return milestone.note === undefined ? null : (
    <p className="mt-1.5 max-w-152 text-sm text-muted-foreground">{milestone.note}</p>
  );
}

function AnswerAgentButton(props: {
  readonly threadRef: ScopedThreadRef;
  readonly agent: OrchestrationV2Subagent;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const link = useSubagentLink(linkProps(props.threadRef, props.agent, props.onOpenThread));
  if (link.open === null) return null;
  return (
    <Button size="xs" variant="outline" className="pointer-events-auto" onClick={link.open}>
      Answer
    </Button>
  );
}

/** A subagent that waits on you, answerable from the whole-thread view. */
function AgentNeedsYouRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly agent: OrchestrationV2Subagent;
  readonly approval: boolean;
  readonly group: string | null;
  readonly rowTitle: string;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-warning/45 bg-warning/10 py-1.5 pr-2 pl-3 text-sm">
      <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">
          {formatSubagentDisplayTitle(props.agent.title ?? "Subagent")}
        </span>{" "}
        {props.approval ? "needs your approval" : "has a question for you"}{" "}
        <span className="text-xs text-muted-foreground">
          {props.group === null ? "" : `· ${props.group} `}· {props.rowTitle}
        </span>
      </span>
      <AnswerAgentButton
        threadRef={props.threadRef}
        agent={props.agent}
        onOpenThread={props.onOpenThread}
      />
    </div>
  );
}

/** One agent in a zoomed milestone; the row opens its chat. */
function TraceAgentRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly entry: TraceAgent;
  readonly domain: TraceDomain;
  readonly indented: boolean;
  readonly highlighted: boolean;
  readonly approval: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { entry, domain } = props;
  const { agent, status } = entry;
  const link = useSubagentLink(linkProps(props.threadRef, agent, props.onOpenThread));
  const title = formatSubagentDisplayTitle(agent.title ?? "Subagent");
  const detail =
    status === "needs-you"
      ? props.approval
        ? "Needs your approval"
        : "Has a question for you"
      : status === "failed"
        ? (subagentDetailLine(link.liveStatus, link.result, link.progress) ?? "Failed")
        : null;
  const model = agent.model ? formatModelSlugName(agent.model) : null;
  const badge = AGENT_BADGE[status];
  return (
    <div
      ref={(node) => {
        if (node && props.highlighted) node.scrollIntoView({ block: "nearest" });
      }}
      data-milestone-agent={agent.id}
      className={cn(
        traceRowClass,
        "min-h-[46px] border-transparent",
        props.highlighted && "bg-info/12",
      )}
    >
      {link.open === null ? null : (
        <Tooltip>
          <TooltipTrigger
            delay={500}
            render={
              <button
                type="button"
                aria-label={`Open ${title}`}
                aria-description={badge.label}
                onClick={link.open}
                className={traceCoverClass}
              />
            }
          />
          <SubagentHoverCard
            {...linkProps(props.threadRef, agent, props.onOpenThread)}
            link={link}
          />
        </Tooltip>
      )}
      <TraceLabel className={props.indented ? "pl-10" : undefined}>
        <EnvironmentSubagentAvatar
          environmentId={props.threadRef.environmentId}
          providerInstanceId={agent.providerInstanceId}
          driver={agent.driver}
          remote={link.remote}
        />
        <TraceText
          title={title}
          metaClassName={
            status === "failed"
              ? "text-destructive"
              : status === "needs-you"
                ? "text-warning"
                : undefined
          }
          meta={
            detail ?? (
              <>
                {[model, link.remote === undefined ? null : `on ${link.remote.label}`]
                  .filter(Boolean)
                  .join(" · ")}
                {status === "queued" ? (
                  model ? null : (
                    "Queued"
                  )
                ) : (
                  <>
                    {model || link.remote ? " · " : ""}
                    <AgentElapsed agent={link.timing} />
                  </>
                )}
              </>
            )
          }
        />
      </TraceLabel>
      <TracePlot>
        {entry.span === null ? (
          <TraceBar tone="queued" style={{ ...atNowStyle, width: "5%" }} />
        ) : (
          <TraceBar tone={status} style={spanStyle(domain, entry.span)} />
        )}
      </TracePlot>
      <div className="pointer-events-none relative flex items-center justify-end pr-3">
        {status === "needs-you" ? (
          <AnswerAgentButton
            threadRef={props.threadRef}
            agent={agent}
            onOpenThread={props.onOpenThread}
          />
        ) : (
          <StatusBadge {...badge} dot={status === "running"} />
        )}
      </div>
    </div>
  );
}

/**
 * The thread on one time axis. Zoomed out it shows every milestone (or turn) with its groups of
 * agents running side by side; zoomed in it rescales to one milestone and lists each agent.
 */
export function ThreadMilestonesView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projection: Projection;
  readonly turnItems: ReadonlyArray<ThreadStructureTurnItem>;
  readonly coordinatorAsk: CoordinatorAsk | null;
  readonly bottomInset: number;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** Starts a comment on `milestone` in the composer; null when this client cannot send. */
  readonly onComment: ((milestone: OrchestrationV2Milestone) => void) | null;
}) {
  const { threadRef, projection } = props;
  const environmentId = threadRef.environmentId;
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [transition, setTransition] = useState<"in" | "out" | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const waiting = useAgentsWaitingOnYou(threadRef);
  const storedZoom = useThreadViewModeStore(
    (state) => state.zoomByThreadKey[scopedThreadKey(threadRef)] ?? null,
  );
  const setStoredZoom = useThreadViewModeStore((state) => state.setZoom);
  const setMode = useThreadViewModeStore((state) => state.setMode);
  const revealInChat = useThreadViewModeStore((state) => state.revealInChat);
  const boards = deriveMilestoneBoards(props.turnItems, (item) =>
    item.textOmitted
      ? (projection.messages.find(({ id }) => id === item.messageId)?.text ?? "")
      : item.text,
  );
  const trace = deriveThreadTrace({
    projection,
    turnItems: props.turnItems,
    boards,
    needsYou: waiting.needsYou,
    nowMs: clockMs,
  });
  const activity = deriveCoordinatorActivity(props.turnItems);
  const rows = trace?.rows ?? [];
  const zoomIndex = storedZoom === null ? -1 : rows.findIndex(({ id }) => id === storedZoom.rowId);
  const zoomedRow = rows[zoomIndex] ?? null;
  const highlight = zoomedRow === null ? null : storedZoom!.highlight;

  const zoom = (next: MilestoneZoom | null) => {
    setTransition(next === null ? "out" : "in");
    setStoredZoom(threadRef, next);
  };
  const step = (delta: number) => {
    const next = rows[zoomIndex + delta];
    if (next !== undefined) zoom({ rowId: next.id, highlight: null });
  };
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      zoomedRow === null ||
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const target = event.target;
    // Keys reach the view only from the page itself or from inside the view, never from the
    // composer, a dialog or a field.
    if (
      !(target instanceof Element) ||
      (target !== document.body && !containerRef.current?.contains(target)) ||
      target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
    )
      return;
    if (event.key === "Escape") zoom(null);
    else if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowRight") step(1);
    else return;
    event.preventDefault();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens on the window for Esc and the arrow keys that zoom out and step milestones
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const answerInChat = () => setMode(threadRef, "chat");
  const jump = (entryId: string) => revealInChat(threadRef, entryId);
  const recompute = () => setClockMs(Date.now());
  const noun = trace?.kind === "turns" ? "turn" : "milestone";
  const coordinatorAvatar =
    trace?.coordinator.run == null ? null : (
      <EnvironmentSubagentAvatar
        environmentId={environmentId}
        providerInstanceId={trace.coordinator.run.providerInstanceId}
      />
    );

  let body: ReactNode;
  if (trace === null) {
    body = (
      <div className="pt-2">
        <h3 className="text-sm font-medium">Describe what you want built</h3>
        <p className="mt-0.5 max-w-120 text-xs text-muted-foreground">
          The coordinator's plan shows up here as milestones while it works.
        </p>
      </div>
    );
  } else if (zoomedRow === null) {
    body = (
      <ZoomedOut
        trace={trace}
        threadRef={threadRef}
        coordinatorAsk={props.coordinatorAsk}
        coordinatorAvatar={coordinatorAvatar}
        activity={activity}
        approvals={waiting.approvals}
        boardPosts={(rowId) =>
          (boards.get(rowId) ?? []).filter(({ kind }) => kind !== "comment").length
        }
        expanded={expanded}
        onToggle={(rowId) =>
          setExpanded((current) => {
            const next = new Set(current);
            if (!next.delete(rowId)) next.add(rowId);
            return next;
          })
        }
        onZoom={zoom}
        onHorizon={recompute}
        onAnswerInChat={answerInChat}
        onOpenThread={props.onOpenThread}
      />
    );
  } else {
    const row = zoomedRow;
    const items = boards.get(row.id) ?? [];
    const named = row.groups.some(({ name }) => name !== null);
    const domain = traceRowDomain(trace, row);
    const isActive = row.status === "active";
    const coordinatorRuns = trace.coordinator.runs.filter(
      (run) =>
        row.span !== null &&
        run.startMs <= (row.span.endMs ?? trace.nowMs) &&
        (run.endMs ?? trace.nowMs) >= row.span.startMs,
    );
    const model = trace.coordinator.run
      ? formatModelSlugName(trace.coordinator.run.modelSelection.model)
      : null;
    body = (
      <>
        <div className="mb-2.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Button size="xs" variant="ghost" onClick={() => zoom(null)}>
            <ArrowLeftIcon />
            All {noun}s
          </Button>
          <Kbd>Esc</Kbd>
          <span className="flex-1" />
          <span className="tabular-nums">
            {noun === "turn" ? "Turn" : "Milestone"} {zoomIndex + 1} of {rows.length}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Previous ${noun}`}
            disabled={zoomIndex === 0}
            onClick={() => step(-1)}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Next ${noun}`}
            disabled={zoomIndex === rows.length - 1}
            onClick={() => step(1)}
          >
            <ChevronRightIcon />
          </Button>
        </div>
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="pt-0.5">
            <MilestoneStatusIcon status={row.status} />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              className={cn(
                "truncate text-base font-semibold",
                row.status === "dropped" && "text-muted-foreground line-through",
              )}
            >
              {row.title}
            </h2>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>{row.span === null ? "Not started" : <RowDuration row={row} />}</span>
              {row.agentCount > 0 ? (
                <span>
                  {plural(row.agentCount, "agent")}
                  {named ? ` in ${plural(row.groups.length, "group")}` : ""}
                </span>
              ) : null}
            </div>
          </div>
          <StatusBadge {...rowBadge(row.status)} dot={isActive} />
        </div>
        {row.milestone === null ? null : <Revision milestone={row.milestone} />}
        {isActive && props.coordinatorAsk !== null ? (
          <div className="mt-3">
            <CoordinatorAskCard
              environmentId={environmentId}
              ask={props.coordinatorAsk}
              onAnswerInChat={answerInChat}
            />
          </div>
        ) : null}
        {domain === null ? (
          <p className="mt-1.5 text-sm text-muted-foreground">
            {row.status === "planned"
              ? `This ${noun} starts after the current one. The coordinator may change it before then.`
              : `This ${noun} never started.`}
          </p>
        ) : (
          <div className="mt-3.5">
            <TraceChart
              domain={domain}
              nowMs={trace.nowMs}
              live={trace.live && row.span?.endMs === null}
              zoomed
              axisLabel={`Since this ${noun} started`}
              onHorizon={recompute}
              legend={
                row.groups.length > 1 && named ? (
                  <span>
                    {plural(row.groups.length, "group")} ran in parallel; overlapping bars ran at
                    the same time.
                  </span>
                ) : undefined
              }
            >
              <div className={cn(traceRowClass, "min-h-[46px]")}>
                <TraceLabel>
                  {coordinatorAvatar}
                  <TraceText
                    title="Coordinator"
                    meta={[
                      model,
                      isActive
                        ? coordinatorPhrase(
                            trace.coordinator,
                            props.coordinatorAsk !== null,
                            activity,
                          )
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  />
                </TraceLabel>
                <TracePlot>
                  {coordinatorRuns.map((run) => (
                    <TraceBar key={run.startMs} tone="coordinator" style={spanStyle(domain, run)} />
                  ))}
                </TracePlot>
                <div className="relative flex items-center justify-end pr-3">
                  {isActive && trace.live ? <StatusBadge label="Working" tone="info" /> : null}
                </div>
              </div>
              {row.groups.flatMap((group) => {
                const headed = named;
                const groupHighlighted =
                  highlight?.kind === "group" && highlight.name === group.name;
                return [
                  headed ? (
                    <div
                      key={`group:${group.name ?? ""}`}
                      className={cn(
                        traceRowClass,
                        "min-h-[30px] bg-muted/50",
                        groupHighlighted &&
                          "before:absolute before:inset-y-0 before:left-0 before:w-0.75 before:bg-info",
                      )}
                    >
                      <TraceLabel className="gap-1.5 py-1">
                        <span className="shrink-0 text-xs font-semibold">
                          {group.name ?? "Agents"}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                          {groupDetail(group)}
                        </span>
                      </TraceLabel>
                      <TracePlot>
                        {group.span === null ? null : (
                          <TraceBar tone="group" style={spanStyle(domain, group.span, "1%")} />
                        )}
                      </TracePlot>
                    </div>
                  ) : null,
                  ...group.agents.map((entry) => (
                    <TraceAgentRow
                      key={entry.agent.id}
                      threadRef={threadRef}
                      entry={entry}
                      domain={domain}
                      indented={headed}
                      highlighted={highlight?.kind === "agent" && highlight.id === entry.agent.id}
                      approval={
                        entry.agent.childThreadId !== null &&
                        waiting.approvals.has(entry.agent.childThreadId)
                      }
                      onOpenThread={props.onOpenThread}
                    />
                  )),
                ];
              })}
              {row.agentCount === 0 ? (
                <div className={cn(traceRowClass, "min-h-[46px]")}>
                  <TraceLabel>
                    <span className="text-xs text-muted-foreground">No agents in this {noun}.</span>
                  </TraceLabel>
                </div>
              ) : null}
            </TraceChart>
          </div>
        )}
        {items.length === 0 &&
        !(isActive && props.onComment !== null && row.milestone !== null) ? null : (
          <section className="mt-4 grid gap-2">
            <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
              <span className="text-xs font-semibold text-foreground">Board</span>
              <span className="min-w-0 truncate">
                {boardCounts(items)
                  .map(({ text }) => text)
                  .join(" · ")}
              </span>
            </div>
            <MilestoneBoard environmentId={environmentId} items={items} onJump={jump} />
            {props.onComment === null || row.milestone === null ? null : (
              <CommentButton onComment={() => props.onComment!(row.milestone!)} />
            )}
          </section>
        )}
      </>
    );
  }

  return (
    <div
      ref={containerRef}
      data-thread-milestones-view
      className="scrollbar-gutter-both h-full min-h-0 overflow-y-auto overscroll-y-contain ps-(--chat-lane-inset-start) pe-(--chat-lane-inset-end)"
    >
      <div
        key={zoomedRow?.id ?? "all"}
        ref={zoomedRow === null ? undefined : focusZoomedPanel}
        tabIndex={zoomedRow === null ? undefined : -1}
        data-milestone-zoom={zoomedRow === null ? undefined : ""}
        className={cn(
          "mx-auto w-full max-w-(--chat-content-max-width) origin-top px-3 pt-4 outline-none sm:px-12",
          transition === "in" && "motion-safe:animate-trace-zoom-in",
          transition === "out" && "motion-safe:animate-trace-zoom-out",
        )}
        style={{ paddingBottom: props.bottomInset + 24 }}
      >
        {body}
      </div>
    </div>
  );
}

function ZoomedOut(props: {
  readonly trace: ThreadTrace;
  readonly threadRef: ScopedThreadRef;
  readonly coordinatorAsk: CoordinatorAsk | null;
  readonly coordinatorAvatar: ReactNode;
  readonly activity: string | null;
  readonly approvals: ReadonlySet<string>;
  readonly boardPosts: (rowId: string) => number;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (rowId: string) => void;
  readonly onZoom: (zoom: MilestoneZoom) => void;
  readonly onHorizon: () => void;
  readonly onAnswerInChat: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { trace } = props;
  const domain = threadTraceDomain(trace);
  const turns = trace.kind === "turns";
  const counted = trace.rows.filter(({ current, status }) => current && status !== "dropped");
  const awaitingUser = props.coordinatorAsk !== null;
  const overall = overallBadge(
    trace.coordinator,
    awaitingUser || trace.needsYou.length > 0,
    counted.length > 0 && counted.every(({ status }) => status === "done"),
  );
  const running = live(trace.counts);
  const firstFailed = trace.firstFailed;
  const titles = new Map(trace.rows.map((row) => [row.id, row.title]));
  return (
    <>
      <div className="flex min-w-0 items-start gap-2.5">
        {props.coordinatorAvatar}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{trace.title ?? "Plan"}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground/85">
              {turns ? "Turn" : "Milestone"} {trace.position} of {trace.total}
            </span>
            {trace.agentCount > 0 ? <span>{plural(trace.agentCount, "agent")}</span> : null}
            {running > 0 ? <span className="text-info">{running} running</span> : null}
            {firstFailed === null ? null : (
              <button
                type="button"
                onClick={() =>
                  props.onZoom({
                    rowId: firstFailed.rowId,
                    highlight: { kind: "agent", id: firstFailed.agentId },
                  })
                }
                className="rounded-sm text-destructive underline decoration-current/35 underline-offset-2 outline-none hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                {trace.counts.failed} failed
              </button>
            )}
            <AgentElapsed
              agent={{
                status: trace.live ? "running" : "completed",
                startedAt: iso(trace.startMs),
                completedAt: trace.live ? null : iso(trace.nowMs),
              }}
            />
          </div>
        </div>
        <StatusBadge {...overall} />
      </div>
      {props.coordinatorAsk === null ? null : (
        <div className="mt-3">
          <CoordinatorAskCard
            environmentId={props.threadRef.environmentId}
            ask={props.coordinatorAsk}
            onAnswerInChat={props.onAnswerInChat}
          />
        </div>
      )}
      {trace.needsYou.length === 0 ? null : (
        <div className="mt-3 grid gap-1.5">
          {trace.needsYou.map(({ agent, group, rowId }) => (
            <AgentNeedsYouRow
              key={agent.id}
              threadRef={props.threadRef}
              agent={agent}
              approval={agent.childThreadId !== null && props.approvals.has(agent.childThreadId)}
              group={group}
              rowTitle={titles.get(rowId) ?? ""}
              onOpenThread={props.onOpenThread}
            />
          ))}
        </div>
      )}
      <div className="mt-3.5">
        <TraceChart
          domain={domain}
          nowMs={trace.nowMs}
          live={trace.live}
          zoomed={false}
          axisLabel={turns ? "Turns" : "Plan"}
          onHorizon={props.onHorizon}
          legend={
            <>
              <TraceLegendSwatch tone="done" label="Done" />
              <TraceLegendSwatch tone="active" label="Working" />
              {trace.rows.some(({ estimate }) => estimate !== null) ? (
                <TraceLegendSwatch tone="planned" label="Planned, by average time" />
              ) : null}
              <span className="flex-1" />
              <span>Select a {turns ? "turn" : "milestone"} to zoom in</span>
            </>
          }
        >
          <div className={cn(traceRowClass, "min-h-11")}>
            <TraceLabel>
              <span className="w-4 shrink-0" />
              {props.coordinatorAvatar}
              <TraceText
                title="Coordinator"
                meta={coordinatorPhrase(
                  trace.coordinator,
                  props.coordinatorAsk !== null,
                  props.activity,
                )}
              />
            </TraceLabel>
            <TracePlot>
              {trace.coordinator.runs.map((run) => (
                <TraceBar key={run.startMs} tone="coordinator" style={spanStyle(domain, run)} />
              ))}
            </TracePlot>
          </div>
          {trace.rows.map((row) => (
            <OverviewRow
              key={row.id}
              row={row}
              trace={trace}
              domain={domain}
              ask={row.status === "active" && props.coordinatorAsk !== null}
              posts={props.boardPosts(row.id)}
              open={props.expanded.has(row.id) !== (row.status === "active")}
              onToggle={() => props.onToggle(row.id)}
              onZoom={props.onZoom}
            />
          ))}
        </TraceChart>
      </div>
    </>
  );
}

const agentStrandStyle = (domain: TraceDomain, entry: TraceAgent, top: number) => ({
  top,
  ...(entry.span === null ? { ...atNowStyle, width: "3%" } : spanStyle(domain, entry.span, "3px")),
});

function OverviewRow(props: {
  readonly row: TraceRow;
  readonly trace: ThreadTrace;
  readonly domain: TraceDomain;
  readonly ask: boolean;
  readonly posts: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onZoom: (zoom: MilestoneZoom) => void;
}) {
  const { row, domain } = props;
  const agents = row.groups.flatMap(({ agents: members }) => members);
  const expandable = agents.length > 0;
  const strands = expandable && !props.open;
  const barStyle =
    row.estimate !== null
      ? afterNowStyle(domain, row.estimate.offsetMs, row.estimate.durationMs)
      : row.span !== null
        ? spanStyle(domain, row.span)
        : null;
  return (
    <>
      <div className={cn(traceRowClass, "min-h-11", strands && "min-h-[46px]")}>
        <button
          type="button"
          aria-label={`Zoom into ${row.title}`}
          onClick={() => props.onZoom({ rowId: row.id, highlight: null })}
          className={traceCoverClass}
        />
        <TraceLabel>
          {expandable ? (
            <button
              type="button"
              aria-expanded={props.open}
              aria-label={props.open ? "Hide agents" : "Show agents"}
              onClick={props.onToggle}
              className="pointer-events-auto grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <ChevronRightIcon
                className={cn(
                  "size-3.5 transition-transform motion-reduce:transition-none",
                  props.open && "rotate-90",
                )}
              />
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <MilestoneStatusIcon status={row.status} />
          <TraceText
            title={row.title}
            titleClassName={cn(
              row.status === "active" && "font-semibold",
              row.status === "planned" && "font-normal text-muted-foreground",
              row.status === "dropped" && "font-normal text-muted-foreground/70 line-through",
            )}
            meta={rowMeta(row, props.trace, props.posts)}
          />
        </TraceLabel>
        <TracePlot>
          {barStyle === null ? null : (
            <TraceBar tone={row.status} style={barStyle} raised={strands} />
          )}
          {row.pins.map((pin) => (
            <TracePin key={pin.id} style={atStyle(domain, pin.atMs)} raised={strands} />
          ))}
          {props.ask ? <TracePin style={atNowStyle} ask raised={strands} /> : null}
          {strands
            ? agents.map((entry, index) => (
                <TraceStrand
                  key={entry.agent.id}
                  status={entry.status}
                  style={agentStrandStyle(domain, entry, 30 + (index % 4) * 4)}
                />
              ))
            : null}
        </TracePlot>
      </div>
      {props.open
        ? row.groups.map((group) => (
            <div
              key={group.name ?? ""}
              className={cn(traceRowClass, "border-transparent")}
              style={{ minHeight: Math.max(26, 12 + group.agents.length * 6) }}
            >
              <button
                type="button"
                aria-label={`Zoom into ${group.name ?? "agents"} in ${row.title}`}
                onClick={() =>
                  props.onZoom({ rowId: row.id, highlight: { kind: "group", name: group.name } })
                }
                className={traceCoverClass}
              />
              <TraceLabel className="gap-1.5 py-1 pl-10">
                <span className="my-0.5 w-[3px] self-stretch rounded-full bg-foreground/20" />
                <span className="shrink-0 text-xs font-medium text-foreground/85">
                  {group.name ?? "Agents"}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {groupSummary(group)}
                </span>
              </TraceLabel>
              <TracePlot>
                {group.agents.map((entry, index) => (
                  <TraceStrand
                    key={entry.agent.id}
                    status={entry.status}
                    thick
                    style={agentStrandStyle(domain, entry, 8 + index * 6)}
                  />
                ))}
              </TracePlot>
            </div>
          ))
        : null}
    </>
  );
}
