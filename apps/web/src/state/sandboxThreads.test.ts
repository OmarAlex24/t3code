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
  bridgedSandboxCopies,
  bridgedSandboxCopyHost,
  findThreadSandbox,
  isBridgedSandboxCopy,
  sandboxBridgeReady,
  sandboxCopyTitleUpdates,
  withBridgedSandboxCopies,
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

describe("isBridgedSandboxCopy", () => {
  const copyRef = { environmentId: SANDBOX, threadId };
  const hostThread = { environmentId: HOST, id: threadId };
  const copyThread = { environmentId: SANDBOX, id: threadId };

  it("is the sandbox's own thread once the host keeps the conversation", () => {
    expect(isBridgedSandboxCopy(record(), copyRef, [hostThread, copyThread], HOST)).toBe(true);
  });

  it("is never the host thread itself", () => {
    const hostRef = { environmentId: HOST, threadId };
    expect(isBridgedSandboxCopy(record(), hostRef, [hostThread, copyThread], HOST)).toBe(false);
  });

  it("keeps a thread from before the bridge, which has no host thread, as the only one", () => {
    expect(isBridgedSandboxCopy(record(), copyRef, [copyThread], HOST)).toBe(false);
  });

  it("ignores another thread on the sandbox, and a sandbox the host does not know yet", () => {
    const other = { environmentId: SANDBOX, threadId: ThreadId.make("thread-2") };
    expect(isBridgedSandboxCopy(record(), other, [hostThread], HOST)).toBe(false);
    expect(isBridgedSandboxCopy(record(), copyRef, [hostThread], null)).toBe(false);
    expect(isBridgedSandboxCopy(record({ environmentId: null }), copyRef, [hostThread], HOST)).toBe(
      false,
    );
  });

  it("never hides the only thread when the sandbox answers as the host's own environment", () => {
    const hostRef = { environmentId: HOST, threadId };
    expect(isBridgedSandboxCopy(record({ environmentId: HOST }), hostRef, [hostThread], HOST)).toBe(
      false,
    );
  });
});

describe("bridgedSandboxCopies", () => {
  it("maps each bridged copy to its host thread, and leaves older sandbox threads out", () => {
    const legacyThreadId = ThreadId.make("thread-legacy");
    const legacySandbox = EnvironmentId.make("sandbox-legacy");
    const copies = bridgedSandboxCopies(
      [
        record(),
        record({
          instanceId: "instance-2",
          environmentId: legacySandbox,
          threadId: legacyThreadId,
        }),
      ],
      [
        { environmentId: HOST, id: threadId },
        { environmentId: SANDBOX, id: threadId },
        { environmentId: legacySandbox, id: legacyThreadId },
      ],
      HOST,
    );
    expect([...copies]).toEqual([
      [threadKey({ environmentId: SANDBOX, threadId }), { environmentId: HOST, threadId }],
    ]);
  });
});

describe("withBridgedSandboxCopies and bridgedSandboxCopyHost", () => {
  const copyRef = { environmentId: SANDBOX, threadId };
  const hostRef = { environmentId: HOST, threadId };
  const copies = new Map([[threadKey(copyRef), hostRef]]);

  it("leaves copies out of lists as delegated tasks are, keeping the set when there are none", () => {
    const delegated = new Set(["task"]);
    expect(withBridgedSandboxCopies(delegated, new Map())).toBe(delegated);
    expect([...withBridgedSandboxCopies(delegated, copies)]).toEqual(["task", threadKey(copyRef)]);
  });

  it("finds the host thread of a copy only", () => {
    expect(bridgedSandboxCopyHost(copies, copyRef)).toEqual(hostRef);
    expect(bridgedSandboxCopyHost(copies, hostRef)).toBeUndefined();
  });
});

describe("sandboxCopyTitleUpdates", () => {
  const copyRef = { environmentId: SANDBOX, threadId };
  const hostRef = { environmentId: HOST, threadId };
  const copies = new Map([[threadKey(copyRef), hostRef]]);
  const host = { environmentId: HOST, id: threadId, title: "Greeting from boat.dev" };

  it("gives the copy the host thread's title", () => {
    const copy = { environmentId: SANDBOX, id: threadId, title: "say high from boat.dev:)" };
    expect(sandboxCopyTitleUpdates(copies, [host, copy])).toEqual([
      { copy: copyRef, title: "Greeting from boat.dev", copyTitle: "say high from boat.dev:)" },
    ]);
  });

  it("does nothing once they match, or while either thread is not loaded", () => {
    const copy = { environmentId: SANDBOX, id: threadId, title: "Greeting from boat.dev" };
    expect(sandboxCopyTitleUpdates(copies, [host, copy])).toEqual([]);
    expect(sandboxCopyTitleUpdates(copies, [host])).toEqual([]);
    expect(sandboxCopyTitleUpdates(copies, [{ ...copy, title: "other" }])).toEqual([]);
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
