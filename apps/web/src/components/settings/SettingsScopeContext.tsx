import { type EnvironmentId, T3_PROJECT_FILE_NAME, type T3ProjectFile } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, type ReactNode, useContext } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useSandboxFollowers } from "../../state/sandboxes";
import { getProjectFileQueryAtom, optimisticFileAtom } from "../files/projectFilesQueryState";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { resolveScopedSettingsTargets, selectScopedSettingsEnvironments } from "./scopedSettings";
import {
  normalizeSandboxScopeSearch,
  resolveSettingsScope,
  type SettingsScopeSearch,
} from "./settingsScope";
import { selectSingleEnvironmentScope } from "./settingsScopeAxis";

type ProjectFileMember = readonly [
  environmentId: EnvironmentId,
  workspaceRoot: string,
  physicalProjectKey: string,
];

const memberProjectFilesAtom = Atom.family((membersKey: string) => {
  const members = JSON.parse(membersKey) as ReadonlyArray<ProjectFileMember>;
  return Atom.make((get) => {
    const files = new Map<string, T3ProjectFile | null>();
    for (const [environmentId, workspaceRoot, physicalProjectKey] of members) {
      const result = get(
        getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
      );
      if (result.waiting) continue;
      const data =
        get(optimisticFileAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME))?.data ??
        AsyncResult.getOrElse(result, () => null);
      files.set(
        physicalProjectKey,
        data === null || data.exists === false || data.truncated
          ? null
          : parseT3ProjectFile(data.contents),
      );
    }
    return files;
  }).pipe(Atom.withLabel(`web-settings-member-project-files:${membersKey}`));
});

function useMemberProjectFiles(scope: ReturnType<typeof resolveSettingsScope>) {
  const members = scope.kind === "project" || scope.kind === "checkout" ? scope.members : [];
  return useAtomValue(
    memberProjectFilesAtom(
      JSON.stringify(
        members.map((member): ProjectFileMember => [
          member.environmentId,
          member.workspaceRoot,
          member.physicalProjectKey,
        ]),
      ),
    ),
  );
}

/**
 * A thread's sandbox is never a choice here: it is left out of every environment and project list
 * and written to with its host (`scope.followers`).
 */
function useResolvedSettingsScope(rawSearch: SettingsScopeSearch, singleEnvironment: boolean) {
  const sandboxes = useSandboxFollowers();
  const { groups, withHidden } = useSettingsProjectGroups(sandboxes.environmentIds);
  const { environments } = useEnvironments();
  const availableEnvironments = environments.filter(
    (environment) => !sandboxes.environmentIds.has(environment.environmentId),
  );
  // A stopped sandbox keeps what it had; a write to it would only wait for a reconnect.
  const followerEnvironments = environments.filter(
    (environment) =>
      sandboxes.environmentIds.has(environment.environmentId) &&
      environment.connection.phase === "connected",
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const normalized = normalizeSandboxScopeSearch(rawSearch, groups, withHidden, sandboxes);
  const search = singleEnvironment
    ? selectSingleEnvironmentScope(
        normalized,
        resolveSettingsScope(normalized, groups, availableEnvironments),
        availableEnvironments,
        primaryEnvironmentId,
      )
    : normalized;
  const scope = resolveSettingsScope(search, groups, availableEnvironments, sandboxes);
  const projectFiles = useMemberProjectFiles(scope);
  const selected = selectScopedSettingsEnvironments(
    scope,
    availableEnvironments,
    primaryEnvironmentId,
  );
  const targets = resolveScopedSettingsTargets(scope, selected.connectedEnvironments, projectFiles);
  const target =
    targets.find((candidate) => candidate.environmentId === selected.environment?.environmentId) ??
    targets[0] ??
    null;
  return {
    scope,
    groups,
    search,
    ...selected,
    targets,
    target,
    availableEnvironments,
    followerEnvironments,
    hostEnvironmentId: sandboxes.hostEnvironmentId,
    sandboxFollowers: sandboxes.followers,
    sandboxesKnown: sandboxes.known,
  };
}

const SettingsScopeContext = createContext<
  | (ReturnType<typeof useResolvedSettingsScope> & {
      singleEnvironment: boolean;
      search: SettingsScopeSearch;
      selectScope: (next: SettingsScopeSearch) => void;
    })
  | null
>(null);

export function SettingsScopeProvider({
  search,
  onChange,
  children,
  singleEnvironment = false,
}: {
  singleEnvironment?: boolean;
  search: SettingsScopeSearch;
  onChange: (next: SettingsScopeSearch) => void;
  children: ReactNode;
}) {
  const resolved = useResolvedSettingsScope(search, singleEnvironment);
  const value = { ...resolved, singleEnvironment, selectScope: onChange };
  return <SettingsScopeContext value={value}>{children}</SettingsScopeContext>;
}

export function useOptionalSettingsScope() {
  return useContext(SettingsScopeContext);
}

export function useSettingsScope() {
  const scope = useOptionalSettingsScope();
  if (scope === null) throw new Error("Settings scope must be read inside SettingsScopeProvider.");
  return scope;
}
