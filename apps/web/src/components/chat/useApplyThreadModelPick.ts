import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isSandboxMirrorThread } from "@t3tools/client-runtime/state/sandbox-mirror";
import { useContext } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { useQuietThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useSandboxProvisionerEnvironmentId, useSandboxRecords } from "../../state/sandboxes";
import { sandboxChatPickPartner, sandboxHostMirrors } from "../../state/sandboxThreads";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Sets an existing thread's composer pick on the thread, so any next turn runs on it. A sandbox
 * chat's other thread takes it too (see `sandboxChatPickPartner`).
 */
export function useApplyThreadModelPick() {
  const registry = useContext(RegistryContext);
  const setModelSelection = useOrchestrationCommand(threadEnvironment.setModelSelection, {
    label: "change model",
  });
  // A mirror whose sandbox thread this app does not list sets it through the host, as the phone does.
  const setSandboxMirrorModel = useOrchestrationCommand(serverEnvironment.sandboxesSetThreadModel, {
    label: "change model",
  });
  // A stopped sandbox's thread takes the pick from the bridge with the next message instead.
  const setPartnerModelSelection = useOrchestrationCommand(threadEnvironment.setModelSelection, {
    reportFailure: false,
  });
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const sandboxes = useSandboxRecords();
  const threads = useQuietThreadShells();
  return async (target: ComposerThreadTarget) => {
    if (typeof target === "string") return;
    const store = useComposerDraftStore.getState();
    const draft = store.draftsByThreadKey[scopedThreadKey(target)];
    if (!draft?.modelSelectionExplicit || !draft.activeProvider) return;
    const pick = draft.modelSelectionByProvider[draft.activeProvider];
    const thread = registry.get(environmentThreadShells.threadShellAtom(target));
    if (!pick || !thread || store.draftThreadsByThreadKey[scopedThreadKey(target)]) return;
    // Another instance replaces the live session, which may hold an open question; that pick
    // still waits for a sent message.
    if (pick.instanceId !== thread.modelSelection.instanceId) return;
    const partner = sandboxChatPickPartner(
      sandboxHostMirrors(sandboxes, threads, provisionerEnvironmentId),
      threads,
      target,
      pick,
    );
    const input = { threadId: target.threadId, modelSelection: pick };
    const [result, partnerResult] = await Promise.all([
      partner === null && isSandboxMirrorThread(thread)
        ? setSandboxMirrorModel({ environmentId: target.environmentId, input })
        : setModelSelection({ environmentId: target.environmentId, input }),
      partner === null
        ? null
        : setPartnerModelSelection({
            environmentId: partner.ref.environmentId,
            input: { threadId: partner.ref.threadId, modelSelection: partner.modelSelection },
          }),
    ]);
    // Until both threads have it, the composer keeps showing the pick and sends it.
    if (result._tag === "Success" && partnerResult?._tag !== "Failure") {
      useComposerDraftStore.getState().releaseModelSelection(target, pick);
    } else if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not apply model selection",
          description: `This model pick was not saved. ${error instanceof Error ? error.message : "Try again."}`,
        }),
      );
    }
  };
}
