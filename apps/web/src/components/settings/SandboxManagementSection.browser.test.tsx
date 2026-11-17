import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, ProjectId, type SandboxRecord, ThreadId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  sandboxes: [] as Array<unknown>,
  orphans: [] as Array<unknown>,
  configs: [] as Array<unknown>,
  providers: undefined as Array<unknown> | undefined,
  deleteSandbox: vi.fn(async () => AsyncResult.success({ warnings: [] })),
  stopSandbox: vi.fn(async () => AsyncResult.success(undefined)),
  navigate: vi.fn(),
  threads: [] as Array<unknown>,
}));

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useThreadShells: (() => mocks.threads) as never,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => mocks.navigate) as never,
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
            ? { providers: mocks.providers ?? [boatInfo], host: { github: false } }
            : null,
    isPending: false,
    error: null,
    refresh: () => {},
  })) as never,
}));

import "~/index.css";
import { useComposerDraftStore } from "~/composerDraftStore";
import { SandboxManagementSection } from "./SandboxManagementSection";
import { SettingsGroup } from "./SettingsGroup";

const boatInfo = {
  kind: "boat",
  label: "Boat",
  detail: "",
  apiKeyLabel: "Boat API key",
  apiKeyPlaceholder: "",
  docsUrl: "https://boat.dev",
  sizes: [
    { id: "small", label: "Small", detail: "2 vCPU" },
    { id: "default", label: "Default", detail: "4 vCPU" },
  ],
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
  mocks.threads = [];
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

  it("says a sandbox that keeps itself up stops on idle, not at its running limit", async () => {
    setup("running", {
      configId: "config-1",
      threadId: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      projectTitle: "hello",
      sandboxId: "bx_46wrgghp",
      size: "small",
      idleMinutes: 30,
      keepAliveKey: { name: "t3-keepalive-hello-abc" },
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
        envFiles: {},
        idleMinutes: 30,
        maxRunningMinutes: 480,
        createdAt: "2026-11-01T09:00:00.000Z",
        updatedAt: "2026-11-01T09:00:00.000Z",
      },
    ];
    mocks.providers = [
      { ...boatInfo, capabilities: { ...boatInfo.capabilities, keepAlive: true } },
    ];
    await using _screen = await render(<SandboxManagementSection />);

    await expect.element(page.getByText("Small · stops after 30 min without work")).toBeVisible();
    await expect
      .element(page.getByText("hello · bx_46wr · up 2 h · stops after 30 min without work"))
      .toBeVisible();
    mocks.providers = [boatInfo];
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
    // It still bills, so the row says the message is waiting and leads back to it.
    await expect.element(page.getByText(/Its first message has not reached it yet/u)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Open draft" }));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/draft/$draftId",
      params: { draftId: "draft-1" },
    });
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

  it("nests subagents' sandboxes under the thread that delegated their tasks", async () => {
    const hostEnvironmentId = EnvironmentId.make("11111111-1111-4111-8111-111111111111");
    const chatThreadId = ThreadId.make("thread-chat");
    const plainThreadId = ThreadId.make("thread-plain");
    const config = {
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
      createdAt: "2026-11-01T09:00:00.000Z",
      updatedAt: "2026-11-01T09:00:00.000Z",
    };
    const subagent = (patch: Partial<SandboxRecord>): SandboxRecord => ({
      ...sandbox("running"),
      configId: "config-1",
      projectTitle: "hello",
      label: "hello subagent on Boat small",
      ...patch,
    });
    setup("running");
    mocks.configs = [config];
    mocks.threads = [
      {
        environmentId: EnvironmentId.make("22222222-2222-4222-8222-222222222222"),
        id: chatThreadId,
        title: "Try the new parser",
      },
      { environmentId: hostEnvironmentId, id: plainThreadId, title: "Speed up the test suite" },
    ];
    mocks.sandboxes = [
      {
        ...sandbox("running"),
        instanceId: "instance-chat",
        sandboxId: "bx_chat1234",
        configId: "config-1",
        threadId: chatThreadId,
        projectTitle: "hello",
        label: "hello on Boat small",
        size: "small",
      },
      subagent({
        instanceId: "instance-sub-chat",
        sandboxId: "bx_subchat1",
        parentThreadId: chatThreadId,
        size: "default",
      }),
      subagent({
        instanceId: "instance-sub-1",
        sandboxId: "bx_subone12",
        parentThreadId: plainThreadId,
        size: "default",
      }),
      subagent({
        instanceId: "instance-sub-2",
        sandboxId: "bx_subtwo12",
        parentThreadId: plainThreadId,
        size: "small",
        state: "stopped",
        runningSince: null,
        stoppedAt: "2026-11-01T11:30:00.000Z",
      }),
    ];
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(820, 560);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await using _screen = await render(
      // The settings card the section sits in, which the mocked layout leaves out.
      <div className="w-[760px] bg-background p-6">
        <SettingsGroup>
          <SandboxManagementSection />
        </SettingsGroup>
      </div>,
    );

    // The plain thread gets a line of its own, with its two subagent sandboxes under it.
    await expect.element(page.getByText("Speed up the test suite", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Parent thread · 2 subagent sandboxes")).toBeVisible();
    await expect
      .element(page.getByText("Subagent's sandbox · bx_subo · Default · up 2 h · stops in 6 h"))
      .toBeVisible();
    await expect
      .element(page.getByText("Subagent's sandbox · bx_subt · Small · stopped 30 min"))
      .toBeVisible();
    // The sandbox chat's own subagent sits under that chat's sandbox, with no line of its own.
    await expect
      .element(page.getByText("Subagent's sandbox · bx_subc · Default · up 2 h · stops in 6 h"))
      .toBeVisible();
    await expect
      .element(page.getByText(/Parent thread · 1 subagent sandbox$/u))
      .not.toBeInTheDocument();
    // A subagent's sandbox is never offered as a template source.
    await expect
      .element(page.getByRole("button", { name: "Save as template…" }))
      .not.toBeInTheDocument();
    await page.screenshot({ path: "__screenshots__/sub-sandbox/sandboxes-list.png" });

    // The second Open thread is the plain parent's; the first opens the sandbox chat.
    await userEvent.click(page.getByRole("button", { name: "Open thread" }).nth(1));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: expect.objectContaining({ threadId: plainThreadId }),
    });
    await userEvent.click(page.getByRole("button", { name: "Delete sandbox" }).nth(2));
    await expect
      .element(page.getByText(/along with any work its subagent left that is not pushed/u))
      .toBeVisible();
    await page.screenshot({ path: "__screenshots__/sub-sandbox/delete-confirmation.png" });
  });
});
