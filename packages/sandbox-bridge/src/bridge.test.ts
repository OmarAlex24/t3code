import {
  type MessageId,
  type ModelSelection,
  SANDBOX_BRIDGE_MESSAGE_META,
  SANDBOX_BRIDGE_WITHDRAW_METHOD,
  SANDBOX_RESUME_STEP_SECONDS,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  ProjectId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import type * as Scope from "effect/Scope";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as AcpAgent from "effect-acp/agent";
import * as AcpClient from "effect-acp/client";
import type * as AcpSchema from "effect-acp/compat";

import {
  approvalOptions,
  answersOf,
  decisionOf,
  hostMcpOf,
  SANDBOX_GONE_MESSAGE,
  PROBE_CLIENT_NAME,
  promptText,
  modeSyncCommands,
  runSandboxBridge,
  sandboxSelectionFor,
  SandboxBridgeError,
  type SandboxBridgePorts,
  type SandboxSession,
  skippedAttachmentsMessage,
  toolTitleOf,
  TurnTracker,
} from "./bridge.ts";
import type { SandboxBridgeLink } from "./link.ts";

const threadId = ThreadId.make("thread-sandbox-1");
const sandboxProjectId = ProjectId.make("project-on-sandbox");

const link: SandboxBridgeLink = {
  threadId,
  instanceId: "sandbox-instance",
  sandboxId: "bx_123",
  label: "api",
  httpBaseUrl: "http://sandbox.test:3773",
  sandboxProjectId,
  token: "bridge-token",
};

const hostMcpServer = {
  name: "t3-code",
  command: "/usr/bin/t3",
  args: ["mcp"],
  env: [
    { name: "T3_ACP_MCP_ENDPOINT", value: "http://127.0.0.1:3773/mcp" },
    { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer host-mcp" },
  ],
};

const codexSelection = (model: string, options?: ModelSelection["options"]) =>
  ({ instanceId: "codex", model, ...(options ? { options } : {}) }) as ModelSelection;
const effort = {
  id: "effort",
  label: "Effort",
  type: "select",
  role: "reasoning",
  options: [
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
  ],
} as const;
const sandboxProviders = [
  {
    instanceId: "codex",
    models: [
      {
        slug: "gpt-5.5",
        name: "GPT-5.5",
        isCustom: false,
        capabilities: { optionDescriptors: [effort] },
      },
      { slug: "gpt-5.5-mini", name: "GPT-5.5 Mini", isCustom: false, capabilities: null },
      { slug: "gpt-4", name: "GPT-4", isCustom: false, isLegacy: true, capabilities: null },
    ],
  },
] as unknown as SandboxSession["providers"];
const bridgeSelection = (model: string, options?: ModelSelection["options"]) =>
  ({ instanceId: "sandboxes", model, ...(options ? { options } : {}) }) as ModelSelection;

const encoder = new TextEncoder();

/** Two in-memory stdio ends wired to each other, so the real ACP client talks to the bridge. */
const crossedStdio = Effect.gen(function* () {
  const toAgent = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const toClient = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const writeTo = (queue: Queue.Queue<Uint8Array, Cause.Done<void>>) =>
    Sink.forEach((chunk: string | Uint8Array) =>
      Queue.offer(queue, typeof chunk === "string" ? encoder.encode(chunk) : chunk),
    );
  return {
    agent: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(toAgent),
      stdout: () => writeTo(toClient),
      stderr: () => Sink.drain,
    }),
    client: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(toClient),
      stdout: () => writeTo(toAgent),
      stderr: () => Sink.drain,
    }),
  };
});

// Entities the bridge only reads a few fields of; the rest of each schema does not matter here.
const run = (messageId: MessageId, status: string, id = "run-1") =>
  ({ id, threadId, userMessageId: messageId, status }) as never;
const assistant = (id: string, text: string, ordinal: number) =>
  ({ id, type: "assistant_message", text, status: "running", ordinal }) as never;
const approval = (requestId: string, requestKind: string, ordinal = 5) =>
  ({
    id: `item-${requestId}`,
    type: "approval_request",
    requestId,
    requestKind,
    title: "Run a command",
    prompt: "rm -rf build",
    status: "waiting",
    ordinal,
  }) as never;
const question = (requestId: string) =>
  ({
    id: `item-${requestId}`,
    type: "user_input_request",
    requestId,
    status: "waiting",
    ordinal: 6,
    questions: [
      {
        id: "color",
        header: "Color",
        question: "Which color?",
        options: [
          { label: "Red", value: "red" },
          { label: "Blue", value: "blue" },
        ],
      },
    ],
  }) as never;
const event = (type: string, payload: unknown): OrchestrationV2ThreadStreamItem =>
  ({ kind: "event", sequence: 1, event: { type, payload } }) as never;
const projection = (
  turnItems: ReadonlyArray<unknown>,
  runs: ReadonlyArray<unknown> = [],
  runtimeMode: RuntimeMode = "approval-required",
  modelSelection: ModelSelection = codexSelection("gpt-5.5"),
) =>
  ({
    thread: { runtimeMode, interactionMode: "default", modelSelection },
    turnItems,
    runs,
    runtimeRequests: [],
  }) as unknown as OrchestrationV2ThreadProjection;
const userMessage = (messageId: string, ordinal: number, runId: string | null = null) =>
  ({
    id: `item-${messageId}`,
    type: "user_message",
    messageId,
    runId,
    status: "completed",
    ordinal,
  }) as never;

interface FakeSandbox {
  readonly session: SandboxSession;
  readonly commands: Array<OrchestrationV2Command>;
  readonly launches: Array<OrchestrationV2ThreadLaunchInput>;
  readonly uploads: Array<unknown>;
  readonly push: (item: OrchestrationV2ThreadStreamItem) => Effect.Effect<void>;
}

/** A sandbox whose thread stream the test drives; `react` answers each command it receives. */
const makeFakeSandbox = (options: {
  readonly existing?: OrchestrationV2ThreadProjection;
  readonly providers?: SandboxSession["providers"];
  readonly threadStop?: boolean;
  readonly react?: (
    command: { readonly type: string; readonly messageId?: MessageId | undefined },
    fake: FakeSandbox,
  ) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const stream = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
    const commands: Array<OrchestrationV2Command> = [];
    const launches: Array<OrchestrationV2ThreadLaunchInput> = [];
    const uploads: Array<unknown> = [];
    const fake: FakeSandbox = {
      commands,
      launches,
      uploads,
      push: (item) => Queue.offer(stream, item).pipe(Effect.asVoid),
      session: {
        threadStop: options.threadStop ?? true,
        defaultModelSelection: { instanceId: "codex", model: "gpt-5.5" } as never,
        providers: options.providers ?? [],
        projection: () => Effect.succeed(Option.fromNullishOr(options.existing)),
        launch: (input) =>
          Effect.suspend(() => {
            launches.push(input);
            return (
              options.react?.(
                { type: "launch", messageId: input.initialMessage?.messageId },
                fake,
              ) ?? Effect.void
            );
          }),
        dispatch: (command) =>
          Effect.suspend(() => {
            commands.push(command);
            return options.react?.(command as never, fake) ?? Effect.void;
          }),
        persistAttachments: (input) =>
          Effect.sync(() => {
            uploads.push(input);
            return input.attachments.map((attachment, index) => ({
              type: "image" as const,
              id: `saved-${index}`,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            })) as never;
          }),
        subscribe: () => Stream.fromQueue(stream),
      },
    };
    return fake;
  });

const launchedMessageId = (sandbox: FakeSandbox) =>
  sandbox.launches[0]?.initialMessage?.messageId as MessageId;

/** A turn that streams `text` and completes, the way a sandbox reports one. */
const answerWith =
  (text: string) =>
  (
    command: { readonly type: string; readonly messageId?: MessageId | undefined },
    fake: FakeSandbox,
  ) =>
    command.type === "launch" || command.type === "message.dispatch"
      ? Effect.forEach(
          [
            event("run.created", run(command.messageId!, "running")),
            event("turn-item.updated", assistant("answer", text.slice(0, 5), 2)),
            event("turn-item.updated", assistant("answer", text, 2)),
            event("run.updated", run(command.messageId!, "completed")),
          ],
          fake.push,
          { discard: true },
        )
      : Effect.void;

interface Harness {
  readonly acp: AcpClient.AcpClient["Service"];
  readonly updates: Array<AcpSchema.SessionNotification>;
  readonly permissions: Array<AcpSchema.RequestPermissionRequest>;
  readonly elicitations: Array<AcpSchema.CreateElicitationRequest>;
  readonly withdrawals: Array<unknown>;
}

const messages = (
  updates: ReadonlyArray<AcpSchema.SessionNotification>,
  kind = "agent_message_chunk",
) =>
  updates.flatMap((notification) =>
    notification.update.sessionUpdate === kind && "content" in notification.update
      ? [(notification.update.content as { readonly text: string }).text]
      : [],
  );

/** Runs the bridge against the real effect-acp client, crossed over in-memory stdio. */
const withBridge = <A, E>(
  options: {
    readonly fake?: FakeSandbox;
    readonly linked?: boolean;
    readonly runtimeMode?: RuntimeMode;
    readonly hostModel?: ModelSelection;
    readonly connect?: SandboxBridgePorts["connect"];
    /** Null waits as long as the bridge does by default, spaced as it does by default. */
    readonly reconnectWindow?: null;
    readonly permission?: (
      request: AcpSchema.RequestPermissionRequest,
    ) => AcpSchema.RequestPermissionResponse;
    readonly elicitation?: AcpSchema.CreateElicitationResponse;
    /** Holds every permission request open, as a user who has not answered yet; set on arrival. */
    readonly permissionPending?: Deferred.Deferred<void>;
    readonly clientName?: string;
  },
  body: (harness: Harness) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const pipes = yield* crossedStdio;
    const ports: SandboxBridgePorts = {
      readHostThread: () =>
        Effect.succeed({
          threadId,
          modelSelection: options.hostModel ?? bridgeSelection("sandbox"),
          runtimeMode: options.runtimeMode ?? "approval-required",
          interactionMode: "default",
        }),
      findLink: () => Effect.succeed(options.linked === false ? Option.none() : Option.some(link)),
      connect:
        options.connect ??
        (() =>
          options.fake === undefined
            ? Effect.fail(new SandboxBridgeError({ message: "no sandbox" }))
            : Effect.succeed(options.fake.session)),
      ...(options.reconnectWindow === null
        ? {}
        : { reconnectWindow: "40 millis", reconnectSpacing: "10 millis" }),
    };
    yield* runSandboxBridge(ports).pipe(
      Effect.provide(Layer.mergeAll(AcpAgent.layer(pipes.agent), SecureRandom.layerWebCrypto)),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    const acp = yield* AcpClient.make(pipes.client);
    const harness: Harness = {
      acp,
      updates: [],
      permissions: [],
      elicitations: [],
      withdrawals: [],
    };
    yield* acp.handleExtNotification(SANDBOX_BRIDGE_WITHDRAW_METHOD, Schema.Unknown, (payload) =>
      Effect.sync(() => void harness.withdrawals.push(payload)),
    );
    yield* acp.handleSessionUpdate((notification) =>
      Effect.sync(() => void harness.updates.push(notification)),
    );
    yield* acp.handleRequestPermission((request) =>
      Effect.suspend(() => {
        harness.permissions.push(request);
        if (options.permissionPending !== undefined) {
          return Deferred.succeed(options.permissionPending, undefined).pipe(
            Effect.andThen(Effect.never),
          );
        }
        return Effect.succeed(
          options.permission?.(request) ?? {
            outcome: { outcome: "selected", optionId: request.options[0]!.optionId },
          },
        );
      }),
    );
    yield* acp.handleElicitation((request) =>
      Effect.sync(() => {
        harness.elicitations.push(request);
        return options.elicitation ?? { action: "cancel" };
      }),
    );
    yield* acp.agent.initialize({
      protocolVersion: 1,
      clientInfo: { name: options.clientName ?? "t3-code", version: "1" },
      clientCapabilities: { elicitation: { form: {} } },
    });
    return yield* body(harness);
  }).pipe(Effect.scoped);

const openThread = (acp: AcpClient.AcpClient["Service"]) =>
  acp.agent.createSession({ cwd: "/tmp/host-project", mcpServers: [hostMcpServer] });

const say = (
  acp: AcpClient.AcpClient["Service"],
  sessionId: string,
  text: string,
  message?: {
    readonly messageId: string;
    readonly createdBy?: string;
    readonly creationSource?: string;
  },
) =>
  acp.agent.prompt({
    sessionId,
    prompt: [{ type: "text", text }],
    ...(message === undefined
      ? {}
      : {
          _meta: {
            [SANDBOX_BRIDGE_MESSAGE_META]: {
              createdBy: "user",
              creationSource: "mobile",
              ...message,
            },
          },
        }),
  });

describe("the ACP side", () => {
  it.effect("advertises session loading and images, and gives the probe a dry-run session", () =>
    Effect.gen(function* () {
      const pipes = yield* crossedStdio;
      yield* runSandboxBridge({
        readHostThread: () => Effect.die("the probe must not read a host thread"),
        findLink: () => Effect.die("the probe must not look up a link"),
        connect: () => Effect.die("the probe must not reach a sandbox"),
      }).pipe(
        Effect.provide(Layer.mergeAll(AcpAgent.layer(pipes.agent), SecureRandom.layerWebCrypto)),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const acp = yield* AcpClient.make(pipes.client);
      const init = yield* acp.agent.initialize({
        protocolVersion: 1,
        clientInfo: { name: PROBE_CLIENT_NAME, version: "1" },
      });
      assert.strictEqual(init.agentCapabilities?.loadSession, true);
      assert.strictEqual(init.agentCapabilities?.promptCapabilities?.image, true);
      const session = yield* openThread(acp);
      assert.isTrue(session.sessionId.startsWith("sandbox-dry-run:"));
      assert.deepStrictEqual(
        session.configOptions?.map((option) => option.id),
        ["model"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("says plainly that a thread's sandbox is gone once its link is", () =>
    withBridge({ linked: false }, ({ acp, updates }) =>
      Effect.gen(function* () {
        const session = yield* openThread(acp);
        assert.isTrue(session.sessionId.startsWith("sandbox-dry-run:"));
        const result = yield* say(acp, session.sessionId, "hello");
        assert.strictEqual(result.stopReason, "end_turn");
        // A plain reply, not an error, and no thinking left running.
        assert.deepStrictEqual(messages(updates), [
          "This chat's sandbox was deleted, so this message wasn't sent. The conversation stays here to read; to keep working, start a new chat from T3 Code on your computer.",
        ]);
        assert.strictEqual(SANDBOX_GONE_MESSAGE, messages(updates)[0]);
        assert.deepStrictEqual(messages(updates, "agent_thought_chunk"), []);
        assert.deepStrictEqual(updates.at(-1)?.update, {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
        });
      }),
    ),
  );

  it.effect("resumes a linked session without replaying it", () =>
    withBridge({}, ({ acp, updates }) =>
      Effect.gen(function* () {
        yield* acp.agent.loadSession({
          sessionId: `sandbox:${threadId}`,
          cwd: "/tmp/host-project",
          mcpServers: [hostMcpServer],
        });
        assert.deepStrictEqual(updates, []);
      }),
    ),
  );
});

describe("the sandbox's models", () => {
  const sentModel = (fake: FakeSandbox) =>
    fake.commands.flatMap((command) =>
      command.type === "message.dispatch" ? [command.modelSelection ?? null] : [],
    );

  it.effect("offers the sandbox thread's models and effort, or none when it does not answer", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeSandbox({
        providers: sandboxProviders,
        existing: projection(
          [],
          [],
          "approval-required",
          codexSelection("gpt-5.5", [{ id: "effort", value: "high" }]),
        ),
      });
      yield* withBridge({ fake }, ({ acp }) =>
        Effect.gen(function* () {
          const session = yield* openThread(acp);
          const [model, level] = session.configOptions ?? [];
          assert.deepInclude(model, { id: "model", currentValue: "gpt-5.5" });
          assert.deepStrictEqual(
            model?.type === "select" ? model.options.map((option) => option.name) : [],
            ["GPT-5.5", "GPT-5.5 Mini", "Sandbox default"],
          );
          assert.deepInclude(level, {
            id: "effort",
            category: "thought_level",
            currentValue: "high",
          });
        }),
      );
      // An empty list keeps the models a sandbox listed before, instead of a placeholder.
      yield* withBridge({}, ({ acp }) =>
        Effect.gen(function* () {
          assert.deepStrictEqual((yield* openThread(acp)).configOptions, []);
        }),
      );
    }),
  );

  it.effect("sends the model picked on the host with the next message, and only then", () =>
    Effect.gen(function* () {
      const picked = bridgeSelection("gpt-5.5-mini", [{ id: "effort", value: "high" }]);
      const fake = yield* makeFakeSandbox({
        providers: sandboxProviders,
        existing: projection(
          [userMessage("from-computer", 1, "run-0")],
          [run("from-computer" as MessageId, "completed", "run-0")],
        ),
        react: answerWith("Done"),
      });
      yield* withBridge({ fake, hostModel: picked }, ({ acp }) =>
        Effect.gen(function* () {
          const session = yield* openThread(acp);
          // A message the computer already sent keeps the model it was sent with.
          yield* say(acp, session.sessionId, "From the computer", { messageId: "from-computer" });
          assert.deepStrictEqual(sentModel(fake), []);
          yield* say(acp, session.sessionId, "From the phone", { messageId: "from-phone" });
          assert.deepStrictEqual(sentModel(fake), [
            codexSelection("gpt-5.5-mini", [{ id: "effort", value: "high" }]),
          ]);
        }),
      );
    }),
  );

  it("keeps the sandbox's model for the bridge's own value, a model it lacks, or the same one", () => {
    const current = codexSelection("gpt-5.5");
    for (const host of [
      bridgeSelection("sandbox"),
      bridgeSelection("claude-opus-5-5"),
      bridgeSelection("gpt-5.5"),
    ]) {
      assert.isNull(sandboxSelectionFor(host, current, sandboxProviders));
    }
    assert.deepStrictEqual(
      sandboxSelectionFor(bridgeSelection("gpt-5.5-mini"), current, sandboxProviders),
      codexSelection("gpt-5.5-mini"),
    );
  });
});

describe("forwarding a turn", () => {
  it.effect("creates the sandbox thread with the host thread's id and streams the answer", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeSandbox({ react: answerWith("Hello from the sandbox") });
      yield* withBridge({ fake, runtimeMode: "approval-required" }, ({ acp, updates }) =>
        Effect.gen(function* () {
          const session = yield* openThread(acp);
          assert.strictEqual(session.sessionId, `sandbox:${threadId}`);
          const result = yield* say(acp, session.sessionId, "Fix the bug");
          assert.strictEqual(result.stopReason, "end_turn");
          assert.strictEqual(messages(updates).join(""), "Hello from the sandbox");
          const launch = fake.launches[0]!;
          assert.strictEqual(launch.threadId, threadId);
          assert.strictEqual(launch.projectId, sandboxProjectId);
          assert.strictEqual(launch.runtimeMode, "approval-required");
          assert.strictEqual(launch.initialMessage?.text, "Fix the bug");
          assert.deepStrictEqual(launch.modelSelection, {
            instanceId: "codex",
            model: "gpt-5.5",
          } as never);
          assert.deepStrictEqual(fake.commands, []);
        }),
      );
    }),
  );

  it.effect("sends to an existing sandbox thread without replaying its history", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeSandbox({
        existing: projection([assistant("old", "Earlier answer", 1)]),
        react: (command, sandbox) =>
          command.type === "message.dispatch"
            ? Effect.forEach(
                [
                  {
                    kind: "snapshot",
                    snapshotSequence: 1,
                    projection: projection([assistant("old", "Earlier answer", 1)]),
                  } as never,
                  event("run.created", run(command.messageId!, "running", "run-2")),
                  event("turn-item.updated", assistant("new", "Next answer", 3)),
                  event("run.updated", run(command.messageId!, "completed", "run-2")),
                ],
                sandbox.push,
                { discard: true },
              )
            : Effect.void,
      });
      yield* withBridge({ fake }, ({ acp, updates }) =>
        Effect.gen(function* () {
          const session = yield* openThread(acp);
          const result = yield* say(acp, session.sessionId, "And now?");
          assert.strictEqual(result.stopReason, "end_turn");
          assert.deepStrictEqual(messages(updates), ["Next answer"]);
          const dispatched = fake.commands[0]!;
          assert.strictEqual(dispatched.type, "message.dispatch");
          assert.strictEqual(dispatched.type === "message.dispatch" && dispatched.text, "And now?");
          assert.deepStrictEqual(fake.launches, []);
        }),
      );
    }),
  );

  it.effect("asks for a sandbox approval with a non-read kind and answers with the choice", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeSandbox({
        react: (command, sandbox) => {
          if (command.type === "launch") {
            return Effect.forEach(
              [
                event("run.created", run(command.messageId!, "waiting")),
                event("turn-item.updated", approval("req-1", "command")),
              ],
              sandbox.push,
              { discard: true },
            );
          }
          if (command.type === "runtime-request.respond") {
            return sandbox.push(event("run.updated", run(launchedMessageId(sandbox), "completed")));
          }
          return Effect.void;
        },
      });
      yield* withBridge(
        {
          fake,
          permission: (request) => ({
            outcome: {
              outcome: "selected",
              optionId: request.options.find((option) => option.kind === "allow_always")!.optionId,
            },
          }),
        },
        ({ acp, permissions }) =>
          Effect.gen(function* () {
            const session = yield* openThread(acp);
            const result = yield* say(acp, session.sessionId, "Clean up");
            assert.strictEqual(result.stopReason, "end_turn");
            const asked = permissions[0]!;
            assert.strictEqual(asked.toolCall.kind, "execute");
            assert.include(asked.toolCall.title ?? "", "Sandbox bx_123");
            // The host shows the request by its command, as the computer does.
            assert.deepStrictEqual(asked.toolCall.rawInput, { command: "rm -rf build" });
            assert.deepStrictEqual(
              fake.commands.map((command) => command.type),
              ["runtime-request.respond"],
            );
            const respond = fake.commands[0]!;
            assert.strictEqual(
              respond.type === "runtime-request.respond" && respond.decision,
              "acceptForSession",
            );
          }),
      );
    }),
  );

  it.effect("asks with a form when the thread is not Supervised, so its policy cannot answer", () =>
    Effect.gen(function* () {
      const approvalTurn = makeFakeSandbox({
        react: (command, sandbox) => {
          if (command.type === "launch") {
            return Effect.forEach(
              [
                event("run.created", run(command.messageId!, "waiting")),
                event("turn-item.updated", approval("req-1", "command", 5)),
              ],
              sandbox.push,
              { discard: true },
            );
          }
          return command.type === "runtime-request.respond"
            ? sandbox.push(event("run.updated", run(launchedMessageId(sandbox), "completed")))
            : Effect.void;
        },
      });
      // Full access grants it without asking anyone.
      for (const [runtimeMode, asked] of [
        ["auto", 1],
        ["full-access", 0],
      ] as const) {
        const fake = yield* approvalTurn;
        yield* withBridge(
          {
            fake,
            runtimeMode,
            elicitation: { action: "accept", content: { decision: "Allow" } },
          },
          ({ acp, permissions, elicitations }) =>
            Effect.gen(function* () {
              const session = yield* openThread(acp);
              const result = yield* say(acp, session.sessionId, "Clean up");
              assert.strictEqual(result.stopReason, "end_turn");
              assert.deepStrictEqual(permissions, []);
              assert.strictEqual(elicitations.length, asked);
              const respond = fake.commands.find(
                (command) => command.type === "runtime-request.respond",
              );
              assert.strictEqual(
                respond?.type === "runtime-request.respond" && respond.decision,
                "accept",
              );
            }),
        );
      }
    }),
  );

  it("moves the sandbox to new modes at once, granting its waiting approvals under full access", () => {
    const waiting = {
      ...projection([], [], "approval-required"),
      thread: { id: threadId, runtimeMode: "approval-required", interactionMode: "plan" },
      runtimeRequests: [
        { id: "req-cmd", kind: "command", status: "pending" },
        { id: "req-ask", kind: "user_input", status: "pending" },
        { id: "req-old", kind: "file-change", status: "resolved" },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    let count = 0;
    const commandId = () => `cmd-${count++}` as never;
    assert.deepStrictEqual(
      modeSyncCommands(
        waiting,
        { runtimeMode: "full-access", interactionMode: "default" },
        commandId,
      ),
      [
        {
          type: "thread.runtime-mode.set",
          commandId: "cmd-0",
          threadId,
          runtimeMode: "full-access",
        },
        {
          type: "thread.interaction-mode.set",
          commandId: "cmd-1",
          threadId,
          interactionMode: "default",
        },
        {
          type: "runtime-request.respond",
          commandId: "cmd-2",
          threadId,
          requestId: "req-cmd",
          decision: "accept",
        },
      ] as never,
    );
    assert.deepStrictEqual(
      modeSyncCommands(
        waiting,
        { runtimeMode: "approval-required", interactionMode: "plan" },
        commandId,
      ),
      [],
    );
  });

  it("grants a running sandbox's approvals under full access but moves its mode after the run", () => {
    // Changing a sandbox thread's runtime mode cuts its agent's run short.
    const running = {
      ...projection([], [run("msg-1" as MessageId, "running", "run-1")], "approval-required"),
      thread: { id: threadId, runtimeMode: "approval-required", interactionMode: "default" },
      runtimeRequests: [{ id: "req-cmd", kind: "command", status: "pending" }],
    } as unknown as OrchestrationV2ThreadProjection;
    let count = 0;
    const commandId = () => `cmd-${count++}` as never;
    assert.deepStrictEqual(
      modeSyncCommands(
        running,
        { runtimeMode: "full-access", interactionMode: "default" },
        commandId,
      ),
      [
        {
          type: "runtime-request.respond",
          commandId: "cmd-0",
          threadId,
          requestId: "req-cmd",
          decision: "accept",
        },
      ] as never,
    );
    const ended = {
      ...running,
      runs: [run("msg-1" as MessageId, "completed", "run-1")],
      runtimeRequests: [],
    } as unknown as OrchestrationV2ThreadProjection;
    assert.deepStrictEqual(
      modeSyncCommands(
        ended,
        { runtimeMode: "full-access", interactionMode: "default" },
        commandId,
      ),
      [
        {
          type: "thread.runtime-mode.set",
          commandId: "cmd-1",
          threadId,
          runtimeMode: "full-access",
        },
      ] as never,
    );
  });

  it.effect("closes the host's request when the approval is answered on the sandbox", () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>();
      const fake = yield* makeFakeSandbox({
        react: (command, sandbox) =>
          command.type === "launch"
            ? Effect.forEach(
                [
                  event("run.created", run(command.messageId!, "waiting")),
                  event("turn-item.updated", approval("req-1", "command", 5)),
                ],
                sandbox.push,
                { discard: true },
              )
            : Effect.void,
      });
      yield* withBridge({ fake, permissionPending: asked }, ({ acp, withdrawals }) =>
        Effect.gen(function* () {
          const session = yield* openThread(acp);
          const prompt = yield* say(acp, session.sessionId, "Clean up").pipe(Effect.forkScoped);
          // The computer answers: the sandbox resolves the request and the run finishes.
          yield* Deferred.await(asked);
          yield* fake.push(
            event("runtime-request.updated", { id: "req-1", status: "resolved" } as never),
          );
          yield* fake.push(event("run.updated", run(launchedMessageId(fake), "completed")));
          const result = yield* Fiber.join(prompt);
          assert.strictEqual(result.stopReason, "end_turn");
          assert.deepStrictEqual(withdrawals, [{ sessionId: session.sessionId }]);
          assert.deepStrictEqual(fake.commands, []);
        }),
      );
    }),
  );

  it.effect("follows a message the sandbox already has instead of sending it again", () =>
    Effect.gen(function* () {
      // Sent on the computer: the sandbox has the message and part of its answer already.
      const existing = projection(
        [
          assistant("old", "Earlier answer", 1),
          userMessage("msg-desk", 2, "run-desk"),
          assistant("partial", "Half", 3),
        ],
        [run("msg-desk" as MessageId, "running", "run-desk")],
      );
      const fake = yield* makeFakeSandbox({ existing });
      yield* withBridge({ fake }, ({ acp, updates }) =>
        Effect.gen(function* () {
          const session = yield* openThread(acp);
          const prompt = yield* say(acp, session.sessionId, "From the computer", {
            messageId: "msg-desk",
            creationSource: "web",
          }).pipe(Effect.forkScoped);
          yield* fake.push(event("turn-item.updated", assistant("partial", "Half done", 3)));
          yield* fake.push(
            event("run.updated", run("msg-desk" as MessageId, "completed", "run-desk")),
          );
          const result = yield* Fiber.join(prompt);
          assert.strictEqual(result.stopReason, "end_turn");
          assert.deepStrictEqual(messages(updates), ["Half", " done"]);
          assert.deepStrictEqual(fake.commands, []);
          assert.deepStrictEqual(fake.launches, []);
        }),
      );
    }),
  );

  it.effect(
    "sends a new message with the host's id, after moving the sandbox to the thread's modes",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeSandbox({
          existing: projection([], [], "approval-required"),
          react: answerWith("Done"),
        });
        yield* withBridge({ fake, runtimeMode: "auto" }, ({ acp }) =>
          Effect.gen(function* () {
            const session = yield* openThread(acp);
            yield* say(acp, session.sessionId, "Go", { messageId: "msg-phone" });
            assert.deepStrictEqual(
              fake.commands.map((command) => command.type),
              ["thread.runtime-mode.set", "message.dispatch"],
            );
            const [mode, sent] = fake.commands;
            assert.strictEqual(
              mode?.type === "thread.runtime-mode.set" && mode.runtimeMode,
              "auto",
            );
            assert.strictEqual(
              sent?.type === "message.dispatch" && String(sent.messageId),
              "msg-phone",
            );
          }),
        );
      }),
  );

  it.effect("follows the sandbox's turn when the host continues after a restart", () =>
    Effect.gen(function* () {
      const existing = projection(
        [userMessage("msg-1", 1, "run-1"), assistant("a", "Working", 2)],
        [run("msg-1" as MessageId, "running", "run-1")],
      );
      const fake = yield* makeFakeSandbox({ existing });
      yield* withBridge({ fake }, ({ acp, updates }) =>
        Effect.gen(function* () {
          const session = yield* openThread(acp);
          const prompt = yield* say(
            acp,
            session.sessionId,
            "Continue where you left off. Your last turn was cut short.",
            { messageId: "msg-continue", createdBy: "agent", creationSource: "server" },
          ).pipe(Effect.forkScoped);
          yield* fake.push(event("run.updated", run("msg-1" as MessageId, "completed", "run-1")));
          const result = yield* Fiber.join(prompt);
          assert.strictEqual(result.stopReason, "end_turn");
          assert.deepStrictEqual(fake.commands, []);
          assert.deepStrictEqual(messages(updates), ["Working"]);
        }),
      );
    }),
  );

  it.effect("sends images as sandbox attachments and says which files stayed behind", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeSandbox({ react: answerWith("Nice picture") });
      yield* withBridge({ fake }, ({ acp, updates }) =>
        Effect.gen(function* () {
          const session = yield* openThread(acp);
          yield* acp.agent.prompt({
            sessionId: session.sessionId,
            prompt: [
              {
                type: "text",
                text:
                  "<t3_code_instructions>\nx\n</t3_code_instructions>\n\n<user_request>\nLook at this\n\n" +
                  '[Attached image "shot.png" is saved at: /Users/me/.t3/attachments/a.png]\n\n' +
                  '[Attached file "notes.pdf" is saved at: /Users/me/.t3/attachments/b.pdf]\n</user_request>',
              },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
          });
          const launch = fake.launches[0]!;
          assert.strictEqual(launch.initialMessage?.text, "Look at this");
          assert.deepStrictEqual(
            launch.initialMessage?.attachments.map((attachment) => attachment.name),
            ["shot.png"],
          );
          const upload = fake.uploads[0] as {
            attachments: ReadonlyArray<{ dataUrl: string; sizeBytes: number }>;
          };
          assert.strictEqual(upload.attachments[0]?.dataUrl, "data:image/png;base64,aGVsbG8=");
          assert.strictEqual(upload.attachments[0]?.sizeBytes, 5);
          assert.include(messages(updates), skippedAttachmentsMessage(["notes.pdf"]));
        }),
      );
    }),
  );

  it.effect("turns a sandbox question into a form and sends back the answers", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeSandbox({
        react: (command, sandbox) => {
          if (command.type === "launch") {
            return Effect.forEach(
              [
                event("run.created", run(command.messageId!, "waiting")),
                event("turn-item.updated", question("req-q")),
              ],
              sandbox.push,
              { discard: true },
            );
          }
          return command.type === "runtime-request.respond"
            ? sandbox.push(event("run.updated", run(launchedMessageId(sandbox), "completed")))
            : Effect.void;
        },
      });
      yield* withBridge(
        { fake, elicitation: { action: "accept", content: { color: "blue" } } },
        ({ acp, elicitations }) =>
          Effect.gen(function* () {
            const session = yield* openThread(acp);
            yield* say(acp, session.sessionId, "Paint it");
            const form = elicitations[0]!;
            assert.strictEqual(form.mode, "form");
            const respond = fake.commands[0]!;
            assert.deepStrictEqual(
              respond.type === "runtime-request.respond" ? respond.answers : null,
              { color: "blue" },
            );
          }),
      );
    }),
  );

  it.effect("surfaces a request already pending on the sandbox when a turn starts", () =>
    Effect.gen(function* () {
      const pending = projection([approval("req-old", "command", 1)]);
      const fake = yield* makeFakeSandbox({
        existing: pending,
        react: (command, sandbox) => {
          if (command.type === "message.dispatch") {
            return Effect.forEach(
              [
                { kind: "snapshot", snapshotSequence: 1, projection: pending } as never,
                event("run.created", run(command.messageId!, "queued")),
              ],
              sandbox.push,
              { discard: true },
            );
          }
          if (command.type === "runtime-request.respond") {
            const sent = sandbox.commands[0]!;
            const messageId = sent.type === "message.dispatch" ? sent.messageId : undefined;
            return sandbox.push(event("run.updated", run(messageId!, "completed")));
          }
          return Effect.void;
        },
      });
      yield* withBridge({ fake }, ({ acp, permissions }) =>
        Effect.gen(function* () {
          const session = yield* openThread(acp);
          yield* say(acp, session.sessionId, "Go on");
          assert.strictEqual(permissions.length, 1);
          const respond = fake.commands[1]!;
          assert.strictEqual(
            respond.type === "runtime-request.respond" ? String(respond.requestId) : null,
            "req-old",
          );
        }),
      );
    }),
  );

  it.effect.each([true, false])("stops the sandbox turn on cancel (threadStop %s)", (threadStop) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const fake = yield* makeFakeSandbox({
        threadStop,
        react: (command, sandbox) =>
          command.type === "launch"
            ? sandbox
                .push(event("run.created", run(command.messageId!, "running")))
                .pipe(Effect.andThen(Deferred.succeed(started, undefined)))
            : Effect.void,
      });
      yield* withBridge({ fake }, ({ acp }) =>
        Effect.gen(function* () {
          const session = yield* openThread(acp);
          const prompt = yield* say(acp, session.sessionId, "Long job").pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* Effect.yieldNow;
          yield* acp.agent.cancel({ sessionId: session.sessionId });
          const result = yield* Fiber.join(prompt);
          assert.strictEqual(result.stopReason, "cancelled");
          assert.deepStrictEqual(
            fake.commands.map((command) => command.type),
            [threadStop ? "thread.stop" : "run.interrupt"],
          );
        }),
      );
    }),
  );

  it.effect("waits out a slow resume and then sends the message it was given", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeSandbox({ react: answerWith("Back up") });
      // A machine start and T3's start at their limits: past the four minutes the bridge waited.
      const upAt =
        (SANDBOX_RESUME_STEP_SECONDS.machineStart + SANDBOX_RESUME_STEP_SECONDS.t3Start) * 1000 +
        30_000;
      const startedAt = yield* Clock.currentTimeMillis;
      // Set once the session is open, so only the turn's own attempts count.
      let turnRefused: Deferred.Deferred<void> | undefined;
      yield* withBridge(
        {
          fake,
          reconnectWindow: null,
          connect: () =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                now - startedAt < upAt
                  ? Effect.suspend(() =>
                      turnRefused === undefined
                        ? Effect.void
                        : Deferred.succeed(turnRefused, undefined),
                    ).pipe(
                      Effect.andThen(
                        Effect.fail(new SandboxBridgeError({ message: "connection refused" })),
                      ),
                    )
                  : Effect.succeed(fake.session),
              ),
            ),
        },
        ({ acp, updates }) =>
          Effect.gen(function* () {
            const session = yield* openThread(acp);
            const refused = yield* Deferred.make<void>();
            turnRefused = refused;
            const prompt = yield* say(acp, session.sessionId, "Pick this up").pipe(
              Effect.forkScoped,
            );
            yield* Deferred.await(refused);
            yield* TestClock.adjust(upAt + 10_000);
            const result = yield* Fiber.join(prompt);
            assert.strictEqual(result.stopReason, "end_turn");
            assert.deepStrictEqual(messages(updates, "agent_thought_chunk"), [
              "Starting sandbox bx_123…",
            ]);
            assert.strictEqual(messages(updates).join(""), "Back up");
            assert.strictEqual(fake.launches[0]?.initialMessage?.text, "Pick this up");
          }),
      );
    }),
  );

  it.live("waits for a sandbox that is resuming, then reports it unreachable", () =>
    withBridge(
      { connect: () => Effect.fail(new SandboxBridgeError({ message: "connection refused" })) },
      ({ acp, updates }) =>
        Effect.gen(function* () {
          const session = yield* openThread(acp);
          const result = yield* say(acp, session.sessionId, "Hello?");
          assert.strictEqual(result.stopReason, "end_turn");
          assert.deepStrictEqual(messages(updates, "agent_thought_chunk"), [
            "Starting sandbox bx_123…",
          ]);
          assert.match(messages(updates).join(""), /bx_123 is stopped or not answering/u);
          assert.notMatch(messages(updates).join(""), /\bMac\b/u);
        }),
    ),
  );
});

describe("mapping", () => {
  it("offers one option per kind and always a way to decline", () => {
    const options = approvalOptions([
      { decision: "accept", label: "Yes" },
      { decision: "acceptAlways", label: "Always" },
      { decision: "acceptForSession", label: "Session" },
    ] as never);
    assert.deepStrictEqual(
      options.map((option) => [option.optionId, option.kind]),
      [
        ["accept", "allow_once"],
        ["acceptAlways", "allow_always"],
        ["decline", "reject_once"],
      ],
    );
  });

  it("titles a tool by what it does, not the provider's generic label", () => {
    assert.strictEqual(
      toolTitleOf({
        type: "command_execution",
        title: "Ran command",
        input: "cargo build\n--release",
      } as never),
      "cargo build",
    );
    assert.strictEqual(
      toolTitleOf({ type: "subagent", title: null, prompt: "Review the diff" } as never),
      "Subagent: Review the diff",
    );
    assert.strictEqual(
      toolTitleOf({ type: "dynamic_tool", title: null, toolName: "t3_thread_read" } as never),
      "t3_thread_read",
    );
  });

  it("updates a command once its input arrives, and names the command for the host", () => {
    const tracker = new TurnTracker("message-1" as MessageId, Option.none());
    const command = (input: string | undefined) =>
      event("turn-item.updated", {
        id: "item-cmd",
        type: "command_execution",
        title: "Ran command",
        ...(input === undefined ? {} : { input }),
        status: "running",
        ordinal: 3,
      });
    assert.deepStrictEqual(tracker.apply(command(undefined)), [
      {
        _tag: "tool",
        id: "item-cmd",
        title: "Ran command",
        kind: "execute",
        status: "in_progress",
      },
    ]);
    assert.deepStrictEqual(tracker.apply(command("touch /tmp/x && rm /tmp/x")), [
      {
        _tag: "tool",
        id: "item-cmd",
        title: "touch /tmp/x && rm /tmp/x",
        kind: "execute",
        status: "in_progress",
        command: "touch /tmp/x && rm /tmp/x",
      },
    ]);
    assert.deepStrictEqual(tracker.apply(command("touch /tmp/x && rm /tmp/x")), []);
  });

  it("reads the decision back, and nothing when the host cancelled", () => {
    assert.strictEqual(
      decisionOf({ outcome: { outcome: "selected", optionId: "decline" } }),
      "decline",
    );
    assert.strictEqual(decisionOf({ outcome: { outcome: "selected", optionId: "bogus" } }), null);
    assert.strictEqual(decisionOf({ outcome: { outcome: "cancelled" } }), null);
  });

  it("keeps only answers to the questions asked", () => {
    assert.deepStrictEqual(
      answersOf([{ id: "a" }, { id: "b" }, { id: "c" }] as never, {
        a: "x",
        b: true,
        c: ["1", 2],
        d: "ignored",
      }),
      { a: "x", b: "true", c: ["1"] },
    );
  });

  it("finds the host's MCP credential over stdio or HTTP", () => {
    assert.deepStrictEqual(hostMcpOf([hostMcpServer] as never), {
      endpoint: "http://127.0.0.1:3773/mcp",
      authorization: "Bearer host-mcp",
    });
    assert.deepStrictEqual(
      hostMcpOf([
        {
          type: "http",
          name: "t3-code",
          url: "http://127.0.0.1:3773/mcp",
          headers: [{ name: "Authorization", value: "Bearer http" }],
        },
      ] as never),
      { endpoint: "http://127.0.0.1:3773/mcp", authorization: "Bearer http" },
    );
    assert.strictEqual(hostMcpOf([]), null);
  });

  it("forwards a prompt's text and embedded text resources", () => {
    assert.strictEqual(
      promptText([
        { type: "text", text: "one" },
        { type: "resource", resource: { uri: "file:///a", text: "two" } },
        { type: "image", data: "", mimeType: "image/png" },
      ] as never),
      "one\n\ntwo",
    );
  });

  it("forwards only the user's request, since the sandbox adds its own instructions", () => {
    const wrapped =
      "<t3_code_instructions>\n## T3 Code interaction mode: Default\n</t3_code_instructions>\n\n" +
      "<user_request>\nList the files\nin this repo\n</user_request>";
    assert.strictEqual(
      promptText([{ type: "text", text: wrapped }] as never),
      "List the files\nin this repo",
    );
    // The first prompt also carries the host's runtime notes in a block of their own.
    assert.strictEqual(
      promptText([
        { type: "text", text: wrapped },
        {
          type: "text",
          text: "<runtime_info>acpRegistry</runtime_info>\n\n<pull_request_linking>\nx\n</pull_request_linking>",
        },
        { type: "text", text: "see the diff" },
      ] as never),
      "List the files\nin this repo\n\nsee the diff",
    );
    assert.strictEqual(
      promptText([{ type: "text", text: "Explain <user_request> tags" }] as never),
      "Explain <user_request> tags",
    );
  });
});
