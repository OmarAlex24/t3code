import type { EnvironmentId } from "@t3tools/contracts";

import { useClientSettings } from "../../hooks/useSettings";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";

const NO_ENVIRONMENTS: ReadonlySet<EnvironmentId> = new Set();

/**
 * Projects grouped as the sidebar groups them, without checkouts on `hiddenEnvironmentIds` (a
 * thread's sandbox). `withHidden` groups them all, for links that still name one.
 */
export function useSettingsProjectGroups(
  hiddenEnvironmentIds: ReadonlySet<EnvironmentId> = NO_ENVIRONMENTS,
) {
  const projects = useProjects();
  // Avoid object selector identities that rebuild groups and every settings row on each write.
  const sidebarProjectGroupingMode = useClientSettings(
    (settings) => settings.sidebarProjectGroupingMode,
  );
  const sidebarProjectGroupingOverrides = useClientSettings(
    (settings) => settings.sidebarProjectGroupingOverrides,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
  const build = (included: typeof projects) =>
    buildSidebarProjectSnapshots({
      projects: included,
      settings: { sidebarProjectGroupingMode, sidebarProjectGroupingOverrides },
      primaryEnvironmentId,
      resolveEnvironmentLabel: (id) => labels.get(id) ?? null,
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const visible =
    hiddenEnvironmentIds.size === 0
      ? projects
      : projects.filter((project) => !hiddenEnvironmentIds.has(project.environmentId));
  return {
    groups: build(visible),
    withHidden: () => build(projects),
  };
}
