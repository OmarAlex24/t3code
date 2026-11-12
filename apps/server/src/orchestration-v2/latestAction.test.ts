import {
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { latestActionFromTurnItem } from "./latestAction.ts";

const at = DateTime.makeUnsafe("2026-11-10T10:00:00.000Z");
const base = {
  id: TurnItemId.make("item:latest-action"),
  threadId: ThreadId.make("thread:latest-action"),
  runId: RunId.make("run:latest-action"),
  nodeId: NodeId.make("node:latest-action"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  startedAt: at,
  completedAt: null,
  updatedAt: at,
} as const;

describe("latestActionFromTurnItem", () => {
  it.each([
    [{ type: "file_search", pattern: "useAuth" }, { summary: "Searched useAuth" }],
    [{ type: "web_search", patterns: ["github oauth"] }, { summary: "Searched github oauth" }],
    [
      { type: "dynamic_tool", toolName: "Read", input: { file_path: "src/auth/session.ts" } },
      { summary: "Read src/auth/session.ts" },
    ],
    [
      { type: "dynamic_tool", toolName: "Grep", input: { pattern: "session", path: "src" } },
      { summary: "Searched session in src" },
    ],
    [
      { type: "dynamic_tool", toolName: "mcp__t3-code__request_secret", input: {} },
      { summary: "Asked for a secret" },
    ],
    [
      {
        type: "dynamic_tool",
        toolName: "mcp__t3-code__delegate_task",
        input: {},
        status: "failed",
      },
      { summary: "Failed to delegate a child task" },
    ],
    [
      { type: "dynamic_tool", toolName: "mcp__linear__create_issue", input: {} },
      { summary: "create_issue" },
    ],
    [
      {
        type: "dynamic_tool",
        toolName: "mcp__linear__create_issue",
        title: "mcp__linear__create_issue",
        input: {},
      },
      { summary: "create_issue" },
    ],
    [{ type: "reasoning", text: "Thinking", streaming: false }, null],
    [{ type: "assistant_message", messageId: "message:x", text: "Done", streaming: false }, null],
  ] as const)("labels %o", (item, expected) => {
    const action = latestActionFromTurnItem({ ...base, ...item } as OrchestrationV2TurnItem);
    expect(action).toEqual(expected === null ? null : { ...expected, at });
  });
});
