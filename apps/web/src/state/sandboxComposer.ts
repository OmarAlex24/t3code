import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

import type { DraftId } from "../composerDraftStore";

// Composer options for sandbox configs ride in the machine picker beside real environments. The
// prefix cannot collide with a server-minted environment id.
const SANDBOX_OPTION_PREFIX = "sandbox-config:";

export const sandboxOptionId = (configId: string) =>
  `${SANDBOX_OPTION_PREFIX}${configId}` as EnvironmentId;

/** The config a picker value names, or null for a real environment. */
export const sandboxOptionConfigId = (id: string): string | null =>
  id.startsWith(SANDBOX_OPTION_PREFIX) ? id.slice(SANDBOX_OPTION_PREFIX.length) : null;

/**
 * A thread's sandbox holds a copy of the project's repository, so project grouping can put a new
 * draft on it. That machine belongs to its thread; any other draft has to leave it.
 */
export const isForeignSandbox = (
  owners: ReadonlyMap<EnvironmentId, ThreadId>,
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): boolean => {
  if (environmentId === null) return false;
  const owner = owners.get(environmentId);
  return owner !== undefined && owner !== threadId;
};

/** Whether the machine picker offers this environment: never another thread's sandbox. */
export const keepsSandboxEnvironment = (
  owners: ReadonlyMap<EnvironmentId, ThreadId>,
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): boolean => !isForeignSandbox(owners, environmentId, threadId);

interface SandboxComposerState {
  /** The sandbox config each unsent draft will launch on. */
  readonly selections: Readonly<Record<string, string>>;
  readonly select: (draftId: DraftId, configId: string | null) => void;
}

export const useSandboxComposerStore = create<SandboxComposerState>((set) => ({
  selections: {},
  select: (draftId, configId) =>
    set((state) => {
      const next = { ...state.selections };
      if (configId === null) delete next[draftId];
      else next[draftId] = configId;
      return { selections: next };
    }),
}));
