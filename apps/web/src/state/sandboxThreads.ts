import {
  type EnvironmentId,
  type ProjectId,
  ProviderInstanceId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  type SandboxProviderInfo,
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

const bridgeInstanceId = ProviderInstanceId.make(SANDBOX_BRIDGE_INSTANCE_ID);

/**
 * Whether a host thread can send through the bridge in this project yet. Linking turns the
 * provider on for the project and the server probes it after; until then the composer would pick
 * another provider, or the placeholder model the instance lists before its probe finds `model`.
 */
export const sandboxBridgeReady = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides"> | null;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly model: string;
}) => {
  if (input.settings === null) return false;
  const listed = input.projects.some(
    (project) => project.environmentId === input.environmentId && project.id === input.projectId,
  );
  const entry = providerInstanceEntriesFor(input.providers, input.settings, input.projectId).find(
    (candidate) => candidate.instanceId === bridgeInstanceId,
  );
  return (
    listed &&
    entry !== undefined &&
    isProviderInstancePickerReady(entry) &&
    entry.models.some((candidate) => candidate.slug === input.model)
  );
};

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

/**
 * What the thread actions ask of the one mounted sandbox coordinator. A legacy thread lives on its
 * sandbox's server, which this host never hears from, so settling, resuming and deleting the
 * sandbox all start in this client. A bridged thread's host thread goes through it too.
 */
export interface SandboxThreadHandlers {
  readonly isSandboxThread: (threadRef: ScopedThreadRef) => boolean;
  /** After a settle: stops, deletes, or asks, as the thread's config says. */
  readonly onSettled: (threadRef: ScopedThreadRef) => void;
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

export const notifySandboxThreadSettled = (threadRef: ScopedThreadRef) => {
  handlers?.onSettled(threadRef);
};

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
