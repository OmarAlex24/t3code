import { secondTick } from "@t3tools/client-runtime/clock";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type SandboxRecord,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { dismissContextMenu } from "../contextMenuFallback";
import { registerSandboxThreadHandlers } from "../state/sandboxThreads";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

const HOST = EnvironmentId.make("host");
const SANDBOX = EnvironmentId.make("sandbox-bridged");
const LEGACY_SANDBOX = EnvironmentId.make("sandbox-legacy");
const REMOTE = EnvironmentId.make("remote-mac");
const bridgedThreadId = ThreadId.make("thread-bridged");
const legacyThreadId = ThreadId.make("thread-legacy");
const remoteThreadId = ThreadId.make("thread-remote");

const mocks = vi.hoisted(() => ({ sandboxes: [] as Array<unknown> }));

vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, sandboxesList: (() => "list") as never },
  };
});
vi.mock(import("~/state/query"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useEnvironmentQuery: ((atom: unknown) =>
      atom === "list"
        ? {
            data: { sandboxes: mocks.sandboxes, orphans: [] },
            isPending: false,
            error: null,
            refresh: () => {},
          }
        : actual.useEnvironmentQuery(atom as never)) as never,
  };
});

function project(environmentId: EnvironmentId, id: string, title: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId,
    title,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    scripts: [],
  };
}

function shell(
  environmentId: EnvironmentId,
  id: ThreadId,
  projectId: string,
  title: string,
): EnvironmentThreadShell {
  return {
    environmentId,
    id,
    projectId: ProjectId.make(projectId),
    title,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    linkOrigin: null,
    delegatedFrom: null,
    activeProviderThreadId: null,
    latestRun: null,
    runtime: null,
    latestUserMessageAt: "2026-11-01T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    goal: null,
    itemCount: 2,
    visibleItemCount: 2,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    pullRequests: [],
    lastVisitedAt: "2026-11-01T10:00:00.000Z",
    deletedAt: null,
    source: {} as EnvironmentThreadShell["source"],
  };
}

const sandbox = (fields: Partial<SandboxRecord>): SandboxRecord => ({
  instanceId: "instance-1",
  environmentId: SANDBOX,
  configId: "config-1",
  threadId: bridgedThreadId,
  provider: "boat",
  sandboxId: "bx_46wrabcd",
  label: "horizon-stack on Boat small",
  size: "small",
  state: "running",
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  httpBaseUrl: "https://bx.example.test",
  runningSince: "2026-11-01T10:00:00.000Z",
  maxRunningMinutes: 480,
  ...fields,
});

// The empty folder T3 made on the host only so the phone has a home for the mirror.
const placeholder = {
  ...project(HOST, "project-host", "horizon-stack"),
  workspaceRoot: "/Users/me/.t3/userdata/sandbox-projects/OmarAlex24/horizon-stack",
};

describe("sandbox chats in the sidebar", () => {
  it("lists a sandbox chat once, as the sandbox's own thread, and keeps one from before the bridge", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    mocks.sandboxes = [
      sandbox({ hostProjectId: ProjectId.make("project-host") }),
      sandbox({
        instanceId: "instance-2",
        environmentId: LEGACY_SANDBOX,
        threadId: legacyThreadId,
      }),
    ];
    vi.mocked(usePrimaryEnvironmentId).mockReturnValue(HOST);
    vi.mocked(useProjects).mockReturnValue([
      placeholder,
      project(SANDBOX, "project-sandbox", "OmarAlex24/horizon-stack"),
      project(LEGACY_SANDBOX, "project-legacy", "OmarAlex24/older-stack"),
    ]);
    vi.mocked(useQuietThreadShells).mockReturnValue([
      shell(HOST, bridgedThreadId, "project-host", "Greeting from boat.dev"),
      shell(SANDBOX, bridgedThreadId, "project-sandbox", "say high from boat.dev:)"),
      shell(LEGACY_SANDBOX, legacyThreadId, "project-legacy", "An older sandbox chat"),
    ]);

    await using _screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await expect.element(page.getByText("say high from boat.dev:)").first()).toBeVisible();
    await expect.element(page.getByText("An older sandbox chat").first()).toBeVisible();
    // The host's mirror is for the phone, and its project holds nothing else.
    await expect.element(page.getByText("Greeting from boat.dev")).not.toBeInTheDocument();
  });

  it("keeps a host copy listed while its sandbox's own thread isn't", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      // Project folders leave out a thread whose project isn't listed.
      boringSidebarEnabled: true,
    });
    mocks.sandboxes = [sandbox({ hostProjectId: ProjectId.make("project-host") })];
    vi.mocked(usePrimaryEnvironmentId).mockReturnValue(HOST);
    vi.mocked(useProjects).mockReturnValue([placeholder]);
    // The sandbox isn't connected, so its thread isn't listed.
    vi.mocked(useQuietThreadShells).mockReturnValue([
      shell(HOST, bridgedThreadId, "project-host", "Greeting from boat.dev"),
    ]);

    await using _screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await expect.element(page.getByText("Greeting from boat.dev").first()).toBeVisible();
  });

  it("draws a sandbox thread's machine as its provider's mark and a paired machine as its icon", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    mocks.sandboxes = [
      sandbox({ environmentId: LEGACY_SANDBOX, threadId: legacyThreadId, provider: "vercel" }),
    ];
    vi.mocked(usePrimaryEnvironmentId).mockReturnValue(HOST);
    vi.mocked(useProjects).mockReturnValue([
      project(LEGACY_SANDBOX, "project-legacy", "OmarAlex24/older-stack"),
      project(REMOTE, "project-remote", "OmarAlex24/remote-stack"),
    ]);
    vi.mocked(useQuietThreadShells).mockReturnValue([
      shell(LEGACY_SANDBOX, legacyThreadId, "project-legacy", "Runs on a Vercel sandbox"),
      shell(REMOTE, remoteThreadId, "project-remote", "Runs on a paired Mac"),
    ]);

    await using _screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    const rowOf = async (title: string) => {
      const titleText = page.getByText(title).first();
      await expect.element(titleText).toBeVisible();
      const row = titleText.element().closest("li[data-thread-item]");
      expect(row).not.toBeNull();
      return row as HTMLElement;
    };
    const vercelMark = 'svg[viewBox="0 0 76 65"]';
    const sandboxRow = await rowOf("Runs on a Vercel sandbox");
    expect(sandboxRow.querySelector(vercelMark)).not.toBeNull();
    expect(sandboxRow.querySelector("svg.lucide-server")).toBeNull();
    const remoteRow = await rowOf("Runs on a paired Mac");
    expect(remoteRow.querySelector("svg.lucide-server")).not.toBeNull();
    expect(remoteRow.querySelector(vercelMark)).toBeNull();
  });

  it("marks a stopped sandbox's thread frozen and one resuming as starting, on its own row or a host mirror", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    // Begun 42 seconds ago by the clock the elapsed time reads.
    const resumingSince = new Date(secondTick.getSnapshot() - 42_000).toISOString();
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    mocks.sandboxes = [
      sandbox({
        hostProjectId: ProjectId.make("project-host"),
        state: "stopped",
        runningSince: null,
        stoppedAt: "2026-11-10T11:00:00.000Z",
      }),
      // Its own thread is not listed (its server is still off), so the host's mirror stands in.
      sandbox({
        instanceId: "instance-2",
        environmentId: LEGACY_SANDBOX,
        threadId: legacyThreadId,
        sandboxId: "bx_9kq2wxyz",
        hostProjectId: ProjectId.make("project-host"),
        state: "stopped",
        runningSince: null,
        resumingSince,
      }),
    ];
    vi.mocked(usePrimaryEnvironmentId).mockReturnValue(HOST);
    vi.mocked(useProjects).mockReturnValue([
      placeholder,
      project(SANDBOX, "project-sandbox", "OmarAlex24/horizon-stack"),
      project(REMOTE, "project-remote", "OmarAlex24/remote-stack"),
    ]);
    // Wide enough for the desktop sidebar, so the screenshots show it as users see it.
    await page.viewport(1100, 640);
    vi.mocked(useQuietThreadShells).mockReturnValue([
      shell(SANDBOX, bridgedThreadId, "project-sandbox", "Refactor the billing worker"),
      shell(HOST, legacyThreadId, "project-host", "Add retries to the importer"),
      shell(REMOTE, remoteThreadId, "project-remote", "Runs on a paired Mac"),
    ]);

    await using _screen = await render(
      <SidebarProvider>
        {/* The app's sidebar column, so rows lay out and paint as they do there. */}
        <div className="flex h-[600px] w-80 flex-col bg-sidebar text-sidebar-foreground">
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </div>
      </SidebarProvider>,
    );

    const rowOf = async (title: string) => {
      const titleText = page.getByText(title).first();
      await expect.element(titleText).toBeVisible();
      const row = titleText.element().closest("li[data-thread-item]");
      expect(row).not.toBeNull();
      return row as HTMLElement;
    };
    const frozen = await rowOf("Refactor the billing worker");
    expect(frozen.querySelector('[data-sandbox-phase="stopped"] svg.lucide-pause')).not.toBeNull();
    await expect
      .element(page.getByRole("button", { name: /^Refactor the billing worker, Sandbox stopped/ }))
      .toBeInTheDocument();
    // Muted until hovered, like a row that is still setting up.
    expect(frozen.querySelector("[data-sidebar-row]")?.className).toContain("opacity-70");
    // Said in the status slot, where its last activity time would be.
    const stoppedStatus = page.elementLocator(frozen).getByText("Stopped", { exact: true }).first();
    await expect.element(stoppedStatus).toBeVisible();
    expect(
      stoppedStatus.element().closest("span")?.querySelector("svg.lucide-pause"),
    ).not.toBeNull();
    expect(frozen.textContent).not.toContain("9d");

    // The host thread the bridge drives is local, but it shows its sandbox's start.
    const waking = await rowOf("Add retries to the importer");
    expect(waking.textContent).toMatch(/Starting sandbox4\ds/);
    expect(waking.querySelector('[data-sandbox-phase="stopped"]')).toBeNull();
    expect(waking.querySelector(".motion-safe\\:animate-status-pulse")).not.toBeNull();

    // A paired machine is no sandbox, so it keeps its usual look.
    const remote = await rowOf("Runs on a paired Mac");
    expect(remote.querySelector("[data-sandbox-phase]")).toBeNull();
    expect(remote.textContent).not.toContain("Starting sandbox");

    await page.screenshot({ path: "__screenshots__/sandbox-state-rows.png" });
    // Up close, where the badge on the provider's mark can be checked.
    document.documentElement.style.zoom = "3";
    await page.screenshot({ path: "__screenshots__/sandbox-state-rows-zoomed.png" });
    document.documentElement.style.zoom = "";
    await userEvent.hover(page.elementLocator(frozen.querySelector("[data-sidebar-row]")!));
    const hint = page.getByText("send a message to resume it", { exact: true });
    await expect.element(hint).toBeVisible();
    const hintLine = hint.element().parentElement!;
    expect(hintLine.textContent).toBe("Sandbox stopped · send a message to resume it");
    // Past the hover card's fade-in, so the screenshot shows it as read.
    await expect
      .poll(() => {
        let opacity = 1;
        for (let node: Element | null = hint.element(); node !== null; node = node.parentElement) {
          opacity *= Number(getComputedStyle(node).opacity);
        }
        return opacity;
      })
      .toBe(1);
    // On one line: the card makes room rather than splitting the hint.
    expect(hintLine.getClientRects().length).toBe(1);
    expect(hintLine.getBoundingClientRect().height).toBeLessThan(20);
    await page.screenshot({ path: "__screenshots__/sandbox-state-stopped-hover.png" });
  });

  it("lists a stopped sandbox's chat that was mid-run with the active threads, not in Working", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      sidebarWorkingShelfEnabled: true,
    });
    const STARTING = EnvironmentId.make("sandbox-starting");
    const startingThreadId = ThreadId.make("thread-starting");
    mocks.sandboxes = [
      // Stopped at its running limit while a turn ran: its own thread still reads as running.
      sandbox({
        hostProjectId: ProjectId.make("project-host"),
        state: "stopped",
        runningSince: null,
        stoppedAt: "2026-11-10T11:00:00.000Z",
      }),
      // The same, seen through the host's mirror, since its own thread is not listed.
      sandbox({
        instanceId: "instance-2",
        environmentId: LEGACY_SANDBOX,
        threadId: legacyThreadId,
        sandboxId: "bx_9kq2wxyz",
        hostProjectId: ProjectId.make("project-host"),
        state: "stopped",
        runningSince: null,
      }),
      // One already coming back keeps its place in Working.
      sandbox({
        instanceId: "instance-3",
        environmentId: STARTING,
        threadId: startingThreadId,
        sandboxId: "bx_7tq9mnop",
        state: "stopped",
        runningSince: null,
        resumingSince: "2026-11-10T11:00:00.000Z",
      }),
    ];
    vi.mocked(usePrimaryEnvironmentId).mockReturnValue(HOST);
    vi.mocked(useProjects).mockReturnValue([
      placeholder,
      project(SANDBOX, "project-sandbox", "OmarAlex24/horizon-stack"),
      project(STARTING, "project-starting", "OmarAlex24/starting-stack"),
      project(REMOTE, "project-remote", "OmarAlex24/remote-stack"),
    ]);
    await page.viewport(1100, 640);
    const running = (thread: EnvironmentThreadShell): EnvironmentThreadShell => ({
      ...thread,
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerName: "Claude",
        lastError: null,
        updatedAt: "2026-11-10T10:59:00.000Z",
      },
    });
    vi.mocked(useQuietThreadShells).mockReturnValue([
      running(shell(SANDBOX, bridgedThreadId, "project-sandbox", "Refactor the billing worker")),
      running(shell(HOST, legacyThreadId, "project-host", "Add retries to the importer")),
      running(shell(STARTING, startingThreadId, "project-starting", "Port the search index")),
      running(shell(REMOTE, remoteThreadId, "project-remote", "Runs on a paired Mac")),
    ]);

    await using _screen = await render(
      <SidebarProvider>
        <div className="flex h-[600px] w-80 flex-col bg-sidebar text-sidebar-foreground">
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </div>
      </SidebarProvider>,
    );

    const header = page.getByTestId("sidebar-working-header");
    await expect.element(header).toBeVisible();
    // Only the work that really runs: the paired Mac's and the sandbox coming back.
    await expect.poll(() => header.element().textContent?.replace(/\D/g, "")).toBe("2");
    const above = (title: string) => {
      const row = page.getByText(title).first().element().closest("li[data-thread-item]")!;
      return Boolean(
        row.compareDocumentPosition(header.element()) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    };
    for (const title of ["Refactor the billing worker", "Add retries to the importer"]) {
      await expect.element(page.getByText(title).first()).toBeVisible();
      expect(above(title), title).toBe(true);
    }
    for (const title of ["Refactor the billing worker", "Add retries to the importer"]) {
      const row = page.getByText(title).first().element().closest("li[data-thread-item]")!;
      expect(row.textContent).toContain("Stopped");
    }
    await page.screenshot({ path: "__screenshots__/sandbox-stopped-active.png" });

    await userEvent.click(page.getByTestId("sidebar-working-shelf-toggle"));
    for (const title of ["Port the search index", "Runs on a paired Mac"]) {
      await expect.element(page.getByText(title).first()).toBeVisible();
      expect(above(title), title).toBe(false);
    }
  });

  it("offers deleting a sandbox deleted outside T3 Code from its thread's menu, and says why the rest is off", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    stack.defer(() => dismissContextMenu(false));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    mocks.sandboxes = [
      sandbox({ environmentId: LEGACY_SANDBOX, threadId: legacyThreadId, state: "deleted" }),
    ];
    // The coordinator's own tests cover its dialog; here it only answers for this thread.
    const deleteSandbox = vi.fn(async () => {});
    stack.defer(
      registerSandboxThreadHandlers({
        isSandboxThread: (ref) => ref.environmentId === LEGACY_SANDBOX,
        sandboxState: (ref) => (ref.environmentId === LEGACY_SANDBOX ? "deleted" : undefined),
        onSettled: () => false,
        ensureRunning: async () => true,
        deleteThreadAndSandbox: async () => {},
        deleteSandbox,
      }),
    );
    vi.mocked(usePrimaryEnvironmentId).mockReturnValue(HOST);
    vi.mocked(useProjects).mockReturnValue([
      project(LEGACY_SANDBOX, "project-legacy", "OmarAlex24/kontext"),
    ]);
    // The sandbox's server is gone, so this client holds no session that can change its threads.
    vi.mocked(useQuietThreadShells).mockReturnValue([
      shell(LEGACY_SANDBOX, legacyThreadId, "project-legacy", "que modelo eres"),
    ]);

    await using _screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    const title = page.getByText("que modelo eres").first();
    await expect.element(title).toBeVisible();
    title
      .element()
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    const reason = page.getByRole("menuitem", { name: "The sandbox no longer exists" });
    await expect.element(reason).toBeVisible();
    await expect.element(reason).toBeDisabled();
    await expect.element(page.getByRole("menuitem", { name: "Rename thread" })).toBeDisabled();
    await expect
      .element(page.getByRole("menuitem", { name: "Delete", exact: true }))
      .toBeDisabled();
    const deleteItem = page.getByRole("menuitem", { name: "Delete sandbox…" });
    await expect.element(deleteItem).toBeEnabled();
    await userEvent.click(deleteItem);
    await vi.waitFor(() =>
      expect(deleteSandbox).toHaveBeenCalledExactlyOnceWith({
        environmentId: LEGACY_SANDBOX,
        threadId: legacyThreadId,
      }),
    );
  });
});
