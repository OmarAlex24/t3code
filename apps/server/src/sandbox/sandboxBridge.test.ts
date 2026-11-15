import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  isSandboxHostProjectRoot,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  MessageId,
  type SandboxEnvironmentConfig,
  type SandboxLaunchInput,
  type SandboxLaunchMessage,
  SandboxProviderError,
  type SandboxRecord,
  ThreadId,
} from "@t3tools/contracts";
import {
  bridgeLaunchSecretName,
  bridgeResumeFailureSecretName,
  SANDBOX_BRIDGE_ATTACHMENTS_DIR_ENV,
  SANDBOX_BRIDGE_SECRETS_DIR_ENV,
  SANDBOX_BRIDGE_TRACE_FILE_ENV,
  SandboxBridgeResumeFailureJson,
} from "@t3tools/sandbox-bridge/link";
import type { SandboxSession } from "@t3tools/sandbox-bridge";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { WorkspaceRootNotExistsError } from "../workspace/WorkspacePaths.ts";
import * as SandboxBridge from "./sandboxBridge.ts";
import * as SandboxProvisioner from "./SandboxProvisioner.ts";
import type { SandboxLaunchLifecycle } from "./sandboxLaunches.ts";

const threadId = ThreadId.make("thread-on-sandbox");
const decodeResumeFailure = Schema.decodeEffect(SandboxBridgeResumeFailureJson);
const instanceId = ProviderInstanceId.make(SANDBOX_BRIDGE_INSTANCE_ID);

const record = (overrides: Partial<SandboxRecord> = {}): SandboxRecord =>
  ({
    instanceId: "sandbox-1",
    environmentId: "environment-sandbox-1",
    provider: "boat",
    sandboxId: "bx_1",
    label: "hello on Boat",
    state: "running",
    threadId,
    repository: "octo/hello",
    sandboxProjectId: "project-remote",
    ...overrides,
  }) as SandboxRecord;

const boatConfig = {
  id: "config-1",
  provider: "boat",
  label: "Boat small",
} as SandboxEnvironmentConfig;

const launchMessage = {
  messageId: MessageId.make("message-1"),
  text: "Fix the flaky test",
  attachments: [],
  title: "Fix the flaky test",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
} as unknown as SandboxLaunchMessage;

const launchInput: SandboxLaunchInput = {
  configId: "config-1",
  threadId,
  project: {
    id: ProjectId.make("project-elsewhere"),
    title: "hello",
    remoteUrl: "https://github.com/octo/hello.git",
  },
  message: launchMessage,
};

// The orchestrator's part, as far as the bridge reads it back: runs a launch's message makes.
const applyCommand = (harness: Harness, command: Record<string, unknown>) => {
  harness.commands.push(command);
  const run = harness.hostRuns.find((candidate) => candidate.id === command.runId);
  switch (command.type) {
    case "thread.create":
      harness.hostThreadExists = true;
      return;
    case "message.dispatch": {
      const modelSelection = command.modelSelection as HostRun["modelSelection"];
      harness.hostRuns.push({
        id: `run-${String(command.messageId)}`,
        status:
          (command.dispatchMode as { readonly type: string }).type === "defer_start"
            ? "preparing"
            : "starting",
        userMessageId: String(command.messageId),
        providerInstanceId: modelSelection?.instanceId ?? SANDBOX_BRIDGE_INSTANCE_ID,
        ordinal: harness.hostRuns.length + 1,
        ...(modelSelection === undefined ? {} : { modelSelection }),
      });
      return;
    }
    case "prepared-run.release":
      if (run !== undefined) run.status = "starting";
      return;
    case "prepared-run.fail":
      if (run !== undefined) run.status = "failed";
      return;
    case "prepared-run.retry":
      if (run !== undefined) run.status = "preparing";
      return;
  }
};

interface Harness {
  readonly records: Array<SandboxRecord>;
  readonly linked: Array<{ readonly threadId: ThreadId; readonly hostProjectId: ProjectId }>;
  readonly resumed: Array<string>;
  readonly projects: Map<string, { readonly id: ProjectId; readonly workspaceRoot: string }>;
  readonly events: Queue.Queue<OrchestrationV2DomainEvent>;
  readonly resumes: Queue.Queue<string>;
  readonly modeChanges: Queue.Queue<{ readonly threadId: ThreadId; readonly runtimeMode: string }>;
  readonly removals: Queue.Queue<SandboxRecord>;
  readonly dispatched: Queue.Queue<{
    readonly type: string;
    readonly threadId: string;
    readonly runId?: string;
  }>;
  // The host thread as the orchestrator would read it.
  hostThread: {
    readonly instanceId: string;
    readonly settledAt: string | null;
    readonly runtimeMode?: string;
  };
  hostRuns: Array<HostRun>;
  /** Set to make the next resumes fail with this reason. */
  resumeFails?: string | undefined;
  /** Sandboxes the provider reports stopped, whatever their records say. */
  readonly providerStopped: Set<string>;
  /** The name of every secret the bridge writes, once written. */
  readonly secretWrites: Queue.Queue<string>;
  /** Secrets the store holds before the bridge starts, as after a restart. */
  readonly presetSecrets: Map<string, string>;
  /** Every command the bridge dispatched, whole. */
  readonly commands: Array<Record<string, unknown>>;
  /** Whether the host already has the thread. */
  hostThreadExists: boolean;
  shells: Array<{ readonly id: ThreadId; readonly mayBeLive: boolean }>;
  configs: Array<SandboxEnvironmentConfig>;
  readonly lifecycle: Queue.Queue<SandboxLaunchLifecycle>;
  readonly launched: Array<{ readonly input: SandboxLaunchInput; readonly hostProjectId?: string }>;
  readonly launchingThreads: Set<string>;
  readonly lost: Array<string>;
  /** Whether the provisioner still holds a launch to retry. */
  retryFound: boolean;
  piReady: boolean;
  /** Each time the bridge asks whether Pi is ready on the sandbox. */
  readonly piChecks: Queue.Queue<void>;
}

interface HostRun {
  readonly id: string;
  status: string;
  readonly userMessageId?: string;
  readonly providerInstanceId?: string;
  readonly ordinal?: number;
  readonly modelSelection?: { readonly instanceId: string; readonly model: string };
}

const makeHarness = Effect.gen(function* () {
  const harness: Harness = {
    records: [],
    linked: [],
    resumed: [],
    projects: new Map(),
    events: yield* Queue.unbounded<OrchestrationV2DomainEvent>(),
    resumes: yield* Queue.unbounded<string>(),
    providerStopped: new Set(),
    modeChanges: yield* Queue.unbounded<{
      readonly threadId: ThreadId;
      readonly runtimeMode: string;
    }>(),
    removals: yield* Queue.unbounded<SandboxRecord>(),
    dispatched: yield* Queue.unbounded<{
      readonly type: string;
      readonly threadId: string;
      readonly runId?: string;
    }>(),
    hostThread: { instanceId: SANDBOX_BRIDGE_INSTANCE_ID, settledAt: null },
    hostRuns: [],
    secretWrites: yield* Queue.unbounded<string>(),
    presetSecrets: new Map(),
    commands: [],
    hostThreadExists: false,
    shells: [],
    configs: [boatConfig],
    lifecycle: yield* Queue.unbounded<SandboxLaunchLifecycle>(),
    launched: [],
    launchingThreads: new Set(),
    lost: [],
    retryFound: true,
    piReady: true,
    piChecks: yield* Queue.unbounded<void>(),
  };
  const provisionerService: Partial<SandboxProvisioner.SandboxProvisioner["Service"]> = {
    list: Effect.sync(() => ({ sandboxes: harness.records, orphans: [] })),
    linkBridge: (input) =>
      Effect.sync(() => {
        harness.linked.push(input);
        return record({ hostProjectId: input.hostProjectId });
      }),
    removed: Stream.fromQueue(harness.removals),
    refreshState: (onInstance) =>
      Effect.sync(() =>
        harness.providerStopped.has(onInstance)
          ? "stopped"
          : (harness.records.find((candidate) => candidate.instanceId === onInstance)?.state ??
            "deleted"),
      ),
    resume: (input) =>
      Effect.suspend(() => {
        harness.resumed.push(input.instanceId);
        const reason = harness.resumeFails;
        return reason === undefined
          ? Effect.succeed({ sandbox: record(), httpBaseUrl: "https://sandbox.example" })
          : Effect.fail(
              new SandboxProviderError({ provider: "boat", stage: "start", detail: reason }),
            );
      }).pipe(Effect.tap(() => Queue.offer(harness.resumes, input.instanceId))),
    configs: Effect.sync(() => ({ configs: harness.configs })),
    launch: (input, options) =>
      Effect.sync(() => {
        harness.launched.push({
          input,
          ...(options?.hostProjectId === undefined ? {} : { hostProjectId: options.hostProjectId }),
        });
        harness.launchingThreads.add(input.threadId);
        return { instanceId: "sandbox-1" };
      }),
    launching: (onThread) => Effect.sync(() => harness.launchingThreads.has(onThread)),
    launchLifecycle: Stream.fromQueue(harness.lifecycle),
    markLaunchLost: (input) => Effect.sync(() => void harness.lost.push(input.threadId)),
    retryLaunch: () => Effect.sync(() => harness.retryFound),
  };
  const provisioner = Layer.succeed(
    SandboxProvisioner.SandboxProvisioner,
    provisionerService as SandboxProvisioner.SandboxProvisioner["Service"],
  );
  // Projects here carry only the fields the bridge reads.
  const projectService = (fileSystem: FileSystem.FileSystem) => ({
    bootstrap: (input: ProjectService.ProjectBootstrapInput) =>
      // Like the real service, which looks the folder up before it would create it.
      fileSystem.exists(input.workspaceRoot).pipe(
        Effect.orElseSucceed(() => false),
        Effect.flatMap((exists) =>
          !exists
            ? Effect.fail(
                new WorkspaceRootNotExistsError({
                  workspaceRoot: input.workspaceRoot,
                  normalizedWorkspaceRoot: input.workspaceRoot,
                }),
              )
            : Effect.sync(() => {
                const existing = harness.projects.get(input.workspaceRoot);
                if (existing !== undefined) {
                  return { project: existing, created: false };
                }
                const project = { id: input.projectId, workspaceRoot: input.workspaceRoot };
                harness.projects.set(input.workspaceRoot, project);
                expect(input.createWorkspaceRootIfMissing).toBe(true);
                expect(input.title).toBe("hello");
                return { project, created: true };
              }),
        ),
      ),
    update: (input: ProjectService.ProjectUpdateInput) => Effect.succeed({ id: input.projectId }),
    getById: (projectId: ProjectId) =>
      Effect.sync(() =>
        Option.fromUndefinedOr(
          [...harness.projects.values()].find((project) => project.id === projectId),
        ),
      ),
  });
  const projects = Layer.effect(
    ProjectService.ProjectService,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return projectService(fileSystem) as unknown as ProjectService.ProjectService["Service"];
    }),
  );
  const orchestrator = Layer.succeed(Orchestrator.OrchestratorV2, {
    streamDomainEvents: Stream.fromQueue(harness.events),
    getThreadRecords: () =>
      Effect.sync(() => ({
        thread: {
          modelSelection: { instanceId: harness.hostThread.instanceId, model: "sandbox" },
          runtimeMode: harness.hostThread.runtimeMode ?? "approval-required",
          interactionMode: "default",
          settledAt: harness.hostThread.settledAt,
          settledOverride: null,
          deletedAt: null,
        },
        runs: harness.hostRuns,
      })),
    getThreadShell: () => Effect.sync(() => (harness.hostThreadExists ? { id: threadId } : null)),
    listActiveShellIndex: () => Effect.sync(() => harness.shells),
    dispatch: (command: {
      readonly type: string;
      readonly threadId: string;
      readonly runId?: string;
    }) =>
      Effect.sync(() => applyCommand(harness, command)).pipe(
        Effect.andThen(
          Queue.offer(
            harness.dispatched,
            command.runId === undefined
              ? { type: command.type, threadId: command.threadId }
              : { type: command.type, threadId: command.threadId, runId: command.runId },
          ),
        ),
        Effect.as({ sequence: 1 }),
      ),
  } as unknown as Orchestrator.OrchestratorV2["Service"]);
  const remote = Layer.succeed(SandboxBridge.SandboxThreadRemote, {
    setModes: (threadId, modes) =>
      Queue.offer(harness.modeChanges, { threadId, runtimeMode: modes.runtimeMode }).pipe(
        Effect.asVoid,
      ),
    providerReady: () =>
      Queue.offer(harness.piChecks, undefined).pipe(Effect.map(() => harness.piReady)),
  });
  const layer = SandboxBridge.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        remote,
        provisioner,
        projects,
        orchestrator,
        ServerSettings.layerTest({
          projectSettingsOverrides: {
            [ProjectId.make("project-host")]: { defaultRuntimeMode: "full-access" },
          },
        }),
      ),
    ),
    // The real store, telling the test when the bridge has written to it.
    Layer.provideMerge(
      Layer.effect(
        ServerSecretStore.ServerSecretStore,
        Effect.gen(function* () {
          const store = yield* ServerSecretStore.make;
          return {
            ...store,
            get: (name: string) => {
              const preset = harness.presetSecrets.get(name);
              return preset === undefined
                ? store.get(name)
                : Effect.succeedSome(new TextEncoder().encode(preset));
            },
            remove: (name: string) =>
              Effect.sync(() => harness.presetSecrets.delete(name)).pipe(
                Effect.andThen(store.remove(name)),
              ),
            set: (name: string, value: Uint8Array) =>
              store
                .set(name, value)
                .pipe(Effect.andThen(Queue.offer(harness.secretWrites, name)), Effect.asVoid),
          };
        }),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix: "t3-sandbox-bridge-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return { harness, layer };
});

const withHarness = <A, E>(
  body: (
    harness: Harness,
  ) => Effect.Effect<
    A,
    E,
    | SandboxBridge.SandboxBridge
    | ServerSettings.ServerSettingsService
    | ServerConfig.ServerConfig
    | ServerSecretStore.ServerSecretStore
    | Path.Path
  >,
  /** Runs before the bridge starts, to set up what a restarted host finds. */
  before?: (harness: Harness) => void,
) =>
  Effect.gen(function* () {
    const { harness, layer } = yield* makeHarness;
    before?.(harness);
    return yield* body(harness).pipe(Effect.provide(layer));
  }).pipe(
    Effect.provideService(HostProcess.ExecutablePath, "/usr/local/bin/node"),
    Effect.provideService(HostProcess.Arguments, ["/usr/local/bin/node", "/srv/t3/bin.mjs"]),
    Effect.provideService(HostProcess.IsExecutable, false),
  );

/** The next dispatch of `type`, skipping the others. */
const nextDispatch = (harness: Harness, type: string) =>
  Effect.gen(function* () {
    while (true) {
      const command = yield* Queue.take(harness.dispatched);
      if (command.type === type) return command;
    }
  });

const lastCommand = (harness: Harness, type: string) =>
  harness.commands.findLast((command) => command.type === type);

describe("SandboxBridge", () => {
  it.effect("seeds a hidden Sandboxes instance that runs this server as `sandbox-bridge`", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const seeded = (yield* settings.getSettings).providerInstances[instanceId];
        expect(seeded).toMatchObject({
          displayName: "Sandboxes",
          driver: "acpRegistry",
          enabled: false,
          config: {
            source: "local",
            commandPath: "/usr/local/bin/node",
            commandArgs: ["/srv/t3/bin.mjs", "sandbox-bridge"],
          },
        });
        expect(seeded?.environment).toContainEqual({
          name: SANDBOX_BRIDGE_SECRETS_DIR_ENV,
          value: config.secretsDir,
          sensitive: false,
        });
        expect(seeded?.environment).toContainEqual({
          name: SANDBOX_BRIDGE_ATTACHMENTS_DIR_ENV,
          value: config.attachmentsDir,
          sensitive: false,
        });
        expect(seeded?.environment).toContainEqual({
          name: SANDBOX_BRIDGE_TRACE_FILE_ENV,
          value: `${config.logsDir}/sandbox-bridge.trace.ndjson`,
          sensitive: false,
        });

        // A user's own changes survive a restart; a stale command is rewritten under them.
        yield* settings.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            ...seeded!,
            displayName: "My sandboxes",
            config: { ...(seeded!.config as object), commandPath: "/old/node" },
          },
        });
        yield* SandboxBridge.seedInstance;
        const reseeded = (yield* settings.getSettings).providerInstances[instanceId];
        expect(reseeded).toMatchObject({
          displayName: "My sandboxes",
          enabled: false,
          config: { commandPath: "/usr/local/bin/node" },
        });
        const before = yield* settings.getSettings;
        yield* SandboxBridge.seedInstance;
        expect(yield* settings.getSettings).toEqual(before);
      }),
    ),
  );

  it.effect(
    "links a thread with no host copy to a lightweight project, reused per repository",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          harness.records.push(record());
          const bridge = yield* SandboxBridge.SandboxBridge;
          const settings = yield* ServerSettings.ServerSettingsService;
          const config = yield* ServerConfig.ServerConfig;

          const first = yield* bridge.linkHostThread({ threadId });
          expect(first).toMatchObject({
            instanceId: SANDBOX_BRIDGE_INSTANCE_ID,
            lightweightProject: true,
            modelSelection: { instanceId: SANDBOX_BRIDGE_INSTANCE_ID, model: "sandbox" },
          });
          const [workspaceRoot] = [...harness.projects.keys()];
          expect(workspaceRoot).toBe(`${config.baseDir}/sandbox-projects/octo/hello`);
          expect(isSandboxHostProjectRoot(workspaceRoot!)).toBe(true);
          expect(harness.linked).toEqual([{ threadId, hostProjectId: first.hostProjectId }]);
          // Shown in that project's pickers only.
          const overrides = (yield* settings.getSettings).projectSettingsOverrides;
          expect(overrides[first.hostProjectId]?.providerInstances?.[instanceId]?.enabled).toBe(
            true,
          );

          const otherThread = ThreadId.make("thread-on-another-sandbox");
          harness.records.push(record({ instanceId: "sandbox-2", threadId: otherThread }));
          const second = yield* bridge.linkHostThread({ threadId: otherThread });
          expect(second.hostProjectId).toBe(first.hostProjectId);
          expect(harness.projects.size).toBe(1);
        }),
      ),
  );

  it.effect("links to the project's own copy on this host, keeping its other overrides", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const hostProjectId = ProjectId.make("project-host");
        harness.projects.set("/host/hello", { id: hostProjectId, workspaceRoot: "/host/hello" });
        harness.records.push(record({ hostProjectId }));
        const bridge = yield* SandboxBridge.SandboxBridge;
        const settings = yield* ServerSettings.ServerSettingsService;

        const linked = yield* bridge.linkHostThread({ threadId });
        expect(linked).toMatchObject({ hostProjectId, lightweightProject: false });
        expect(harness.projects.size).toBe(1);
        const override = (yield* settings.getSettings).projectSettingsOverrides[hostProjectId];
        expect(override?.defaultRuntimeMode).toBe("full-access");
        expect(override?.providerInstances?.[instanceId]?.enabled).toBe(true);

        const missing = yield* bridge
          .linkHostThread({ threadId: ThreadId.make("thread-without-sandbox") })
          .pipe(Effect.flip);
        expect(missing.detail).toBe("No sandbox belongs to this thread.");
        expect(missing.provider).toBeUndefined();
      }),
    ),
  );

  it.effect("moves the sandbox's thread to a mode set on its host thread", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* SandboxBridge.SandboxBridge;
        const modeSet = (onInstance: string, runtimeMode: string) =>
          ({
            type: "thread.runtime-mode-updated",
            threadId,
            payload: {
              id: threadId,
              modelSelection: { instanceId: onInstance, model: "sandbox" },
              runtimeMode,
              interactionMode: "plan",
            },
          }) as unknown as OrchestrationV2DomainEvent;
        yield* Queue.offerAll(harness.events, [
          modeSet("codex", "full-access"),
          modeSet(SANDBOX_BRIDGE_INSTANCE_ID, "auto"),
        ]);
        expect(yield* Queue.take(harness.modeChanges)).toEqual({ threadId, runtimeMode: "auto" });
      }),
    ),
  );

  it.effect("moves the sandbox to full access once the run it waited out has ended", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* SandboxBridge.SandboxBridge;
        const ended = (id: string) =>
          ({
            type: "run.updated",
            threadId,
            payload: { id, threadId, providerInstanceId: instanceId, status: "completed" },
          }) as unknown as OrchestrationV2DomainEvent;
        harness.hostThread = { ...harness.hostThread, runtimeMode: "full-access" };
        yield* Queue.offer(harness.events, ended("run-1"));
        expect(yield* Queue.take(harness.modeChanges)).toEqual({
          threadId,
          runtimeMode: "full-access",
        });
        // Supervised: nothing was held back, so the end of a run changes nothing.
        harness.hostThread = { ...harness.hostThread, runtimeMode: "approval-required" };
        yield* Queue.offerAll(harness.events, [
          ended("run-2"),
          {
            type: "thread.runtime-mode-updated",
            threadId,
            payload: {
              id: threadId,
              modelSelection: { instanceId, model: "sandbox" },
              runtimeMode: "auto",
              interactionMode: "default",
            },
          } as unknown as OrchestrationV2DomainEvent,
        ]);
        expect(yield* Queue.take(harness.modeChanges)).toEqual({ threadId, runtimeMode: "auto" });
      }),
    ),
  );

  it.effect("settles a removed sandbox's host thread and cancels what was queued for it", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        harness.hostRuns = [
          { id: "run-done", status: "completed" },
          { id: "run-queued", status: "queued" },
        ];
        yield* SandboxBridge.SandboxBridge;
        // However the sandbox went: a delete, the sweep, a launch replacing it.
        yield* Queue.offer(
          harness.removals,
          record({ hostProjectId: ProjectId.make("project-host") }),
        );
        expect(yield* Queue.take(harness.dispatched)).toEqual({
          type: "queued-run.cancel",
          threadId,
          runId: "run-queued",
        });
        expect(yield* Queue.take(harness.dispatched)).toEqual({ type: "thread.settle", threadId });
      }),
    ),
  );

  it.effect("leaves the thread alone for a sandbox the bridge never linked", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const linkedThread = ThreadId.make("thread-linked");
        yield* SandboxBridge.SandboxBridge;
        yield* Queue.offerAll(harness.removals, [
          record(),
          record({
            instanceId: "sandbox-2",
            threadId: linkedThread,
            hostProjectId: ProjectId.make("project-host"),
          }),
        ]);
        // Removals are handled in order, so the linked one's settle comes first only if the
        // unlinked one dispatched nothing.
        expect(yield* Queue.take(harness.dispatched)).toEqual({
          type: "thread.settle",
          threadId: linkedThread,
        });
      }),
    ),
  );

  it.effect("resumes a stopped sandbox once when a turn starts on its thread", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const laterThread = ThreadId.make("thread-later");
        harness.records.push(
          record({ state: "stopped" }),
          record({ instanceId: "sandbox-2", threadId: laterThread, state: "stopped" }),
        );
        yield* SandboxBridge.SandboxBridge;
        const run = (type: string, status: string, onThread = threadId, id = "run-1") =>
          ({
            type,
            threadId: onThread,
            payload: { id, threadId: onThread, providerInstanceId: instanceId, status },
          }) as unknown as OrchestrationV2DomainEvent;
        yield* Queue.offerAll(harness.events, [
          run("run.created", "starting"),
          run("run.updated", "running"),
          { ...run("run.created", "running"), payload: { providerInstanceId: "codex" } } as never,
          // Events are handled in order, so this one's resume marks the end of the ones before.
          run("run.created", "starting", laterThread, "run-2"),
        ]);
        yield* Queue.take(harness.resumes);
        yield* Queue.take(harness.resumes);
        expect(harness.resumed).toEqual(["sandbox-1", "sandbox-2"]);
      }),
    ),
  );

  it.effect("resumes a sandbox the provider stopped before the sweep told its record", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const autoStoppedThread = ThreadId.make("thread-auto-stopped");
        harness.records.push(
          record(),
          record({ instanceId: "sandbox-2", threadId: autoStoppedThread }),
        );
        harness.providerStopped.add("sandbox-2");
        yield* SandboxBridge.SandboxBridge;
        const run = (onThread: ThreadId, id: string) =>
          ({
            type: "run.created",
            threadId: onThread,
            payload: { id, threadId: onThread, providerInstanceId: instanceId, status: "starting" },
          }) as unknown as OrchestrationV2DomainEvent;
        // Events are handled in order, so the second one's resume marks the end of the first.
        yield* Queue.offerAll(harness.events, [
          run(threadId, "run-1"),
          run(autoStoppedThread, "run-2"),
        ]);
        yield* Queue.take(harness.resumes);
        expect(harness.resumed).toEqual(["sandbox-2"]);
      }),
    ),
  );

  it.effect(
    "tells the bridge which waiting turns a failed resume ends, and retries on the next",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          harness.records.push(record({ state: "stopped" }));
          harness.resumeFails = "Boat refused to start bx_1.";
          harness.hostRuns = [
            { id: "run-1", status: "starting", userMessageId: "message-1" },
            // Behind the active turn: it asks for a resume of its own when it starts.
            { id: "run-2", status: "queued", userMessageId: "message-2" },
            { id: "run-0", status: "completed", userMessageId: "message-0" },
          ];
          yield* SandboxBridge.SandboxBridge;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          const name = bridgeResumeFailureSecretName(threadId);
          const readFailure = secrets.get(name).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeedNone,
                onSome: (bytes) =>
                  decodeResumeFailure(new TextDecoder().decode(bytes)).pipe(Effect.asSome),
              }),
            ),
          );
          const run = (id: string, status: string) =>
            ({
              type: "run.updated",
              threadId,
              payload: { id, threadId, providerInstanceId: instanceId, status },
            }) as unknown as OrchestrationV2DomainEvent;

          yield* Queue.offer(harness.events, run("run-1", "starting"));
          expect(yield* Queue.take(harness.secretWrites)).toBe(name);
          const failure = yield* readFailure;
          expect(Option.getOrThrow(failure)).toMatchObject({
            reason: "Boat refused to start bx_1.",
            messageIds: ["message-1"],
          });

          // The next turn tries again, and the old failure no longer speaks for it.
          harness.resumeFails = undefined;
          yield* Queue.offer(harness.events, run("run-2", "starting"));
          yield* Queue.take(harness.resumes);
          expect(yield* readFailure).toEqual(Option.none());
          expect(harness.resumed).toEqual(["sandbox-1", "sandbox-1"]);
        }),
      ),
  );
  it.effect("starts a sandbox chat as a thread here with its first message waiting", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const bridge = yield* SandboxBridge.SandboxBridge;
        const config = yield* ServerConfig.ServerConfig;
        const result = yield* bridge.launch(launchInput);

        // The thread lives in a project here, shown with the Sandboxes provider.
        const hostProjectId = result.hostThread!.projectId;
        expect(result).toEqual({
          instanceId: "sandbox-1",
          hostThread: { threadId, projectId: hostProjectId },
        });
        expect([...harness.projects.keys()]).toEqual([
          `${config.baseDir}/sandbox-projects/octo/hello`,
        ]);
        expect(lastCommand(harness, "thread.create")).toMatchObject({
          threadId,
          projectId: hostProjectId,
          title: "Fix the flaky test",
          runtimeMode: "full-access",
          // The picked model goes through the bridge, which carries it to the sandbox.
          modelSelection: { instanceId: SANDBOX_BRIDGE_INSTANCE_ID, model: "claude-opus-5-5" },
        });
        expect(lastCommand(harness, "message.dispatch")).toMatchObject({
          threadId,
          messageId: "message-1",
          text: "Fix the flaky test",
          dispatchMode: { type: "defer_start" },
        });
        // The message waits, `preparing`, while the launch runs and links the bridge.
        expect(harness.hostRuns).toMatchObject([{ id: "run-message-1", status: "preparing" }]);
        expect(harness.launched).toEqual([{ input: launchInput, hostProjectId: hostProjectId }]);
        expect(yield* Queue.take(harness.secretWrites)).toBe(bridgeLaunchSecretName(threadId));

        // A send again (a retried request) makes nothing twice.
        harness.launchingThreads.add(threadId);
        yield* bridge.launch(launchInput);
        expect(harness.commands.filter((command) => command.type === "thread.create")).toHaveLength(
          1,
        );
      }),
    ),
  );

  it.effect("sends the waiting message once its launch is done, even with no client", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const bridge = yield* SandboxBridge.SandboxBridge;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* bridge.launch(launchInput);
        expect(Option.isSome(yield* secrets.get(bridgeLaunchSecretName(threadId)))).toBe(true);

        harness.launchingThreads.delete(threadId);
        yield* Queue.offer(harness.lifecycle, {
          _tag: "finished",
          threadId,
          phase: "done",
          error: null,
        });
        expect(yield* nextDispatch(harness, "prepared-run.release")).toEqual({
          type: "prepared-run.release",
          threadId,
          runId: "run-message-1",
        });
        expect(harness.hostRuns[0]?.status).toBe("starting");
        // Nothing is left to retry once the message is out.
        expect(yield* secrets.get(bridgeLaunchSecretName(threadId))).toEqual(Option.none());
      }),
    ),
  );

  it.effect("fails the waiting message with its launch and takes it back on a retry", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const bridge = yield* SandboxBridge.SandboxBridge;
        yield* bridge.launch(launchInput);
        yield* Queue.offer(harness.lifecycle, {
          _tag: "finished",
          threadId,
          phase: "failed",
          error: "Boat refused to create the sandbox.",
        });
        yield* nextDispatch(harness, "prepared-run.fail");
        expect(lastCommand(harness, "prepared-run.fail")).toMatchObject({
          runId: "run-message-1",
          failure: {
            class: "provider_error",
            message: "The sandbox could not be set up: Boat refused to create the sandbox.",
            retryable: true,
          },
        });
        expect(harness.hostRuns[0]?.status).toBe("failed");

        // A retry on the card starts the launch again, and the message waits on it again.
        yield* bridge.retryLaunch({ threadId });
        yield* Queue.offer(harness.lifecycle, { _tag: "began", threadId });
        expect(yield* nextDispatch(harness, "prepared-run.retry")).toEqual({
          type: "prepared-run.retry",
          threadId,
          runId: "run-message-1",
        });
        expect(harness.hostRuns[0]?.status).toBe("preparing");
        yield* Queue.offer(harness.lifecycle, {
          _tag: "finished",
          threadId,
          phase: "done",
          error: null,
        });
        yield* nextDispatch(harness, "prepared-run.release");
        expect(harness.hostRuns[0]?.status).toBe("starting");
      }),
    ),
  );

  it.effect("says a cancelled launch's message was not sent", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const bridge = yield* SandboxBridge.SandboxBridge;
        yield* bridge.launch(launchInput);
        yield* Queue.offer(harness.lifecycle, {
          _tag: "finished",
          threadId,
          phase: "cancelled",
          error: null,
        });
        yield* nextDispatch(harness, "prepared-run.fail");
        expect(lastCommand(harness, "prepared-run.fail")).toMatchObject({
          failure: { message: SandboxBridge.LAUNCH_CANCELLED_MESSAGE },
        });
      }),
    ),
  );

  it.effect("starts a new sandbox from what it kept when a retry follows a restart", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const bridge = yield* SandboxBridge.SandboxBridge;
        const { hostThread } = yield* bridge.launch(launchInput);
        // The provisioner lost its launch with the restart.
        harness.retryFound = false;
        yield* bridge.retryLaunch({ threadId });
        const { message: _message, ...kept } = launchInput;
        expect(harness.launched.at(-1)).toEqual({
          input: kept,
          hostProjectId: hostThread!.projectId,
        });
      }),
    ),
  );

  it.effect("after a restart, fails a first message whose launch was lost", () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          yield* SandboxBridge.SandboxBridge;
          expect(yield* nextDispatch(harness, "prepared-run.fail")).toEqual({
            type: "prepared-run.fail",
            threadId,
            runId: "run-waiting",
          });
          expect(lastCommand(harness, "prepared-run.fail")).toMatchObject({
            failure: { message: SandboxBridge.LAUNCH_LOST_MESSAGE },
          });
          // Its card offers a new sandbox.
          expect(harness.lost).toEqual([threadId]);
        }),
      (harness) => {
        harness.shells = [{ id: threadId, mayBeLive: true }];
        harness.hostRuns = [
          {
            id: "run-waiting",
            status: "preparing",
            providerInstanceId: SANDBOX_BRIDGE_INSTANCE_ID,
            ordinal: 1,
            modelSelection: { instanceId: SANDBOX_BRIDGE_INSTANCE_ID, model: "sandbox" },
          },
        ];
        const { message: _message, ...kept } = launchInput;
        harness.presetSecrets.set(
          bridgeLaunchSecretName(threadId),
          JSON.stringify({ input: kept, hostProjectId: "project-host" }),
        );
      },
    ),
  );

  it.effect("after a restart, sends a first message whose sandbox was already linked", () =>
    withHarness(
      (harness) =>
        Effect.gen(function* () {
          yield* SandboxBridge.SandboxBridge;
          expect(yield* nextDispatch(harness, "prepared-run.release")).toEqual({
            type: "prepared-run.release",
            threadId,
            runId: "run-waiting",
          });
          expect(harness.lost).toEqual([]);
        }),
      (harness) => {
        harness.shells = [{ id: threadId, mayBeLive: true }];
        harness.records.push(
          record({
            hostProjectId: ProjectId.make("project-host"),
            bridge: {
              sessionId: "bridge-session-1",
              secret: "sandbox-bridge-x",
              expiresAt: "2027-01-01T00:00:00.000Z",
            },
          }),
        );
        harness.hostRuns = [
          {
            id: "run-waiting",
            status: "preparing",
            providerInstanceId: SANDBOX_BRIDGE_INSTANCE_ID,
            ordinal: 1,
            modelSelection: { instanceId: SANDBOX_BRIDGE_INSTANCE_ID, model: "sandbox" },
          },
        ];
      },
    ),
  );

  it.effect("waits a while for Pi on a config that starts chats there, then sends anyway", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        harness.configs = [{ ...boatConfig, pi: { startModel: "wafer/GLM-5.3" } }];
        harness.piReady = false;
        const bridge = yield* SandboxBridge.SandboxBridge;
        yield* bridge.launch(launchInput);
        // The first message is for Pi with the config's model, whatever the composer had.
        expect(lastCommand(harness, "message.dispatch")).toMatchObject({
          modelSelection: { instanceId: SANDBOX_BRIDGE_INSTANCE_ID, model: "hub/wafer/GLM-5.3" },
        });
        yield* Queue.offer(harness.lifecycle, {
          _tag: "finished",
          threadId,
          phase: "done",
          error: null,
        });
        yield* Queue.take(harness.piChecks);
        yield* TestClock.adjust("30 seconds");
        expect(lastCommand(harness, "prepared-run.release")).toBeUndefined();
        yield* TestClock.adjust("31 seconds");
        yield* nextDispatch(harness, "prepared-run.release");
      }),
    ),
  );
});

describe("SandboxThreadRemote", () => {
  it.effect("reaches the sandbox for new modes, or while a move waits on its run", () =>
    Effect.gen(function* () {
      const link = {
        threadId,
        instanceId: "sandbox-1",
        sandboxId: "bx_1",
        label: "hello on Boat",
        httpBaseUrl: "https://sandbox.example",
        sandboxProjectId: "project-remote",
        token: "bearer",
      };
      const sandbox = { runtimeMode: "approval-required", runStatus: "running" };
      const dispatched: Array<string> = [];
      let connects = 0;
      const connect = () =>
        Effect.sync(() => {
          connects++;
          return {
            projection: () =>
              Effect.succeedSome({
                thread: {
                  id: threadId,
                  runtimeMode: sandbox.runtimeMode,
                  interactionMode: "default",
                },
                runs: [{ id: "run-1", status: sandbox.runStatus }],
                runtimeRequests: [],
              }),
            dispatch: (command: { readonly type: string }) =>
              Effect.sync(() => void dispatched.push(command.type)),
          } as unknown as SandboxSession;
        });
      const remote = yield* SandboxBridge.SandboxThreadRemote.pipe(
        Effect.provide(
          SandboxBridge.layerThreadRemoteWith(connect).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ServerSecretStore.ServerSecretStore, {
                  get: () => Effect.succeedSome(new TextEncoder().encode(JSON.stringify(link))),
                } as unknown as ServerSecretStore.ServerSecretStore["Service"]),
                NodeCrypto.layer,
              ),
            ),
          ),
        ),
      );
      const fullAccess = { runtimeMode: "full-access", interactionMode: "default" } as const;
      // The sandbox's run is working, so the move waits; the end of a host run checks again.
      yield* remote.setModes(threadId, fullAccess);
      yield* remote.setModes(threadId, fullAccess);
      expect({ connects, dispatched }).toEqual({ connects: 2, dispatched: [] });
      sandbox.runStatus = "completed";
      yield* remote.setModes(threadId, fullAccess);
      expect({ connects, dispatched }).toEqual({
        connects: 3,
        dispatched: ["thread.runtime-mode.set"],
      });
      // Nothing waits any more, and the modes are the ones it was put in.
      yield* remote.setModes(threadId, fullAccess);
      expect(connects).toBe(3);
    }),
  );
});
