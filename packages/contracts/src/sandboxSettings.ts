import type { ServerSettings } from "./settings.ts";

/**
 * Server settings a sandbox takes from the server that provisioned it: copied into its
 * `settings.json` before `t3 serve`, and repeated on it when the host saves one through Settings.
 * Any setting not listed stays on the host, so a new one never carries a secret or host path to a
 * sandbox until someone decides it is safe to follow.
 */
export const SANDBOX_FOLLOWED_SERVER_SETTING_KEYS = [
  "favorites",
  "providerModelPreferences",
  "worktreeCleanup",
  "storageCleanup",
  "responseStreamingMode",
  "enableProviderUpdateChecks",
  "continueThreadsAfterServerUpdate",
  "enableAgentBrowserAccess",
  "speechProjectCustomWords",
  "defaultAutoPull",
  "defaultProjectScripts",
  "defaultRuntimeMode",
  "sidebarAutoSettleAfterDays",
  "compactIdleThreads",
  "idleCompaction",
  "snoozeLimitedThreads",
  "autoResumeLimitedThreads",
  "snoozePresets",
  "hiddenThreadTags",
  "hideTaggedThreads",
  "promptSuggestionsEnabled",
  "sidebarAutoSettleKeepPullRequests",
  "sidebarAutoSettleOnMerge",
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "backgroundActivityProfile",
  "defaultTheme",
  "defaultThemeSetAt",
  "defaultAppearance",
  "defaultAppearanceSetAt",
  "newWorktreesStartFromOrigin",
  "worktreeSubmodules",
  "ghqCloneLayout",
  "textGenerationModelSelection",
  "threadTitleInstructions",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
  "removeAgentCreditsOnMerge",
  "sourceControlWritingStyle",
  "sourceControlWriterModelSelection",
  "reviewGuidesEnabled",
  "reviewGuideModelSelection",
  "reviewGuideInstructions",
  "pullRequestMergeMethod",
  "usageHistoryRetentionDays",
  "usagePriceOverrides",
  "usageModelAliases",
  "usageModelFilter",
  "offeredSourceControlProviders",
] as const satisfies ReadonlyArray<keyof ServerSettings>;

export type SandboxFollowedServerSettingKey = (typeof SANDBOX_FOLLOWED_SERVER_SETTING_KEYS)[number];

const FOLLOWED: ReadonlySet<string> = new Set(SANDBOX_FOLLOWED_SERVER_SETTING_KEYS);

export function isSandboxFollowedServerSettingKey(
  key: string,
): key is SandboxFollowedServerSettingKey {
  return FOLLOWED.has(key);
}

/** The part of a settings object or patch a sandbox follows. */
export function pickSandboxFollowedSettings<T extends object>(settings: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(settings).filter(([key]) => FOLLOWED.has(key)),
  ) as Partial<T>;
}
