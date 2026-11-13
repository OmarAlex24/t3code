import type {
  OrchestrationV2DomainEvent,
  SandboxDeleteResult,
  SandboxProviderError,
  SandboxRecord,
  SandboxResolveSettleInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as SandboxProvisioner from "./SandboxProvisioner.ts";

/** How long a remembered delete waits after a settle, so the settle's Undo still keeps everything. */
const SETTLE_DELETE_DELAY = "10 seconds";

const isStarting = (record: SandboxRecord) =>
  record.state === "provisioning" || record.resumingSince !== undefined;

/**
 * Applies a sandbox config's `onSettle` when its chat's thread on this host settles, whichever
 * client, agent, or sweep settled it. What it cannot do alone waits on the record as
 * `settlePending` for the user.
 */
export class SandboxSettle extends Context.Service<
  SandboxSettle,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly resolve: (
      input: SandboxResolveSettleInput,
    ) => Effect.Effect<SandboxDeleteResult, SandboxProviderError>;
    /** Waits for the settles still in hand: a delete's undo window, or a sandbox still starting. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/sandbox/SandboxSettle") {}

const make = Effect.gen(function* () {
  const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  // Keyed by instance: an un-settle, a newer settle, or the user's answer replaces what waits.
  const inHand = yield* FiberMap.make<string, void, never>();
  // The settle each thread was last handled for. Settling a settled chat again keeps its time.
  const handledSettles = new Map<ThreadId, number>();

  const recordOf = (instanceId: string) =>
    provisioner.list.pipe(
      Effect.map(({ sandboxes }) => sandboxes.find((record) => record.instanceId === instanceId)),
    );
  // The thread here with a sandbox's thread id is the chat the bridge drives for it.
  const chatSandbox = (threadId: ThreadId) =>
    provisioner.list.pipe(
      Effect.map(({ sandboxes }) =>
        sandboxes.find((record) => record.threadId === threadId && record.state !== "deleted"),
      ),
    );
  const stillSettled = (threadId: ThreadId) =>
    orchestrator
      .getThreadShell(threadId)
      .pipe(Effect.map((shell) => shell?.settledOverride === "settled"));

  // A launch or resume writes back the record it started with, so a decision waits for it to end.
  const afterStarting = Effect.fn("SandboxSettle.afterStarting")(function* (instanceId: string) {
    const ready = (record: SandboxRecord | undefined) =>
      record === undefined || !isStarting(record);
    const now = yield* recordOf(instanceId);
    if (ready(now)) return now;
    const changed = Stream.merge(
      Stream.map(provisioner.listChanges, () => undefined),
      Stream.map(provisioner.launchLifecycle, () => undefined),
    );
    // The minute tick covers a change that landed before the subscription did.
    const found = yield* Stream.merge(changed, Stream.tick("1 minute")).pipe(
      Stream.mapEffect(() => recordOf(instanceId)),
      Stream.filter(ready),
      Stream.runHead,
    );
    return found._tag === "Some" ? found.value : undefined;
  });

  const ask = (record: SandboxRecord, reason: "ask" | "work") =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        provisioner.setSettlePending(record.instanceId, {
          since: DateTime.formatIso(now),
          reason,
        }),
      ),
    );

  const deleteWhenClean = Effect.fn("SandboxSettle.deleteWhenClean")(function* (
    record: SandboxRecord,
    threadId: ThreadId,
  ) {
    yield* Effect.sleep(SETTLE_DELETE_DELAY);
    if (!(yield* stillSettled(threadId))) return;
    const current = yield* recordOf(record.instanceId);
    if (current === undefined) return;
    if (current.state !== "running") return yield* ask(current, "work");
    const work = yield* provisioner.checkWork({ instanceId: current.instanceId });
    if (work.status !== "clean") return yield* ask(current, "work");
    // The check takes seconds; an un-settle meanwhile still keeps the sandbox.
    if (!(yield* stillSettled(threadId))) return;
    yield* provisioner.delete({
      provider: current.provider,
      sandboxId: current.sandboxId,
      instanceId: current.instanceId,
    });
  });

  const applyOnSettle = Effect.fn("SandboxSettle.applyOnSettle")(
    function* (instanceId: string, threadId: ThreadId) {
      const record = yield* afterStarting(instanceId);
      if (record === undefined || !(yield* stillSettled(threadId))) return;
      const { configs } = yield* provisioner.configs;
      const action = configs.find((config) => config.id === record.configId)?.onSettle ?? "ask";
      switch (record.state) {
        case "running":
        case "error":
          break;
        case "stopped":
          // Already what a snapshot keeps; a stopped machine's work cannot be checked.
          if (action === "snapshot") return;
          return yield* ask(record, action === "delete" ? "work" : "ask");
        default:
          return;
      }
      if (action === "ask") return yield* ask(record, "ask");
      if (action === "snapshot") {
        return yield* provisioner
          .stop({ instanceId: record.instanceId })
          .pipe(Effect.catch(() => ask(record, "ask")));
      }
      if (record.state !== "running") return yield* ask(record, "work");
      yield* deleteWhenClean(record, threadId).pipe(Effect.catch(() => ask(record, "work")));
    },
    (effect, instanceId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not apply a sandbox's on-settle", { instanceId, cause }),
        ),
      ),
  );

  const unsettled = Effect.fn("SandboxSettle.unsettled")(function* (threadId: ThreadId) {
    handledSettles.delete(threadId);
    const record = yield* chatSandbox(threadId);
    if (record === undefined) return;
    yield* FiberMap.remove(inHand, record.instanceId);
    yield* provisioner.setSettlePending(record.instanceId, undefined);
  });

  // Runs for every domain event; all but settles and un-settles return at once.
  const handle: SandboxSettle["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      switch (event.type) {
        case "thread.settled": {
          const settledAt =
            event.payload.settledAt === null ? 0 : DateTime.toEpochMillis(event.payload.settledAt);
          if (handledSettles.get(event.threadId) === settledAt) return;
          handledSettles.set(event.threadId, settledAt);
          const record = yield* chatSandbox(event.threadId);
          if (record === undefined) return;
          yield* FiberMap.run(
            inHand,
            record.instanceId,
            applyOnSettle(record.instanceId, event.threadId),
          );
          return;
        }
        case "thread.unsettled":
        case "thread.pinned":
          if (event.payload.settledOverride === "settled") return;
          return yield* unsettled(event.threadId);
        default:
          return;
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not follow a sandbox chat's settle", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const resolve: SandboxSettle["Service"]["resolve"] = Effect.fn("SandboxSettle.resolve")(
    function* (input) {
      yield* FiberMap.remove(inHand, input.instanceId);
      const record = yield* recordOf(input.instanceId);
      if (record === undefined) return { warnings: [] };
      if (input.choice === "keep") {
        yield* provisioner.setSettlePending(record.instanceId, undefined);
        return { warnings: [] };
      }
      return yield* provisioner.delete({
        provider: record.provider,
        sandboxId: record.sandboxId,
        instanceId: record.instanceId,
      });
    },
  );

  const start: SandboxSettle["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("sandbox settle event stream failed", { cause }),
        ),
      ),
    );

  return SandboxSettle.of({ start, handle, resolve, drain: FiberMap.awaitEmpty(inHand) });
});

export const layer = Layer.effect(SandboxSettle, make);
