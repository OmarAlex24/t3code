import { type SandboxRecord, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeSandboxWork, sandboxSettleDecisionOf } from "./sandboxSettle.ts";

const chat = ThreadId.make("thread-chat");

const record = (overrides: Partial<SandboxRecord> = {}): SandboxRecord =>
  ({
    instanceId: "sandbox-1",
    environmentId: "environment-sandbox-1",
    provider: "celesto",
    sandboxId: "sb_1",
    state: "running",
    threadId: chat,
    hostProjectId: "project-host",
    settlePending: { since: "2026-11-13T10:00:00.000Z", reason: "ask" },
    ...overrides,
  }) as SandboxRecord;

describe("sandboxSettleDecisionOf", () => {
  it("reads the decision the host waits on for the chat's sandbox", () => {
    expect(sandboxSettleDecisionOf([record()], chat)).toEqual({
      instanceId: "sandbox-1",
      provider: "celesto",
      reason: "ask",
      stopped: false,
    });
    expect(
      sandboxSettleDecisionOf(
        [record({ state: "stopped", settlePending: { since: "x", reason: "work" } })],
        chat,
      ),
    ).toMatchObject({ reason: "work", stopped: true });
  });

  it("is null for a chat with nothing pending, and for any other thread", () => {
    const { settlePending: _settlePending, ...answered } = record();
    expect(sandboxSettleDecisionOf([answered as SandboxRecord], chat)).toBeNull();
    expect(sandboxSettleDecisionOf([record()], ThreadId.make("thread-other"))).toBeNull();
  });

  // A new launch on the thread replaces an abandoned sandbox, whose record stays until deleted.
  it("reads the chat's live sandbox, not a deleted one on the same thread", () => {
    expect(
      sandboxSettleDecisionOf([record({ instanceId: "old", state: "deleted" })], chat),
    ).toBeNull();
    expect(
      sandboxSettleDecisionOf(
        [record({ instanceId: "old", state: "deleted" }), record({ instanceId: "new" })],
        chat,
      )?.instanceId,
    ).toBe("new");
  });
});

describe("describeSandboxWork", () => {
  it.each([
    [
      { status: "clean", uncommittedFiles: 0, unpushedCommits: 0 },
      "No uncommitted or unpushed work.",
    ],
    [
      { status: "dirty", uncommittedFiles: 2, unpushedCommits: 1 },
      "2 uncommitted files and 1 unpushed commit would be lost.",
    ],
    [
      { status: "dirty", uncommittedFiles: 1, unpushedCommits: 0 },
      "1 uncommitted file would be lost.",
    ],
    [
      {
        status: "unknown",
        uncommittedFiles: 0,
        unpushedCommits: 0,
        detail: "The sandbox did not answer in time.",
      },
      "Couldn't check for unpushed work. The sandbox did not answer in time.",
    ],
  ] as const)("says what a delete would lose: %j", (work, text) => {
    expect(describeSandboxWork(work)).toBe(text);
  });
});
