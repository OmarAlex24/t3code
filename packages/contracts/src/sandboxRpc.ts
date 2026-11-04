import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthSettingsWriteScope, EnvironmentAuthorizationError } from "./auth.ts";
import {
  SandboxCreateInput,
  SandboxCreateResult,
  SandboxCredentialEnvironmentsInput,
  SandboxCredentialEnvironmentsResult,
  SandboxDeleteInput,
  SandboxDeleteResult,
  SandboxDeleteTemplateInput,
  SandboxExtendInput,
  SandboxExtendResult,
  SandboxLifecycleInput,
  SandboxLimitsInput,
  SandboxLimitsResult,
  SandboxListResult,
  SandboxProviderError,
  SandboxProvidersResult,
  SandboxResumeResult,
  SandboxSaveTemplateInput,
  SandboxSaveTemplateResult,
  SandboxStopResult,
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
  sandboxesExtend: "sandboxes.extend",
  sandboxesTemplates: "sandboxes.templates",
  sandboxesSaveTemplate: "sandboxes.saveTemplate",
  sandboxesDeleteTemplate: "sandboxes.deleteTemplate",
} as const;

const WsSandboxesProvidersRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesProviders, {
  payload: Schema.Void,
  success: SandboxProvidersResult,
  error: EnvironmentAuthorizationError,
});

const WsSandboxesEnvironmentsRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesEnvironments, {
  payload: SandboxCredentialEnvironmentsInput,
  success: SandboxCredentialEnvironmentsResult,
  error: Schema.Union([SandboxProviderError, EnvironmentAuthorizationError]),
});

const WsSandboxesLimitsRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesLimits, {
  payload: SandboxLimitsInput,
  success: SandboxLimitsResult,
  error: Schema.Union([SandboxProviderError, EnvironmentAuthorizationError]),
});

const WsSandboxesListRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesList, {
  payload: Schema.Void,
  success: SandboxListResult,
  error: Schema.Union([SandboxProviderError, EnvironmentAuthorizationError]),
});

const WsSandboxesStopRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesStop, {
  payload: SandboxLifecycleInput,
  success: SandboxStopResult,
  error: Schema.Union([SandboxProviderError, EnvironmentAuthorizationError]),
});

const WsSandboxesResumeRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesResume, {
  payload: SandboxLifecycleInput,
  success: SandboxResumeResult,
  error: Schema.Union([SandboxProviderError, EnvironmentAuthorizationError]),
});

const WsSandboxesExtendRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesExtend, {
  payload: SandboxExtendInput,
  success: SandboxExtendResult,
  error: Schema.Union([SandboxProviderError, EnvironmentAuthorizationError]),
});

const WsSandboxesTemplatesRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesTemplates, {
  payload: SandboxTemplatesInput,
  success: SandboxTemplatesResult,
  error: Schema.Union([SandboxProviderError, EnvironmentAuthorizationError]),
});

const WsSandboxesSaveTemplateRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesSaveTemplate, {
  payload: SandboxSaveTemplateInput,
  success: SandboxSaveTemplateResult,
  error: Schema.Union([SandboxProviderError, EnvironmentAuthorizationError]),
});

const WsSandboxesDeleteTemplateRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesDeleteTemplate, {
  payload: SandboxDeleteTemplateInput,
  success: Schema.Void,
  error: Schema.Union([SandboxProviderError, EnvironmentAuthorizationError]),
});

const WsSandboxesCreateRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesCreate, {
  payload: SandboxCreateInput,
  success: SandboxCreateResult,
  error: Schema.Union([SandboxProviderError, EnvironmentAuthorizationError]),
});

const WsSandboxesDeleteRpc = Rpc.make(SANDBOX_WS_METHODS.sandboxesDelete, {
  payload: SandboxDeleteInput,
  success: SandboxDeleteResult,
  error: Schema.Union([SandboxProviderError, EnvironmentAuthorizationError]),
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
  WsSandboxesExtendRpc,
  WsSandboxesTemplatesRpc,
  WsSandboxesSaveTemplateRpc,
  WsSandboxesDeleteTemplateRpc,
] as const;

export const SANDBOX_CLIENT_GUARDED_RPC_SCOPES = {
  // Creates a billable machine with the saved provider key.
  [SANDBOX_WS_METHODS.sandboxesCreate]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesDelete]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesStop]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesResume]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesExtend]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesSaveTemplate]: AuthSettingsWriteScope,
  [SANDBOX_WS_METHODS.sandboxesDeleteTemplate]: AuthSettingsWriteScope,
} as const;
