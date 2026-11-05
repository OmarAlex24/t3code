import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectId,
  SandboxRecord,
  ScopedThreadRef,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { useProjects, useQuietThreadShells } from "./entities";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "./environments";
import { useEnvironmentQuery } from "./query";
import { findThreadSandbox, sandboxBridgeReady, sandboxHostMirrors } from "./sandboxThreads";
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

/** Whether a host project can send through the sandbox bridge yet; see `sandboxBridgeReady`. */
export function useSandboxBridgeReady(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  model: string | null,
): boolean {
  const providersByEnvironment = useEnvironmentProviders();
  const settings = useAtomValue(
    environmentId === null ? NO_SETTINGS : serverEnvironment.settingsValueAtom(environmentId),
  );
  const projects = useProjects();
  if (environmentId === null || projectId === null || model === null) return false;
  return sandboxBridgeReady({
    providers: providersByEnvironment.get(environmentId) ?? [],
    settings,
    projects,
    environmentId,
    projectId,
    model,
  });
}
