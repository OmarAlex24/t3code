import {
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolvePendingHandoff, type HandoffTimelineRun } from "./handoff.ts";

const from = ProviderInstanceId.make("codex_personal");
const to = ProviderInstanceId.make("claudeAgent");
const run = (
  id: string,
  ordinal: number,
  instanceId: ProviderInstanceId,
  model: string,
): HandoffTimelineRun => ({
  id: RunId.make(id),
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model },
});

const projection = {
  runs: [
    {
      ...run("source", 1, from, "source"),
      status: "completed",
      contextHandoffId: null,
      startedAt: "2026-10-11T00:00:00Z",
    },
  ],
  visibleTurnItems: [{ item: { type: "user_message" } }],
} as unknown as OrchestrationV2ThreadProjection;

describe("pending context handoff on the sandbox bridge", () => {
  it("stays hidden for a switch onto or off the sandbox bridge, which carries no history", () => {
    const bridge = ProviderInstanceId.make("sandboxes");
    const sandboxChat = {
      ...projection,
      runs: [{ ...projection.runs[0]!, ...run("source", 1, bridge, "claude-opus-5-5") }],
    };
    expect(
      resolvePendingHandoff(sandboxChat, { instanceId: to, model: "claude-opus-5-5" }, []),
    ).toBeNull();
    expect(
      resolvePendingHandoff(projection, { instanceId: bridge, model: "claude-opus-5-5" }, []),
    ).toBeNull();
  });
});
