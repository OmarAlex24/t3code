import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type ThreadViewMode = "chat" | "milestones";

/** A timeline entry the chat view brings into view and highlights once it mounts. */
export interface ThreadChatReveal {
  readonly threadKey: string;
  readonly entryId: string;
  readonly requestId: number;
}

interface ThreadViewModeState {
  byThreadKey: Record<string, ThreadViewMode>;
  /** New threads open in the view used last. */
  lastUsed: ThreadViewMode;
  reveal: ThreadChatReveal | null;
  setMode: (ref: ScopedThreadRef, mode: ThreadViewMode) => void;
  toggle: (ref: ScopedThreadRef) => void;
  /** Switches the thread to Chat and asks it to reveal `entryId`. */
  revealInChat: (ref: ScopedThreadRef, entryId: string) => void;
  finishReveal: (requestId: number) => void;
}

export const useThreadViewModeStore = create<ThreadViewModeState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      lastUsed: "chat",
      reveal: null,
      // A reveal left pending (its history page never landed) must not fire on a later visit.
      setMode: (ref, mode) =>
        set((state) => ({
          byThreadKey: { ...state.byThreadKey, [scopedThreadKey(ref)]: mode },
          lastUsed: mode,
          reveal: null,
        })),
      toggle: (ref) =>
        get().setMode(ref, selectThreadViewMode(get(), ref) === "chat" ? "milestones" : "chat"),
      revealInChat: (ref, entryId) => {
        get().setMode(ref, "chat");
        set((state) => ({
          reveal: {
            threadKey: scopedThreadKey(ref),
            entryId,
            requestId: (state.reveal?.requestId ?? 0) + 1,
          },
        }));
      },
      finishReveal: (requestId) =>
        set((state) => (state.reveal?.requestId === requestId ? { reveal: null } : state)),
    }),
    {
      name: "t3code:thread-view-mode:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey, lastUsed: state.lastUsed }),
    },
  ),
);

export function selectThreadViewMode(
  state: Pick<ThreadViewModeState, "byThreadKey" | "lastUsed">,
  ref: ScopedThreadRef | null,
): ThreadViewMode {
  if (ref === null) return "chat";
  return state.byThreadKey[scopedThreadKey(ref)] ?? state.lastUsed;
}
