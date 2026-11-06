import {
  isSandboxHostProjectRoot,
  type EnvironmentId,
  type ScopedProjectRef,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import {
  buildProjectGroups,
  deriveProjectGroupLabel,
  derivePhysicalProjectKey,
  resolveScratchProjectScopeKey,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { Project } from "./types";

export const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};

export function withProjectGroupingOverride(
  overrides: Readonly<Record<string, SidebarProjectGroupingMode>> | undefined,
  overrideKey: string,
  selection: SidebarProjectGroupingMode | "inherit",
): Record<string, SidebarProjectGroupingMode> {
  const next = { ...overrides };
  if (selection === "inherit") delete next[overrideKey];
  else next[overrideKey] = selection;
  return next;
}

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  allRemoteMembersAreDesktopLocal: boolean;
  allRemoteMembersAreWsl: boolean;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
  pinned: boolean;
  archived: boolean;
}

export function projectGroupsSpanEnvironments(
  groups: ReadonlyArray<Pick<SidebarProjectSnapshot, "memberProjects">>,
): boolean {
  const environmentIds = new Set<EnvironmentId>();
  for (const group of groups) {
    for (const member of group.memberProjects) {
      environmentIds.add(member.environmentId);
      if (environmentIds.size > 1) return true;
    }
  }
  return false;
}

export interface SidebarProjectPickerEntry {
  group: SidebarProjectSnapshot;
  targetProject: SidebarProjectGroupMember;
  isPreferred: boolean;
}

export function getSidebarProjectSettingsKey(
  group: SidebarProjectSnapshot,
  settings: ProjectGroupingSettings,
  projects: ReadonlyArray<Project>,
  projectRef?: ScopedProjectRef,
): string {
  if (!group.isScratch) return group.projectKey;
  const project =
    group.memberProjects.find(
      (member) =>
        member.environmentId === projectRef?.environmentId && member.id === projectRef.projectId,
    ) ??
    group.memberProjects.find((member) => member.environmentId === projectRef?.environmentId) ??
    group;
  return (
    buildPhysicalToLogicalProjectKeyMap({ projects, settings, primaryEnvironmentId: null }).get(
      derivePhysicalProjectKey(project),
    ) ?? group.projectKey
  );
}

export function resolveSidebarProjectScopeKey(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly key: string | null;
  readonly settings?: ProjectGroupingSettings;
  readonly canClearMissingScope?: boolean;
}): string | null {
  if (input.key === null) return null;
  const group =
    input.groups.find((candidate) => candidate.projectKey === input.key) ??
    input.groups.find(
      (candidate) =>
        candidate.isScratch &&
        resolveScratchProjectScopeKey(input.key, candidate.memberProjects, input.settings) ===
          candidate.projectKey,
    );
  return group?.projectKey ?? (input.canClearMissingScope ? null : input.key);
}

export function resolveSidebarProjectScopeKeys(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly keys: ReadonlyArray<string>;
  readonly settings?: ProjectGroupingSettings;
  readonly canClearMissingScope?: boolean;
}): string[] {
  return [
    ...new Set(input.keys.flatMap((key) => resolveSidebarProjectScopeKey({ ...input, key }) ?? [])),
  ];
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): Map<string, string> {
  const mapping = new Map<string, string>();
  const groups = buildProjectGroups({
    projects: input.projects,
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  });
  for (const group of groups) {
    for (const member of group.members) {
      mapping.set(member.physicalProjectKey, group.key);
    }
  }
  return mapping;
}

/**
 * An empty folder the server made only so the phone has a home for a sandbox thread's host copy.
 * This client shows the sandbox's own thread instead, so it offers no such project.
 */
export const isSandboxPlaceholderProject = (project: Pick<Project, "workspaceRoot">): boolean =>
  isSandboxHostProjectRoot(project.workspaceRoot);

export function buildSidebarProjectSnapshots(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  groupScratchProjects?: boolean;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
  isWslEnvironment?: (environmentId: EnvironmentId) => boolean;
  /** Sandbox placeholder projects to list anyway, such as one still holding a visible thread. */
  keepSandboxPlaceholder?: (project: Project) => boolean;
}): SidebarProjectSnapshot[] {
  const keepPlaceholder = input.keepSandboxPlaceholder ?? (() => false);
  return buildProjectGroups({
    projects: input.projects.filter(
      (project) => !isSandboxPlaceholderProject(project) || keepPlaceholder(project),
    ),
    groupScratchProjects: input.groupScratchProjects ?? false,
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  }).map((group): SidebarProjectSnapshot => {
    const members = group.members.map(
      ({ physicalProjectKey, project }): SidebarProjectGroupMember => ({
        ...project,
        physicalProjectKey,
        environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
      }),
    );
    const grouped =
      members.find(
        (member) =>
          member.environmentId === group.representative.environmentId &&
          member.id === group.representative.id,
      ) ?? members[0]!;
    // A placeholder never stands for a real checkout it is grouped with.
    const representative = isSandboxPlaceholderProject(grouped)
      ? (members.find(
          (member) =>
            member.environmentId === grouped.environmentId && !isSandboxPlaceholderProject(member),
        ) ??
        members.find((member) => !isSandboxPlaceholderProject(member)) ??
        grouped)
      : grouped;

    const hasLocal =
      input.primaryEnvironmentId !== null &&
      members.some((member) => member.environmentId === input.primaryEnvironmentId);
    const hasRemote =
      input.primaryEnvironmentId !== null
        ? members.some((member) => member.environmentId !== input.primaryEnvironmentId)
        : false;
    const remoteMembers = members.filter(
      (member) =>
        input.primaryEnvironmentId !== null && member.environmentId !== input.primaryEnvironmentId,
    );
    const remoteEnvironmentLabels = remoteMembers
      .flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : []))
      .filter((label, index, labels) => labels.indexOf(label) === index);
    const isDesktopLocal = input.isDesktopLocalEnvironment ?? (() => false);
    const isWsl = input.isWslEnvironment ?? (() => false);
    const allRemoteMembersAreDesktopLocal =
      remoteMembers.length > 0 &&
      remoteMembers.every((member) => isDesktopLocal(member.environmentId));
    const allRemoteMembersAreWsl =
      remoteMembers.length > 0 && remoteMembers.every((member) => isWsl(member.environmentId));

    return {
      ...representative,
      projectKey: group.key,
      displayName:
        representative === grouped
          ? group.label
          : deriveProjectGroupLabel({ representative, members }),
      groupedProjectCount: members.length,
      environmentPresence:
        hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
      allRemoteMembersAreDesktopLocal,
      allRemoteMembersAreWsl,
      memberProjects: members,
      memberProjectRefs: group.memberProjectRefs,
      remoteEnvironmentLabels,
      pinned: group.pinned,
      archived: group.archived,
    };
  });
}

export function buildSidebarProjectPickerEntries(input: {
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  preferredProjectRef: ScopedProjectRef | null;
}) {
  const preferredProjectRef = input.preferredProjectRef;
  const entries = input.groups.flatMap((group): SidebarProjectPickerEntry[] => {
    const isPreferred = preferredProjectRef
      ? group.memberProjectRefs.some(
          (projectRef) =>
            projectRef.environmentId === preferredProjectRef.environmentId &&
            projectRef.projectId === preferredProjectRef.projectId,
        )
      : false;
    const preferredProject = preferredProjectRef
      ? (group.memberProjects.find(
          (project) =>
            project.environmentId === preferredProjectRef.environmentId &&
            project.id === preferredProjectRef.projectId,
        ) ??
        group.memberProjects.find(
          (project) => project.environmentId === preferredProjectRef.environmentId,
        ))
      : null;
    const targetProject =
      preferredProject ??
      group.memberProjects.find(
        (project) => project.environmentId === group.environmentId && project.id === group.id,
      ) ??
      group.memberProjects[0];
    if (!targetProject) return [];

    return [{ group, targetProject, isPreferred }];
  });
  // The current project leads, even ahead of pinned projects.
  const preferred = entries.find((entry) => entry.isPreferred);
  if (!preferred) return entries;
  return [preferred, ...entries.filter((entry) => entry !== preferred)];
}
