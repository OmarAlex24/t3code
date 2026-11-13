import { useAtomValue } from "@effect/atom-react";
import { isSandboxMirrorThread } from "@t3tools/client-runtime/state/sandbox-mirror";
import type { SandboxSettleDecision } from "@t3tools/client-runtime/state/sandbox-settle";
import type { EnvironmentId, ModelSelection, ThreadId } from "@t3tools/contracts";

import { serverEnvironment } from "./server";

/**
 * The keep-or-delete decision the host waits on after this sandbox chat settled; null for any
 * other thread, which reads no sandbox list.
 */
export function useSandboxSettleDecision(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly modelSelection: Pick<ModelSelection, "instanceId">;
  } | null,
): SandboxSettleDecision | null {
  return useAtomValue(
    serverEnvironment.sandboxesSettleDecision(
      thread !== null && isSandboxMirrorThread(thread)
        ? { environmentId: thread.environmentId, threadId: thread.id }
        : null,
    ),
  );
}
