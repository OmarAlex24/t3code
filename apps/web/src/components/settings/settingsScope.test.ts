import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  normalizeSandboxScopeSearch,
  resolveSettingsScope,
  validateSettingsScopeSearch,
} from "./settingsScope";

const laptopId = EnvironmentId.make("laptop");
const serverId = EnvironmentId.make("server");
const environments = [
  { environmentId: laptopId, label: "Laptop" },
  { environmentId: serverId, label: "Server" },
];

function member(id: string, environmentId: EnvironmentId): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "T3 Code",
    workspaceRoot: `/repos/${id}`,
    physicalProjectKey: `${environmentId}:/repos/${id}`,
    environmentLabel:
      environments.find((environment) => environment.environmentId === environmentId)?.label ??
      null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

const first = member("first", laptopId);
const second = member("second", laptopId);
const third = member("third", serverId);
const other = member("other", serverId);

function group(
  projectKey: string,
  members: readonly SidebarProjectGroupMember[],
): SidebarProjectSnapshot {
  return {
    ...members[0]!,
    projectKey,
    displayName: projectKey,
    memberProjects: members,
    memberProjectRefs: members.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    groupedProjectCount: members.length,
    environmentPresence: "mixed",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    remoteEnvironmentLabels: [],
    pinned: false,
    archived: false,
  };
}

const groups = [group("t3code", [first, second, third]), group("other", [other])];

describe("settings scope search", () => {
  it("retains an orphan checkout so it cannot turn into all environments", () => {
    const search = validateSettingsScopeSearch({ checkout: first.physicalProjectKey });
    expect(search).toEqual({ checkout: first.physicalProjectKey });
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "unavailable",
      reason: "project-required",
      members: [],
      environmentIds: [],
    });
  });
});

describe("settings scope resolution", () => {
  it("keeps all physical members in a project aggregate, including several on one environment", () => {
    expect(resolveSettingsScope({ project: "t3code" }, groups, environments)).toMatchObject({
      kind: "project",
      environmentId: null,
      members: [first, second, third],
      environmentIds: [laptopId, serverId],
    });
  });

  it("narrows a checkout target to exactly one member, deriving its environment when omitted", () => {
    expect(
      resolveSettingsScope(
        { project: "t3code", checkout: second.physicalProjectKey },
        groups,
        environments,
      ),
    ).toMatchObject({
      kind: "checkout",
      checkout: second,
      environmentId: laptopId,
      label: "t3code / Laptop · /repos/second",
      members: [second],
      environmentIds: [laptopId],
    });
  });

  it.each([
    { project: "missing" },
    { machine: "removed" },
    { project: "t3code", machine: "removed" },
    { project: "t3code", checkout: "deleted" },
    { project: "other", machine: laptopId },
    { project: "other", checkout: first.physicalProjectKey },
    { project: "t3code", machine: serverId, checkout: first.physicalProjectKey },
  ])("never widens an invalid or stale target: %j", (search) => {
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "unavailable",
      members: [],
      environmentIds: [],
    });
  });

  it("leaves a removed checkout unavailable while sibling checkouts remain", () => {
    const search = {
      project: "t3code",
      machine: laptopId,
      checkout: first.physicalProjectKey,
    };
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "checkout",
      members: [first],
    });
    expect(
      resolveSettingsScope(search, [group("t3code", [second, third])], environments),
    ).toMatchObject({ kind: "unavailable", members: [], environmentIds: [] });
  });

  it("does not select another environment after removing a project's last local checkout", () => {
    const search = { project: "t3code", machine: laptopId };
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "project",
      members: [first, second],
    });
    expect(resolveSettingsScope(search, [group("t3code", [third])], environments)).toMatchObject({
      kind: "unavailable",
      members: [],
      environmentIds: [],
    });
  });

  it("rejects a cached checkout whose environment was removed", () => {
    expect(
      resolveSettingsScope(
        { project: "t3code", checkout: third.physicalProjectKey },
        groups,
        environments.slice(0, 1),
      ),
    ).toMatchObject({
      kind: "unavailable",
      reason: "environment-missing",
      members: [],
      environmentIds: [],
    });
  });
});

describe("sandboxes in the settings scope", () => {
  const sandboxId = EnvironmentId.make("sandbox");
  const clone = member("clone", sandboxId);
  const sandboxes = {
    hostEnvironmentId: laptopId,
    followers: [{ environmentId: sandboxId, hostProjectId: first.id, projectId: clone.id }],
  };
  // Sandbox checkouts are left out of the groups the scope sees, but links may still name them.
  const withSandbox = () => [
    group("t3code", [first, second, third, clone]),
    group("other", [other]),
  ];
  const separate = () => [...groups, group("clone-only", [clone])];
  const normalize = (search: object, hidden = withSandbox) =>
    normalizeSandboxScopeSearch(search, groups, hidden, sandboxes);

  it("opens the host instead of a sandbox, and leaves other remotes alone", () => {
    expect(normalize({ machine: sandboxId })).toEqual({ machine: laptopId });
    expect(normalize({ project: "t3code", machine: serverId })).toEqual({
      project: "t3code",
      machine: serverId,
    });
    expect(normalize({ project: "t3code", checkout: clone.physicalProjectKey })).toEqual({
      project: "t3code",
      machine: laptopId,
    });
    expect(normalize({ project: "clone-only" }, separate)).toEqual({ project: "t3code" });
  });

  it("makes the host's sandboxes followers of every scope that writes to the host", () => {
    const resolve = (search: object) =>
      resolveSettingsScope(search, groups, environments, sandboxes).followers;
    expect(resolve({})).toEqual([{ environmentId: sandboxId, projectId: null }]);
    expect(resolve({ machine: laptopId })).toEqual([{ environmentId: sandboxId, projectId: null }]);
    expect(resolve({ machine: serverId })).toEqual([]);
    expect(resolve({ project: "t3code" })).toEqual([
      { environmentId: sandboxId, projectId: clone.id },
    ]);
    expect(resolve({ project: "t3code", checkout: second.physicalProjectKey })).toEqual([]);
  });
});
