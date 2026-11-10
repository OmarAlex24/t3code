import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("says why a sandbox thread cannot change and offers deleting its sandbox", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      sandboxUnavailable: "The sandbox no longer exists",
    });
    expect(items[0]).toEqual({
      id: "sandbox-unavailable",
      label: "The sandbox no longer exists",
      disabled: true,
    });
    expect(items[1]).toMatchObject({ id: "pin", disabled: true, separatorBefore: true });
    expect(items.at(-1)).toMatchObject({ id: "delete-sandbox", label: "Delete sandbox…" });
    expect(items.at(-1)?.disabled).not.toBe(true);
    expect(items.find((item) => item.id === "delete")?.disabled).toBe(true);
  });

  it("leaves an operable thread's menu as it was, sandbox or not", () => {
    expect(
      buildThreadActionMenuItems({ ...baseState, sandboxUnavailable: "The sandbox is stopped" }),
    ).toEqual(buildThreadActionMenuItems(baseState));
    expect(
      buildThreadActionMenuItems({ ...baseState, canOperate: false, sandboxUnavailable: null }),
    ).toEqual(buildThreadActionMenuItems({ ...baseState, canOperate: false }));
  });
});
