import { describe, expect, it } from "vite-plus/test";

import { aggregateSandboxShare, type SandboxShareRun } from "./sandboxShare.ts";

// Friday 2026-11-13, so the current week starts Monday 2026-11-09.
const NOW = Date.parse("2026-11-13T12:00:00Z");

const run = (threadId: string, startedAt: string, onSandbox: boolean): SandboxShareRun => ({
  threadId,
  startedAtMs: Date.parse(startedAt),
  onSandbox,
});

const aggregate = (input: Partial<Parameters<typeof aggregateSandboxShare>[0]>) =>
  aggregateSandboxShare({
    runs: [],
    unmirroredSandboxChats: [],
    nowMs: NOW,
    timeZone: "UTC",
    ...input,
  });

describe("aggregateSandboxShare", () => {
  it("returns eight Monday weeks, oldest first, empty when nothing ran", () => {
    const share = aggregate({});
    expect(share.weeks.map((week) => week.weekStart)).toEqual([
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
      "2026-11-02",
      "2026-11-09",
    ]);
    for (const week of share.weeks) {
      expect(week.local).toEqual({ chats: 0, turns: 0 });
      expect(week.sandbox).toEqual({ chats: 0, turns: 0 });
    }
  });

  it("counts chats once and every started turn, and skips weeks with no activity", () => {
    const share = aggregate({
      runs: [
        run("local-a", "2026-11-09T08:00:00Z", false),
        run("local-a", "2026-11-10T08:00:00Z", false),
        run("local-b", "2026-11-11T08:00:00Z", false),
        // The host's mirror of a sandbox chat; the sandbox's own thread shares its id.
        run("sandbox-a", "2026-11-12T08:00:00Z", true),
        run("sandbox-a", "2026-11-12T09:00:00Z", true),
        run("sandbox-a", "2026-11-12T10:00:00Z", true),
        run("local-a", "2026-10-20T08:00:00Z", false),
      ],
    });
    const byWeek = new Map<string, (typeof share.weeks)[number]>(
      share.weeks.map((week) => [week.weekStart, week]),
    );
    expect(byWeek.get("2026-11-09")).toEqual({
      weekStart: "2026-11-09",
      local: { chats: 2, turns: 3 },
      sandbox: { chats: 1, turns: 3 },
    });
    expect(byWeek.get("2026-10-19")?.local).toEqual({ chats: 1, turns: 1 });
    expect(byWeek.get("2026-11-02")).toEqual({
      weekStart: "2026-11-02",
      local: { chats: 0, turns: 0 },
      sandbox: { chats: 0, turns: 0 },
    });
  });

  it("splits a chat's turns when it moved to a sandbox, and counts the chat on its latest side", () => {
    const share = aggregate({
      runs: [
        run("moved", "2026-11-03T08:00:00Z", false),
        run("moved", "2026-11-09T08:00:00Z", false),
        run("moved", "2026-11-11T08:00:00Z", true),
        run("moved", "2026-11-12T08:00:00Z", true),
      ],
    });
    const [previous, current] = share.weeks.slice(-2);
    expect(previous).toMatchObject({ local: { chats: 1, turns: 1 }, sandbox: { chats: 0 } });
    expect(current).toMatchObject({
      local: { chats: 0, turns: 1 },
      sandbox: { chats: 1, turns: 2 },
    });
  });

  it("counts a sandbox chat the host never mirrored once, in the week it launched", () => {
    const share = aggregate({
      runs: [run("mirrored", "2026-11-10T08:00:00Z", true)],
      unmirroredSandboxChats: [
        { threadId: "unmirrored", launchedAtMs: Date.parse("2026-11-04T08:00:00Z") },
        // A record for a thread the host also has runs for is the same chat.
        { threadId: "mirrored", launchedAtMs: Date.parse("2026-11-10T07:00:00Z") },
      ],
    });
    const [previous, current] = share.weeks.slice(-2);
    expect(previous?.sandbox).toEqual({ chats: 1, turns: 0 });
    expect(current?.sandbox).toEqual({ chats: 1, turns: 1 });
  });

  it("buckets by the requested zone's weeks and ignores turns outside the eight weeks", () => {
    const share = aggregate({
      timeZone: "America/Los_Angeles",
      runs: [
        // Monday 01:00 UTC is still Sunday in Los Angeles, the previous week.
        run("late", "2026-11-09T01:00:00Z", false),
        run("old", "2026-09-01T08:00:00Z", false),
        run("future", "2026-11-20T08:00:00Z", false),
      ],
    });
    const [previous, current] = share.weeks.slice(-2);
    expect(previous?.local.turns).toBe(1);
    expect(current?.local.turns).toBe(0);
    expect(share.weeks.reduce((sum, week) => sum + week.local.turns, 0)).toBe(1);
  });
});
