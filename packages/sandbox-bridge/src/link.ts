import { ProjectId, ThreadId, TrimmedNonEmptyString, TrimmedString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * What the bridge needs to reach one thread's sandbox. The host writes it as a server secret, since
 * it carries the bearer token minted on the sandbox; the bridge reads it again before every turn,
 * so a resumed sandbox's new address is picked up.
 */
export const SandboxBridgeLink = Schema.Struct({
  threadId: ThreadId,
  instanceId: TrimmedNonEmptyString,
  sandboxId: TrimmedString,
  label: TrimmedString,
  httpBaseUrl: TrimmedNonEmptyString,
  sandboxProjectId: ProjectId,
  token: TrimmedNonEmptyString,
});
export type SandboxBridgeLink = typeof SandboxBridgeLink.Type;

export const SandboxBridgeLinkJson = Schema.fromJsonString(SandboxBridgeLink);

/** Thread ids are free text, so the secret's file name carries them hex-encoded. */
export const bridgeLinkSecretName = (threadId: string): string =>
  `sandbox-bridge-${Array.from(new TextEncoder().encode(threadId), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;

/** Names the host's secrets directory for the bridge process; set on the provider instance. */
export const SANDBOX_BRIDGE_SECRETS_DIR_ENV = "T3_SANDBOX_BRIDGE_SECRETS_DIR";
