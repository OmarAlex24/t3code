import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type SandboxCheckWorkResult,
  type SandboxEnvironmentConfig,
  type SandboxProviderInfo,
  type SandboxRecord,
  type SandboxSettleAction,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useThreadShells } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useSandboxProvisionerEnvironmentId } from "~/state/sandboxes";
import {
  findThreadSandbox,
  isBridgedSandbox,
  isHostThreadRef,
  registerSandboxThreadHandlers,
  shortSandboxId,
} from "~/state/sandboxThreads";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { describeSandboxFailure } from "../settings/SandboxStartLimits";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";

// How long a resumed sandbox gets to answer again before a send or un-settle gives up.
const RESUME_WAIT_MS = 4 * 60_000;

type DeleteReason = "settle" | "thread" | "menu";

type Prompt =
  | {
      readonly kind: "settle";
      readonly id: number;
      readonly threadRef: ScopedThreadRef;
      readonly sandbox: SandboxRecord;
      readonly bridged: boolean;
    }
  | {
      readonly kind: "delete";
      readonly id: number;
      readonly threadRef: ScopedThreadRef;
      readonly sandbox: SandboxRecord;
      readonly reason: DeleteReason;
      readonly bridged: boolean;
      readonly work: SandboxCheckWorkResult | null;
      readonly deleteThread?: () => Promise<{ readonly _tag: string }>;
      readonly done: () => void;
    };

const describeWork = (work: SandboxCheckWorkResult) => {
  if (work.status === "clean") return "No uncommitted or unpushed work.";
  if (work.status === "unknown") {
    return `Couldn't check for unpushed work. ${work.detail ?? ""}`.trim();
  }
  const parts = [
    ...(work.uncommittedFiles === 0
      ? []
      : [`${work.uncommittedFiles} uncommitted ${work.uncommittedFiles === 1 ? "file" : "files"}`]),
    ...(work.unpushedCommits === 0
      ? []
      : [`${work.unpushedCommits} unpushed ${work.unpushedCommits === 1 ? "commit" : "commits"}`]),
  ];
  return `${parts.join(" and ")} would be lost.`;
};

const deleteDescription = (
  prompt: Extract<Prompt, { kind: "delete" }>,
  short: string,
  providerLabel: string,
) => {
  if (!prompt.bridged) {
    return `${
      prompt.reason === "thread"
        ? `Also deletes sandbox ${short} on ${providerLabel}.`
        : `This deletes the machine and its disk on ${providerLabel}.`
    } The conversation lives on the sandbox, so it is deleted too.`;
  }
  if (prompt.reason !== "thread") {
    return `This deletes the machine and its disk on ${providerLabel}. The conversation stays in this thread on this computer; work only on the sandbox's disk is lost.`;
  }
  return isHostThreadRef(prompt.sandbox, prompt.threadRef)
    ? `Also deletes sandbox ${short} on ${providerLabel}, with its disk and its copy of this thread.`
    : `Also deletes sandbox ${short} on ${providerLabel}. The conversation stays in the thread on this computer.`;
};

/**
 * Settling, resuming and deleting a thread's own sandbox. Mounted once; the thread actions reach
 * it through `sandboxThreads.ts`, since every settle and delete path goes through them.
 *
 * A bridged thread keeps its conversation in the host thread, so deleting its sandbox loses only
 * the sandbox's disk. A legacy thread lives only on its sandbox and goes with it.
 */
export function SandboxThreadCoordinator() {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const list = useEnvironmentQuery(
    provisionerEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesList({
          environmentId: provisionerEnvironmentId,
          input: undefined,
        }),
  );
  const configsQuery = useEnvironmentQuery(
    provisionerEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesConfigs({
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
  const resumeSandbox = useAtomCommand(serverEnvironment.sandboxesResume, {
    reportFailure: false,
  });
  const deleteSandbox = useAtomCommand(serverEnvironment.sandboxesDelete, {
    reportFailure: false,
  });
  const checkWork = useAtomCommand(serverEnvironment.sandboxesCheckWork, {
    reportFailure: false,
  });
  const saveConfig = useAtomCommand(serverEnvironment.sandboxesSaveConfig, {
    reportFailure: false,
  });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const deleteRemoteThread = useOrchestrationCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const { entries } = useAtomValue(environmentCatalog.catalogValueAtom);
  const { environments } = useEnvironments();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const [prompts, setPrompts] = useState<ReadonlyArray<Prompt>>([]);
  // The prompt that just closed, so the dialog keeps its text while it animates out.
  const [closing, setClosing] = useState<Prompt | null>(null);
  const nextId = useRef(0);
  const waiters = useRef(new Map<EnvironmentId, Array<() => void>>());

  const sandboxes = list.data?.sandboxes ?? [];
  const configs = configsQuery.data?.configs ?? [];
  const providers = providersQuery.data?.providers ?? [];
  const providerOf = (sandbox: SandboxRecord): SandboxProviderInfo | undefined =>
    providers.find((candidate) => candidate.kind === sandbox.provider);
  const configOf = (sandbox: SandboxRecord): SandboxEnvironmentConfig | undefined =>
    configs.find((config) => config.id === sandbox.configId);
  const providerLabel = (sandbox: SandboxRecord) => providerOf(sandbox)?.label ?? sandbox.provider;
  const findSandbox = (threadRef: ScopedThreadRef) =>
    findThreadSandbox(sandboxes, threadRef, provisionerEnvironmentId);
  const bridgedOf = (sandbox: SandboxRecord) =>
    isBridgedSandbox(sandbox, threads, provisionerEnvironmentId);
  const isConnected = (environmentId: EnvironmentId) => {
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    return environment?.connection.phase === "connected" && environment.serverConfig !== null;
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- settles the promises a resume handed out once the sandbox's connection comes up
  useEffect(() => {
    for (const [environmentId, resolve] of waiters.current) {
      if (!isConnected(environmentId)) continue;
      waiters.current.delete(environmentId);
      for (const done of resolve) done();
    }
  });

  const enqueue = (prompt: Prompt) => setPrompts((current) => [...current, prompt]);
  const close = (id: number) => {
    if (prompts[0]?.id === id) setClosing(prompts[0]);
    setPrompts((current) => current.filter((prompt) => prompt.id !== id));
  };
  const patch = (id: number, work: SandboxCheckWorkResult) =>
    setPrompts((current) =>
      current.map((prompt) =>
        prompt.id === id && prompt.kind === "delete" ? { ...prompt, work } : prompt,
      ),
    );

  const failureToast = (result: Parameters<typeof squashAtomCommandFailure>[0], title: string) => {
    const failure = describeSandboxFailure(squashAtomCommandFailure(result), title);
    toastManager.add(
      stackedThreadToast({ type: "error", title: failure.title, description: failure.description }),
    );
  };

  const remember = async (sandbox: SandboxRecord, onSettle: SandboxSettleAction) => {
    const config = configOf(sandbox);
    if (config === undefined || provisionerEnvironmentId === null) return;
    const result = await saveConfig({
      environmentId: provisionerEnvironmentId,
      input: { config: { ...config, onSettle } },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast(result, "Could not remember the choice");
      return;
    }
    void configsQuery.refresh();
  };

  const keepSnapshot = async (sandbox: SandboxRecord) => {
    if (provisionerEnvironmentId === null) return;
    const result = await stopSandbox({
      environmentId: provisionerEnvironmentId,
      input: { instanceId: sandbox.instanceId },
    });
    void list.refresh();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) failureToast(result, "Could not stop the sandbox");
      return;
    }
    const days = providerOf(sandbox)?.diskRetentionDays;
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: `Stopped sandbox ${shortSandboxId(sandbox.sandboxId)}`,
        description: `${providerLabel(sandbox)} keeps its disk${days === undefined ? "" : ` for ${days} days`} and bills for it. Send a message in the chat to resume it.`,
      }),
    );
  };

  // The host thread and the sandbox's thread share an id, so a bridged sandbox's delete leaves
  // only a page showing the sandbox's thread, unless the host thread was deleted too.
  const leaveThread = (sandbox: SandboxRecord, threadRef: ScopedThreadRef, hostKept: boolean) => {
    const path = window.location.pathname;
    if (!path.includes(threadRef.threadId)) return;
    if (hostKept && (sandbox.environmentId === null || !path.includes(sandbox.environmentId))) {
      return;
    }
    void navigate({ to: "/" });
  };

  // A legacy thread's conversation lives on the sandbox, so it goes with it; the toast says so.
  const removeSandbox = async (
    sandbox: SandboxRecord,
    threadRef: ScopedThreadRef,
    title: string,
    options: { readonly bridged: boolean; readonly hostThreadDeleted: boolean },
  ) => {
    if (provisionerEnvironmentId === null) return false;
    const result = await deleteSandbox({
      environmentId: provisionerEnvironmentId,
      input: {
        provider: sandbox.provider,
        sandboxId: sandbox.sandboxId,
        instanceId: sandbox.instanceId,
      },
    });
    void list.refresh();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) failureToast(result, "Could not delete the sandbox");
      return false;
    }
    const hostKept = options.bridged && !options.hostThreadDeleted;
    // A kept host thread can still be un-settled; a thread that is gone cannot.
    if (!hostKept) ThreadUndo.invalidate("settle", scopedThreadKey(threadRef));
    leaveThread(sandbox, threadRef, hostKept);
    if (sandbox.environmentId !== null && entries.has(sandbox.environmentId)) {
      await removeEnvironment(sandbox.environmentId);
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title,
        description: !options.bridged
          ? `The conversation was on sandbox ${shortSandboxId(sandbox.sandboxId)}, so it is gone too.`
          : hostKept
            ? "The conversation stays in this thread. Its next message needs a new sandbox."
            : `The thread and sandbox ${shortSandboxId(sandbox.sandboxId)} are gone.`,
      }),
    );
    for (const warning of result.value.warnings) {
      toastManager.add(stackedThreadToast({ type: "warning", title, description: warning }));
    }
    return true;
  };

  const runCheck = async (sandbox: SandboxRecord): Promise<SandboxCheckWorkResult> => {
    if (provisionerEnvironmentId === null) {
      return { status: "unknown", uncommittedFiles: 0, unpushedCommits: 0 };
    }
    const result = await checkWork({
      environmentId: provisionerEnvironmentId,
      input: { instanceId: sandbox.instanceId },
    });
    return result._tag === "Success"
      ? result.value
      : {
          status: "unknown",
          uncommittedFiles: 0,
          unpushedCommits: 0,
          detail: "T3 Code could not reach the sandbox.",
        };
  };

  // Asks before every delete, with what the check found, unless a remembered choice found nothing
  // to lose: then the delete goes ahead and the toast says what went.
  const startDelete = (
    sandbox: SandboxRecord,
    threadRef: ScopedThreadRef,
    reason: DeleteReason,
    options: {
      readonly deleteThread?: () => Promise<{ readonly _tag: string }>;
      readonly remembered?: boolean;
    } = {},
  ) =>
    new Promise<void>((resolve) => {
      const id = nextId.current++;
      const bridged = bridgedOf(sandbox);
      if (options.remembered === true) {
        void runCheck(sandbox).then((work) => {
          if (work.status === "clean") {
            void removeSandbox(
              sandbox,
              threadRef,
              `Deleted sandbox ${shortSandboxId(sandbox.sandboxId)}`,
              { bridged, hostThreadDeleted: false },
            ).then(() => resolve());
            return;
          }
          enqueue({ kind: "delete", id, threadRef, sandbox, reason, bridged, work, done: resolve });
        });
        return;
      }
      enqueue({
        kind: "delete",
        id,
        threadRef,
        sandbox,
        reason,
        bridged,
        work: null,
        ...(options.deleteThread === undefined ? {} : { deleteThread: options.deleteThread }),
        done: resolve,
      });
      void runCheck(sandbox).then((work) => patch(id, work));
    });

  const confirmDelete = async (prompt: Extract<Prompt, { kind: "delete" }>) => {
    close(prompt.id);
    const { sandbox, threadRef } = prompt;
    // A stopped sandbox's server cannot delete the thread; it goes with the sandbox.
    if (prompt.deleteThread !== undefined && isConnected(threadRef.environmentId)) {
      const deleted = await prompt.deleteThread();
      if (deleted._tag === "Failure") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete thread",
            description: "The sandbox was kept, so nothing else was deleted.",
          }),
        );
        prompt.done();
        return;
      }
    }
    const hostThreadDeleted = prompt.reason === "thread" && isHostThreadRef(sandbox, threadRef);
    // The sandbox's copy of a deleted host thread goes too while its server answers; the sandbox
    // delete below would take it anyway, but this leaves no stray thread if that delete fails.
    if (
      hostThreadDeleted &&
      sandbox.environmentId !== null &&
      sandbox.threadId !== undefined &&
      isConnected(sandbox.environmentId)
    ) {
      await deleteRemoteThread({
        environmentId: sandbox.environmentId,
        input: { threadId: sandbox.threadId },
      });
    }
    await removeSandbox(
      sandbox,
      threadRef,
      prompt.reason === "thread"
        ? `Deleted the thread and sandbox ${shortSandboxId(sandbox.sandboxId)}`
        : `Deleted sandbox ${shortSandboxId(sandbox.sandboxId)}`,
      { bridged: prompt.bridged, hostThreadDeleted },
    );
    prompt.done();
  };

  const onSettled = useStableCallback((threadRef: ScopedThreadRef) => {
    const sandbox = findSandbox(threadRef);
    if (sandbox === undefined || (sandbox.state !== "running" && sandbox.state !== "error")) return;
    const action = configOf(sandbox)?.onSettle ?? "ask";
    if (action === "snapshot") void keepSnapshot(sandbox);
    else if (action === "delete") {
      void startDelete(sandbox, threadRef, "settle", { remembered: true });
    } else {
      enqueue({
        kind: "settle",
        id: nextId.current++,
        threadRef,
        sandbox,
        bridged: bridgedOf(sandbox),
      });
    }
  });

  const ensureRunning = useStableCallback(async (threadRef: ScopedThreadRef) => {
    const sandbox = findSandbox(threadRef);
    if (sandbox === undefined || provisionerEnvironmentId === null) return true;
    // The host thread's server is up. Its next turn makes the host resume the sandbox and waits for
    // it, so only an explicit resume (un-settle, the header menu) starts one here, without waiting.
    if (isHostThreadRef(sandbox, threadRef)) {
      if (sandbox.state !== "stopped") return true;
      const result = await resumeSandbox({
        environmentId: provisionerEnvironmentId,
        input: { instanceId: sandbox.instanceId },
      });
      void list.refresh();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) failureToast(result, "Could not resume the sandbox");
        return false;
      }
      return true;
    }
    if (sandbox.state !== "stopped" && isConnected(threadRef.environmentId)) return true;
    if (sandbox.state === "stopped") {
      const result = await resumeSandbox({
        environmentId: provisionerEnvironmentId,
        input: { instanceId: sandbox.instanceId },
      });
      void list.refresh();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) failureToast(result, "Could not resume the sandbox");
        return false;
      }
    }
    if (isConnected(threadRef.environmentId)) return true;
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => resolve(false), RESUME_WAIT_MS);
      const pending = waiters.current.get(threadRef.environmentId) ?? [];
      waiters.current.set(threadRef.environmentId, [
        ...pending,
        () => {
          window.clearTimeout(timer);
          resolve(true);
        },
      ]);
    });
  });

  const deleteThreadAndSandbox = useStableCallback(
    (threadRef: ScopedThreadRef, deleteThread: () => Promise<{ readonly _tag: string }>) => {
      const sandbox = findSandbox(threadRef);
      if (sandbox === undefined) return deleteThread().then(() => undefined);
      return startDelete(sandbox, threadRef, "thread", { deleteThread });
    },
  );

  const isSandboxThread = useStableCallback(
    (threadRef: ScopedThreadRef) => findSandbox(threadRef) !== undefined,
  );

  const deleteOnly = useStableCallback((threadRef: ScopedThreadRef) => {
    const sandbox = findSandbox(threadRef);
    return sandbox === undefined ? Promise.resolve() : startDelete(sandbox, threadRef, "menu");
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the module registry entry the thread actions call, until unmount
  useEffect(
    () =>
      registerSandboxThreadHandlers({
        isSandboxThread,
        onSettled,
        ensureRunning,
        deleteThreadAndSandbox,
        deleteSandbox: deleteOnly,
      }),
    [isSandboxThread, onSettled, ensureRunning, deleteThreadAndSandbox, deleteOnly],
  );

  const open = prompts[0];
  const prompt = open ?? closing;
  // One dialog stays mounted, as in ConfirmDialogHost, and shows the queue's first prompt.
  return (
    <AlertDialog
      open={open !== undefined}
      onOpenChange={(next) => {
        if (next || open === undefined) return;
        close(open.id);
        if (open.kind === "delete") open.done();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) setClosing(null);
      }}
    >
      <AlertDialogPopup>
        {prompt === null ? null : (
          <SandboxThreadPrompt
            key={prompt.id}
            prompt={prompt}
            threadTitle={
              threads.find(
                (thread) =>
                  thread.environmentId === prompt.threadRef.environmentId &&
                  thread.id === prompt.threadRef.threadId,
              )?.title ?? null
            }
            providerLabel={providerLabel(prompt.sandbox)}
            retentionDays={providerOf(prompt.sandbox)?.diskRetentionDays}
            rememberLabel={
              provisionerEnvironmentId !== null &&
              readEnvironmentScope(provisionerEnvironmentId, AuthSettingsWriteScope)
                ? (configOf(prompt.sandbox)?.label ?? null)
                : null
            }
            onKeep={(rememberChoice) => {
              close(prompt.id);
              if (rememberChoice) void remember(prompt.sandbox, "snapshot");
              void keepSnapshot(prompt.sandbox);
            }}
            onDelete={(rememberChoice) => {
              close(prompt.id);
              if (rememberChoice) void remember(prompt.sandbox, "delete");
              void startDelete(prompt.sandbox, prompt.threadRef, "settle");
            }}
            onConfirmDelete={() => {
              if (prompt.kind === "delete") void confirmDelete(prompt);
            }}
            onCancel={() => {
              close(prompt.id);
              if (prompt.kind === "delete") prompt.done();
            }}
          />
        )}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function SandboxThreadPrompt({
  prompt,
  threadTitle,
  providerLabel,
  retentionDays,
  rememberLabel,
  onKeep,
  onDelete,
  onConfirmDelete,
  onCancel,
}: {
  readonly prompt: Prompt;
  readonly threadTitle: string | null;
  readonly providerLabel: string;
  readonly retentionDays: number | undefined;
  readonly rememberLabel: string | null;
  readonly onKeep: (remember: boolean) => void;
  readonly onDelete: (remember: boolean) => void;
  readonly onConfirmDelete: () => void;
  readonly onCancel: () => void;
}) {
  const [rememberChoice, setRememberChoice] = useState(false);
  const short = shortSandboxId(prompt.sandbox.sandboxId);
  return (
    <>
      {prompt.kind === "settle" ? (
        <>
          <AlertDialogHeader>
            <AlertDialogTitle>Keep this chat&apos;s sandbox?</AlertDialogTitle>
            <AlertDialogDescription>
              {threadTitle === null ? "This chat" : `"${threadTitle}"`}{" "}
              {prompt.bridged ? "runs on" : "lives on"} {providerLabel} sandbox {short}. A snapshot
              stops the machine and keeps its disk, and sending a message resumes it.
              {retentionDays === undefined
                ? ` ${providerLabel} bills for the stopped disk.`
                : ` ${providerLabel} keeps a stopped disk for ${retentionDays} days and bills for it.`}{" "}
              {prompt.bridged
                ? "Deleting the sandbox keeps this conversation here; work only on its disk is lost."
                : "Deleting the sandbox deletes this conversation too."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {rememberLabel === null ? null : (
            <label className="flex cursor-pointer items-center gap-2 px-6 text-sm text-muted-foreground">
              <Checkbox
                checked={rememberChoice}
                onCheckedChange={(checked) => setRememberChoice(checked === true)}
              />
              Remember for {rememberLabel}
            </label>
          )}
          <AlertDialogFooter>
            <Button variant="ghost" onClick={onCancel}>
              Not now
            </Button>
            <Button variant="destructive-outline" onClick={() => onDelete(rememberChoice)}>
              Delete sandbox…
            </Button>
            <Button onClick={() => onKeep(rememberChoice)}>Keep snapshot</Button>
          </AlertDialogFooter>
        </>
      ) : (
        <>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {prompt.reason === "thread"
                ? `Delete ${threadTitle === null ? "this thread" : `"${threadTitle}"`} and its sandbox?`
                : `Delete sandbox ${short}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDescription(prompt, short, providerLabel)} This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p
            role="status"
            className={
              prompt.work === null || prompt.work.status === "clean"
                ? "flex items-center gap-2 px-6 text-sm text-muted-foreground"
                : "flex items-center gap-2 px-6 text-sm text-warning-foreground"
            }
          >
            {prompt.work === null ? (
              <>
                <Spinner className="size-3.5" />
                Checking for unpushed work…
              </>
            ) : (
              describeWork(prompt.work)
            )}
          </p>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={prompt.work === null} onClick={onConfirmDelete}>
              {prompt.reason === "thread" ? "Delete thread and sandbox" : "Delete sandbox"}
            </Button>
          </AlertDialogFooter>
        </>
      )}
    </>
  );
}
