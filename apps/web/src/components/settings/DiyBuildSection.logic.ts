import {
  type DiyKitStatus,
  type DiyResolverProvider,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { formatDayAwareTimestamp, formatUpcomingTimestamp } from "../../timestampFormat";

export type DiyRunTone = "ok" | "failed" | "running" | "idle";

/** The resolvers the kit can run, as the providers T3 Code knows them by. */
export const DIY_RESOLVER_DRIVERS: ReadonlyMap<ProviderDriverKind, DiyResolverProvider> = new Map([
  [ProviderDriverKind.make("claudeAgent"), "claude"],
  [ProviderDriverKind.make("codex"), "codex"],
]);

/** "OmarAlex24/t3code" from an SSH or HTTPS remote; the URL itself when it isn't one. */
export function repositoryName(url: string): string {
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1] ?? url;
}

const DAY_MS = 86_400_000;
const isSameDay = (isoDate: string, nowMs: number) =>
  new Date(isoDate).toDateString() === new Date(nowMs).toDateString();
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function pastLabel(isoDate: string, format: TimestampFormat, nowMs: number): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";
  // Formatting against its own instant gives just the time of day.
  const time = formatDayAwareTimestamp(isoDate, format, date.getTime());
  if (isSameDay(isoDate, nowMs)) return `today at ${time}`;
  if (isSameDay(isoDate, nowMs - DAY_MS)) return `yesterday at ${time}`;
  return `on ${shortDate.format(date)} at ${time}`;
}

export function nextRunLabel(
  status: DiyKitStatus,
  format: TimestampFormat,
  nowMs: number,
): string | null {
  const next = status.schedule.nextRun;
  if (next === null || !status.schedule.loaded) return null;
  const label = formatUpcomingTimestamp(next, format, nowMs);
  return isSameDay(next, nowMs) ? `Next update today at ${label}.` : `Next update ${label}.`;
}

const RESULT_HEADLINES: Readonly<Record<string, (at: string) => string>> = {
  conflict_unresolved: (at) => `Stopped ${at} on a rebase conflict`,
  tests_failed: (at) => `Tests failed ${at}`,
  migration_collision: (at) => `Stopped ${at} on a migration conflict`,
  rebase_failed: (at) => `The rebase failed ${at}`,
  push_failed: (at) => `Couldn't push your branch ${at}`,
  build_failed: (at) => `The build failed ${at}`,
};

/** The last update as one sentence; a failure always says the installed app didn't change. */
export function describeLastRun(
  status: DiyKitStatus,
  format: TimestampFormat,
  nowMs: number,
): { readonly tone: DiyRunTone; readonly text: string } {
  const run = status.lastRun;
  if (status.running) {
    const started = run?.result === "running" ? run.startedAt : null;
    return {
      tone: "running",
      text: started
        ? `Updating now, started ${pastLabel(started, format, nowMs)}.`
        : "Updating now.",
    };
  }
  if (run === null) return { tone: "idle", text: "No update has run yet." };
  const at = pastLabel(run.endedAt ?? run.startedAt ?? "", format, nowMs);
  if (run.result === "ok") {
    const waiting =
      run.version !== null && run.version !== status.app.installedVersion
        ? " Check for Updates installs it."
        : "";
    return { tone: "ok", text: `Built ${run.version ?? "a new version"} ${at}.${waiting}` };
  }
  if (run.result === "up_to_date") {
    return { tone: "ok", text: `Checked ${at}. Nothing new upstream or on your branch.` };
  }
  const headline =
    run.result === "interrupted"
      ? `The update that started ${pastLabel(run.startedAt ?? "", format, nowMs)} didn't finish`
      : (RESULT_HEADLINES[run.result]?.(at) ?? `The update failed ${at}`);
  const reason = run.reason.trim().replace(/\.+$/, "");
  return {
    tone: "failed",
    text: `${headline}${reason === "" ? "" : `: ${reason}`}. Your installed app is unchanged.`,
  };
}
