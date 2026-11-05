/**
 * The host side of the sandbox bridge: the `sandboxes` provider instance runs this server as
 * `sandbox-bridge` so any client of this host, the phone included, can drive a sandbox's thread.
 * Seeds that instance, links threads to a host project, and resumes stopped sandboxes on demand.
 */
import {
  CommandId,
  isSandboxHostProjectRoot,
  type ModelSelection,
  type ProjectId,
  ProjectId as ProjectIdSchema,
  type ProviderInstanceConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  SANDBOX_BRIDGE_MODEL,
  SANDBOX_HOST_PROJECTS_FOLDER,
  type SandboxLaunchThreadInput,
  type SandboxLinkHostThreadResult,
  SandboxProviderError,
  type SandboxRecord,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { SANDBOX_BRIDGE_SECRETS_DIR_ENV } from "@t3tools/sandbox-bridge/link";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxProvisioner from "./SandboxProvisioner.ts";

const instanceId = ProviderInstanceId.make(SANDBOX_BRIDGE_INSTANCE_ID);

const bridgeModelSelection = {
  instanceId,
  model: SANDBOX_BRIDGE_MODEL,
} as ModelSelection;

const BRIDGE_ENVIRONMENT_NAMES = new Set([SANDBOX_BRIDGE_SECRETS_DIR_ENV, "ELECTRON_RUN_AS_NODE"]);

const sameArgs = (left: unknown, right: ReadonlyArray<string>) =>
  Array.isArray(left) &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

/**
 * Upserts the `sandboxes` instance when it is missing or its command is stale (the server binary
 * or secrets directory moved). Off machine-wide on first seed, so it shows only in projects that
 * host a sandbox thread; a user's later edits, such as its name, are kept.
 */
export const seedInstance = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const self = yield* resolveSelfInvocation();
  const commandArgs = selfInvocationArgs(self, ["sandbox-bridge"]);
  const existing = (yield* settings.getSettings).providerInstances[instanceId];
  const existingConfig = existing?.config as Record<string, unknown> | undefined;
  const secretsDir = existing?.environment?.find(
    (variable) => variable.name === SANDBOX_BRIDGE_SECRETS_DIR_ENV,
  );
  if (
    existing !== undefined &&
    existing.driver === "acpRegistry" &&
    existingConfig?.source === "local" &&
    existingConfig.commandPath === self.command &&
    sameArgs(existingConfig.commandArgs, commandArgs) &&
    secretsDir?.value === config.secretsDir
  ) {
    return;
  }
  const instance: ProviderInstanceConfig = {
    displayName: "Sandboxes",
    enabled: false,
    ...existing,
    driver: ProviderDriverKind.make("acpRegistry"),
    environment: [
      ...(existing?.environment ?? []).filter(
        (variable) => !BRIDGE_ENVIRONMENT_NAMES.has(variable.name),
      ),
      // Never a credential: the bridge reads the sandbox's link from the secret store there.
      { name: SANDBOX_BRIDGE_SECRETS_DIR_ENV, value: config.secretsDir, sensitive: false },
      // Desktop runs this server on Electron's binary, which acts as Node only with this set.
      { name: "ELECTRON_RUN_AS_NODE", value: "1", sensitive: false },
    ],
    config: { ...existingConfig, source: "local", commandPath: self.command, commandArgs },
  };
  yield* settings.updateProviderInstance({ operation: "upsert", instanceId, instance });
});

export class SandboxBridge extends Context.Service<
  SandboxBridge,
  {
    /**
     * Readies a launched thread to run through the bridge: picks its host project (the project's
     * copy here, or a lightweight one per repository), shows the `sandboxes` instance there, and
     * has the provisioner keep the sandbox's bearer and record the project.
     */
    readonly linkHostThread: (
      input: SandboxLaunchThreadInput,
    ) => Effect.Effect<SandboxLinkHostThreadResult, SandboxProviderError>;
  }
>()("t3/sandbox/sandboxBridge") {}

// Statuses of a run that is about to need its sandbox.
const STARTING_RUN = new Set(["preparing", "queued", "starting", "running"]);
const ENDED_RUN = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

// Keeps a path segment a single plain folder name, whatever the remote called it.
const folderName = (segment: string) => {
  const safe = segment.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^\.+$/u, "-");
  return safe === "" ? "-" : safe;
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;

  yield* seedInstance.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not seed the sandbox bridge provider instance", cause),
    ),
  );

  const failed = (provider: SandboxRecord["provider"], detail: string, cause?: unknown) =>
    new SandboxProviderError({
      provider,
      stage: "pair",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  /** An empty folder per repository, never a checkout: it only gives the thread a home here. */
  const lightweightProject = Effect.fn("SandboxBridge.lightweightProject")(function* (
    record: SandboxRecord,
  ) {
    const [owner = "sandbox", name = record.label] = (record.repository ?? "").split("/");
    const workspaceRoot = path.join(
      config.baseDir,
      SANDBOX_HOST_PROJECTS_FOLDER,
      folderName(owner),
      folderName(name),
    );
    // Bootstrap looks the folder up before it would create it, so a first launch makes it here.
    yield* fileSystem
      .makeDirectory(workspaceRoot, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          failed(record.provider, "Could not create a folder for this sandbox thread.", cause),
        ),
      );
    const id = yield* random.uuidV4().pipe(Effect.orDie);
    const bootstrapped = yield* projects
      .bootstrap({
        commandId: CommandId.make(`sandbox-host-project:${id}`),
        projectId: ProjectIdSchema.make(id),
        title: name,
        workspaceRoot,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: bridgeModelSelection,
      })
      .pipe(
        // A project already at that folder is the one to reuse.
        Effect.catchTags({
          ProjectConflictError: (conflict) =>
            Effect.succeed({ project: { id: conflict.conflictingProjectId }, created: false }),
        }),
        Effect.mapError((cause) =>
          failed(record.provider, "Could not create a project for this sandbox thread.", cause),
        ),
      );
    if (bootstrapped.created) {
      yield* projects
        .update({
          commandId: CommandId.make(`sandbox-host-project-icon:${id}`),
          projectId: bootstrapped.project.id,
          projectIcon: { kind: "lucide", name: "cloud", color: "sky" },
        })
        .pipe(Effect.ignore);
    }
    return bootstrapped.project.id;
  });

  // The whole project entry is replaced on write, so its other overrides are carried over.
  const showInProject = Effect.fn("SandboxBridge.showInProject")(function* (projectId: ProjectId) {
    const current = (yield* settings.getSettings).projectSettingsOverrides[projectId] ?? {};
    if (current.providerInstances?.[instanceId]?.enabled === true) return;
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: {
          ...current,
          providerInstances: { ...current.providerInstances, [instanceId]: { enabled: true } },
        },
      },
    });
  });

  const linkHostThread = Effect.fn("SandboxBridge.linkHostThread")(function* (
    input: SandboxLaunchThreadInput,
  ) {
    const { sandboxes } = yield* provisioner.list;
    const record = sandboxes.find(
      (candidate) => candidate.threadId === input.threadId && candidate.state !== "deleted",
    );
    if (record === undefined) {
      return yield* failed("boat", "No sandbox belongs to this thread.");
    }
    const hostCopy =
      record.hostProjectId === undefined
        ? Option.none()
        : yield* projects.getById(record.hostProjectId).pipe(Effect.orElseSucceed(Option.none));
    const hostProjectId = Option.isSome(hostCopy)
      ? hostCopy.value.id
      : yield* lightweightProject(record);
    yield* showInProject(hostProjectId).pipe(
      Effect.mapError((cause) =>
        failed(record.provider, "Could not show the Sandboxes provider in this project.", cause),
      ),
    );
    yield* provisioner.linkBridge({ threadId: input.threadId, hostProjectId });
    return {
      instanceId,
      hostProjectId,
      lightweightProject:
        Option.isNone(hostCopy) || isSandboxHostProjectRoot(hostCopy.value.workspaceRoot),
      modelSelection: bridgeModelSelection,
    } satisfies SandboxLinkHostThreadResult;
  });

  // A turn on a stopped sandbox's thread resumes it; the bridge waits for it to answer meanwhile.
  const resumingRuns = new Set<string>();
  const resuming = new Set<string>();
  const resumeFor = Effect.fn("SandboxBridge.resumeFor")(function* (threadId: ThreadId) {
    const { sandboxes } = yield* provisioner.list;
    const stopped = sandboxes.find(
      (record) => record.threadId === threadId && record.state === "stopped",
    );
    if (stopped === undefined || resuming.has(stopped.instanceId)) return;
    resuming.add(stopped.instanceId);
    yield* provisioner
      .resume({ instanceId: stopped.instanceId })
      .pipe(Effect.ensuring(Effect.sync(() => resuming.delete(stopped.instanceId))));
  });
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
      if (event.type !== "run.created" && event.type !== "run.updated") return Effect.void;
      const run = event.payload;
      if (run.providerInstanceId !== instanceId) return Effect.void;
      if (ENDED_RUN.has(run.status)) {
        resumingRuns.delete(run.id);
        return Effect.void;
      }
      if (!STARTING_RUN.has(run.status) || resumingRuns.has(run.id)) return Effect.void;
      resumingRuns.add(run.id);
      return resumeFor(run.threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not resume a sandbox for its thread", { cause }),
        ),
        Effect.forkScoped,
        Effect.asVoid,
      );
    }),
  );

  return SandboxBridge.of({ linkHostThread });
});

export const layer = Layer.effect(SandboxBridge, make);

/** The sandbox WebSocket handlers: the provisioner's, plus linking a thread to the bridge. */
export const rpcHandlers = Effect.gen(function* () {
  const provisionerHandlers = yield* SandboxProvisioner.rpcHandlers;
  const bridge = yield* SandboxBridge;
  return {
    ...provisionerHandlers,
    [WS_METHODS.sandboxesLinkHostThread]: (input: SandboxLaunchThreadInput) =>
      bridge.linkHostThread(input),
  };
});
