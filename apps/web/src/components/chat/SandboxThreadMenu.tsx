import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CloudIcon,
  ExternalLinkIcon,
  PlayIcon,
  SquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useEnvironmentQuery } from "~/state/query";
import { useSandboxProvisionerEnvironmentId } from "~/state/sandboxes";
import {
  deleteThreadSandbox,
  ensureSandboxThreadRunning,
  findThreadSandbox,
  isHostThreadRef,
  retentionWarning,
  shortSandboxId,
  stoppedDiskAge,
} from "~/state/sandboxThreads";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { SandboxProviderLogo } from "../settings/SandboxProviderLogo";
import { describeSandboxFailure } from "../settings/SandboxStartLimits";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";

const STATE_LABEL: Record<string, string> = {
  provisioning: "Starting",
  running: "Running",
  stopped: "Stopped",
  error: "Needs attention",
  expired: "Disk expired",
  deleted: "Deleted outside T3 Code",
};

const STATE_DOT: Record<string, string> = {
  provisioning: "bg-warning",
  running: "bg-success",
  stopped: "bg-muted-foreground/50",
  error: "bg-destructive",
  expired: "bg-destructive",
  deleted: "bg-destructive",
};

const days = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;

/**
 * The thread's own sandbox, from its header: what state it is in, stop or resume it, delete it,
 * or find it in the Sandboxes list. On the host thread the bridge drives, it also opens the
 * sandbox's own thread, where its files, diffs and terminals are. Renders nothing for a thread
 * that has no sandbox.
 */
export function SandboxThreadMenu({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const list = useEnvironmentQuery(
    provisionerEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesList({
          environmentId: provisionerEnvironmentId,
          input: undefined,
        }),
  );
  const providersQuery = useEnvironmentQuery(
    provisionerEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesProviders({
          environmentId: provisionerEnvironmentId,
          input: undefined,
        }),
  );
  const stopSandbox = useAtomCommand(serverEnvironment.sandboxesStop, { reportFailure: false });
  const navigate = useNavigate();
  const minute = useNowMinute();
  const [pending, setPending] = useState(false);
  const sandbox = findThreadSandbox(
    list.data?.sandboxes ?? [],
    threadRef,
    provisionerEnvironmentId,
  );
  if (sandbox === undefined || provisionerEnvironmentId === null) return null;
  const provider = providersQuery.data?.providers.find(
    (candidate) => candidate.kind === sandbox.provider,
  );
  const providerLabel = provider?.label ?? sandbox.provider;
  const nowMillis = Date.parse(`${minute}:00.000Z`);
  const { stoppedDays, retentionDays, nearRetention } = stoppedDiskAge(
    sandbox,
    provider,
    nowMillis,
  );
  const canStopResume = provider?.capabilities.stopResume ?? true;
  const short = shortSandboxId(sandbox.sandboxId);
  const sandboxThreadEnvironmentId = isHostThreadRef(sandbox, threadRef)
    ? sandbox.environmentId
    : null;
  const status =
    sandbox.state === "stopped" && stoppedDays !== null
      ? `Stopped ${stoppedDays === 0 ? "today" : `${days(stoppedDays)} ago`}`
      : (STATE_LABEL[sandbox.state] ?? sandbox.state);

  const stop = async () => {
    setPending(true);
    const result = await stopSandbox({
      environmentId: provisionerEnvironmentId,
      input: { instanceId: sandbox.instanceId },
    });
    setPending(false);
    void list.refresh();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = describeSandboxFailure(
        squashAtomCommandFailure(result),
        "Could not stop the sandbox",
      );
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failure.title,
          description: failure.description,
        }),
      );
    }
  };

  const resume = async () => {
    setPending(true);
    await ensureSandboxThreadRunning(threadRef);
    setPending(false);
    void list.refresh();
  };

  return (
    <Menu>
      <MenuTrigger
        aria-label={`Sandbox ${short}: ${status}`}
        render={<Button size="xs" variant="ghost-muted" className="shrink-0" />}
      >
        <SandboxProviderLogo kind={sandbox.provider} />
        {short}
        <ConnectionStatusDot
          tooltipText={status}
          dotClassName={STATE_DOT[sandbox.state] ?? "bg-muted-foreground/50"}
        />
        {nearRetention ? (
          <TriangleAlertIcon aria-hidden className="size-3 text-warning-foreground" />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" className="w-72">
        <div className="px-2 py-1.5">
          <p className="text-xs font-medium text-foreground">
            {providerLabel} sandbox {short}
          </p>
          <p className="text-xs text-muted-foreground">{status}</p>
          {nearRetention && retentionDays !== undefined && stoppedDays !== null ? (
            <p className="mt-1.5 text-xs text-warning-foreground">
              {retentionWarning(providerLabel, retentionDays, stoppedDays)}
            </p>
          ) : null}
        </div>
        <MenuSeparator />
        <MenuGroup>
          {canStopResume && (sandbox.state === "running" || sandbox.state === "error") ? (
            <MenuItem disabled={pending} onClick={() => void stop()}>
              <SquareIcon aria-hidden className="size-3 fill-current" />
              Stop and keep its disk
            </MenuItem>
          ) : null}
          {canStopResume && sandbox.state === "stopped" ? (
            <MenuItem disabled={pending} onClick={() => void resume()}>
              <PlayIcon aria-hidden className="size-3 fill-current" />
              Resume
            </MenuItem>
          ) : null}
          {sandboxThreadEnvironmentId === null ? null : (
            <MenuItem
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: {
                    environmentId: sandboxThreadEnvironmentId,
                    threadId: threadRef.threadId,
                  },
                })
              }
            >
              <CloudIcon aria-hidden className="size-3.5" />
              Open sandbox thread
            </MenuItem>
          )}
          <MenuItem
            onClick={() => void navigate({ to: "/settings/connections", hash: "sandboxes" })}
          >
            <ExternalLinkIcon aria-hidden className="size-3.5" />
            Open in Sandboxes list
          </MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={() => void deleteThreadSandbox(threadRef)}>
            <Trash2Icon aria-hidden className="size-3.5" />
            Delete sandbox…
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
