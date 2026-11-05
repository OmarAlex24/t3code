import type { SandboxProviderInfo, SandboxRecord, ScopedThreadRef } from "@t3tools/contracts";

/** The sandbox a thread runs on: the record that names its environment and thread. */
export const findThreadSandbox = (
  sandboxes: ReadonlyArray<SandboxRecord>,
  threadRef: ScopedThreadRef,
): SandboxRecord | undefined =>
  sandboxes.find(
    (sandbox) =>
      sandbox.environmentId === threadRef.environmentId && sandbox.threadId === threadRef.threadId,
  );

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
 * What the thread actions ask of the one mounted sandbox coordinator. The thread lives on its
 * sandbox's server, which this host never hears from, so settling, resuming and deleting the
 * sandbox all start in this client.
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
  /** Confirms with the work check and deletes the sandbox, and the conversation on it. */
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
