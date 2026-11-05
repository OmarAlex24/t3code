import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  type MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type RuntimeMode,
  SANDBOX_BRIDGE_INSTANCE_ID,
  SANDBOX_BRIDGE_MODEL,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { useStableCallback } from "../../hooks/useStableCallback";
import { useQuietThreadShells } from "../../state/entities";
import { useSandboxProvisionerEnvironmentId, useSandboxRecords } from "../../state/sandboxes";
import { sandboxMirrorOf } from "../../state/sandboxThreads";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

const bridgeModelSelection = {
  instanceId: ProviderInstanceId.make(SANDBOX_BRIDGE_INSTANCE_ID),
  model: SANDBOX_BRIDGE_MODEL,
} as ModelSelection;

// Links a launch made before the sandbox list caught up, so its first message is mirrored too.
const pendingLinks = new Map<string, ProjectId>();

/** Remembers a sandbox thread's host project from the launch, before the sandbox list says so. */
export const rememberSandboxMirror = (threadRef: ScopedThreadRef, hostProjectId: ProjectId) => {
  pendingLinks.set(threadKey(threadRef), hostProjectId);
};

export interface SandboxMirrorMessage {
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachmentCount: number;
  readonly title: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly createdAt: string;
}

/**
 * Copies a message sent on a sandbox thread to the host thread with its id, where the phone
 * follows it. The host thread's bridge finds the message already on the sandbox and streams its
 * answer instead of sending it again. The thread's modes go along, since the host's are the ones
 * the sandbox runs with.
 */
export function useSandboxMirrorSend() {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const sandboxes = useSandboxRecords();
  const threads = useQuietThreadShells();
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const setRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });

  return useStableCallback(async (threadRef: ScopedThreadRef, message: SandboxMirrorMessage) => {
    const pending = pendingLinks.get(threadKey(threadRef));
    const target =
      sandboxMirrorOf(sandboxes, threadRef, provisionerEnvironmentId) ??
      (pending === undefined || provisionerEnvironmentId === null
        ? null
        : {
            mirror: { environmentId: provisionerEnvironmentId, threadId: threadRef.threadId },
            hostProjectId: pending,
          });
    if (target === null) return;
    const { environmentId, threadId } = target.mirror;
    const existing = threads.find(
      (thread) => thread.environmentId === environmentId && thread.id === threadId,
    );
    if (existing !== undefined && existing.runtimeMode !== message.runtimeMode) {
      await setRuntimeMode({
        environmentId,
        input: { threadId, runtimeMode: message.runtimeMode, createdAt: message.createdAt },
      });
    }
    if (existing !== undefined && existing.interactionMode !== message.interactionMode) {
      await setInteractionMode({
        environmentId,
        input: { threadId, interactionMode: message.interactionMode, createdAt: message.createdAt },
      });
    }
    // Attachments stay on the sandbox; the phone sees that they were sent.
    const note =
      message.attachmentCount === 0
        ? ""
        : `(${message.attachmentCount} ${message.attachmentCount === 1 ? "attachment" : "attachments"} sent from the computer)`;
    const text = [message.text, note].filter((part) => part.length > 0).join("\n\n");
    const result = await startTurn({
      environmentId,
      input: {
        threadId,
        message: { messageId: message.messageId, role: "user", text, attachments: [] },
        runtimeMode: message.runtimeMode,
        interactionMode: message.interactionMode,
        dispatchMode: "queue",
        ...(existing !== undefined
          ? {}
          : {
              titleSeed: message.title,
              modelSelection: bridgeModelSelection,
              bootstrap: {
                createThread: {
                  projectId: target.hostProjectId,
                  title: message.title,
                  modelSelection: bridgeModelSelection,
                  runtimeMode: message.runtimeMode,
                  interactionMode: message.interactionMode,
                  branch: null,
                  worktreePath: null,
                  createdAt: message.createdAt,
                },
              },
            }),
      },
    });
    if (result._tag === "Success") {
      pendingLinks.delete(threadKey(threadRef));
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Your phone may not see this message",
        description:
          "It reached the sandbox, but T3 Code could not copy it to this computer's thread for the phone.",
      }),
    );
  });
}
