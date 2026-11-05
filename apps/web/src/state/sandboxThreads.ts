import { threadKey } from "@t3tools/client-runtime/state/entities";
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

/**
 * Whether the ref is the sandbox's own copy of a conversation the host thread keeps. The bridge
 * starts that copy with the host thread's id, so the two would list as one chat twice; the host
 * thread is the one the phone sees. A thread from before the bridge has no host thread and is the
 * only one, so it never counts.
 */
export const isBridgedSandboxCopy = (
  sandbox: SandboxRecord,
  threadRef: ScopedThreadRef,
  threads: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ThreadId }>,
  provisionerEnvironmentId: EnvironmentId | null,
) =>
  sandbox.environmentId !== provisionerEnvironmentId &&
  sandbox.environmentId === threadRef.environmentId &&
  sandbox.threadId === threadRef.threadId &&
  isBridgedSandbox(sandbox, threads, provisionerEnvironmentId);

/** Each bridged sandbox copy by its thread key (`threadKey`), with the host thread it copies. */
export const bridgedSandboxCopies = (
  sandboxes: ReadonlyArray<SandboxRecord>,
  threads: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ThreadId }>,
  provisionerEnvironmentId: EnvironmentId | null,
): ReadonlyMap<string, ScopedThreadRef> => {
  const copies = new Map<string, ScopedThreadRef>();
  if (provisionerEnvironmentId === null) return copies;
  for (const sandbox of sandboxes) {
    if (sandbox.environmentId === null || sandbox.threadId === undefined) continue;
    const copyRef = { environmentId: sandbox.environmentId, threadId: sandbox.threadId };
    if (isBridgedSandboxCopy(sandbox, copyRef, threads, provisionerEnvironmentId)) {
      copies.set(threadKey(copyRef), {
        environmentId: provisionerEnvironmentId,
        threadId: sandbox.threadId,
      });
    }
  }
  return copies;
};

/** The host thread a bridged sandbox copy belongs to; undefined for any other thread. */
export const bridgedSandboxCopyHost = (
  copies: ReadonlyMap<string, ScopedThreadRef>,
  threadRef: ScopedThreadRef,
): ScopedThreadRef | undefined => copies.get(threadKey(threadRef));

/**
 * The thread keys lists leave out because another row stands for them: tasks shown under their
 * parent (`delegatedUnderParent`), and bridged sandbox copies, shown as their host thread.
 */
export const withBridgedSandboxCopies = (
  delegatedUnderParent: ReadonlySet<string>,
  copies: ReadonlyMap<string, ScopedThreadRef>,
): ReadonlySet<string> =>
  copies.size === 0 ? delegatedUnderParent : new Set([...delegatedUnderParent, ...copies.keys()]);

/**
 * The copies whose title differs from their host thread's, with the title to give them, so the
 * sandbox's copy follows the name the phone and the sidebar show.
 */
export const sandboxCopyTitleUpdates = (
  copies: ReadonlyMap<string, ScopedThreadRef>,
  threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly title: string;
  }>,
): ReadonlyArray<{
  readonly copy: ScopedThreadRef;
  readonly title: string;
  readonly copyTitle: string;
}> => {
  if (copies.size === 0) return [];
  const titleOf = new Map(
    threads.map((thread) => [
      threadKey({ environmentId: thread.environmentId, threadId: thread.id }),
      thread.title,
    ]),
  );
  return [...copies].flatMap(([copyKey, host]) => {
    const copyTitle = titleOf.get(copyKey);
    const hostTitle = titleOf.get(threadKey(host))?.trim();
    // A copy keeps the host thread's id; only its environment differs.
    const copy = threads.find(
      (thread) =>
        thread.id === host.threadId &&
        threadKey({ environmentId: thread.environmentId, threadId: thread.id }) === copyKey,
    );
    return copy === undefined || !hostTitle || copyTitle === hostTitle
      ? []
      : [
          {
            copy: { environmentId: copy.environmentId, threadId: copy.id },
            title: hostTitle,
            copyTitle: copy.title,
          },
        ];
  });
};

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
