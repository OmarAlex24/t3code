import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "./sidebarProjectGrouping";
import type { Project } from "./types";

const primaryEnvironmentId = EnvironmentId.make("env-primary");

const repositoryIdentity = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};
const defaultGroupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-1"),
    environmentId: primaryEnvironmentId,
    title: "shared-repo",
    workspaceRoot: "/tmp/shared-repo",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

describe("environment grouping with sandboxes", () => {
  it("leaves out sandbox placeholder projects unless asked to keep one", () => {
    const real = makeProject({ title: "hello", workspaceRoot: "/work/hello" });
    const placeholder = makeProject({
      id: ProjectId.make("placeholder"),
      title: "hello",
      workspaceRoot: "/Users/me/.t3/userdata/sandbox-projects/octo/hello",
      // Newest, so it would otherwise win its group.
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    const input = {
      projects: [real, placeholder],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    };

    expect(buildSidebarProjectSnapshots(input).map((group) => group.id)).toEqual([real.id]);
    const kept = buildSidebarProjectSnapshots({
      ...input,
      keepSandboxPlaceholder: (project) => project.id === placeholder.id,
    });
    expect(kept.map((group) => group.id)).toEqual([real.id, placeholder.id]);
  });

  it("never lets a sandbox placeholder stand for the real project it is grouped with", () => {
    const real = makeProject({
      title: "shared-repo",
      workspaceRoot: "/work/shared-repo",
      repositoryIdentity,
    });
    // A placeholder inside a checkout resolves to that checkout's repository.
    const placeholder = makeProject({
      id: ProjectId.make("placeholder"),
      title: "octo-hello",
      workspaceRoot: "/work/shared-repo/.t3/userdata/sandbox-projects/octo/hello",
      repositoryIdentity,
      projectIcon: { kind: "lucide", name: "cloud", color: "sky" },
    });
    const [group, ...rest] = buildSidebarProjectSnapshots({
      projects: [placeholder, real],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
      keepSandboxPlaceholder: () => true,
    });

    expect(rest).toEqual([]);
    expect(group).toMatchObject({
      id: real.id,
      workspaceRoot: "/work/shared-repo",
      displayName: "shared-repo",
      groupedProjectCount: 2,
    });
    expect(group).not.toHaveProperty("projectIcon");
  });
});
