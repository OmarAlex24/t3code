import { describe, expect, it } from "vite-plus/test";

import {
  ProviderInstanceId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  type ServerConfig,
} from "@t3tools/contracts";

import { buildModelOptions } from "./modelOptions";

const provider = (instanceId: string, driver: string, slug: string, name: string) => ({
  instanceId,
  driver,
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  models: [{ slug, name, isCustom: false, capabilities: null }],
});

const config = {
  providers: [
    provider("claudeAgent", "claudeAgent", "opus", "Claude Opus"),
    provider(SANDBOX_BRIDGE_INSTANCE_ID, "acpRegistry", "sandbox", "Sandbox agent"),
  ],
} as unknown as ServerConfig;

describe("the sandbox bridge in mobile model options", () => {
  it("is not offered to a thread that isn't on it", () => {
    expect(buildModelOptions(config, null, undefined, null).map((option) => option.key)).toEqual([
      "claudeAgent:opus",
    ]);
  });

  it("still lists the Sandbox agent for a host thread the bridge drives", () => {
    const bridge = ProviderInstanceId.make(SANDBOX_BRIDGE_INSTANCE_ID);
    expect(
      buildModelOptions(config, { instanceId: bridge, model: "sandbox" }, bridge, null).map(
        (option) => option.label,
      ),
    ).toContain("Sandbox agent");
  });
});
