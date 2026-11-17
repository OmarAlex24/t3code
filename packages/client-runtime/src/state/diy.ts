import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createDiyEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const diyRevisionAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-data:diy:revision:${environmentId}`),
    ),
  );
  const bump = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => registry.update(diyRevisionAtom(environmentId), (revision) => revision + 1));

  return {
    // The kit's launchd job runs on its own schedule, so the card polls while it is on screen.
    diyStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:diy:status",
      tag: WS_METHODS.diyStatus,
      idleTtlMs: 0,
      refreshIntervalMs: 5_000,
      refreshTrigger: ({ environmentId }) => diyRevisionAtom(environmentId),
    }),
    diyLog: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:diy:log",
      tag: WS_METHODS.diyLog,
      idleTtlMs: 0,
      refreshIntervalMs: 5_000,
      refreshTrigger: ({ environmentId }) => diyRevisionAtom(environmentId),
    }),
    diySetResolver: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:diy:set-resolver",
      tag: WS_METHODS.diySetResolver,
      onSuccess: bump,
    }),
    diyRunNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:diy:run-now",
      tag: WS_METHODS.diyRunNow,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
      onSuccess: bump,
    }),
  };
}
