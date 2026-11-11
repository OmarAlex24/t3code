import {
  type OrchestrationV2MilestoneAction,
  type OrchestrationV2TurnItem,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  decideMilestoneAction,
  foldMilestoneItems,
  milestonesAfterRollback,
  milestoneTurnItem,
  summarizeMilestones,
} from "./MilestoneDecider.ts";

const NOW = DateTime.makeUnsafe("2026-11-10T00:00:00.000Z");
const RUN_1 = RunId.make("run-1");
const RUN_2 = RunId.make("run-2");

/** Decides and records each action as `milestone` turn items, as the orchestrator does. */
function record(
  steps: ReadonlyArray<readonly [RunId, OrchestrationV2MilestoneAction]>,
  items: ReadonlyArray<OrchestrationV2TurnItem> = [],
) {
  const log = [...items];
  const rejections: Array<string> = [];
  for (const [runId, action] of steps) {
    const decision = decideMilestoneAction(foldMilestoneItems(log, new Set()), action);
    if (decision._tag === "rejected") {
      rejections.push(decision.message);
      continue;
    }
    if (decision._tag !== "accepted") continue;
    log.push(
      milestoneTurnItem({
        base: {
          id: TurnItemId.make(`item-${log.length + 1}`),
          threadId: ThreadId.make("thread-1"),
          runId,
          nodeId: NodeId.make("node-1"),
          providerThreadId: null,
          providerTurnId: null,
          ordinal: log.length + 1,
        },
        detail: decision.detail,
        now: NOW,
      }),
    );
  }
  return { items: log, rejections, state: foldMilestoneItems(log, new Set()) };
}

const statuses = (state: ReturnType<typeof foldMilestoneItems>) =>
  state.milestones.map(({ id, setId, status }) => `${id}:${setId}:${status}`);

describe("decideMilestoneAction", () => {
  it("walks a plan, closing the active milestone on each start", () => {
    const { state, items } = record([
      [RUN_1, { action: "plan", titles: ["Scope", "Build", "Ship"] }],
      [RUN_1, { action: "start", note: "scoped" }],
      [RUN_1, { action: "change", id: "m3", title: "Ship it", reason: "renamed" }],
      [RUN_1, { action: "start", id: "m3" }],
      [RUN_1, { action: "done", note: "shipped" }],
    ]);

    expect(statuses(state)).toEqual(["m1:s1:done", "m2:s1:done", "m3:s1:done"]);
    expect(state.milestones[0]).toMatchObject({ note: "scoped", anchors: { done: {} } });
    expect(state.milestones[2]).toMatchObject({
      title: "Ship it",
      note: "shipped",
      revision: { previousTitle: "Ship", reason: "renamed" },
    });
    expect(items.at(-1)).toMatchObject({ type: "milestone", event: "done", milestoneId: "m3" });
    expect(summarizeMilestones(state.milestones)).toBe("3/3 done");
  });

  it("opens a new set on each plan and keeps ids counting thread-wide", () => {
    const { state } = record([
      [RUN_1, { action: "plan", titles: ["A", "B", "C"] }],
      [RUN_1, { action: "drop", id: "m3", reason: "not needed" }],
      [RUN_1, { action: "plan", titles: ["D", "E"] }],
      [RUN_1, { action: "start", title: "Extra" }],
    ]);

    expect(statuses(state)).toEqual([
      "m1:s1:done",
      "m2:s1:dropped",
      "m3:s1:dropped",
      "m4:s2:done",
      "m5:s2:planned",
      "m6:s2:active",
    ]);
    expect(state.milestones[2]?.note).toBe("not needed");
    expect(summarizeMilestones(state.milestones)).toBe("m6 active · 2/3 · next m5");
  });

  it("starts an unplanned milestone in a new set when nothing exists yet", () => {
    const { state } = record([[RUN_1, { action: "start", title: "Explore" }]]);
    expect(statuses(state)).toEqual(["m1:s1:active"]);
  });

  it("keeps the active milestone when started again by its own title", () => {
    const { state, items, rejections } = record([
      [RUN_1, { action: "plan", titles: ["Preparar", "Verificar"] }],
      [RUN_1, { action: "start", title: "Preparar" }],
    ]);
    expect(rejections).toEqual([]);
    expect(items).toHaveLength(1);
    expect(statuses(state)).toEqual(["m1:s1:active", "m2:s1:planned"]);
    expect(decideMilestoneAction(state, { action: "start", title: "  preparar " })).toMatchObject({
      _tag: "unchanged",
    });
  });

  it.each([
    ["the same title", "Verificar"],
    ["a title differing in case and whitespace", "  vERIFICAR  "],
  ])("starts the planned milestone with %s", (_name, title) => {
    const { state, items } = record([
      [RUN_1, { action: "plan", titles: ["Preparar", "Verificar", "Verificar"] }],
      [RUN_1, { action: "start", title }],
    ]);
    expect(items.at(-1)).toMatchObject({
      event: "started",
      milestoneId: "m2",
      setId: "s1",
      title: "Verificar",
      closedMilestoneId: "m1",
    });
    expect(statuses(state)).toEqual(["m1:s1:done", "m2:s1:active", "m3:s1:planned"]);
  });

  it("starts a new milestone when the title matches only a closed one", () => {
    const { state } = record([
      [RUN_1, { action: "plan", titles: ["Preparar", "Verificar"] }],
      [RUN_1, { action: "start" }],
      [RUN_1, { action: "drop", id: "m2", reason: "skipped" }],
      [RUN_1, { action: "start", title: "Preparar" }],
      [RUN_1, { action: "start", title: "verificar" }],
    ]);
    expect(statuses(state)).toEqual(["m1:s1:done", "m2:s1:dropped", "m3:s1:done", "m4:s1:active"]);
    expect(state.milestones.map(({ title }) => title)).toEqual([
      "Preparar",
      "Verificar",
      "Preparar",
      "verificar",
    ]);
  });

  it.each<[string, ReadonlyArray<OrchestrationV2MilestoneAction>, string]>([
    ["start with nothing planned", [{ action: "start" }], "Nothing planned"],
    [
      "start with both id and title",
      [{ action: "start", id: "m1", title: "X" }],
      "Pass `id` or `title`, not both.",
    ],
    ["start an unknown id", [{ action: "start", id: "m9" }], "No milestone m9."],
    [
      "start the active milestone",
      [
        { action: "plan", titles: ["A"] },
        { action: "start", id: "m1" },
      ],
      "m1 is active; start a planned one or pass `title`.",
    ],
    ["done with nothing active", [{ action: "done" }], "No active milestone. Pass `id`."],
    [
      "done twice",
      [{ action: "plan", titles: ["A"] }, { action: "done" }, { action: "done", id: "m1" }],
      "m1 is already done.",
    ],
    [
      "change a closed milestone",
      [
        { action: "plan", titles: ["A"] },
        { action: "done" },
        { action: "change", id: "m1", reason: "late" },
      ],
      "m1 is done; only planned or active ones change.",
    ],
    ["drop an unknown id", [{ action: "drop", id: "m2", reason: "x" }], "No milestone m2."],
    ["an empty post", [{ action: "post", attachments: [] }], "A post needs `note` or `images`."],
  ])("rejects %s", (_name, actions, message) => {
    const { rejections } = record(actions.map((action) => [RUN_1, action] as const));
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain(message);
  });

  it("posts to the active milestone without changing it", () => {
    const { state, items } = record([
      [RUN_1, { action: "plan", titles: ["A", "B"] }],
      [RUN_1, { action: "post", text: "screenshot", attachments: [] }],
    ]);
    expect(items.at(-1)).toMatchObject({ event: "post", milestoneId: "m1", note: "screenshot" });
    expect(statuses(state)).toEqual(["m1:s1:active", "m2:s1:planned"]);
  });
});

describe("milestone rollback", () => {
  it("drops a rolled-back run's transitions without reusing its ids", () => {
    const first = record([[RUN_1, { action: "plan", titles: ["A", "B"] }]]);
    const second = record(
      [
        [RUN_2, { action: "start", note: "a done" }],
        [RUN_2, { action: "start", title: "C" }],
      ],
      first.items,
    );
    expect(statuses(second.state)).toEqual(["m1:s1:done", "m2:s1:done", "m3:s1:active"]);

    const after = milestonesAfterRollback({
      items: second.items,
      runs: [{ id: RUN_1, status: "completed" }],
      rollingBack: [RUN_2],
    });
    expect(after?.map(({ id, status }) => `${id}:${status}`)).toEqual(["m1:active", "m2:planned"]);

    const replayed = foldMilestoneItems(second.items, new Set([RUN_2]));
    const decision = decideMilestoneAction(replayed, { action: "start", title: "D" });
    expect(decision).toMatchObject({ _tag: "accepted", detail: { milestoneId: "m4" } });
  });

  it("changes nothing when the rolled-back runs marked no milestone", () => {
    const { items } = record([[RUN_1, { action: "plan", titles: ["A"] }]]);
    expect(
      milestonesAfterRollback({
        items,
        runs: [{ id: RUN_1, status: "completed" }],
        rollingBack: [RUN_2],
      }),
    ).toBeUndefined();
  });

  it("ignores runs already rolled back when replaying", () => {
    const { items } = record([
      [RUN_1, { action: "plan", titles: ["A"] }],
      [RUN_2, { action: "done" }],
    ]);
    const after = milestonesAfterRollback({
      items,
      runs: [{ id: RUN_2, status: "rolled_back" }],
      rollingBack: [RUN_1],
    });
    expect(after).toEqual([]);
  });
});
