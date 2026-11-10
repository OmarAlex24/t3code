import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";
import type { SandboxFollowers } from "../../state/sandboxes";

export interface SettingsScopeSearch {
  project?: string | undefined;
  machine?: string | undefined;
  checkout?: string | undefined;
}

/** A hidden sandbox written to with the host: environment-wide, or its clone of a host project. */
export interface ScopeFollowerTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}

type ScopeTargets = {
  label: string;
  members: readonly SidebarProjectGroupMember[];
  environmentIds: readonly EnvironmentId[];
  followers: readonly ScopeFollowerTarget[];
};

type ScopeSandboxes = Pick<SandboxFollowers, "hostEnvironmentId" | "followers">;

const NO_SANDBOXES: ScopeSandboxes = { hostEnvironmentId: null, followers: [] };

function scopeFollowers(
  sandboxes: ScopeSandboxes,
  environmentIds: readonly EnvironmentId[],
  members: readonly SidebarProjectGroupMember[] | null,
): ScopeFollowerTarget[] {
  const host = sandboxes.hostEnvironmentId;
  if (host === null) return [];
  if (members === null) {
    return environmentIds.includes(host)
      ? sandboxes.followers.map(({ environmentId }) => ({ environmentId, projectId: null }))
      : [];
  }
  const hostProjects = new Set(
    members.filter((member) => member.environmentId === host).map((member) => member.id),
  );
  return sandboxes.followers.flatMap(({ environmentId, hostProjectId, projectId }) =>
    projectId !== null && hostProjectId !== null && hostProjects.has(hostProjectId)
      ? [{ environmentId, projectId }]
      : [],
  );
}

export type ResolvedSettingsScope = ScopeTargets &
  (
    | { kind: "all" }
    | { kind: "environment"; environmentId: EnvironmentId }
    | {
        kind: "project";
        group: SidebarProjectSnapshot;
        environmentId: EnvironmentId | null;
      }
    | {
        kind: "checkout";
        group: SidebarProjectSnapshot;
        checkout: SidebarProjectGroupMember;
        environmentId: EnvironmentId;
      }
    | {
        kind: "unavailable";
        reason: "project-required" | "project-missing" | "environment-missing" | "checkout-missing";
        message: string;
      }
  );

/** Stale IDs remain visible to the resolver so a removed target reads as unavailable, not as "all". */
export function validateSettingsScopeSearch(raw: Record<string, unknown>): SettingsScopeSearch {
  const stringValue = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  const project = stringValue(raw.project);
  const machine = stringValue(raw.machine);
  const checkout = stringValue(raw.checkout);
  return {
    ...(project === undefined ? {} : { project }),
    ...(machine === undefined ? {} : { machine }),
    ...(checkout === undefined ? {} : { checkout }),
  };
}

/**
 * An unavailable selection never broadens a subsequent write. `groups` and `environments` leave
 * sandboxes out; `sandboxes` makes them followers of the host instead.
 */
export function resolveSettingsScope(
  search: SettingsScopeSearch,
  groups: readonly SidebarProjectSnapshot[],
  environments: readonly Pick<EnvironmentPresentation, "environmentId" | "label">[],
  sandboxes: ScopeSandboxes = NO_SANDBOXES,
): ResolvedSettingsScope {
  const unavailable = (
    reason: Extract<ResolvedSettingsScope, { kind: "unavailable" }>["reason"],
    message: string,
  ): ResolvedSettingsScope => ({
    kind: "unavailable",
    reason,
    label: "Unavailable selection",
    message,
    members: [],
    environmentIds: [],
    followers: [],
  });

  if (search.checkout && !search.project) {
    return unavailable("project-required", "Select a project to choose one of its checkouts.");
  }

  const environment = environments.find((candidate) => candidate.environmentId === search.machine);
  if (search.machine && !environment) {
    return unavailable("environment-missing", "This environment is no longer available.");
  }

  if (search.project) {
    const group = groups.find((candidate) => candidate.projectKey === search.project);
    if (!group) return unavailable("project-missing", "This project is no longer available.");
    const members = group.memberProjects.filter(
      (member) =>
        (search.machine === undefined || member.environmentId === search.machine) &&
        (search.checkout === undefined || member.physicalProjectKey === search.checkout),
    );
    if (members.length === 0) {
      return unavailable(
        "checkout-missing",
        search.checkout
          ? "This checkout is no longer available in the selected project and environment."
          : "This project has no checkout on this environment.",
      );
    }
    if (search.checkout) {
      const checkout = members[0]!;
      const checkoutEnvironment = environments.find(
        (candidate) => candidate.environmentId === checkout.environmentId,
      );
      if (!checkoutEnvironment) {
        return unavailable(
          "environment-missing",
          "This checkout's environment is no longer available.",
        );
      }
      const sharesEnvironment = group.memberProjects.some(
        (member) =>
          member.environmentId === checkout.environmentId &&
          member.physicalProjectKey !== checkout.physicalProjectKey,
      );
      return {
        kind: "checkout",
        group,
        checkout,
        environmentId: checkout.environmentId,
        label: `${group.displayName} / ${checkoutEnvironment.label}${sharesEnvironment ? ` · ${checkout.workspaceRoot}` : ""}`,
        members,
        environmentIds: [checkout.environmentId],
        followers: scopeFollowers(sandboxes, [checkout.environmentId], members),
      };
    }
    const environmentIds = [...new Set(members.map((member) => member.environmentId))];
    return {
      kind: "project",
      group,
      environmentId: environment?.environmentId ?? null,
      label: `${group.displayName} / ${environment?.label ?? "All checkouts"}`,
      members,
      environmentIds,
      followers: scopeFollowers(sandboxes, environmentIds, members),
    };
  }
  if (environment) {
    return {
      kind: "environment",
      environmentId: environment.environmentId,
      label: environment.label,
      members: [],
      environmentIds: [environment.environmentId],
      followers: scopeFollowers(sandboxes, [environment.environmentId], null),
    };
  }
  const environmentIds = environments.map((candidate) => candidate.environmentId);
  return {
    kind: "all",
    label: "All environments",
    members: [],
    environmentIds,
    followers: scopeFollowers(sandboxes, environmentIds, null),
  };
}

/**
 * A link may still name a sandbox (`machine`, or a project or checkout that only a sandbox has):
 * it opens its host and the host's project instead of an unavailable selection.
 */
export function normalizeSandboxScopeSearch(
  search: SettingsScopeSearch,
  groups: readonly SidebarProjectSnapshot[],
  groupsWithSandboxes: () => readonly SidebarProjectSnapshot[],
  sandboxes: ScopeSandboxes,
): SettingsScopeSearch {
  const host = sandboxes.hostEnvironmentId;
  if (host === null || sandboxes.followers.length === 0) return search;
  const isSandbox = (environmentId: string | undefined) =>
    sandboxes.followers.some((follower) => follower.environmentId === environmentId);
  const machine = isSandbox(search.machine) ? host : search.machine;
  const visible = (key: string | undefined) =>
    groups.find((candidate) => candidate.projectKey === key);
  const hidden =
    search.project === undefined
      ? undefined
      : groupsWithSandboxes().find((candidate) => candidate.projectKey === search.project);
  const sandboxMember =
    search.checkout === undefined
      ? undefined
      : hidden?.memberProjects.find(
          (member) =>
            member.physicalProjectKey === search.checkout && isSandbox(member.environmentId),
        );
  const needsHostProject = visible(search.project) === undefined || sandboxMember !== undefined;
  if (!needsHostProject) {
    return machine === search.machine ? search : { ...search, machine };
  }
  const hostProjectIds = new Set(
    (sandboxMember ? [sandboxMember] : (hidden?.memberProjects ?? [])).flatMap((member) =>
      sandboxes.followers.flatMap((follower) =>
        follower.environmentId === member.environmentId &&
        follower.projectId === member.id &&
        follower.hostProjectId !== null
          ? [follower.hostProjectId]
          : [],
      ),
    ),
  );
  const hostGroup = groups.find((candidate) =>
    candidate.memberProjects.some(
      (member) => member.environmentId === host && hostProjectIds.has(member.id),
    ),
  );
  if (hostGroup === undefined) return { ...search, ...(machine ? { machine } : {}) };
  return sandboxMember || isSandbox(search.machine)
    ? { project: hostGroup.projectKey, machine: host }
    : { project: hostGroup.projectKey, ...(machine ? { machine } : {}) };
}
