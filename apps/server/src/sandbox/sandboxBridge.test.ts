import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  isSandboxHostProjectRoot,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  type SandboxRecord,
  ThreadId,
} from "@t3tools/contracts";
import { SANDBOX_BRIDGE_SECRETS_DIR_ENV } from "@t3tools/sandbox-bridge/link";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { WorkspaceRootNotExistsError } from "../workspace/WorkspacePaths.ts";
import * as SandboxBridge from "./sandboxBridge.ts";
import * as SandboxProvisioner from "./SandboxProvisioner.ts";

const threadId = ThreadId.make("thread-on-sandbox");
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

interface Harness {
  readonly records: Array<SandboxRecord>;
  readonly linked: Array<{ readonly threadId: ThreadId; readonly hostProjectId: ProjectId }>;
  readonly resumed: Array<string>;
  readonly projects: Map<string, { readonly id: ProjectId; readonly workspaceRoot: string }>;
  readonly events: Queue.Queue<OrchestrationV2DomainEvent>;
  readonly resumes: Queue.Queue<string>;
}

const makeHarness = Effect.gen(function* () {
  const harness: Harness = {
    records: [],
    linked: [],
    resumed: [],
    projects: new Map(),
    events: yield* Queue.unbounded<OrchestrationV2DomainEvent>(),
    resumes: yield* Queue.unbounded<string>(),
  };
  const provisionerService: Partial<SandboxProvisioner.SandboxProvisioner["Service"]> = {
    list: Effect.sync(() => ({ sandboxes: harness.records, orphans: [] })),
    linkBridge: (input) =>
      Effect.sync(() => {
        harness.linked.push(input);
        return record({ hostProjectId: input.hostProjectId });
      }),
    resume: (input) =>
      Effect.sync(() => {
        harness.resumed.push(input.instanceId);
        return { sandbox: record(), httpBaseUrl: "https://sandbox.example" };
      }).pipe(Effect.tap(() => Queue.offer(harness.resumes, input.instanceId))),
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
  } as unknown as Orchestrator.OrchestratorV2["Service"]);
  const layer = SandboxBridge.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
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
    | Path.Path
  >,
) =>
  Effect.gen(function* () {
    const { harness, layer } = yield* makeHarness;
    return yield* body(harness).pipe(Effect.provide(layer));
  }).pipe(
    Effect.provideService(HostProcess.ExecutablePath, "/usr/local/bin/node"),
    Effect.provideService(HostProcess.Arguments, ["/usr/local/bin/node", "/srv/t3/bin.mjs"]),
    Effect.provideService(HostProcess.IsExecutable, false),
  );

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
});
