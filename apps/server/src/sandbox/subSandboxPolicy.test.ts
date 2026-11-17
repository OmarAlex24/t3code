import {
  ProjectId,
  type SandboxEnvironmentConfig,
  type SandboxRecord,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkSubSandboxCapacity,
  resolveSubSandboxConfig,
  resolveSubSandboxSize,
} from "./subSandboxPolicy.ts";

const parent = ThreadId.make("thread:parent");
const other = ThreadId.make("thread:other");
const projectId = ProjectId.make("project:host");

const config = (overrides: Partial<SandboxEnvironmentConfig> = {}): SandboxEnvironmentConfig => ({
  id: "config-a",
  label: "Boat",
  provider: "boat",
  size: "small",
  passGithubToken: false,
  joinTailnet: false,
  access: "public",
  envFiles: {},
  idleMinutes: 30,
  maxRunningMinutes: 480,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

let counter = 0;
const record = (overrides: Partial<SandboxRecord> = {}): SandboxRecord => {
  counter += 1;
  return {
    instanceId: `instance-${counter}`,
    environmentId: null,
    provider: "boat",
    sandboxId: `bx_${counter}`,
    label: "sandbox",
    size: "small",
    state: "running",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    httpBaseUrl: "",
    runningSince: null,
    maxRunningMinutes: 480,
    ...overrides,
  };
};

const sizes = [
  { id: "small", label: "Small", detail: "" },
  { id: "default", label: "Default", detail: "" },
  { id: "large", label: "Large", detail: "" },
  { id: "xlarge", label: "Extra large", detail: "" },
];

describe("checkSubSandboxCapacity", () => {
  it("allows two per parent thread by default and refuses a third", () => {
    const records = [
      record({ parentThreadId: parent }),
      record({ parentThreadId: parent, state: "provisioning" }),
    ];
    const refusal = checkSubSandboxCapacity({
      config: config(),
      parentThreadId: parent,
      records,
      starting: new Map(),
    });
    expect(refusal?.code).toBe("concurrency_full");
    expect(refusal?.message).toContain("This thread already has 2 subagent sandboxes");
    expect(
      checkSubSandboxCapacity({
        config: config(),
        parentThreadId: parent,
        records: records.slice(1),
        starting: new Map(),
      }),
    ).toBeNull();
  });

  it("counts sandboxes still starting that have no record yet", () => {
    const refusal = checkSubSandboxCapacity({
      config: config(),
      parentThreadId: parent,
      records: [record({ parentThreadId: parent })],
      starting: new Map([["instance-starting", parent]]),
    });
    expect(refusal?.code).toBe("concurrency_full");
  });

  it("counts a starting sandbox once when its record already exists", () => {
    const existing = record({ parentThreadId: parent, state: "provisioning" });
    expect(
      checkSubSandboxCapacity({
        config: config(),
        parentThreadId: parent,
        records: [existing],
        starting: new Map([[existing.instanceId, parent]]),
      }),
    ).toBeNull();
  });

  it("refuses past four in total across parents by default", () => {
    const records = [
      record({ parentThreadId: other }),
      record({ parentThreadId: other }),
      record({ parentThreadId: ThreadId.make("thread:third") }),
    ];
    const refusal = checkSubSandboxCapacity({
      config: config(),
      parentThreadId: parent,
      records,
      starting: new Map([["instance-starting", ThreadId.make("thread:fourth")]]),
    });
    expect(refusal?.code).toBe("concurrency_full");
    expect(refusal?.message).toContain("4 subagent sandboxes are already running");
  });

  it("leaves out stopped sandboxes, chat sandboxes and the config's own limits", () => {
    const records = [
      record({ parentThreadId: parent, state: "stopped" }),
      record({ parentThreadId: parent, state: "error" }),
      record({ threadId: parent }),
      record({ threadId: other }),
    ];
    expect(
      checkSubSandboxCapacity({
        config: config(),
        parentThreadId: parent,
        records,
        starting: new Map(),
      }),
    ).toBeNull();
    const refusal = checkSubSandboxCapacity({
      config: config({ subSandboxes: { perThread: 3, total: 1 } }),
      parentThreadId: parent,
      records: [record({ parentThreadId: other })],
      starting: new Map(),
    });
    expect(refusal?.message).toContain("1 subagent sandboxes are already running");
  });

  it("refuses every start when the config turns them off", () => {
    const refusal = checkSubSandboxCapacity({
      config: config({ subSandboxes: { perThread: 0, total: 4 } }),
      parentThreadId: parent,
      records: [],
      starting: new Map(),
    });
    expect(refusal?.code).toBe("concurrency_full");
    expect(refusal?.message).toContain("does not let subagents start sandboxes");
  });
});

describe("resolveSubSandboxSize", () => {
  it("defaults to the config's size and allows one step up or anything smaller", () => {
    expect(resolveSubSandboxSize({ config: config(), sizes, requested: undefined })).toEqual({
      _tag: "size",
      size: "small",
    });
    expect(
      resolveSubSandboxSize({ config: config({ size: "default" }), sizes, requested: "large" }),
    ).toEqual({ _tag: "size", size: "large" });
    expect(
      resolveSubSandboxSize({ config: config({ size: "default" }), sizes, requested: "small" }),
    ).toEqual({ _tag: "size", size: "small" });
  });

  it("refuses two steps up and sizes the provider does not have", () => {
    const tooBig = resolveSubSandboxSize({ config: config(), sizes, requested: "large" });
    expect(tooBig._tag).toBe("refused");
    expect(tooBig._tag === "refused" && tooBig.refusal.message).toContain("small or default");
    expect(resolveSubSandboxSize({ config: config(), sizes, requested: "huge" })._tag).toBe(
      "refused",
    );
  });

  it("keeps a template's size", () => {
    const templated = config({ size: "default", template: "tpl-node" });
    expect(resolveSubSandboxSize({ config: templated, sizes, requested: undefined })).toEqual({
      _tag: "size",
      size: "default",
    });
    const refused = resolveSubSandboxSize({ config: templated, sizes, requested: "large" });
    expect(refused._tag === "refused" && refused.refusal.message).toContain("template tpl-node");
  });
});

describe("resolveSubSandboxConfig", () => {
  const a = config();
  const b = config({ id: "config-b", label: "Daytona", provider: "daytona" });

  it("uses the parent's own sandbox config when the parent is a sandbox chat", () => {
    const resolved = resolveSubSandboxConfig({
      parentThreadId: parent,
      projectId,
      repositoryKey: null,
      records: [record({ threadId: parent, configId: "config-b" })],
      configs: [a, b],
    });
    expect(resolved).toEqual({ _tag: "config", config: b });
  });

  it("uses the config this project's sandbox chats last used", () => {
    const resolved = resolveSubSandboxConfig({
      parentThreadId: parent,
      projectId,
      repositoryKey: "acme/app",
      records: [
        record({ threadId: other, configId: "config-a", hostProjectId: projectId }),
        record({
          threadId: ThreadId.make("thread:newer"),
          configId: "config-b",
          repository: "Acme/App",
          createdAt: "2026-11-05T00:00:00.000Z",
        }),
      ],
      configs: [a, b],
    });
    expect(resolved).toEqual({ _tag: "config", config: b });
  });

  it("falls back to the only config, and refuses when there is no choice to make", () => {
    expect(
      resolveSubSandboxConfig({
        parentThreadId: parent,
        projectId,
        repositoryKey: null,
        records: [],
        configs: [a],
      }),
    ).toEqual({ _tag: "config", config: a });
    const none = resolveSubSandboxConfig({
      parentThreadId: parent,
      projectId,
      repositoryKey: null,
      records: [],
      configs: [],
    });
    expect(none._tag === "refused" && none.refusal.message).toContain("no sandbox config");
    const ambiguous = resolveSubSandboxConfig({
      parentThreadId: parent,
      projectId,
      repositoryKey: null,
      records: [],
      configs: [a, b],
    });
    expect(ambiguous._tag === "refused" && ambiguous.refusal.message).toContain(
      "No sandbox config is chosen for this project",
    );
  });
});
