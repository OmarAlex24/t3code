import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, ProjectId, type SandboxRecord, ThreadId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  sandboxes: [] as Array<unknown>,
  orphans: [] as Array<unknown>,
  configs: [] as Array<unknown>,
  deleteSandbox: vi.fn(async () => AsyncResult.success({ warnings: [] })),
  stopSandbox: vi.fn(async () => AsyncResult.success(undefined)),
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => 1440) as never,
  useUpdateEnvironmentSettings: (() => () => {}) as never,
}));
vi.mock(import("~/hooks/useNowMinute"), () => ({ useNowMinute: () => "2026-11-01T12:00" }));
// The sandbox's own server is connected, so the row can tell whether its thread is there.
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      {
        environmentId: "22222222-2222-4222-8222-222222222222",
        connection: { phase: "connected" },
        serverConfig: {},
      },
    ],
  })) as never,
}));
vi.mock(import("~/state/sandboxes"), async (original) => ({
  ...(await original()),
  useSandboxProvisionerEnvironmentId: (() =>
    EnvironmentId.make("11111111-1111-4111-8111-111111111111")) as never,
}));
// The settings chrome reads app-wide scope; the row is what is under test.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSection: (({ children }: { children: unknown }) => children) as never,
  SettingsRow: (() => null) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      sandboxesList: (() => "list") as never,
      sandboxesConfigs: (() => "configs") as never,
      sandboxesProviders: (() => "providers") as never,
      sandboxesLimits: (() => "limits") as never,
      sandboxesStop: mocks.stopSandbox as never,
      sandboxesDelete: mocks.deleteSandbox as never,
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data:
      atom === "list"
        ? { sandboxes: mocks.sandboxes, orphans: mocks.orphans }
        : atom === "configs"
          ? { configs: mocks.configs }
          : atom === "providers"
            ? { providers: [boatInfo], host: { github: false } }
            : null,
    isPending: false,
    error: null,
    refresh: () => {},
  })) as never,
}));

import { useComposerDraftStore } from "~/composerDraftStore";
import { SandboxManagementSection } from "./SandboxManagementSection";

const boatInfo = {
  kind: "boat",
  label: "Boat",
  detail: "",
  apiKeyLabel: "Boat API key",
  apiKeyPlaceholder: "",
  docsUrl: "https://boat.dev",
  sizes: [{ id: "small", label: "Small", detail: "2 vCPU" }],
  defaultSize: "small",
  configured: true,
  diskRetentionDays: 14,
  capabilities: {
    limits: false,
    stopResume: true,
    credentialEnvironments: false,
    agentProviderAccess: false,
    templates: false,
  },
};

const sandbox = (state: SandboxRecord["state"]): SandboxRecord => ({
  instanceId: "instance-1",
  environmentId: EnvironmentId.make("22222222-2222-4222-8222-222222222222"),
  provider: "boat",
  sandboxId: "bx_1",
  label: "Web Stack",
  size: "default",
  state,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  httpBaseUrl: "https://bx-1.example.test",
  runningSince: state === "running" ? "2026-11-01T10:00:00.000Z" : null,
  maxRunningMinutes: 480,
});

function setup(state: SandboxRecord["state"], patch: Partial<SandboxRecord> = {}) {
  mocks.sandboxes = [{ ...sandbox(state), ...patch }];
  mocks.orphans = [];
  mocks.configs = [];
  mocks.deleteSandbox.mockClear();
  mocks.stopSandbox.mockClear();
}

describe("SandboxManagementSection", () => {
  it("deletes a running sandbox after the user confirms", async () => {
    setup("running");
    await using _screen = await render(<SandboxManagementSection />);

    await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Delete sandbox" }));
    expect(mocks.deleteSandbox).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: "Delete sandbox" }));
    expect(mocks.deleteSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { provider: "boat", sandboxId: "bx_1", instanceId: "instance-1" },
      }),
    );
    expect(mocks.stopSandbox).not.toHaveBeenCalled();
  });

  it("groups a thread's sandbox under its config with its short id, uptime and time left", async () => {
    setup("running", {
      sandboxId: "bx_46wrgghp",
      configId: "config-1",
      threadId: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      projectTitle: "hello",
      label: "hello on Boat small",
      size: "small",
    });
    mocks.configs = [
      {
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
        createdAt: "2026-11-01T09:00:00.000Z",
        updatedAt: "2026-11-01T09:00:00.000Z",
      },
    ];
    await using _screen = await render(<SandboxManagementSection />);

    await expect.element(page.getByText("Boat small", { exact: true })).toBeVisible();
    // The size is in the config's header, so the row leaves it out and counts down the limit.
    await expect.element(page.getByText("hello · bx_46wr · up 2 h · stops in 6 h")).toBeVisible();
    await userEvent.hover(page.getByText("bx_46wr", { exact: true }));
    await expect.element(page.getByText("bx_46wrgghp", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Running" })).toBeVisible();
  });

  it("recommends deleting a stopped disk close to the provider's retention", async () => {
    setup("stopped", { stoppedAt: "2026-10-20T12:00:00.000Z" });
    await using _screen = await render(<SandboxManagementSection />);

    await expect
      .element(
        page.getByText(/keeps a stopped disk for 14 days; this one has been stopped 12 days/u),
      )
      .toBeVisible();
    // Delete keeps its place and look in every state.
    await expect.element(page.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Delete sandbox" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Delete", exact: true }))
      .not.toBeInTheDocument();
  });

  it("warns about a sandbox whose thread is gone, but not one whose message waits in a draft", async () => {
    const threadId = ThreadId.make("thread-waiting");
    setup("running", { threadId, projectTitle: "hello" });
    useComposerDraftStore.setState({ draftThreadsByThreadKey: {} });
    const first = await render(<SandboxManagementSection />);
    await expect.element(page.getByText(/Its thread was deleted/u)).toBeVisible();
    await first[Symbol.asyncDispose]();

    // The provider on the sandbox is not signed in yet, so the handed-off message has not sent.
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        "draft-1": { threadId, promotedTo: null } as never,
      },
    });
    await using _screen = await render(<SandboxManagementSection />);
    await expect.element(page.getByText("hello", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/Its thread was deleted/u)).not.toBeInTheDocument();
  });

  it("lists tagged sandboxes T3 Code does not track and deletes one on confirm", async () => {
    setup("running");
    mocks.sandboxes = [];
    mocks.orphans = [{ provider: "boat", sandboxId: "bx_lost", name: "lost sandbox" }];
    await using _screen = await render(<SandboxManagementSection />);

    await expect.element(page.getByText("Not tracked by T3 Code", { exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Delete sandbox" }));
    expect(mocks.deleteSandbox).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Delete sandbox" }));
    expect(mocks.deleteSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ input: { provider: "boat", sandboxId: "bx_lost" } }),
    );
  });
  it("lists a fork the agent made under its sandbox, and deleting the sandbox says it goes too", async () => {
    setup("running");
    mocks.orphans = [
      {
        provider: "boat",
        sandboxId: "bx_fork1",
        name: "Web Stack fork",
        forkOf: "instance-1",
      },
    ];
    await using _screen = await render(<SandboxManagementSection />);

    await expect.element(page.getByText("Web Stack fork", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(/Fork made by the agent · bx_fork1 · bills like a sandbox/u))
      .toBeVisible();
    // A fork is not one of the sandboxes T3 Code lost track of.
    await expect
      .element(page.getByText("Not tracked by T3 Code", { exact: true }))
      .not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "Delete sandbox" }).first());
    await expect.element(page.getByText("It also deletes the fork its agent made.")).toBeVisible();
  });
});
