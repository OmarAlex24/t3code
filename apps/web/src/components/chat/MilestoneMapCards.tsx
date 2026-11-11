import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  actionLine,
  agentLine,
  agentThreadRef,
  type MapAgent,
  type MapMilestone,
  type MapRollupTone,
  type MapStatus,
} from "@t3tools/client-runtime/state/thread-milestone-map";
import type { ProviderDriverKind, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import {
  BotIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  LoaderCircleIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "../../state/entities";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AgentElapsed } from "./AgentElapsed";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { useSubagentLink } from "./V2LifecycleRow";

const iso = (ms: number | null) =>
  ms === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));

export function ProviderTile(props: {
  readonly driver: ProviderDriverKind | null;
  readonly size?: "md" | "sm" | "xs";
}) {
  const size = props.size ?? "md";
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center border bg-card",
        size === "md" && "size-7.5 rounded-lg",
        size === "sm" && "size-6.5 rounded-md",
        size === "xs" && "size-5 rounded-md",
      )}
    >
      {props.driver === null ? (
        <BotIcon className="size-3.5 text-muted-foreground" />
      ) : (
        <ProviderInstanceIcon
          driverKind={props.driver}
          displayName={props.driver}
          showBadge={false}
          iconClassName={size === "md" ? "size-4" : size === "sm" ? "size-3.5" : "size-3"}
        />
      )}
    </span>
  );
}

const BADGES: Record<
  MapStatus,
  {
    readonly label: string;
    readonly variant: "info" | "success" | "warning" | "error" | "secondary";
    readonly icon: typeof CheckIcon | null;
  }
> = {
  running: { label: "Running", variant: "info", icon: LoaderCircleIcon },
  done: { label: "Done", variant: "success", icon: CheckIcon },
  "needs-you": { label: "Needs you", variant: "warning", icon: ClockIcon },
  failed: { label: "Failed", variant: "error", icon: XIcon },
  planned: { label: "Planned", variant: "secondary", icon: null },
  dropped: { label: "Dropped", variant: "secondary", icon: null },
  stopped: { label: "Stopped", variant: "secondary", icon: null },
};

function MapStatusBadge(props: { readonly status: MapStatus }) {
  const { label, variant, icon: Icon } = BADGES[props.status];
  return (
    <Badge variant={variant} size="lg">
      {Icon === null ? null : <Icon />}
      {label}
    </Badge>
  );
}

/** The milestone's status as a small mark, for lists. */
export function MilestoneStatusIcon(props: { readonly status: MapStatus }) {
  switch (props.status) {
    case "done":
      return (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-success/16 text-success">
          <CheckIcon className="size-2.5" strokeWidth={3} />
        </span>
      );
    case "running":
    case "needs-you":
      return (
        <span
          className={cn(
            "grid size-4 shrink-0 place-items-center rounded-full border",
            props.status === "running" ? "border-info" : "border-warning",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              props.status === "running" ? "bg-info" : "bg-warning",
            )}
          />
        </span>
      );
    case "failed":
      return (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-destructive/14 text-destructive">
          <XIcon className="size-2.5" strokeWidth={3} />
        </span>
      );
    case "dropped":
    case "stopped":
      return (
        <span className="grid size-4 shrink-0 place-items-center text-muted-foreground/60">
          <XIcon className="size-2.5" strokeWidth={3} />
        </span>
      );
    case "planned":
      return (
        <span className="m-px size-3.5 shrink-0 rounded-full border border-dashed border-muted-foreground/45" />
      );
  }
}

export function RailDot(props: {
  readonly status: MapStatus | "you";
  readonly style: CSSProperties;
}) {
  return (
    <span
      aria-hidden
      style={props.style}
      className={cn(
        "absolute z-1 rounded-full",
        props.status === "you"
          ? "-mt-1.25 -ml-1.25 size-2.25 bg-foreground"
          : "-mt-1.5 -ml-1.5 size-2.75",
        props.status === "done" && "bg-success",
        props.status === "running" && "border-2 border-info bg-card",
        props.status === "needs-you" && "border-2 border-warning bg-card",
        props.status === "failed" && "border-2 border-destructive bg-card",
        props.status === "planned" && "border border-dashed border-foreground/32 bg-background",
        (props.status === "dropped" || props.status === "stopped") &&
          "border border-foreground/20 bg-background",
      )}
    />
  );
}

const ROLLUP_ICON: Record<MapRollupTone, typeof CheckIcon> = {
  "needs-you": ClockIcon,
  running: LoaderCircleIcon,
  none: UserIcon,
  failed: CircleXIcon,
  done: CircleCheckIcon,
};

const cardClass =
  "absolute flex flex-col justify-between rounded-xl border bg-card shadow-xs/5 transition-[opacity,box-shadow] duration-200 motion-reduce:transition-none";

/** The coordinator's latest step, for the milestone it is working on now. */
function CoordinatorLine(props: {
  readonly threadRef: ScopedThreadRef;
  readonly fallback: string | null;
}) {
  const shell = useThreadShell(props.threadRef);
  return <>{actionLine(shell?.latestAction) ?? props.fallback ?? ""}</>;
}

export function MilestoneCard(props: {
  readonly node: MapMilestone;
  readonly threadRef: ScopedThreadRef;
  readonly lead: ProviderDriverKind | null;
  readonly style: CSSProperties;
  readonly selected: boolean;
  readonly faded: boolean;
  readonly onSelect: () => void;
}) {
  const { node } = props;
  const label = `Zoom into ${node.title}`;
  const fade = props.faded && "opacity-42";
  if (!node.started) {
    const dropped = node.status === "dropped";
    return (
      <button
        type="button"
        aria-label={label}
        data-milestone-node={node.id}
        onClick={props.onSelect}
        style={props.style}
        className={cn(
          cardClass,
          "h-10 w-72 flex-row items-center gap-2 pr-2.5 pl-3 text-left text-sm hover:shadow-lg/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
          fade,
        )}
      >
        <b
          className={cn(
            "min-w-0 flex-1 truncate font-medium text-foreground/80",
            dropped && "text-muted-foreground line-through decoration-foreground/32",
          )}
        >
          {node.title}
        </b>
        {dropped && node.why !== null ? (
          <span className="truncate text-xs text-muted-foreground">{node.why}</span>
        ) : null}
        {dropped ? null : <MapStatusBadge status="planned" />}
      </button>
    );
  }
  const RollupIcon = ROLLUP_ICON[node.rollup.tone];
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={props.selected || undefined}
      data-milestone-node={node.id}
      onClick={props.onSelect}
      style={props.style}
      className={cn(
        cardClass,
        "h-27 w-72 px-3 pt-2.75 pb-2.5 text-left hover:shadow-lg/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
        props.selected && "shadow-lg/10",
        fade,
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <ProviderTile driver={props.lead} />
        <div className="min-w-0 flex-1 leading-tight">
          <b className="block truncate text-sm font-medium">{node.title}</b>
          <span className="mt-px block truncate text-xs text-muted-foreground">
            {node.subtitle}
          </span>
        </div>
        <MapStatusBadge status={node.status} />
      </div>
      <div className="flex min-w-0 items-center gap-2 text-sm text-foreground/78">
        {node.drivers.length === 0 ? null : (
          <span className="inline-flex h-5.5 shrink-0 items-center rounded-md border bg-card pr-1.25 pl-0.75">
            {node.drivers.map((driver, index) => (
              <span
                key={driver}
                className={cn("grid size-4.25 place-items-center", index > 0 && "-ml-0.75")}
              >
                <ProviderInstanceIcon
                  driverKind={driver}
                  displayName={driver}
                  showBadge={false}
                  iconClassName="size-3.25"
                />
              </span>
            ))}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">
          {node.live ? (
            <CoordinatorLine threadRef={props.threadRef} fallback={node.note} />
          ) : (
            node.note
          )}
        </span>
      </div>
      <div className="flex min-h-6.5 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1.25 truncate">
          <RollupIcon className="size-3.25 shrink-0" />
          {node.rollup.text}
        </span>
        <span className="flex-1" />
        <span className="font-medium text-foreground tabular-nums">
          <AgentElapsed
            agent={{
              status: node.endMs === null ? "running" : "completed",
              startedAt: iso(node.startMs),
              completedAt: iso(node.endMs),
            }}
          />
        </span>
      </div>
    </button>
  );
}

function AgentTask(props: { readonly entry: MapAgent; readonly threadRef: ScopedThreadRef }) {
  const ref = agentThreadRef(props.entry.agent, props.threadRef.environmentId);
  const shell = useThreadShell(ref);
  const line = agentLine(props.entry.ask, shell?.latestAction, props.entry.agent);
  return <span className="min-w-0 flex-1 truncate">{line}</span>;
}

export function AgentCard(props: {
  readonly entry: MapAgent;
  readonly threadRef: ScopedThreadRef;
  readonly style: CSSProperties;
  readonly width: number;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onAnswer: (threadKey: string) => void;
}) {
  const { entry } = props;
  const { agent } = entry;
  const title = formatSubagentDisplayTitle(agent.title ?? "Subagent");
  const ref = agentThreadRef(agent, props.threadRef.environmentId);
  const link = useSubagentLink({
    parentRef: props.threadRef,
    subagentId: agent.id,
    providerInstanceId: agent.providerInstanceId,
    origin: agent.origin,
    status: agent.status,
    driver: agent.driver,
    title,
    result: agent.result,
    progress: agent.progress,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
    threadId: agent.childThreadId,
    remote: agent.remoteChild,
    onOpenThread: props.onOpenThread,
  });
  // A question in the agent's own chat is answered there; secrets and approvals in the dock.
  const answer =
    entry.ask === null
      ? null
      : entry.ask.kind === "input" || ref === null
        ? link.open
        : () => props.onAnswer(scopedThreadKey(ref));
  return (
    <div
      data-milestone-agent={agent.id}
      style={{ ...props.style, width: props.width }}
      className={cn(
        cardClass,
        "h-27 px-3 pt-2.75 pb-2.5 motion-safe:animate-map-enter",
        entry.ask !== null && "border-warning/45",
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <ProviderTile driver={agent.driver} />
        <div className="min-w-0 flex-1 leading-tight">
          {link.open === null ? (
            <b className="block truncate text-sm font-medium">{title}</b>
          ) : (
            <button
              type="button"
              onClick={link.open}
              aria-label={`Open ${title}`}
              className="block max-w-full truncate rounded-sm text-left text-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
            >
              {title}
            </button>
          )}
          <span className="mt-px block truncate text-xs text-muted-foreground">
            {[
              agent.model ? formatModelSlugName(agent.model) : null,
              link.remote ? `on ${link.remote.label}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <MapStatusBadge status={entry.status} />
      </div>
      <div className="flex min-w-0 items-center gap-2 text-sm text-foreground/78">
        {agent.group === undefined ? null : (
          <span className="inline-flex h-5.5 shrink-0 items-center rounded-md border px-1.75 text-xs text-muted-foreground">
            {agent.group}
          </span>
        )}
        <AgentTask entry={entry} threadRef={props.threadRef} />
      </div>
      <div className="flex min-h-6.5 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">
          <AgentElapsed agent={link.timing} />
        </span>
        <span className="flex-1" />
        {answer === null ? null : (
          <Button size="xs" variant="outline" onClick={answer}>
            Answer
          </Button>
        )}
      </div>
    </div>
  );
}
