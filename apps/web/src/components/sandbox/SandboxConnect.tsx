import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { PlugZapIcon } from "lucide-react";

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

const CONNECT_FAILED = "Could not connect to the sandbox";
// How long a resumed sandbox gets to answer again before a send, un-settle or open gives up.
export const RESUME_WAIT_MS = 4 * 60_000;

export interface SandboxConnect {
  /** What a surface that needs the sandbox says while this client is not connected to it. */
  readonly reason: string;
  /** The sandbox is stopped, so connecting starts it first. */
  readonly resumes: boolean;
  /** This client's grant on the host lets it ask for a connection. */
  readonly allowed: boolean;
  readonly connecting: boolean;
  /** Why the last connect, the user's or this app's own, failed. */
  readonly failure: { readonly title: string; readonly description: string } | null;
  readonly connect: () => void;
}

/**
 * Pairs this client with a chat's sandbox through the host and saves it at the sandbox's current
 * address, recording the attempt for the chat's connect action. `resume` starts a stopped sandbox
 * first. Resolves to the failure, or null once connected or interrupted.
 */
export function useConnectSandbox() {
  const hostEnvironmentId = useSandboxProvisionerEnvironmentId();
  const connectThread = useAtomCommand(serverEnvironment.sandboxesConnectThread, {
    reportFailure: false,
  });
  const pairLaunch = useAtomCommand(serverEnvironment.sandboxesPairLaunch, {
    reportFailure: false,
  });
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const markConnected = useSandboxConnectionsStore((state) => state.markConnected);
  const setAttempt = useSandboxConnectionsStore((state) => state.setAttempt);

  const request = async (
    host: EnvironmentId,
    threadId: ThreadId,
    resume: boolean,
  ): Promise<unknown> => {
    const paired = await (resume ? connectThread : pairLaunch)({
      environmentId: host,
      input: { threadId },
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

  return async (
    sandbox: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
    resume: boolean,
  ): Promise<unknown> => {
    if (hostEnvironmentId === null) return null;
    setAttempt(sandbox.environmentId, { connecting: true, failure: null });
    const failure = await request(hostEnvironmentId, sandbox.threadId, resume);
    setAttempt(sandbox.environmentId, failure === null ? null : { connecting: false, failure });
    return failure;
  };
}

/**
 * Connecting this client to a sandbox chat's sandbox from the chat's host mirror. Once connected,
 * the sandbox's own thread lists and the chat moves to it (`sandboxChatAliases`). Null for any
 * thread that is not such a mirror, and once connected.
 */
export function useSandboxConnect(threadRef: ScopedThreadRef | null): SandboxConnect | null {
  const hostEnvironmentId = useSandboxProvisionerEnvironmentId();
  const sandbox = useThreadSandbox(threadRef);
  const sandboxEnvironmentId = sandbox?.environmentId ?? null;
  const environment = useEnvironment(sandboxEnvironmentId);
  const phase = environment?.connection.phase;
  const allowed = useAtomValue(
    serverEnvironment.sandboxesConnectThread.permissionAtom(hostEnvironmentId),
  );
  const connectSandbox = useConnectSandbox();
  const attempt = useSandboxConnectionsStore((state) =>
    sandboxEnvironmentId === null ? undefined : state.attempts.get(sandboxEnvironmentId),
  );

  const offer =
    threadRef === null ? null : sandboxConnectOffer(sandbox, threadRef, phase === "connected");
  if (
    offer === null ||
    threadRef === null ||
    hostEnvironmentId === null ||
    sandboxEnvironmentId === null
  ) {
    return null;
  }

  const connecting = attempt?.connecting === true || phase === "connecting";
  const connect = async () => {
    if (connecting) return;
    const failure = await connectSandbox(
      { environmentId: sandboxEnvironmentId, threadId: threadRef.threadId },
      true,
    );
    if (failure === null) return;
    const described = describeSandboxFailure(failure, CONNECT_FAILED);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: described.title,
        description: described.description,
      }),
    );
  };

  return {
    reason: allowed
      ? "Needs a connection to this chat's sandbox."
      : "Needs a connection to this chat's sandbox, which this device is not allowed to make.",
    resumes: offer.resumes,
    allowed,
    connecting,
    failure:
      attempt === undefined || attempt.connecting
        ? null
        : describeSandboxFailure(attempt.failure, CONNECT_FAILED),
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
      {state.failure === null ? null : (
        <p className="text-center text-destructive text-xs">
          {state.failure.title}: {state.failure.description}
        </p>
      )}
    </div>
  );
}
