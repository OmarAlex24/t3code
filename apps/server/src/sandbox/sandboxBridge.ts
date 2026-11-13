/**
 * The host side of the sandbox bridge: the `sandboxes` provider instance runs this server as
 * `sandbox-bridge` so any client of this host, the phone included, can drive a sandbox's thread.
 * Seeds that instance, links threads to a host project, and resumes stopped sandboxes on demand.
 */
import {
  CommandId,
  githubRepositoryOf,
  isSandboxHostProjectRoot,
  type ModelSelection,
  type OrchestrationV2Run,
  type ProjectId,
  ProjectId as ProjectIdSchema,
  type ProviderInteractionMode,
  type ProviderInstanceConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  type RunId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  SANDBOX_BRIDGE_MODEL,
  SANDBOX_HOST_PROJECTS_FOLDER,
  SANDBOX_PI_INSTANCE_ID,
  SandboxLaunchInput,
  type SandboxResolveSettleInput,
  type SandboxLaunchMessage,
  type SandboxLaunchResult,
  type SandboxLaunchThreadInput,
  type SandboxLinkHostThreadResult,
  type SandboxProviderKind,
  SandboxProviderError,
  type SandboxRecord,
  sandboxPiModelSlug,
  type RuntimeMode,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { connectSandbox, modeSyncCommands } from "@t3tools/sandbox-bridge";
import {
  bridgeLaunchSecretName,
  bridgeLinkSecretName,
  bridgeResumeFailureSecretName,
  SANDBOX_BRIDGE_SECRETS_DIR_ENV,
  SandboxBridgeLinkJson,
  SandboxBridgeResumeFailureJson,
} from "@t3tools/sandbox-bridge/link";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { persistChatAttachments } from "../persistChatAttachments.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxProvisioner from "./SandboxProvisioner.ts";
import * as SandboxSettle from "./SandboxSettle.ts";
import type { SandboxLaunchLifecycle } from "./sandboxLaunches.ts";

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

/** The thread with the same id on a sandbox, reached with the bridge's own link and bearer. */
export class SandboxThreadRemote extends Context.Service<
  SandboxThreadRemote,
  {
    /**
     * Puts the sandbox's thread in the host thread's modes, granting its waiting approvals under
     * full access; a thread with no link is skipped.
     */
    readonly setModes: (
      threadId: ThreadId,
      modes: {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      },
    ) => Effect.Effect<void, SandboxProviderError>;
    /** Whether the thread's sandbox lists the provider ready with the model; false unreachable. */
    readonly providerReady: (
      threadId: ThreadId,
      providerInstanceId: string,
      model: string,
    ) => Effect.Effect<boolean>;
  }
>()("t3/sandbox/sandboxBridge/SandboxThreadRemote") {}

const decodeLink = Schema.decodeEffect(SandboxBridgeLinkJson);

const layerThreadRemote = Layer.effect(
  SandboxThreadRemote,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const random = yield* SecureRandom.SecureRandom;
    // Keyed by thread with no sandbox record in hand, so these name no provider.
    const failed = (detail: string) => (cause: unknown) =>
      new SandboxProviderError({ stage: "pair", detail, cause });
    const readLink = Effect.fn("SandboxThreadRemote.readLink")(function* (threadId: ThreadId) {
      const stored = yield* secrets
        .get(bridgeLinkSecretName(threadId))
        .pipe(Effect.mapError(failed("Could not read this thread's sandbox link.")));
      if (Option.isNone(stored)) return Option.none();
      return Option.some(
        yield* decodeLink(new TextDecoder().decode(stored.value)).pipe(
          Effect.mapError(failed("This thread's sandbox link is unreadable.")),
        ),
      );
    });
    const providerReady = Effect.fn("SandboxThreadRemote.providerReady")(
      function* (threadId: ThreadId, providerInstanceId: string, model: string) {
        const link = yield* readLink(threadId);
        if (Option.isNone(link)) return false;
        const sandbox = yield* connectSandbox(link.value);
        const provider = sandbox.providers.find(
          (candidate) => candidate.instanceId === providerInstanceId,
        );
        return (
          provider !== undefined &&
          provider.enabled &&
          provider.status === "ready" &&
          provider.models.some((candidate) => candidate.slug === model)
        );
      },
      Effect.scoped,
      Effect.provide(FetchHttpClient.layer),
      Effect.orElseSucceed(() => false),
    );
    const setModes = Effect.fn("SandboxThreadRemote.setModes")(function* (
      threadId: ThreadId,
      modes: {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      },
    ) {
      const stored = yield* readLink(threadId);
      if (Option.isNone(stored)) return;
      const link = stored;
      yield* Effect.gen(function* () {
        const sandbox = yield* connectSandbox(link.value);
        const projection = yield* sandbox.projection(threadId);
        if (Option.isNone(projection)) return;
        const id = yield* random.uuidV4().pipe(Effect.orDie);
        let count = 0;
        const commands = modeSyncCommands(projection.value, modes, () =>
          CommandId.make(`sandbox-mode-sync:${id}:${count++}`),
        );
        for (const command of commands) {
          // An approval answered meanwhile is refused; the rest still apply.
          yield* sandbox
            .dispatch(command)
            .pipe(command.type === "runtime-request.respond" ? Effect.ignore : Effect.asVoid);
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError(failed("Could not reach the sandbox to change its modes.")),
      );
    });
    return SandboxThreadRemote.of({ setModes, providerReady });
  }),
);

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
    /**
     * Starts a sandbox chat as a thread here: its first message waits in it, `preparing`, while the
     * sandbox launches, and goes out through the bridge once the launch links it. A launch with no
     * message only provisions.
     */
    readonly launch: (
      input: SandboxLaunchInput,
    ) => Effect.Effect<SandboxLaunchResult, SandboxProviderError>;
    /** Retries a thread's failed launch, from what this server kept of it after a restart too. */
    readonly retryLaunch: (
      input: SandboxLaunchThreadInput,
    ) => Effect.Effect<void, SandboxProviderError>;
  }
>()("t3/sandbox/sandboxBridge") {}

// Statuses of a run that is about to need its sandbox.
const STARTING_RUN = new Set(["preparing", "queued", "starting", "running"]);
const ENDED_RUN = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
// Statuses of a run whose turn is at the bridge, waiting for the sandbox to answer. A queued run
// is not there yet: it starts a resume of its own when its turn comes.
const AT_BRIDGE_RUN = new Set(["starting", "running"]);

const encodeResumeFailure = Schema.encodeEffect(SandboxBridgeResumeFailureJson);

/** What the host keeps of a launch so a retry after a restart can start it again. */
const PendingLaunch = Schema.Struct({ input: SandboxLaunchInput, hostProjectId: ProjectIdSchema });
const PendingLaunchJson = Schema.fromJsonString(PendingLaunch);
const encodePendingLaunch = Schema.encodeEffect(PendingLaunchJson);
const decodePendingLaunch = Schema.decodeEffect(PendingLaunchJson);

// How long a launch whose config starts chats on Pi waits for the sandbox to list Pi's model.
const PI_READY_WAIT = "60 seconds";
const PI_READY_SPACING = "3 seconds";

export const LAUNCH_CANCELLED_MESSAGE =
  "This sandbox's setup was cancelled, so the message wasn't sent.";
export const LAUNCH_LOST_MESSAGE =
  "T3 Code stopped before this sandbox finished starting. Retry on its card to start a new one.";
const launchFailedMessage = (error: string | null) =>
  `The sandbox could not be set up${error === null ? "." : `: ${error}`}`;

const piInstanceId = ProviderInstanceId.make(SANDBOX_PI_INSTANCE_ID);

/** The chat's model as the bridge carries it: the picked model's slug and options, on the bridge. */
const bridgeSelectionFor = (
  selection: ModelSelection | undefined,
  piStartModel: string | undefined,
): ModelSelection =>
  piStartModel !== undefined
    ? ({ instanceId, model: sandboxPiModelSlug(piStartModel) } as ModelSelection)
    : selection === undefined
      ? bridgeModelSelection
      : selection.instanceId === instanceId
        ? selection
        : ({
            instanceId,
            model: selection.model || SANDBOX_BRIDGE_MODEL,
            ...(selection.options === undefined ? {} : { options: selection.options }),
          } as ModelSelection);

// The run that holds a sandbox chat's first message while its sandbox launches.
const isLaunchRun = (run: OrchestrationV2Run) =>
  run.providerInstanceId === instanceId && run.workspacePreparation === undefined;

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
  const remote = yield* SandboxThreadRemote;
  const secrets = yield* ServerSecretStore.ServerSecretStore;

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
  const lightweightProject = Effect.fn("SandboxBridge.lightweightProject")(function* (record: {
    readonly provider: SandboxProviderKind;
    readonly repository?: string | undefined;
    readonly label: string;
  }) {
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
      return yield* new SandboxProviderError({
        stage: "pair",
        detail: "No sandbox belongs to this thread.",
      });
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

  const clearResumeFailure = (threadId: ThreadId) =>
    secrets.remove(bridgeResumeFailureSecretName(threadId)).pipe(Effect.ignore);

  // Tells the bridge the turns waiting on this resume can stop waiting, and why.
  const recordResumeFailure = Effect.fn("SandboxBridge.recordResumeFailure")(function* (
    threadId: ThreadId,
    reason: string,
  ) {
    const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
    const json = yield* encodeResumeFailure({
      reason,
      messageIds: runs
        .filter((run) => AT_BRIDGE_RUN.has(run.status))
        .map((run) => run.userMessageId),
      failedAt: yield* Clock.currentTimeMillis,
    });
    yield* secrets.set(bridgeResumeFailureSecretName(threadId), new TextEncoder().encode(json));
  });

  // A turn on a stopped sandbox's thread resumes it; the bridge waits for it to answer meanwhile.
  const resumingRuns = new Set<string>();
  const resuming = new Set<string>();
  // Starting a resume and recording one's failure take turns, so a turn that arrives as a resume
  // fails is either named in the failure or starts the next attempt, never neither.
  const resumeTurns = yield* Semaphore.make(1);
  const resumeFor = Effect.fn("SandboxBridge.resumeFor")(function* (threadId: ThreadId) {
    const { sandboxes } = yield* provisioner.list;
    const stopped = sandboxes.find(
      (record) => record.threadId === threadId && record.state === "stopped",
    );
    if (stopped === undefined) return;
    const started = yield* Effect.gen(function* () {
      if (resuming.has(stopped.instanceId)) return false;
      resuming.add(stopped.instanceId);
      // A new attempt: an earlier failure no longer speaks for the turns waiting now.
      yield* clearResumeFailure(threadId);
      return true;
    }).pipe(resumeTurns.withPermits(1));
    if (!started) return;
    yield* provisioner.resume({ instanceId: stopped.instanceId }).pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : recordResumeFailure(
              threadId,
              Option.match(Cause.findErrorOption(cause), {
                onNone: () => "something went wrong while it started",
                onSome: (error) => error.detail,
              }),
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not tell the sandbox bridge a resume failed", { cause }),
              ),
              Effect.ensuring(Effect.sync(() => resuming.delete(stopped.instanceId))),
              resumeTurns.withPermits(1),
            ),
      ),
      Effect.ensuring(Effect.sync(() => resuming.delete(stopped.instanceId))),
    );
  });
  const catchUpModes = Effect.fn("SandboxBridge.catchUpModes")(function* (threadId: ThreadId) {
    const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
    if (thread.deletedAt !== null || thread.runtimeMode !== "full-access") return;
    yield* remote.setModes(threadId, {
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
    });
  });
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
      // The sandbox's thread runs in the host thread's modes, so a change on either client (the
      // phone here, or the computer, which sets them on this thread too) reaches it at once.
      if (
        (event.type === "thread.runtime-mode-updated" ||
          event.type === "thread.interaction-mode-updated") &&
        event.payload.modelSelection.instanceId === instanceId
      ) {
        return remote
          .setModes(event.payload.id, {
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not move a sandbox thread to its host thread's modes", {
                cause,
              }),
            ),
            Effect.forkScoped,
            Effect.asVoid,
          );
      }
      if (event.type !== "run.created" && event.type !== "run.updated") return Effect.void;
      const run = event.payload;
      if (run.providerInstanceId !== instanceId) return Effect.void;
      if (ENDED_RUN.has(run.status)) {
        resumingRuns.delete(run.id);
        // A move to full access waits out the sandbox's run (see modeSyncCommands); it lands now.
        return catchUpModes(run.threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not move a sandbox thread to its host thread's modes", {
              cause,
            }),
          ),
          Effect.forkScoped,
          Effect.asVoid,
        );
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

  // The host thread outlives its sandbox as an ordinary thread: nothing queued for the sandbox
  // can run any more, and the chat is done.
  const releaseHostThread = Effect.fn("SandboxBridge.releaseHostThread")(function* (
    threadId: ThreadId,
  ) {
    const { thread, runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
    if (thread.deletedAt !== null || thread.modelSelection.instanceId !== instanceId) return;
    const id = yield* random.uuidV4().pipe(Effect.orDie);
    for (const run of runs) {
      if (run.status !== "queued") continue;
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make(`sandbox-deleted-cancel:${id}:${run.id}`),
        threadId,
        runId: run.id,
      });
    }
    if (thread.settledAt !== null || thread.settledOverride === "settled") return;
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make(`sandbox-deleted-settle:${id}`),
      threadId,
    });
  });

  // However a linked sandbox goes (a delete, the sweep, a new launch replacing it), its host
  // thread keeps the chat.
  yield* forkParked(
    Stream.runForEach(provisioner.removed, (record) =>
      record.threadId === undefined || record.hostProjectId === undefined
        ? Effect.void
        : clearResumeFailure(record.threadId).pipe(
            Effect.andThen(releaseHostThread(record.threadId)),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not settle a deleted sandbox's host thread", { cause }),
            ),
          ),
    ),
  );

  const pendingLaunchSecret = bridgeLaunchSecretName;
  const savePendingLaunch = Effect.fn("SandboxBridge.savePendingLaunch")(function* (
    input: SandboxLaunchInput,
    hostProjectId: ProjectId,
  ) {
    const { message: _message, ...kept } = input;
    const json = yield* encodePendingLaunch({ input: kept, hostProjectId }).pipe(Effect.orDie);
    yield* secrets.set(pendingLaunchSecret(input.threadId), new TextEncoder().encode(json)).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not keep a sandbox launch for a retry after a restart", {
          cause,
        }),
      ),
    );
  });
  const readPendingLaunch = (threadId: ThreadId) =>
    secrets.get(pendingLaunchSecret(threadId)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (bytes) =>
            decodePendingLaunch(new TextDecoder().decode(bytes)).pipe(Effect.asSome),
        }),
      ),
      Effect.orElseSucceed(() => Option.none<typeof PendingLaunch.Type>()),
    );
  const forgetPendingLaunch = (threadId: ThreadId) =>
    secrets.remove(pendingLaunchSecret(threadId)).pipe(Effect.ignore);

  /** The thread's project here: the repository's own copy when the client named a real one. */
  const pickHostProject = Effect.fn("SandboxBridge.pickHostProject")(function* (
    input: SandboxLaunchInput,
    provider: SandboxProviderKind,
  ) {
    const claimed = input.project.hostCopy;
    const hostCopy =
      claimed === undefined
        ? Option.none()
        : yield* projects.getById(claimed.projectId).pipe(Effect.orElseSucceed(Option.none));
    const hostProjectId =
      Option.isSome(hostCopy) && hostCopy.value.workspaceRoot === claimed?.workspaceRoot
        ? hostCopy.value.id
        : yield* lightweightProject({
            provider,
            repository: githubRepositoryOf(input.project.remoteUrl)?.label,
            label: input.project.title,
          });
    yield* showInProject(hostProjectId).pipe(
      Effect.mapError((cause) =>
        failed(provider, "Could not show the Sandboxes provider in this project.", cause),
      ),
    );
    return hostProjectId;
  });

  /** The thread with the chat's first message, `preparing` until the launch releases it. */
  const createHostThread = Effect.fn("SandboxBridge.createHostThread")(function* (
    threadId: ThreadId,
    hostProjectId: ProjectId,
    message: SandboxLaunchMessage,
    modelSelection: ModelSelection,
    provider: SandboxProviderKind,
  ) {
    const toError = (cause: unknown) =>
      failed(provider, "Could not start this chat's thread on this computer.", cause);
    const shell = yield* orchestrator.getThreadShell(threadId).pipe(Effect.mapError(toError));
    if (shell === null) {
      yield* orchestrator
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make(`sandbox-launch-thread:${message.messageId}`),
          threadId,
          projectId: hostProjectId,
          title: message.title,
          modelSelection,
          runtimeMode: message.runtimeMode,
          interactionMode: message.interactionMode,
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.mapError(toError));
    }
    const attachments =
      message.attachments.length === 0
        ? []
        : yield* persistChatAttachments({
            threadId,
            messageId: message.messageId,
            attachments: message.attachments,
          }).pipe(
            Effect.provideService(ServerConfig.ServerConfig, config),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.mapError((cause) => failed(provider, cause.message, cause)),
          );
    yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`sandbox-launch-message:${message.messageId}`),
        threadId,
        messageId: message.messageId,
        text: message.text,
        attachments: [...attachments],
        titleSeed: message.title,
        modelSelection,
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError(toError));
  });

  const launchRuns = Effect.fn("SandboxBridge.launchRuns")(function* (threadId: ThreadId) {
    const { thread, runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
    if (thread.deletedAt !== null) return [];
    return runs.filter(isLaunchRun).toSorted((left, right) => left.ordinal - right.ordinal);
  });

  const commandFor = (kind: string, runId: RunId) =>
    random.uuidV4().pipe(
      Effect.orDie,
      Effect.map((id) => CommandId.make(`sandbox-launch-${kind}:${runId}:${id}`)),
    );

  // A config that starts chats on Pi waits a while for the sandbox to list Pi's model, so the
  // first message goes to it; past that it goes to the sandbox's default.
  const awaitPi = Effect.fn("SandboxBridge.awaitPi")(function* (
    threadId: ThreadId,
    selection: ModelSelection,
  ) {
    const piModel = selection.model;
    if (!piModel.startsWith(sandboxPiModelSlug(""))) return;
    yield* Effect.gen(function* () {
      while (!(yield* remote.providerReady(threadId, piInstanceId, piModel))) {
        yield* Effect.sleep(PI_READY_SPACING);
      }
    }).pipe(Effect.timeoutOption(PI_READY_WAIT));
  });

  const releaseLaunchRun = Effect.fn("SandboxBridge.releaseLaunchRun")(function* (
    threadId: ThreadId,
  ) {
    const run = (yield* launchRuns(threadId)).findLast(
      (candidate) => candidate.status === "preparing",
    );
    // The sandbox exists now, so a retry would never need to start another.
    yield* forgetPendingLaunch(threadId);
    if (run === undefined) return;
    yield* awaitPi(threadId, run.modelSelection);
    yield* orchestrator.dispatch({
      type: "prepared-run.release",
      commandId: yield* commandFor("release", run.id),
      threadId,
      runId: run.id,
    });
  });

  const failLaunchRun = Effect.fn("SandboxBridge.failLaunchRun")(function* (
    threadId: ThreadId,
    message: string,
  ) {
    for (const run of yield* launchRuns(threadId)) {
      if (run.status !== "preparing") continue;
      yield* orchestrator.dispatch({
        type: "prepared-run.fail",
        commandId: yield* commandFor("fail", run.id),
        threadId,
        runId: run.id,
        failure: {
          class: "provider_error",
          message,
          code: null,
          retryable: true,
        },
      });
    }
  });

  // A launch starting over (a retry on the card) takes back the message its failure ended.
  const retryLaunchRun = Effect.fn("SandboxBridge.retryLaunchRun")(function* (threadId: ThreadId) {
    const runs = yield* launchRuns(threadId);
    const latest = runs.at(-1);
    if (latest === undefined || latest.status !== "failed") return;
    yield* orchestrator.dispatch({
      type: "prepared-run.retry",
      commandId: yield* commandFor("retry", latest.id),
      threadId,
      runId: latest.id,
    });
  });

  const onLaunchLifecycle = (event: SandboxLaunchLifecycle) => {
    const handled =
      event._tag === "began"
        ? retryLaunchRun(event.threadId)
        : event.phase === "done"
          ? releaseLaunchRun(event.threadId)
          : failLaunchRun(
              event.threadId,
              event.phase === "cancelled"
                ? LAUNCH_CANCELLED_MESSAGE
                : launchFailedMessage(event.error),
            ).pipe(
              Effect.andThen(
                event.phase === "cancelled" ? forgetPendingLaunch(event.threadId) : Effect.void,
              ),
            );
    return handled.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not move a sandbox chat's first message along with its launch", {
          threadId: event.threadId,
          launch: event._tag === "began" ? "began" : event.phase,
          cause,
        }),
      ),
    );
  };
  yield* forkParked(Stream.runForEach(provisioner.launchLifecycle, onLaunchLifecycle));

  // After a restart no launch is running, so a first message still waiting has lost its launch:
  // one whose sandbox got linked goes out now, the rest fail with a way to retry.
  const sweepOrphanedLaunchRuns = Effect.gen(function* () {
    const shells = yield* orchestrator.listActiveShellIndex();
    const { sandboxes } = yield* provisioner.list;
    for (const shell of shells) {
      if (!shell.mayBeLive) continue;
      const threadId = shell.id;
      const waiting = (yield* launchRuns(threadId).pipe(Effect.orElseSucceed(() => []))).some(
        (run) => run.status === "preparing",
      );
      if (!waiting || (yield* provisioner.launching(threadId))) continue;
      const linked = sandboxes.some(
        (record) =>
          record.threadId === threadId &&
          record.bridge !== undefined &&
          record.hostProjectId !== undefined &&
          record.state !== "provisioning" &&
          record.state !== "deleted",
      );
      if (linked) {
        yield* releaseLaunchRun(threadId);
        continue;
      }
      const pending = yield* readPendingLaunch(threadId);
      if (Option.isSome(pending)) yield* provisioner.markLaunchLost(pending.value.input);
      yield* failLaunchRun(threadId, LAUNCH_LOST_MESSAGE);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not settle sandbox chats whose launch was lost", { cause }),
    ),
  );
  yield* forkParked(sweepOrphanedLaunchRuns);

  const launch = Effect.fn("SandboxBridge.launch")(function* (input: SandboxLaunchInput) {
    const message = input.message;
    if (message === undefined) return yield* provisioner.launch(input);
    const { configs } = yield* provisioner.configs;
    const config = configs.find((candidate) => candidate.id === input.configId);
    // Refusals a launch would make anyway come before the thread does.
    if (config === undefined || githubRepositoryOf(input.project.remoteUrl) === null) {
      return yield* provisioner.launch(input);
    }
    const hostProjectId = yield* pickHostProject(input, config.provider);
    yield* createHostThread(
      input.threadId,
      hostProjectId,
      message,
      bridgeSelectionFor(message.modelSelection, config.pi?.startModel),
      config.provider,
    );
    yield* savePendingLaunch(input, hostProjectId);
    const result = yield* provisioner
      .launch(input, { hostProjectId })
      .pipe(
        Effect.tapError((error) =>
          failLaunchRun(input.threadId, launchFailedMessage(error.detail)).pipe(Effect.ignore),
        ),
      );
    // The thread already had its sandbox, so the message goes to it now.
    if (!(yield* provisioner.launching(input.threadId))) {
      const { sandboxes } = yield* provisioner.list;
      const own = sandboxes.find(
        (record) => record.instanceId === result.instanceId && record.bridge !== undefined,
      );
      if (own !== undefined) {
        yield* releaseLaunchRun(input.threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not send a sandbox chat's first message", { cause }),
          ),
        );
      }
    }
    return {
      ...result,
      hostThread: { threadId: input.threadId, projectId: hostProjectId },
    } satisfies SandboxLaunchResult;
  });

  const retryLaunch = Effect.fn("SandboxBridge.retryLaunch")(function* (
    input: SandboxLaunchThreadInput,
  ) {
    if (yield* provisioner.retryLaunch(input)) return;
    // This server restarted since the launch failed; what it kept starts a new sandbox.
    const pending = yield* readPendingLaunch(input.threadId);
    if (Option.isNone(pending)) return;
    yield* provisioner.launch(pending.value.input, { hostProjectId: pending.value.hostProjectId });
  });

  return SandboxBridge.of({ linkHostThread, launch, retryLaunch });
});

export const layer = Layer.effect(SandboxBridge, make);

export const layerLive = layer.pipe(Layer.provide(layerThreadRemote));

/** The sandbox WebSocket handlers: the provisioner's, plus linking a thread to the bridge. */
export const rpcHandlers = Effect.gen(function* () {
  const provisionerHandlers = yield* SandboxProvisioner.rpcHandlers;
  const bridge = yield* SandboxBridge;
  const settle = yield* SandboxSettle.SandboxSettle;
  return {
    ...provisionerHandlers,
    [WS_METHODS.sandboxesResolveSettle]: (input: SandboxResolveSettleInput) =>
      settle.resolve(input),
    [WS_METHODS.sandboxesLinkHostThread]: (input: SandboxLaunchThreadInput) =>
      bridge.linkHostThread(input),
    [WS_METHODS.sandboxesLaunch]: (input: SandboxLaunchInput) => bridge.launch(input),
    [WS_METHODS.sandboxesRetryLaunch]: (input: SandboxLaunchThreadInput) =>
      bridge.retryLaunch(input),
  };
});
