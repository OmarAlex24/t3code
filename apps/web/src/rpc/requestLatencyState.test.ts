import { WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { rpcAckThresholdMs, shouldTrackRpcAck } from "./requestLatencyState";

describe("slow request tracking", () => {
  it("leaves sandbox starts to their own progress instead of the slow-request toast", () => {
    for (const method of [
      WS_METHODS.sandboxesResume,
      WS_METHODS.sandboxesCreate,
      WS_METHODS.sandboxesPairLaunch,
    ]) {
      expect(shouldTrackRpcAck(method)).toBe(false);
    }
  });

  it("gives sandbox calls that wait on the machine the long threshold", () => {
    for (const method of [
      WS_METHODS.sandboxesLinkHostThread,
      WS_METHODS.sandboxesDelete,
      WS_METHODS.sandboxesSaveTemplate,
    ]) {
      expect(shouldTrackRpcAck(method)).toBe(true);
      expect(rpcAckThresholdMs(method)).toBe(120_000);
    }
  });

  it("keeps the normal threshold for other sandbox calls", () => {
    expect(shouldTrackRpcAck(WS_METHODS.sandboxesList)).toBe(true);
    expect(rpcAckThresholdMs(WS_METHODS.sandboxesStop)).toBe(15_000);
  });
});
