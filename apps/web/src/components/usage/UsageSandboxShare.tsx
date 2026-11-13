import {
  sandboxShareChangeLabel,
  type SandboxShareSummary,
  type SandboxShareWeekView,
} from "@t3tools/client-runtime/state/usage-sandbox-share";
import { formatCount, formatDayShort, formatPercent } from "@t3tools/shared/usageFormat";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ink = (percent: number) =>
  `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;

const SANDBOX_COLOR = ink(100);
const LOCAL_COLOR = ink(28);

function sideLabel(side: { readonly chats: number; readonly turns: number }): string {
  return `${formatCount(side.chats)} ${side.chats === 1 ? "chat" : "chats"} · ${formatCount(side.turns)} ${side.turns === 1 ? "turn" : "turns"}`;
}

function weekLabel(week: SandboxShareWeekView): string {
  return `${formatDayShort(week.weekStart)} ${week.sandboxShare === null ? "no turns" : formatPercent(week.sandboxShare, 0)}`;
}

/** How much of the host's work runs on sandboxes, by week. */
export function UsageSandboxShare({ summary }: { readonly summary: SandboxShareSummary }) {
  const current = summary.current;
  if (current === null) return null;
  const change = sandboxShareChangeLabel(summary);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Local vs sandboxes</h2>
        <span className="text-xs text-muted-foreground">Turns, last 8 weeks</span>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-4xl font-semibold text-foreground tabular-nums">
              {current.sandboxShare === null ? "-" : formatPercent(current.sandboxShare, 0)}
            </span>
            <span className="text-xs text-muted-foreground">
              of this week's turns ran on sandboxes
            </span>
            {change === null ? null : <span className="text-xs text-foreground">{change}</span>}
          </div>
          {(
            [
              { label: "Sandboxes", color: SANDBOX_COLOR, side: current.sandbox },
              { label: "Local", color: LOCAL_COLOR, side: current.local },
            ] as const
          ).map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-4 text-sm">
              <span className="flex items-center gap-2 text-foreground">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-xs"
                  style={{ backgroundColor: row.color }}
                />
                {row.label}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {sideLabel(row.side)}
              </span>
            </div>
          ))}
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <div
            role="img"
            aria-label={`Share of turns on sandboxes by week: ${summary.weeks
              .map(weekLabel)
              .join("; ")}`}
            className="flex h-24 items-end gap-1.5"
          >
            {summary.weeks.map((week) => (
              <Tooltip key={week.weekStart}>
                <TooltipTrigger
                  render={
                    <div className="flex h-full min-w-0 flex-1 flex-col-reverse overflow-hidden rounded-xs bg-muted/60">
                      {week.sandboxShare === null ? null : (
                        <>
                          <div
                            className="w-full"
                            style={{
                              height: `${week.sandboxShare * 100}%`,
                              backgroundColor: SANDBOX_COLOR,
                            }}
                          />
                          <div className="w-full flex-1" style={{ backgroundColor: LOCAL_COLOR }} />
                        </>
                      )}
                    </div>
                  }
                />
                <TooltipPopup>
                  <div className="flex flex-col gap-0.5">
                    <span>Week of {formatDayShort(week.weekStart)}</span>
                    <span>Sandboxes · {sideLabel(week.sandbox)}</span>
                    <span>Local · {sideLabel(week.local)}</span>
                  </div>
                </TooltipPopup>
              </Tooltip>
            ))}
          </div>
          <div aria-hidden className="flex gap-1.5 text-2xs text-muted-foreground tabular-nums">
            {summary.weeks.map((week, index) => (
              <span key={week.weekStart} className="min-w-0 flex-1 truncate text-center">
                {index === summary.weeks.length - 1 ? "This week" : formatDayShort(week.weekStart)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
