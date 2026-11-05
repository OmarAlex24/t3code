import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, type SandboxRecord, ThreadId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";

const SANDBOX_ENV = "22222222-2222-4222-8222-222222222222";

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
    ],
  })) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useThreadShells: (() => [
    { environmentId: SANDBOX_ENV, id: "thread-1", title: "Fix the login bug" },
  ]) as never,
}));
vi.mock(import("~/state/sandboxes"), async (original) => ({
  ...(await original()),
  useSandboxProvisionerEnvironmentId: (() =>
    EnvironmentId.make("11111111-1111-4111-8111-111111111111")) as never,
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

import { notifySandboxThreadSettled, deleteSandboxThread } from "~/state/sandboxThreads";
import { SandboxThreadCoordinator } from "./SandboxThreadCoordinator";

const threadRef = {
  environmentId: EnvironmentId.make(SANDBOX_ENV),
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
  projectIds: [],
  envFiles: {},
  idleMinutes: 30,
  maxRunningMinutes: 480,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...(onSettle === undefined ? {} : { onSettle }),
});

function setup(onSettle?: "ask" | "snapshot" | "delete", work?: unknown) {
  mocks.sandboxes = [sandbox];
  mocks.configs = [config(onSettle)];
  mocks.work = work ?? { status: "clean", uncommittedFiles: 0, unpushedCommits: 0 };
  for (const mock of [
    mocks.deleteSandbox,
    mocks.stopSandbox,
    mocks.saveConfig,
    mocks.checkWork,
    mocks.removeEnvironment,
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
});
