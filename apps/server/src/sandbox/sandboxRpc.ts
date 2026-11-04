import { AuthOrchestrationReadScope, AuthSettingsWriteScope, WS_METHODS } from "@t3tools/contracts";

// Creating or deleting a sandbox spends the saved provider key and changes billable machines.
export const SANDBOX_RPC_REQUIRED_SCOPES = {
  [WS_METHODS.sandboxesProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.sandboxesEnvironments]: AuthOrchestrationReadScope,
  [WS_METHODS.sandboxesLimits]: AuthOrchestrationReadScope,
  [WS_METHODS.sandboxesCreate]: AuthSettingsWriteScope,
  [WS_METHODS.sandboxesDelete]: AuthSettingsWriteScope,
  [WS_METHODS.sandboxesList]: AuthOrchestrationReadScope,
  [WS_METHODS.sandboxesStop]: AuthSettingsWriteScope,
  [WS_METHODS.sandboxesResume]: AuthSettingsWriteScope,
  [WS_METHODS.sandboxesExtend]: AuthSettingsWriteScope,
  [WS_METHODS.sandboxesTemplates]: AuthOrchestrationReadScope,
  [WS_METHODS.sandboxesSaveTemplate]: AuthSettingsWriteScope,
  [WS_METHODS.sandboxesDeleteTemplate]: AuthSettingsWriteScope,
} as const;

export const SANDBOX_RPC_AGGREGATES = {
  [WS_METHODS.sandboxesProviders]: "environments",
  [WS_METHODS.sandboxesEnvironments]: "environments",
  [WS_METHODS.sandboxesLimits]: "environments",
  [WS_METHODS.sandboxesCreate]: "environments",
  [WS_METHODS.sandboxesDelete]: "environments",
  [WS_METHODS.sandboxesList]: "environments",
  [WS_METHODS.sandboxesStop]: "environments",
  [WS_METHODS.sandboxesResume]: "environments",
  [WS_METHODS.sandboxesExtend]: "environments",
  [WS_METHODS.sandboxesTemplates]: "environments",
  [WS_METHODS.sandboxesSaveTemplate]: "environments",
  [WS_METHODS.sandboxesDeleteTemplate]: "environments",
} as const;
