import { orderItemsByPreferredIds, sortSidebarV2ProjectGroups } from "../components/Sidebar.logic";
import {
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  buildSidebarProjectSnapshots,
  isSandboxPlaceholderProject,
} from "../sidebarProjectGrouping";
import { useSandboxChatAliases } from "../state/sandboxes";
import { withSandboxHostMirrors } from "../state/sandboxThreads";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../state/environments";
import { useDelegatedUnderParent, useProjects, useQuietThreadShells } from "../state/entities";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

const projectKeyOf = (project: { readonly environmentId: string; readonly id: string }) =>
  `${project.environmentId}:${project.id}`;

export function useSidebarProjectGroups() {
  const projects = useProjects();
  // Activity order lags a running thread's streaming ticks until its next
  // real change; reading every tick re-rendered the whole sidebar with it.
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const sortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const environments = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const orderedProjects = orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  // A sandbox chat lists one of its two threads; a placeholder still holding another thread, such
  // as the mirror standing for a stopped sandbox, stays so that thread keeps a row.
  const unlisted = withSandboxHostMirrors(delegatedUnderParent, useSandboxChatAliases());
  const placeholders = new Set(
    projects.filter(isSandboxPlaceholderProject).map((project) => projectKeyOf(project)),
  );
  const placeholdersWithThreads = new Set(
    placeholders.size === 0
      ? []
      : threads.flatMap((thread) => {
          const key = `${thread.environmentId}:${thread.projectId}`;
          return placeholders.has(key) &&
            thread.archivedAt === null &&
            !unlisted.has(threadKey({ environmentId: thread.environmentId, threadId: thread.id }))
            ? [key]
            : [];
        }),
  );
  const unsortedGroups = buildSidebarProjectSnapshots({
    projects: sortOrder === "manual" ? orderedProjects : projects,
    groupScratchProjects: true,
    settings: groupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => labels.get(environmentId) ?? null,
    keepSandboxPlaceholder: (project) => placeholdersWithThreads.has(projectKeyOf(project)),
  });
  return sortSidebarV2ProjectGroups(unsortedGroups, threads, sortOrder, delegatedUnderParent);
}
