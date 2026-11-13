import {
  type ModelSelection,
  ProviderInstanceId,
  type SandboxThreadMirror,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sandboxMirrorModelSource, sandboxMirrorModelSourceOf } from "./sandboxMirror.ts";

const sandboxClaude = {
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  enabled: true,
  installed: true,
  status: "ready",
  models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: null }],
} as unknown as ServerProvider;
const running = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "xhigh" }],
} as ModelSelection;

describe("sandboxMirrorModelSource", () => {
  // The host's bridge lists one set of models and options for every sandbox, so its picker read
  // "Sandboxes" with another chat's effort.
  it("shows the sandbox's own provider and selection, under the bridge the mirror sends on", () => {
    expect(sandboxMirrorModelSource(running, [sandboxClaude])).toEqual({
      providers: [{ ...sandboxClaude, instanceId: "sandboxes" }],
      modelSelection: { ...running, instanceId: ProviderInstanceId.make("sandboxes") },
    });
  });

  it("leaves the bridge's list while the sandbox's provider is unknown here", () => {
    expect(sandboxMirrorModelSource(running, [])).toBeNull();
  });

  // The phone reads the same through the host, kept while the sandbox is stopped.
  it("reads the same source from what the host read of the sandbox, available or not", () => {
    const mirror = {
      available: false,
      provider: sandboxClaude,
      modelSelection: running,
      runs: [],
      subagents: [],
    } satisfies SandboxThreadMirror;
    expect(sandboxMirrorModelSourceOf(mirror)).toEqual(
      sandboxMirrorModelSource(running, [sandboxClaude]),
    );
    expect(sandboxMirrorModelSourceOf({ ...mirror, provider: null })).toBeNull();
  });
});
