import { type EnvironmentId, type ServerSettings, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** The settings the server reads its sandbox host facts from, as one comparable value. */
const sandboxHostSettingsKey = (
  settings: Pick<
    ServerSettings,
    "sandboxProviders" | "sandboxTailscale" | "sandboxTooling" | "usageLimitSources"
  > | null,
): string =>
  settings === null
    ? ""
    : JSON.stringify([
        settings.sandboxProviders,
        settings.sandboxTailscale,
        settings.sandboxTooling,
        settings.usageLimitSources,
      ]);

export function createSandboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
  settingsValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerSettings | null>,
) {
  // Saving a token, the GitHub App or Tailscale changes what the host offers sandboxes. The
  // settings push lands after the write, so a refetch then reads the new facts, whichever client
  // made the change.
  const sandboxHostSettingsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => sandboxHostSettingsKey(get(settingsValueAtom(environmentId)))).pipe(
      Atom.withLabel(`environment-data:sandboxes:host-settings:${environmentId}`),
    ),
  );
  const sandboxesProviders = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:sandboxes:providers",
    tag: WS_METHODS.sandboxesProviders,
    idleTtlMs: 0,
    refreshTrigger: ({ environmentId }) => sandboxHostSettingsAtom(environmentId),
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
  const sandboxesConfigsRevisionAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-data:sandboxes:configs-revision:${environmentId}`),
    ),
  );
  const sandboxesConfigs = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:sandboxes:configs",
    tag: WS_METHODS.sandboxesConfigs,
    idleTtlMs: 0,
    refreshTrigger: ({ environmentId }) => sandboxesConfigsRevisionAtom(environmentId),
  });
  const sandboxesListRevisionAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-data:sandboxes:list-revision:${environmentId}`),
    ),
  );
  // Records the server changes on its own (a resume the bridge starts, a stop the sweep sees).
  const sandboxesListChanges = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:sandboxes:list-changes",
    tag: WS_METHODS.sandboxesSubscribeListChanges,
  });
  const sandboxesListTriggerAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => [
      get(sandboxesListRevisionAtom(environmentId)),
      get(sandboxesListChanges({ environmentId, input: {} })),
    ]).pipe(Atom.withLabel(`environment-data:sandboxes:list-trigger:${environmentId}`)),
  );
  const sandboxesList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:sandboxes:list",
    tag: WS_METHODS.sandboxesList,
    idleTtlMs: 0,
    // Backs up the pushed changes, which a dropped connection can miss.
    refreshIntervalMs: 60_000,
    refreshTrigger: ({ environmentId }) => sandboxesListTriggerAtom(environmentId),
  });

  return {
    sandboxesProviders,
    sandboxesEnvironments,
    sandboxesLimits,
    sandboxesTemplates,
    sandboxesList,
    sandboxesConfigs,
    sandboxesSaveConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:save-config",
      tag: WS_METHODS.sandboxesSaveConfig,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() =>
          registry.update(sandboxesConfigsRevisionAtom(environmentId), (revision) => revision + 1),
        ),
    }),
    sandboxesDeleteConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:delete-config",
      tag: WS_METHODS.sandboxesDeleteConfig,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() =>
          registry.update(sandboxesConfigsRevisionAtom(environmentId), (revision) => revision + 1),
        ),
    }),
    /** One thread's launch on the host, as the snapshots its card shows. */
    sandboxesLaunchState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:sandboxes:launch-state",
      tag: WS_METHODS.sandboxesSubscribeLaunch,
      idleTtlMs: 0,
    }),
    sandboxesLaunch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:launch",
      tag: WS_METHODS.sandboxesLaunch,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() =>
          registry.update(sandboxesListRevisionAtom(environmentId), (revision) => revision + 1),
        ),
    }),
    sandboxesCancelLaunch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:cancel-launch",
      tag: WS_METHODS.sandboxesCancelLaunch,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() =>
          registry.update(sandboxesListRevisionAtom(environmentId), (revision) => revision + 1),
        ),
    }),
    sandboxesRetryLaunch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:retry-launch",
      tag: WS_METHODS.sandboxesRetryLaunch,
    }),
    sandboxesPairLaunch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:pair-launch",
      tag: WS_METHODS.sandboxesPairLaunch,
    }),
    sandboxesConnectGithubApp: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:connect-github-app",
      tag: WS_METHODS.sandboxesConnectGithubApp,
    }),
    sandboxesConnectRailway: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:connect-railway",
      tag: WS_METHODS.sandboxesConnectRailway,
    }),
    sandboxesCheckTailscale: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:check-tailscale",
      tag: WS_METHODS.sandboxesCheckTailscale,
    }),
    sandboxesStop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:stop",
      tag: WS_METHODS.sandboxesStop,
    }),
    sandboxesResume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:resume",
      tag: WS_METHODS.sandboxesResume,
    }),
    sandboxesCheckWork: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:check-work",
      tag: WS_METHODS.sandboxesCheckWork,
    }),
    sandboxesLinkHostThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:link-host-thread",
      tag: WS_METHODS.sandboxesLinkHostThread,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() =>
          registry.update(sandboxesListRevisionAtom(environmentId), (revision) => revision + 1),
        ),
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
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() =>
          registry.update(sandboxesListRevisionAtom(environmentId), (revision) => revision + 1),
        ),
    }),
  };
}
