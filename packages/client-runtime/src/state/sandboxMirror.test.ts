import {
  type ModelSelection,
  ProviderInstanceId,
  type SandboxThreadMirror,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  sandboxMirrorModelSource,
  sandboxMirrorModelSourceOf,
  sandboxMirrorPickerSource,
} from "./sandboxMirror.ts";

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

describe("sandboxMirrorPickerSource", () => {
  const bridge = {
    ...sandboxClaude,
    instanceId: "sandboxes",
    driver: "acpRegistry",
  } as ServerProvider;
  const hostCodex = { ...sandboxClaude, instanceId: "codex", driver: "codex" } as ServerProvider;
  const mirrorSelection = {
    instanceId: ProviderInstanceId.make("sandboxes"),
    model: "claude-opus-5-5",
  } as ModelSelection;
  const hostMirror = {
    available: false,
    provider: sandboxClaude,
    modelSelection: running,
    runs: [],
    subagents: [],
  } satisfies SandboxThreadMirror;
  const input = {
    paired: null,
    hostMirror: null,
    mirrorSelection,
    hostProviders: [sandboxClaude, bridge, hostCodex],
  };

  it("prefers the paired sandbox's thread, then what the host read of it", () => {
    const paired = sandboxMirrorModelSource(running, [sandboxClaude]);
    expect(sandboxMirrorPickerSource({ ...input, paired, hostMirror })).toEqual({
      ...paired,
      readOnly: false,
    });
    expect(sandboxMirrorPickerSource({ ...input, hostMirror })).toEqual({
      ...sandboxMirrorModelSourceOf(hostMirror),
      readOnly: false,
    });
  });

  // Picking the host's Claude on a stopped sandbox's mirror was refused by the host.
  it("never offers the host's own providers while neither has read the sandbox", () => {
    expect(sandboxMirrorPickerSource(input)).toEqual({
      providers: [bridge],
      modelSelection: mirrorSelection,
      readOnly: true,
    });
    expect(
      sandboxMirrorPickerSource({ ...input, hostMirror: { ...hostMirror, provider: null } }),
    ).toEqual({ providers: [bridge], modelSelection: mirrorSelection, readOnly: true });
  });
});
