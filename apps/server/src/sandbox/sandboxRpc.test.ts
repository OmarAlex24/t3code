import { AuthOrchestrationReadScope, AuthSettingsWriteScope, WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";

it("lets read-only clients see sandbox limits but keeps starting machines behind settings", () => {
  for (const method of [
    WS_METHODS.sandboxesProviders,
    WS_METHODS.sandboxesEnvironments,
    WS_METHODS.sandboxesLimits,
    WS_METHODS.sandboxesTemplates,
    WS_METHODS.sandboxesList,
  ]) {
    expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
  }
  for (const method of [
    WS_METHODS.sandboxesCreate,
    WS_METHODS.sandboxesResume,
    WS_METHODS.sandboxesExtend,
    WS_METHODS.sandboxesSaveTemplate,
    WS_METHODS.sandboxesDeleteTemplate,
    WS_METHODS.sandboxesStop,
    WS_METHODS.sandboxesDelete,
  ]) {
    expect(requiredScopeForRpcMethod(method)).toBe(AuthSettingsWriteScope);
  }
});
