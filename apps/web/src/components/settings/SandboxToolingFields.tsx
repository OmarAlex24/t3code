import { CircleAlertIcon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import {
  SANDBOX_SETUP_SCRIPT_MAX_LENGTH,
  type SandboxEnvironmentConfig,
  type SandboxHostAccess,
  type SandboxHostMcpServer,
} from "@t3tools/contracts";

import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { FieldLabel, OptIn } from "./SandboxFormParts";
import { formatBytes } from "~/lib/formatBytes";

type GithubMode = "off" | "app" | "legacy";

const GITHUB_LABELS: Record<GithubMode, string> = {
  off: "Off",
  app: "GitHub App (recommended)",
  legacy: "This machine's token (legacy)",
};

const SETUP_PLACEHOLDER = `command -v psql >/dev/null || sudo apt-get install -y postgresql-client
npm install -g pnpm`;

const githubModeOf = (config: SandboxEnvironmentConfig | undefined, host?: SandboxHostAccess) =>
  config === undefined
    ? host?.githubApp === undefined
      ? "off"
      : "app"
    : config.githubApp === true
      ? "app"
      : config.passGithubToken
        ? "legacy"
        : "off";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The tools, GitHub sign-in and Claude files a config's sandboxes get, as edited in the form. */
export function useSandboxToolingDraft(
  config: SandboxEnvironmentConfig | undefined,
  host: SandboxHostAccess | undefined,
) {
  // Null until edited, so a new config follows what the server turns out to have.
  const [githubChoice, setGithubMode] = useState<GithubMode | null>(null);
  const [claudeMdChoice, setClaudeMd] = useState<boolean | null>(null);
  const [gitName, setGitName] = useState(config?.gitIdentity?.name ?? "");
  const [gitEmail, setGitEmail] = useState(config?.gitIdentity?.email ?? "");
  const [setupScript, setSetupScript] = useState(config?.setupScript ?? "");
  const [northflank, setNorthflank] = useState(config?.northflank === true);
  const [mcpServers, setMcpServers] = useState<ReadonlyArray<string>>(config?.mcpServers ?? []);
  const [skills, setSkills] = useState<ReadonlyArray<string>>(config?.skills ?? []);

  const tooling = host?.tooling;
  const githubMode = githubChoice ?? githubModeOf(config, host);
  const claudeMd =
    claudeMdChoice ??
    (config === undefined ? tooling?.claudeMd === true : config.claudeMd === true);
  const identity =
    gitName.trim() !== "" && gitEmail.trim() !== ""
      ? { name: gitName.trim(), email: gitEmail.trim() }
      : null;
  const copiedClaudeMd = claudeMd && (tooling === undefined || tooling.claudeMd);

  const attention =
    githubMode === "app" && host !== undefined && host.githubApp === undefined
      ? "Connect the GitHub App under Sandboxes, or pick another GitHub option"
      : northflank && host !== undefined && host.northflank !== true
        ? "Save a Northflank token under Sandboxes, or turn off Northflank"
        : (gitName.trim() === "") !== (gitEmail.trim() === "")
          ? "Enter both a git name and email, or leave both empty"
          : null;

  const claudeFiles = [
    copiedClaudeMd ? "CLAUDE.md" : null,
    skills.length === 0 ? null : plural(skills.length, "skill"),
  ].filter((part): part is string => part !== null);
  const summaryParts = [
    githubMode === "app"
      ? "GitHub signed in"
      : githubMode === "legacy" && host?.github === true
        ? "GitHub signed in with this machine's token"
        : null,
    setupScript.trim() === "" ? null : "runs your setup script",
    northflank ? "Northflank signed in" : null,
    mcpServers.length === 0 ? null : plural(mcpServers.length, "MCP server"),
    claudeFiles.length === 0 ? null : `copies ${claudeFiles.join(" and ")}`,
  ].filter((part): part is string => part !== null);

  const toConfig = () => ({
    passGithubToken: githubMode === "legacy" && host?.github === true,
    ...(githubMode === "app" ? { githubApp: true } : {}),
    ...(identity === null ? {} : { gitIdentity: identity }),
    ...(setupScript.trim() === "" ? {} : { setupScript }),
    ...(northflank ? { northflank: true } : {}),
    ...(mcpServers.length === 0 ? {} : { mcpServers: [...mcpServers] }),
    ...(copiedClaudeMd ? { claudeMd: true } : {}),
    ...(skills.length === 0 ? {} : { skills: [...skills] }),
  });

  return {
    host,
    githubMode,
    setGithubMode,
    gitName,
    setGitName,
    gitEmail,
    setGitEmail,
    setupScript,
    setSetupScript,
    northflank,
    setNorthflank,
    mcpServers,
    setMcpServers,
    claudeMd,
    setClaudeMd,
    skills,
    setSkills,
    attention,
    summaryParts,
    toConfig,
  };
}

type ToolingDraft = ReturnType<typeof useSandboxToolingDraft>;

const toggled = (list: ReadonlyArray<string>, name: string, on: boolean) =>
  on ? [...list.filter((entry) => entry !== name), name] : list.filter((entry) => entry !== name);

// What happens to a server's credentials, in the words of someone choosing it.
const mcpHint = (server: SandboxHostMcpServer) => {
  if (server.copy === "mint") {
    return "Gets a Maple key of its own, revoked when the sandbox is deleted.";
  }
  if (server.copy === "unavailable") return server.reason ?? "Can't be copied.";
  if (server.headerNames.length > 0) {
    return `Copies this machine's ${server.headerNames.join(", ")} header. Deleting the sandbox doesn't revoke it.`;
  }
  return server.reason ?? "Copied as is.";
};

function GroupHeading({ children }: { children: string }) {
  return <p className="text-xs font-semibold text-foreground">{children}</p>;
}

export function SandboxToolingFields({
  draft,
  disabled,
  onOpenSettings,
}: {
  draft: ToolingDraft;
  disabled: boolean;
  /** Closes the form and shows the Sandboxes settings, where credentials are saved. */
  onOpenSettings: () => void;
}) {
  const { host } = draft;
  const tooling = host?.tooling;
  const settingsLink = (label: string) => (
    <button
      type="button"
      className="font-medium underline underline-offset-2 hover:text-foreground"
      onClick={onOpenSettings}
    >
      {label}
    </button>
  );
  const githubHint =
    draft.githubMode === "app" ? (
      host?.githubApp === undefined ? (
        <span className="text-warning-foreground">
          The GitHub App isn't connected yet. {settingsLink("Connect it")}
        </span>
      ) : (
        `Each sandbox gets an hour-long token for its repository only, renewed while it runs and revoked when it's deleted. Pull requests show as ${host.githubApp.slug}.`
      )
    ) : draft.githubMode === "legacy" ? (
      host?.github === true ? (
        "Copies this machine's own GitHub token. Deleting a sandbox doesn't revoke it, so prefer the GitHub App."
      ) : (
        "This machine has no GitHub token to share."
      )
    ) : (
      "Sandboxes can clone public repositories only."
    );
  const hostIdentity = tooling?.gitIdentity;

  return (
    <div className="space-y-4 border-t border-border pt-4">
      <GroupHeading>Agent tools</GroupHeading>

      <div className="space-y-2">
        <label className="block">
          <FieldLabel>GitHub</FieldLabel>
          <Select
            value={draft.githubMode}
            disabled={disabled}
            onValueChange={(value) => {
              if (value !== null) draft.setGithubMode(value);
            }}
          >
            <SelectTrigger aria-label="GitHub sign-in" size="default">
              <SelectValue>{GITHUB_LABELS[draft.githubMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="off">{GITHUB_LABELS.off}</SelectItem>
              <SelectItem value="app">{GITHUB_LABELS.app}</SelectItem>
              <SelectItem value="legacy">{GITHUB_LABELS.legacy}</SelectItem>
            </SelectPopup>
          </Select>
        </label>
        <p className="text-2xs leading-relaxed text-muted-foreground">{githubHint}</p>
      </div>

      <div className="space-y-1.5">
        <FieldLabel>Commit as</FieldLabel>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            aria-label="Git name"
            value={draft.gitName}
            onChange={(event) => draft.setGitName(event.target.value)}
            placeholder={hostIdentity?.name ?? "Name"}
            disabled={disabled}
            spellCheck={false}
          />
          <Input
            aria-label="Git email"
            type="email"
            value={draft.gitEmail}
            onChange={(event) => draft.setGitEmail(event.target.value)}
            placeholder={hostIdentity?.email ?? "Email"}
            disabled={disabled}
            spellCheck={false}
          />
        </div>
        <p className="text-2xs leading-relaxed text-muted-foreground">
          {hostIdentity === undefined
            ? "This machine has no git name and email, so enter them for commits on the sandbox."
            : "Leave empty to use this machine's git name and email when GitHub is signed in."}
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="block">
          <FieldLabel
            trailing={
              draft.setupScript.length > SANDBOX_SETUP_SCRIPT_MAX_LENGTH * 0.9 ? (
                <span className="text-2xs font-normal text-muted-foreground">
                  {draft.setupScript.length.toLocaleString()} /{" "}
                  {SANDBOX_SETUP_SCRIPT_MAX_LENGTH.toLocaleString()}
                </span>
              ) : null
            }
          >
            Tools to install
          </FieldLabel>
          <Textarea
            value={draft.setupScript}
            onChange={(event) => draft.setSetupScript(event.target.value)}
            placeholder={SETUP_PLACEHOLDER}
            maxLength={SANDBOX_SETUP_SCRIPT_MAX_LENGTH}
            disabled={disabled}
            spellCheck={false}
          />
        </label>
        <p className="text-2xs leading-relaxed text-muted-foreground">
          A shell script that runs in the project folder after the clone. A sandbox started from a
          template that already ran it skips it. If it fails, setup still finishes and tells you.
        </p>
      </div>

      <OptIn
        checked={draft.northflank && host?.northflank === true}
        disabled={disabled || host?.northflank !== true}
        onCheckedChange={draft.setNorthflank}
        title="Sign the Northflank CLI in"
      >
        {host?.northflank === true ? (
          "Installs the CLI and signs it in with the token saved under Sandboxes. Every sandbox shares that token, so give it only the access sandboxes need."
        ) : (
          <>Needs a Northflank token saved under Sandboxes. {settingsLink("Add one")}</>
        )}
      </OptIn>

      {tooling === undefined || tooling.mcpServers.length === 0 ? null : (
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-xs font-medium text-foreground">
            MCP servers from this machine
          </legend>
          {tooling.mcpServers.map((server) => (
            <OptIn
              key={server.name}
              checked={server.copy !== "unavailable" && draft.mcpServers.includes(server.name)}
              disabled={disabled || server.copy === "unavailable"}
              onCheckedChange={(on) =>
                draft.setMcpServers(toggled(draft.mcpServers, server.name, on))
              }
              title={
                <span className="flex items-center gap-1.5">
                  <span>{server.name}</span>
                  {server.host === undefined ? null : (
                    <span className="font-normal text-muted-foreground">{server.host}</span>
                  )}
                  {server.copy === "mint" ? (
                    <KeyRoundIcon aria-label="Own key" className="size-3 text-success" />
                  ) : null}
                </span>
              }
            >
              {mcpHint(server)}
            </OptIn>
          ))}
          {draft.mcpServers.some(
            (name) => !tooling.mcpServers.some((server) => server.name === name),
          ) ? (
            <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-warning-foreground">
              <CircleAlertIcon aria-hidden className="mt-px size-3 shrink-0" />
              This machine no longer has{" "}
              {draft.mcpServers
                .filter((name) => !tooling.mcpServers.some((server) => server.name === name))
                .join(", ")}
              , so sandboxes won't get it.
            </p>
          ) : null}
        </fieldset>
      )}

      {tooling === undefined ? null : (
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-xs font-medium text-foreground">Claude files</legend>
          <OptIn
            checked={draft.claudeMd && tooling.claudeMd}
            disabled={disabled || !tooling.claudeMd}
            onCheckedChange={draft.setClaudeMd}
            title="Your CLAUDE.md"
          >
            {tooling.claudeMd
              ? "Copied fresh to each new sandbox."
              : "This machine has no ~/.claude/CLAUDE.md."}
          </OptIn>
          {tooling.skills.map((skill) => (
            <OptIn
              key={skill.name}
              checked={skill.copyable && draft.skills.includes(skill.name)}
              disabled={disabled || !skill.copyable}
              onCheckedChange={(on) => draft.setSkills(toggled(draft.skills, skill.name, on))}
              title={
                <span className="flex items-center gap-1.5">
                  <span>{skill.name}</span>
                  <span className="font-normal text-muted-foreground">
                    {formatBytes(skill.bytes)}
                  </span>
                </span>
              }
            >
              {skill.copyable ? undefined : "Too large to copy."}
            </OptIn>
          ))}
        </fieldset>
      )}
    </div>
  );
}
