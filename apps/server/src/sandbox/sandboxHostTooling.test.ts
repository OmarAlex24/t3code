import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { describe, expect } from "vite-plus/test";

import {
  listHostMcpServers,
  listHostSkills,
  parseClaudeMcpServers,
  pickHostMcpEntries,
  readClaudeFiles,
} from "./sandboxHostTooling.ts";

// Shaped like ~/.claude.json: the user's servers, then each project's.
const claudeJson = JSON.stringify({
  numStartups: 9,
  mcpServers: {
    railway: { type: "stdio", command: "railway", args: ["mcp"] },
    maple: { type: "http", url: "https://api.maple.dev/mcp" },
  },
  projects: {
    "/work/web": {
      mcpServers: {
        maple: {
          type: "http",
          url: "https://api.maple.dev/mcp",
          headers: { Authorization: "Bearer host_maple_KEY" },
        },
        palmier: { type: "http", url: "http://127.0.0.1:19789/mcp" },
        docs: { type: "http", url: "https://docs.example.test/mcp", headers: { "X-Key": "k" } },
      },
    },
    "/work/api": { mcpServers: { linear: { type: "sse", url: "https://mcp.linear.test/sse" } } },
  },
});

describe("host MCP servers", () => {
  it("lists each server once with how it can reach a sandbox, and never a header value", () => {
    const entries = parseClaudeMcpServers(claudeJson);
    const listed = listHostMcpServers(entries, { mapleReady: false, railwayReady: false });
    expect(JSON.stringify(listed)).not.toContain("host_maple_KEY");
    expect(listed.map((server) => [server.name, server.copy])).toEqual([
      ["docs", "copy"],
      ["linear", "copy"],
      ["maple", "unavailable"],
      ["palmier", "unavailable"],
      ["railway", "unavailable"],
    ]);
    expect(listed.find((server) => server.name === "docs")).toMatchObject({
      scope: "project",
      transport: "http",
      host: "docs.example.test",
      headerNames: ["X-Key"],
    });
    expect(listed.find((server) => server.name === "railway")?.reason).toBe(
      "Save a Railway token under Sandboxes so each sandbox gets its own.",
    );
    // Maple and Railway are minted per sandbox once a key is saved, never copied with this
    // machine's sign-in; Railway's hosted server and its CLI's stdio server alike.
    const ready = listHostMcpServers(entries, { mapleReady: true, railwayReady: true });
    expect(ready.find((server) => server.name === "maple")).toMatchObject({
      copy: "mint",
      mintedBy: "maple",
    });
    expect(ready.find((server) => server.name === "railway")).toMatchObject({
      copy: "mint",
      mintedBy: "railway",
    });
    const hosted = parseClaudeMcpServers(
      JSON.stringify({
        mcpServers: {
          railway: { type: "http", url: "https://mcp.railway.com" },
          shim: { command: "npx", args: ["-y", "@railway/mcp-server"] },
          other: { command: "railway" },
        },
      }),
    );
    expect(
      listHostMcpServers(hosted, { mapleReady: false, railwayReady: true }).map((server) => [
        server.name,
        server.mintedBy ?? server.copy,
      ]),
    ).toEqual([
      ["other", "unavailable"],
      ["railway", "railway"],
      ["shim", "railway"],
    ]);
    expect(parseClaudeMcpServers("not json")).toEqual([]);
  });

  it("picks the launching project's entry first, then the user's, then any project's", () => {
    const entries = parseClaudeMcpServers(claudeJson);
    const picked = (projectRoot: string | undefined) =>
      pickHostMcpEntries(entries, ["maple", "linear", "missing"], projectRoot).map(
        (entry) => `${entry.name}:${entry.projectPath ?? "user"}`,
      );
    expect(picked("/work/web")).toEqual(["maple:/work/web", "linear:/work/api"]);
    expect(picked(undefined)).toEqual(["maple:user", "linear:/work/api"]);
  });
});

describe("host skills", () => {
  it.live("follows symlinked skills, skips zips and folders without SKILL.md, and caps sizes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-" });
      const skills = `${root}/claude/skills`;
      yield* fs.makeDirectory(`${skills}/small/scripts`, { recursive: true });
      yield* fs.writeFileString(`${skills}/small/SKILL.md`, "---\nname: small\n---");
      yield* fs.writeFileString(`${skills}/small/scripts/run.sh`, "echo hi");
      yield* fs.writeFile(`${skills}/small/scripts/logo.png`, new Uint8Array([0x89, 0, 1, 2]));
      yield* fs.writeFileString(`${skills}/small/bundle.zip`, "zip");
      yield* fs.makeDirectory(`${root}/elsewhere/linked`, { recursive: true });
      yield* fs.writeFileString(`${root}/elsewhere/linked/SKILL.md`, "linked");
      yield* fs.symlink(`${root}/elsewhere/linked`, `${skills}/linked`);
      yield* fs.makeDirectory(`${skills}/huge`);
      yield* fs.writeFileString(`${skills}/huge/SKILL.md`, "x".repeat(3 * 1024 * 1024));
      yield* fs.makeDirectory(`${skills}/notes`);
      yield* fs.writeFileString(`${skills}/archive.zip`, "zip");

      const listed = yield* listHostSkills(skills);
      expect(listed.map((skill) => [skill.name, skill.copyable])).toEqual([
        ["huge", false],
        ["linked", true],
        ["small", true],
      ]);

      const read = yield* readClaudeFiles(`${root}/claude`, {
        claudeMd: true,
        skills: ["small", "linked", "huge", "../escape"],
      });
      expect(read.files.map((file) => file.path)).toEqual([
        "skills/small/SKILL.md",
        "skills/small/scripts/run.sh",
        "skills/linked/SKILL.md",
      ]);
      expect(read.skipped).toEqual(["CLAUDE.md", "huge", "../escape"]);
      expect(read.skills).toEqual(["small", "linked"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
