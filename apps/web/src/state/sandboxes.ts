import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProjectId,
  ProviderInstanceId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  type SandboxProviderKind,
  type SandboxRecord,
  type ScopedThreadRef,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { useProjects, useQuietThreadShells } from "./entities";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "./environments";
import { useEnvironmentQuery } from "./query";
import {
  findThreadSandbox,
  isSandboxlessBridgeThread,
  providerInstanceReady,
  sandboxHostMirrors,
} from "./sandboxThreads";
import { serverEnvironment } from "./server";

const NO_SETTINGS = Atom.make<ServerSettings | null>(null);

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

/**
 * The provider of each live sandbox, by its environment, so a list of threads can draw a sandbox
 * thread's machine as its provider's mark with one lookup per row.
 */
export function useSandboxProviderByEnvironmentId(): ReadonlyMap<
  EnvironmentId,
  SandboxProviderKind
> {
  const sandboxes = useSandboxRecords();
  return new Map(
    sandboxes.flatMap((sandbox) =>
      sandbox.environmentId === null || sandbox.state === "deleted"
        ? []
        : [[sandbox.environmentId, sandbox.provider] as const],
    ),
  );
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
  return (
    threadRef !== null &&
    isSandboxlessBridgeThread({
      sandboxes: list.data?.sandboxes ?? null,
      threadRef,
      instanceId,
      provisionerEnvironmentId,
    })
  );
}

/** The host's mirrors of sandbox threads, by thread key; see `sandboxHostMirrors`. */
export function useSandboxHostMirrors(): ReadonlyMap<string, ScopedThreadRef> {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const threads = useQuietThreadShells();
  const sandboxes = useSandboxRecords();
  return sandboxHostMirrors(sandboxes, threads, provisionerEnvironmentId);
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

/** Whether a project's composer can send on `instanceId` with `model`; see `providerInstanceReady`. */
export function useProviderInstanceReady(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  instanceId: ProviderInstanceId,
  model: string | null,
): boolean {
  const providersByEnvironment = useEnvironmentProviders();
  const settings = useAtomValue(
    environmentId === null ? NO_SETTINGS : serverEnvironment.settingsValueAtom(environmentId),
  );
  const projects = useProjects();
  if (environmentId === null || projectId === null || model === null) return false;
  return providerInstanceReady({
    providers: providersByEnvironment.get(environmentId) ?? [],
    settings,
    projects,
    environmentId,
    projectId,
    instanceId,
    model,
  });
}

const bridgeInstanceId = ProviderInstanceId.make(SANDBOX_BRIDGE_INSTANCE_ID);

/** Whether a host project can send through the sandbox bridge yet. */
export const useSandboxBridgeReady = (
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  model: string | null,
): boolean => useProviderInstanceReady(environmentId, projectId, bridgeInstanceId, model);
