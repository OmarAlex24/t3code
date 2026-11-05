import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SANDBOX_SETUP_STAGE_ORDER,
  type SandboxSetupSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";

const HOST_ENV = "11111111-1111-4111-8111-111111111111";
const SANDBOX_ENV = "22222222-2222-4222-8222-222222222222";

// The hooks below read these; `bump` re-renders every reader, like an atom update would.
const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    version: 0,
    snapshot: null as unknown,
    bridgeReady: false,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bump: () => {
      state.version += 1;
      for (const listener of listeners) listener();
    },
  };
  return {
    state,
    launch: vi.fn(),
    pairLaunch: vi.fn(),
    connectPairing: vi.fn(),
    completeLaunch: vi.fn(),
    linkHostThread: vi.fn(),
    cancelLaunch: vi.fn(),
    retryLaunch: vi.fn(),
    navigate: vi.fn(),
  };
});

const useVersion = () => useSyncExternalStore(mocks.state.subscribe, () => mocks.state.version);

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => mocks.navigate) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/connection/onboarding"), async (original) => ({
  ...(await original()),
  connectPairing: mocks.connectPairing as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (() => true) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      sandboxesConfigs: (() => "configs") as never,
      sandboxesLaunchState: (() => "launch-state") as never,
      sandboxesLaunch: mocks.launch as never,
      sandboxesCancelLaunch: mocks.cancelLaunch as never,
      sandboxesRetryLaunch: mocks.retryLaunch as never,
      sandboxesPairLaunch: mocks.pairLaunch as never,
      sandboxesCompleteLaunch: mocks.completeLaunch as never,
      sandboxesLinkHostThread: mocks.linkHostThread as never,
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => {
    useVersion();
    return {
      data:
        atom === "configs"
          ? {
              configs: [
                {
                  id: "config-1",
                  label: "Boat small",
                  provider: "boat",
                },
              ],
            }
          : atom === "launch-state"
            ? mocks.state.snapshot
            : undefined,
      isPending: false,
      error: null,
      refresh: () => {},
    };
  }) as never,
}));
vi.mock(import("~/state/sandboxes"), async (original) => ({
  ...(await original()),
  useSandboxProvisionerEnvironmentId: (() => EnvironmentId.make(HOST_ENV)) as never,
  useSandboxThreadEnvironmentIds: (() => new Map()) as never,
  useSandboxBridgeReady: (() => {
    useVersion();
    return mocks.state.bridgeReady;
  }) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      { environmentId: SANDBOX_ENV, connection: { phase: "connected" }, serverConfig: {} },
    ],
  })) as never,
}));

const sourceProject = {
  environmentId: EnvironmentId.make(HOST_ENV),
  id: ProjectId.make("project-source"),
  title: "web",
  workspaceRoot: "/Users/me/web",
  repositoryIdentity: {
    locator: { remoteUrl: "https://github.com/acme/web.git" },
  },
} as unknown as EnvironmentProject;
const sandboxProject = {
  environmentId: EnvironmentId.make(SANDBOX_ENV),
  id: ProjectId.make("project-sandbox"),
  title: "web",
  workspaceRoot: "/home/boat/work/web",
  repositoryIdentity: null,
} as unknown as EnvironmentProject;

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [sourceProject, sandboxProject]) as never,
}));

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useSandboxComposerStore } from "~/state/sandboxComposer";
import { toastManager } from "../ui/toast";
import { useSandboxLaunch } from "./useSandboxLaunch";

const draftId = DraftId.make("draft-bridge");
const threadId = ThreadId.make("thread-bridge");
const onHandedOff = vi.fn();

function Harness() {
  const launch = useSandboxLaunch({
    draftId,
    threadId,
    activeEnvironmentId: EnvironmentId.make(HOST_ENV),
    activeProject: sourceProject,
    logicalProjectEnvironments: [],
    envLocked: false,
    onHandedOff,
  });
  return (
    <div>
      {launch.card}
      <button type="button" onClick={() => launch.interceptSend()}>
        Send
      </button>
    </div>
  );
}

// The host's launch of the harness's thread, as it streams it.
const launchSnapshot = (overrides: Partial<SandboxSetupSnapshot> = {}): SandboxSetupSnapshot => ({
  threadId,
  instanceId: "instance-1",
  configId: "config-1",
  label: "Boat small",
  provider: "boat",
  phase: "running",
  startedAt: "2026-11-05T18:36:53.000Z",
  endedAt: null,
  stages: SANDBOX_SETUP_STAGE_ORDER.map((id, index) => ({
    id,
    status: index < 2 ? "done" : index === 2 ? "running" : "pending",
    startedAt: index <= 2 ? "2026-11-05T18:36:53.000Z" : null,
    endedAt: index < 2 ? "2026-11-05T18:37:10.000Z" : null,
    detail: null,
  })),
  warnings: [],
  error: null,
  recovery: null,
  awaitingHandoff: false,
  sequence: 1,
  ...overrides,
});

const linked = {
  instanceId: "sandboxes",
  hostProjectId: ProjectId.make("project-host"),
  lightweightProject: true,
  modelSelection: { instanceId: "sandboxes", model: "sandbox" },
};

// Launches, then lets the host report the machine ready for the client's half of the handoff.
async function launchToHandoff() {
  await userEvent.click(page.getByRole("button", { name: "Send" }));
  await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce());
  mocks.state.snapshot = launchSnapshot({ awaitingHandoff: true });
  mocks.state.bump();
  await vi.waitFor(() => expect(mocks.completeLaunch).toHaveBeenCalledOnce());
}

const draftProjectRef = () => {
  const draft = useComposerDraftStore.getState().getDraftThread(draftId);
  return draft === null ? null : { environmentId: draft.environmentId, projectId: draft.projectId };
};

// A fresh draft on the source project with the sandbox config picked, and the host's answers.
function setup() {
  {
    mocks.state.snapshot = null;
    mocks.state.bridgeReady = false;
    for (const mock of [
      mocks.launch,
      mocks.cancelLaunch,
      mocks.retryLaunch,
      mocks.pairLaunch,
      mocks.connectPairing,
      mocks.completeLaunch,
      mocks.linkHostThread,
      onHandedOff,
    ]) {
      mock.mockReset();
    }
    mocks.launch.mockResolvedValue(AsyncResult.success(undefined));
    mocks.pairLaunch.mockResolvedValue(
      AsyncResult.success({
        httpBaseUrl: "https://bx.example.test",
        pairingCode: "code",
        environmentId: SANDBOX_ENV,
        projectId: "project-sandbox",
      }),
    );
    mocks.connectPairing.mockResolvedValue(AsyncResult.success(undefined));
    mocks.completeLaunch.mockResolvedValue(AsyncResult.success(undefined));
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(
        scopeProjectRef(EnvironmentId.make(HOST_ENV), sourceProject.id),
        draftId,
        {
          threadId,
        },
      );
    useSandboxComposerStore.getState().select(draftId, "config-1");
  }
}

describe("useSandboxLaunch handoff", () => {
  it("links a host thread and sends there once the Sandboxes provider is ready", async () => {
    setup();
    mocks.linkHostThread.mockResolvedValue(AsyncResult.success(linked));
    await using _screen = await render(<Harness />);

    await launchToHandoff();
    await vi.waitFor(() =>
      expect(mocks.linkHostThread).toHaveBeenCalledWith({
        environmentId: HOST_ENV,
        input: { threadId },
      }),
    );
    expect(mocks.completeLaunch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.linkHostThread.mock.invocationCallOrder[0]!,
    );
    // The provider is still being probed for that project, so the message waits.
    expect(onHandedOff).not.toHaveBeenCalled();
    expect(draftProjectRef()).toEqual({ environmentId: HOST_ENV, projectId: sourceProject.id });

    mocks.state.bridgeReady = true;
    mocks.state.bump();
    await vi.waitFor(() => expect(onHandedOff).toHaveBeenCalledOnce());
    expect(draftProjectRef()).toEqual({ environmentId: HOST_ENV, projectId: "project-host" });
    const composer = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(composer?.activeProvider).toBe("sandboxes");
    expect(composer?.modelSelectionByProvider[ProviderInstanceId.make("sandboxes")]?.model).toBe(
      "sandbox",
    );
    expect(composer?.runtimeMode).toBe("approval-required");
  });

  it("sends on the sandbox, with a warning, when the host thread cannot be linked", async () => {
    setup();
    mocks.linkHostThread.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("No sandbox belongs to this thread."))),
    );
    const toast = vi.spyOn(toastManager, "add");
    await using _screen = await render(<Harness />);

    await launchToHandoff();
    await vi.waitFor(() => expect(onHandedOff).toHaveBeenCalledOnce());
    expect(draftProjectRef()).toEqual({ environmentId: SANDBOX_ENV, projectId: "project-sandbox" });
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Your phone cannot drive this thread",
      }),
    );
    toast.mockRestore();
  });

  it("picks a launch up again when the user leaves the thread and comes back", async () => {
    setup();
    mocks.linkHostThread.mockResolvedValue(AsyncResult.success(linked));
    {
      await using _first = await render(<Harness />);
      await userEvent.click(page.getByRole("button", { name: "Send" }));
      await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce());
      mocks.state.snapshot = launchSnapshot();
      mocks.state.bump();
      await expect
        .element(page.getByText("Starting a sandbox on Boat small…").first())
        .toBeVisible();
    }
    // Away on another thread, the host reached the handoff that only this client can finish.
    mocks.state.snapshot = launchSnapshot({ awaitingHandoff: true, sequence: 2 });
    expect(mocks.pairLaunch).not.toHaveBeenCalled();

    await using _second = await render(<Harness />);
    await vi.waitFor(() => expect(mocks.completeLaunch).toHaveBeenCalledOnce());
    expect(mocks.pairLaunch).toHaveBeenCalledOnce();
    expect(mocks.launch).toHaveBeenCalledOnce();
    mocks.state.bridgeReady = true;
    mocks.state.bump();
    // The message the user sent before leaving goes out on the host thread.
    await vi.waitFor(() => expect(onHandedOff).toHaveBeenCalledOnce());
    expect(draftProjectRef()).toEqual({ environmentId: HOST_ENV, projectId: "project-host" });
  });

  it("follows a launch already starting when the user sends again", async () => {
    setup();
    mocks.state.snapshot = launchSnapshot();
    const toast = vi.spyOn(toastManager, "add");
    await using _screen = await render(<Harness />);
    await expect.element(page.getByText("Starting a sandbox on Boat small…").first()).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Send" }));
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    await expect.element(page.getByText("Starting a sandbox on Boat small…").first()).toBeVisible();
    toast.mockRestore();
  });

  it("starts a new sandbox from a launch the host lost, or dismisses it", async () => {
    setup();
    mocks.state.snapshot = launchSnapshot({
      phase: "failed",
      error: "T3 Code stopped before this sandbox finished starting.",
      recovery: "relaunch",
    });
    await using _screen = await render(<Harness />);
    await expect
      .element(page.getByText("The sandbox on Boat small could not start").first())
      .toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Start a new sandbox" }));
    await vi.waitFor(() =>
      expect(mocks.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: HOST_ENV,
          input: expect.objectContaining({ configId: "config-1", threadId }),
        }),
      ),
    );
    expect(mocks.retryLaunch).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: "Dismiss" }));
    expect(mocks.cancelLaunch).toHaveBeenCalledOnce();
    // The host still streams the failed launch until it drops it; the card stays gone.
    await expect
      .element(page.getByText("The sandbox on Boat small could not start").first())
      .not.toBeInTheDocument();
  });
});
