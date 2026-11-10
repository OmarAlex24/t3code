import type { EnvironmentId } from "@t3tools/contracts";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useSandboxEnvironmentIds } from "../../state/sandboxes";
import { resolveAccessEnvironmentId } from "./ConnectionsSettings.logic";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

/**
 * The environments Sharing & access manages, the one `requested` resolves to, and its name.
 * The MCP wizard uses the same, so both name an environment alike. A requested environment
 * always counts, so a thread on a second WSL backend opens on that backend.
 */
export function useAccessEnvironment(requested: EnvironmentId | null) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const sandboxEnvironmentIds = useSandboxEnvironmentIds();
  // A thread's sandbox is listed only when a link asks for it.
  const candidates = environments.filter(
    (environment) =>
      environment.environmentId === primaryEnvironmentId ||
      environment.environmentId === requested ||
      (environment.entry.enabled &&
        !isDesktopLocalConnectionTarget(environment.entry.target) &&
        !sandboxEnvironmentIds.has(environment.environmentId)),
  );
  const environmentId = resolveAccessEnvironmentId({
    primaryEnvironmentId,
    environments: candidates.map((environment) => ({
      environmentId: environment.environmentId,
      connected: environment.connection.phase === "connected",
    })),
    selected: requested,
  });
  const environment =
    candidates.find((candidate) => candidate.environmentId === environmentId) ?? null;
  return {
    candidates,
    environment,
    label: environment ? settingsScopeEnvironmentLabel(environment, candidates) : null,
  };
}
