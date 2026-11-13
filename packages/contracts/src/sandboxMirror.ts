import * as Schema from "effect/Schema";

import { MessageId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
} from "./orchestrationV2.ts";
import { ServerProvider } from "./server.ts";

/** A sandbox chat's host mirror thread; the sandbox's own thread has the same id. */
export const SandboxThreadMirrorInput = Schema.Struct({ threadId: ThreadId });
export type SandboxThreadMirrorInput = typeof SandboxThreadMirrorInput.Type;

/**
 * What the host reads of a sandbox chat's own thread for a client of the host: its provider (with
 * the models a picker offers) and selection, and its agents and delegated tasks. While the sandbox
 * is stopped or not answering, `available` is false and the rest is what the host last read.
 * `runs` holds only the runs the agents' turn is told from.
 */
export const SandboxThreadMirror = Schema.Struct({
  available: Schema.Boolean,
  provider: Schema.NullOr(ServerProvider),
  modelSelection: Schema.NullOr(ModelSelection),
  runs: Schema.Array(OrchestrationV2Run),
  subagents: Schema.Array(OrchestrationV2Subagent),
});
export type SandboxThreadMirror = typeof SandboxThreadMirror.Type;

export const SandboxMirrorChildInput = Schema.Struct({
  threadId: ThreadId,
  childThreadId: ThreadId,
});
export type SandboxMirrorChildInput = typeof SandboxMirrorChildInput.Type;

export const SandboxMirrorChildMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationV2ConversationMessage.fields.role,
  text: Schema.String,
  createdAt: Schema.DateTimeUtc,
});
export type SandboxMirrorChildMessage = typeof SandboxMirrorChildMessage.Type;

/** An agent's thread on the sandbox, read through the host; no messages while it is unreachable. */
export const SandboxMirrorChild = Schema.Struct({
  available: Schema.Boolean,
  messages: Schema.Array(SandboxMirrorChildMessage),
});
export type SandboxMirrorChild = typeof SandboxMirrorChild.Type;

/** A pick from the mirror's picker, on the bridge's instance as the mirror carries it. */
export const SandboxSetThreadModelInput = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
});
export type SandboxSetThreadModelInput = typeof SandboxSetThreadModelInput.Type;

/** False when the sandbox could not take it now; the bridge hands it over with the next message. */
export const SandboxSetThreadModelResult = Schema.Struct({ sandboxUpdated: Schema.Boolean });
export type SandboxSetThreadModelResult = typeof SandboxSetThreadModelResult.Type;
