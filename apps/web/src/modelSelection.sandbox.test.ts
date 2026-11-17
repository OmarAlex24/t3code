import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { resolveAppModelSelectionForInstance } from "./modelSelection";

function provider(input: {
  provider?: ProviderDriverKind;
  instanceId: string;
  models?: ReadonlyArray<string>;
  supportsTextGeneration?: boolean;
}): ServerProvider {
  const driver =
    input.provider ??
    (input.instanceId.startsWith("claude_")
      ? ProviderDriverKind.make("claudeAgent")
      : ProviderDriverKind.make("codex"));
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver,
    ...(input.supportsTextGeneration === undefined
      ? {}
      : { supportsTextGeneration: input.supportsTextGeneration }),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: (input.models ?? []).map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

function settingsWithProviderInstances(): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: [] },
      },
      [ProviderInstanceId.make("claude_openrouter")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: ["openai/gpt-5.5"] },
      },
    },
  };
}

describe("instance-scoped model selection on the sandbox bridge", () => {
  it("keeps a sandbox chat's own model on the sandbox bridge, which lists only its placeholder", () => {
    const acp = ProviderDriverKind.make("acpRegistry");
    const providers = [
      provider({ provider: acp, instanceId: "sandboxes", models: ["sandbox"] }),
      provider({ provider: acp, instanceId: "kimi", models: ["kimi-k3"] }),
    ];
    const settings = settingsWithProviderInstances();
    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("sandboxes"),
        settings,
        providers,
        "claude-fable-5-2",
      ),
    ).toBe("claude-fable-5-2");
    // Another agent on the same driver still falls back to a model it lists.
    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("kimi"),
        settings,
        providers,
        "claude-fable-5-2",
      ),
    ).toBe("kimi-k3");
  });
});
