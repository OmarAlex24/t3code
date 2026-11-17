import type {
  UsageDay,
  UsageSandboxShare,
  UsageSandboxShareSide,
  UsageSandboxShareWeek,
} from "@t3tools/contracts";

export interface SandboxShareWeekView {
  readonly weekStart: UsageDay;
  /** Sandbox turns over all turns; null for a week with no turns. */
  readonly sandboxShare: number | null;
  readonly local: UsageSandboxShareSide;
  readonly sandbox: UsageSandboxShareSide;
}

export interface SandboxShareSummary {
  readonly weeks: readonly SandboxShareWeekView[];
  /** This week, so far. */
  readonly current: SandboxShareWeekView | null;
  readonly previousShare: number | null;
  /** This week's share minus last week's, when both had turns. */
  readonly change: number | null;
  /** Any sandbox chat in the window; without one the comparison says nothing. */
  readonly hasSandboxActivity: boolean;
}

function weekView(week: UsageSandboxShareWeek): SandboxShareWeekView {
  const turns = week.local.turns + week.sandbox.turns;
  return {
    weekStart: week.weekStart,
    sandboxShare: turns === 0 ? null : week.sandbox.turns / turns,
    local: week.local,
    sandbox: week.sandbox,
  };
}

export function summarizeSandboxShare(share: UsageSandboxShare): SandboxShareSummary {
  const weeks = share.weeks.map(weekView);
  const current = weeks.at(-1) ?? null;
  const previousShare = weeks.at(-2)?.sandboxShare ?? null;
  const currentShare = current?.sandboxShare ?? null;
  return {
    weeks,
    current,
    previousShare,
    change: currentShare === null || previousShare === null ? null : currentShare - previousShare,
    hasSandboxActivity: weeks.some((week) => week.sandbox.chats > 0),
  };
}

/** The change in whole percentage points, as a sentence; null without a comparison. */
export function sandboxShareChangeLabel(summary: SandboxShareSummary): string | null {
  if (summary.change === null) return null;
  const points = Math.round(summary.change * 100);
  if (points === 0) return "Same as last week";
  const unit = Math.abs(points) === 1 ? "point" : "points";
  return `${points > 0 ? "Up" : "Down"} ${Math.abs(points)} ${unit} from last week`;
}
