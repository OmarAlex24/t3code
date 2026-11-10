import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProjectId,
  ProviderInstanceId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  type SandboxLifecycleState,
  type SandboxProviderInfo,
  type SandboxProviderKind,
  type SandboxRecord,
  type ScopedThreadRef,
  type ServerProvider,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";

import { isProviderInstancePickerReady, providerInstanceEntriesFor } from "../providerInstances";

/**
 * The sandbox a thread runs on. The ref is either the sandbox's own thread, or the host thread the
 * sandbox bridge drives: the provisioning server's thread with the same id, once it is linked.
 */
export const findThreadSandbox = (
  sandboxes: ReadonlyArray<SandboxRecord>,
  threadRef: ScopedThreadRef,
  provisionerEnvironmentId: EnvironmentId | null,
): SandboxRecord | undefined =>
  sandboxes.find(
    (sandbox) =>
      sandbox.environmentId === threadRef.environmentId && sandbox.threadId === threadRef.threadId,
  ) ??
  (threadRef.environmentId === provisionerEnvironmentId
    ? sandboxes.find(
        (sandbox) =>
          sandbox.threadId === threadRef.threadId &&
          sandbox.hostProjectId !== undefined &&
          sandbox.state !== "provisioning" &&
          sandbox.state !== "deleted",
      )
    : undefined);

/** What a thread row shows of the sandbox it runs on. */
export interface SandboxRowState {
  readonly provider: SandboxProviderKind;
  readonly state: SandboxLifecycleState;
  /** When a resume began, while one runs. */
  readonly resumingSince: string | null;
}

/** What a stopped sandbox's thread says on hover; sending is what resumes it. */
export const SANDBOX_STOPPED_HINT = "Sandbox stopped · send a message to resume it";

/** How a sandbox thread's row marks its machine: starting, stopped, or as it usually looks. */
export type SandboxRowPhase = "starting" | "stopped" | null;

export const sandboxRowPhase = (row: SandboxRowState | null): SandboxRowPhase =>
  row === null
    ? null
    : row.resumingSince !== null
      ? "starting"
      : row.state === "stopped"
        ? "stopped"
        : null;

/**
 * Each row's sandbox, looked up once per list: any thread on a sandbox's own environment, and the
 * host thread the bridge drives for it, as `findThreadSandbox` finds them. Null for other threads.
 */
export const sandboxRowStates = (
  sandboxes: ReadonlyArray<SandboxRecord>,
  provisionerEnvironmentId: EnvironmentId | null,
): ((threadRef: ScopedThreadRef) => SandboxRowState | null) => {
  const byEnvironment = new Map<EnvironmentId, SandboxRowState>();
  const byHostThread = new Map<ThreadId, SandboxRowState>();
  for (const sandbox of sandboxes) {
    if (sandbox.state === "deleted") continue;
    const row: SandboxRowState = {
      provider: sandbox.provider,
      state: sandbox.state,
      resumingSince: sandbox.resumingSince ?? null,
    };
    // One that answers as the host would claim every host thread.
    if (sandbox.environmentId !== null && sandbox.environmentId !== provisionerEnvironmentId) {
      byEnvironment.set(sandbox.environmentId, row);
    }
    if (
      sandbox.threadId !== undefined &&
      sandbox.hostProjectId !== undefined &&
      sandbox.state !== "provisioning"
    ) {
      byHostThread.set(sandbox.threadId, row);
    }
  }
  return (threadRef) =>
    byEnvironment.get(threadRef.environmentId) ??
    (threadRef.environmentId === provisionerEnvironmentId
      ? byHostThread.get(threadRef.threadId)
      : undefined) ??
    null;
};

/** Whether the ref is the host thread the bridge drives rather than the sandbox's own thread. */
export const isHostThreadRef = (sandbox: SandboxRecord, threadRef: ScopedThreadRef) =>
  sandbox.environmentId !== threadRef.environmentId;

/**
 * Whether the sandbox's conversation is kept on the host, in the thread the bridge drives. A launch
 * that could not link sends on the sandbox instead, so only the host thread's existence says so.
 */
export const isBridgedSandbox = (
  sandbox: SandboxRecord,
  threads: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ThreadId }>,
  provisionerEnvironmentId: EnvironmentId | null,
) =>
  sandbox.threadId !== undefined &&
  threads.some(
    (thread) => thread.environmentId === provisionerEnvironmentId && thread.id === sandbox.threadId,
  );

type ThreadEntry = { readonly environmentId: EnvironmentId; readonly id: ThreadId };

const listed = (threads: ReadonlyArray<ThreadEntry>, ref: ScopedThreadRef) =>
  threads.some(
    (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
  );

/**
 * The host's mirrors of sandbox threads, by the mirror's thread key, each with the sandbox's own
 * thread. The bridge drives a mirror with the sandbox thread's id so the phone can follow it; this
 * app shows the sandbox's thread instead, the one with the real model, files and terminal. Without
 * that thread listed here (a sandbox gone or not connected), the mirror is the conversation.
 */
export const sandboxHostMirrors = (
  sandboxes: ReadonlyArray<SandboxRecord>,
  threads: ReadonlyArray<ThreadEntry>,
  provisionerEnvironmentId: EnvironmentId | null,
): ReadonlyMap<string, ScopedThreadRef> => {
  const mirrors = new Map<string, ScopedThreadRef>();
  if (provisionerEnvironmentId === null) return mirrors;
  for (const sandbox of sandboxes) {
    if (
      sandbox.environmentId === null ||
      sandbox.environmentId === provisionerEnvironmentId ||
      sandbox.threadId === undefined ||
      sandbox.hostProjectId === undefined ||
      sandbox.state === "deleted"
    ) {
      continue;
    }
    const real = { environmentId: sandbox.environmentId, threadId: sandbox.threadId };
    const mirror = { environmentId: provisionerEnvironmentId, threadId: sandbox.threadId };
    if (listed(threads, real) && listed(threads, mirror)) mirrors.set(threadKey(mirror), real);
  }
  return mirrors;
};

/** The sandbox thread a host mirror stands for; undefined for any other thread. */
export const sandboxMirrorTarget = (
  mirrors: ReadonlyMap<string, ScopedThreadRef>,
  threadRef: ScopedThreadRef,
): ScopedThreadRef | undefined => mirrors.get(threadKey(threadRef));

/**
 * The thread keys lists leave out because another row stands for them: tasks shown under their
 * parent (`delegatedUnderParent`), and host mirrors, shown as their sandbox thread.
 */
export const withSandboxHostMirrors = (
  delegatedUnderParent: ReadonlySet<string>,
  mirrors: ReadonlyMap<string, ScopedThreadRef>,
): ReadonlySet<string> =>
  mirrors.size === 0 ? delegatedUnderParent : new Set([...delegatedUnderParent, ...mirrors.keys()]);

/**
 * The mirrors whose title differs from their sandbox thread's, with the title to give them, so the
 * phone shows the name the sandbox's thread got.
 */
export const sandboxMirrorTitleUpdates = (
  mirrors: ReadonlyMap<string, ScopedThreadRef>,
  threads: ReadonlyArray<ThreadEntry & { readonly title: string }>,
): ReadonlyArray<{
  readonly mirror: ScopedThreadRef;
  readonly title: string;
  readonly mirrorTitle: string;
}> => {
  if (mirrors.size === 0) return [];
  const byKey = new Map(
    threads.map((thread) => [
      threadKey({ environmentId: thread.environmentId, threadId: thread.id }),
      thread,
    ]),
  );
  return [...mirrors].flatMap(([mirrorKey, real]) => {
    const mirror = byKey.get(mirrorKey);
    const title = byKey.get(threadKey(real))?.title.trim();
    return mirror === undefined || !title || mirror.title === title
      ? []
      : [
          {
            mirror: { environmentId: mirror.environmentId, threadId: mirror.id },
            title,
            mirrorTitle: mirror.title,
          },
        ];
  });
};

/**
 * Where a send on a sandbox thread is mirrored for the phone: the host thread with its id, in the
 * host project the launch linked. Null for a thread with no linked sandbox.
 */
export const sandboxMirrorOf = (
  sandboxes: ReadonlyArray<SandboxRecord>,
  threadRef: ScopedThreadRef,
  provisionerEnvironmentId: EnvironmentId | null,
): { readonly mirror: ScopedThreadRef; readonly hostProjectId: ProjectId } | null => {
  if (provisionerEnvironmentId === null || threadRef.environmentId === provisionerEnvironmentId) {
    return null;
  }
  const sandbox = sandboxes.find(
    (candidate) =>
      candidate.environmentId === threadRef.environmentId &&
      candidate.threadId === threadRef.threadId &&
      candidate.state !== "deleted",
  );
  return sandbox?.hostProjectId === undefined
    ? null
    : {
        mirror: { environmentId: provisionerEnvironmentId, threadId: threadRef.threadId },
        hostProjectId: sandbox.hostProjectId,
      };
};

const bridgeInstanceId = ProviderInstanceId.make(SANDBOX_BRIDGE_INSTANCE_ID);

/**
 * Whether a host thread sent through the sandbox bridge and its sandbox is gone: the chat stays to
 * read, and nothing it sends could reach a sandbox. False while the sandbox list loads.
 */
export const isSandboxlessBridgeThread = (input: {
  readonly sandboxes: ReadonlyArray<SandboxRecord> | null;
  readonly threadRef: ScopedThreadRef;
  readonly instanceId: string | undefined;
  readonly provisionerEnvironmentId: EnvironmentId | null;
}) =>
  input.sandboxes !== null &&
  input.instanceId === bridgeInstanceId &&
  input.threadRef.environmentId === input.provisionerEnvironmentId &&
  !input.sandboxes.some(
    (sandbox) => sandbox.threadId === input.threadRef.threadId && sandbox.state !== "deleted",
  );

interface InstanceReadyInput {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides"> | null;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly model: string;
}

/**
 * Whether the composer can send on `instanceId` with `model` in this project yet: the project is
 * listed, the instance is on there and probed, and its probe found `model`. Until then the composer
 * would pick another provider, or a placeholder model the instance lists before its probe.
 */
export const providerInstanceReady = (
  input: InstanceReadyInput & { readonly instanceId: ProviderInstanceId },
) => {
  if (input.settings === null) return false;
  const listed = input.projects.some(
    (project) => project.environmentId === input.environmentId && project.id === input.projectId,
  );
  const entry = providerInstanceEntriesFor(input.providers, input.settings, input.projectId).find(
    (candidate) => candidate.instanceId === input.instanceId,
  );
  return (
    listed &&
    entry !== undefined &&
    isProviderInstancePickerReady(entry) &&
    entry.models.some((candidate) => candidate.slug === input.model)
  );
};

/**
 * Whether a host thread can send through the bridge in this project yet. Linking turns the
 * provider on for the project and the server probes it after.
 */
export const sandboxBridgeReady = (input: InstanceReadyInput) =>
  providerInstanceReady({ ...input, instanceId: bridgeInstanceId });

const DAY_MINUTES = 24 * 60;
// A stopped disk this close to the provider's limit gets a warning that recommends deleting it.
const RETENTION_WARNING_DAYS = 3;

/** How long a stopped sandbox's disk has been kept, and whether the provider is about to drop it. */
export const stoppedDiskAge = (
  sandbox: SandboxRecord,
  provider: SandboxProviderInfo | undefined,
  nowMillis: number,
) => {
  const stoppedMinutes =
    sandbox.state === "stopped"
      ? Math.max(
          0,
          Math.floor((nowMillis - Date.parse(sandbox.stoppedAt ?? sandbox.updatedAt)) / 60_000),
        )
      : null;
  const retentionDays = provider?.diskRetentionDays;
  const stoppedDays = stoppedMinutes === null ? null : Math.floor(stoppedMinutes / DAY_MINUTES);
  const nearRetention =
    retentionDays !== undefined &&
    stoppedDays !== null &&
    stoppedDays >= retentionDays - RETENTION_WARNING_DAYS;
  return { stoppedMinutes, stoppedDays, retentionDays, nearRetention };
};

/** The warning shown wherever a stopped disk is close to the provider dropping it. */
export const retentionWarning = (
  providerLabel: string,
  retentionDays: number,
  stoppedDays: number,
) =>
  `${providerLabel} keeps a stopped disk for ${retentionDays} days; this one has been stopped ${stoppedDays} ${stoppedDays === 1 ? "day" : "days"}. Delete it unless you need what is on it. T3 Code never deletes it for you.`;

// Enough of the provider's id to tell two sandboxes with one thread title apart, such as `bx_46wr`.
export const shortSandboxId = (sandboxId: string) => {
  const separator = sandboxId.indexOf("_");
  return separator === -1 ? sandboxId.slice(0, 7) : sandboxId.slice(0, separator + 5);
};

/** A settle's Undo: its claim, current until something supersedes the settle, and the undo itself. */
export interface SandboxSettleUndo {
  readonly claim: { readonly isCurrent: () => boolean; readonly finish: () => void };
  readonly undo: () => Promise<AtomCommandResult<unknown, unknown>>;
}

/**
 * What the thread actions ask of the one mounted sandbox coordinator. A legacy thread lives on its
 * sandbox's server, which this host never hears from, so settling, resuming and deleting the
 * sandbox all start in this client. A bridged thread's host thread goes through it too.
 */
export interface SandboxThreadHandlers {
  readonly isSandboxThread: (threadRef: ScopedThreadRef) => boolean;
  /** The state of the thread's sandbox; undefined for a thread with no sandbox. */
  readonly sandboxState: (threadRef: ScopedThreadRef) => SandboxRecord["state"] | undefined;
  /**
   * After a settle: stops, deletes, or asks, as the thread's config says. True when it shows the
   * settle's Undo itself, as a delayed delete does.
   */
  readonly onSettled: (threadRef: ScopedThreadRef, settle: SandboxSettleUndo) => boolean;
  /** Resumes a stopped sandbox and waits for its server; false when it could not. */
  readonly ensureRunning: (threadRef: ScopedThreadRef) => Promise<boolean>;
  /** Confirms, deletes the thread while its server answers, then deletes the sandbox. */
  readonly deleteThreadAndSandbox: (
    threadRef: ScopedThreadRef,
    deleteThread: () => Promise<{ readonly _tag: string }>,
  ) => Promise<void>;
  /** Confirms with the work check and deletes the sandbox, and any conversation only on it. */
  readonly deleteSandbox: (threadRef: ScopedThreadRef) => Promise<void>;
}

let handlers: SandboxThreadHandlers | null = null;

export function registerSandboxThreadHandlers(next: SandboxThreadHandlers): () => void {
  handlers = next;
  return () => {
    if (handlers === next) handlers = null;
  };
}

export const isSandboxThread = (threadRef: ScopedThreadRef) =>
  handlers?.isSandboxThread(threadRef) === true;

export const notifySandboxThreadSettled = (threadRef: ScopedThreadRef, settle: SandboxSettleUndo) =>
  handlers?.onSettled(threadRef, settle) === true;

/** True when the thread has no sandbox, or its sandbox runs again. */
export const ensureSandboxThreadRunning = async (threadRef: ScopedThreadRef) =>
  handlers === null || !handlers.isSandboxThread(threadRef)
    ? true
    : handlers.ensureRunning(threadRef);

export const deleteSandboxThread = (
  threadRef: ScopedThreadRef,
  deleteThread: () => Promise<{ readonly _tag: string }>,
) => handlers?.deleteThreadAndSandbox(threadRef, deleteThread) ?? Promise.resolve();

export const deleteThreadSandbox = (threadRef: ScopedThreadRef) =>
  handlers?.deleteSandbox(threadRef) ?? Promise.resolve();

const UNAVAILABLE_REASON: Partial<Record<SandboxRecord["state"], string>> = {
  deleted: "The sandbox no longer exists",
  expired: "The sandbox's disk expired",
  stopped: "The sandbox is stopped",
  provisioning: "The sandbox is still starting",
};

/**
 * What a thread's menu says when its server cannot take its changes, because its sandbox is gone,
 * stopped or not connected. Null for a thread with no sandbox.
 */
export const threadSandboxUnavailableReason = (threadRef: ScopedThreadRef): string | null => {
  const state = handlers?.sandboxState(threadRef);
  return state === undefined ? null : (UNAVAILABLE_REASON[state] ?? "The sandbox is not connected");
};
