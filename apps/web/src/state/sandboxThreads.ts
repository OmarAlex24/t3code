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
  type SandboxSetupSnapshot,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

/**
 * Whether a sandbox's chat is the provisioning server's thread with its id: once the launch linked
 * it, and from the start of a launch, which makes that thread and holds its first message there.
 * A running sandbox the launch never linked keeps its chat on the sandbox.
 */
const chatsOnHost = (sandbox: SandboxRecord) =>
  sandbox.threadId !== undefined &&
  sandbox.state !== "deleted" &&
  (sandbox.hostProjectId !== undefined || sandbox.state === "provisioning");

/**
 * The sandbox a thread runs on. The ref is either the sandbox's own thread, or the host thread the
 * sandbox bridge drives: the provisioning server's thread with the same id (see `chatsOnHost`).
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
    ? sandboxes.find((sandbox) => sandbox.threadId === threadRef.threadId && chatsOnHost(sandbox))
    : undefined);

/** What a thread row shows of the sandbox it runs on. */
export interface SandboxRowState {
  readonly provider: SandboxProviderKind;
  readonly state: SandboxLifecycleState;
  /** When a resume began, while one runs. */
  readonly resumingSince: string | null;
  /** The row is the host thread the bridge drives, standing for the sandbox's own thread. */
  readonly onHost: boolean;
}

/**
 * A thread as its row reads it. A host mirror's queue can hold messages for days that never ran,
 * while nothing runs on the sandbox; only that queue drops, so a bridge turn still reads as work.
 */
export const sandboxRowThread = <
  T extends { readonly runtime: { readonly status: string } | null },
>(
  thread: T,
  row: SandboxRowState | null,
): T =>
  row?.onHost === true && thread.runtime?.status === "queued"
    ? { ...thread, runtime: null }
    : thread;

export const SANDBOX_STOPPED_LABEL = "Sandbox stopped";
export const SANDBOX_RESUME_HINT = "send a message to resume it";
/** What a stopped sandbox's thread says on hover; sending is what resumes it. */
export const SANDBOX_STOPPED_HINT = `${SANDBOX_STOPPED_LABEL} · ${SANDBOX_RESUME_HINT}`;

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
      onHost: false,
    };
    // One that answers as the host would claim every host thread.
    if (sandbox.environmentId !== null && sandbox.environmentId !== provisionerEnvironmentId) {
      byEnvironment.set(sandbox.environmentId, row);
    }
    if (sandbox.threadId !== undefined && chatsOnHost(sandbox)) {
      byHostThread.set(sandbox.threadId, { ...row, onHost: true });
    }
  }
  return (threadRef) =>
    byEnvironment.get(threadRef.environmentId) ??
    (threadRef.environmentId === provisionerEnvironmentId
      ? byHostThread.get(threadRef.threadId)
      : undefined) ??
    null;
};

/**
 * Linked sandboxes this app is not paired with yet. The host's launch ends with its own bridge, so
 * each app pairs on its own afterwards, whether or not the chat is open; meanwhile the host thread
 * is the chat. A stopped sandbox waits until it runs again.
 */
export const sandboxesToPair = (
  sandboxes: ReadonlyArray<SandboxRecord>,
  provisionerEnvironmentId: EnvironmentId | null,
  pairedEnvironmentIds: ReadonlySet<EnvironmentId>,
): ReadonlyArray<SandboxRecord> =>
  provisionerEnvironmentId === null
    ? []
    : sandboxes.filter(
        (sandbox) =>
          sandbox.state === "running" &&
          sandbox.threadId !== undefined &&
          sandbox.hostProjectId !== undefined &&
          sandbox.bridge !== undefined &&
          sandbox.environmentId !== null &&
          sandbox.environmentId !== provisionerEnvironmentId &&
          !pairedEnvironmentIds.has(sandbox.environmentId),
      );

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
 * The host's mirrors of sandbox threads that are both listed, by the mirror's thread key, each with
 * the sandbox's own thread. The bridge drives a mirror with the sandbox thread's id so the phone can
 * follow it, and the mirror takes the sandbox thread's title; `sandboxChatAliases` says which of the
 * two this app shows.
 */
export const sandboxHostMirrors = (
  sandboxes: ReadonlyArray<SandboxRecord>,
  threads: ReadonlyArray<ThreadEntry>,
  provisionerEnvironmentId: EnvironmentId | null,
): ReadonlyMap<string, ScopedThreadRef> => {
  const mirrors = new Map<string, ScopedThreadRef>();
  for (const { real, mirror } of bridgedSandboxChats(sandboxes, provisionerEnvironmentId)) {
    if (listed(threads, real) && listed(threads, mirror)) {
      mirrors.set(threadKey(mirror), real);
    }
  }
  return mirrors;
};

/**
 * The thread of each sandbox chat that lists, the sidebar and the chat view leave out, by key, with
 * the one that stands for it. The sandbox's own thread is the chat whenever it lists, running or
 * not (a send there resumes it); the mirror stands in only for a stopped one never listed here.
 */
export const sandboxChatAliases = (
  sandboxes: ReadonlyArray<SandboxRecord>,
  threads: ReadonlyArray<ThreadEntry>,
  provisionerEnvironmentId: EnvironmentId | null,
): ReadonlyMap<string, ScopedThreadRef> => {
  const aliases = new Map<string, ScopedThreadRef>();
  for (const { sandbox, real, mirror } of bridgedSandboxChats(
    sandboxes,
    provisionerEnvironmentId,
  )) {
    if (!listed(threads, mirror)) continue;
    if (listed(threads, real)) {
      aliases.set(threadKey(mirror), real);
    } else if (sandbox.state !== "running" && sandbox.state !== "provisioning") {
      aliases.set(threadKey(real), mirror);
    }
  }
  return aliases;
};

/** The two threads of each sandbox chat the host could mirror. */
const bridgedSandboxChats = (
  sandboxes: ReadonlyArray<SandboxRecord>,
  provisionerEnvironmentId: EnvironmentId | null,
) =>
  provisionerEnvironmentId === null
    ? []
    : sandboxes.flatMap((sandbox) =>
        sandbox.environmentId === null ||
        sandbox.environmentId === provisionerEnvironmentId ||
        sandbox.threadId === undefined ||
        sandbox.hostProjectId === undefined ||
        sandbox.state === "deleted"
          ? []
          : [
              {
                sandbox,
                real: { environmentId: sandbox.environmentId, threadId: sandbox.threadId },
                mirror: { environmentId: provisionerEnvironmentId, threadId: sandbox.threadId },
              },
            ],
      );

/** The thread a sandbox chat's other thread stands for; undefined for any other thread. */
export const sandboxChatAliasTarget = (
  aliases: ReadonlyMap<string, ScopedThreadRef>,
  threadRef: ScopedThreadRef,
): ScopedThreadRef | undefined => aliases.get(threadKey(threadRef));

/**
 * The thread keys lists leave out because another row stands for them: tasks shown under their
 * parent (`delegatedUnderParent`), and the thread of a sandbox chat its other thread stands for.
 */
export const withSandboxHostMirrors = (
  delegatedUnderParent: ReadonlySet<string>,
  aliases: ReadonlyMap<string, ScopedThreadRef>,
): ReadonlySet<string> =>
  aliases.size === 0 ? delegatedUnderParent : new Set([...delegatedUnderParent, ...aliases.keys()]);

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

// The mirror's bridge run would run a command such as `/compact` on the host, where it fails;
// only the sandbox's own thread can run it.
const SLASH_COMMAND = /^\/[a-z][\w-]*(?::[\w-]+)?(?:\s|$)/iu;

/** Whether a message sent on a sandbox's own thread is copied to the host's mirror. */
export const copiesToSandboxMirror = (text: string): boolean =>
  !SLASH_COMMAND.test(text.trimStart());

const bridgeInstanceId = ProviderInstanceId.make(SANDBOX_BRIDGE_INSTANCE_ID);

/**
 * Whether a host thread sent through the sandbox bridge and its sandbox is gone: the chat stays to
 * read, and nothing it sends could reach a sandbox. False while the sandbox list or the thread's
 * launch loads, and while that launch runs or failed: its sandbox may not be listed yet.
 */
export const isSandboxlessBridgeThread = (input: {
  readonly sandboxes: ReadonlyArray<SandboxRecord> | null;
  readonly threadRef: ScopedThreadRef;
  readonly instanceId: string | undefined;
  readonly provisionerEnvironmentId: EnvironmentId | null;
  /** The thread's launch on the host; null when it has none, undefined while that loads. */
  readonly launch: Pick<SandboxSetupSnapshot, "phase"> | null | undefined;
}) =>
  input.sandboxes !== null &&
  input.launch !== undefined &&
  input.launch?.phase !== "running" &&
  input.launch?.phase !== "failed" &&
  input.instanceId === bridgeInstanceId &&
  input.threadRef.environmentId === input.provisionerEnvironmentId &&
  !input.sandboxes.some(
    (sandbox) => sandbox.threadId === input.threadRef.threadId && sandbox.state !== "deleted",
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
