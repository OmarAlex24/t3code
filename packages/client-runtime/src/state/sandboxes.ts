import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createSandboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const sandboxesProviders = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:sandboxes:providers",
    tag: WS_METHODS.sandboxesProviders,
    idleTtlMs: 0,
  });
  const sandboxesEnvironments = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:sandboxes:environments",
    tag: WS_METHODS.sandboxesEnvironments,
    idleTtlMs: 0,
  });
  const sandboxesLimits = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:sandboxes:limits",
    tag: WS_METHODS.sandboxesLimits,
    idleTtlMs: 0,
  });
  const sandboxesTemplates = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:sandboxes:templates",
    tag: WS_METHODS.sandboxesTemplates,
    idleTtlMs: 0,
  });
  const sandboxesListRevisionAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-data:sandboxes:list-revision:${environmentId}`),
    ),
  );
  const sandboxesList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:sandboxes:list",
    tag: WS_METHODS.sandboxesList,
    idleTtlMs: 0,
    // The server's once-a-minute sweep changes records with no client action.
    refreshIntervalMs: 60_000,
    refreshTrigger: ({ environmentId }) => sandboxesListRevisionAtom(environmentId),
  });

  return {
    sandboxesProviders,
    sandboxesEnvironments,
    sandboxesLimits,
    sandboxesTemplates,
    sandboxesList,
    sandboxesStop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:stop",
      tag: WS_METHODS.sandboxesStop,
    }),
    sandboxesResume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:resume",
      tag: WS_METHODS.sandboxesResume,
    }),
    sandboxesExtend: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:extend",
      tag: WS_METHODS.sandboxesExtend,
    }),
    sandboxesSaveTemplate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:save-template",
      tag: WS_METHODS.sandboxesSaveTemplate,
    }),
    sandboxesDeleteTemplate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:delete-template",
      tag: WS_METHODS.sandboxesDeleteTemplate,
    }),
    sandboxesCreate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:create",
      tag: WS_METHODS.sandboxesCreate,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() =>
          registry.update(sandboxesListRevisionAtom(environmentId), (revision) => revision + 1),
        ),
    }),
    sandboxesDelete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:delete",
      tag: WS_METHODS.sandboxesDelete,
    }),
  };
}
