import { useSyncExternalStore } from "react";

/**
 * Messages waiting on a stopped sandbox to resume, by the thread key they were sent on. Each
 * message stays in its thread's composer draft until that thread's chat sends it, so one chat's
 * wait never shows on, or sends from, another, and several sandboxes can resume at once. Kept
 * outside the chat view, which the app reuses from thread to thread.
 */
let pending: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const publish = (next: ReadonlySet<string>) => {
  pending = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Marks the thread's message as waiting for its sandbox; false if one already waits there. */
export const beginSandboxResend = (threadKey: string): boolean => {
  if (pending.has(threadKey)) return false;
  publish(new Set([...pending, threadKey]));
  return true;
};

/** Clears the thread's wait, once its message sends or its sandbox does not come back. */
export const endSandboxResend = (threadKey: string) => {
  if (!pending.has(threadKey)) return;
  const next = new Set(pending);
  next.delete(threadKey);
  publish(next);
};

export const isSandboxResendPending = (threadKey: string) => pending.has(threadKey);

/** Whether a message on this thread waits for its sandbox to resume. */
export function useSandboxResendPending(threadKey: string | null): boolean {
  return useSyncExternalStore(subscribe, () => threadKey !== null && pending.has(threadKey));
}
