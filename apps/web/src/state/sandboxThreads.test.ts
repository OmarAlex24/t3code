import {
  EnvironmentId,
  ProjectId,
  type SandboxRecord,
  type ServerProvider,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { describe, expect, it } from "vite-plus/test";

import {
  providerInstanceEntriesFor,
  resolveProjectDefaultProviderModelSelection,
  resolveSelectableProviderInstanceEntry,
} from "../providerInstances";

import {
  findThreadSandbox,
  sandboxBridgeReady,
  sandboxHostMirrors,
  sandboxMirrorOf,
  sandboxMirrorTarget,
  sandboxMirrorTitleUpdates,
  withSandboxHostMirrors,
} from "./sandboxThreads";

const HOST = EnvironmentId.make("host");
const SANDBOX = EnvironmentId.make("sandbox");
const threadId = ThreadId.make("thread-1");

const record = (fields: Partial<SandboxRecord> = {}): SandboxRecord =>
  ({
    instanceId: "instance-1",
    environmentId: SANDBOX,
    threadId,
    state: "running",
    sandboxId: "bx_46wrabcd",
    ...fields,
  }) as SandboxRecord;

describe("findThreadSandbox", () => {
  it("matches the sandbox's own thread", () => {
    expect(findThreadSandbox([record()], { environmentId: SANDBOX, threadId }, HOST)).toBeDefined();
  });

  it("matches the host thread of a linked sandbox by its id", () => {
    const linked = record({ hostProjectId: ProjectId.make("project-host") });
    expect(findThreadSandbox([linked], { environmentId: HOST, threadId }, HOST)).toBe(linked);
  });

  it("ignores the host's thread id when the sandbox was never linked or is still starting", () => {
    const ref = { environmentId: HOST, threadId };
    expect(findThreadSandbox([record()], ref, HOST)).toBeUndefined();
    const starting = record({ hostProjectId: ProjectId.make("p"), state: "provisioning" });
    expect(findThreadSandbox([starting], ref, HOST)).toBeUndefined();
  });

  it("never matches a thread on a third environment", () => {
    const linked = record({ hostProjectId: ProjectId.make("project-host") });
    const other = { environmentId: EnvironmentId.make("other"), threadId };
    expect(findThreadSandbox([linked], other, HOST)).toBeUndefined();
  });
});

describe("sandboxHostMirrors", () => {
  const linked = (fields: Partial<SandboxRecord> = {}) =>
    record({ hostProjectId: ProjectId.make("project-host"), ...fields });
  const hostThread = { environmentId: HOST, id: threadId };
  const sandboxThread = { environmentId: SANDBOX, id: threadId };
  const mirrorKey = threadKey({ environmentId: HOST, threadId });

  it("hides the host's mirror behind the sandbox's own thread", () => {
    expect([...sandboxHostMirrors([linked()], [hostThread, sandboxThread], HOST)]).toEqual([
      [mirrorKey, { environmentId: SANDBOX, threadId }],
    ]);
  });

  it("keeps the mirror when it is the only copy listed, or the sandbox is gone", () => {
    expect(sandboxHostMirrors([linked()], [hostThread], HOST).size).toBe(0);
    expect(
      sandboxHostMirrors([linked({ state: "deleted" })], [hostThread, sandboxThread], HOST).size,
    ).toBe(0);
  });

  it("ignores a sandbox that was never linked, or that answers as the host itself", () => {
    expect(sandboxHostMirrors([record()], [hostThread, sandboxThread], HOST).size).toBe(0);
    expect(sandboxHostMirrors([linked({ environmentId: HOST })], [hostThread], HOST).size).toBe(0);
    expect(sandboxHostMirrors([linked()], [hostThread, sandboxThread], null).size).toBe(0);
  });
});

describe("withSandboxHostMirrors and sandboxMirrorTarget", () => {
  const sandboxRef = { environmentId: SANDBOX, threadId };
  const hostRef = { environmentId: HOST, threadId };
  const mirrors = new Map([[threadKey(hostRef), sandboxRef]]);

  it("leaves mirrors out of lists as delegated tasks are, keeping the set when there are none", () => {
    const delegated = new Set(["task"]);
    expect(withSandboxHostMirrors(delegated, new Map())).toBe(delegated);
    expect([...withSandboxHostMirrors(delegated, mirrors)]).toEqual(["task", threadKey(hostRef)]);
  });

  it("finds the sandbox thread of a mirror only", () => {
    expect(sandboxMirrorTarget(mirrors, hostRef)).toEqual(sandboxRef);
    expect(sandboxMirrorTarget(mirrors, sandboxRef)).toBeUndefined();
  });
});

describe("sandboxMirrorTitleUpdates", () => {
  const sandboxRef = { environmentId: SANDBOX, threadId };
  const hostRef = { environmentId: HOST, threadId };
  const mirrors = new Map([[threadKey(hostRef), sandboxRef]]);
  const sandbox = { environmentId: SANDBOX, id: threadId, title: "Greeting from boat.dev" };

  it("gives the mirror the sandbox thread's title", () => {
    const mirror = { environmentId: HOST, id: threadId, title: "say high from boat.dev:)" };
    expect(sandboxMirrorTitleUpdates(mirrors, [sandbox, mirror])).toEqual([
      { mirror: hostRef, title: "Greeting from boat.dev", mirrorTitle: "say high from boat.dev:)" },
    ]);
  });

  it("does nothing once they match, or while either thread is not loaded", () => {
    const mirror = { environmentId: HOST, id: threadId, title: "Greeting from boat.dev" };
    expect(sandboxMirrorTitleUpdates(mirrors, [sandbox, mirror])).toEqual([]);
    expect(sandboxMirrorTitleUpdates(mirrors, [sandbox])).toEqual([]);
    expect(sandboxMirrorTitleUpdates(mirrors, [{ ...mirror, title: "other" }])).toEqual([]);
  });
});

describe("sandboxMirrorOf", () => {
  it("mirrors a linked sandbox thread to the host thread with its id", () => {
    const hostProjectId = ProjectId.make("project-host");
    expect(
      sandboxMirrorOf([record({ hostProjectId })], { environmentId: SANDBOX, threadId }, HOST),
    ).toEqual({ mirror: { environmentId: HOST, threadId }, hostProjectId });
  });

  it("mirrors nothing for an unlinked sandbox, the host's own threads, or a deleted sandbox", () => {
    const ref = { environmentId: SANDBOX, threadId };
    expect(sandboxMirrorOf([record()], ref, HOST)).toBeNull();
    const linked = record({ hostProjectId: ProjectId.make("p") });
    expect(sandboxMirrorOf([linked], { environmentId: HOST, threadId }, HOST)).toBeNull();
    expect(sandboxMirrorOf([{ ...linked, state: "deleted" }], ref, HOST)).toBeNull();
  });
});

describe("sandboxBridgeReady", () => {
  const projectId = ProjectId.make("project-host");
  const provider = (fields: Partial<ServerProvider> = {}) =>
    ({
      instanceId: "sandboxes",
      driver: "acpRegistry",
      enabled: true,
      installed: true,
      status: "ready",
      models: [{ slug: "sandbox", name: "Sandbox agent" }],
      ...fields,
    }) as unknown as ServerProvider;
  const settings = (projectEnabled: boolean) =>
    ({
      providerInstances: { sandboxes: { driver: "acpRegistry", enabled: false } },
      projectSettingsOverrides: projectEnabled
        ? { [projectId]: { providerInstances: { sandboxes: { enabled: true } } } }
        : {},
    }) as unknown as ServerSettings;
  const projects = [{ environmentId: HOST, id: projectId }];

  it("is ready once the instance is probed, the project shows it, and the project is listed", () => {
    expect(
      sandboxBridgeReady({
        providers: [provider()],
        settings: settings(true),
        projects,
        environmentId: HOST,
        projectId,
        model: "sandbox",
      }),
    ).toBe(true);
  });

  it("waits for each of them", () => {
    const base = {
      providers: [provider()],
      settings: settings(true),
      projects,
      environmentId: HOST,
      projectId,
      model: "sandbox",
    };
    expect(sandboxBridgeReady({ ...base, providers: [] })).toBe(false);
    // Before the probe discovers the bridge's model the instance lists a placeholder, which the
    // composer would send with instead.
    expect(
      sandboxBridgeReady({
        ...base,
        providers: [provider({ models: [{ slug: "default", name: "Default" }] as never })],
      }),
    ).toBe(false);
    expect(sandboxBridgeReady({ ...base, providers: [provider({ status: "warning" })] })).toBe(
      false,
    );
    expect(sandboxBridgeReady({ ...base, settings: settings(false) })).toBe(false);
    expect(sandboxBridgeReady({ ...base, settings: null })).toBe(false);
    expect(sandboxBridgeReady({ ...base, projects: [] })).toBe(false);
  });
});

describe("the sandbox bridge as an internal provider instance", () => {
  const projectId = ProjectId.make("project-host");
  const provider = (instanceId: string, driver: string, slug: string) =>
    ({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      status: "ready",
      models: [{ slug, name: slug, isCustom: false, capabilities: null }],
    }) as unknown as ServerProvider;
  // The bridge listed first, as it would be if the server reported it before anything else.
  const providers = [
    provider("sandboxes", "acpRegistry", "sandbox"),
    provider("claudeAgent", "claudeAgent", "opus"),
  ];
  const settings = {
    providerInstances: { sandboxes: { driver: "acpRegistry", enabled: false } },
    projectSettingsOverrides: {
      [projectId]: { providerInstances: { sandboxes: { enabled: true } } },
    },
  } as unknown as ServerSettings;
  const entries = providerInstanceEntriesFor(providers, settings, projectId);

  it("still resolves for a thread that asks for it", () => {
    expect(resolveSelectableProviderInstanceEntry(entries, "sandboxes" as never)?.instanceId).toBe(
      "sandboxes",
    );
  });

  it("is never what a new thread in a host project falls back to", () => {
    expect(resolveSelectableProviderInstanceEntry(entries, undefined)?.instanceId).toBe(
      "claudeAgent",
    );
    expect(
      resolveProjectDefaultProviderModelSelection(providers, settings as never, projectId),
    ).toEqual({ instanceId: "claudeAgent", model: "opus" });
  });
});
