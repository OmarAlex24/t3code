import { secondTick } from "@t3tools/client-runtime/clock";
import {
  formatTraceClock,
  traceFraction,
  tracePosition,
  traceTicks,
  type TraceAgentStatus,
  type TraceDomain,
  type TraceRowStatus,
  type TraceSpan,
} from "@t3tools/client-runtime/state/thread-milestone-trace";
import { CheckIcon, XIcon } from "lucide-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useChildThreadInputs } from "../../state/entities";

type TraceTone = TraceRowStatus | TraceAgentStatus | "coordinator" | "group";

const pct = (value: number) => `${(value * 100).toFixed(3)}%`;
const NOW = "var(--trace-now)";

/** Left and width of a span; a running span ends at the live now line. */
export function spanStyle(domain: TraceDomain, span: TraceSpan, minWidth = "5px"): CSSProperties {
  const left = tracePosition(domain, span.startMs);
  return {
    left: pct(left),
    width:
      span.endMs === null
        ? `max(${minWidth}, calc((${NOW} - ${left}) * 100%))`
        : `max(${minWidth}, ${pct(tracePosition(domain, span.endMs) - left)})`,
  };
}

/** Something that has not run yet, placed `offsetMs` after the moving now line. */
export function afterNowStyle(
  domain: TraceDomain,
  offsetMs: number,
  widthMs: number,
): CSSProperties {
  return {
    left: `calc(${NOW} * 100% + ${pct(traceFraction(domain, offsetMs))})`,
    width: pct(traceFraction(domain, widthMs)),
  };
}

export const atStyle = (domain: TraceDomain, atMs: number): CSSProperties => ({
  left: pct(tracePosition(domain, atMs)),
});

export const atNowStyle: CSSProperties = { left: `calc(${NOW} * 100%)` };

const BAR_TONE: Record<TraceTone, string> = {
  done: "border-success/40 bg-success/15",
  active: "border-info/50 border-r-2 border-r-info bg-linear-to-r from-info/13 to-info/26",
  running: "border-info/50 border-r-2 border-r-info bg-linear-to-r from-info/13 to-info/26",
  planned: "border-dashed border-foreground/20",
  queued: "border-dashed border-foreground/20",
  dropped:
    "border-foreground/20 bg-[repeating-linear-gradient(135deg,color-mix(in_srgb,var(--color-foreground)_9%,transparent)_0_3px,transparent_3px_6px)]",
  failed: "border-destructive/50 bg-destructive/13",
  "needs-you": "border-warning/50 border-r-2 border-r-warning bg-warning/14",
  stopped: "border-foreground/20 bg-foreground/8",
  coordinator: "h-2.5 border-foreground/20 bg-foreground/8",
  group: "h-2 border-transparent bg-foreground/8",
};

export function TraceBar(props: {
  readonly tone: TraceTone;
  readonly style: CSSProperties;
  /** Moves the bar up to make room for agent strands under it. */
  readonly raised?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      style={props.style}
      className={cn(
        "absolute h-3 rounded-sm border",
        props.raised ? "top-3" : "top-1/2 -translate-y-1/2",
        BAR_TONE[props.tone],
        props.className,
      )}
    />
  );
}

const STRAND_TONE: Record<TraceAgentStatus, string> = {
  done: "bg-success/45",
  running: "bg-info",
  "needs-you": "bg-warning",
  failed: "bg-destructive",
  stopped: "bg-foreground/25",
  queued: "h-0! border-t-2 border-dotted border-foreground/25 bg-transparent",
};

/** One agent as a thin line; overlapping lines ran at the same time. */
export function TraceStrand(props: {
  readonly status: TraceAgentStatus;
  readonly style: CSSProperties;
  readonly thick?: boolean;
}) {
  return (
    <span
      aria-hidden
      style={props.style}
      className={cn(
        "absolute rounded-full",
        props.thick ? "h-[3px]" : "h-0.5",
        STRAND_TONE[props.status],
      )}
    />
  );
}

export function TracePin(props: {
  readonly style: CSSProperties;
  readonly ask?: boolean;
  readonly raised?: boolean;
}) {
  return (
    <span
      aria-hidden
      style={props.style}
      className={cn(
        "absolute size-[9px] -translate-x-1/2 rounded-full border",
        props.raised ? "top-[14.5px]" : "top-1/2 -translate-y-1/2",
        props.ask
          ? "border-warning bg-warning ring-3 ring-warning/20"
          : "border-foreground/75 bg-card",
      )}
    />
  );
}

export function MilestoneStatusIcon(props: { readonly status: TraceRowStatus }) {
  switch (props.status) {
    case "done":
      return (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-success/16 text-success">
          <CheckIcon className="size-2.5" strokeWidth={3} />
        </span>
      );
    case "active":
      return (
        <span className="grid size-4 shrink-0 place-items-center rounded-full border border-info">
          <span className="size-1.5 rounded-full bg-info" />
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

/** Shared row grid: a label column, the plot, and in a zoomed chart a status column. */
export const traceRowClass =
  "relative grid grid-cols-[var(--trace-label)_minmax(0,1fr)_var(--trace-side)] items-stretch border-t border-foreground/7 first:border-t-0";

/** A row-wide button under the row's content; controls inside the row sit above it. */
export const traceCoverClass =
  "absolute inset-0 cursor-pointer outline-none hover:bg-foreground/4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

export function TraceLabel(props: {
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none relative flex min-w-0 items-center gap-2.5 py-1.5 pr-2.5 pl-3.5",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

export function TraceText(props: {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly titleClassName?: string | undefined;
  readonly metaClassName?: string | undefined;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className={cn("truncate text-sm font-medium text-foreground", props.titleClassName)}>
        {props.title}
      </div>
      {props.meta === undefined ? null : (
        <div className={cn("truncate text-xs text-muted-foreground", props.metaClassName)}>
          {props.meta}
        </div>
      )}
    </div>
  );
}

export function TracePlot(props: { readonly children?: ReactNode }) {
  return <div className="pointer-events-none relative mr-4.5 ml-3">{props.children}</div>;
}

export function TraceLegendSwatch(props: { readonly tone: TraceTone; readonly label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn("h-2 w-4.5 rounded-xs border", BAR_TONE[props.tone])} />
      {props.label}
    </span>
  );
}

/**
 * The chart card: an axis row, the rows, and an overlay with ticks, idle breaks and the now line.
 * While live, now moves through the `--trace-now` variable on the shared second tick, so rows
 * never re-render for it; `onHorizon` fires once now passes the domain's headroom.
 */
export function TraceChart(props: {
  readonly domain: TraceDomain;
  readonly nowMs: number;
  readonly live: boolean;
  readonly zoomed: boolean;
  readonly axisLabel: string;
  readonly onHorizon: () => void;
  readonly legend?: ReactNode;
  readonly children: ReactNode;
}) {
  const { domain, nowMs, live, onHorizon } = props;
  const trackNow = (node: HTMLDivElement | null) => {
    if (!node) return;
    const write = () => {
      const now = Math.max(Date.now(), nowMs);
      if (live && now > domain.horizonMs) {
        onHorizon();
        return;
      }
      node.style.setProperty("--trace-now", String(tracePosition(domain, live ? now : nowMs)));
    };
    write();
    return live ? secondTick.subscribe(write) : undefined;
  };
  const showNow = live;
  const nowAt = tracePosition(domain, nowMs);
  // The now pill shares the tick row, and a label at the right edge would be cut off.
  const ticks = traceTicks(domain).filter(
    ({ position }) =>
      position <= 0.93 && (!showNow || position < nowAt - 0.15 || position > nowAt + 0.06),
  );
  return (
    <div className="@container">
      <div
        ref={trackNow}
        className={cn(
          "overflow-hidden rounded-2xl border bg-card shadow-xs/5",
          "[--trace-label:16.375rem] [--trace-side:0px] @max-xl:[--trace-label:13.875rem]",
          props.zoomed &&
            "[--trace-side:6rem] @max-xl:[--trace-label:12.875rem] @max-xl:[--trace-side:5.25rem]",
        )}
      >
        <div className="relative">
          <div className={cn(traceRowClass, "h-[30px] border-b border-border")}>
            <div className="flex items-center pl-3.5 text-xs text-muted-foreground">
              {props.axisLabel}
            </div>
          </div>
          {props.children}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-[calc(var(--trace-side)+18px)] left-[calc(var(--trace-label)+12px)] z-20"
          >
            {ticks.map((tick, index) => (
              <div
                key={tick.position}
                className={cn(
                  "absolute inset-y-0 w-px bg-foreground/7",
                  index % 2 === 1 && "@max-xl:[&>span]:invisible",
                )}
                style={{ left: pct(tick.position) }}
              >
                <span className="absolute top-2 left-1.25 text-2xs whitespace-nowrap text-muted-foreground tabular-nums">
                  {formatTraceClock(tick.elapsedMs)}
                </span>
              </div>
            ))}
            {domain.gaps.map((gap) => {
              const left = pct(tracePosition(domain, gap.startMs));
              return (
                <div key={gap.startMs}>
                  <div
                    className="absolute top-[30px] bottom-0 -translate-x-1/2 border-l-2 border-dashed border-foreground/20"
                    style={{ left }}
                  />
                  <span
                    className="absolute top-1.5 -translate-x-1/2 rounded-sm border bg-muted px-1.25 text-3xs leading-3.5 whitespace-nowrap text-muted-foreground"
                    style={{ left }}
                  >
                    {formatTraceClock(gap.endMs - gap.startMs)} idle
                  </span>
                </div>
              );
            })}
            {showNow ? (
              <>
                <div
                  className="absolute top-[22px] bottom-0 -translate-x-1/2 border-l-2 border-info before:absolute before:-top-[3px] before:-left-1 before:size-[6.5px] before:rounded-full before:bg-info"
                  style={atNowStyle}
                />
                <span
                  className="absolute top-1.5 -translate-x-1/2 rounded-sm bg-info/14 px-1.25 text-3xs leading-3.75 font-semibold text-info"
                  style={atNowStyle}
                >
                  now
                </span>
              </>
            ) : null}
          </div>
        </div>
        {props.legend === undefined ? null : (
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t px-3.5 py-2 text-xs text-muted-foreground">
            {props.legend}
          </div>
        )}
      </div>
    </div>
  );
}

/** Child threads waiting on you, and which of them wait on an approval. */
export function useAgentsWaitingOnYou(threadRef: ScopedThreadRef) {
  const children = useChildThreadInputs(threadRef);
  const waiting = children.filter(
    (child) => child.hasPendingApprovals || child.hasPendingUserInput,
  );
  return {
    needsYou: new Set<string>(waiting.map(({ id }) => id)),
    approvals: new Set<string>(
      waiting.filter(({ hasPendingApprovals }) => hasPendingApprovals).map(({ id }) => id),
    ),
  };
}
