import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { persistScopedSettingsPatch, planScopedSettingsPatch } from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";

function environment(
  id: string,
  options: {
    connected?: boolean;
    loaded?: boolean;
    settings?: Partial<ServerSettings>;
  } = {},
) {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: {
      phase: options.connected === false ? ("offline" as const) : ("connected" as const),
    },
    serverConfig:
      options.loaded === false
        ? null
        : {
            settings: { ...DEFAULT_SERVER_SETTINGS, ...options.settings },
          },
  };
}

const laptop = environment("Laptop");
const server = environment("Server");
const offline = environment("Offline", { connected: false });
const loading = environment("Loading", { loaded: false });
const environments = [laptop, server, offline, loading];

const projectId = ProjectId.make("project");
const laptopProjectId = ProjectId.make("laptop-project");
const member = {
  id: projectId,
  environmentId: server.environmentId,
  title: "Project",
  workspaceRoot: "/repo",
  physicalProjectKey: `${server.environmentId}:/repo`,
  environmentLabel: server.label,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const laptopMember = {
  ...member,
  id: laptopProjectId,
  environmentId: laptop.environmentId,
  physicalProjectKey: `${laptop.environmentId}:/repo`,
  environmentLabel: laptop.label,
};
const group: SidebarProjectSnapshot = {
  ...member,
  projectKey: "project-group",
  displayName: "Project",
  memberProjects: [member, laptopMember],
  memberProjectRefs: [
    { environmentId: server.environmentId, projectId },
    { environmentId: laptop.environmentId, projectId: laptopProjectId },
  ],
  groupedProjectCount: 2,
  environmentPresence: "remote-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  remoteEnvironmentLabels: [server.label, laptop.label],
  pinned: false,
  archived: false,
};

describe("sandbox followers", () => {
  const sandbox = environment("Sandbox");
  const sandboxProjectId = ProjectId.make("sandbox-clone");
  const sandboxes = {
    hostEnvironmentId: laptop.environmentId,
    followers: [
      {
        environmentId: sandbox.environmentId,
        hostProjectId: laptopProjectId,
        projectId: sandboxProjectId,
      },
    ],
  };
  const patch = { branchNamePrefix: "ada", worktreesDirectory: "/Users/ada/trees" };

  it("repeats the host's followed settings on its sandboxes and reports only the host's", () => {
    const scope = resolveSettingsScope({}, [], environments, sandboxes);
    const plan = planScopedSettingsPatch(scope, environments, patch, {
      followerEnvironments: [sandbox],
    });
    expect(plan.serverWrites.map((write) => write.environmentId)).toEqual([
      laptop.environmentId,
      server.environmentId,
    ]);
    expect(plan.followerWrites).toEqual([
      expect.objectContaining({
        environmentId: sandbox.environmentId,
        patch: { branchNamePrefix: "ada" },
      }),
    ]);
    // A setting that stays on the host, or a scope without the host, reaches no sandbox.
    expect(
      planScopedSettingsPatch(
        scope,
        environments,
        { worktreesDirectory: "/x" },
        { followerEnvironments: [sandbox] },
      ).followerWrites,
    ).toEqual([]);
    expect(
      planScopedSettingsPatch(
        resolveSettingsScope({ machine: server.environmentId }, [], environments, sandboxes),
        environments,
        patch,
        { followerEnvironments: [sandbox] },
      ).followerWrites,
    ).toEqual([]);
  });

  it("repeats a host project's override on the sandbox's clone of it", () => {
    const scope = resolveSettingsScope(
      { project: group.projectKey },
      [group],
      environments,
      sandboxes,
    );
    expect(
      planScopedSettingsPatch(
        scope,
        environments,
        { branchNamePrefix: "ada" },
        { followerEnvironments: [sandbox] },
      ).followerWrites,
    ).toEqual([
      expect.objectContaining({
        environmentId: sandbox.environmentId,
        patch: { projectSettingsOverrides: { [sandboxProjectId]: { branchNamePrefix: "ada" } } },
      }),
    ]);
    // Pi owns a sandbox's default model.
    expect(
      planScopedSettingsPatch(
        scope,
        environments,
        { defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" } },
        { followerEnvironments: [sandbox] },
      ).followerWrites,
    ).toEqual([]);
  });

  it("never waits for or reports a sandbox's write", async () => {
    const scope = resolveSettingsScope({}, [], [laptop], sandboxes);
    const plan = planScopedSettingsPatch(
      scope,
      [laptop],
      { branchNamePrefix: "ada" },
      { followerEnvironments: [sandbox] },
    );
    const writes: EnvironmentId[] = [];
    const result = await persistScopedSettingsPatch(
      plan,
      async ({ environmentId, input }) => {
        writes.push(environmentId);
        // A sandbox that went away answers only when it reconnects, if ever.
        return environmentId === sandbox.environmentId
          ? new Promise<never>(() => {})
          : {
              _tag: "Success" as const,
              value: applyServerSettingsPatch(laptop.serverConfig!.settings, input.patch),
            };
      },
      () => {},
    );
    expect(writes).toContain(sandbox.environmentId);
    expect(result.failedEnvironments).toEqual([]);
    expect(result.savedEnvironments.map((write) => write.environmentId)).toEqual([
      laptop.environmentId,
    ]);
  });
});
