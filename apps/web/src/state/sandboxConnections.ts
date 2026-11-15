import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

/** A connect to a chat's sandbox, the user's or this app's own, while it runs or after it failed. */
export interface SandboxConnectAttempt {
  readonly connecting: boolean;
  readonly failure: unknown;
}

interface SandboxConnectionsState {
  /** Sandboxes this app was disconnected from, which it does not pair with again on its own. */
  readonly disconnected: ReadonlyArray<EnvironmentId>;
  readonly attempts: ReadonlyMap<EnvironmentId, SandboxConnectAttempt>;
  readonly markDisconnected: (environmentId: EnvironmentId) => void;
  readonly markConnected: (environmentId: EnvironmentId) => void;
  readonly setAttempt: (
    environmentId: EnvironmentId,
    attempt: SandboxConnectAttempt | null,
  ) => void;
}

export const useSandboxConnectionsStore = create<SandboxConnectionsState>()(
  persist(
    (set) => ({
      disconnected: [],
      attempts: new Map(),
      markDisconnected: (environmentId) =>
        set((state) =>
          state.disconnected.includes(environmentId)
            ? state
            : { disconnected: [...state.disconnected, environmentId] },
        ),
      markConnected: (environmentId) =>
        set((state) =>
          state.disconnected.includes(environmentId)
            ? { disconnected: state.disconnected.filter((id) => id !== environmentId) }
            : state,
        ),
      setAttempt: (environmentId, attempt) =>
        set((state) => {
          const attempts = new Map(state.attempts);
          if (attempt === null) attempts.delete(environmentId);
          else attempts.set(environmentId, attempt);
          return { attempts };
        }),
    }),
    {
      name: "t3code:sandbox-connections:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ disconnected }) => ({ disconnected }),
    },
  ),
);
