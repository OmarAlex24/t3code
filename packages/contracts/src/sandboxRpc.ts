import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthSettingsWriteScope, EnvironmentAuthorizationError } from "./auth.ts";
import {
  SandboxCheckWorkResult,
  SandboxConfigsResult,
  SandboxConnectGithubAppInput,
  SandboxConnectGithubAppResult,
  SandboxCreateInput,
  SandboxCreateResult,
  SandboxCredentialEnvironmentsInput,
  SandboxCredentialEnvironmentsResult,
  SandboxDeleteConfigInput,
  SandboxDeleteInput,
  SandboxDeleteResult,
  SandboxDeleteTemplateInput,
  SandboxLaunchCancelResult,
  SandboxLaunchInput,
  SandboxLaunchPairResult,
  SandboxLaunchResult,
  SandboxLaunchStreamEvent,
  SandboxLaunchThreadInput,
  SandboxLifecycleInput,
  SandboxLimitsInput,
  SandboxLimitsResult,
  SandboxLinkHostThreadResult,
  SandboxListResult,
  SandboxProviderError,
  SandboxProvidersResult,
  SandboxResumeResult,
  SandboxSaveConfigInput,
  SandboxSaveConfigResult,
  SandboxSaveTemplateInput,
  SandboxSaveTemplateResult,
  SandboxStopResult,
  SandboxTailscaleCheckInput,
  SandboxTailscaleCheckResult,
  SandboxTemplatesInput,
  SandboxTemplatesResult,
} from "./sandbox.ts";

export const SANDBOX_WS_METHODS = {
  sandboxesProviders: "sandboxes.providers",
  sandboxesEnvironments: "sandboxes.environments",
  sandboxesLimits: "sandboxes.limits",
  sandboxesCreate: "sandboxes.create",
  sandboxesDelete: "sandboxes.delete",
  sandboxesList: "sandboxes.list",
  sandboxesStop: "sandboxes.stop",
  sandboxesResume: "sandboxes.resume",
  sandboxesCheckWork: "sandboxes.checkWork",
  sandboxesTemplates: "sandboxes.templates",
  sandboxesSaveTemplate: "sandboxes.saveTemplate",
  sandboxesDeleteTemplate: "sandboxes.deleteTemplate",
  sandboxesConfigs: "sandboxes.configs",
  sandboxesSaveConfig: "sandboxes.saveConfig",
  sandboxesDeleteConfig: "sandboxes.deleteConfig",
  sandboxesLaunch: "sandboxes.launch",
  sandboxesSubscribeLaunch: "sandboxes.subscribeLaunch",
  sandboxesCancelLaunch: "sandboxes.cancelLaunch",
  sandboxesRetryLaunch: "sandboxes.retryLaunch",
  sandboxesPairLaunch: "sandboxes.pairLaunch",
  sandboxesCompleteLaunch: "sandboxes.completeLaunch",
  sandboxesCheckTailscale: "sandboxes.checkTailscale",
  sandboxesLinkHostThread: "sandboxes.linkHostThread",
  sandboxesConnectGithubApp: "sandboxes.connectGithubApp",
} as const;

const SandboxFailure = Schema.Union([SandboxProviderError, EnvironmentAuthorizationError]);

const WsSandboxesProvidersRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesProviders, {
  payload: Schema.Void,
  success: SandboxProvidersResult,
  error: EnvironmentAuthorizationError,
});

const WsSandboxesEnvironmentsRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesEnvironments, {
  payload: SandboxCredentialEnvironmentsInput,
  success: SandboxCredentialEnvironmentsResult,
  error: SandboxFailure,
});

const WsSandboxesLimitsRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesLimits, {
  payload: SandboxLimitsInput,
  success: SandboxLimitsResult,
  error: SandboxFailure,
});

const WsSandboxesListRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesList, {
  payload: Schema.Void,
  success: SandboxListResult,
  error: SandboxFailure,
});

const WsSandboxesStopRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesStop, {
  payload: SandboxLifecycleInput,
  success: SandboxStopResult,
  error: SandboxFailure,
});

// Runs a fixed git check on the sandbox; never a failure, since `unknown` says why it could not.
const WsSandboxesCheckWorkRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesCheckWork, {
  payload: SandboxLifecycleInput,
  success: SandboxCheckWorkResult,
  error: SandboxFailure,
});

const WsSandboxesResumeRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesResume, {
  payload: SandboxLifecycleInput,
  success: SandboxResumeResult,
  error: SandboxFailure,
});

const WsSandboxesTemplatesRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesTemplates, {
  payload: SandboxTemplatesInput,
  success: SandboxTemplatesResult,
  error: SandboxFailure,
});

const WsSandboxesSaveTemplateRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesSaveTemplate, {
  payload: SandboxSaveTemplateInput,
  success: SandboxSaveTemplateResult,
  error: SandboxFailure,
});

const WsSandboxesDeleteTemplateRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesDeleteTemplate, {
  payload: SandboxDeleteTemplateInput,
  success: Schema.Void,
  error: SandboxFailure,
});

const WsSandboxesCreateRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesCreate, {
  payload: SandboxCreateInput,
  success: SandboxCreateResult,
  error: SandboxFailure,
});

const WsSandboxesDeleteRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesDelete, {
  payload: SandboxDeleteInput,
  success: SandboxDeleteResult,
  error: SandboxFailure,
});

const WsSandboxesConfigsRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesConfigs, {
  payload: Schema.Void,
  success: SandboxConfigsResult,
  error: SandboxFailure,
});

const WsSandboxesSaveConfigRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesSaveConfig, {
  payload: SandboxSaveConfigInput,
  success: SandboxSaveConfigResult,
  error: SandboxFailure,
});

const WsSandboxesDeleteConfigRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesDeleteConfig, {
  payload: SandboxDeleteConfigInput,
  success: Schema.Void,
  error: SandboxFailure,
});

const WsSandboxesLaunchRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesLaunch, {
  payload: SandboxLaunchInput,
  success: SandboxLaunchResult,
  error: SandboxFailure,
});

const WsSandboxesSubscribeLaunchRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesSubscribeLaunch, {
  payload: SandboxLaunchThreadInput,
  success: SandboxLaunchStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSandboxesCancelLaunchRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesCancelLaunch, {
  payload: SandboxLaunchThreadInput,
  success: SandboxLaunchCancelResult,
  error: EnvironmentAuthorizationError,
});

const WsSandboxesRetryLaunchRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesRetryLaunch, {
  payload: SandboxLaunchThreadInput,
  success: Schema.Void,
  error: SandboxFailure,
});

const WsSandboxesPairLaunchRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesPairLaunch, {
  payload: SandboxLaunchThreadInput,
  success: SandboxLaunchPairResult,
  error: SandboxFailure,
});

const WsSandboxesCompleteLaunchRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesCompleteLaunch, {
  payload: SandboxLaunchThreadInput,
  success: Schema.Void,
  error: SandboxFailure,
});

// The secret only signs in; nothing is saved, so a wrong one changes nothing.
const WsSandboxesCheckTailscaleRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesCheckTailscale, {
  payload: SandboxTailscaleCheckInput,
  success: SandboxTailscaleCheckResult,
  error: EnvironmentAuthorizationError,
});

// Readies the sandbox bridge for a launched thread so the phone can drive it through this server.
const WsSandboxesLinkHostThreadRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesLinkHostThread, {
  payload: SandboxLaunchThreadInput,
  success: SandboxLinkHostThreadResult,
  error: SandboxFailure,
});

// Turns the manifest flow's code into the sandboxes' GitHub App and saves its key on this server.
const WsSandboxesConnectGithubAppRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesConnectGithubApp, {
  payload: SandboxConnectGithubAppInput,
  success: SandboxConnectGithubAppResult,
  error: SandboxFailure,
});

export const SandboxRpcs = [
  WsSandboxesProvidersRpc,
  WsSandboxesEnvironmentsRpc,
  WsSandboxesLimitsRpc,
  WsSandboxesCreateRpc,
  WsSandboxesDeleteRpc,
  WsSandboxesListRpc,
  WsSandboxesStopRpc,
  WsSandboxesResumeRpc,
  WsSandboxesCheckWorkRpc,
  WsSandboxesTemplatesRpc,
  WsSandboxesSaveTemplateRpc,
  WsSandboxesDeleteTemplateRpc,
  WsSandboxesConfigsRpc,
  WsSandboxesSaveConfigRpc,
  WsSandboxesDeleteConfigRpc,
  WsSandboxesLaunchRpc,
  WsSandboxesSubscribeLaunchRpc,
  WsSandboxesCancelLaunchRpc,
  WsSandboxesRetryLaunchRpc,
  WsSandboxesPairLaunchRpc,
  WsSandboxesCompleteLaunchRpc,
  WsSandboxesCheckTailscaleRpc,
  WsSandboxesLinkHostThreadRpc,
  WsSandboxesConnectGithubAppRpc,
] as const;

// Each of these spends the saved provider key, changes billable machines, or hands out a pairing
// code for one.
export const SANDBOX_CLIENT_GUARDED_RPC_SCOPES = {
  [SANDBOX_WS_METHODS.sandboxesCreate]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesDelete]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesStop]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesResume]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesCheckWork]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesSaveTemplate]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesDeleteTemplate]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesSaveConfig]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesDeleteConfig]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesLaunch]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesCancelLaunch]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesRetryLaunch]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesPairLaunch]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesCompleteLaunch]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesCheckTailscale]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesLinkHostThread]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesConnectGithubApp]: AuthSettingsWriteScope,
} as const;
