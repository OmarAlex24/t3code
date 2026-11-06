import {
  SANDBOX_SKILL_MAX_BYTES,
  SANDBOX_SKILLS_TOTAL_MAX_BYTES,
  type SandboxHostMcpServer,
  type SandboxHostSkill,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { mapleApiBaseUrl } from "./mapleApi.ts";

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One MCP server entry from ~/.claude.json, with the config it would copy. */
export interface HostMcpEntry {
  readonly name: string;
  readonly scope: "user" | "project";
  /** The project folder whose list holds it, for `project` entries. */
  readonly projectPath?: string;
  readonly config: JsonObject;
}

/** Every MCP server ~/.claude.json lists: the user's own, then each project's. */
export const parseClaudeMcpServers = (text: string): ReadonlyArray<HostMcpEntry> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObject(parsed)) return [];
  const entries = (servers: unknown, scope: HostMcpEntry["scope"], projectPath?: string) =>
    isObject(servers)
      ? Object.entries(servers).flatMap(([name, config]) =>
          isObject(config) && name.trim() !== ""
            ? [{ name, scope, config, ...(projectPath === undefined ? {} : { projectPath }) }]
            : [],
        )
      : [];
  return [
    ...entries(parsed.mcpServers, "user"),
    ...(isObject(parsed.projects)
      ? Object.entries(parsed.projects).flatMap(([projectPath, project]) =>
          isObject(project) ? entries(project.mcpServers, "project", projectPath) : [],
        )
      : []),
  ];
};

const transportOf = (config: JsonObject): SandboxHostMcpServer["transport"] =>
  config.type === "http" || config.type === "sse"
    ? config.type
    : typeof config.url === "string" && config.type === undefined
      ? "http"
      : "stdio";

const headerNamesOf = (config: JsonObject) =>
  isObject(config.headers) ? Object.keys(config.headers) : [];

const isLoopback = (host: string) =>
  host === "localhost" || host.startsWith("127.") || host === "[::1]";

/** Railway's own MCP server: `railway mcp`, the npm shim that runs it, or the hosted one. */
const isRailwayMcpEntry = (config: JsonObject) => {
  const args = Array.isArray(config.args) ? config.args : [];
  if (typeof config.command === "string") {
    return (
      (config.command.split("/").at(-1) === "railway" && args.includes("mcp")) ||
      args.some((arg) => typeof arg === "string" && arg.startsWith("@railway/mcp-server"))
    );
  }
  const url = typeof config.url === "string" ? URL.parse(config.url) : null;
  return url?.hostname === "mcp.railway.com";
};

export interface McpMintReadiness {
  readonly mapleReady: boolean;
  readonly railwayReady: boolean;
}

/**
 * How a server reaches a sandbox, judged from its entry alone. Maple and Railway servers never
 * copy this machine's sign-in: each sandbox gets its own, or none when nothing is saved to mint it.
 */
export const describeHostMcpServer = (
  entry: HostMcpEntry,
  options: McpMintReadiness,
): SandboxHostMcpServer => {
  const transport = transportOf(entry.config);
  const url = typeof entry.config.url === "string" ? URL.parse(entry.config.url) : null;
  const headerNames = headerNamesOf(entry.config);
  const base = {
    name: entry.name,
    scope: entry.scope,
    transport,
    headerNames,
    ...(url === null ? {} : { host: url.host }),
  };
  if (isRailwayMcpEntry(entry.config)) {
    return options.railwayReady
      ? {
          ...base,
          copy: "mint",
          mintedBy: "railway",
          reason:
            "Runs the Railway CLI on the sandbox with a token of its own, revoked when the sandbox is deleted.",
        }
      : {
          ...base,
          copy: "unavailable",
          reason: "Save a Railway token under Sandboxes so each sandbox gets its own.",
        };
  }
  if (transport === "stdio") {
    return {
      ...base,
      copy: "unavailable",
      reason: "Runs a program on this machine, so it can't be copied.",
    };
  }
  if (url === null) return { ...base, copy: "unavailable", reason: "Its URL can't be read." };
  if (isLoopback(url.hostname)) {
    return { ...base, copy: "unavailable", reason: "Only this machine can reach it." };
  }
  if (mapleApiBaseUrl(url.href) !== null) {
    return options.mapleReady
      ? {
          ...base,
          copy: "mint",
          mintedBy: "maple",
          reason: "Gets a Maple key of its own, revoked when the sandbox is deleted.",
        }
      : {
          ...base,
          copy: "unavailable",
          reason: "Save a Maple admin key under Sandboxes so each sandbox gets its own key.",
        };
  }
  if (headerNames.length === 0) {
    return {
      ...base,
      copy: "copy",
      reason: "Copied without a sign-in. If it uses OAuth, sign in again on the sandbox.",
    };
  }
  return { ...base, copy: "copy" };
};

/**
 * The entry a sandbox gets for each name, by Claude's own precedence: the project's list, then
 * the user's, then any other project that has one (the form lists every project's servers).
 */
export const pickHostMcpEntries = (
  entries: ReadonlyArray<HostMcpEntry>,
  names: ReadonlyArray<string>,
  projectRoot: string | undefined,
) =>
  names.flatMap((name) => {
    const named = entries.filter((entry) => entry.name === name);
    const found =
      named.find((entry) => projectRoot !== undefined && entry.projectPath === projectRoot) ??
      named.find((entry) => entry.scope === "user") ??
      named[0];
    return found === undefined ? [] : [found];
  });

/** Lists each name once, preferring an entry that can be copied. */
export const listHostMcpServers = (
  entries: ReadonlyArray<HostMcpEntry>,
  options: McpMintReadiness,
): ReadonlyArray<SandboxHostMcpServer> => {
  const byName = new Map<string, SandboxHostMcpServer>();
  for (const entry of entries) {
    const described = describeHostMcpServer(entry, options);
    const current = byName.get(entry.name);
    if (
      current === undefined ||
      (current.copy === "unavailable" && described.copy !== "unavailable")
    ) {
      byName.set(entry.name, described);
    }
  }
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
};

const SKIPPED_PARTS = new Set([".git", "node_modules", ".DS_Store"]);

const isSkippedFile = (relativePath: string) =>
  relativePath.endsWith(".zip") || relativePath.split("/").some((part) => SKIPPED_PARTS.has(part));

/** A file of a skill, relative to the skill's folder. */
export interface SkillFile {
  readonly relativePath: string;
  readonly size: number;
}

/**
 * A skill folder's files, following a symlinked folder. Stops counting once past the limit, so a
 * huge folder costs no more than the limit to look at.
 */
const walkSkill = Effect.fn("SandboxHostTooling.walkSkill")(function* (
  directory: string,
  maxBytes: number = SANDBOX_SKILL_MAX_BYTES,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<SkillFile> = [];
  let bytes = 0;
  const pending = [""];
  while (pending.length > 0 && bytes <= maxBytes) {
    const relative = pending.shift()!;
    const names = yield* fileSystem
      .readDirectory(path.join(directory, relative))
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const name of [...names].toSorted()) {
      const relativePath = relative === "" ? name : `${relative}/${name}`;
      if (isSkippedFile(relativePath)) continue;
      const info = yield* fileSystem
        .stat(path.join(directory, relativePath))
        .pipe(Effect.orElseSucceed(() => null));
      if (info === null) continue;
      if (info.type === "Directory") pending.push(relativePath);
      else if (info.type === "File") {
        const size = Number(info.size);
        files.push({ relativePath, size });
        bytes += size;
        if (bytes > maxBytes) break;
      }
    }
  }
  return { files, bytes };
});

/** The skills folder's skills: each folder (or symlink to one) with a SKILL.md. Zips are skipped. */
export const listHostSkills = Effect.fn("SandboxHostTooling.listHostSkills")(function* (
  skillsDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fileSystem
    .readDirectory(skillsDirectory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const skills: Array<SandboxHostSkill> = [];
  for (const name of [...names].toSorted()) {
    if (name.startsWith(".") || name.endsWith(".zip")) continue;
    const directory = path.join(skillsDirectory, name);
    const hasSkill = yield* fileSystem
      .exists(path.join(directory, "SKILL.md"))
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasSkill) continue;
    const walked = yield* walkSkill(directory);
    skills.push({ name, bytes: walked.bytes, copyable: walked.bytes <= SANDBOX_SKILL_MAX_BYTES });
  }
  return skills;
});

/** A file to write under the sandbox's Claude folder, with its UTF-8 text. */
export interface ClaudeFile {
  readonly path: string;
  readonly content: string;
}

const isText = (bytes: Uint8Array) => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/**
 * CLAUDE.md and the chosen skills as files relative to the Claude folder. A skill that is gone,
 * too large, or past the total limit is skipped by name; binary files inside a skill are left out.
 */
export const readClaudeFiles = Effect.fn("SandboxHostTooling.readClaudeFiles")(function* (
  configDirectory: string,
  input: { readonly claudeMd: boolean; readonly skills: ReadonlyArray<string> },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<ClaudeFile> = [];
  const skipped: Array<string> = [];
  const copiedSkills: Array<string> = [];
  if (input.claudeMd) {
    const content = yield* fileSystem
      .readFileString(path.join(configDirectory, "CLAUDE.md"))
      .pipe(Effect.orElseSucceed(() => null));
    if (content === null) skipped.push("CLAUDE.md");
    else files.push({ path: "CLAUDE.md", content });
  }
  let total = 0;
  for (const name of input.skills) {
    const directory = path.join(configDirectory, "skills", name);
    if (name.includes("/") || name.startsWith(".") || name.endsWith(".zip")) {
      skipped.push(name);
      continue;
    }
    const walked = yield* walkSkill(directory);
    if (walked.files.length === 0 || walked.bytes > SANDBOX_SKILL_MAX_BYTES) {
      skipped.push(name);
      continue;
    }
    if (total + walked.bytes > SANDBOX_SKILLS_TOTAL_MAX_BYTES) {
      skipped.push(name);
      continue;
    }
    total += walked.bytes;
    copiedSkills.push(name);
    for (const file of walked.files) {
      const bytes = yield* fileSystem
        .readFile(path.join(directory, file.relativePath))
        .pipe(Effect.orElseSucceed(() => null));
      if (bytes === null || !isText(bytes)) continue;
      files.push({
        path: `skills/${name}/${file.relativePath}`,
        content: new TextDecoder().decode(bytes),
      });
    }
  }
  return { files, skipped, skills: copiedSkills };
});
