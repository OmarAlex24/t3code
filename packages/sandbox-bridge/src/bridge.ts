/**
 * The sandbox bridge: an ACP agent the host runs for a thread whose work happens on a sandbox's
 * own T3 server. It forwards each prompt to the thread with the same id on the sandbox, streams
 * the sandbox's text back, and turns the sandbox's approvals and questions into ACP requests, so
 * any client of the host (the phone included) can drive the thread.
 */
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RunId,
  type RuntimeMode,
  type RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as AcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import type { SandboxBridgeLink } from "./link.ts";

export class SandboxBridgeError extends Schema.TaggedError<SandboxBridgeError>()(
  "SandboxBridgeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** The host thread this bridge process serves, read through the host's MCP endpoint. */
export interface HostThread {
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
}

/** The thread-scoped MCP credential the host hands every ACP session. */
export interface HostMcp {
  readonly endpoint: string;
  readonly authorization: string;
}

/** One open connection to a sandbox's T3 server, scoped to a single prompt. */
export interface SandboxSession {
  readonly threadStop: boolean;
  readonly defaultModelSelection: ModelSelection | null;
  /** None when the sandbox has no such thread yet. */
  readonly projection: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationV2ThreadProjection>, SandboxBridgeError>;
  readonly launch: (
    input: OrchestrationV2ThreadLaunchInput,
  ) => Effect.Effect<void, SandboxBridgeError>;
  readonly dispatch: (command: OrchestrationV2Command) => Effect.Effect<void, SandboxBridgeError>;
  readonly subscribe: (
    threadId: ThreadId,
  ) => Stream.Stream<OrchestrationV2ThreadStreamItem, SandboxBridgeError>;
}

export interface SandboxBridgePorts {
  readonly readHostThread: (mcp: HostMcp) => Effect.Effect<HostThread, SandboxBridgeError>;
  readonly findLink: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<SandboxBridgeLink>, SandboxBridgeError>;
  readonly connect: (
    link: SandboxBridgeLink,
  ) => Effect.Effect<SandboxSession, SandboxBridgeError, Scope.Scope>;
  /** How long a turn waits for an unreachable sandbox, such as one the host is resuming. */
  readonly reconnectWindow?: Duration.Input;
  readonly reconnectSpacing?: Duration.Input;
}

export const PROBE_CLIENT_NAME = "t3-code-provider-test";
export const SANDBOX_SESSION_PREFIX = "sandbox:";
const DRY_RUN_SESSION_PREFIX = "sandbox-dry-run:";
const MODEL_OPTION_VALUE = "sandbox";

export const NOT_LINKED_MESSAGE =
  "This thread is not linked to a sandbox. Start it from a sandbox config in T3 Code on your Mac.";
export const SUPERVISED_NOTICE =
  "This thread must stay Supervised for the sandbox's approvals to reach you. Switch it back to Supervised; the request is waiting on the sandbox.";
export const unreachableMessage = (link: SandboxBridgeLink) =>
  `Sandbox ${link.sandboxId || link.label} is stopped or not answering. Resume it from T3 Code on your Mac, then send again.`;
export const waitingThought = (link: SandboxBridgeLink) =>
  `Resuming sandbox ${link.sandboxId || link.label}…`;

const modelConfigOptions: ReadonlyArray<AcpSchema.SessionConfigOption> = [
  {
    configId: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: MODEL_OPTION_VALUE,
    options: [{ value: MODEL_OPTION_VALUE, name: "Sandbox agent" }],
  },
];

const CLAUDE_FALLBACK_MODEL: ModelSelection = {
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
} as ModelSelection;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The host's ACP adapter wraps a prompt in T3 Code's instructions and adds its runtime notes; the
// sandbox's own server adds both again for its agent.
const HOST_INSTRUCTIONS_WRAPPER =
  /^\s*<t3_code_instructions>[\s\S]*?<\/t3_code_instructions>\s*<user_request>\n?([\s\S]*?)\n?<\/user_request>\s*$/u;
const HOST_RUNTIME_NOTES = /^\s*<runtime_info>/u;

/** The text a prompt carries; attachments wait for a later phase. */
export const promptText = (blocks: ReadonlyArray<AcpSchema.ContentBlock>): string =>
  blocks
    .flatMap((block) => {
      switch (block.type) {
        case "text": {
          const text = String(block.text);
          if (HOST_RUNTIME_NOTES.test(text)) return [];
          return [HOST_INSTRUCTIONS_WRAPPER.exec(text)?.[1] ?? text];
        }
        case "resource_link":
          return [block.uri];
        case "resource": {
          const resource: unknown = block.resource;
          return isRecord(resource) && typeof resource.text === "string" ? [resource.text] : [];
        }
        default:
          return [];
      }
    })
    .join("\n\n");

/**
 * Never a read kind: the host's ACP policy allows reads without asking, and every request the
 * sandbox raises needs the user's answer.
 */
export const approvalToolKind = (requestKind: string): AcpSchema.ToolKind =>
  requestKind === "file-change" ? "edit" : "execute";

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow" },
  { decision: "acceptForSession", label: "Allow for this session" },
  { decision: "decline", label: "Decline" },
] as ReadonlyArray<ProviderApprovalOption>;

const ACP_OPTION_KIND: Partial<Record<ProviderApprovalDecision, AcpSchema.PermissionOptionKind>> = {
  accept: "allow_once",
  acceptForSession: "allow_always",
  acceptAlways: "allow_always",
  decline: "reject_once",
};

/** One ACP option per kind, since the host answers by kind; the option id is the T3 decision. */
export const approvalOptions = (
  offered: ReadonlyArray<ProviderApprovalOption> | undefined,
): ReadonlyArray<AcpSchema.PermissionOption> => {
  const options: Array<AcpSchema.PermissionOption> = [];
  for (const option of offered !== undefined && offered.length > 0
    ? offered
    : DEFAULT_APPROVAL_OPTIONS) {
    const kind = ACP_OPTION_KIND[option.decision];
    if (kind === undefined || options.some((existing) => existing.kind === kind)) continue;
    options.push({ optionId: option.decision, name: option.label, kind });
  }
  if (!options.some((option) => option.kind === "reject_once")) {
    options.push({ optionId: "decline", name: "Decline", kind: "reject_once" });
  }
  return options;
};

const DECISIONS: ReadonlySet<string> = new Set([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
]);

/** The T3 decision an ACP permission answer picked, or null when the host cancelled it. */
export const decisionOf = (
  response: AcpSchema.RequestPermissionResponse,
): ProviderApprovalDecision | null =>
  response.outcome.outcome === "selected" &&
  typeof response.outcome.optionId === "string" &&
  DECISIONS.has(response.outcome.optionId)
    ? (response.outcome.optionId as ProviderApprovalDecision)
    : null;

const optionValue = (option: OrchestrationV2UserInputQuestion["options"][number]) =>
  option.value ?? option.label;

/** A form whose fields are the sandbox's questions; option values come back as the answers. */
export const questionForm = (
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
): AcpSchema.ElicitationSchema => ({
  type: "object",
  properties: Object.fromEntries(
    questions.map((question) => [
      question.id,
      {
        type: "string" as const,
        title: question.header,
        description: question.question,
        ...(question.options.length > 0 && question.multiSelect !== true
          ? { enum: question.options.map(optionValue) }
          : {}),
      },
    ]),
  ),
  required: questions.filter((question) => question.required !== false).map((q) => q.id),
});

export const answersOf = (
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  content: unknown,
): Record<string, string | ReadonlyArray<string>> => {
  const answers: Record<string, string | ReadonlyArray<string>> = {};
  for (const question of questions) {
    const value = isRecord(content) ? content[question.id] : undefined;
    if (typeof value === "string") answers[question.id] = value;
    else if (typeof value === "number" || typeof value === "boolean") {
      answers[question.id] = String(value);
    } else if (Array.isArray(value)) {
      answers[question.id] = value.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return answers;
};

const TERMINAL_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const isTerminalRun = (run: OrchestrationV2Run) => TERMINAL_RUN_STATUSES.has(run.status);

type ToolItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "command_execution" | "file_change" | "file_search" | "web_search" }
>;
type ApprovalItem = Extract<OrchestrationV2TurnItem, { readonly type: "approval_request" }>;
type QuestionItem = Extract<OrchestrationV2TurnItem, { readonly type: "user_input_request" }>;

const toolKindOf = (item: ToolItem): AcpSchema.ToolKind => {
  switch (item.type) {
    case "command_execution":
      return "execute";
    case "file_change":
      return "edit";
    case "file_search":
      return "search";
    case "web_search":
      return "fetch";
  }
};

const toolTitleOf = (item: ToolItem): string => {
  switch (item.type) {
    case "command_execution":
      return item.title ?? item.input;
    case "file_change":
      return item.title ?? item.fileName;
    case "file_search":
      return item.title ?? item.pattern ?? "Search files";
    case "web_search":
      return item.title ?? item.patterns?.join(", ") ?? "Search the web";
  }
};

const toolStatusOf = (status: OrchestrationV2TurnItem["status"]): AcpSchema.ToolCallStatus => {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
    case "interrupted":
      return "failed";
    case "running":
    case "waiting":
      return "in_progress";
    default:
      return "pending";
  }
};

export type TurnAction =
  | {
      readonly _tag: "text";
      readonly kind: "message" | "thought";
      readonly id: string;
      readonly text: string;
    }
  | {
      readonly _tag: "tool";
      readonly id: string;
      readonly title: string;
      readonly kind: AcpSchema.ToolKind;
      readonly status: AcpSchema.ToolCallStatus;
    }
  | { readonly _tag: "approval"; readonly item: ApprovalItem }
  | { readonly _tag: "question"; readonly item: QuestionItem };

/**
 * Follows a sandbox thread for one host turn. Text already on the sandbox before the turn counts
 * as sent, so a thread's history is never replayed; anything new on any run is streamed, and the
 * turn ends when the run carrying the forwarded message ends.
 */
export class TurnTracker {
  private readonly runs = new Map<string, OrchestrationV2Run>();
  private readonly items = new Map<string, OrchestrationV2TurnItem>();
  private readonly requests = new Map<string, OrchestrationV2RuntimeRequest>();
  private readonly sent = new Map<string, number>();
  private readonly toolStatus = new Map<string, AcpSchema.ToolCallStatus>();
  private readonly handled = new Set<string>();
  private readonly messageId: MessageId;

  constructor(messageId: MessageId, baseline: Option.Option<OrchestrationV2ThreadProjection>) {
    this.messageId = messageId;
    if (Option.isSome(baseline)) {
      for (const item of baseline.value.turnItems) {
        if (item.type === "assistant_message" || item.type === "reasoning") {
          this.sent.set(item.id, item.text.length);
        } else if (isToolItem(item)) {
          this.toolStatus.set(item.id, toolStatusOf(item.status));
        }
      }
    }
  }

  apply(item: OrchestrationV2ThreadStreamItem): ReadonlyArray<TurnAction> {
    if (item.kind === "snapshot") {
      for (const run of item.projection.runs) this.runs.set(run.id, run);
      for (const request of item.projection.runtimeRequests) this.requests.set(request.id, request);
      for (const turnItem of item.projection.turnItems) this.items.set(turnItem.id, turnItem);
      return this.actionsFor(item.projection.turnItems);
    }
    if (item.kind !== "event") return [];
    const event = item.event;
    switch (event.type) {
      case "run.created":
      case "run.updated":
        this.runs.set(event.payload.id, event.payload);
        return [];
      case "runtime-request.updated":
        this.requests.set(event.payload.id, event.payload);
        return [];
      case "turn-item.updated":
        this.items.set(event.payload.id, event.payload);
        return this.actionsFor([event.payload]);
      default:
        return [];
    }
  }

  /** The run carrying the forwarded message, once the sandbox has made it. */
  get run(): OrchestrationV2Run | undefined {
    for (const run of this.runs.values()) {
      if (run.userMessageId === this.messageId) return run;
    }
    return undefined;
  }

  get done(): boolean {
    const run = this.run;
    return run !== undefined && isTerminalRun(run);
  }

  /** The newest run still working, for an interrupt when the forwarded one is not known yet. */
  get activeRunId(): RunId | undefined {
    return this.run?.id ?? [...this.runs.values()].findLast((run) => !isTerminalRun(run))?.id;
  }

  /** Requests still pending on the sandbox that this turn has not handled. */
  pendingRequests(): ReadonlyArray<TurnAction> {
    return this.actionsFor([...this.items.values()]).filter(
      (action) => action._tag === "approval" || action._tag === "question",
    );
  }

  markHandled(requestId: RuntimeRequestId): void {
    this.handled.add(requestId);
  }

  private isPending(requestId: RuntimeRequestId, status: OrchestrationV2TurnItem["status"]) {
    if (this.handled.has(requestId)) return false;
    const request = this.requests.get(requestId);
    if (request !== undefined) return request.status === "pending";
    return status === "pending" || status === "waiting" || status === "running";
  }

  private actionsFor(items: ReadonlyArray<OrchestrationV2TurnItem>): ReadonlyArray<TurnAction> {
    const actions: Array<TurnAction> = [];
    for (const item of [...items].sort((a, b) => a.ordinal - b.ordinal)) {
      if (item.type === "assistant_message" || item.type === "reasoning") {
        const sent = this.sent.get(item.id) ?? 0;
        if (item.text.length <= sent) continue;
        this.sent.set(item.id, item.text.length);
        actions.push({
          _tag: "text",
          kind: item.type === "reasoning" ? "thought" : "message",
          id: item.id,
          text: item.text.slice(sent),
        });
      } else if (isToolItem(item)) {
        const status = toolStatusOf(item.status);
        if (this.toolStatus.get(item.id) === status) continue;
        this.toolStatus.set(item.id, status);
        actions.push({
          _tag: "tool",
          id: item.id,
          title: toolTitleOf(item),
          kind: toolKindOf(item),
          status,
        });
      } else if (item.type === "approval_request" && this.isPending(item.requestId, item.status)) {
        actions.push({ _tag: "approval", item });
      } else if (
        item.type === "user_input_request" &&
        this.isPending(item.requestId, item.status)
      ) {
        actions.push({ _tag: "question", item });
      }
    }
    return actions;
  }
}

const isToolItem = (item: OrchestrationV2TurnItem): item is ToolItem =>
  item.type === "command_execution" ||
  item.type === "file_change" ||
  item.type === "file_search" ||
  item.type === "web_search";

/** The MCP credential the host put in a session's `mcpServers`, over stdio or HTTP. */
export const hostMcpOf = (
  servers: ReadonlyArray<AcpSchema.McpServer> | undefined,
): HostMcp | null => {
  // `_meta`'s index signature widens every field, so read the shapes structurally.
  const named = (entries: unknown, matches: (name: string) => boolean): string | undefined => {
    if (!Array.isArray(entries)) return undefined;
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry.name === "string" && matches(entry.name)) {
        return typeof entry.value === "string" ? entry.value : undefined;
      }
    }
    return undefined;
  };
  for (const server of servers ?? []) {
    const fields: Readonly<Record<string, unknown>> = server;
    const endpoint = named(fields.env, (name) => name === "T3_ACP_MCP_ENDPOINT");
    const envAuthorization = named(fields.env, (name) => name === "T3_ACP_MCP_AUTHORIZATION");
    if (endpoint && envAuthorization) return { endpoint, authorization: envAuthorization };
    const headerAuthorization = named(
      fields.headers,
      (name) => name.toLowerCase() === "authorization",
    );
    if (typeof fields.url === "string" && headerAuthorization) {
      return { endpoint: fields.url, authorization: headerAuthorization };
    }
  }
  return null;
};

export const sessionIdFor = (threadId: ThreadId) => `${SANDBOX_SESSION_PREFIX}${threadId}`;

export const threadIdOfSession = (sessionId: string): ThreadId | null =>
  sessionId.startsWith(SANDBOX_SESSION_PREFIX) && sessionId.length > SANDBOX_SESSION_PREFIX.length
    ? ThreadId.make(sessionId.slice(SANDBOX_SESSION_PREFIX.length))
    : null;

interface BridgeSession {
  readonly threadId: ThreadId | null;
  mcp: HostMcp | null;
  cancel: Deferred.Deferred<void> | null;
}

/**
 * Serves ACP on the agent's stdio until the host closes it. The host starts one bridge process
 * per thread; a session that maps to no sandbox (the provider probe's, for one) is a dry run.
 */
export const runSandboxBridge = Effect.fn("SandboxBridge.run")(function* (
  ports: SandboxBridgePorts,
) {
  const agent = yield* AcpAgent.AcpAgent;
  const random = yield* SecureRandom.SecureRandom;
  const sessions = new Map<string, BridgeSession>();
  let clientName: string | undefined;
  const newId = random.uuidV4().pipe(Effect.orDie);

  const update = (sessionId: string, value: AcpSchema.SessionUpdate) =>
    agent.client.sessionUpdate({ sessionId, update: value });
  const say = (sessionId: string, kind: "message" | "thought", id: string, text: string) =>
    update(sessionId, {
      sessionUpdate: kind === "message" ? "agent_message_chunk" : "agent_thought_chunk",
      messageId: id,
      content: { type: "text", text },
    });
  const sayOnce = (sessionId: string, kind: "message" | "thought", text: string) =>
    newId.pipe(Effect.flatMap((id) => say(sessionId, kind, `bridge-${id}`, text)));

  const sessionOf = (sessionId: string) => {
    const session = sessions.get(sessionId);
    return session === undefined
      ? Effect.fail(AcpError.AcpRequestError.resourceNotFound(`Unknown session ${sessionId}`))
      : Effect.succeed(session);
  };

  yield* agent.handleInitialize((request) =>
    Effect.sync(() => {
      clientName = request.info?.name;
      return {
        protocolVersion: 2,
        info: { name: "t3-sandbox-bridge", version: "1" },
        capabilities: { session: { prompt: {} } },
      } satisfies AcpSchema.InitializeResponse;
    }),
  );

  // The probe and threads no sandbox maps to get a session that only explains itself.
  const openSession = Effect.fn("SandboxBridge.openSession")(function* (
    mcp: HostMcp | null,
  ): Effect.fn.Return<string> {
    if (clientName === PROBE_CLIENT_NAME || mcp === null) {
      const sessionId = `${DRY_RUN_SESSION_PREFIX}${yield* newId}`;
      sessions.set(sessionId, { threadId: null, mcp: null, cancel: null });
      return sessionId;
    }
    const host = yield* ports.readHostThread(mcp).pipe(Effect.option);
    const link = Option.isNone(host)
      ? Option.none()
      : yield* ports.findLink(host.value.threadId).pipe(Effect.orElseSucceed(Option.none));
    if (Option.isNone(host) || Option.isNone(link)) {
      const sessionId = `${DRY_RUN_SESSION_PREFIX}${yield* newId}`;
      sessions.set(sessionId, { threadId: null, mcp, cancel: null });
      return sessionId;
    }
    const sessionId = sessionIdFor(host.value.threadId);
    sessions.set(sessionId, { threadId: host.value.threadId, mcp, cancel: null });
    return sessionId;
  });

  yield* agent.handleCreateSession((request) =>
    openSession(hostMcpOf(request.mcpServers)).pipe(
      Effect.map((sessionId) => ({ sessionId, configOptions: modelConfigOptions })),
    ),
  );

  // The host keeps the conversation, so a session is resumed without replaying any of it.
  const resume = Effect.fn("SandboxBridge.resume")(function* (
    request: AcpSchema.ResumeSessionRequest,
  ) {
    const threadId = threadIdOfSession(request.sessionId);
    if (threadId === null) {
      return yield* AcpError.AcpRequestError.resourceNotFound(
        `Unknown session ${request.sessionId}`,
      );
    }
    const existing = sessions.get(request.sessionId);
    const mcp = hostMcpOf(request.mcpServers) ?? existing?.mcp ?? null;
    sessions.set(request.sessionId, { threadId, mcp, cancel: existing?.cancel ?? null });
    return { configOptions: modelConfigOptions } satisfies AcpSchema.ResumeSessionResponse;
  });
  yield* agent.handleResumeSession(resume);
  yield* agent.handleLoadSession(resume);

  yield* agent.handleSetSessionConfigOption((request) =>
    sessionOf(request.sessionId).pipe(Effect.as({ configOptions: modelConfigOptions })),
  );

  yield* agent.handleCloseSession((request) =>
    Effect.sync(() => {
      const session = sessions.get(request.sessionId);
      if (session?.cancel) Deferred.doneUnsafe(session.cancel, Effect.void);
      sessions.delete(request.sessionId);
      return {};
    }),
  );

  yield* agent.handleCancel((notification) =>
    Effect.suspend(() => {
      const cancel = sessions.get(notification.sessionId)?.cancel;
      return cancel === undefined || cancel === null
        ? Effect.void
        : Deferred.succeed(cancel, undefined).pipe(Effect.asVoid);
    }),
  );

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const session = yield* sessionOf(request.sessionId);
      const cancel = yield* Deferred.make<void>();
      session.cancel = cancel;
      const stopReason = yield* runTurn(request, session, cancel).pipe(
        Effect.scoped,
        Effect.catchTags({
          SandboxBridgeError: (error) =>
            sayOnce(
              request.sessionId,
              "message",
              `The sandbox bridge failed: ${error.message}`,
            ).pipe(
              Effect.orElseSucceed(() => undefined),
              Effect.as<AcpSchema.StopReason>("end_turn"),
            ),
        }),
        Effect.ensuring(Effect.sync(() => (session.cancel = null))),
      );
      // ACP v2 ends a turn with an idle state; the prompt response only acknowledges it.
      yield* update(request.sessionId, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason,
      });
      return {} satisfies AcpSchema.PromptResponse;
    }),
  );

  const connectWithRetry = Effect.fn("SandboxBridge.connect")(function* (
    sessionId: string,
    threadId: ThreadId,
  ): Effect.fn.Return<
    Option.Option<{ readonly link: SandboxBridgeLink; readonly sandbox: SandboxSession }>,
    SandboxBridgeError | AcpError.AcpError,
    Scope.Scope
  > {
    const window = Duration.toMillis(
      Duration.fromInputUnsafe(ports.reconnectWindow ?? "4 minutes"),
    );
    const spacing = ports.reconnectSpacing ?? "5 seconds";
    let waited = 0;
    let announced = false;
    let lastLink: SandboxBridgeLink | null = null;
    while (true) {
      const link = yield* ports.findLink(threadId);
      if (Option.isNone(link)) return Option.none();
      lastLink = link.value;
      const connected = yield* ports.connect(link.value).pipe(Effect.option);
      if (Option.isSome(connected)) {
        return Option.some({ link: link.value, sandbox: connected.value });
      }
      if (waited >= window) break;
      if (!announced) {
        announced = true;
        yield* sayOnce(sessionId, "thought", waitingThought(link.value));
      }
      yield* Effect.sleep(spacing);
      waited += Duration.toMillis(Duration.fromInputUnsafe(spacing));
    }
    yield* sayOnce(sessionId, "message", unreachableMessage(lastLink));
    return Option.none();
  });

  const runTurn = Effect.fn("SandboxBridge.turn")(function* (
    request: AcpSchema.PromptRequest,
    session: BridgeSession,
    cancel: Deferred.Deferred<void>,
  ): Effect.fn.Return<AcpSchema.StopReason, SandboxBridgeError | AcpError.AcpError, Scope.Scope> {
    const sessionId = request.sessionId;
    const threadId = session.threadId;
    if (threadId === null) {
      yield* sayOnce(sessionId, "message", NOT_LINKED_MESSAGE);
      return "end_turn";
    }
    const connected = yield* connectWithRetry(sessionId, threadId).pipe(
      Effect.raceFirst(Deferred.await(cancel).pipe(Effect.as(null))),
    );
    if (connected === null) return "cancelled";
    if (Option.isNone(connected)) {
      if (!(yield* ports.findLink(threadId)).pipe(Option.isSome)) {
        yield* sayOnce(sessionId, "message", NOT_LINKED_MESSAGE);
      }
      return "end_turn";
    }
    const { link, sandbox } = connected.value;
    const before = yield* sandbox.projection(threadId);
    const messageId = MessageId.make(yield* newId);
    const text = promptText(request.prompt);
    const commandId = CommandId.make(yield* newId);
    const dispatchMessage = sandbox.dispatch({
      type: "message.dispatch",
      commandId,
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId,
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    if (Option.isNone(before)) {
      // The first message makes the thread on the sandbox, with the id the host thread has.
      const runtimeMode = session.mcp
        ? yield* ports.readHostThread(session.mcp).pipe(
            Effect.map((host) => host.runtimeMode),
            Effect.orElseSucceed((): RuntimeMode => "approval-required"),
          )
        : "approval-required";
      yield* sandbox
        .launch({
          commandId,
          creationSource: "web",
          threadId,
          projectId: link.sandboxProjectId,
          title: text.slice(0, 80).trim() || "Sandbox thread",
          generateTitle: true,
          modelSelection: sandbox.defaultModelSelection ?? CLAUDE_FALLBACK_MODEL,
          runtimeMode,
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId, text, attachments: [] },
        })
        .pipe(Effect.catch(() => dispatchMessage));
    } else {
      yield* dispatchMessage;
    }

    const tracker = new TurnTracker(messageId, before);
    let refusedNoticeSent = false;
    // A request left waiting for a Supervised thread blocks the turn; it ends here instead.
    let refused = false;

    const forwardApproval = Effect.fn("SandboxBridge.forwardApproval")(function* (
      item: ApprovalItem,
    ) {
      const mode = session.mcp
        ? yield* ports.readHostThread(session.mcp).pipe(
            Effect.map((host) => host.runtimeMode),
            Effect.option,
          )
        : Option.none<RuntimeMode>();
      tracker.markHandled(item.requestId);
      if (Option.getOrUndefined(mode) !== "approval-required") {
        refused = true;
        if (!refusedNoticeSent) {
          refusedNoticeSent = true;
          yield* sayOnce(sessionId, "message", SUPERVISED_NOTICE);
        }
        return;
      }
      const toolCallId = `sandbox-request:${item.requestId}`;
      const title = `Sandbox ${link.sandboxId || link.label}: ${item.prompt ?? item.title ?? "Approve this action"}`;
      const kind = approvalToolKind(item.requestKind);
      yield* update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title,
        kind,
        status: "pending",
      });
      const response = yield* agent.client.requestPermission({
        sessionId,
        title,
        ...(item.reason === undefined ? {} : { description: item.reason }),
        subject: {
          type: "tool_call",
          toolCall: { toolCallId, title, kind, status: "pending" },
        },
        options: approvalOptions(item.options),
      });
      const decision = decisionOf(response);
      if (decision === null) return;
      yield* sandbox.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(yield* newId),
        threadId,
        requestId: item.requestId,
        decision,
      });
      yield* update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: decision === "decline" ? "failed" : "completed",
      });
    });

    const forwardQuestion = Effect.fn("SandboxBridge.forwardQuestion")(function* (
      item: QuestionItem,
    ) {
      tracker.markHandled(item.requestId);
      const response = yield* agent.client.elicit({
        sessionId,
        message: `Sandbox ${link.sandboxId || link.label} asks`,
        mode: "form",
        requestedSchema: questionForm(item.questions),
      });
      if (response.action === "accept") {
        yield* sandbox.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(yield* newId),
          threadId,
          requestId: item.requestId,
          answers: answersOf(item.questions, "content" in response ? response.content : undefined),
        });
      } else if (response.action === "decline") {
        yield* sandbox.dispatch({
          type: "thread.user-input.dismiss",
          commandId: CommandId.make(yield* newId),
          threadId,
          requestId: item.requestId,
        });
      }
    });

    const perform = (action: TurnAction) => {
      switch (action._tag) {
        case "text":
          return say(sessionId, action.kind, action.id, action.text);
        case "tool":
          return update(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: `sandbox-tool:${action.id}`,
            title: action.title,
            kind: action.kind,
            status: action.status,
          });
        case "approval":
          return forwardApproval(action.item);
        case "question":
          return forwardQuestion(action.item);
      }
    };

    const follow = sandbox.subscribe(threadId).pipe(
      Stream.runForEachWhile((item) =>
        Effect.forEach(tracker.apply(item), perform, { discard: true }).pipe(
          Effect.as(!tracker.done && !refused),
        ),
      ),
      Effect.as("followed" as const),
    );
    const outcome = yield* follow.pipe(
      Effect.raceFirst(Deferred.await(cancel).pipe(Effect.as("cancelled" as const))),
    );
    if (outcome === "cancelled") {
      const runId = tracker.activeRunId;
      yield* (
        sandbox.threadStop
          ? sandbox.dispatch({
              type: "thread.stop",
              commandId: CommandId.make(yield* newId),
              threadId,
            })
          : runId === undefined
            ? Effect.void
            : sandbox.dispatch({
                type: "run.interrupt",
                commandId: CommandId.make(yield* newId),
                threadId,
                runId,
              })
      ).pipe(Effect.ignore);
      return "cancelled";
    }
    const run = tracker.run;
    if (run?.status === "failed") {
      yield* sayOnce(
        sessionId,
        "message",
        "The sandbox turn failed. Open the thread on the sandbox for details.",
      );
    }
    return run?.status === "interrupted" || run?.status === "cancelled" ? "cancelled" : "end_turn";
  });

  return yield* Effect.never;
});
