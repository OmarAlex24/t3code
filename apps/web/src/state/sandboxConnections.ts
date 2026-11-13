import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

interface SandboxConnectionsState {
  /** Sandboxes this app was disconnected from, which it does not pair with again on its own. */
  readonly disconnected: ReadonlyArray<EnvironmentId>;
  readonly markDisconnected: (environmentId: EnvironmentId) => void;
  readonly markConnected: (environmentId: EnvironmentId) => void;
}

export const useSandboxConnectionsStore = create<SandboxConnectionsState>()(
  persist(
    (set) => ({
      disconnected: [],
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
