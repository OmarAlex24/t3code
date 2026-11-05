import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectId,
  sandboxConfigAllows,
  type SandboxEnvironmentConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
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
import { SandboxSetupCard } from "./SandboxSetupCard";

const EMPTY_CONFIGS: ReadonlyArray<SandboxEnvironmentConfig> = [];
// A paired sandbox reports its projects shortly after it connects; past this the handoff gives up.
const PROJECT_WAIT_MS = 90_000;

const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0], title: string) =>
  describeSandboxFailure(squashAtomCommandFailure(result), title).description;

/**
 * Starting a draft on a sandbox config: the picker options, the send that launches a machine
 * instead of sending, the card that follows the launch, and the move onto the sandbox once it is
 * paired. The draft keeps its thread id, so the thread starts on the sandbox under the same id.
 */
export function useSandboxLaunch(input: {
  readonly draftId: DraftId | null;
  readonly threadId: ThreadId | null;
  readonly activeEnvironmentId: EnvironmentId | null;
  readonly activeProject: EnvironmentProject | null;
  readonly logicalProjectEnvironments: ReadonlyArray<EnvironmentOption>;
  readonly envLocked: boolean;
  /** Sends the waiting message once the draft is on the sandbox. */
  readonly onHandedOff: () => void;
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
  const { environments } = useEnvironments();
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const selectedConfigId = useSandboxComposerStore((state) =>
    draftId === null ? undefined : state.selections[draftId],
  );
  const select = useSandboxComposerStore((state) => state.select);
  const launchSandbox = useAtomCommand(serverEnvironment.sandboxesLaunch, { reportFailure: false });
  const cancelLaunch = useAtomCommand(serverEnvironment.sandboxesCancelLaunch, {
    reportFailure: false,
  });
  const retryLaunch = useAtomCommand(serverEnvironment.sandboxesRetryLaunch, {
    reportFailure: false,
  });
  const pairLaunch = useAtomCommand(serverEnvironment.sandboxesPairLaunch, {
    reportFailure: false,
  });
  const completeLaunch = useAtomCommand(serverEnvironment.sandboxesCompleteLaunch, {
    reportFailure: false,
  });
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });

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
  const usableConfigs = launchable
    ? configs.filter((config) =>
        sandboxConfigAllows(config, {
          repository: repository.key,
          hostProjectId: hostProject?.id ?? null,
        }),
      )
    : EMPTY_CONFIGS;
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

  // The launch this view started, keyed to its draft so another draft never shows its card.
  const [launch, setLaunch] = useState<{
    readonly draftId: DraftId;
    readonly threadId: ThreadId;
    readonly hostEnvironmentId: EnvironmentId;
  } | null>(null);
  const activeLaunch = launch !== null && launch.draftId === draftId ? launch : null;
  const snapshotQuery = useEnvironmentQuery(
    activeLaunch === null
      ? null
      : serverEnvironment.sandboxesLaunchState({
          environmentId: activeLaunch.hostEnvironmentId,
          input: { threadId: activeLaunch.threadId },
        }),
  );
  const snapshot =
    snapshotQuery.data !== undefined &&
    snapshotQuery.data !== null &&
    activeLaunch !== null &&
    snapshotQuery.data.threadId === activeLaunch.threadId
      ? snapshotQuery.data
      : null;

  // The handoff runs once per pairing attempt: a retry clears it so the next attempt can pair.
  const [handoff, setHandoff] = useState<{
    readonly sequence: number;
    readonly target: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
    } | null;
    readonly startedAt: number;
  } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const pairingRef = useRef(false);

  const startHandoff = useStableCallback(async () => {
    if (activeLaunch === null || snapshot === null || pairingRef.current) return;
    pairingRef.current = true;
    setLocalError(null);
    setHandoff({ sequence: snapshot.sequence, target: null, startedAt: Date.now() });
    const target = {
      environmentId: activeLaunch.hostEnvironmentId,
      input: { threadId: activeLaunch.threadId },
    };
    const paired = await pairLaunch(target);
    if (paired._tag === "Failure") {
      pairingRef.current = false;
      // The host marks its pair stage failed and offers a retry on the card.
      if (!isAtomCommandInterrupted(paired)) {
        setLocalError(failureText(paired, "Could not pair with the sandbox"));
      }
      return;
    }
    const connected = await connectPairing({
      host: paired.value.httpBaseUrl,
      pairingCode: paired.value.pairingCode,
    });
    if (connected._tag === "Failure") {
      pairingRef.current = false;
      if (!isAtomCommandInterrupted(connected)) {
        const reason = squashAtomCommandFailure(connected);
        setLocalError(
          `This app could not connect to the sandbox at ${paired.value.httpBaseUrl}. ${reason instanceof Error ? reason.message : ""}`.trim(),
        );
      }
      return;
    }
    setHandoff((current) =>
      current === null
        ? null
        : {
            ...current,
            target: {
              environmentId: paired.value.environmentId,
              projectId: paired.value.projectId,
            },
          },
    );
  });

  // Pairs as soon as the host has the machine ready.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the client half of the handoff when the host's launch reaches it
  useEffect(() => {
    if (snapshot === null || !snapshot.awaitingHandoff || snapshot.phase !== "running") return;
    if (handoff !== null || localError !== null) return;
    void startHandoff();
  }, [handoff, localError, snapshot, startHandoff]);

  const handoffProject =
    handoff?.target == null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === handoff.target!.environmentId &&
            project.id === handoff.target!.projectId,
        ) ?? null);
  const handoffEnvironmentConnected =
    handoff?.target != null &&
    environments.some(
      (environment) =>
        environment.environmentId === handoff.target!.environmentId &&
        environment.connection.phase === "connected",
    );

  const finishHandoff = useStableCallback(async () => {
    if (activeLaunch === null || handoff?.target == null || draftId === null) return;
    // The draft moves onto the sandbox's project; its thread id stays, so the thread starts there.
    setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(handoff.target.environmentId, handoff.target.projectId),
      environmentSelection: "manual",
      loadBalancedEnvironmentId: null,
      envMode: "local",
      branch: null,
      worktreePath: null,
    });
    select(draftId, null);
    const completed = await completeLaunch({
      environmentId: activeLaunch.hostEnvironmentId,
      input: { threadId: activeLaunch.threadId },
    });
    pairingRef.current = false;
    setHandoff(null);
    setLaunch(null);
    if (completed._tag === "Failure" && !isAtomCommandInterrupted(completed)) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Sandbox connected",
          description: failureText(completed, "The host did not record the sandbox as running"),
        }),
      );
    }
    input.onHandedOff();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the draft once the paired sandbox reports the cloned project
  useEffect(() => {
    if (handoffProject === null || !handoffEnvironmentConnected) return;
    void finishHandoff();
  }, [finishHandoff, handoffEnvironmentConnected, handoffProject]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- gives up on a paired sandbox that never reports its project
  useEffect(() => {
    if (handoff?.target == null || handoffProject !== null) return;
    const timer = window.setTimeout(
      () => {
        pairingRef.current = false;
        setLocalError(
          "The sandbox connected but did not show its project. Check it under Settings → Connections → Sandboxes.",
        );
      },
      Math.max(0, handoff.startedAt + PROJECT_WAIT_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [handoff, handoffProject]);

  const onEnvironmentChange = (id: EnvironmentId): boolean => {
    if (draftId === null) return false;
    const configId = sandboxOptionConfigId(id);
    select(draftId, configId);
    return configId !== null;
  };

  /** Starts the launch instead of sending; true while the message has to wait for it. */
  const interceptSend = (): boolean => {
    if (activeLaunch !== null) return true;
    if (
      selectedConfig === null ||
      !launchable ||
      repository === null ||
      activeProject === null ||
      threadId === null ||
      draftId === null
    ) {
      return false;
    }
    const host = hostEnvironmentId!;
    const started = { draftId, threadId, hostEnvironmentId: host };
    setLaunch(started);
    setLocalError(null);
    pairingRef.current = false;
    setHandoff(null);
    void launchSandbox({
      environmentId: host,
      input: {
        configId: selectedConfig.id,
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
      },
    }).then((result) => {
      if (result._tag === "Success") return;
      setLaunch((current) => (current === started ? null : current));
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
    });
    return true;
  };

  const dismiss = useStableCallback(() => {
    if (activeLaunch === null) return;
    void cancelLaunch({
      environmentId: activeLaunch.hostEnvironmentId,
      input: { threadId: activeLaunch.threadId },
    });
    pairingRef.current = false;
    setHandoff(null);
    setLocalError(null);
    setLaunch(null);
  });

  const retry = useStableCallback(() => {
    if (activeLaunch === null) return;
    pairingRef.current = false;
    setHandoff(null);
    const hostFailed = snapshot?.phase === "failed";
    setLocalError(null);
    // A client-side failure retries the pairing; the host only hears about its own failures.
    if (hostFailed) {
      void retryLaunch({
        environmentId: activeLaunch.hostEnvironmentId,
        input: { threadId: activeLaunch.threadId },
      });
    }
  });

  const card: ReactNode =
    snapshot === null ? null : (
      <SandboxSetupCard
        snapshot={snapshot}
        connecting={handoff !== null}
        localError={localError}
        onCancel={dismiss}
        onRetry={retry}
        onDismiss={dismiss}
      />
    );

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
    launching: activeLaunch !== null,
    card,
  };
}
