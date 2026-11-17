import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "sandbox-control" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("keeps a sandbox chat on the sandbox bridge whatever client asks to switch", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:sandbox-bridge-switch");
    const bridgeSelection = { instanceId: ProviderInstanceId.make("sandboxes"), model: "sandbox" };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-sandbox-bridge-switch"),
      threadId,
      projectId: ProjectId.make("project:sandbox-bridge-switch"),
      title: "Sandbox chat",
      modelSelection: bridgeSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    for (const command of [
      {
        type: "thread.model-selection.set",
        commandId: CommandId.make("switch-sandbox-bridge-model"),
        threadId,
        modelSelection,
      },
      {
        type: "message.dispatch",
        commandId: CommandId.make("send-sandbox-bridge-other-model"),
        threadId,
        messageId: MessageId.make("message:sandbox-bridge-other-model"),
        text: "Run this here",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "mobile",
      },
    ] as const) {
      const failure = yield* orchestrator.dispatch(command).pipe(Effect.flip);
      assert.instanceOf(failure, Orchestrator.OrchestratorDispatchError);
      assert.include(String(failure.cause), "keeps the sandbox's agent");
    }
    assert.deepEqual((yield* projections.getThread(threadId)).modelSelection, bridgeSelection);
  }).pipe(Effect.provide(layerTest)),
);
