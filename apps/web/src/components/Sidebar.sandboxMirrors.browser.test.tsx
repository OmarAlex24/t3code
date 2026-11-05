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
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

const HOST = EnvironmentId.make("host");
const SANDBOX = EnvironmentId.make("sandbox-bridged");
const LEGACY_SANDBOX = EnvironmentId.make("sandbox-legacy");
const bridgedThreadId = ThreadId.make("thread-bridged");
const legacyThreadId = ThreadId.make("thread-legacy");

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
      project(HOST, "project-host", "horizon-stack"),
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
});
