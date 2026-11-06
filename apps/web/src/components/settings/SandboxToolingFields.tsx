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
import {
  AccessSwitch,
  CompactOptIn,
  DetailField,
  Disclosure,
  FieldLabel,
  SubHeading,
} from "./SandboxFormParts";
import { formatBytes } from "~/lib/formatBytes";

type GithubMode = "off" | "app" | "legacy";

const GITHUB_LABELS: Record<Exclude<GithubMode, "off">, string> = {
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
  const [railway, setRailway] = useState(config?.railway === true);
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
        : railway && host !== undefined && host.railway !== true
          ? "Save a Railway token under Sandboxes, or turn off Railway"
          : (gitName.trim() === "") !== (gitEmail.trim() === "")
            ? "Enter both a git name and email, or leave both empty"
            : null;

  // Railway's MCP server signs in with the sandbox's Railway token, so it goes only with Railway.
  const copiedMcpServers = mcpServers.filter(
    (name) =>
      railway || tooling?.mcpServers.find((server) => server.name === name)?.mintedBy !== "railway",
  );

  const claudeFiles = [
    copiedClaudeMd ? "CLAUDE.md" : null,
    skills.length === 0 ? null : plural(skills.length, "skill"),
  ].filter((part): part is string => part !== null);
  const agentSummaryParts = [
    githubMode === "app"
      ? "GitHub signed in"
      : githubMode === "legacy" && host?.github === true
        ? "GitHub signed in with this machine's token"
        : null,
    identity === null ? null : `commits as ${identity.name}`,
    northflank ? "Northflank signed in" : null,
    railway ? "Railway signed in" : null,
    copiedMcpServers.length === 0 ? null : plural(copiedMcpServers.length, "MCP server"),
  ].filter((part): part is string => part !== null);
  const setupSummaryParts = [
    setupScript.trim() === "" ? null : "runs your setup script",
    claudeFiles.length === 0 ? null : `copies ${claudeFiles.join(" and ")}`,
  ].filter((part): part is string => part !== null);

  const toConfig = () => ({
    passGithubToken: githubMode === "legacy" && host?.github === true,
    ...(githubMode === "app" ? { githubApp: true } : {}),
    ...(identity === null ? {} : { gitIdentity: identity }),
    ...(setupScript.trim() === "" ? {} : { setupScript }),
    ...(northflank ? { northflank: true } : {}),
    ...(railway ? { railway: true } : {}),
    ...(copiedMcpServers.length === 0 ? {} : { mcpServers: [...copiedMcpServers] }),
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
    railway,
    setRailway,
    mcpServers,
    copiedMcpServers,
    setMcpServers,
    claudeMd,
    setClaudeMd,
    skills,
    setSkills,
    attention,
    agentSummaryParts,
    setupSummaryParts,
    toConfig,
  };
}

type ToolingDraft = ReturnType<typeof useSandboxToolingDraft>;

const toggled = (list: ReadonlyArray<string>, name: string, on: boolean) =>
  on ? [...list.filter((entry) => entry !== name), name] : list.filter((entry) => entry !== name);

// What happens to a server's credentials, in the words of someone choosing it.
const mcpHint = (server: SandboxHostMcpServer) => {
  if (server.copy === "mint") {
    return server.reason ?? "Gets a key of its own, revoked when the sandbox is deleted.";
  }
  if (server.copy === "unavailable") return server.reason ?? "Can't be copied.";
  if (server.headerNames.length > 0) {
    return `Copies this machine's ${server.headerNames.join(", ")} header. Deleting the sandbox doesn't revoke it.`;
  }
  return server.reason ?? "Copied as is.";
};

const mcpNote = (server: SandboxHostMcpServer) =>
  server.copy === "mint"
    ? "own key"
    : server.copy === "unavailable"
      ? "can't be copied"
      : server.headerNames.length > 0
        ? `copies ${server.headerNames.join(", ")}`
        : "copied as is";

/** How sandboxes sign in to GitHub and the CLIs this machine has credentials for. */
export function SandboxAgentToolingFields({
  draft,
  disabled,
  onOpenSettings,
}: {
  draft: ToolingDraft;
  disabled: boolean;
  /** Closes the form and shows where the GitHub App is connected. */
  onOpenSettings: () => void;
}) {
  const { host } = draft;
  const hostIdentity = host?.tooling?.gitIdentity;
  const githubOn = draft.githubMode !== "off";
  const identityHalfSet = (draft.gitName.trim() === "") !== (draft.gitEmail.trim() === "");
  const showsGithub =
    host?.githubApp !== undefined ||
    host?.github === true ||
    githubOn ||
    draft.gitName !== "" ||
    draft.gitEmail !== "";
  const appMissing = draft.githubMode === "app" && host?.githubApp === undefined;
  const githubState =
    draft.githubMode === "app"
      ? host?.githubApp === undefined
        ? "The GitHub App isn't connected on this machine"
        : `A token for its repository only, as ${host.githubApp.slug}`
      : draft.githubMode === "legacy"
        ? host?.github === true
          ? "This machine's token, not revoked on delete"
          : "This machine has no GitHub token to share"
        : "Public repositories only";
  const githubDetails = (
    <>
      <DetailField label="Sign in with">
        <Select
          value={draft.githubMode === "off" ? "app" : draft.githubMode}
          disabled={disabled}
          onValueChange={(value) => {
            if (value !== null) draft.setGithubMode(value);
          }}
        >
          <SelectTrigger aria-label="GitHub sign-in" size="sm">
            <SelectValue>
              {GITHUB_LABELS[draft.githubMode === "off" ? "app" : draft.githubMode]}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="app">{GITHUB_LABELS.app}</SelectItem>
            <SelectItem value="legacy">{GITHUB_LABELS.legacy}</SelectItem>
          </SelectPopup>
        </Select>
      </DetailField>
      {appMissing ? (
        <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-warning-foreground">
          <CircleAlertIcon aria-hidden className="mt-px size-3 shrink-0" />
          <span>
            The GitHub App isn't connected yet.{" "}
            <button
              type="button"
              className="font-medium underline underline-offset-2 hover:text-foreground"
              onClick={onOpenSettings}
            >
              Connect it
            </button>
          </span>
        </p>
      ) : null}
      <DetailField label="Commit as">
        <div className="space-y-1">
          <div className="grid grid-cols-2 gap-2">
            <Input
              aria-label="Git name"
              size="sm"
              value={draft.gitName}
              onChange={(event) => draft.setGitName(event.target.value)}
              placeholder={hostIdentity?.name ?? "Name"}
              disabled={disabled}
              spellCheck={false}
            />
            <Input
              aria-label="Git email"
              size="sm"
              type="email"
              value={draft.gitEmail}
              onChange={(event) => draft.setGitEmail(event.target.value)}
              placeholder={hostIdentity?.email ?? "Email"}
              disabled={disabled}
              spellCheck={false}
            />
          </div>
          {hostIdentity === undefined ? (
            <p className="text-2xs leading-relaxed text-muted-foreground">
              This machine has no git identity, so enter one for commits.
            </p>
          ) : null}
        </div>
      </DetailField>
    </>
  );

  return (
    <>
      {showsGithub ? (
        <div>
          <AccessSwitch
            name="GitHub"
            state={githubState}
            warning={appMissing}
            checked={githubOn}
            disabled={disabled}
            onCheckedChange={(on) =>
              draft.setGithubMode(
                !on
                  ? "off"
                  : host?.githubApp === undefined && host?.github === true
                    ? "legacy"
                    : "app",
              )
            }
          >
            {githubDetails}
          </AccessSwitch>
          {/* A half-entered identity blocks saving, so it stays reachable with GitHub off. */}
          {!githubOn && identityHalfSet ? (
            <div className="space-y-2.5 pb-2.5">{githubDetails}</div>
          ) : null}
        </div>
      ) : null}

      {host?.northflank === true || draft.northflank ? (
        <AccessSwitch
          name="Northflank"
          state={
            host?.northflank === true
              ? "Signs the CLI in with the token every sandbox shares"
              : "No Northflank token on this machine"
          }
          warning={host?.northflank !== true}
          checked={draft.northflank}
          disabled={disabled || (host?.northflank !== true && !draft.northflank)}
          onCheckedChange={draft.setNorthflank}
        />
      ) : null}

      {host?.railway === true || draft.railway ? (
        <AccessSwitch
          name="Railway"
          state={
            host?.railway === true
              ? "Signs the CLI in with its own token, revoked on delete"
              : "No Railway token on this machine"
          }
          warning={host?.railway !== true}
          checked={draft.railway}
          disabled={disabled || (host?.railway !== true && !draft.railway)}
          onCheckedChange={draft.setRailway}
        />
      ) : null}
    </>
  );
}

/** The MCP servers on this machine a config's sandboxes get copies of, folded to one row. */
export function SandboxMcpServerFields({
  draft,
  disabled,
}: {
  draft: ToolingDraft;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tooling = draft.host?.tooling;
  const missingMcpServers = draft.mcpServers.filter(
    (name) => !(tooling?.mcpServers ?? []).some((server) => server.name === name),
  );
  return tooling === undefined || tooling.mcpServers.length === 0 ? null : (
    <div className="py-2">
      <Disclosure
        title="MCP servers"
        trailing={`${draft.copiedMcpServers.length} of ${tooling.mcpServers.length}`}
        open={open}
        onOpenChange={setOpen}
      >
        <fieldset aria-label="MCP servers from this machine" className="space-y-1.5 ps-5">
          <div className="grid gap-x-6 sm:grid-cols-2">
            {tooling.mcpServers.map((server) => {
              // Signs in with the sandbox's Railway token, which only the Railway switch makes.
              const needsRailway = server.mintedBy === "railway" && !draft.railway;
              return (
                <CompactOptIn
                  key={server.name}
                  checked={
                    server.copy !== "unavailable" &&
                    !needsRailway &&
                    draft.mcpServers.includes(server.name)
                  }
                  disabled={disabled || server.copy === "unavailable" || needsRailway}
                  onCheckedChange={(on) =>
                    draft.setMcpServers(toggled(draft.mcpServers, server.name, on))
                  }
                  title={
                    <span className="flex items-center gap-1">
                      {server.name}
                      {server.copy === "mint" ? (
                        <KeyRoundIcon aria-label="Own key" className="size-3 text-success" />
                      ) : null}
                    </span>
                  }
                  detail={needsRailway ? "turn on Railway above" : mcpNote(server)}
                  hint={`${server.host === undefined ? "" : `${server.host}. `}${
                    needsRailway
                      ? "Turn on Railway above: this server signs in with the sandbox's own Railway token."
                      : mcpHint(server)
                  }`}
                />
              );
            })}
          </div>
          <p className="text-2xs leading-relaxed text-muted-foreground">
            A key marks a server that gets its own, revoked with the sandbox. Copied headers keep
            working after it's deleted.
          </p>
          {missingMcpServers.length === 0 ? null : (
            <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-warning-foreground">
              <CircleAlertIcon aria-hidden className="mt-px size-3 shrink-0" />
              This machine no longer has {missingMcpServers.join(", ")}, so sandboxes won't get it.
            </p>
          )}
        </fieldset>
      </Disclosure>
    </div>
  );
}

/** What each sandbox installs and gets copied from this machine once it starts. */
export function SandboxSetupToolingFields({
  draft,
  disabled,
}: {
  draft: ToolingDraft;
  disabled: boolean;
}) {
  const tooling = draft.host?.tooling;
  const copyable =
    tooling === undefined ? 0 : tooling.skills.filter((skill) => skill.copyable).length;
  return (
    <>
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

      {tooling === undefined ? null : (
        <fieldset className="space-y-1.5">
          <legend className="contents">
            <SubHeading
              trailing={
                copyable === 0 ? null : (
                  <span className="text-2xs text-muted-foreground">
                    {draft.skills.length} of {plural(copyable, "skill")}
                  </span>
                )
              }
            >
              Claude files
            </SubHeading>
          </legend>
          <div className="grid gap-x-6 sm:grid-cols-2">
            <CompactOptIn
              checked={draft.claudeMd && tooling.claudeMd}
              disabled={disabled || !tooling.claudeMd}
              onCheckedChange={draft.setClaudeMd}
              title="Your CLAUDE.md"
              detail={tooling.claudeMd ? undefined : "none on this machine"}
              hint={
                tooling.claudeMd
                  ? "Copied fresh to each new sandbox."
                  : "This machine has no ~/.claude/CLAUDE.md."
              }
            />
            {tooling.skills.map((skill) => (
              <CompactOptIn
                key={skill.name}
                checked={skill.copyable && draft.skills.includes(skill.name)}
                disabled={disabled || !skill.copyable}
                onCheckedChange={(on) => draft.setSkills(toggled(draft.skills, skill.name, on))}
                title={skill.name}
                detail={skill.copyable ? formatBytes(skill.bytes) : "too large to copy"}
              />
            ))}
          </div>
          <p className="text-2xs leading-relaxed text-muted-foreground">
            Copied from ~/.claude when each sandbox starts.
          </p>
        </fieldset>
      )}
    </>
  );
}
