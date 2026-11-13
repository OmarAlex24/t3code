import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { UploadChatAttachment } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { WorktreeSetupPhase, WorktreeSetupStageStatus } from "./worktreeSetup.ts";

/**
 * Sandbox providers are provisioned by the server a client is already connected to. The
 * provider's API key is saved in that server's settings, so an environment can be created from
 * any client without ever sending its key to the other machines on the account.
 */
export const SandboxProviderKind = Schema.Literals([
  "boat",
  "celesto",
  "daytona",
  "upstash",
  "vercel",
]);
export type SandboxProviderKind = typeof SandboxProviderKind.Type;

export const SandboxMachineSize = Schema.Struct({
  id: TrimmedString,
  label: TrimmedString,
  detail: TrimmedString,
});
export type SandboxMachineSize = typeof SandboxMachineSize.Type;

/** A non-secret account setting a provider needs besides its key, saved next to the key. */
export const SandboxProviderSettingsField = Schema.Struct({
  id: TrimmedString,
  label: TrimmedString,
  placeholder: Schema.optionalKey(TrimmedString),
  optional: Schema.Boolean,
});
export type SandboxProviderSettingsField = typeof SandboxProviderSettingsField.Type;

export const SandboxProviderInfo = Schema.Struct({
  kind: SandboxProviderKind,
  label: TrimmedString,
  detail: TrimmedString,
  apiKeyLabel: TrimmedString,
  apiKeyPlaceholder: TrimmedString,
  docsUrl: TrimmedString,
  /** False until an API key is saved on this server. */
  configured: Schema.Boolean,
  sizes: Schema.Array(SandboxMachineSize),
  /** The size a create without one gets, so clients preselect what the server would pick. */
  defaultSize: TrimmedString,
  settingsFields: Schema.optionalKey(Schema.Array(SandboxProviderSettingsField)),
  /** The saved values of `settingsFields`, keyed by field id. */
  settings: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Days the provider keeps a stopped sandbox's disk, where it documents a limit. */
  diskRetentionDays: Schema.optionalKey(Schema.Int),
  /** Derived from the optional methods the driver implements, so clients never branch on `kind`. */
  capabilities: Schema.Struct({
    limits: Schema.Boolean,
    stopResume: Schema.Boolean,
    credentialEnvironments: Schema.Boolean,
    templates: Schema.Boolean,
    /** The provider can give one sandbox's agent a key scoped to that sandbox and its forks. */
    agentProviderAccess: Schema.Boolean,
    /**
     * A sandbox keeps itself running while its threads work and the provider stops it after
     * `idleMinutes` without work. Absent from older servers.
     */
    keepAlive: Schema.optionalKey(Schema.Boolean),
  }),
});
export type SandboxProviderInfo = typeof SandboxProviderInfo.Type;

/**
 * How a host MCP server reaches a sandbox. `copy` copies its entry, header values included; `mint`
 * gives each sandbox a key of its own (Maple); `unavailable` says why it cannot go (`reason`).
 */
export const SandboxMcpCopyMode = Schema.Literals(["copy", "mint", "unavailable"]);
export type SandboxMcpCopyMode = typeof SandboxMcpCopyMode.Type;

/** One of this machine's Claude MCP servers, by name. Never carries a header value. */
export const SandboxHostMcpServer = Schema.Struct({
  name: TrimmedString,
  /** `user` is the server list in ~/.claude.json; `project` is a project's own list there. */
  scope: Schema.Literals(["user", "project"]),
  transport: Schema.Literals(["http", "sse", "stdio"]),
  /** The server's host, for HTTP servers. */
  host: Schema.optionalKey(TrimmedString),
  headerNames: Schema.Array(TrimmedString),
  copy: SandboxMcpCopyMode,
  /** Who makes the key a `mint` server gets: a Railway server also needs the config's `railway`. */
  mintedBy: Schema.optionalKey(Schema.Literals(["maple", "railway"])),
  reason: Schema.optionalKey(TrimmedString),
});
export type SandboxHostMcpServer = typeof SandboxHostMcpServer.Type;

export const SandboxHostSkill = Schema.Struct({
  name: TrimmedString,
  bytes: Schema.Number,
  /** False when the skill is too large to copy. */
  copyable: Schema.Boolean,
});
export type SandboxHostSkill = typeof SandboxHostSkill.Type;

/** The largest skill a sandbox gets, and the most all copied skills may add up to. */
export const SANDBOX_SKILL_MAX_BYTES = 2 * 1024 * 1024;
export const SANDBOX_SKILLS_TOTAL_MAX_BYTES = 4 * 1024 * 1024;
export const SANDBOX_SETUP_SCRIPT_MAX_LENGTH = 20_000;

export const SandboxHostTooling = Schema.Struct({
  /** Git's global user.name and user.email on this machine. */
  gitIdentity: Schema.optionalKey(Schema.Struct({ name: TrimmedString, email: TrimmedString })),
  /** ~/.claude/CLAUDE.md exists. */
  claudeMd: Schema.Boolean,
  skills: Schema.Array(SandboxHostSkill),
  mcpServers: Schema.Array(SandboxHostMcpServer),
});
export type SandboxHostTooling = typeof SandboxHostTooling.Type;

/**
 * What the provisioning server can share with a new sandbox from its own machine. Only facts:
 * the base URL is the editable default, and no key or token ever leaves the server.
 */
export const SandboxHostAccess = Schema.Struct({
  /** Present when this server's Claude talks to a custom endpoint a sandbox can reuse. */
  claude: Schema.optionalKey(
    Schema.Struct({
      baseUrl: TrimmedString,
      /** `hub`: a new key is added on the CLIProxyAPI hub; `copy`: this machine's token is copied. */
      key: Schema.Literals(["hub", "copy"]),
      /** The base URL resolves only to private addresses, so a cloud sandbox likely can't reach it. */
      privateNetwork: Schema.Boolean,
      /** The base URL's Tailscale address, when it resolves to one. */
      tailnetAddress: Schema.optionalKey(TrimmedString),
    }),
  ),
  /** This server has a GitHub token for github.com it could forward. */
  github: Schema.Boolean,
  /** A Tailscale OAuth client is saved, so a sandbox can join this tailnet. */
  tailscale: Schema.Boolean,
  /** The GitHub App sandboxes get their own short-lived tokens from, once it is connected. */
  githubApp: Schema.optionalKey(Schema.Struct({ slug: TrimmedString, owner: TrimmedString })),
  /** A dedicated Northflank token is saved for sandboxes. */
  northflank: Schema.optionalKey(Schema.Boolean),
  /** A Maple admin key is saved, so each sandbox gets a Maple key of its own. */
  maple: Schema.optionalKey(Schema.Boolean),
  /** A Railway workspace token is saved, so each sandbox gets a Railway token of its own. */
  railway: Schema.optionalKey(Schema.Boolean),
  /** What this machine has for an agent to work with: git identity, MCP servers, skills. */
  tooling: Schema.optionalKey(SandboxHostTooling),
  /** The hub's non-Claude models a sandbox's Pi would get, when Claude uses a hub that lists them. */
  piModels: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type SandboxHostAccess = typeof SandboxHostAccess.Type;

export const SandboxProvidersResult = Schema.Struct({
  providers: Schema.Array(SandboxProviderInfo),
  host: SandboxHostAccess,
});
export type SandboxProvidersResult = typeof SandboxProvidersResult.Type;

/**
 * A provider-side environment is the only supported way to give a sandbox credentials. It
 * decides whether the provider passes its GitHub token, secrets, and agent logins; T3 never
 * reads or forwards those values itself.
 */
export const SandboxCredentialEnvironment = Schema.Struct({
  name: TrimmedString,
  isDefault: Schema.Boolean,
  safeForThirdParties: Schema.Boolean,
  passGithub: Schema.Boolean,
  passSecrets: Schema.Boolean,
  passSandboxCredentials: Schema.Boolean,
  passAgentsCredentials: Schema.Boolean,
  proxyAiCredentials: Schema.Boolean,
});
export type SandboxCredentialEnvironment = typeof SandboxCredentialEnvironment.Type;

export const SandboxCredentialEnvironmentsInput = Schema.Struct({
  provider: SandboxProviderKind,
});
export type SandboxCredentialEnvironmentsInput = typeof SandboxCredentialEnvironmentsInput.Type;

export const SandboxCredentialEnvironmentsResult = Schema.Struct({
  environments: Schema.Array(SandboxCredentialEnvironment),
});
export type SandboxCredentialEnvironmentsResult = typeof SandboxCredentialEnvironmentsResult.Type;

export const SandboxStartWindow = Schema.Struct({
  window: Schema.Literals(["minute", "hour", "day"]),
  limit: Schema.Number,
  used: Schema.Number,
  remaining: Schema.Number,
  resetsAt: Schema.optionalKey(TrimmedString),
});
export type SandboxStartWindow = typeof SandboxStartWindow.Type;

/**
 * What the provider account allows right now, normalized across providers. Every field but
 * `canStart` is optional because providers report different subsets.
 */
export const SandboxProviderLimits = Schema.Struct({
  canStart: Schema.Boolean,
  blockedReason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  starts: Schema.optionalKey(Schema.Array(SandboxStartWindow)),
  concurrency: Schema.optionalKey(Schema.Struct({ active: Schema.Number, max: Schema.Number })),
  /** `refused` means the provider would reject the next start outright. */
  startCost: Schema.optionalKey(Schema.Literals(["included", "paid", "refused"])),
  startDollars: Schema.optionalKey(Schema.Number),
  maxTtlMinutes: Schema.optionalKey(Schema.Int),
  /** False when the plan refuses to save templates, so a save is refused before T3 is reset. */
  canSaveTemplates: Schema.optionalKey(Schema.Boolean),
  sizes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: TrimmedString,
        available: Schema.Boolean,
        reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
      }),
    ),
  ),
  plan: Schema.optionalKey(TrimmedString),
  billingUrl: Schema.optionalKey(TrimmedString),
});
export type SandboxProviderLimits = typeof SandboxProviderLimits.Type;

export const SandboxLimitsInput = Schema.Struct({
  provider: SandboxProviderKind,
});
export type SandboxLimitsInput = typeof SandboxLimitsInput.Type;

export const SandboxLimitsResult = Schema.Struct({
  /** Null when the provider cannot report limits; starting is then left to the provider. */
  limits: Schema.NullOr(SandboxProviderLimits),
});
export type SandboxLimitsResult = typeof SandboxLimitsResult.Type;

/** `public` serves T3 on a provider URL; `tailnet` reaches the sandbox only at its tailnet address. */
export const SandboxAccess = Schema.Literals(["public", "tailnet"]);
export type SandboxAccess = typeof SandboxAccess.Type;

export const DEFAULT_SANDBOX_MAX_RUNNING_MINUTES = 480;

/**
 * The longest each step of a sandbox resume may take on the host: the provider starting the
 * machine (every driver polls 90 times, 2 seconds apart), installing a keep-alive key, rejoining a
 * tailnet, starting T3 Code on it, and rewriting T3 Code's agent skill and instructions.
 */
export const SANDBOX_RESUME_STEP_SECONDS = {
  machineStart: 180,
  keepAlive: 60,
  tailnetRejoin: 420,
  t3Start: 180,
  agentGuidance: 30,
  subSandboxHelper: 30,
} as const;

/**
 * How long a turn on a sandbox chat's host thread waits for its resuming sandbox to answer: every
 * step at its longest, and a minute for the provider calls between them and the connection.
 */
export const SANDBOX_RESUME_WAIT_SECONDS =
  Object.values(SANDBOX_RESUME_STEP_SECONDS).reduce((total, seconds) => total + seconds, 0) + 60;
export const DEFAULT_SANDBOX_IDLE_MINUTES = 30;
export const SandboxMaxRunningMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 10, maximum: 43200 }),
);
const SandboxIdleMinutes = Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 1440 }));

/** How many sandboxes `delegate_task` may start for subagents when a config sets no limits. */
export const DEFAULT_SANDBOX_SUB_SANDBOX_LIMITS = { perThread: 2, total: 4 } as const;
const SandboxSubSandboxCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }));
/**
 * Sandboxes subagents may get of their own: at most `perThread` at once for one parent thread,
 * and `total` at once across every parent. 0 turns them off.
 */
export const SandboxSubSandboxLimits = Schema.Struct({
  perThread: SandboxSubSandboxCount,
  total: SandboxSubSandboxCount,
});
export type SandboxSubSandboxLimits = typeof SandboxSubSandboxLimits.Type;

export const SandboxCreateInput = Schema.Struct({
  provider: SandboxProviderKind,
  /** Saved on this server when present; when omitted the saved key is used. */
  apiKey: Schema.optional(TrimmedString),
  /** Values for the provider's `settingsFields`, saved on this server; an empty value clears one. */
  settings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Shown as the environment and sandbox name. Defaults to a generated name. */
  label: Schema.optional(TrimmedString),
  /** One of the provider's machine size ids. Defaults to the provider's default size. */
  size: Schema.optional(TrimmedString),
  /** Provider environment whose credentials the sandbox receives. Omit for no credentials. */
  environment: Schema.optional(TrimmedString),
  /** Required with `environment`: the user confirmed that this environment passes credentials. */
  allowCredentials: Schema.optional(Schema.Boolean),
  /** Stop the machine after it has run this many minutes. Defaults to eight hours. */
  maxRunningMinutes: Schema.optional(SandboxMaxRunningMinutes),
  /** Where the provider keeps a sandbox up while it works: stop it after this long without work. */
  idleMinutes: Schema.optional(SandboxIdleMinutes),
  /** Where the provider keeps a sandbox up while it works: stop it after this long even then. */
  runningCapMinutes: Schema.optional(SandboxMaxRunningMinutes),
  /** A saved template to start from. The template decides the machine size. */
  template: Schema.optional(TrimmedString),
  /** Sets up agents in the sandbox from this server's own setup. Omit for none. */
  agentAccess: Schema.optional(
    Schema.Struct({
      claude: Schema.optional(Schema.Struct({ baseUrl: TrimmedString })),
      /** Sets up Pi with the hub's other models on the sandbox's hub key; needs `claude` on a hub. */
      pi: Schema.optional(Schema.Struct({ startModel: Schema.optional(TrimmedNonEmptyString) })),
    }),
  ),
  /** Signs `gh` and git in the sandbox in with this server's GitHub token. */
  passGithubToken: Schema.optional(Schema.Boolean),
  /** Joins the sandbox to this server's tailnet as an ephemeral, tagged node. */
  joinTailnet: Schema.optional(Schema.Boolean),
  /**
   * Signs the provider's CLI in on the sandbox with a key scoped to it: the agent can fork it,
   * host its ports, and delete only the forks it made. Never combined with `environment`.
   */
  agentProviderAccess: Schema.optional(Schema.Boolean),
  /** `tailnet` publishes no public URL; clients reach the sandbox at its Tailscale address. */
  access: Schema.optional(SandboxAccess),
});
export type SandboxCreateInput = typeof SandboxCreateInput.Type;

/** `skipped` was not asked for; `failed` left the sandbox running without it. */
export const SandboxSetupState = Schema.Literals(["ready", "failed", "skipped"]);
export type SandboxSetupState = typeof SandboxSetupState.Type;

export const SandboxCreateResult = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  provider: SandboxProviderKind,
  sandboxId: TrimmedString,
  environmentId: EnvironmentId,
  label: TrimmedString,
  /** Public origin of the T3 server running in the sandbox. */
  httpBaseUrl: TrimmedString,
  /** One-time pairing code, consumed by the client that connects to the new environment. */
  pairingCode: TrimmedString,
  /** What the sandbox got beyond T3 Code, for the checklist shown after it is created. */
  setup: Schema.Struct({
    claude: SandboxSetupState,
    github: SandboxSetupState,
    tailscale: SandboxSetupState,
    /** Steps that did not finish but left a working sandbox. Never carries command output. */
    warnings: Schema.Array(Schema.String),
  }),
});
export type SandboxCreateResult = typeof SandboxCreateResult.Type;

/** Without `instanceId`, deletes an untracked sandbox the sweep flagged as an orphan. */
export const SandboxDeleteInput = Schema.Struct({
  provider: SandboxProviderKind,
  sandboxId: TrimmedString,
  instanceId: Schema.optional(TrimmedNonEmptyString),
});
export type SandboxDeleteInput = typeof SandboxDeleteInput.Type;

export const SandboxDeleteResult = Schema.Struct({
  /** Cleanup that failed after the sandbox was deleted, such as revoking its hub key. */
  warnings: Schema.Array(Schema.String),
});
export type SandboxDeleteResult = typeof SandboxDeleteResult.Type;

/**
 * `expired` is a stopped sandbox whose disk the provider no longer keeps; `deleted` is one the
 * provider no longer knows. Both stay listed until the user removes them.
 */
export const SandboxLifecycleState = Schema.Literals([
  "provisioning",
  "running",
  "stopped",
  "error",
  "expired",
  "deleted",
]);
export type SandboxLifecycleState = typeof SandboxLifecycleState.Type;

/**
 * Server-side record of one provider machine, keyed by an id T3 picks before the machine exists.
 * A per-thread sandbox names the config it was launched from and the thread it runs; the
 * environment id is known once T3 answers on the machine.
 */
export const SandboxRecord = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  environmentId: Schema.NullOr(EnvironmentId),
  configId: Schema.optionalKey(TrimmedNonEmptyString),
  threadId: Schema.optionalKey(ThreadId),
  /**
   * Set on a sandbox `delegate_task` started for a subagent: the thread on this server that
   * delegated the task. Such a sandbox has no chat of its own (`threadId` is absent).
   */
  parentThreadId: Schema.optionalKey(ThreadId),
  projectId: Schema.optionalKey(ProjectId),
  projectTitle: Schema.optionalKey(TrimmedString),
  provider: SandboxProviderKind,
  sandboxId: TrimmedString,
  label: TrimmedString,
  size: TrimmedString,
  state: SandboxLifecycleState,
  createdAt: TrimmedString,
  updatedAt: TrimmedString,
  /** Empty until the machine has an origin. */
  httpBaseUrl: TrimmedString,
  access: Schema.optionalKey(SandboxAccess),
  /** Start of the current running stretch; null while stopped. */
  runningSince: Schema.NullOr(TrimmedString),
  /**
   * The sweep stops a sandbox that has run this long since its last start, unless it keeps itself
   * running (`keepAliveKey`); then only `runningCapMinutes` limits it.
   */
  maxRunningMinutes: Schema.Int,
  /** With keep-alive, the provider stops the sandbox this long after its threads stop working. */
  idleMinutes: Schema.optionalKey(Schema.Int),
  /** With keep-alive, the sweep still stops the sandbox after running this long. Absent: no cap. */
  runningCapMinutes: Schema.optionalKey(Schema.Int),
  /**
   * The provider key the sandbox moves its own auto-stop with while its threads work, scoped to
   * this sandbox and revoked when it is deleted. Named before it is minted; `id` is set once it is.
   */
  keepAliveKey: Schema.optionalKey(
    Schema.Struct({
      name: TrimmedString,
      id: Schema.optionalKey(TrimmedString),
      expiresAt: Schema.optionalKey(TrimmedString),
    }),
  ),
  /** When the sandbox last stopped, so the list can say how old its kept disk is. */
  stoppedAt: Schema.optionalKey(TrimmedString),
  /** Set while a resume runs, from when it began, so clients can say the sandbox is starting. */
  resumingSince: Schema.optionalKey(TrimmedString),
  /**
   * The chat was settled and the host could not act alone: its config asks (`ask`), or deletes but
   * the sandbox may hold work or its agents may still run (`work`). Clients offer Delete and Keep (`sandboxes.resolveSettle`);
   * un-settling the chat clears it.
   */
  settlePending: Schema.optionalKey(
    Schema.Struct({ since: TrimmedString, reason: Schema.Literals(["ask", "work"]) }),
  ),
  /**
   * The chat settle (the thread's `settledAt`) whose `onSettle` the host has applied, so a host
   * restart applies a settle it missed and never one already decided, kept, or snapshotted.
   */
  settleHandled: Schema.optionalKey(TrimmedString),
  credentialEnvironment: Schema.optionalKey(TrimmedString),
  /** The template the sandbox started from, for display. */
  template: Schema.optionalKey(TrimmedString),
  /**
   * The CLIProxyAPI key added for this sandbox, revoked when it is deleted. The key itself is a
   * server secret named by `secret`; the record only says where it lives.
   */
  claudeHubKey: Schema.optionalKey(
    Schema.Struct({ sourceId: TrimmedString, secret: TrimmedString }),
  ),
  /** The tailnet device T3 joined the sandbox as, removed when the sandbox is deleted. */
  tailscale: Schema.optionalKey(Schema.Struct({ deviceId: TrimmedString })),
  /**
   * The GitHub App installation token the sandbox signs `gh` and git in with. It lasts an hour and
   * is replaced while the sandbox runs; the token is a server secret named by `secret`, revoked
   * when the sandbox is deleted.
   */
  githubApp: Schema.optionalKey(
    Schema.Struct({
      installationId: Schema.Number,
      repository: TrimmedString,
      secret: TrimmedString,
      expiresAt: TrimmedString,
    }),
  ),
  /** The Maple key made for this sandbox's MCP server, revoked when the sandbox is deleted. */
  mapleKey: Schema.optionalKey(Schema.Struct({ keyId: TrimmedString, apiBaseUrl: TrimmedString })),
  /**
   * The Railway workspace token made for this sandbox, found again by its unique `name` and
   * revoked when the sandbox is deleted. The token itself is a server secret named by `secret`.
   */
  railwayToken: Schema.optionalKey(
    Schema.Struct({ name: TrimmedString, workspaceId: TrimmedString, secret: TrimmedString }),
  ),
  /** Where the thread's repository was cloned, so a delete can check it for unpushed work. */
  repoDir: Schema.optionalKey(TrimmedString),
  /**
   * The provider environment made for this sandbox alone, so its forks can be found, and the
   * scoped key its agent signs in with. Deleting the sandbox revokes the key, deletes its forks
   * and then the environment. `keyId` is absent once the key is revoked or never got in.
   */
  agentProviderAccess: Schema.optionalKey(
    Schema.Struct({
      environmentId: TrimmedString,
      environmentName: TrimmedString,
      keyId: Schema.optionalKey(TrimmedString),
    }),
  ),
  /** The project T3 added for the clone on the sandbox, where the sandbox bridge starts the thread. */
  sandboxProjectId: Schema.optionalKey(ProjectId),
  /** The github.com repository the sandbox cloned, as `owner/name`. */
  repository: Schema.optionalKey(TrimmedString),
  /** The project on this server that holds the thread the phone sees; the bridge routes it here. */
  hostProjectId: Schema.optionalKey(ProjectId),
  /**
   * The bearer session minted on the sandbox for the sandbox bridge. The token is a server secret
   * named by `secret`; the record only says where it lives and when it expires.
   */
  bridge: Schema.optionalKey(
    Schema.Struct({ sessionId: TrimmedString, secret: TrimmedString, expiresAt: TrimmedString }),
  ),
  /**
   * When T3 found this sandbox's launch with nothing left to finish it (the server stopped
   * mid-launch). The machine is kept for the user to delete; a new launch on its thread replaces it.
   */
  abandonedAt: Schema.optionalKey(TrimmedString),
  /** Provider settings the sandbox was created with; they win over the current ones for it. */
  providerSettings: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Machine cost this calendar month at list price, when the provider reports it. */
  costDollars: Schema.optionalKey(Schema.Number),
  costSince: Schema.optionalKey(TrimmedString),
});
export type SandboxRecord = typeof SandboxRecord.Type;

/**
 * A provider sandbox no record tracks: one tagged by this server, or a fork an agent made of a
 * sandbox it runs on (`forkOf` names that sandbox's record). Listed, never deleted by the sweep.
 */
export const SandboxOrphan = Schema.Struct({
  provider: SandboxProviderKind,
  sandboxId: TrimmedString,
  name: TrimmedString,
  instanceId: Schema.optionalKey(TrimmedString),
  createdAt: Schema.optionalKey(TrimmedString),
  forkOf: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SandboxOrphan = typeof SandboxOrphan.Type;

export const SandboxListResult = Schema.Struct({
  sandboxes: Schema.Array(SandboxRecord),
  orphans: Schema.Array(SandboxOrphan),
});
export type SandboxListResult = typeof SandboxListResult.Type;

export const SandboxLifecycleInput = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
});
export type SandboxLifecycleInput = typeof SandboxLifecycleInput.Type;

/** The user's answer to a settled chat's `settlePending`: delete the sandbox, or keep it as it is. */
export const SandboxResolveSettleInput = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  choice: Schema.Literals(["delete", "keep"]),
});
export type SandboxResolveSettleInput = typeof SandboxResolveSettleInput.Type;

export const SandboxResolveSettleResult = Schema.Struct({
  warnings: Schema.Array(Schema.String),
  /** False when nothing waited on the answer: the chat was un-settled, or it was answered already. */
  resolved: Schema.Boolean,
});
export type SandboxResolveSettleResult = typeof SandboxResolveSettleResult.Type;

const SANDBOX_TEMPLATE_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "latest",
  "tree",
  "pull",
  "rm",
  "save",
  "current",
  "self",
  "new",
]);

/** Why `name` cannot name a template, or null. The save dialog and the RPC schema share it. */
export const describeSandboxTemplateNameProblem = (name: string): string | null => {
  if (name === "") return "Enter a name.";
  if (name.length > 63) return "Use at most 63 characters.";
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
    return "Use lowercase letters, digits, and dashes, starting with a letter or digit.";
  }
  if (SANDBOX_TEMPLATE_RESERVED_NAMES.has(name)) return `"${name}" is a reserved name.`;
  return null;
};

// Boat's saved-snapshot rule, the strictest of the providers, so one name works everywhere.
export const SandboxTemplateName = Schema.String.check(
  Schema.makeFilter((name: string) => describeSandboxTemplateNameProblem(name) === null, {
    expected: "a template name of 1-63 lowercase letters, digits, or dashes",
  }),
);

export const SandboxTemplate = Schema.Struct({
  name: TrimmedString,
  createdAt: Schema.optionalKey(TrimmedString),
  sizeBytes: Schema.optionalKey(Schema.Number),
  /** One of the provider's size ids, when the template decides the size of what starts from it. */
  size: Schema.optionalKey(TrimmedString),
});
export type SandboxTemplate = typeof SandboxTemplate.Type;

/** What the account pays for templates, when the provider reports it. */
export const SandboxTemplateAllowance = Schema.Struct({
  included: Schema.Number,
  used: Schema.Number,
  extra: Schema.optionalKey(Schema.Number),
  pricePerExtraDailyDollars: Schema.optionalKey(Schema.Number),
});
export type SandboxTemplateAllowance = typeof SandboxTemplateAllowance.Type;

export const SandboxTemplatesInput = Schema.Struct({
  provider: SandboxProviderKind,
});
export type SandboxTemplatesInput = typeof SandboxTemplatesInput.Type;

export const SandboxTemplatesResult = Schema.Struct({
  templates: Schema.Array(SandboxTemplate),
  templateAllowance: Schema.optionalKey(SandboxTemplateAllowance),
});
export type SandboxTemplatesResult = typeof SandboxTemplatesResult.Type;

export const SandboxSaveTemplateInput = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  name: SandboxTemplateName,
});
export type SandboxSaveTemplateInput = typeof SandboxSaveTemplateInput.Type;

export const SandboxSaveTemplateResult = Schema.Struct({
  template: SandboxTemplate,
});
export type SandboxSaveTemplateResult = typeof SandboxSaveTemplateResult.Type;

export const SandboxDeleteTemplateInput = Schema.Struct({
  provider: SandboxProviderKind,
  name: TrimmedString,
});
export type SandboxDeleteTemplateInput = typeof SandboxDeleteTemplateInput.Type;

export const SandboxStopResult = Schema.Struct({
  sandbox: SandboxRecord,
});
export type SandboxStopResult = typeof SandboxStopResult.Type;

/**
 * Whether a thread's sandbox holds work that deleting it would lose: changed or untracked files,
 * and commits not on any remote. `unknown` says why it could not tell, such as a stopped sandbox.
 */
export const SandboxCheckWorkResult = Schema.Struct({
  status: Schema.Literals(["clean", "dirty", "unknown"]),
  uncommittedFiles: Schema.Int,
  unpushedCommits: Schema.Int,
  detail: Schema.optionalKey(TrimmedString),
});
export type SandboxCheckWorkResult = typeof SandboxCheckWorkResult.Type;

export const SandboxResumeResult = Schema.Struct({
  sandbox: SandboxRecord,
  httpBaseUrl: TrimmedString,
  /** Setup that did not come back with the sandbox, such as rejoining the tailnet. */
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type SandboxResumeResult = typeof SandboxResumeResult.Type;

export const SandboxStage = Schema.Literals([
  "create",
  "install",
  "start",
  "expose",
  "repo",
  "pair",
  "delete",
  "config",
  "template",
]);
export type SandboxStage = typeof SandboxStage.Type;

export const SandboxProviderErrorCode = Schema.Literals([
  "api_key_rejected",
  "rate_limited",
  "concurrency_full",
  "billing_required",
  "size_unavailable",
  "snapshot_expired",
  "capacity_unavailable",
  "not_found",
  "templates_unavailable",
  "template_saving",
  /** Claude's endpoint is only on a private network, and no Tailscale client is saved to join. */
  "tailscale_required",
  /** The account key cannot mint the scoped key a sandbox's agent would sign in with. */
  "scoped_keys_unavailable",
  "unknown",
]);
export type SandboxProviderErrorCode = typeof SandboxProviderErrorCode.Type;

export class SandboxProviderError extends Schema.TaggedError<SandboxProviderError>()(
  "SandboxProviderError",
  {
    /** The sandbox's provider; absent when no sandbox record names one, such as an unknown thread. */
    provider: Schema.optional(SandboxProviderKind),
    stage: SandboxStage,
    /**
     * Bounded, human-readable reason shown to the user. Never a raw provider response body or
     * remote command output: those can carry credentials.
     */
    detail: Schema.String,
    /** The provider's HTTP status when the failure came from a response. */
    status: Schema.optional(Schema.Number),
    /** Stable category for provider refusals, so clients can react without parsing `detail`. */
    code: Schema.optional(SandboxProviderErrorCode),
    retryAfterSeconds: Schema.optional(Schema.Number),
    /** The exact underlying error or output, kept out of `message` and out of logs. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.provider === undefined ? this.detail : `${this.provider}: ${this.detail}`;
  }
}

export const isSandboxProviderError = Schema.is(SandboxProviderError);

const formatWait = (seconds: number): string =>
  seconds < 90
    ? `${Math.max(1, Math.round(seconds))} s`
    : seconds < 5400
      ? `${Math.round(seconds / 60)} min`
      : `${Math.round(seconds / 360) / 10} h`;

/** "Try again in 12 min." or an empty string, for messages that know when a limit frees up. */
export const describeSandboxRetry = (retryAfterSeconds: number | undefined): string =>
  retryAfterSeconds === undefined || retryAfterSeconds <= 0
    ? ""
    : ` Try again in ${formatWait(retryAfterSeconds)}.`;

/** Ten percent of the window, but never fewer than two starts. */
export const isSandboxStartWindowLow = (window: SandboxStartWindow): boolean =>
  window.remaining <= Math.max(2, Math.ceil(window.limit / 10));

export interface SandboxStartAssessment {
  readonly blocked: {
    readonly code: SandboxProviderErrorCode;
    readonly reason: string;
    readonly retryAfterSeconds?: number;
  } | null;
  /** Starts the provider accepts but the user should confirm: paid, nearly out, last slot. */
  readonly warnings: ReadonlyArray<string>;
}

/**
 * The one place that decides whether a start is blocked or only needs a confirmation. The server
 * enforces `blocked`; clients show both. Unknown fields never block.
 */
export const assessSandboxStart = (
  limits: SandboxProviderLimits,
  options: { readonly providerLabel: string; readonly size?: string; readonly nowMillis: number },
): SandboxStartAssessment => {
  const fullWindow = limits.starts?.find((window) => window.remaining <= 0);
  const secondsUntil = (iso: string | undefined) => {
    if (iso === undefined) return undefined;
    const millis = Date.parse(iso);
    return Number.isNaN(millis)
      ? undefined
      : Math.max(0, Math.ceil((millis - options.nowMillis) / 1000));
  };
  const size =
    options.size === undefined
      ? undefined
      : limits.sizes?.find((entry) => entry.id === options.size);
  const concurrencyFull =
    limits.concurrency !== undefined && limits.concurrency.active >= limits.concurrency.max;

  const blocked = ((): SandboxStartAssessment["blocked"] => {
    if (!limits.canStart) {
      return {
        code: "billing_required",
        reason:
          limits.blockedReason ??
          `${options.providerLabel} is not accepting new starts on this account.`,
      };
    }
    if (size !== undefined && !size.available) {
      return {
        code: "size_unavailable",
        reason:
          size.reason ??
          `This machine size is not available on your ${options.providerLabel} plan.`,
      };
    }
    if (concurrencyFull) {
      return {
        code: "concurrency_full",
        reason: `All ${limits.concurrency!.max} of your ${options.providerLabel} sandbox slots are in use. Stop or delete one first.`,
      };
    }
    if (limits.startCost === "refused") {
      if (fullWindow === undefined) {
        return {
          code: "billing_required",
          reason: `${options.providerLabel} would refuse the next start on this account.`,
        };
      }
      const retryAfterSeconds = secondsUntil(fullWindow.resetsAt);
      return {
        code: "rate_limited",
        reason: `${options.providerLabel}'s start limit for this ${fullWindow.window} is used up.${describeSandboxRetry(retryAfterSeconds)}`,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    }
    return null;
  })();
  if (blocked !== null) return { blocked, warnings: [] };

  const warnings: Array<string> = [];
  if (limits.startCost === "paid") {
    warnings.push(
      limits.startDollars === undefined
        ? `This start is past your plan's limits and will be charged.`
        : `This start will be charged about $${limits.startDollars.toFixed(2)}.`,
    );
  }
  const lowWindow = limits.starts?.find(
    (window) => window.remaining > 0 && isSandboxStartWindowLow(window),
  );
  if (lowWindow !== undefined) {
    warnings.push(
      `Only ${lowWindow.remaining} ${lowWindow.remaining === 1 ? "start" : "starts"} left this ${lowWindow.window}.`,
    );
  }
  if (
    limits.concurrency !== undefined &&
    limits.concurrency.active === limits.concurrency.max - 1
  ) {
    warnings.push(
      `This uses your last free slot (${limits.concurrency.active} of ${limits.concurrency.max} running).`,
    );
  }
  return { blocked: null, warnings };
};

const GITHUB_REMOTE =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/u;

/**
 * The github.com repository a remote points at, or null for any other host. `key` is the
 * lower-case `owner/name` two spellings of one remote share; `cloneUrl` never carries the
 * credential a remote URL may hold.
 */
export const githubRepositoryOf = (remoteUrl: string) => {
  const match = GITHUB_REMOTE.exec(remoteUrl.trim());
  if (match === null) return null;
  const owner = match[1]!;
  const name = match[2]!;
  return {
    owner,
    name,
    key: `${owner}/${name}`.toLowerCase(),
    label: `${owner}/${name}`,
    cloneUrl: `https://github.com/${owner}/${name}.git`,
  };
};

export const SandboxSettleAction = Schema.Literals(["ask", "snapshot", "delete"]);
export type SandboxSettleAction = typeof SandboxSettleAction.Type;

/**
 * How to make a sandbox for one thread. Saving a config creates no machine; each thread launched
 * on it gets its own sandbox, provisioned on the server that holds the provider key.
 */
export const SandboxEnvironmentConfig = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  provider: SandboxProviderKind,
  /** One of the provider's size ids; ignored when `template` decides the size. */
  size: TrimmedNonEmptyString,
  template: Schema.optionalKey(TrimmedNonEmptyString),
  /** A provider credential environment, which the user confirmed passes credentials. */
  credentialEnvironment: Schema.optionalKey(TrimmedNonEmptyString),
  /** Points Claude in the sandbox at this server's endpoint, with a hub key or a copied token. */
  claude: Schema.optionalKey(Schema.Struct({ baseUrl: TrimmedNonEmptyString })),
  /** Legacy: signs GitHub in with this server's own token, which deleting a sandbox cannot revoke. */
  passGithubToken: Schema.Boolean,
  /** Signs GitHub in with an hour-long GitHub App token for the thread's repository alone. */
  githubApp: Schema.optionalKey(Schema.Boolean),
  /** Git's name and email on the sandbox; this server's own are copied when absent. */
  gitIdentity: Schema.optionalKey(
    Schema.Struct({ name: TrimmedNonEmptyString, email: TrimmedNonEmptyString }),
  ),
  /**
   * A shell script run in the clone after it is made, to install the agent's tools. It runs once
   * per machine: a sandbox from a template that already ran it skips it.
   */
  setupScript: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(SANDBOX_SETUP_SCRIPT_MAX_LENGTH)),
  ),
  /** Names of this server's Claude MCP servers copied into the sandbox's Claude config. */
  mcpServers: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** Copies this server's ~/.claude/CLAUDE.md to the sandbox. */
  claudeMd: Schema.optionalKey(Schema.Boolean),
  /** Names of skills in this server's ~/.claude/skills copied to the sandbox. */
  skills: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** Signs the Northflank CLI in with the dedicated token saved for sandboxes. */
  northflank: Schema.optionalKey(Schema.Boolean),
  /** Signs the Railway CLI in with a workspace token made for each sandbox and revoked with it. */
  railway: Schema.optionalKey(Schema.Boolean),
  /**
   * Sets up Pi with the CLIProxyAPI hub's non-Claude models, on the key the sandbox gets for Claude.
   * With `startModel` (a hub model id), new chats on the config start on Pi with that model.
   */
  pi: Schema.optionalKey(Schema.Struct({ startModel: Schema.optionalKey(TrimmedNonEmptyString) })),
  joinTailnet: Schema.Boolean,
  /** Lets the agent use the provider's CLI on its own sandbox; see `SandboxCreateInput`. */
  agentProviderAccess: Schema.optionalKey(Schema.Boolean),
  /**
   * What settling a chat does to its sandbox: `ask` (the default when absent), `snapshot` stops
   * it and keeps its disk, `delete` deletes it and the conversation it holds.
   */
  onSettle: Schema.optionalKey(SandboxSettleAction),
  access: SandboxAccess,
  // Any GitHub project can start on any config. Rows saved when a config could be limited still
  // carry `projectIds` and `repositories`; decoding drops those keys, so nothing reads them.
  /**
   * Git-ignored files copied into the clone from the project's copy on this server, by repository
   * key (`owner/name`, lower case) or, for older configs, by project id. A project without an
   * entry gets its env files (`.env*`, `.envrc`, `.dev.vars`).
   */
  envFiles: Schema.Record(Schema.String, Schema.Array(TrimmedNonEmptyString)),
  /**
   * Minutes without work before the sandbox stops, on providers that keep a sandbox running
   * while its threads work (`capabilities.keepAlive`).
   */
  idleMinutes: SandboxIdleMinutes,
  /** The running limit on providers without keep-alive, and the fallback when it cannot be set up. */
  maxRunningMinutes: SandboxMaxRunningMinutes,
  /** With keep-alive, stop a sandbox after running this long even while it works. Absent: no cap. */
  runningCapMinutes: Schema.optionalKey(SandboxMaxRunningMinutes),
  /** Sandboxes subagents may start from this config. Absent: `DEFAULT_SANDBOX_SUB_SANDBOX_LIMITS`. */
  subSandboxes: Schema.optionalKey(SandboxSubSandboxLimits),
  createdAt: TrimmedString,
  updatedAt: TrimmedString,
});
export type SandboxEnvironmentConfig = typeof SandboxEnvironmentConfig.Type;

export const SandboxConfigsResult = Schema.Struct({
  configs: Schema.Array(SandboxEnvironmentConfig),
});
export type SandboxConfigsResult = typeof SandboxConfigsResult.Type;

export const SandboxSaveConfigInput = Schema.Struct({
  config: Schema.Struct({
    ...SandboxEnvironmentConfig.fields,
    /** Omit to create a config. */
    id: Schema.optionalKey(TrimmedNonEmptyString),
    createdAt: Schema.optionalKey(TrimmedString),
    updatedAt: Schema.optionalKey(TrimmedString),
  }),
  /** Saved on this server when present; when omitted the saved key is used. */
  apiKey: Schema.optional(TrimmedString),
  /** Values for the provider's `settingsFields`, saved next to the key. */
  settings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type SandboxSaveConfigInput = typeof SandboxSaveConfigInput.Type;

export const SandboxSaveConfigResult = Schema.Struct({
  config: SandboxEnvironmentConfig,
});
export type SandboxSaveConfigResult = typeof SandboxSaveConfigResult.Type;

export const SandboxDeleteConfigInput = Schema.Struct({
  configId: TrimmedNonEmptyString,
});
export type SandboxDeleteConfigInput = typeof SandboxDeleteConfigInput.Type;

/** Producers clamp free text to these before publishing so encoding never fails. */
export const SANDBOX_SETUP_DETAIL_MAX_LENGTH = 200;
export const SANDBOX_SETUP_ERROR_MAX_LENGTH = 1000;

export const SandboxSetupStageId = Schema.Literals([
  "preflight",
  "create",
  "install",
  "credentials",
  "start",
  "repo",
  "env-files",
  "pair",
  "tools",
]);
export type SandboxSetupStageId = typeof SandboxSetupStageId.Type;

export const SANDBOX_SETUP_STAGE_ORDER: ReadonlyArray<SandboxSetupStageId> = [
  "preflight",
  "create",
  "install",
  "credentials",
  "start",
  "repo",
  "env-files",
  "tools",
  "pair",
];

export function sandboxSetupStageLabel(id: SandboxSetupStageId): string {
  switch (id) {
    case "preflight":
      return "Check limits and access";
    case "create":
      return "Create machine";
    case "install":
      return "Install T3 Code and tools";
    case "credentials":
      return "Set up credentials";
    case "start":
      return "Start T3 Code";
    case "repo":
      return "Clone repository";
    case "env-files":
      return "Copy env files";
    case "tools":
      return "Set up tools and Claude";
    case "pair":
      return "Connect and start thread";
  }
}

export const SandboxSetupStage = Schema.Struct({
  id: SandboxSetupStageId,
  status: WorktreeSetupStageStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  detail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(SANDBOX_SETUP_DETAIL_MAX_LENGTH))),
});
export type SandboxSetupStage = typeof SandboxSetupStage.Type;

/**
 * What a failed launch can do next. `relaunch`: nothing was kept, so retry starts over.
 * `retry`: the machine is kept, so retry runs the failed stage again; cancel deletes it.
 * `set-up-tailscale`: nothing was kept, and a new sandbox would fail the same way until Tailscale
 * is set up for it to join the tailnet.
 */
export const SandboxSetupRecovery = Schema.Literals(["relaunch", "retry", "set-up-tailscale"]);
export type SandboxSetupRecovery = typeof SandboxSetupRecovery.Type;

/** One thread's sandbox launch, streamed from the server provisioning it. */
export const SandboxSetupSnapshot = Schema.Struct({
  threadId: ThreadId,
  instanceId: TrimmedNonEmptyString,
  configId: TrimmedNonEmptyString,
  label: TrimmedString,
  provider: SandboxProviderKind,
  phase: WorktreeSetupPhase,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  stages: Schema.Array(SandboxSetupStage),
  /** Steps that did not finish but left a working sandbox. Never carries command output. */
  warnings: Schema.Array(Schema.String.check(Schema.isMaxLength(SANDBOX_SETUP_DETAIL_MAX_LENGTH))),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(SANDBOX_SETUP_ERROR_MAX_LENGTH))),
  recovery: Schema.NullOr(SandboxSetupRecovery),
  /** The sandbox serves T3 with the project added; the client pairs and starts the thread. */
  awaitingHandoff: Schema.Boolean,
  sequence: NonNegativeInt,
});
export type SandboxSetupSnapshot = typeof SandboxSetupSnapshot.Type;

/**
 * A sandbox chat's first message. The host makes the chat a thread of its own with this message
 * queued, and sends it through the sandbox bridge once the sandbox is ready.
 */
export const SandboxLaunchMessage = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  /** Images the host saves for this thread and message before it queues the message. */
  attachments: Schema.Array(UploadChatAttachment),
  title: TrimmedNonEmptyString,
  /** The model picked for the chat; the bridge carries it to the sandbox when the sandbox lists it. */
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type SandboxLaunchMessage = typeof SandboxLaunchMessage.Type;

export const SandboxLaunchInput = Schema.Struct({
  configId: TrimmedNonEmptyString,
  /** The thread id the client allocated for the draft; the snapshot and record are keyed by it. */
  threadId: ThreadId,
  project: Schema.Struct({
    /** The project's id on whichever environment it lives on; recorded, never looked up. */
    id: ProjectId,
    title: TrimmedNonEmptyString,
    /** A github.com remote; the sandbox clones from it, so the project may live on any machine. */
    remoteUrl: TrimmedNonEmptyString,
    /** Branch to clone; omitted clones the default branch. */
    baseRef: Schema.optional(TrimmedNonEmptyString),
    /**
     * The same repository's project on this server, whose env files are copied. Absent when this
     * server has no copy; the server checks it names one of its own projects.
     */
    hostCopy: Schema.optional(
      Schema.Struct({ projectId: ProjectId, workspaceRoot: TrimmedNonEmptyString }),
    ),
  }),
  message: Schema.optional(SandboxLaunchMessage),
});
export type SandboxLaunchInput = typeof SandboxLaunchInput.Type;

export const SandboxLaunchResult = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  /** The host thread that holds the chat, with its first message queued, when one was sent. */
  hostThread: Schema.optional(Schema.Struct({ threadId: ThreadId, projectId: ProjectId })),
});
export type SandboxLaunchResult = typeof SandboxLaunchResult.Type;

export const SandboxLaunchThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type SandboxLaunchThreadInput = typeof SandboxLaunchThreadInput.Type;

export const SandboxLaunchStreamEvent = Schema.NullOr(SandboxSetupSnapshot);
export type SandboxLaunchStreamEvent = typeof SandboxLaunchStreamEvent.Type;

/** The provider instance that drives sandbox threads from the host, and its one model. */
export const SANDBOX_BRIDGE_INSTANCE_ID = "sandboxes";
export const SANDBOX_BRIDGE_MODEL = "sandbox";
/** The Pi provider instance a sandbox's T3 runs, and Pi's provider id for the hub's models. */
export const SANDBOX_PI_INSTANCE_ID = "pi";
export const SANDBOX_PI_PROVIDER = "hub";
/** The Pi model slug T3 uses for a hub model id, such as `hub/wafer/GLM-5.3`. */
export const sandboxPiModelSlug = (model: string) => `${SANDBOX_PI_PROVIDER}/${model}`;
/** The host's prompt `_meta` key naming the T3 message, so the bridge reuses its id on the sandbox. */
export const SANDBOX_BRIDGE_MESSAGE_META = "t3code/message";
/**
 * The host's `session/cancel` `_meta` key when it cancels a sandbox prompt only to send a newer
 * message (a steer), not for the user's Stop; the bridge then leaves the sandbox's run working.
 */
export const SANDBOX_BRIDGE_CANCEL_META = "t3code/cancel";
export const SANDBOX_BRIDGE_STEER_CANCEL = "steer";
/** The bridge's ACP notification that its open approval or question was answered on the sandbox. */
export const SANDBOX_BRIDGE_WITHDRAW_METHOD = "_t3code/sandbox_requests_withdrawn";

/**
 * Provider instances T3 seeds and runs for itself, like the sandbox bridge. They work wherever a
 * thread already uses one, but nobody picks them: Settings and model pickers leave them out.
 */
export const isInternalProviderInstance = (instanceId: string): boolean =>
  instanceId === SANDBOX_BRIDGE_INSTANCE_ID;

/** Why a sandbox chat refuses another provider: it would run on this computer, with no sandbox. */
export const SANDBOX_BRIDGE_SWITCH_REFUSAL =
  "This chat runs on a sandbox, so it keeps the sandbox's agent. Pick a model from the sandbox's list, or start a new chat to work on this computer.";

/** Whether a selection would move a thread that runs through the sandbox bridge off it. */
export const leavesSandboxBridge = (
  current: { readonly instanceId: string },
  next: { readonly instanceId: string } | undefined,
): boolean =>
  current.instanceId === SANDBOX_BRIDGE_INSTANCE_ID &&
  next !== undefined &&
  next.instanceId !== SANDBOX_BRIDGE_INSTANCE_ID;
/** Lightweight host projects for sandbox threads live under this folder of the server's home. */
export const SANDBOX_HOST_PROJECTS_FOLDER = "sandbox-projects";

/** Whether a host project is a folder T3 made only to hold sandbox threads; it has no checkout. */
export const isSandboxHostProjectRoot = (workspaceRoot: string): boolean =>
  /[\\/]sandbox-projects[\\/][^\\/]+[\\/][^\\/]+[\\/]?$/u.test(workspaceRoot);

export const SandboxLinkHostThreadResult = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  /** Where the thread goes on this server: the repository's own copy, or a lightweight project. */
  hostProjectId: ProjectId,
  /** True when T3 made the project only for sandbox threads; it has no checkout. */
  lightweightProject: Schema.Boolean,
  /** What the host thread sends with: the sandbox bridge's instance and its one model. */
  modelSelection: ModelSelection,
});
export type SandboxLinkHostThreadResult = typeof SandboxLinkHostThreadResult.Type;

export const SandboxLaunchCancelResult = Schema.Struct({
  cancelled: Schema.Boolean,
});
export type SandboxLaunchCancelResult = typeof SandboxLaunchCancelResult.Type;

/** What the client needs to pair with a launched sandbox and open the thread's project there. */
export const SandboxLaunchPairResult = Schema.Struct({
  environmentId: EnvironmentId,
  httpBaseUrl: TrimmedNonEmptyString,
  pairingCode: TrimmedNonEmptyString,
  /** The project `t3 project add` registered for the clone on the sandbox. */
  projectId: ProjectId,
});
export type SandboxLaunchPairResult = typeof SandboxLaunchPairResult.Type;

export const SandboxSettings = Schema.Struct({
  apiKey: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  /** Values for the driver's `settingsFields`. Not secret, so they stay in plain settings. */
  settings: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type SandboxSettings = typeof SandboxSettings.Type;

export const DEFAULT_SANDBOX_TAILSCALE_TAG = "tag:t3-sandbox";

/**
 * The Tailscale OAuth client sandboxes join the tailnet with. The secret stays on the server; each
 * sandbox gets only a single-use key minted from it.
 */
export const SandboxTailscaleSettings = Schema.Struct({
  clientId: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  clientSecret: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  tag: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SANDBOX_TAILSCALE_TAG)),
  ),
});
export type SandboxTailscaleSettings = typeof SandboxTailscaleSettings.Type;

/** A Tailscale OAuth client secret reads `tskey-client-<clientId>-<secret>`. */
export const tailscaleClientIdFromSecret = (secret: string): string | null =>
  /^tskey-client-([A-Za-z0-9]+)-\S+$/u.exec(secret.trim())?.[1] ?? null;

/** The OAuth scopes T3 needs: minting device keys and removing the devices it made. */
export const SANDBOX_TAILSCALE_SCOPES = [
  { id: "devices:core", label: "Devices → Core" },
  { id: "auth_keys", label: "Keys → Auth Keys" },
] as const;

export const SandboxTailscaleCheckInput = Schema.Struct({
  clientSecret: TrimmedNonEmptyString,
  /** Only needed when the secret does not carry it. */
  clientId: Schema.optional(TrimmedNonEmptyString),
  /** The tag sandboxes join with; the default tag when omitted. */
  tag: Schema.optional(TrimmedNonEmptyString),
});
export type SandboxTailscaleCheckInput = typeof SandboxTailscaleCheckInput.Type;

export const SandboxTailscaleCheckResult = Schema.Struct({
  /** The ID to save with the secret; empty when it could not be read. */
  clientId: TrimmedString,
  scopes: Schema.Array(Schema.String),
  /** Why the client cannot be used, for the user; null when it can. */
  problem: Schema.NullOr(Schema.String),
});
export type SandboxTailscaleCheckResult = typeof SandboxTailscaleCheckResult.Type;

/**
 * What sandboxes get credentials from besides the provider key. Each secret stays on this server:
 * the GitHub App's key, the Maple admin key and the Railway token only mint per-sandbox
 * credentials, and the Northflank token is the one credential every sandbox shares.
 */
export const SandboxToolingSettings = Schema.Struct({
  githubAppId: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  githubAppSlug: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  githubAppOwner: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  githubAppPrivateKey: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  northflankToken: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  mapleAdminKey: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  /** A Railway workspace (or account) token that mints a token per sandbox in `railwayWorkspaceId`. */
  railwayToken: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  railwayWorkspaceId: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  railwayWorkspaceName: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type SandboxToolingSettings = typeof SandboxToolingSettings.Type;

/** The repository permissions the sandboxes' GitHub App asks for. */
const SANDBOX_GITHUB_APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
  // So an agent can read how CI went on the pull requests it opens.
  checks: "read",
  statuses: "read",
  actions: "read",
  // A push that changes `.github/workflows/` needs it, or GitHub refuses the push.
  workflows: "write",
} as const;

/** The sandboxes' GitHub App's homepage on github.com. */
export const SANDBOX_GITHUB_APP_HOMEPAGE = "https://github.com/OmarAlex24/t3code";

/** Where GitHub sends a client with no web address of its own; the user pastes it back. */
export const SANDBOX_GITHUB_APP_PASTE_REDIRECT_URL = "http://127.0.0.1/t3-sandbox-github-app";

/**
 * The server page that posts the manifest to GitHub, for clients that can only open a URL in the
 * user's browser (the desktop app). Takes the client's `state`.
 */
export const SANDBOX_GITHUB_APP_NEW_ROUTE = "/api/sandbox/github-app/new";

/**
 * The manifest that creates the sandboxes' GitHub App in one step on github.com. Private, with no
 * webhook; `redirectUrl` receives the code the server turns into the app.
 */
export const sandboxGithubAppManifest = (input: {
  readonly redirectUrl: string;
  readonly homepageUrl: string;
}) => ({
  name: "T3 Code sandboxes",
  url: input.homepageUrl,
  redirect_url: input.redirectUrl,
  description:
    "Gives each T3 Code sandbox an hour-long token for every repository this app is installed on.",
  public: false,
  default_permissions: SANDBOX_GITHUB_APP_PERMISSIONS,
});

export const SandboxConnectGithubAppInput = Schema.Struct({
  /** The one-time code GitHub sent back to the manifest's redirect URL. */
  code: TrimmedNonEmptyString,
});
export type SandboxConnectGithubAppInput = typeof SandboxConnectGithubAppInput.Type;

export const SandboxConnectGithubAppResult = Schema.Struct({
  slug: TrimmedString,
  owner: TrimmedString,
  /** Where the user installs the app on the repositories sandboxes may use. */
  installUrl: TrimmedString,
});
export type SandboxConnectGithubAppResult = typeof SandboxConnectGithubAppResult.Type;

/**
 * A Railway token to save for sandboxes. Without `workspaceId` the server asks Railway which
 * workspaces the token reaches and saves it when there is exactly one.
 */
export const SandboxConnectRailwayInput = Schema.Struct({
  token: TrimmedNonEmptyString,
  workspaceId: Schema.optional(TrimmedNonEmptyString),
});
export type SandboxConnectRailwayInput = typeof SandboxConnectRailwayInput.Type;

export const SandboxRailwayWorkspace = Schema.Struct({ id: TrimmedString, name: TrimmedString });
export type SandboxRailwayWorkspace = typeof SandboxRailwayWorkspace.Type;

export const SandboxConnectRailwayResult = Schema.Struct({
  /** The workspace the token was saved for; absent when nothing was saved. */
  saved: Schema.optionalKey(SandboxRailwayWorkspace),
  /** The workspaces to pick from when the token reaches more than one. */
  workspaces: Schema.Array(SandboxRailwayWorkspace),
  /** Why nothing was saved, for the user; null when it was. */
  problem: Schema.NullOr(Schema.String),
});
export type SandboxConnectRailwayResult = typeof SandboxConnectRailwayResult.Type;

export const SandboxServerSettingsFields = {
  // Sandbox provider API keys, only read by the server that provisions the sandbox.
  sandboxProviders: Schema.Record(Schema.String, SandboxSettings).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sandboxTailscale: SandboxTailscaleSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sandboxTooling: SandboxToolingSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
};

export const SandboxServerSettingsPatchFields = {
  /** Merges per provider; a redaction marker retains the saved key, an empty key removes it. */
  sandboxProviders: Schema.optionalKey(Schema.Record(Schema.String, SandboxSettings)),
  /** Merges per field; a redaction marker retains the saved secret, an empty one removes it. */
  sandboxTailscale: Schema.optionalKey(
    Schema.Struct({
      clientId: Schema.optionalKey(TrimmedString),
      clientSecret: Schema.optionalKey(TrimmedString),
      tag: Schema.optionalKey(TrimmedString),
    }),
  ),
  /** Merges per field; a redaction marker retains a saved secret, an empty one removes it. */
  sandboxTooling: Schema.optionalKey(
    Schema.Struct({
      githubAppId: Schema.optionalKey(TrimmedString),
      githubAppSlug: Schema.optionalKey(TrimmedString),
      githubAppOwner: Schema.optionalKey(TrimmedString),
      githubAppPrivateKey: Schema.optionalKey(TrimmedString),
      northflankToken: Schema.optionalKey(TrimmedString),
      mapleAdminKey: Schema.optionalKey(TrimmedString),
      railwayToken: Schema.optionalKey(TrimmedString),
      railwayWorkspaceId: Schema.optionalKey(TrimmedString),
      railwayWorkspaceName: Schema.optionalKey(TrimmedString),
    }),
  ),
};
