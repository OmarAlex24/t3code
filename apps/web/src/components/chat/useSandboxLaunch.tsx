import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type SandboxEnvironmentConfig,
  type SandboxLaunchMessage,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import {
  isForeignSandbox,
  keepsSandboxEnvironment,
  sandboxOptionConfigId,
  sandboxOptionId,
  useSandboxComposerStore,
} from "../../state/sandboxComposer";
import {
  useSandboxProvisionerEnvironmentId,
  useSandboxRecords,
  useSandboxThreadEnvironmentIds,
} from "../../state/sandboxes";
import { hostCopyOf, sandboxRepositoryOf } from "../../state/sandboxRepositories";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import type { EnvironmentOption } from "../BranchToolbar.logic";
import { SandboxConfigDialog } from "../settings/SandboxConfigDialog";
import { describeSandboxFailure } from "../settings/SandboxStartLimits";
import { stackedThreadToast, toastManager } from "../ui/toast";

const EMPTY_CONFIGS: ReadonlyArray<SandboxEnvironmentConfig> = [];

/**
 * Starting a draft on a sandbox config: picker options and the send that launches a machine. The
 * send makes the chat a thread on the host, with the draft's id and its message waiting in it; the
 * host sends that message through the sandbox bridge once the sandbox is ready, whether or not
 * this app is still open. The thread shows the setup (see `useSandboxThreadSetup`).
 */
export function useSandboxLaunch(input: {
  readonly draftId: DraftId | null;
  readonly threadId: ThreadId | null;
  readonly activeEnvironmentId: EnvironmentId | null;
  readonly activeProject: EnvironmentProject | null;
  readonly logicalProjectEnvironments: ReadonlyArray<EnvironmentOption>;
  readonly envLocked: boolean;
  /**
   * The composer's message for the sandbox: null when there is nothing to send, or why it cannot
   * go, such as a file only the computer can read.
   */
  readonly readLaunchMessage: () => Promise<SandboxLaunchMessage | string | null>;
  /** The chat became this host thread; the draft hands over to it. */
  readonly onLaunched: (threadRef: ScopedThreadRef) => void;
}) {
  const { draftId, threadId, activeEnvironmentId, activeProject, envLocked } = input;
  const hostEnvironmentId = useSandboxProvisionerEnvironmentId();
  const sandboxThreadEnvironmentIds = useSandboxThreadEnvironmentIds();
  const configsQuery = useEnvironmentQuery(
    hostEnvironmentId === null || draftId === null
      ? null
      : serverEnvironment.sandboxesConfigs({ environmentId: hostEnvironmentId, input: undefined }),
  );
  const configs = configsQuery.data?.configs ?? EMPTY_CONFIGS;
  const projects = useProjects();
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const selectedConfigId = useSandboxComposerStore((state) =>
    draftId === null ? undefined : state.selections[draftId],
  );
  const select = useSandboxComposerStore((state) => state.select);
  const launchSandbox = useAtomCommand(serverEnvironment.sandboxesLaunch, { reportFailure: false });
  const navigate = useNavigate();

  // The machine picker hides other threads' sandboxes: each belongs to its own thread.
  const keptEnvironments = input.logicalProjectEnvironments.filter((environment) =>
    keepsSandboxEnvironment(sandboxThreadEnvironmentIds, environment.environmentId, threadId),
  );
  // Keeps the caller's array when nothing is hidden, so its effects do not rerun.
  const logicalProjectEnvironments =
    keptEnvironments.length === input.logicalProjectEnvironments.length
      ? input.logicalProjectEnvironments
      : keptEnvironments;
  // A sandbox clones the project from GitHub, so it can start from a project on any machine; the
  // same repository's copy on the host, when there is one, supplies its env files.
  const repository = activeProject === null ? null : sandboxRepositoryOf(activeProject);
  const hostProject =
    repository === null || hostEnvironmentId === null
      ? null
      : hostCopyOf(projects, hostEnvironmentId, repository.key);
  const launchable =
    draftId !== null && !envLocked && hostEnvironmentId !== null && repository !== null;
  // Every config can start any GitHub project, wherever it is open.
  const usableConfigs = launchable ? configs : EMPTY_CONFIGS;
  const options: ReadonlyArray<EnvironmentOption> = usableConfigs.map((config) => ({
    environmentId: sandboxOptionId(config.id),
    projectId: null,
    label: config.label,
    isPrimary: false,
    machine: "cloud",
    sandboxProvider: config.provider,
  }));
  // With no config yet, the picker offers to make one; saving it needs settings access.
  const [creatingConfig, setCreatingConfig] = useState(false);
  const offersNewConfig =
    launchable &&
    configsQuery.data !== undefined &&
    configs.length === 0 &&
    hostEnvironmentId !== null &&
    readEnvironmentScope(hostEnvironmentId, AuthSettingsWriteScope);
  const selectedConfig = usableConfigs.find((config) => config.id === selectedConfigId) ?? null;

  // A new draft for the project can land on another thread's sandbox, since it holds a copy of the
  // same repository. That machine belongs to its thread, so the draft moves back to the host.
  const onForeignSandbox = isForeignSandbox(
    sandboxThreadEnvironmentIds,
    activeEnvironmentId,
    threadId,
  );
  // Back to the host's copy, or else to the project's own machine, such as a paired remote.
  const homeEntry =
    hostProject !== null && hostEnvironmentId !== null
      ? { environmentId: hostEnvironmentId, projectId: hostProject.id }
      : logicalProjectEnvironments.find(
          (environment) =>
            environment.projectId !== null &&
            !sandboxThreadEnvironmentIds.has(environment.environmentId),
        );
  const homeEnvironmentId = homeEntry?.environmentId ?? null;
  const homeProjectId = homeEntry?.projectId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves an unsent draft off a sandbox that belongs to another thread
  useEffect(() => {
    if (!onForeignSandbox || envLocked || draftId === null) return;
    if (homeEnvironmentId === null || homeProjectId === null) return;
    setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(homeEnvironmentId, homeProjectId),
      environmentSelection: "manual",
      loadBalancedEnvironmentId: null,
    });
  }, [
    draftId,
    envLocked,
    homeEnvironmentId,
    homeProjectId,
    onForeignSandbox,
    setDraftThreadContext,
  ]);

  // A send is starting a launch: the host makes the thread, so a second send must wait for it.
  const launchingRef = useRef(false);
  const [launching, setLaunching] = useState(false);

  // A draft whose thread already has a sandbox elsewhere (an older launch's) cannot start another.
  const sandboxRecords = useSandboxRecords();
  const threadSandbox =
    threadId === null
      ? null
      : (sandboxRecords.find(
          (record) =>
            record.threadId === threadId &&
            record.abandonedAt === undefined &&
            record.state !== "deleted",
        ) ?? null);

  const holdForThreadSandbox = (sandbox: NonNullable<typeof threadSandbox>) => {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title:
          sandbox.state === "stopped"
            ? "This thread's sandbox is stopped"
            : "This thread's sandbox is not reachable",
        description:
          "Open the thread it started from, or delete the sandbox under Settings → Connections → Sandboxes to start a new one.",
      }),
    );
  };

  /** Starts a launch on `configId` with the composer's message; false when this view cannot. */
  const startLaunch = (configId: string): boolean => {
    if (
      !launchable ||
      repository === null ||
      activeProject === null ||
      threadId === null ||
      draftId === null ||
      launchingRef.current
    ) {
      return false;
    }
    const host = hostEnvironmentId!;
    launchingRef.current = true;
    setLaunching(true);
    const finish = () => {
      launchingRef.current = false;
      setLaunching(false);
    };
    void (async () => {
      const message = await input.readLaunchMessage();
      if (message === null) return finish();
      if (typeof message === "string") {
        toastManager.add(
          stackedThreadToast({ type: "warning", title: "Message not sent", description: message }),
        );
        return finish();
      }
      const result = await launchSandbox({
        environmentId: host,
        input: {
          configId,
          threadId,
          project: {
            id: activeProject.id,
            title: activeProject.title,
            // Credential-free; the host checks it again before cloning.
            remoteUrl: repository.cloneUrl,
            ...(hostProject === null
              ? {}
              : {
                  hostCopy: { projectId: hostProject.id, workspaceRoot: hostProject.workspaceRoot },
                }),
          },
          message,
        },
      });
      finish();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = describeSandboxFailure(
            squashAtomCommandFailure(result),
            "Could not start the sandbox",
          );
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: failure.title,
              description: failure.description,
            }),
          );
        }
        return;
      }
      // The chat is a thread on the host now, its message waiting there for the sandbox.
      const hostThread = result.value.hostThread;
      select(draftId, null);
      if (hostThread === undefined) return;
      const threadRef = { environmentId: host, threadId: hostThread.threadId };
      input.onLaunched(threadRef);
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: host, threadId: hostThread.threadId },
        replace: true,
      });
    })();
    return true;
  };

  /** Starts the launch instead of sending; true when the send is handled here. */
  const interceptSend = (): boolean => {
    if (launchingRef.current) return true;
    if (selectedConfig === null) return false;
    if (threadSandbox !== null) {
      if (threadSandbox.environmentId === activeEnvironmentId) return false;
      holdForThreadSandbox(threadSandbox);
      return true;
    }
    return startLaunch(selectedConfig.id);
  };

  const onEnvironmentChange = (id: EnvironmentId): boolean => {
    if (draftId === null) return false;
    const configId = sandboxOptionConfigId(id);
    select(draftId, configId);
    return configId !== null;
  };

  const configDialog: ReactNode =
    hostEnvironmentId === null ? null : (
      <SandboxConfigDialog
        environmentId={hostEnvironmentId}
        editing={creatingConfig ? "new" : null}
        onClose={() => setCreatingConfig(false)}
      />
    );

  return {
    /** Real machines for this project, without other threads' sandboxes. */
    logicalProjectEnvironments,
    options,
    /** Opens the config dialog from the picker while no config exists yet. */
    onNewConfig: offersNewConfig ? () => setCreatingConfig(true) : undefined,
    configDialog,
    pickedEnvironmentId: selectedConfig === null ? null : sandboxOptionId(selectedConfig.id),
    onEnvironmentChange,
    interceptSend,
    launching,
  };
}
