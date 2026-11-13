import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { type Atom, AsyncResult } from "effect/reactivity";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import {
  EnvironmentId,
  type ScopedThreadRef,
  type SandboxRecord,
  ThreadId,
} from "@t3tools/contracts";
import type { ReactElement } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, fakeTimers, render } from "../../../test/render";

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
  resolveSettle: vi.fn(async () => AsyncResult.success({ warnings: [], resolved: true })),
  settleThread: vi.fn(async () => AsyncResult.success(undefined)),
  unsettleThread: vi.fn(async () => AsyncResult.success(undefined)),
  removeEnvironment: vi.fn(async () => AsyncResult.success(undefined)),
  deleteSandboxThread: vi.fn(async () => AsyncResult.success(undefined)),
  renameThread: vi.fn(async () => AsyncResult.success(undefined)),
  pairLaunch: vi.fn(async () =>
    AsyncResult.success({
      environmentId: "22222222-2222-4222-8222-222222222222",
      httpBaseUrl: "https://bx.example.test",
      pairingCode: "code-1",
      projectId: "project-sandbox",
    }),
  ),
  connectPairing: vi.fn(async () => AsyncResult.success(undefined)),
  // A bridged thread also lives on the host, under the same id.
  hostThread: false,
  hostTitle: "Fix the login bug",
  settled: true,
  // A sandbox deleted outside T3 Code leaves its server unreachable.
  sandboxConnected: true,
  // Saved in this app once but not connected, as after a resume at a new address.
  sandboxSaved: false,
  route: null as ScopedThreadRef | null,
  // This client's grant on the host, which a remote host's session loads after mount.
  pairPermission: null as unknown as Atom.Writable<boolean>,
}));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      ...(mocks.sandboxConnected
        ? [{ environmentId: SANDBOX_ENV, connection: { phase: "connected" }, serverConfig: {} }]
        : mocks.sandboxSaved
          ? [{ environmentId: SANDBOX_ENV, connection: { phase: "error" }, serverConfig: null }]
          : []),
      { environmentId: HOST_ENV, connection: { phase: "connected" }, serverConfig: {} },
    ],
  })) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useThreadShells: (() => {
    const settledOverride = mocks.settled ? "settled" : null;
    return [
      { environmentId: SANDBOX_ENV, id: "thread-1", title: "Fix the login bug", settledOverride },
      ...(mocks.hostThread
        ? [{ environmentId: HOST_ENV, id: "thread-1", title: mocks.hostTitle, settledOverride }]
        : []),
    ];
  }) as never,
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
      settle: mocks.settleThread as never,
      unsettle: mocks.unsettleThread as never,
    },
  };
});
vi.mock(import("~/connection/onboarding"), async (original) => ({
  ...(await original()),
  connectPairing: mocks.connectPairing as never,
}));
vi.mock(import("~/state/sandboxes"), async (original) => ({
  ...(await original()),
  useSandboxProvisionerEnvironmentId: (() => EnvironmentId.make(HOST_ENV)) as never,
}));
vi.mock(import("~/hooks/useThreadRouteTarget"), async (original) => ({
  ...(await original()),
  useThreadRouteRef: (() => mocks.route) as never,
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
  const { Atom } = await import("effect/reactivity");
  mocks.pairPermission = Atom.make(true);
  const permission = { permissionAtom: () => mocks.pairPermission };
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
      sandboxesPairLaunch: Object.assign(mocks.pairLaunch, permission) as never,
      sandboxesResolveSettle: Object.assign(mocks.resolveSettle, permission) as never,
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
  notifySandboxThreadUnsettled,
  threadSandboxUnavailableReason,
} from "~/state/sandboxThreads";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useSandboxConnectionsStore } from "~/state/sandboxConnections";
import { toastManager } from "../ui/toast";
import { SETTLE_DELETE_DELAY_MS, SandboxThreadCoordinator } from "./SandboxThreadCoordinator";

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

// What `useThreadActions.settleThread` hands the coordinator: the settle's Undo claim and plan.
const settleUndo = (ref: ScopedThreadRef) => ({
  claim: ThreadUndo.begin("settle", scopedThreadKey(ref)),
  undo: vi.fn(async () => AsyncResult.success(undefined)),
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
  mocks.settled = true;
  mocks.sandboxConnected = true;
  mocks.sandboxSaved = false;
  mocks.route = null;
  appAtomRegistry.set(mocks.pairPermission, true);
  mocks.sandboxes = [
    {
      ...sandbox,
      ...(options.bridged === true ? { hostProjectId: "project-host" } : {}),
      ...(options.state === undefined ? {} : { state: options.state }),
    },
  ];
  mocks.configs = [config(onSettle)];
  mocks.work = work ?? { status: "clean", uncommittedFiles: 0, unpushedCommits: 0 };
  useSandboxConnectionsStore.setState({ disconnected: [], attempts: new Map() });
  for (const mock of [
    mocks.deleteSandbox,
    mocks.stopSandbox,
    mocks.saveConfig,
    mocks.checkWork,
    mocks.removeEnvironment,
    mocks.resumeSandbox,
    mocks.deleteSandboxThread,
    mocks.renameThread,
    mocks.resolveSettle,
    mocks.settleThread,
    mocks.unsettleThread,
  ]) {
    mock.mockClear();
  }
}

// The host records a settle it could not decide alone; the list push brings it to this app.
async function hostAsks(
  screen: { readonly rerender: (element: ReactElement) => Promise<unknown> },
  reason: "ask" | "work" = "ask",
) {
  mocks.sandboxes = mocks.sandboxes.map((record) => ({
    ...(record as SandboxRecord),
    settlePending: { since: "2026-11-13T10:00:00.000Z", reason },
  }));
  await screen.rerender(<SandboxThreadCoordinator />);
}

describe("SandboxThreadCoordinator", () => {
  it("asks what the host could not decide, keeps a snapshot, and remembers the choice", async () => {
    setup();
    await using screen = await render(<SandboxThreadCoordinator />);

    await hostAsks(screen);
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
      expect(mocks.resolveSettle).toHaveBeenCalledWith(
        expect.objectContaining({ input: { instanceId: "instance-1", choice: "keep" } }),
      ),
    );
    // The host's keep stops the machine, as it does for the phone and Settings.
    expect(mocks.stopSandbox).not.toHaveBeenCalled();
    expect(mocks.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { config: expect.objectContaining({ id: "config-1", onSettle: "snapshot" }) },
      }),
    );
    expect(mocks.deleteSandbox).not.toHaveBeenCalled();
  });

  it("spaces the remember choice and the work check off the footer, like the app's dialogs", async () => {
    setup("ask", { status: "dirty", uncommittedFiles: 2, unpushedCommits: 1 });
    await using screen = await render(<SandboxThreadCoordinator />);

    // Content below a dialog's header ends 16px above the footer, as upstream's dialogs do.
    const gapAboveFooter = (element: Element) => {
      const footer = document.querySelector('[data-slot="alert-dialog-footer"]')!;
      const content = document.createRange();
      content.selectNodeContents(element);
      return footer.getBoundingClientRect().top - content.getBoundingClientRect().bottom;
    };
    await hostAsks(screen);
    const remember = page.getByText("Remember for Boat small");
    await expect.element(remember).toBeVisible();
    expect(gapAboveFooter(remember.element().closest("label")!)).toBeGreaterThanOrEqual(16);

    await userEvent.click(page.getByRole("button", { name: "Delete sandbox…" }));
    const status = page.getByText("2 uncommitted files and 1 unpushed commit would be lost.");
    await expect.element(status).toBeVisible();
    expect(gapAboveFooter(status.element())).toBeGreaterThanOrEqual(16);
  });

  it("answers delete only after a confirmation that shows the work check", async () => {
    setup("delete", { status: "dirty", uncommittedFiles: 2, unpushedCommits: 1 });
    await using screen = await render(<SandboxThreadCoordinator />);

    await hostAsks(screen, "work");
    await expect.element(page.getByText(/may hold work that hasn't been pushed/u)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Delete sandbox…" }));
    await expect.element(page.getByText("Delete sandbox bx_46wr?")).toBeVisible();
    await expect
      .element(page.getByText("2 uncommitted files and 1 unpushed commit would be lost."))
      .toBeVisible();
    expect(mocks.resolveSettle).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Delete sandbox", exact: true }));
    await vi.waitFor(() =>
      expect(mocks.resolveSettle).toHaveBeenCalledWith(
        expect.objectContaining({ input: { instanceId: "instance-1", choice: "delete" } }),
      ),
    );
    await vi.waitFor(() => expect(mocks.removeEnvironment).toHaveBeenCalledWith(SANDBOX_ENV));
    expect(mocks.deleteSandbox).not.toHaveBeenCalled();
  });

  it("leaves decisions already waiting when it starts to Settings and the chat's row", async () => {
    setup();
    mocks.sandboxes = [
      { ...sandbox, settlePending: { since: "2026-11-12T10:00:00.000Z", reason: "ask" } },
    ];
    await using screen = await render(<SandboxThreadCoordinator />);
    await screen.rerender(<SandboxThreadCoordinator />);
    await expect.element(page.getByText("Keep this chat's sandbox?")).not.toBeInTheDocument();
  });

  it("closes the question once it is answered elsewhere", async () => {
    setup();
    await using screen = await render(<SandboxThreadCoordinator />);
    await hostAsks(screen);
    await expect.element(page.getByText("Keep this chat's sandbox?")).toBeVisible();
    mocks.sandboxes = [sandbox];
    await screen.rerender(<SandboxThreadCoordinator />);
    await expect.element(page.getByText("Keep this chat's sandbox?")).not.toBeInTheDocument();
  });

  it("decides nothing itself on settle: no stop, check, or delete", async () => {
    for (const onSettle of [undefined, "snapshot", "delete"] as const) {
      setup(onSettle);
      await using _screen = await render(<SandboxThreadCoordinator />);
      using _timers = fakeTimers();
      notifySandboxThreadSettled(threadRef, settleUndo(threadRef));
      await vi.advanceTimersByTimeAsync(SETTLE_DELETE_DELAY_MS);
      expect(mocks.stopSandbox).not.toHaveBeenCalled();
      expect(mocks.checkWork).not.toHaveBeenCalled();
      expect(mocks.deleteSandbox).not.toHaveBeenCalled();
      expect(mocks.resolveSettle).not.toHaveBeenCalled();
    }
  });

  it("says a remembered delete is coming, with the settle's Undo", async () => {
    setup("delete", undefined, { bridged: true });
    using toast = vi.spyOn(toastManager, "add");
    await using _screen = await render(<SandboxThreadCoordinator />);
    using _timers = fakeTimers();

    const settle = settleUndo(threadRef);
    expect(notifySandboxThreadSettled(threadRef, settle)).toBe(true);
    const [options] = toast.mock.calls.at(-1)!;
    expect(options).toEqual(
      expect.objectContaining({
        title: "Settled · sandbox bx_46wr will be deleted in 10 s",
        actionProps: expect.objectContaining({ children: "Undo" }),
      }),
    );
    (options.actionProps as { onClick: () => void }).onClick();
    expect(settle.undo).toHaveBeenCalledOnce();
    expect(settle.claim.isCurrent()).toBe(false);
  });

  it("ends the settle's Undo with the notice", async () => {
    setup("delete", undefined, { bridged: true });
    await using _screen = await render(<SandboxThreadCoordinator />);
    using _timers = fakeTimers();

    const settle = settleUndo(threadRef);
    notifySandboxThreadSettled(threadRef, settle);
    await vi.advanceTimersByTimeAsync(SETTLE_DELETE_DELAY_MS - 1);
    expect(settle.claim.isCurrent()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(settle.claim.isCurrent()).toBe(false);
    expect(settle.undo).not.toHaveBeenCalled();
  });

  it("promises nothing for a chat the host does not mirror, and points to Settings", async () => {
    setup("delete");
    using toast = vi.spyOn(toastManager, "add");
    await using _screen = await render(<SandboxThreadCoordinator />);

    // The plain Settled notice, with its own Undo, stays the caller's.
    expect(notifySandboxThreadSettled(threadRef, settleUndo(threadRef))).toBe(false);
    const titles = toast.mock.calls.map(([options]) => options.title);
    expect(titles).not.toContain("Settled · sandbox bx_46wr will be deleted in 10 s");
    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Sandbox bx_46wr is left as it is",
        actionProps: expect.objectContaining({ children: "Open Sandboxes" }),
      }),
    );
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

  it("deletes a sandbox deleted outside T3 Code from its thread's menu, through the same confirmation", async () => {
    setup(undefined, undefined, { state: "deleted" });
    mocks.sandboxConnected = false;
    await using _screen = await render(<SandboxThreadCoordinator />);

    await vi.waitFor(() =>
      expect(threadSandboxUnavailableReason(threadRef)).toBe("The sandbox no longer exists"),
    );
    const done = deleteThreadSandbox(threadRef);
    await expect.element(page.getByText("Delete sandbox bx_46wr?")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Delete sandbox", exact: true }));
    await done;
    expect(mocks.deleteSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { provider: "boat", sandboxId: "bx_46wrabcd", instanceId: "instance-1" },
      }),
    );
    expect(threadSandboxUnavailableReason(hostRef)).toBeNull();
  });

  describe("a thread the sandbox bridge drives from the host", () => {
    it("settles and un-settles the host's thread with the sandbox's, so the host decides once", async () => {
      setup("ask", undefined, { bridged: true });
      await using _screen = await render(<SandboxThreadCoordinator />);

      notifySandboxThreadSettled(threadRef, settleUndo(threadRef));
      expect(mocks.settleThread).toHaveBeenCalledWith({
        environmentId: HOST_ENV,
        input: { threadId: "thread-1" },
      });
      notifySandboxThreadUnsettled(threadRef);
      expect(mocks.unsettleThread).toHaveBeenCalledWith({
        environmentId: HOST_ENV,
        input: { threadId: "thread-1", reason: "user" },
      });
      // The host's own thread is the one it hears from; nothing more to forward.
      notifySandboxThreadSettled(hostRef, settleUndo(hostRef));
      notifySandboxThreadUnsettled(hostRef);
      expect(mocks.settleThread).toHaveBeenCalledOnce();
      expect(mocks.unsettleThread).toHaveBeenCalledOnce();
    });

    it("says on settle that the chat is kept and only the disk can be lost", async () => {
      setup("ask", undefined, { bridged: true });
      await using screen = await render(<SandboxThreadCoordinator />);

      await hostAsks(screen);
      await expect.element(page.getByText("Keep this chat's sandbox?")).toBeVisible();
      await expect
        .element(
          page.getByText(
            /If you delete the sandbox, the chat is kept, under Settled; only work on its disk/u,
          ),
        )
        .toBeVisible();
      await expect
        .element(page.getByText(/Deleting the sandbox deletes this conversation too/u))
        .not.toBeInTheDocument();
    });

    it("deletes the sandbox from the header menu and keeps the chat, in the same words", async () => {
      setup("ask", { status: "dirty", uncommittedFiles: 1, unpushedCommits: 0 }, { bridged: true });
      const toast = vi.spyOn(toastManager, "add");
      await using _screen = await render(<SandboxThreadCoordinator />);

      // A host thread's menu never blames the sandbox: its own server takes its changes.
      await vi.waitFor(() => expect(threadSandboxUnavailableReason(threadRef)).not.toBeNull());
      expect(threadSandboxUnavailableReason(hostRef)).toBeNull();
      const done = deleteThreadSandbox(threadRef);
      await expect.element(page.getByText("Delete sandbox bx_46wr?")).toBeVisible();
      await expect
        .element(
          page.getByText(/The chat is kept, under Settled; only work on the sandbox's disk/u),
        )
        .toBeVisible();
      await expect.element(page.getByText("1 uncommitted file would be lost.")).toBeVisible();
      await userEvent.click(page.getByRole("button", { name: "Delete sandbox", exact: true }));
      await done;
      expect(mocks.deleteSandbox).toHaveBeenCalledOnce();
      expect(mocks.deleteSandboxThread).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Deleted sandbox bx_46wr",
          description: "The chat is kept, under Settled.",
        }),
      );
      toast.mockRestore();
    });

    it("deleting the sandbox's thread also deletes the host's mirror and the sandbox", async () => {
      setup("ask", undefined, { bridged: true });
      await using _screen = await render(<SandboxThreadCoordinator />);

      const deleteThread = vi.fn(async () => ({ _tag: "Success" }));
      const done = deleteSandboxThread(threadRef, deleteThread);
      await expect
        .element(page.getByText(/Also deletes sandbox bx_46wr on Boat, with its disk/u))
        .toBeVisible();
      await userEvent.click(page.getByRole("button", { name: "Delete thread and sandbox" }));
      await done;
      expect(deleteThread).toHaveBeenCalledOnce();
      expect(mocks.deleteSandboxThread).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: HOST_ENV, input: { threadId: "thread-1" } }),
      );
      expect(mocks.deleteSandbox).toHaveBeenCalledOnce();
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

    it("keeps naming the mirror after the sandbox's thread while it stands in for a stopped one", async () => {
      // The chat lists as the mirror now, and the phone still sees the sandbox thread's title.
      setup("ask", undefined, { bridged: true, hostTitle: "New thread", state: "stopped" });
      await using _screen = await render(<SandboxThreadCoordinator />);

      await expect.poll(() => mocks.renameThread.mock.calls.length).toBe(1);
      expect(mocks.renameThread).toHaveBeenCalledWith({
        environmentId: HOST_ENV,
        input: { threadId: "thread-1", title: "Fix the login bug" },
      });
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

  describe("pairing", () => {
    const linked = {
      ...sandbox,
      hostProjectId: "project-host",
      bridge: {
        sessionId: "bridge-session-1",
        secret: "sandbox-bridge-1",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    };

    // The chat's mirror is open and this app is not connected to its running sandbox.
    const openChat = (saved: boolean) => {
      setup("ask", undefined, { bridged: true });
      mocks.sandboxConnected = false;
      mocks.sandboxSaved = saved;
      mocks.sandboxes = [linked];
      mocks.route = hostRef;
      mocks.pairLaunch.mockClear();
      mocks.connectPairing.mockClear();
    };

    it("connects to the open chat's sandbox at its current address, saved here or not", async () => {
      for (const saved of [false, true]) {
        openChat(saved);
        await using _screen = await render(<SandboxThreadCoordinator />);

        await vi.waitFor(() =>
          expect(mocks.connectPairing).toHaveBeenCalledWith({
            host: "https://bx.example.test",
            pairingCode: "code-1",
            expectedEnvironmentId: SANDBOX_ENV,
          }),
        );
        expect(mocks.pairLaunch).toHaveBeenCalledWith({
          environmentId: HOST_ENV,
          input: { threadId: "thread-1" },
        });
        // One attempt, not one per render.
        expect(mocks.pairLaunch).toHaveBeenCalledOnce();
      }
    });

    it("connects once this client's grant on the host loads after mount", async () => {
      openChat(false);
      appAtomRegistry.set(mocks.pairPermission, false);
      await using _screen = await render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <SandboxThreadCoordinator />
        </RegistryContext.Provider>,
      );
      expect(mocks.pairLaunch).not.toHaveBeenCalled();

      await act(() => appAtomRegistry.set(mocks.pairPermission, true));
      await vi.waitFor(() => expect(mocks.pairLaunch).toHaveBeenCalledOnce());
    });

    it("keeps a refused connect for the chat's action and does not retry it at once", async () => {
      openChat(false);
      using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const refusal = new Error("The sandbox is not ready yet.");
      mocks.pairLaunch.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(refusal)) as never);
      await using screen = await render(<SandboxThreadCoordinator />);

      await vi.waitFor(() =>
        expect(
          useSandboxConnectionsStore.getState().attempts.get(EnvironmentId.make(SANDBOX_ENV)),
        ).toEqual({ connecting: false, failure: refusal }),
      );
      expect(warn).toHaveBeenCalledWith(expect.any(String), refusal);
      await screen.rerender(<SandboxThreadCoordinator />);
      expect(mocks.pairLaunch).toHaveBeenCalledOnce();
      expect(mocks.connectPairing).not.toHaveBeenCalled();
    });

    it("leaves a sandbox alone while it starts, once this app is paired, or when it is stopped", async () => {
      setup("ask", undefined, { bridged: true });
      mocks.pairLaunch.mockClear();
      mocks.route = hostRef;
      // Paired already: its environment is in this app.
      mocks.sandboxes = [linked];
      await using _paired = await render(<SandboxThreadCoordinator />);
      mocks.sandboxConnected = false;
      mocks.sandboxes = [
        { ...linked, state: "provisioning" },
        { ...linked, instanceId: "instance-2", threadId: "thread-2", state: "stopped" },
      ];
      await using _screen = await render(<SandboxThreadCoordinator />);
      expect(mocks.pairLaunch).not.toHaveBeenCalled();
    });

    it("does not pair again with a sandbox this app was disconnected from", async () => {
      openChat(true);
      useSandboxConnectionsStore.setState({ disconnected: [EnvironmentId.make(SANDBOX_ENV)] });
      await using _screen = await render(<SandboxThreadCoordinator />);
      expect(mocks.pairLaunch).not.toHaveBeenCalled();
    });
  });
});
