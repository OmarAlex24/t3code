import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { usePrimaryEnvironmentId } from "./environments";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

/**
 * Hosted web has no primary. The catalog keeps save order, so the first enabled saved environment
 * is the server the user paired before it made any sandbox.
 */
export function useSandboxProvisionerEnvironmentId(): EnvironmentId | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { entries } = useAtomValue(environmentCatalog.catalogValueAtom);
  if (primaryEnvironmentId !== null) return primaryEnvironmentId;
  for (const [environmentId, entry] of entries) {
    if (entry.target._tag !== "PrimaryConnectionTarget" && entry.enabled) return environmentId;
  }
  return null;
}

/**
 * Environments that are a thread's own sandbox. They belong to the Sandboxes section, under their
 * config, instead of the list of machines the user paired.
 */
export function useSandboxThreadEnvironmentIds(): ReadonlySet<EnvironmentId> {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const list = useEnvironmentQuery(
    provisionerEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesList({
          environmentId: provisionerEnvironmentId,
          input: undefined,
        }),
  );
  return new Set(
    (list.data?.sandboxes ?? []).flatMap((sandbox) =>
      sandbox.threadId === undefined || sandbox.environmentId === null
        ? []
        : [sandbox.environmentId],
    ),
  );
}
