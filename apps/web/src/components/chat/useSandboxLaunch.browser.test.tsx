import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  type SandboxLaunchMessage,
  type ScopedThreadRef,
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
    // The host's sandbox records, as `sandboxes.list` returns them.
    records: [] as Array<unknown>,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bump: () => {
      state.version += 1;
      for (const listener of listeners) listener();
    },
  };
  return { state, launch: vi.fn(), navigate: vi.fn() };
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
      sandboxesLaunch: mocks.launch as never,
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data:
      atom === "configs"
        ? { configs: [{ id: "config-1", label: "Boat small", provider: "boat" }] }
        : undefined,
    isPending: false,
    error: null,
    refresh: () => {},
  })) as never,
}));
vi.mock(import("~/state/sandboxes"), async (original) => ({
  ...(await original()),
  useSandboxProvisionerEnvironmentId: (() => EnvironmentId.make(HOST_ENV)) as never,
  useSandboxThreadEnvironmentIds: (() => new Map()) as never,
  useSandboxRecords: (() => {
    useVersion();
    return mocks.state.records;
  }) as never,
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

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [sourceProject]) as never,
}));

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useSandboxComposerStore } from "~/state/sandboxComposer";
import { toastManager } from "../ui/toast";
import { useSandboxLaunch } from "./useSandboxLaunch";

const draftId = DraftId.make("draft-sandbox");
const threadId = ThreadId.make("thread-sandbox");
const hostProjectId = ProjectId.make("project-host");

const message: SandboxLaunchMessage = {
  messageId: MessageId.make("message-1"),
  text: "Fix the flaky test",
  attachments: [],
  title: "Fix the flaky test",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } as never,
  runtimeMode: "full-access",
  interactionMode: "default",
};

const harness = {
  message: message as SandboxLaunchMessage | string | null,
  onLaunched: vi.fn<(threadRef: ScopedThreadRef) => void>(),
};

function Harness() {
  const launch = useSandboxLaunch({
    draftId,
    threadId,
    activeEnvironmentId: EnvironmentId.make(HOST_ENV),
    activeProject: sourceProject,
    logicalProjectEnvironments: [],
    envLocked: false,
    readLaunchMessage: async () => harness.message,
    onLaunched: harness.onLaunched,
  });
  return (
    <div>
      <span data-testid="launching">{launch.launching ? "launching" : "idle"}</span>
      <button type="button" onClick={() => launch.interceptSend()}>
        Send
      </button>
    </div>
  );
}

// A fresh draft on the source project with the sandbox config picked.
function setup() {
  mocks.state.records = [];
  mocks.launch.mockReset();
  mocks.navigate.mockReset();
  harness.onLaunched.mockReset();
  harness.message = message;
  mocks.launch.mockResolvedValue(
    AsyncResult.success({
      instanceId: "instance-1",
      hostThread: { threadId, projectId: hostProjectId },
    }),
  );
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(
      scopeProjectRef(EnvironmentId.make(HOST_ENV), sourceProject.id),
      draftId,
      { threadId },
    );
  useSandboxComposerStore.getState().select(draftId, "config-1");
}

const send = () => userEvent.click(page.getByRole("button", { name: "Send" }));

describe("useSandboxLaunch", () => {
  it("makes the chat a thread on the host with its message, then opens that thread", async () => {
    setup();
    await using _screen = await render(<Harness />);

    await send();
    await vi.waitFor(() => expect(harness.onLaunched).toHaveBeenCalledOnce());
    // One request carries the message: the host makes the thread and queues it there.
    expect(mocks.launch).toHaveBeenCalledWith({
      environmentId: HOST_ENV,
      input: {
        configId: "config-1",
        threadId,
        project: {
          id: sourceProject.id,
          title: "web",
          remoteUrl: "https://github.com/acme/web.git",
          hostCopy: { projectId: sourceProject.id, workspaceRoot: "/Users/me/web" },
        },
        message,
      },
    });
    // The draft hands over to the real thread, and the view follows it.
    expect(harness.onLaunched).toHaveBeenCalledWith({ environmentId: HOST_ENV, threadId });
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: HOST_ENV, threadId },
      replace: true,
    });
    expect(useSandboxComposerStore.getState().selections[draftId]).toBeUndefined();
    await expect.element(page.getByTestId("launching")).toHaveTextContent("idle");
  });

  it("starts one launch however many times the user sends while it starts", async () => {
    setup();
    let answer: (value: unknown) => void = () => {};
    mocks.launch.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await using _screen = await render(<Harness />);

    await send();
    await expect.element(page.getByTestId("launching")).toHaveTextContent("launching");
    await send();
    await send();
    expect(mocks.launch).toHaveBeenCalledOnce();
    answer(
      AsyncResult.success({
        instanceId: "instance-1",
        hostThread: { threadId, projectId: hostProjectId },
      }),
    );
    await vi.waitFor(() => expect(harness.onLaunched).toHaveBeenCalledOnce());
  });

  it("keeps the draft and says why when the host refuses the launch", async () => {
    setup();
    const add = vi.spyOn(toastManager, "add");
    mocks.launch.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("This sandbox config no longer exists."))),
    );
    await using _screen = await render(<Harness />);

    await send();
    await vi.waitFor(() => expect(add).toHaveBeenCalled());
    expect(harness.onLaunched).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    // The message is still in the composer and the config still picked, to send again.
    expect(useSandboxComposerStore.getState().selections[draftId]).toBe("config-1");
    add.mockRestore();
  });

  it("sends nothing for an empty composer, and says why a message cannot go", async () => {
    setup();
    const add = vi.spyOn(toastManager, "add");
    await using _screen = await render(<Harness />);

    harness.message = null;
    await send();
    await expect.element(page.getByTestId("launching")).toHaveTextContent("idle");
    harness.message = "Only images can go with a sandbox chat's first message.";
    await send();
    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Message not sent",
          description: "Only images can go with a sandbox chat's first message.",
        }),
      ),
    );
    expect(mocks.launch).not.toHaveBeenCalled();
    add.mockRestore();
  });

  it("holds a send for a thread whose sandbox is stopped instead of launching another", async () => {
    setup();
    const add = vi.spyOn(toastManager, "add");
    mocks.state.records = [
      {
        instanceId: "instance-1",
        environmentId: SANDBOX_ENV,
        threadId,
        provider: "boat",
        sandboxId: "bx_stopped",
        state: "stopped",
      },
    ];
    mocks.state.bump();
    await using _screen = await render(<Harness />);

    await send();
    await vi.waitFor(() => expect(add).toHaveBeenCalled());
    expect(mocks.launch).not.toHaveBeenCalled();
    add.mockRestore();
  });
});
