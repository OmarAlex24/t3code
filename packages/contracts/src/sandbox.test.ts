import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  isSandboxHostProjectRoot,
  assessSandboxStart,
  describeSandboxTemplateNameProblem,
  githubRepositoryOf,
  sandboxConfigAllows,
  tailscaleClientIdFromSecret,
  SandboxCreateInput,
  type SandboxProviderLimits,
  SandboxTemplateName,
} from "./sandbox.ts";

const assess = (limits: Partial<SandboxProviderLimits>) =>
  assessSandboxStart({ canStart: true, ...limits }, { providerLabel: "Boat", nowMillis: 0 });

describe("assessSandboxStart", () => {
  it("asks for confirmation on paid, nearly exhausted, or last-slot starts without blocking", () => {
    const cases: ReadonlyArray<[Partial<SandboxProviderLimits>, ReadonlyArray<string>]> = [
      [{ startCost: "included" }, []],
      [{ startCost: "paid", startDollars: 0.03 }, ["This start will be charged about $0.03."]],
      // The threshold is ten percent of the window, but never below two starts.
      [
        { starts: [{ window: "minute", limit: 5, used: 3, remaining: 2 }] },
        ["Only 2 starts left this minute."],
      ],
      [{ starts: [{ window: "minute", limit: 5, used: 2, remaining: 3 }] }, []],
      [
        { starts: [{ window: "day", limit: 840, used: 756, remaining: 84 }] },
        ["Only 84 starts left this day."],
      ],
      [{ starts: [{ window: "day", limit: 840, used: 755, remaining: 85 }] }, []],
      [{ concurrency: { active: 1, max: 2 } }, ["This uses your last free slot (1 of 2 running)."]],
      // A full window that the provider still accepts is a paid start, not a refusal.
      [
        {
          startCost: "paid",
          starts: [{ window: "hour", limit: 60, used: 60, remaining: 0 }],
        },
        ["This start is past your plan's limits and will be charged."],
      ],
    ];
    for (const [limits, warnings] of cases) {
      expect(assess(limits)).toEqual({ blocked: null, warnings });
    }
  });
});

const isSandboxTemplateName = Schema.is(SandboxTemplateName);

describe("SandboxTemplateName", () => {
  it("accepts only names every provider can save, and says why the rest fail", () => {
    const cases: ReadonlyArray<[string, string | null]> = [
      ["web-stack", null],
      ["0", null],
      ["a".repeat(63), null],
      ["", "Enter a name."],
      ["a".repeat(64), "Use at most 63 characters."],
      ["-stack", "Use lowercase letters, digits, and dashes, starting with a letter or digit."],
      ["Web-Stack", "Use lowercase letters, digits, and dashes, starting with a letter or digit."],
      ["web_stack", "Use lowercase letters, digits, and dashes, starting with a letter or digit."],
      ["web stack", "Use lowercase letters, digits, and dashes, starting with a letter or digit."],
      // Boat reserves these for its CLI.
      ...["latest", "tree", "pull", "rm", "save", "current", "self", "new"].map(
        (name): [string, string] => [name, `"${name}" is a reserved name.`],
      ),
      ["newer", null],
    ];
    for (const [name, problem] of cases) {
      expect(describeSandboxTemplateNameProblem(name), name).toBe(problem);
      expect(isSandboxTemplateName(name), name).toBe(problem === null);
    }
  });
});

const decodeSandboxCreateInput = Schema.decodeUnknownSync(SandboxCreateInput);

describe("SandboxCreateInput", () => {
  // Projects reach a sandbox through "Add project to another machine"; the server clones nothing.
  it("drops a repository to clone sent by an older client", () => {
    const decoded = decodeSandboxCreateInput({
      provider: "boat",
      repositoryUrl: "https://github.com/owner/repo",
    });
    expect(decoded).toEqual({ provider: "boat" });
  });
});

describe("githubRepositoryOf", () => {
  it("names a github.com repository the same way for every remote spelling", () => {
    for (const remote of [
      "https://github.com/OmarAlex24/Hello-World.git",
      "https://x-access-token:ghp_secret@github.com/omaralex24/hello-world",
      "git@github.com:OmarAlex24/Hello-World.git",
      "ssh://git@github.com/OmarAlex24/Hello-World/",
    ]) {
      expect(githubRepositoryOf(remote)?.key).toBe("omaralex24/hello-world");
    }
    const parsed = githubRepositoryOf("https://ghp_secret@github.com/OmarAlex24/Hello-World.git");
    // The clone URL never carries the credential from the remote.
    expect(parsed?.cloneUrl).toBe("https://github.com/OmarAlex24/Hello-World.git");
    expect(parsed?.label).toBe("OmarAlex24/Hello-World");
  });

  it("refuses remotes that are not on github.com", () => {
    for (const remote of [
      "https://gitlab.com/a/b.git",
      "https://github.com.evil.test/a/b.git",
      "git@github.example.com:a/b.git",
      "/Users/me/repo",
    ]) {
      expect(githubRepositoryOf(remote)).toBeNull();
    }
  });
});

describe("sandboxConfigAllows", () => {
  const repo = "omaralex24/hello-world";
  it("allows any GitHub repository when the config names none", () => {
    expect(sandboxConfigAllows({ projectIds: [] }, { repository: repo, hostProjectId: null })).toBe(
      true,
    );
  });

  it("matches repositories by identity, wherever the project lives", () => {
    const config = { projectIds: [], repositories: ["OmarAlex24/Hello-World"] };
    expect(sandboxConfigAllows(config, { repository: repo, hostProjectId: null })).toBe(true);
    expect(
      sandboxConfigAllows(config, { repository: "omaralex24/other", hostProjectId: null }),
    ).toBe(false);
  });

  it("keeps a config saved with host project ids working for those projects", () => {
    const config = { projectIds: ["project-1"] };
    expect(sandboxConfigAllows(config, { repository: repo, hostProjectId: "project-1" })).toBe(
      true,
    );
    expect(sandboxConfigAllows(config, { repository: repo, hostProjectId: null })).toBe(false);
  });
});

describe("tailscaleClientIdFromSecret", () => {
  it("reads the client ID out of an OAuth client secret", () => {
    expect(tailscaleClientIdFromSecret("tskey-client-kAbC123CNTRL-SomeLongSecretPart")).toBe(
      "kAbC123CNTRL",
    );
    expect(tailscaleClientIdFromSecret("  tskey-client-k1-a-b-c ")).toBe("k1");
  });

  it("returns null for anything else", () => {
    for (const secret of ["", "tskey-auth-k1-abc", "tskey-client-", "secret"]) {
      expect(tailscaleClientIdFromSecret(secret)).toBeNull();
    }
  });
});

describe("isSandboxHostProjectRoot", () => {
  it("recognises a lightweight sandbox project's folder and nothing else", () => {
    expect(isSandboxHostProjectRoot("/Users/me/.t3/userdata/sandbox-projects/octo/hello")).toBe(
      true,
    );
    expect(isSandboxHostProjectRoot("C:\\t3\\sandbox-projects\\octo\\hello\\")).toBe(true);
    expect(isSandboxHostProjectRoot("/Users/me/code/hello")).toBe(false);
    expect(isSandboxHostProjectRoot("/x/sandbox-projects/octo")).toBe(false);
    expect(isSandboxHostProjectRoot("/x/sandbox-projects/octo/hello/src")).toBe(false);
  });
});
