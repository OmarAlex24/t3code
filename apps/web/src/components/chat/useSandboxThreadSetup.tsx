import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { useEnvironmentQuery } from "../../state/query";
import { useSandboxProvisionerEnvironmentId } from "../../state/sandboxes";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeSandboxFailure } from "../settings/SandboxStartLimits";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SandboxSetupCard } from "./SandboxSetupCard";

/**
 * The setup card of a sandbox chat's host thread while its sandbox launches: the thread's first
 * message waits under it and goes out on its own once the sandbox is ready. Null for any other
 * thread, and once the launch is done, since the thread then shows the sandbox's work.
 */
export function useSandboxThreadSetup(threadRef: ScopedThreadRef | null): ReactNode {
  const hostEnvironmentId = useSandboxProvisionerEnvironmentId();
  const onHost =
    threadRef !== null &&
    hostEnvironmentId !== null &&
    threadRef.environmentId === hostEnvironmentId;
  const snapshotQuery = useEnvironmentQuery(
    !onHost
      ? null
      : serverEnvironment.sandboxesLaunchState({
          environmentId: hostEnvironmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
  const cancelLaunch = useAtomCommand(serverEnvironment.sandboxesCancelLaunch, {
    reportFailure: false,
  });
  const retryLaunch = useAtomCommand(serverEnvironment.sandboxesRetryLaunch, {
    reportFailure: false,
  });
  const navigate = useNavigate();
  const snapshot =
    onHost && snapshotQuery.data?.threadId === threadRef.threadId ? snapshotQuery.data : null;

  const target =
    !onHost || hostEnvironmentId === null
      ? null
      : { environmentId: hostEnvironmentId, input: { threadId: threadRef.threadId } };
  const cancel = useStableCallback(() => {
    if (target !== null) void cancelLaunch(target);
  });
  // The host retries the stage that failed, or starts a new sandbox; the message waits again.
  const retry = useStableCallback(() => {
    if (target === null) return;
    void retryLaunch(target).then((result) => {
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const failure = describeSandboxFailure(
        squashAtomCommandFailure(result),
        "Could not retry the sandbox",
      );
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failure.title,
          description: failure.description,
        }),
      );
    });
  });

  if (snapshot === null || (snapshot.phase !== "running" && snapshot.phase !== "failed")) {
    return null;
  }
  return (
    <SandboxSetupCard
      snapshot={snapshot}
      onCancel={cancel}
      onRetry={retry}
      onDismiss={cancel}
      onSetUpTailscale={() => {
        void navigate({ to: "/settings/connections", hash: "sandbox-tailscale" });
      }}
    />
  );
}
