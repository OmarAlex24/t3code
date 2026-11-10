import type { ServerSettings } from "./settings.ts";

/**
 * Server settings a sandbox takes from the server that provisioned it: copied into its
 * `settings.json` before `t3 serve`, and repeated on it when the host saves one through Settings.
 * Every server setting is in this list or in `SANDBOX_HOST_ONLY_SERVER_SETTING_KEYS`, so a new
 * setting stays on the host until someone decides it is safe to follow.
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
  "usagePriceOverrides",
  "usageModelAliases",
  "usageModelFilter",
] as const satisfies ReadonlyArray<keyof ServerSettings>;

/** Settings that never leave the host, grouped by why. */
export const SANDBOX_HOST_ONLY_SERVER_SETTING_KEYS = [
  // Secrets, credentials, and secret references.
  "cloudSpeechCredentials",
  "providerInstances",
  "sourceControlHosts",
  "sandboxProviders",
  "sandboxTailscale",
  "sandboxTooling",
  "usageLimitSources",
  "textGenerators",
  "secretProviders",
  "easDeviceHosts",
  "simlockDeviceHosts",
  "observability",
  // Paths and hardware that exist only on the host.
  "worktreesDirectory",
  "previousWorktreesDirectories",
  "fastWorktreeCheckout",
  "addProjectBaseDirectory",
  "speechModelId",
  "speechAcceleration",
  "speechModelUnloadTimeout",
  "speechPostProcessingModelSelection",
  "deviceHosts",
  "enableAgentDeviceAccess",
  "enableDeviceSupport",
  "deviceOnboardingCompleted",
  "simlockDeviceHostsEnabled",
  // The host machine's identity and its links to other machines and guests.
  "environmentIcon",
  "guestSharingEnabled",
  "linkedEnvironmentsEnabled",
  // Keyed by the host's project ids, which mean nothing on the sandbox.
  "projectSettingsOverrides",
  "projectAgentBrowserAccessOverrides",
  "projectScriptOverrides",
  "projectAutoPullOverrides",
  "projectSettingsFolded",
  // Pi setup sets the sandbox's default model; a config that starts chats on Pi must keep it.
  "defaultModelSelection",
  "fallbackModelSelection",
  // Delete-after-settle checks only the clone for unpushed work, never a worktree.
  "defaultThreadEnvMode",
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
