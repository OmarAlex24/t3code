import { useAtomValue } from "@effect/atom-react";
import {
  isSandboxMirrorThread,
  sandboxMirrorModelSourceOf,
} from "@t3tools/client-runtime/state/sandbox-mirror";
import type {
  EnvironmentId,
  ModelSelection,
  SandboxThreadMirror,
  ServerConfig,
  ThreadId,
} from "@t3tools/contracts";

import { serverEnvironment } from "./server";

type MirrorTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/**
 * A sandbox chat's own thread as the host reads it, for its mirror thread here; null for any other
 * thread, and until the host has read it. The phone never pairs with the sandbox.
 */
export function useSandboxMirror(
  target: MirrorTarget | null,
  thread: { readonly modelSelection: Pick<ModelSelection, "instanceId"> } | null | undefined,
): SandboxThreadMirror | null {
  return useAtomValue(
    serverEnvironment.sandboxesThreadMirrorValue(
      target !== null && thread != null && isSandboxMirrorThread(thread) ? target : null,
    ),
  );
}

/**
 * What a mirror's model picker reads: the sandbox's provider in place of the bridge's shared list,
 * and the sandbox's selection (null for any other thread, which keeps its own config and pick).
 */
export function sandboxMirrorPicker(
  mirror: SandboxThreadMirror | null,
  config: ServerConfig | null,
): { readonly config: ServerConfig | null; readonly modelSelection: ModelSelection | null } {
  const source = sandboxMirrorModelSourceOf(mirror);
  return source === null || config === null
    ? { config, modelSelection: null }
    : { config: { ...config, providers: source.providers }, modelSelection: source.modelSelection };
}
