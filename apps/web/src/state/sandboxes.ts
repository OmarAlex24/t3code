import { useAtomValue } from "@effect/atom-react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  isSandboxMirrorThread,
  sandboxMirrorModelSource,
  sandboxMirrorPickerSource,
} from "@t3tools/client-runtime/state/sandbox-mirror";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  type SandboxRecord,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { useQuietThreadShells } from "./entities";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "./environments";
import { useEnvironmentPresentation } from "./presentation";
import { useEnvironmentQuery } from "./query";
import {
  findThreadSandbox,
  isSandboxlessBridgeThread,
  sandboxChatAliases,
  sandboxHostMirrors,
  sandboxRowStates,
  type SandboxRowState,
} from "./sandboxThreads";
import { serverEnvironment } from "./server";

/**
 * Hosted web has no primary. The catalog keeps save order, so the first enabled saved environment
 * is the server the user paired before it made any sandbox.
 */
export function useSandboxProvisionerEnvironmentId(): EnvironmentId | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { entries } = useAtomValue(environmentCatalog.catalogValueAtom);
  if (primaryEnvironmentId !== null) return primaryEnvironmentId;
  for (const [environmentId, entry] of entries) {
    if (entry.target._tag !== "PrimaryConnectionTarget" && entry.enabled) return environmentId;
  }
  return null;
}

/**
 * Environments that are a thread's own sandbox, with the thread each belongs to. They belong to the
 * Sandboxes section, under their config, instead of the list of machines the user paired.
 */
export function useSandboxThreadEnvironmentIds(): ReadonlyMap<EnvironmentId, ThreadId> {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const list = useEnvironmentQuery(
    provisionerEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesList({
          environmentId: provisionerEnvironmentId,
          input: undefined,
        }),
  );
  return new Map(
    (list.data?.sandboxes ?? []).flatMap((sandbox) =>
      sandbox.threadId === undefined || sandbox.environmentId === null
        ? []
        : [[sandbox.environmentId, sandbox.threadId] as const],
    ),
  );
}

/**
 * Every environment that is a sandbox, launching ones included. They are a thread's machine, not one
 * the user keeps, so places that pick a machine to keep a project on leave them out.
 */
export function useSandboxEnvironmentIds(): ReadonlySet<EnvironmentId> {
  const sandboxes = useSandboxRecords();
  return new Set(
    sandboxes.flatMap((sandbox) =>
      sandbox.environmentId === null || sandbox.state === "deleted" ? [] : [sandbox.environmentId],
    ),
  );
}

/** `presentations` without the sandboxes in `sandboxEnvironmentIds`, or itself when none is in it. */
export function withoutSandboxes<T>(
  presentations: ReadonlyMap<EnvironmentId, T>,
  sandboxEnvironmentIds: ReadonlySet<EnvironmentId>,
): ReadonlyMap<EnvironmentId, T> {
  return [...presentations.keys()].some((id) => sandboxEnvironmentIds.has(id))
    ? new Map([...presentations].filter(([id]) => !sandboxEnvironmentIds.has(id)))
    : presentations;
}

/** A live sandbox as a follower of its host: never a choice, written to with it. */
export interface SandboxFollower {
  readonly environmentId: EnvironmentId;
  /** The host project the sandbox was launched for, and the sandbox's own clone of it. */
  readonly hostProjectId: ProjectId | null;
  readonly projectId: ProjectId | null;
}

export interface SandboxFollowers {
  readonly hostEnvironmentId: EnvironmentId | null;
  readonly followers: ReadonlyArray<SandboxFollower>;
  readonly environmentIds: ReadonlySet<EnvironmentId>;
  /** False until the host answers its sandbox list, when a sandbox looks like any remote. */
  readonly known: boolean;
}

/** Sandboxes as followers of the host that provisioned them; see `SandboxFollower`. */
export function useSandboxFollowers(): SandboxFollowers {
  const hostEnvironmentId = useSandboxProvisionerEnvironmentId();
  const list = useEnvironmentQuery(
    hostEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesList({ environmentId: hostEnvironmentId, input: undefined }),
  );
  const hostPhase = useEnvironmentPresentation(hostEnvironmentId).presentation?.connection.phase;
  const followers = (list.data?.sandboxes ?? NO_SANDBOXES).flatMap((sandbox) =>
    sandbox.environmentId === null || sandbox.state === "deleted"
      ? []
      : [
          {
            environmentId: sandbox.environmentId,
            hostProjectId: sandbox.projectId ?? sandbox.hostProjectId ?? null,
            projectId: sandbox.sandboxProjectId ?? null,
          },
        ],
  );
  return {
    hostEnvironmentId,
    followers,
    environmentIds: new Set(followers.map((follower) => follower.environmentId)),
    known:
      hostEnvironmentId === null ||
      list.data !== null ||
      list.error !== null ||
      hostPhase !== "connected",
  };
}

/**
 * Each thread row's sandbox (its provider, state and any resume under way), computed once per list
 * so a row reads it with one lookup; see `sandboxRowStates`.
 */
export function useSandboxRowStates(): (threadRef: ScopedThreadRef) => SandboxRowState | null {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const sandboxes = useSandboxRecords();
  return sandboxRowStates(sandboxes, provisionerEnvironmentId);
}

/**
 * The sandbox a thread runs on, from the provisioning server's list: the sandbox's own thread or
 * the host thread the bridge drives. Undefined for any other thread.
 */
export function useThreadSandbox(threadRef: ScopedThreadRef | null): SandboxRecord | undefined {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const list = useEnvironmentQuery(
    provisionerEnvironmentId === null || threadRef === null
      ? null
      : serverEnvironment.sandboxesList({
          environmentId: provisionerEnvironmentId,
          input: undefined,
        }),
  );
  return threadRef === null
    ? undefined
    : findThreadSandbox(list.data?.sandboxes ?? [], threadRef, provisionerEnvironmentId);
}

/** Whether the thread ran on a sandbox that is gone; see `isSandboxlessBridgeThread`. */
export function useSandboxlessBridgeThread(
  threadRef: ScopedThreadRef | null,
  instanceId: string | undefined,
): boolean {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const list = useEnvironmentQuery(
    provisionerEnvironmentId === null || threadRef === null
      ? null
      : serverEnvironment.sandboxesList({
          environmentId: provisionerEnvironmentId,
          input: undefined,
        }),
  );
  // The same subscription the thread's setup card reads, only for a bridge chat on the host.
  const launch = useEnvironmentQuery(
    provisionerEnvironmentId === null ||
      threadRef === null ||
      threadRef.environmentId !== provisionerEnvironmentId ||
      instanceId !== SANDBOX_BRIDGE_INSTANCE_ID
      ? null
      : serverEnvironment.sandboxesLaunchState({
          environmentId: provisionerEnvironmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
  return (
    threadRef !== null &&
    isSandboxlessBridgeThread({
      sandboxes: list.data?.sandboxes ?? null,
      threadRef,
      instanceId,
      provisionerEnvironmentId,
      launch:
        launch.data === undefined || launch.data === null
          ? launch.data
          : launch.data.threadId === threadRef.threadId
            ? launch.data
            : undefined,
    })
  );
}

/** The thread of each sandbox chat that its other thread stands for, by thread key; see `sandboxChatAliases`. */
export function useSandboxChatAliases(): ReadonlyMap<string, ScopedThreadRef> {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const threads = useQuietThreadShells();
  const sandboxes = useSandboxRecords();
  return sandboxChatAliases(sandboxes, threads, provisionerEnvironmentId);
}

/**
 * What every model picker on a sandbox chat's host mirror reads; see `sandboxMirrorPickerSource`.
 * Null for any other thread. The host's read is followed only while this app has no paired one.
 */
export function useSandboxMirrorModelSource(
  threadRef: ScopedThreadRef | null,
  thread: { readonly modelSelection: ModelSelection } | null | undefined,
) {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const threads = useQuietThreadShells();
  const sandboxes = useSandboxRecords();
  const providersByEnvironment = useEnvironmentProviders();
  const isMirror = threadRef !== null && thread != null && isSandboxMirrorThread(thread);
  const sandboxRef = isMirror
    ? sandboxHostMirrors(sandboxes, threads, provisionerEnvironmentId).get(threadKey(threadRef))
    : undefined;
  const sandboxThread =
    sandboxRef === undefined
      ? undefined
      : threads.find(
          (candidate) =>
            candidate.environmentId === sandboxRef.environmentId &&
            candidate.id === sandboxRef.threadId,
        );
  const paired =
    sandboxThread === undefined
      ? null
      : sandboxMirrorModelSource(
          sandboxThread.modelSelection,
          providersByEnvironment.get(sandboxThread.environmentId) ?? [],
        );
  const hostMirror = useAtomValue(
    serverEnvironment.sandboxesThreadMirrorValue(isMirror && paired === null ? threadRef : null),
  );
  if (!isMirror) return null;
  return sandboxMirrorPickerSource({
    paired,
    hostMirror,
    mirrorSelection: thread.modelSelection,
    hostProviders: providersByEnvironment.get(threadRef.environmentId) ?? [],
  });
}

const NO_SANDBOXES: ReadonlyArray<SandboxRecord> = [];

/** The provisioning server's sandbox records. */
export function useSandboxRecords(): ReadonlyArray<SandboxRecord> {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const list = useEnvironmentQuery(
    provisionerEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesList({
          environmentId: provisionerEnvironmentId,
          input: undefined,
        }),
  );
  return list.data?.sandboxes ?? NO_SANDBOXES;
}
