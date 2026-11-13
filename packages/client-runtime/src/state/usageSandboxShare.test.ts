import { UsageDay, type UsageSandboxShare } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sandboxShareChangeLabel, summarizeSandboxShare } from "./usageSandboxShare.ts";

const week = (
  weekStart: string,
  local: readonly [chats: number, turns: number],
  sandbox: readonly [chats: number, turns: number],
) => ({
  weekStart: UsageDay.make(weekStart),
  local: { chats: local[0], turns: local[1] },
  sandbox: { chats: sandbox[0], turns: sandbox[1] },
});

const share = (...weeks: UsageSandboxShare["weeks"]): UsageSandboxShare => ({
  timeZone: "UTC",
  weeks,
});

describe("summarizeSandboxShare", () => {
  it("reads this week's sandbox share of turns against last week's", () => {
    const summary = summarizeSandboxShare(
      share(
        week("2026-10-26", [4, 20], [0, 0]),
        week("2026-11-02", [3, 15], [1, 5]),
        week("2026-11-09", [2, 6], [2, 6]),
      ),
    );
    expect(summary.current).toEqual({
      weekStart: "2026-11-09",
      sandboxShare: 0.5,
      local: { chats: 2, turns: 6 },
      sandbox: { chats: 2, turns: 6 },
    });
    expect(summary.previousShare).toBe(0.25);
    expect(summary.change).toBe(0.25);
    expect(sandboxShareChangeLabel(summary)).toBe("Up 25 points from last week");
    expect(summary.weeks.map((entry) => entry.sandboxShare)).toEqual([0, 0.25, 0.5]);
    expect(summary.hasSandboxActivity).toBe(true);
  });

  it("has no share for a week without turns, and no change against one", () => {
    const summary = summarizeSandboxShare(
      share(week("2026-11-02", [0, 0], [0, 0]), week("2026-11-09", [0, 0], [1, 3])),
    );
    expect(summary.current?.sandboxShare).toBe(1);
    expect(summary.previousShare).toBeNull();
    expect(summary.change).toBeNull();
    expect(sandboxShareChangeLabel(summary)).toBeNull();
    expect(summary.weeks[0]?.sandboxShare).toBeNull();
  });

  it("rounds the change to whole points", () => {
    const summary = (current: number) =>
      summarizeSandboxShare(
        share(
          week("2026-11-02", [1, 1000], [0, 0]),
          week("2026-11-09", [1, 1000 - current], [1, current]),
        ),
      );
    expect(sandboxShareChangeLabel(summary(4))).toBe("Same as last week");
    expect(sandboxShareChangeLabel(summary(10))).toBe("Up 1 point from last week");
  });

  it("counts a launch with no turns as sandbox activity", () => {
    const summary = summarizeSandboxShare(
      share(week("2026-11-02", [1, 2], [0, 0]), week("2026-11-09", [0, 0], [1, 0])),
    );
    expect(summary.current?.sandboxShare).toBeNull();
    expect(summary.hasSandboxActivity).toBe(true);
    expect(
      summarizeSandboxShare(share(week("2026-11-09", [1, 2], [0, 0]))).hasSandboxActivity,
    ).toBe(false);
  });
});
