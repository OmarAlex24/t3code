import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { PlugZapIcon } from "lucide-react";
import { useState } from "react";

import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { useEnvironment } from "~/state/environments";
import { useSandboxConnectionsStore } from "~/state/sandboxConnections";
import { useSandboxProvisionerEnvironmentId, useThreadSandbox } from "~/state/sandboxes";
import { sandboxConnectOffer } from "~/state/sandboxThreads";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { describeSandboxFailure } from "../settings/SandboxStartLimits";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";

export interface SandboxConnect {
  /** What a surface that needs the sandbox says while this client is not connected to it. */
  readonly reason: string;
  /** The sandbox is stopped, so connecting starts it first. */
  readonly resumes: boolean;
  /** This client's grant on the host lets it ask for a connection. */
  readonly allowed: boolean;
  readonly connecting: boolean;
  readonly connect: () => void;
}

/**
 * Connecting this client to a sandbox chat's sandbox from the chat's host mirror. Once connected,
 * the sandbox's own thread lists and the chat moves to it (`sandboxChatAliases`). Null for any
 * thread that is not such a mirror, and once connected.
 */
export function useSandboxConnect(threadRef: ScopedThreadRef | null): SandboxConnect | null {
  const hostEnvironmentId = useSandboxProvisionerEnvironmentId();
  const sandbox = useThreadSandbox(threadRef);
  const environment = useEnvironment(sandbox?.environmentId ?? null);
  const phase = environment?.connection.phase;
  const allowed = useAtomValue(
    serverEnvironment.sandboxesConnectThread.permissionAtom(hostEnvironmentId),
  );
  const connectThread = useAtomCommand(serverEnvironment.sandboxesConnectThread, {
    reportFailure: false,
  });
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const markConnected = useSandboxConnectionsStore((state) => state.markConnected);
  const [requesting, setRequesting] = useState(false);

  const offer =
    threadRef === null ? null : sandboxConnectOffer(sandbox, threadRef, phase === "connected");
  if (offer === null || threadRef === null || hostEnvironmentId === null) return null;

  const fail = (error: unknown) => {
    const failure = describeSandboxFailure(error, "Could not connect to the sandbox");
    toastManager.add(
      stackedThreadToast({ type: "error", title: failure.title, description: failure.description }),
    );
  };

  const request = async (): Promise<unknown> => {
    const paired = await connectThread({
      environmentId: hostEnvironmentId,
      input: { threadId: threadRef.threadId },
    });
    if (paired._tag === "Failure") {
      return isAtomCommandInterrupted(paired) ? null : squashAtomCommandFailure(paired);
    }
    // The expected id lets a saved environment take the sandbox's current address.
    const registered = await connectPairing({
      host: paired.value.httpBaseUrl,
      pairingCode: paired.value.pairingCode,
      expectedEnvironmentId: paired.value.environmentId,
    });
    if (registered._tag === "Failure") {
      return isAtomCommandInterrupted(registered) ? null : squashAtomCommandFailure(registered);
    }
    markConnected(paired.value.environmentId);
    return null;
  };

  const connect = async () => {
    if (requesting) return;
    setRequesting(true);
    const error = await request();
    setRequesting(false);
    if (error !== null) fail(error);
  };

  return {
    reason: allowed
      ? "Needs a connection to this chat's sandbox."
      : "Needs a connection to this chat's sandbox, which this device is not allowed to make.",
    resumes: offer.resumes,
    allowed,
    connecting: requesting || phase === "connecting",
    connect: () => void connect(),
  };
}

/** The action that connects this client to the chat's sandbox, with what it will do. */
export function SandboxConnectAction(props: { readonly state: SandboxConnect }) {
  const { state } = props;
  if (!state.allowed) return null;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Button size="sm" variant="outline" disabled={state.connecting} onClick={state.connect}>
        {state.connecting ? <Spinner className="size-3.5" /> : <PlugZapIcon className="size-3.5" />}
        Connect to the sandbox
      </Button>
      <p className="text-center text-muted-foreground text-xs">
        {state.resumes
          ? "The sandbox is stopped, so this starts it first."
          : "Opens its terminal, files, diff and previews here."}
      </p>
    </div>
  );
}
