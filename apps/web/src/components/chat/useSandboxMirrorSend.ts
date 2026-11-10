import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  type MessageId,
  type ModelSelection,
  type OrchestrationV2RunStatus,
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

const bridgeInstanceId = ProviderInstanceId.make(SANDBOX_BRIDGE_INSTANCE_ID);

/** The sandbox thread's model as the bridge carries it: its slug and options, on the bridge. */
const mirrorModelSelection = (selection: ModelSelection): ModelSelection =>
  selection.instanceId === bridgeInstanceId
    ? selection
    : ({
        instanceId: bridgeInstanceId,
        model: selection.model || SANDBOX_BRIDGE_MODEL,
        ...(selection.options === undefined ? {} : { options: selection.options }),
      } as ModelSelection);

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
  /** The sandbox thread's model for this message; the phone's picker shows it on the mirror. */
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
}

/**
 * Copies a message sent on a sandbox thread to the host thread with its id, where the phone
 * follows it. The host thread's bridge finds the message already on the sandbox and streams its
 * answer instead of sending it again. The thread's modes go along, since the host's are the ones
 * the sandbox runs with, and so does its model, or the phone's next message would send the old one.
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
    // A send on the host's mirror is already the phone's copy, and its run delivers it to the
    // sandbox; copying it again would send it twice.
    if (threadRef.environmentId === provisionerEnvironmentId) return;
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
    const modelSelection = mirrorModelSelection(message.modelSelection);
    const result = await startTurn({
      environmentId,
      input: {
        threadId,
        message: { messageId: message.messageId, role: "user", text, attachments: [] },
        runtimeMode: message.runtimeMode,
        interactionMode: message.interactionMode,
        dispatchMode: "queue",
        modelSelection,
        ...(existing !== undefined
          ? {}
          : {
              titleSeed: message.title,
              bootstrap: {
                createThread: {
                  projectId: target.hostProjectId,
                  title: message.title,
                  modelSelection,
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

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * Applies a mode picked on a sandbox thread at once, to it and its host mirror, since the phone
 * sends with the mirror's modes. Resolves true once the sandbox's thread has it; false for any
 * other thread, on failure, or while it waits for the sandbox's run to end.
 */
export function useSandboxModeSync() {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const sandboxes = useSandboxRecords();
  const threads = useQuietThreadShells();
  const setRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });

  return useStableCallback(
    async (
      threadRef: ScopedThreadRef,
      modes:
        | { readonly runtimeMode: RuntimeMode }
        | { readonly interactionMode: ProviderInteractionMode },
    ): Promise<boolean> => {
      const target = sandboxMirrorOf(sandboxes, threadRef, provisionerEnvironmentId);
      if (target === null) return false;
      const mirrorListed = threads.some(
        (thread) =>
          thread.environmentId === target.mirror.environmentId &&
          thread.id === target.mirror.threadId,
      );
      const createdAt = new Date().toISOString();
      const apply = (ref: ScopedThreadRef) => {
        const input = { threadId: ref.threadId, createdAt };
        return "runtimeMode" in modes
          ? setRuntimeMode({
              environmentId: ref.environmentId,
              input: { ...input, runtimeMode: modes.runtimeMode },
            })
          : setInteractionMode({
              environmentId: ref.environmentId,
              input: { ...input, interactionMode: modes.interactionMode },
            });
      };
      // A sandbox cuts its agent's run short when its runtime mode changes. Full access mid-run
      // goes through the mirror instead: the computer grants what is waiting at once and moves
      // the sandbox's thread when the run ends, and the composer keeps showing the pick.
      const own = threads.find(
        (thread) =>
          thread.environmentId === threadRef.environmentId && thread.id === threadRef.threadId,
      );
      if (
        mirrorListed &&
        "runtimeMode" in modes &&
        modes.runtimeMode === "full-access" &&
        own?.latestRun != null &&
        ACTIVE_RUN_STATUSES.has(own.latestRun.status)
      ) {
        await apply(target.mirror);
        return false;
      }
      const [result] = await Promise.all([
        apply(threadRef),
        ...(mirrorListed ? [apply(target.mirror)] : []),
      ]);
      return result._tag === "Success";
    },
  );
}
