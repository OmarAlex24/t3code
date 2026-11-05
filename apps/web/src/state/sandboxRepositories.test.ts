import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hostCopyOf,
  sandboxRepositoryChoices,
  sandboxRepositoryOf,
  repositoriesFromLegacyConfig,
} from "./sandboxRepositories";

const host = EnvironmentId.make("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
const remote = EnvironmentId.make("dddddddd-dddd-4ddd-8ddd-dddddddddddd");

const project = (
  environmentId: EnvironmentId,
  id: string,
  remoteUrl: string | null,
  extra: Partial<EnvironmentProject> = {},
): EnvironmentProject =>
  ({
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity:
      remoteUrl === null
        ? null
        : {
            canonicalKey: remoteUrl,
            locator: { source: "git-remote", remoteName: "origin", remoteUrl },
          },
    scripts: [],
    defaultModelSelection: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  }) as EnvironmentProject;

describe("sandbox repositories", () => {
  it("reads a GitHub repository from a project on any machine", () => {
    expect(
      sandboxRepositoryOf(project(remote, "hello", "git@github.com:Octo/Hello.git"))?.key,
    ).toBe("octo/hello");
    expect(sandboxRepositoryOf(project(remote, "lab", "https://gitlab.com/a/b.git"))).toBeNull();
    expect(sandboxRepositoryOf(project(remote, "none", null))).toBeNull();
    expect(
      sandboxRepositoryOf(
        project(remote, "scratch", "https://github.com/a/b", { isScratch: true }),
      ),
    ).toBeNull();
  });

  it("lists each repository once, labeled with the repository, from every machine", () => {
    const projects = [
      project(remote, "hello-remote", "https://github.com/Octo/Hello.git"),
      project(host, "hello-host", "git@github.com:octo/hello.git"),
      project(remote, "api", "https://github.com/octo/api"),
      project(remote, "lab", "https://gitlab.com/a/b.git"),
    ];
    expect(
      sandboxRepositoryChoices(projects, host).map((choice) => ({
        key: choice.key,
        label: choice.label,
        hostProjectId: choice.hostProject?.id ?? null,
      })),
    ).toEqual([
      { key: "octo/api", label: "octo/api", hostProjectId: null },
      // The host's copy is the one env files come from, whichever machine listed it first.
      { key: "octo/hello", label: "Octo/Hello", hostProjectId: "hello-host" },
    ]);
  });

  it("finds the host's copy of a repository only on the host", () => {
    const projects = [
      project(remote, "hello-remote", "https://github.com/octo/hello.git"),
      project(host, "hello-host", "https://github.com/octo/hello.git"),
    ];
    expect(hostCopyOf(projects, host, "octo/hello")?.id).toBe("hello-host");
    expect(hostCopyOf(projects.slice(0, 1), host, "octo/hello")).toBeNull();
  });

  it("turns a config's host project ids into repositories, with their env files", () => {
    const projects = [
      project(host, "hello-host", "https://github.com/octo/hello.git"),
      project(host, "local-only", null),
    ];
    expect(
      repositoriesFromLegacyConfig(
        {
          projectIds: ["hello-host", "local-only", "gone"],
          envFiles: { "hello-host": [".env.local"], "octo/api": [".env"] },
        },
        projects,
        host,
      ),
    ).toEqual({
      repositories: ["octo/hello"],
      envFiles: { "octo/hello": [".env.local"], "octo/api": [".env"] },
    });
  });
});
