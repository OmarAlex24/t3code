// @effect-diagnostics globalDate:off
import type {
  UsageDay,
  UsageSandboxShare,
  UsageSandboxShareSide,
  UsageSandboxShareWeek,
} from "@t3tools/contracts";

const SANDBOX_SHARE_WEEKS = 8;

const DAY_MS = 86_400_000;

export interface SandboxShareRun {
  readonly threadId: string;
  readonly startedAtMs: number;
  readonly onSandbox: boolean;
}

/** A sandbox chat the host has no thread for (linking failed), so no turns to count. */
export interface UnmirroredSandboxChat {
  readonly threadId: string;
  readonly launchedAtMs: number;
}

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const options = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  try {
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" });
  }
}

/** The Monday on or before an ISO day; plain UTC arithmetic on the calendar date. */
function mondayOf(day: string): string {
  const dayMs = Date.parse(`${day}T00:00:00Z`);
  const sinceMonday = (new Date(dayMs).getUTCDay() + 6) % 7;
  return new Date(dayMs - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/** Turns before this can't land in the eight weeks; a day of slack covers any zone's offset. */
export function sandboxShareSince(nowMs: number): { readonly ms: number; readonly iso: string } {
  const ms = nowMs - (SANDBOX_SHARE_WEEKS * 7 + 1) * DAY_MS;
  return { ms, iso: new Date(ms).toISOString() };
}

interface ChatWeek {
  lastAtMs: number;
  onSandbox: boolean;
}

/**
 * One chat counts once a week, on the side its latest turn that week ran. The host's mirror of a
 * sandbox chat and the sandbox's own thread share a thread id, so keying by id counts them once.
 */
export function aggregateSandboxShare(input: {
  readonly runs: readonly SandboxShareRun[];
  readonly unmirroredSandboxChats: readonly UnmirroredSandboxChat[];
  readonly nowMs: number;
  readonly timeZone: string;
}): UsageSandboxShare {
  const format = dayFormatter(input.timeZone);
  const weekOf = (timestampMs: number) => mondayOf(format.format(new Date(timestampMs)));
  const currentWeek = weekOf(input.nowMs);
  const currentWeekMs = Date.parse(`${currentWeek}T00:00:00Z`);
  const weekStarts = Array.from({ length: SANDBOX_SHARE_WEEKS }, (_, index) =>
    new Date(currentWeekMs - (SANDBOX_SHARE_WEEKS - 1 - index) * 7 * DAY_MS)
      .toISOString()
      .slice(0, 10),
  );
  const weeks = new Map(
    weekStarts.map((weekStart) => [
      weekStart,
      { turns: { local: 0, sandbox: 0 }, chats: new Map<string, ChatWeek>() },
    ]),
  );

  const note = (week: string, threadId: string, atMs: number, onSandbox: boolean) => {
    const bucket = weeks.get(week);
    if (bucket === undefined) return null;
    const chat = bucket.chats.get(threadId);
    if (chat === undefined) bucket.chats.set(threadId, { lastAtMs: atMs, onSandbox });
    else if (atMs >= chat.lastAtMs) {
      chat.lastAtMs = atMs;
      chat.onSandbox = onSandbox;
    }
    return bucket;
  };

  const mirrored = new Set<string>();
  for (const run of input.runs) {
    mirrored.add(run.threadId);
    const bucket = note(weekOf(run.startedAtMs), run.threadId, run.startedAtMs, run.onSandbox);
    if (bucket !== null) bucket.turns[run.onSandbox ? "sandbox" : "local"] += 1;
  }
  for (const chat of input.unmirroredSandboxChats) {
    if (mirrored.has(chat.threadId)) continue;
    note(weekOf(chat.launchedAtMs), chat.threadId, chat.launchedAtMs, true);
  }

  return {
    timeZone: input.timeZone,
    weeks: [...weeks].map(([weekStart, bucket]): UsageSandboxShareWeek => {
      const side = (onSandbox: boolean): UsageSandboxShareSide => ({
        chats: [...bucket.chats.values()].filter((chat) => chat.onSandbox === onSandbox).length,
        turns: bucket.turns[onSandbox ? "sandbox" : "local"],
      });
      return { weekStart: weekStart as UsageDay, local: side(false), sandbox: side(true) };
    }),
  };
}
