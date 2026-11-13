import { useAtomValue } from "@effect/atom-react";
import {
  isSandboxMirrorThread,
  sandboxMirrorPickerSource,
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
 * What a mirror's model picker reads: the sandbox's provider and selection, or the mirror's own
 * pick alone, read-only, until the host has read them; see `sandboxMirrorPickerSource`. Any other
 * thread keeps its own config and pick (a null selection).
 */
export function sandboxMirrorPicker(
  mirror: SandboxThreadMirror | null,
  config: ServerConfig | null,
  thread: { readonly modelSelection: ModelSelection } | null | undefined,
): {
  readonly config: ServerConfig | null;
  readonly modelSelection: ModelSelection | null;
  readonly readOnly: boolean;
} {
  if (config === null || thread == null || !isSandboxMirrorThread(thread)) {
    return { config, modelSelection: null, readOnly: false };
  }
  const source = sandboxMirrorPickerSource({
    paired: null,
    hostMirror: mirror,
    mirrorSelection: thread.modelSelection,
    hostProviders: config.providers,
  });
  return {
    config: { ...config, providers: source.providers },
    modelSelection: source.modelSelection,
    readOnly: source.readOnly,
  };
}
