import { describe, expect, it } from "vite-plus/test";

import {
  deriveMilestoneBoards,
  formatMilestoneCommentPrefix,
  MILESTONE_BOARD_ROOT,
  parseMilestoneComment,
  pendingAskCard,
} from "./threadMilestoneBoard.ts";

const milestone = (id: string, event: string, fields: Record<string, unknown> = {}) =>
  ({ id, type: "milestone", event, milestoneId: null, setId: "s1", ...fields }) as never;
const render = (id: string, title: string, status = "completed") =>
  ({
    id,
    type: "dynamic_tool",
    status,
    toolName: "mcp__t3-code__html_render",
    output: { htmlRender: { attachmentId: `${id}.html`, title, height: 300 } },
  }) as never;
const said = (id: string, text: string) => ({ id, type: "user_message", text }) as never;

describe("milestone comments", () => {
  it("round-trips the milestone a comment is about, and ignores ordinary messages", () => {
    const text = `${formatMilestoneCommentPrefix({ id: "m3", title: "Build\nthe API" })}Use the same copy on mobile.`;
    expect(parseMilestoneComment(text)).toEqual({
      milestoneId: "m3",
      body: "Use the same copy on mobile.",
    });
    expect(parseMilestoneComment(formatMilestoneCommentPrefix({ id: "m3", title: "x" }))).toBe(
      null,
    );
    expect(parseMilestoneComment("Re: milestone m3 looks wrong")).toBe(null);
  });
});

describe("deriveMilestoneBoards", () => {
  it("hangs posts and comments on their milestone, and visuals on the one running", () => {
    const boards = deriveMilestoneBoards(
      [
        milestone("post-early", "post", { note: "Before any plan" }),
        render("r0", "Sketch"),
        milestone("plan", "plan", { planned: [{ id: "m1", title: "A" }] }),
        render("r1", "Sign-in states"),
        render("r-failed", "Broken", "failed"),
        milestone("start-2", "started", { milestoneId: "m2" }),
        milestone("post-1", "post", { milestoneId: "m1", note: "Late note", attachments: [] }),
        said("c1", `${formatMilestoneCommentPrefix({ id: "m1", title: "A" })}Looks good`),
        said("plain", "Keep going"),
        render("r2", "Schema"),
      ],
      (item) => (item as unknown as { text: string }).text,
    );

    expect(boards.get(MILESTONE_BOARD_ROOT)).toEqual([
      { kind: "post", id: "post-early", text: "Before any plan", attachments: [] },
      { kind: "visual", id: "r0", title: "Sketch" },
    ]);
    expect(boards.get("m1")).toEqual([
      { kind: "visual", id: "r1", title: "Sign-in states" },
      { kind: "post", id: "post-1", text: "Late note", attachments: [] },
      { kind: "comment", id: "c1", text: "Looks good" },
    ]);
    expect(boards.get("m2")).toEqual([{ kind: "visual", id: "r2", title: "Schema" }]);
  });
});

describe("pendingAskCard", () => {
  const card = (id: string, fields: Record<string, unknown>, visibility = "local") =>
    ({ visibility, item: { id, ...fields } }) as never;
  const secret = { type: "secret_request", secretStatus: "pending" };
  const link = { type: "link_request", linkStatus: "pending" };
  it.each([
    ["a pending secret", [card("s1", secret)], "s1"],
    ["a pending link", [card("l1", link)], "l1"],
    ["the latest of several", [card("s1", secret), card("l1", link)], "l1"],
    ["an answered secret", [card("s1", { ...secret, secretStatus: "saved" })], null],
    ["a card from the parent thread", [card("s1", secret, "inherited")], null],
    ["no card", [card("m1", { type: "milestone" })], null],
  ])("%s", (_name, items, expected) => {
    expect(pendingAskCard(items)?.id ?? null).toBe(expected);
  });
});
