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
