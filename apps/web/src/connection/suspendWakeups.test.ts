import { describe, expect, it } from "vite-plus/test";

import { sleptBetweenTicks } from "./suspendWakeups.ts";

describe("sleptBetweenTicks", () => {
  it("tells a computer's sleep from a busy page", () => {
    expect(sleptBetweenTicks(0, 5_000)).toBe(false);
    // A main thread stalled for a while is not a sleep.
    expect(sleptBetweenTicks(0, 20_000)).toBe(false);
    expect(sleptBetweenTicks(0, 30_000)).toBe(true);
    expect(sleptBetweenTicks(0, 8 * 60 * 60_000)).toBe(true);
  });
});
