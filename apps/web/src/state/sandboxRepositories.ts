import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type EnvironmentId, githubRepositoryOf } from "@t3tools/contracts";

/**
 * The GitHub repository a sandbox would clone for this project, or null when it cannot start on
 * one. The machine the project lives on does not matter: the sandbox clones from GitHub.
 */
export const sandboxRepositoryOf = (project: EnvironmentProject) =>
  project.isScratch === true
    ? null
    : githubRepositoryOf(project.repositoryIdentity?.locator.remoteUrl ?? "");

/** The same repository opened on the host, whose git-ignored env files a sandbox can copy. */
export const hostCopyOf = (
  projects: ReadonlyArray<EnvironmentProject>,
  hostEnvironmentId: EnvironmentId,
  repositoryKey: string,
): EnvironmentProject | null =>
  projects.find(
    (project) =>
      project.environmentId === hostEnvironmentId &&
      sandboxRepositoryOf(project)?.key === repositoryKey,
  ) ?? null;

export interface SandboxRepositoryChoice {
  readonly key: string;
  readonly label: string;
  readonly hostProject: EnvironmentProject | null;
}

/** Every GitHub repository open on a connected machine, once each, sorted by name. */
export const sandboxRepositoryChoices = (
  projects: ReadonlyArray<EnvironmentProject>,
  hostEnvironmentId: EnvironmentId,
): ReadonlyArray<SandboxRepositoryChoice> => {
  const byKey = new Map<string, SandboxRepositoryChoice>();
  for (const project of projects) {
    const repository = sandboxRepositoryOf(project);
    if (repository === null) continue;
    const onHost = project.environmentId === hostEnvironmentId;
    const known = byKey.get(repository.key);
    if (known === undefined) {
      byKey.set(repository.key, {
        key: repository.key,
        label: repository.label,
        hostProject: onHost ? project : null,
      });
    } else if (onHost && known.hostProject === null) {
      byKey.set(repository.key, { ...known, hostProject: project });
    }
  }
  return [...byKey.values()].toSorted((a, b) => a.key.localeCompare(b.key));
};

/**
 * A config saved with host project ids, as repositories: each id the host still knows becomes
 * its repository, and env files keyed by those ids move to the repository key.
 */
export const repositoriesFromLegacyConfig = (
  config: {
    readonly projectIds: ReadonlyArray<string>;
    readonly envFiles: Readonly<Record<string, ReadonlyArray<string>>>;
  },
  projects: ReadonlyArray<EnvironmentProject>,
  hostEnvironmentId: EnvironmentId,
) => {
  const keyOfHostProject = (projectId: string) => {
    const project = projects.find(
      (candidate) => candidate.environmentId === hostEnvironmentId && candidate.id === projectId,
    );
    return project === undefined ? null : (sandboxRepositoryOf(project)?.key ?? null);
  };
  const repositories = [
    ...new Set(
      config.projectIds.flatMap((projectId) => {
        const key = keyOfHostProject(projectId);
        return key === null ? [] : [key];
      }),
    ),
  ];
  const envFiles = Object.fromEntries(
    Object.entries(config.envFiles).map(([id, files]) => [keyOfHostProject(id) ?? id, files]),
  );
  return { repositories, envFiles };
};
