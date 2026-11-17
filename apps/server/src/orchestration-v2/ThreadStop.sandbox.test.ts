import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  SANDBOX_BRIDGE_MODEL,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const bridgeSelection = {
  instanceId: ProviderInstanceId.make(SANDBOX_BRIDGE_INSTANCE_ID),
  model: SANDBOX_BRIDGE_MODEL,
};
const bridgeAdapter = {
  instanceId: bridgeSelection.instanceId,
  driver: ProviderDriverKind.make("acpRegistry"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-stop-sandbox" },
        ProviderAdapterRegistry.layerFromAdapters([bridgeAdapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

const threadState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return {
      runs: projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`),
    };
  });

it.effect.each([
  ["30 minutes", "queued"],
  ["2 hours", "cancelled"],
] as const)("a sandbox chat's message after %s leaves its held message %s", ([age, status]) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:stop-sandbox-held:${status}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-stop"),
      title: threadId,
      modelSelection: bridgeSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* send(threadId, "active", "start_immediately");
    yield* send(threadId, "queued before the stop", "queue_after_active");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(`stop:${threadId}`),
      threadId,
    });
    assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted", "queued:held"]);

    yield* TestClock.adjust(age);
    yield* send(threadId, "back", "start_immediately");
    assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted", status, "starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  ["30 minutes", "starting"],
  ["2 hours", "cancelled"],
] as const)("a sandbox chat's message queued %s before its run ends is %s", ([age, status]) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:sandbox-queued:${status}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-stop"),
      title: threadId,
      modelSelection: bridgeSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* send(threadId, "active", "start_immediately");
    yield* send(threadId, "queued behind it", "queue_after_active");
    assert.deepEqual((yield* threadState(threadId)).runs, ["starting", "queued"]);

    yield* TestClock.adjust(age);
    const active = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:sandbox-queued:${status}`),
      type: "run.updated",
      threadId,
      runId: active.id,
      occurredAt: now,
      payload: { ...active, status: "completed", completedAt: now },
    } as OrchestrationV2DomainEvent);
    yield* orchestrator.resumeQueuedRuns;
    assert.deepEqual((yield* threadState(threadId)).runs, ["completed", status]);
  }).pipe(Effect.provide(layerTest)),
);
