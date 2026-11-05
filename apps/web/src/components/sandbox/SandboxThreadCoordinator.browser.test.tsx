import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, type SandboxRecord, ThreadId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";

const SANDBOX_ENV = "22222222-2222-4222-8222-222222222222";
const HOST_ENV = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  sandboxes: [] as Array<unknown>,
  configs: [] as Array<unknown>,
  work: { status: "clean", uncommittedFiles: 0, unpushedCommits: 0 } as unknown,
  deleteSandbox: vi.fn(async () => AsyncResult.success({ warnings: [] })),
  stopSandbox: vi.fn(async () => AsyncResult.success(undefined)),
  resumeSandbox: vi.fn(async () => AsyncResult.success(undefined)),
  saveConfig: vi.fn(async () => AsyncResult.success(undefined)),
  checkWork: vi.fn(async () => AsyncResult.success(mocks.work)),
  removeEnvironment: vi.fn(async () => AsyncResult.success(undefined)),
  deleteSandboxThread: vi.fn(async () => AsyncResult.success(undefined)),
  renameThread: vi.fn(async () => AsyncResult.success(undefined)),
  // A bridged thread also lives on the host, under the same id.
  hostThread: false,
  hostTitle: "Fix the login bug",
}));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      { environmentId: SANDBOX_ENV, connection: { phase: "connected" }, serverConfig: {} },
      { environmentId: HOST_ENV, connection: { phase: "connected" }, serverConfig: {} },
    ],
  })) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useThreadShells: (() => [
    { environmentId: SANDBOX_ENV, id: "thread-1", title: "Fix the login bug" },
    ...(mocks.hostThread
      ? [{ environmentId: HOST_ENV, id: "thread-1", title: mocks.hostTitle }]
      : []),
  ]) as never,
}));
vi.mock(import("~/state/use-orchestration-command"), async (original) => ({
  ...(await original()),
  useOrchestrationCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadEnvironment: {
      ...actual.threadEnvironment,
      delete: mocks.deleteSandboxThread as never,
      updateMetadata: mocks.renameThread as never,
    },
  };
});
vi.mock(import("~/state/sandboxes"), async (original) => ({
  ...(await original()),
  useSandboxProvisionerEnvironmentId: (() => EnvironmentId.make(HOST_ENV)) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (() => true) as never,
}));
vi.mock(import("~/connection/catalog"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentCatalog: {
      ...actual.environmentCatalog,
      // The sandbox's environment is saved in this client, so deleting the sandbox removes it.
      catalogValueAtom: Atom.make({
        entries: new Map([["22222222-2222-4222-8222-222222222222", {}]]),
      }) as never,
      remove: mocks.removeEnvironment as never,
    },
  };
});
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      sandboxesList: (() => "list") as never,
      sandboxesConfigs: (() => "configs") as never,
      sandboxesProviders: (() => "providers") as never,
      sandboxesStop: mocks.stopSandbox as never,
      sandboxesResume: mocks.resumeSandbox as never,
      sandboxesDelete: mocks.deleteSandbox as never,
      sandboxesCheckWork: mocks.checkWork as never,
      sandboxesSaveConfig: mocks.saveConfig as never,
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data:
      atom === "list"
        ? { sandboxes: mocks.sandboxes, orphans: [] }
        : atom === "configs"
          ? { configs: mocks.configs }
          : atom === "providers"
            ? { providers: [{ kind: "boat", label: "Boat", diskRetentionDays: 14 }] }
            : null,
    isPending: false,
    error: null,
    refresh: () => {},
  })) as never,
}));

import {
  deleteSandboxThread,
  deleteThreadSandbox,
  ensureSandboxThreadRunning,
  notifySandboxThreadSettled,
} from "~/state/sandboxThreads";
import { SandboxThreadCoordinator } from "./SandboxThreadCoordinator";

const threadRef = {
  environmentId: EnvironmentId.make(SANDBOX_ENV),
  threadId: ThreadId.make("thread-1"),
};

// The host thread the sandbox bridge drives: the provisioning server's thread with the same id.
const hostRef = {
  environmentId: EnvironmentId.make(HOST_ENV),
  threadId: ThreadId.make("thread-1"),
};

const sandbox: SandboxRecord = {
  instanceId: "instance-1",
  environmentId: EnvironmentId.make(SANDBOX_ENV),
  configId: "config-1",
  threadId: ThreadId.make("thread-1"),
  provider: "boat",
  sandboxId: "bx_46wrabcd",
  label: "web on Boat small",
  size: "small",
  state: "running",
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  httpBaseUrl: "https://bx.example.test",
  runningSince: "2026-11-01T10:00:00.000Z",
  maxRunningMinutes: 480,
};

const config = (onSettle?: "ask" | "snapshot" | "delete") => ({
  id: "config-1",
  label: "Boat small",
  provider: "boat",
  size: "small",
  passGithubToken: false,
  joinTailnet: false,
  access: "public",
  envFiles: {},
  idleMinutes: 30,
  maxRunningMinutes: 480,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...(onSettle === undefined ? {} : { onSettle }),
});

function setup(
  onSettle?: "ask" | "snapshot" | "delete",
  work?: unknown,
  options: {
    readonly bridged?: boolean;
    readonly state?: SandboxRecord["state"];
    readonly hostTitle?: string;
  } = {},
) {
  mocks.hostThread = options.bridged === true;
  mocks.hostTitle = options.hostTitle ?? "Fix the login bug";
  mocks.sandboxes = [
    {
      ...sandbox,
      ...(options.bridged === true ? { hostProjectId: "project-host" } : {}),
      ...(options.state === undefined ? {} : { state: options.state }),
    },
  ];
  mocks.configs = [config(onSettle)];
  mocks.work = work ?? { status: "clean", uncommittedFiles: 0, unpushedCommits: 0 };
  for (const mock of [
    mocks.deleteSandbox,
    mocks.stopSandbox,
    mocks.saveConfig,
    mocks.checkWork,
    mocks.removeEnvironment,
    mocks.resumeSandbox,
    mocks.deleteSandboxThread,
    mocks.renameThread,
  ]) {
    mock.mockClear();
  }
}

describe("SandboxThreadCoordinator", () => {
  it("asks on settle, keeps a snapshot, and remembers the choice for the config", async () => {
    setup();
    await using _screen = await render(<SandboxThreadCoordinator />);

    notifySandboxThreadSettled(threadRef);
    await expect.element(page.getByText("Keep this chat's sandbox?")).toBeVisible();
    await expect
      .element(page.getByText(/Boat keeps a stopped disk for 14 days and bills for it/u))
      .toBeVisible();
    await expect
      .element(page.getByText(/Deleting the sandbox deletes this conversation too/u))
      .toBeVisible();
    await userEvent.click(page.getByText("Remember for Boat small"));
    await userEvent.click(page.getByRole("button", { name: "Keep snapshot" }));

    await vi.waitFor(() =>
      expect(mocks.stopSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ input: { instanceId: "instance-1" } }),
      ),
    );
    expect(mocks.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { config: expect.objectContaining({ id: "config-1", onSettle: "snapshot" }) },
      }),
    );
    expect(mocks.deleteSandbox).not.toHaveBeenCalled();
  });

  it("spaces the remember choice and the work check off the footer, like the app's dialogs", async () => {
    setup("ask", { status: "dirty", uncommittedFiles: 2, unpushedCommits: 1 });
    await using _screen = await render(<SandboxThreadCoordinator />);

    // Content below a dialog's header ends 16px above the footer, as upstream's dialogs do.
    const gapAboveFooter = (element: Element) => {
      const footer = document.querySelector('[data-slot="alert-dialog-footer"]')!;
      const content = document.createRange();
      content.selectNodeContents(element);
      return footer.getBoundingClientRect().top - content.getBoundingClientRect().bottom;
    };
    notifySandboxThreadSettled(threadRef);
    const remember = page.getByText("Remember for Boat small");
    await expect.element(remember).toBeVisible();
    expect(gapAboveFooter(remember.element().closest("label")!)).toBeGreaterThanOrEqual(16);

    await userEvent.click(page.getByRole("button", { name: "Delete sandbox…" }));
    const status = page.getByText("2 uncommitted files and 1 unpushed commit would be lost.");
    await expect.element(status).toBeVisible();
    expect(gapAboveFooter(status.element())).toBeGreaterThanOrEqual(16);
  });

  it("deletes from the prompt only after a confirmation that shows the work check", async () => {
    setup("ask", { status: "dirty", uncommittedFiles: 2, unpushedCommits: 1 });
    await using _screen = await render(<SandboxThreadCoordinator />);

    notifySandboxThreadSettled(threadRef);
    await userEvent.click(page.getByRole("button", { name: "Delete sandbox…" }));
    await expect.element(page.getByText("Delete sandbox bx_46wr?")).toBeVisible();
    await expect
      .element(page.getByText("2 uncommitted files and 1 unpushed commit would be lost."))
      .toBeVisible();
    expect(mocks.deleteSandbox).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Delete sandbox", exact: true }));
    await vi.waitFor(() =>
      expect(mocks.deleteSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          input: { provider: "boat", sandboxId: "bx_46wrabcd", instanceId: "instance-1" },
        }),
      ),
    );
    await vi.waitFor(() => expect(mocks.removeEnvironment).toHaveBeenCalledWith(SANDBOX_ENV));
  });

  it("stops without asking when the config keeps a snapshot", async () => {
    setup("snapshot");
    await using _screen = await render(<SandboxThreadCoordinator />);

    notifySandboxThreadSettled(threadRef);
    await vi.waitFor(() => expect(mocks.stopSandbox).toHaveBeenCalledOnce());
    await expect.element(page.getByText("Keep this chat's sandbox?")).not.toBeInTheDocument();
  });

  it("still confirms a remembered delete when the work could not be checked", async () => {
    setup("delete", {
      status: "unknown",
      uncommittedFiles: 0,
      unpushedCommits: 0,
      detail: "The sandbox did not answer in time.",
    });
    await using _screen = await render(<SandboxThreadCoordinator />);

    notifySandboxThreadSettled(threadRef);
    await expect
      .element(
        page.getByText("Couldn't check for unpushed work. The sandbox did not answer in time."),
      )
      .toBeVisible();
    expect(mocks.deleteSandbox).not.toHaveBeenCalled();
  });

  it("names the sandbox when its thread is deleted, and deletes both on confirm", async () => {
    setup();
    await using _screen = await render(<SandboxThreadCoordinator />);

    const deleteThread = vi.fn(async () => ({ _tag: "Success" }));
    const done = deleteSandboxThread(threadRef, deleteThread);
    await expect
      .element(page.getByText(`Delete "Fix the login bug" and its sandbox?`))
      .toBeVisible();
    await expect.element(page.getByText(/Also deletes sandbox bx_46wr on Boat/u)).toBeVisible();
    await expect.element(page.getByText("No uncommitted or unpushed work.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Delete thread and sandbox" }));
    await done;
    expect(deleteThread).toHaveBeenCalledOnce();
    expect(mocks.deleteSandbox).toHaveBeenCalledOnce();
  });

  describe("a thread the sandbox bridge drives from the host", () => {
    it("says on settle that the conversation stays here and only the disk can be lost", async () => {
      setup("ask", undefined, { bridged: true });
      await using _screen = await render(<SandboxThreadCoordinator />);

      notifySandboxThreadSettled(hostRef);
      await expect.element(page.getByText("Keep this chat's sandbox?")).toBeVisible();
      await expect
        .element(page.getByText(/Deleting the sandbox keeps this conversation here/u))
        .toBeVisible();
      await expect
        .element(page.getByText(/Deleting the sandbox deletes this conversation too/u))
        .not.toBeInTheDocument();
    });

    it("deletes the sandbox from the header menu and keeps the conversation", async () => {
      setup("ask", { status: "dirty", uncommittedFiles: 1, unpushedCommits: 0 }, { bridged: true });
      await using _screen = await render(<SandboxThreadCoordinator />);

      const done = deleteThreadSandbox(hostRef);
      await expect.element(page.getByText("Delete sandbox bx_46wr?")).toBeVisible();
      await expect
        .element(page.getByText(/The conversation stays in this thread on this computer/u))
        .toBeVisible();
      await expect.element(page.getByText("1 uncommitted file would be lost.")).toBeVisible();
      await userEvent.click(page.getByRole("button", { name: "Delete sandbox", exact: true }));
      await done;
      expect(mocks.deleteSandbox).toHaveBeenCalledOnce();
      expect(mocks.deleteSandboxThread).not.toHaveBeenCalled();
    });

    it("deleting the host thread also deletes the sandbox's copy and the sandbox", async () => {
      setup("ask", undefined, { bridged: true });
      await using _screen = await render(<SandboxThreadCoordinator />);

      const deleteThread = vi.fn(async () => ({ _tag: "Success" }));
      const done = deleteSandboxThread(hostRef, deleteThread);
      await expect
        .element(page.getByText(`Delete "Fix the login bug" and its sandbox?`))
        .toBeVisible();
      await expect
        .element(page.getByText(/Also deletes sandbox bx_46wr on Boat, with its disk/u))
        .toBeVisible();
      await userEvent.click(page.getByRole("button", { name: "Delete thread and sandbox" }));
      await done;
      expect(deleteThread).toHaveBeenCalledOnce();
      expect(mocks.deleteSandboxThread).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: SANDBOX_ENV, input: { threadId: "thread-1" } }),
      );
      expect(mocks.deleteSandbox).toHaveBeenCalledOnce();
    });

    it("gives the host's mirror the sandbox thread's title, once", async () => {
      setup("ask", undefined, { bridged: true, hostTitle: "New thread" });
      await using screen = await render(<SandboxThreadCoordinator />);

      await expect.poll(() => mocks.renameThread.mock.calls.length).toBe(1);
      expect(mocks.renameThread).toHaveBeenCalledWith({
        environmentId: HOST_ENV,
        input: { threadId: "thread-1", title: "Fix the login bug" },
      });
      await screen.rerender(<SandboxThreadCoordinator />);
      expect(mocks.renameThread).toHaveBeenCalledOnce();
    });

    it("leaves a mirror alone when its title already matches", async () => {
      setup("ask", undefined, { bridged: true });
      await using _screen = await render(<SandboxThreadCoordinator />);
      expect(mocks.renameThread).not.toHaveBeenCalled();
    });

    it("resumes a stopped sandbox without waiting for it, since the host's turn waits", async () => {
      setup("ask", undefined, { bridged: true, state: "stopped" });
      await using _screen = await render(<SandboxThreadCoordinator />);

      await expect(ensureSandboxThreadRunning(hostRef)).resolves.toBe(true);
      expect(mocks.resumeSandbox).toHaveBeenCalledOnce();
    });
  });
});
