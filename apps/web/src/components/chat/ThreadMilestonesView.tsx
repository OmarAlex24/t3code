import { secondTick } from "@t3tools/client-runtime/clock";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import {
  deriveMilestoneBoards,
  MILESTONE_BOARD_ROOT,
  type MilestoneBoardItem,
  parseMilestoneComment,
} from "@t3tools/client-runtime/state/thread-milestone-board";
import {
  deriveCoordinatorActivity,
  deriveThreadMilestoneGraph,
  type MilestoneCoordinator,
  type MilestoneGraphNode,
  type MilestoneGraphTurn,
  milestoneStripWeights,
} from "@t3tools/client-runtime/state/thread-milestone-graph";
import { resolveActiveThreadRun } from "@t3tools/client-runtime/state/thread-workflows";
import type {
  EnvironmentId,
  OrchestrationV2Milestone,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import {
  CheckIcon,
  ChevronRightIcon,
  CornerDownLeftIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import * as DateTime from "effect/DateTime";
import { type ReactNode, useState } from "react";
import { flushSync } from "react-dom";

import { useThreadViewModeStore } from "../../threadViewModeStore";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AgentElapsed } from "./AgentElapsed";
import { AgentStack, AgentTray, agentTraySummary } from "./MilestoneAgents";
import {
  boardCounts,
  CommentButton,
  type CoordinatorAsk,
  CoordinatorAskCard,
  MilestoneBoard,
} from "./MilestoneBoard";
import { EnvironmentSubagentAvatar } from "./V2LifecycleRow";

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "subagents" | "milestones" | "messages"
>;
type Run = Projection["runs"][number];
type Line = "solid" | "dashed" | "none";
type Tone = "info" | "success" | "error" | "warning" | "outline";

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

function turnLabel(turn: MilestoneGraphTurn): string {
  const at = DateTime.toDate(turn.run.requestedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `Turn ${turn.run.ordinal} · ${at}`;
}

const lineClass = (line: Line) =>
  line === "solid" ? "w-px bg-muted-foreground/35" : "border-l border-dashed";

const focusRing =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none";

const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

const scrollToSelector = (selector: string) =>
  document.querySelector(selector)?.scrollIntoView({ block: "center", behavior: scrollBehavior() });

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
    <span
      aria-label="You"
      className="grid size-4.5 place-items-center rounded-full border border-muted-foreground/45 bg-background text-muted-foreground"
    >
      <UserRoundIcon className="size-2.75" strokeWidth={2.25} />
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

const headClass = cn(
  "group/jump -ml-2.5 flex min-h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1 text-left hover:bg-accent",
  focusRing,
);

/** Your message as it reads in Chat; selecting it opens Chat there. */
function YouMessage(props: { readonly text: string; readonly onJump: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onJump}
      className={cn(
        "group/jump flex w-fit max-w-full min-w-0 rounded-2xl bg-message px-3 py-2 text-left text-sm text-message-foreground hover:bg-accent",
        focusRing,
      )}
    >
      <span className="line-clamp-3 min-w-0">{props.text}</span>
    </button>
  );
}

function Elapsed(props: {
  readonly running: boolean;
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
}) {
  return (
    <span className="shrink-0 text-xs text-muted-foreground">
      <AgentElapsed
        agent={{
          status: props.running ? "running" : "completed",
          startedAt: iso(props.startedAt),
          completedAt: iso(props.completedAt),
        }}
      />
    </span>
  );
}

function SectionHead(props: { readonly title: string; readonly detail: string }) {
  return (
    <div className="mb-1.5 flex items-baseline gap-2 text-xs text-muted-foreground">
      <span className="font-semibold text-foreground">{props.title}</span>
      <span className="min-w-0 truncate">{props.detail}</span>
    </div>
  );
}

/**
 * The plan as one strip, each milestone sized by the time it took. The active segment grows on
 * the shared second tick through the DOM, so the view doesn't re-render every second.
 */
function PlanStrip(props: {
  readonly milestones: ReadonlyArray<OrchestrationV2Milestone>;
  readonly ticking: boolean;
  readonly onSelect: (milestone: OrchestrationV2Milestone) => void;
}) {
  const { milestones, ticking } = props;
  const labelled = milestones.length <= 5;
  const current =
    milestones.find(({ status }) => status === "active") ??
    milestones.findLast(({ status }) => status === "done");
  const sizeSegments = (node: HTMLDivElement | null) => {
    if (!node) return;
    const write = () => {
      for (const [index, weight] of milestoneStripWeights(milestones, Date.now()).entries()) {
        const segment = node.children[index];
        if (segment instanceof HTMLElement) segment.style.flexGrow = String(weight);
      }
    };
    write();
    return ticking ? secondTick.subscribe(write) : undefined;
  };
  return (
    <div className="mt-3">
      <div ref={sizeSegments} className="flex gap-1">
        {milestones.map((milestone) => (
          <button
            key={milestone.id}
            type="button"
            aria-label={`Go to ${milestone.title}`}
            onClick={() => props.onSelect(milestone)}
            className={cn(
              "group/segment flex min-w-3 grow basis-0 flex-col gap-1.5 rounded-sm text-left",
              focusRing,
            )}
          >
            <span
              className={cn(
                "block h-1.5 w-full rounded-full transition-opacity group-hover/segment:opacity-70",
                milestone.status === "done"
                  ? "bg-success/55"
                  : milestone.status === "active"
                    ? "bg-info"
                    : "border border-dashed border-muted-foreground/45",
              )}
            />
            {labelled ? (
              <span
                className={cn(
                  "w-full truncate text-xs",
                  milestone.id === current?.id
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {milestone.title}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {labelled || current === undefined ? null : (
        <p className="mt-1.5 truncate text-xs font-medium text-foreground">{current.title}</p>
      )}
    </div>
  );
}

function coordinatorPhrase(coordinator: MilestoneCoordinator, awaitingUser: boolean): string {
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

/** The coordinator's own stop: what it is doing now and for how long. */
function CoordinatorCard(props: {
  readonly environmentId: EnvironmentId;
  readonly coordinator: MilestoneCoordinator;
  readonly run: Run | null;
  readonly activity: string | null;
  readonly awaitingUser: boolean;
  /** Absent when the question already shows on a milestone. */
  readonly onAnswer?: (() => void) | undefined;
  readonly lineAbove: Line;
  readonly line: Line;
  readonly last: boolean;
}) {
  const { status } = props.coordinator;
  const live = status === "working" || status === "waiting";
  const model = props.run ? formatModelSlugName(props.run.modelSelection.model) : null;
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
      <div className="flex min-w-0 items-center gap-2.5 rounded-xl border bg-card px-2.5 py-2 shadow-xs/5">
        {props.run === null ? null : (
          <EnvironmentSubagentAvatar
            environmentId={props.environmentId}
            providerInstanceId={props.run.providerInstanceId}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-muted-foreground">
            <span className="text-sm font-medium text-foreground">Coordinator</span>{" "}
            {model ? `${model} · ` : ""}
            {coordinatorPhrase(props.coordinator, props.awaitingUser)}
          </div>
          {live && !props.awaitingUser && props.activity !== null ? (
            <div className="truncate font-mono text-xs text-foreground/80">{props.activity}</div>
          ) : null}
        </div>
        {props.awaitingUser && props.onAnswer !== undefined ? (
          <Button size="xs" variant="outline" onClick={props.onAnswer}>
            Answer in chat
          </Button>
        ) : live && props.run?.startedAt ? (
          <Badge variant="info">
            <AgentElapsed
              agent={{ status: "running", startedAt: iso(props.run.startedAt), completedAt: null }}
            />
          </Badge>
        ) : null}
      </div>
    </SpineItem>
  );
}

function focusBadge(status: OrchestrationV2Milestone["status"]): {
  readonly label: string;
  readonly tone: Tone;
} {
  switch (status) {
    case "active":
      return { label: "In progress", tone: "info" };
    case "done":
      return { label: "Done", tone: "success" };
    case "dropped":
      return { label: "Dropped", tone: "outline" };
    case "planned":
      return { label: "Planned", tone: "outline" };
  }
}

function Revision(props: { readonly milestone: OrchestrationV2Milestone }) {
  const { milestone } = props;
  if (milestone.revision !== undefined) {
    return (
      <p className="mt-1.5 max-w-152 border-l-2 border-warning/45 pl-2.5 text-xs text-muted-foreground">
        <s className="text-muted-foreground/70">{milestone.revision.previousTitle}</s>
        <br />
        {milestone.revision.reason}
      </p>
    );
  }
  return milestone.note === undefined ? null : (
    <p className="max-w-152 text-xs text-muted-foreground">{milestone.note}</p>
  );
}

/** What a folded milestone holds, as chips; selecting them unfolds it. */
function FoldedSummary(props: {
  readonly threadRef: ScopedThreadRef;
  readonly agents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly items: ReadonlyArray<MilestoneBoardItem>;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const failed = props.agents.filter(({ status }) => status === "failed").length;
  const chip =
    "inline-flex h-7 items-center gap-1.5 rounded-lg border bg-card px-2 text-xs text-foreground/80 group-hover/fold:border-foreground/20";
  return (
    <button
      type="button"
      aria-expanded={props.open}
      onClick={props.onToggle}
      className={cn("group/fold mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg", focusRing)}
    >
      {props.agents.length === 0 ? null : (
        <span className={cn(chip, "ps-1")}>
          <AgentStack threadRef={props.threadRef} agents={props.agents} />
          {props.agents.length} {props.agents.length === 1 ? "agent" : "agents"}
          {failed > 0 ? <span className="text-destructive">· {failed} failed</span> : null}
        </span>
      )}
      {boardCounts(props.items).map(({ kind, icon: Icon, text }) => (
        <span key={kind} className={chip}>
          <Icon className="size-3.5 text-muted-foreground" />
          {text}
        </span>
      ))}
      <span className={cn(chip, "text-muted-foreground")}>
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", props.open && "rotate-90")}
        />
        {props.open ? "Hide" : "Show"}
      </span>
    </button>
  );
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

/**
 * The coordinator's progress: an overview of the plan, then a spine where finished milestones
 * fold, the current one carries its agents and board, and the coordinator says what it is doing.
 * Selecting a title or one of your messages opens Chat at that point.
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
  const graph = deriveThreadMilestoneGraph(projection);
  const activity = deriveCoordinatorActivity(props.turnItems);
  const awaitingUser = props.coordinatorAsk !== null;
  const run =
    resolveActiveThreadRun(projection) ??
    projection.runs.reduce<Run | null>(
      (latest, candidate) =>
        candidate.status !== "rolled_back" &&
        (latest === null || candidate.ordinal > latest.ordinal)
          ? candidate
          : latest,
      null,
    );
  const boards = deriveMilestoneBoards(props.turnItems, (item) =>
    item.textOmitted
      ? (projection.messages.find(({ id }) => id === item.messageId)?.text ?? "")
      : item.text,
  );
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const revealInChat = useThreadViewModeStore((state) => state.revealInChat);
  const setMode = useThreadViewModeStore((state) => state.setMode);
  // Milestones already present when the view opened appear at once; only new ones cascade in.
  const [seenAtMount] = useState(() => new Set(projection.milestones.map(({ id }) => id)));
  const [openEarlierSets, setOpenEarlierSets] = useState<ReadonlySet<string>>(() => new Set());
  const jump = (entryId: string | undefined) => {
    if (entryId !== undefined) revealInChat(threadRef, entryId);
  };
  const answer = () => setMode(threadRef, "chat");
  const toggleFold = (id: string) =>
    setUnfolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const trayLayout = (agents: ReadonlyArray<OrchestrationV2Subagent>) =>
    agents.some(({ status }) => isActiveSubagentStatus(status)) ? "cards" : "rows";
  const coordinatorCard = (
    options: Pick<
      Parameters<typeof CoordinatorCard>[0],
      "lineAbove" | "line" | "last" | "onAnswer"
    >,
  ) => (
    <CoordinatorCard
      key="coordinator"
      environmentId={environmentId}
      coordinator={graph.mode === "empty" ? { status: "idle", liveAgents: 0 } : graph.coordinator}
      run={run}
      activity={activity}
      awaitingUser={awaitingUser}
      {...options}
    />
  );

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
            <YouMessage
              text={turnText(projection, turn) ?? turnLabel(turn)}
              onJump={() => jump(turn.run.userMessageId)}
            />
            {turn.agents.length === 0 ? null : (
              <div className="mt-2">
                <AgentTray
                  threadRef={threadRef}
                  agents={turn.agents}
                  layout={trayLayout(turn.agents)}
                  onOpenThread={props.onOpenThread}
                />
              </div>
            )}
          </SpineItem>
        ))}
        {coordinatorCard({ lineAbove: "solid", line: "none", last: true, onAnswer: answer })}
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
    const counted = nodes
      .map(({ milestone }) => milestone)
      .filter(({ status }) => status !== "dropped");
    const overall = overallBadge(
      graph.coordinator,
      awaitingUser,
      counted.length > 0 && counted.every(({ status }) => status === "done"),
    );
    const failedAgents = [
      ...(graph.root?.agents ?? []),
      ...nodes.flatMap(({ agents }) => agents),
    ].filter(({ status }) => status === "failed");
    const isOpen = (index: number) =>
      index === coordinatorAfter || unfolded.has(nodes[index]!.milestone.id);
    const revealAgent = (agent: OrchestrationV2Subagent) => {
      const owner = nodes.findIndex(({ agents }) => agents.some(({ id }) => id === agent.id));
      if (owner !== -1 && !isOpen(owner)) {
        flushSync(() => toggleFold(nodes[owner]!.milestone.id));
      }
      scrollToSelector(`[data-milestone-agent="${CSS.escape(agent.id)}"]`);
    };
    const newIds = nodes.map(({ milestone }) => milestone.id).filter((id) => !seenAtMount.has(id));
    const rootItems = boards.get(MILESTONE_BOARD_ROOT) ?? [];
    const rootText = graph.root === null ? null : turnText(projection, graph.root);
    const userTurns = (node: MilestoneGraphNode) =>
      node.turns
        .filter((turn) => {
          const text = turnText(projection, turn);
          // A comment shows on the board of the milestone it is about.
          return text === null || parseMilestoneComment(text) === null;
        })
        .map((turn) => (
          <YouMessage
            key={turn.run.id}
            text={turnText(projection, turn) ?? turnLabel(turn)}
            onJump={() => jump(turn.run.userMessageId)}
          />
        ));
    const anchorOf = (milestone: OrchestrationV2Milestone) =>
      milestone.status === "done" || milestone.status === "active"
        ? (milestone.anchors.started ?? milestone.anchors.done)
        : (milestone.anchors.dropped ?? milestone.anchors.changed ?? milestone.anchors.planned);

    const focusCard = (node: MilestoneGraphNode) => {
      const { milestone, agents } = node;
      const items = boards.get(milestone.id) ?? [];
      const badge = focusBadge(milestone.status);
      return (
        <article
          className={cn(
            "min-w-0 rounded-2xl border bg-card shadow-xs/5",
            milestone.status === "active" && "border-info/30",
          )}
        >
          <div className="px-3.5 pt-2.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <Badge variant={badge.tone}>
                <span aria-hidden className="size-1.5 rounded-full bg-current" />
                {badge.label}
              </Badge>
              <button
                type="button"
                onClick={() => jump(anchorOf(milestone)?.itemId)}
                className={cn(
                  "group/jump flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent",
                  focusRing,
                )}
              >
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                  {milestone.title}
                </span>
                <JumpHint />
              </button>
              {milestone.revision !== undefined ? (
                <Badge variant="warning" size="sm">
                  Changed
                </Badge>
              ) : null}
              <Elapsed
                running={milestone.status === "active" && live}
                startedAt={milestone.startedAt}
                completedAt={milestone.completedAt}
              />
            </div>
            <Revision milestone={milestone} />
          </div>
          <div className="grid gap-3 px-3.5 pt-3 pb-3.5">
            {userTurns(node)}
            {props.coordinatorAsk === null ? null : (
              <CoordinatorAskCard ask={props.coordinatorAsk} onAnswerInChat={answer} />
            )}
            {agents.length === 0 ? null : (
              <section>
                <SectionHead title="Agents" detail={agentTraySummary(agents)} />
                <AgentTray
                  threadRef={threadRef}
                  agents={agents}
                  layout="cards"
                  onOpenThread={props.onOpenThread}
                />
              </section>
            )}
            {items.length === 0 ? null : (
              <section>
                <SectionHead
                  title="Board"
                  detail={boardCounts(items)
                    .map(({ text }) => text)
                    .join(" · ")}
                />
                <MilestoneBoard environmentId={environmentId} items={items} onJump={jump} />
              </section>
            )}
            {props.onComment === null ? null : (
              <CommentButton onComment={() => props.onComment!(milestone)} />
            )}
          </div>
        </article>
      );
    };

    const settledStop = (node: MilestoneGraphNode, index: number) => {
      const { milestone, agents } = node;
      const items = boards.get(milestone.id) ?? [];
      const reached = milestone.status === "done";
      const open = isOpen(index);
      const foldable = reached && (agents.length > 0 || items.length > 0 || node.turns.length > 0);
      const turns = userTurns(node);
      return (
        <>
          <button
            type="button"
            className={headClass}
            onClick={() => jump(anchorOf(milestone)?.itemId)}
          >
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                reached
                  ? "font-medium text-foreground"
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
              <Elapsed
                running={false}
                startedAt={milestone.startedAt}
                completedAt={milestone.completedAt}
              />
            ) : null}
          </button>
          <Revision milestone={milestone} />
          {foldable ? (
            <FoldedSummary
              threadRef={threadRef}
              agents={agents}
              items={items}
              open={open}
              onToggle={() => toggleFold(milestone.id)}
            />
          ) : null}
          {(!foldable || open) && (turns.length > 0 || agents.length > 0 || items.length > 0) ? (
            <div className="mt-2 grid gap-2">
              {turns}
              <AgentTray
                threadRef={threadRef}
                agents={agents}
                layout={trayLayout(agents)}
                onOpenThread={props.onOpenThread}
              />
              <MilestoneBoard environmentId={environmentId} items={items} onJump={jump} />
            </div>
          ) : null}
        </>
      );
    };

    body = (
      <>
        <section
          aria-label="Plan"
          className="mb-5 rounded-2xl border bg-card px-4 py-3 shadow-xs/5"
        >
          <div className="flex min-w-0 items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold text-foreground">
                {rootText ?? "Plan"}
              </h2>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground/85">
                  Milestone {graph.summary.position} of {graph.summary.total}
                </span>
                {graph.coordinator.liveAgents > 0 ? (
                  <span>
                    {graph.coordinator.liveAgents}{" "}
                    {graph.coordinator.liveAgents === 1 ? "agent" : "agents"} running
                  </span>
                ) : null}
                {failedAgents.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => revealAgent(failedAgents[0]!)}
                    className={cn(
                      "rounded-sm font-medium text-destructive hover:underline",
                      focusRing,
                    )}
                  >
                    {failedAgents.length} {failedAgents.length === 1 ? "agent" : "agents"} failed
                  </button>
                ) : null}
                {graph.summary.startedAt === null ? null : (
                  <AgentElapsed
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
            </div>
            <Badge variant={overall.tone}>
              <span aria-hidden className="size-1.5 rounded-full bg-current" />
              {overall.label}
            </Badge>
          </div>
          <PlanStrip
            milestones={counted}
            ticking={live && activeIndex !== -1}
            onSelect={(milestone) =>
              scrollToSelector(`[data-milestone-node="${CSS.escape(milestone.id)}"]`)
            }
          />
        </section>
        <ol>
          {graph.root === null ? null : (
            <SpineItem first line="solid" node={<YouNode />}>
              <YouMessage
                text={rootText ?? turnLabel(graph.root)}
                onJump={() => jump(graph.root!.run.userMessageId)}
              />
              {graph.root.agents.length === 0 &&
              rootItems.length === 0 &&
              (coordinatorAfter !== -1 || props.coordinatorAsk === null) ? null : (
                <div className="mt-2 grid gap-2">
                  {coordinatorAfter === -1 && props.coordinatorAsk !== null ? (
                    <CoordinatorAskCard ask={props.coordinatorAsk} onAnswerInChat={answer} />
                  ) : null}
                  <AgentTray
                    threadRef={threadRef}
                    agents={graph.root.agents}
                    layout={trayLayout(graph.root.agents)}
                    onOpenThread={props.onOpenThread}
                  />
                  <MilestoneBoard environmentId={environmentId} items={rootItems} onJump={jump} />
                </div>
              )}
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
                  className={cn(headClass, "text-xs text-muted-foreground")}
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
              className={cn(headClass, "text-xs text-muted-foreground")}
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
          {coordinatorAfter === -1
            ? coordinatorCard({ lineAbove: "solid", line: "dashed", last: nodes.length === 0 })
            : null}
          {nodes.flatMap((node, index) => {
            const { milestone } = node;
            const newIndex = newIds.indexOf(milestone.id);
            const reached = milestone.status === "done" || milestone.status === "active";
            const item = (
              <SpineItem
                key={milestone.id}
                milestoneId={milestone.id}
                line={reached ? "solid" : "dashed"}
                lineAbove={index <= coordinatorAfter ? "solid" : "dashed"}
                last={index === nodes.length - 1 && index !== coordinatorAfter}
                enterDelay={newIndex === -1 ? null : newIndex * 40}
                node={
                  <MilestoneNode
                    status={milestone.status}
                    live={live && milestone.status === "active"}
                  />
                }
              >
                {index === coordinatorAfter ? focusCard(node) : settledStop(node, index)}
              </SpineItem>
            );
            return index === coordinatorAfter
              ? [
                  item,
                  coordinatorCard({
                    lineAbove: "solid",
                    line: "dashed",
                    last: index === nodes.length - 1,
                  }),
                ]
              : [item];
          })}
        </ol>
      </>
    );
  }

  return (
    <div
      data-thread-milestones-view
      className="scrollbar-gutter-both h-full min-h-0 overflow-y-auto overscroll-y-contain ps-(--chat-lane-inset-start) pe-(--chat-lane-inset-end)"
    >
      <div
        className="mx-auto w-full max-w-(--chat-content-max-width) px-3 pt-4 sm:px-12"
        style={{ paddingBottom: props.bottomInset + 24 }}
      >
        {body}
      </div>
    </div>
  );
}
