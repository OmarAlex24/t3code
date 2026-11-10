import {
  deriveWorkflowGroups,
  isActiveSubagentStatus,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  deriveThreadMilestoneGraph,
  type MilestoneCoordinator,
  type MilestoneGraphTurn,
} from "@t3tools/client-runtime/state/thread-milestone-graph";
import type {
  OrchestrationV2Milestone,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { CheckIcon, ChevronRightIcon, CornerDownLeftIcon, XIcon } from "lucide-react";
import * as DateTime from "effect/DateTime";
import { type ReactNode, useState } from "react";

import { useThreadViewModeStore } from "../../threadViewModeStore";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AgentElapsed } from "./AgentElapsed";
import { SubagentTimelineLink } from "./V2LifecycleRow";

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "subagents" | "milestones" | "messages"
>;
type Line = "solid" | "dashed" | "none";

const iso = (value: DateTime.Utc | null) => (value === null ? null : DateTime.formatIso(value));

function timesWord(count: number) {
  return count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
}

/** The first line of the user's message for a run, when that message is loaded. */
function turnText(projection: Projection, turn: MilestoneGraphTurn): string | null {
  const message = projection.messages.find(({ id }) => id === turn.run.userMessageId);
  const line = message?.text.trim().split("\n")[0]?.trim();
  return line ? line : null;
}

const lineClass = (line: Line) =>
  line === "solid" ? "w-px bg-muted-foreground/35" : "border-l border-dashed";

/**
 * One stop on the spine: a node in the left gutter, the line arriving at it (`lineAbove`) and the
 * line leaving it toward the next stop (`line`).
 */
function SpineItem(props: {
  readonly node: ReactNode;
  readonly line: Line;
  readonly lineAbove?: Line;
  readonly first?: boolean;
  readonly last?: boolean;
  readonly enterDelay?: number | null;
  readonly children: ReactNode;
  readonly milestoneId?: string;
}) {
  const above = props.lineAbove ?? props.line;
  return (
    <li
      data-milestone-node={props.milestoneId}
      className={cn(
        "relative scroll-mt-12 pb-5 pl-8.5",
        props.enterDelay != null && "motion-safe:animate-milestone-enter",
      )}
      style={props.enterDelay ? { animationDelay: `${props.enterDelay}ms` } : undefined}
    >
      {props.first || above === "none" ? null : (
        <span
          aria-hidden
          className={cn("absolute top-0 left-2.75 h-4 -translate-x-1/2", lineClass(above))}
        />
      )}
      {props.last || props.line === "none" ? null : (
        <span
          aria-hidden
          className={cn(
            "absolute top-4 bottom-0 left-2.75 -translate-x-1/2",
            lineClass(props.line),
          )}
        />
      )}
      <span className="absolute top-1.5 left-0 grid size-5.5 place-items-center bg-background">
        {props.node}
      </span>
      {props.children}
    </li>
  );
}

function MilestoneNode(props: {
  readonly status: OrchestrationV2Milestone["status"];
  readonly live: boolean;
}) {
  switch (props.status) {
    case "done":
      return (
        <span className="grid size-4 place-items-center rounded-full bg-success/16 text-success">
          <CheckIcon className="size-2.5" strokeWidth={3} />
        </span>
      );
    case "active":
      return (
        <span className="grid size-4 place-items-center rounded-full border border-info">
          <span
            className={cn(
              "size-1.5 rounded-full bg-info",
              props.live && "motion-safe:animate-status-pulse",
            )}
          />
        </span>
      );
    case "dropped":
      return (
        <span className="grid size-4 place-items-center rounded-full border border-muted-foreground/40 text-muted-foreground/70">
          <XIcon className="size-2.5" strokeWidth={2.5} />
        </span>
      );
    case "planned":
      return <span className="size-4 rounded-full border border-dashed border-muted-foreground" />;
  }
}

/** A user message on the spine. */
function YouNode() {
  return (
    <span className="grid size-5.5 place-items-center rounded-full bg-foreground text-2xs leading-none font-semibold tracking-tight text-background">
      You
    </span>
  );
}

function JumpHint() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/jump:opacity-100 group-focus-visible/jump:opacity-100 max-sm:hidden">
      <CornerDownLeftIcon className="size-3.5" />
      Show in chat
    </span>
  );
}

const headClass =
  "group/jump -ml-2.5 flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none";

function WorkflowPhases(props: { readonly agent: OrchestrationV2Subagent }) {
  const group = deriveWorkflowGroups(projectedSubagentsToRuntime([props.agent]))[0];
  if (group === undefined || group.phases.length === 0) return null;
  return (
    <ol className="mb-1 ml-12 grid gap-0.5 text-xs text-muted-foreground">
      {group.phases.map((phase) => (
        <li key={phase.index} className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              phase.state === "done"
                ? "bg-success"
                : phase.state === "running"
                  ? "bg-info motion-safe:animate-status-pulse"
                  : "border border-muted-foreground/60",
            )}
          />
          <span className="min-w-0 truncate">{phase.title}</span>
          {phase.members.length > 0 ? (
            <span className="shrink-0 tabular-nums">
              {phase.settledCount}/{phase.members.length}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** Delegated work forks off the spine and, once every agent settles, merges back. */
function AgentLane(props: {
  readonly threadRef: ScopedThreadRef;
  readonly agents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  if (props.agents.length === 0) return null;
  const open = props.agents.some((agent) => isActiveSubagentStatus(agent.status));
  const curve = open ? "stroke-info/55" : "stroke-muted-foreground/35";
  return (
    <div className="relative -ml-8.5 py-4.5">
      <svg
        aria-hidden
        viewBox="0 0 24 18"
        className="absolute top-0 left-2.75 h-4.5 w-6 overflow-visible"
      >
        <path d="M0 0 C0 10, 24 8, 24 18" fill="none" strokeWidth={1.5} className={curve} />
      </svg>
      <div className="relative">
        <span
          aria-hidden
          className={cn(
            "absolute -top-px -bottom-px left-8.75 w-px -translate-x-1/2",
            open
              ? "bg-linear-to-b from-info/55 via-info/55 to-transparent"
              : "bg-muted-foreground/35",
          )}
        />
        <ul className="ml-3.75 grid gap-0.5">
          {props.agents.map((agent) => (
            <li key={agent.id} className="min-w-0">
              <SubagentTimelineLink
                parentRef={props.threadRef}
                subagentId={agent.id}
                providerInstanceId={agent.providerInstanceId}
                origin={agent.origin}
                status={agent.status}
                driver={agent.driver}
                title={formatSubagentDisplayTitle(agent.title ?? "Subagent")}
                result={agent.result}
                progress={agent.progress}
                startedAt={agent.startedAt}
                completedAt={agent.completedAt}
                threadId={agent.childThreadId}
                remote={agent.remoteChild}
                onOpenThread={props.onOpenThread}
              />
              {agent.workflow === undefined ? null : <WorkflowPhases agent={agent} />}
            </li>
          ))}
        </ul>
      </div>
      {open ? null : (
        <svg
          aria-hidden
          viewBox="0 0 24 18"
          className="absolute bottom-0 left-2.75 h-4.5 w-6 overflow-visible"
        >
          <path d="M24 0 C24 10, 0 8, 0 18" fill="none" strokeWidth={1.5} className={curve} />
        </svg>
      )}
    </div>
  );
}

function coordinatorPhrase(coordinator: MilestoneCoordinator, awaitingUser: boolean): ReactNode {
  if (awaitingUser) return "is waiting for you";
  switch (coordinator.status) {
    case "waiting":
      return `is waiting on ${coordinator.liveAgents} ${coordinator.liveAgents === 1 ? "agent" : "agents"}`;
    case "working":
      return "is working";
    case "failed":
      return "failed";
    case "interrupted":
      return "was interrupted";
    case "idle":
      return "is idle";
  }
}

function CoordinatorRow(props: {
  readonly coordinator: MilestoneCoordinator;
  readonly awaitingUser: boolean;
  readonly onAnswer: () => void;
  readonly lineAbove: Line;
  readonly line: Line;
  readonly last: boolean;
}) {
  const { status } = props.coordinator;
  const live = status === "working" || status === "waiting";
  return (
    <SpineItem
      line={props.line}
      lineAbove={props.lineAbove}
      last={props.last}
      node={
        <span
          className={cn(
            "size-2.5 rounded-full ring-4",
            props.awaitingUser
              ? "bg-warning ring-warning/18"
              : status === "failed"
                ? "bg-destructive ring-destructive/18"
                : status === "interrupted"
                  ? "bg-warning ring-warning/18"
                  : live
                    ? "bg-info ring-info/18 motion-safe:animate-status-pulse"
                    : "bg-muted-foreground/50 ring-muted-foreground/12",
          )}
        />
      }
    >
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground/85">Coordinator</span>{" "}
          {coordinatorPhrase(props.coordinator, props.awaitingUser)}
        </span>
        {props.awaitingUser ? (
          <Button size="xs" variant="outline" onClick={props.onAnswer}>
            Answer in chat
          </Button>
        ) : null}
      </div>
    </SpineItem>
  );
}

function TurnCard(props: {
  readonly text: string | null;
  readonly label: string;
  readonly onJump: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onJump}
      className="group/jump mt-2 flex w-fit max-w-full min-w-0 flex-col rounded-xl border bg-card px-3 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
    >
      <span className="text-2xs text-muted-foreground">You</span>
      <span className="line-clamp-3 text-sm text-foreground">{props.text ?? props.label}</span>
    </button>
  );
}

function turnLabel(turn: MilestoneGraphTurn): string {
  const at = DateTime.toDate(turn.run.requestedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `Turn ${turn.run.ordinal} · ${at}`;
}

/**
 * The coordinator's progress as a spine of milestones with their agents, the user's turns where
 * they landed, and where the coordinator is now. Clicking a node opens Chat at that point.
 */
export function ThreadMilestonesView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projection: Projection;
  readonly awaitingUser: boolean;
  readonly bottomInset: number;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { threadRef, projection } = props;
  const graph = deriveThreadMilestoneGraph(projection);
  const revealInChat = useThreadViewModeStore((state) => state.revealInChat);
  const setMode = useThreadViewModeStore((state) => state.setMode);
  // Milestones already present when the view opened appear at once; only new ones cascade in.
  const [seenAtMount] = useState(() => new Set(projection.milestones.map(({ id }) => id)));
  const [openEarlierSets, setOpenEarlierSets] = useState<ReadonlySet<string>>(() => new Set());
  const jump = (entryId: string | undefined) => {
    if (entryId !== undefined) revealInChat(threadRef, entryId);
  };
  const answer = () => setMode(threadRef, "chat");

  let body: ReactNode;
  if (graph.mode === "empty") {
    body = (
      <div className="relative pt-1.5 pl-8.5">
        <span className="absolute top-1.5 left-0 grid size-5.5 place-items-center">
          <span className="size-4 rounded-full border border-dashed border-muted-foreground" />
        </span>
        <span
          aria-hidden
          className="absolute top-7.5 left-2.75 h-18 w-px -translate-x-1/2 bg-linear-to-b from-border to-transparent"
        />
        <h3 className="mt-2 text-sm font-medium">Describe what you want built</h3>
        <p className="mt-0.5 max-w-120 text-xs text-muted-foreground">
          The coordinator's plan shows up here as milestones while it works.
        </p>
      </div>
    );
  } else if (graph.mode === "turns") {
    body = (
      <ol>
        {graph.turns.map((turn, index) => (
          <SpineItem
            key={turn.run.id}
            first={index === 0}
            line="solid"
            node={
              index === 0 ? (
                <YouNode />
              ) : (
                <span className="size-3 rounded-full border border-muted-foreground/60 bg-background" />
              )
            }
          >
            <button
              type="button"
              className={headClass}
              onClick={() => jump(turn.run.userMessageId)}
            >
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {turnText(projection, turn) ?? turnLabel(turn)}
              </span>
              <JumpHint />
            </button>
            <AgentLane
              threadRef={threadRef}
              agents={turn.agents}
              onOpenThread={props.onOpenThread}
            />
          </SpineItem>
        ))}
        <CoordinatorRow
          coordinator={graph.coordinator}
          awaitingUser={props.awaitingUser}
          onAnswer={answer}
          lineAbove="solid"
          line="none"
          last
        />
      </ol>
    );
  } else {
    const live = graph.coordinator.status === "working" || graph.coordinator.status === "waiting";
    const nodes = graph.milestones;
    const activeIndex = nodes.findIndex(({ milestone }) => milestone.status === "active");
    const coordinatorAfter =
      activeIndex !== -1
        ? activeIndex
        : nodes.findLastIndex(({ milestone }) => milestone.status !== "planned");
    const firstMilestone = nodes[0]?.milestone;
    let cascade = 0;
    const coordinatorRow = (lineAbove: Line, last: boolean) => (
      <CoordinatorRow
        key="coordinator"
        coordinator={graph.coordinator}
        awaitingUser={props.awaitingUser}
        onAnswer={answer}
        lineAbove={lineAbove}
        line="dashed"
        last={last}
      />
    );
    body = (
      <>
        <div className="sticky top-0 z-10 -mx-1 mb-3 flex gap-1 bg-background px-1 py-2">
          {nodes.map(({ milestone }) =>
            milestone.status === "dropped" ? null : (
              <button
                key={milestone.id}
                type="button"
                aria-label={`Go to ${milestone.title}`}
                className="group/segment h-3 flex-1 py-1"
                onClick={() =>
                  document
                    .querySelector(`[data-milestone-node="${CSS.escape(milestone.id)}"]`)
                    ?.scrollIntoView({
                      block: "center",
                      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                        ? "auto"
                        : "smooth",
                    })
                }
              >
                <span
                  className={cn(
                    "block h-1 rounded-full transition-colors group-hover/segment:bg-foreground/60",
                    milestone.status === "done"
                      ? "bg-success/70"
                      : milestone.status === "active"
                        ? "bg-info"
                        : "bg-border",
                  )}
                />
              </button>
            ),
          )}
        </div>
        <div className="mb-5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/85">
            Milestone {graph.summary.position} of {graph.summary.total}
          </span>
          {graph.coordinator.liveAgents > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-info motion-safe:animate-status-pulse" />
              {graph.coordinator.liveAgents}{" "}
              {graph.coordinator.liveAgents === 1 ? "agent" : "agents"} running
            </span>
          ) : null}
          {graph.summary.startedAt === null ? null : (
            <AgentElapsed
              compact
              agent={{
                status: live ? "running" : "completed",
                startedAt: iso(graph.summary.startedAt),
                completedAt: iso(
                  nodes.findLast(({ milestone }) => milestone.completedAt !== null)?.milestone
                    .completedAt ?? null,
                ),
              }}
            />
          )}
          {graph.summary.changes > 0 ? (
            <span>Plan changed {timesWord(graph.summary.changes)}</span>
          ) : null}
        </div>
        <ol>
          {graph.root === null ? null : (
            <SpineItem first line="solid" node={<YouNode />}>
              <button
                type="button"
                className={headClass}
                onClick={() => jump(graph.root!.run.userMessageId)}
              >
                <span className="line-clamp-2 min-w-0 flex-1 text-sm text-foreground">
                  {turnText(projection, graph.root) ?? turnLabel(graph.root)}
                </span>
                <JumpHint />
              </button>
              <AgentLane
                threadRef={threadRef}
                agents={graph.root.agents}
                onOpenThread={props.onOpenThread}
              />
            </SpineItem>
          )}
          {graph.earlierSets.map((set) => {
            const open = openEarlierSets.has(set.setId);
            return (
              <SpineItem
                key={set.setId}
                first={graph.root === null}
                line="solid"
                node={<span className="h-px w-2.5 bg-muted-foreground/50" />}
              >
                <button
                  type="button"
                  aria-expanded={open}
                  className={cn(headClass, "min-h-8 text-xs text-muted-foreground")}
                  onClick={() =>
                    setOpenEarlierSets((current) => {
                      const next = new Set(current);
                      if (!next.delete(set.setId)) next.add(set.setId);
                      return next;
                    })
                  }
                >
                  <ChevronRightIcon
                    className={cn("size-3.5 transition-transform", open && "rotate-90")}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    Earlier plan · {set.milestones.length}{" "}
                    {set.milestones.length === 1 ? "milestone" : "milestones"}
                    {set.agentCount > 0
                      ? ` · ${set.agentCount} ${set.agentCount === 1 ? "agent" : "agents"}`
                      : ""}
                  </span>
                </button>
                {open ? (
                  <ul className="mt-1 grid gap-0.5">
                    {set.milestones.map((milestone) => (
                      <li key={milestone.id}>
                        <button
                          type="button"
                          className={cn(headClass, "min-h-7 py-1 text-xs")}
                          onClick={() =>
                            jump(
                              (
                                milestone.anchors.done ??
                                milestone.anchors.started ??
                                milestone.anchors.dropped ??
                                milestone.anchors.planned
                              )?.itemId,
                            )
                          }
                        >
                          <MilestoneNode status={milestone.status} live={false} />
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate",
                              milestone.status === "dropped"
                                ? "text-muted-foreground line-through"
                                : "text-foreground/85",
                            )}
                          >
                            {milestone.title}
                          </span>
                          <JumpHint />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </SpineItem>
            );
          })}
          <SpineItem
            first={graph.root === null && graph.earlierSets.length === 0}
            line="solid"
            node={<span className="h-px w-2.5 bg-muted-foreground/50" />}
          >
            <button
              type="button"
              className={cn(headClass, "min-h-8 text-xs text-muted-foreground")}
              onClick={() => jump(firstMilestone?.anchors.planned?.itemId)}
            >
              <span className="min-w-0 flex-1 truncate">
                Plan · {graph.summary.total}{" "}
                {graph.summary.total === 1 ? "milestone" : "milestones"}
                {graph.summary.changes > 0 ? ` · changed ${timesWord(graph.summary.changes)}` : ""}
              </span>
              <JumpHint />
            </button>
          </SpineItem>
          {coordinatorAfter === -1 ? coordinatorRow("solid", nodes.length === 0) : null}
          {nodes.flatMap((node, index) => {
            const { milestone } = node;
            const isNew = !seenAtMount.has(milestone.id);
            const enterDelay = isNew ? cascade++ * 40 : null;
            const reached = milestone.status === "done" || milestone.status === "active";
            const anchor = reached
              ? (milestone.anchors.started ?? milestone.anchors.done)
              : (milestone.anchors.dropped ??
                milestone.anchors.changed ??
                milestone.anchors.planned);
            const item = (
              <SpineItem
                key={milestone.id}
                milestoneId={milestone.id}
                line={reached ? "solid" : "dashed"}
                lineAbove={index <= coordinatorAfter ? "solid" : "dashed"}
                last={index === nodes.length - 1 && index !== coordinatorAfter}
                enterDelay={enterDelay}
                node={
                  <MilestoneNode
                    status={milestone.status}
                    live={live && milestone.status === "active"}
                  />
                }
              >
                <button type="button" className={headClass} onClick={() => jump(anchor?.itemId)}>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-sm",
                      reached
                        ? "font-semibold text-foreground"
                        : milestone.status === "dropped"
                          ? "text-muted-foreground line-through"
                          : "text-foreground/85",
                    )}
                  >
                    {milestone.title}
                  </span>
                  <JumpHint />
                  {milestone.revision !== undefined ? (
                    <Badge variant="warning" size="sm">
                      Changed
                    </Badge>
                  ) : null}
                  {milestone.status === "dropped" ? (
                    <Badge variant="outline" size="sm">
                      Dropped
                    </Badge>
                  ) : null}
                  {reached ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <AgentElapsed
                        compact
                        agent={{
                          status: milestone.status === "active" && live ? "running" : "completed",
                          startedAt: iso(milestone.startedAt),
                          completedAt: iso(milestone.completedAt),
                        }}
                      />
                    </span>
                  ) : null}
                </button>
                {milestone.note !== undefined && milestone.status !== "dropped" ? (
                  <p className="max-w-152 text-xs text-muted-foreground">{milestone.note}</p>
                ) : null}
                {milestone.revision !== undefined ? (
                  <p className="mt-1.5 max-w-152 border-l-2 border-warning/45 pl-2.5 text-xs text-muted-foreground">
                    <s className="text-muted-foreground/70">{milestone.revision.previousTitle}</s>
                    <br />
                    {milestone.revision.reason}
                  </p>
                ) : milestone.status === "dropped" && milestone.note !== undefined ? (
                  <p className="mt-1 max-w-152 text-xs text-muted-foreground">{milestone.note}</p>
                ) : null}
                {node.turns.map((turn) => (
                  <TurnCard
                    key={turn.run.id}
                    text={turnText(projection, turn)}
                    label={turnLabel(turn)}
                    onJump={() => jump(turn.run.userMessageId)}
                  />
                ))}
                <AgentLane
                  threadRef={threadRef}
                  agents={node.agents}
                  onOpenThread={props.onOpenThread}
                />
              </SpineItem>
            );
            return index === coordinatorAfter
              ? [item, coordinatorRow("solid", index === nodes.length - 1)]
              : [item];
          })}
        </ol>
      </>
    );
  }

  return (
    <div
      data-thread-milestones-view
      className="scrollbar-gutter-both h-full min-h-0 overflow-y-auto overscroll-y-contain"
    >
      <div
        className="mx-auto w-full max-w-(--chat-content-max-width) px-4 pt-4 sm:px-6"
        style={{ paddingBottom: props.bottomInset + 24 }}
      >
        {body}
      </div>
    </div>
  );
}
