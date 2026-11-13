import type {
  OrchestrationV2DomainEvent,
  SandboxProviderError,
  SandboxRecord,
  SandboxResolveSettleInput,
  SandboxResolveSettleResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as SandboxMirror from "./SandboxMirror.ts";
import * as SandboxProvisioner from "./SandboxProvisioner.ts";

/** How long a remembered delete waits after a settle, so the settle's Undo still keeps everything. */
const SETTLE_DELETE_DELAY = "10 seconds";

const isStarting = (record: SandboxRecord) =>
  record.state === "provisioning" || record.resumingSince !== undefined;

/** Names one settle of a thread: its `settledAt`, which settling it again keeps. */
const settleOf = (settledAt: DateTime.Utc | null) =>
  settledAt === null ? "unknown" : DateTime.formatIso(settledAt);

/**
 * A settle is about the sandbox the chat had then. The bridge settles a chat whose sandbox went,
 * and a relaunch's new sandbox for the same thread must not take that settle as its own.
 */
const launchedBefore = (record: SandboxRecord, settledAt: DateTime.Utc | null) =>
  settledAt === null || !(Date.parse(record.createdAt) > DateTime.toEpochMillis(settledAt));

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
    /**
     * Applies the settles this host missed, such as one a restart cut short: a settled chat whose
     * sandbox is alive, with no decision pending and no record of that settle being applied.
     */
    readonly reconcile: Effect.Effect<void>;
    readonly resolve: (
      input: SandboxResolveSettleInput,
    ) => Effect.Effect<SandboxResolveSettleResult, SandboxProviderError>;
    /** Waits for the settles still in hand: a delete's undo window, or a sandbox still starting. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/sandbox/SandboxSettle") {}

const make = Effect.gen(function* () {
  const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const mirror = yield* SandboxMirror.SandboxMirror;
  // Keyed by instance: an un-settle, a newer settle, or the user's answer replaces what waits.
  const inHand = yield* FiberMap.make<string, void, never>();
  // The settle each thread was last handled for. Settling a settled chat again keeps its time.
  const handledSettles = new Map<ThreadId, string>();

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

  // Each outcome but a delete marks the settle applied, in the write that records it.
  const ask = (record: SandboxRecord, reason: "ask" | "work", settle: string) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        provisioner.setSettlePending(
          record.instanceId,
          { since: DateTime.formatIso(now), reason },
          settle,
        ),
      ),
    );
  const applied = (record: SandboxRecord, settle: string) =>
    provisioner.setSettlePending(record.instanceId, undefined, settle);

  const deleteWhenClean = Effect.fn("SandboxSettle.deleteWhenClean")(function* (
    record: SandboxRecord,
    threadId: ThreadId,
    settle: string,
  ) {
    yield* Effect.sleep(SETTLE_DELETE_DELAY);
    if (!(yield* stillSettled(threadId))) return;
    const current = yield* recordOf(record.instanceId);
    if (current === undefined) return;
    if (current.state !== "running") return yield* ask(current, "work", settle);
    // A settle says nothing of the agents: the sandbox thread, its tasks, or a sub-sandbox task the
    // host runs for it may still work. A sandbox that does not answer may too.
    const host = yield* orchestrator.getThreadRecords(threadId, ["runs", "subagents"]);
    if (SandboxMirror.hasLiveWork(host)) return yield* ask(current, "work", settle);
    if ((yield* mirror.activity(threadId)) !== "idle") return yield* ask(current, "work", settle);
    const work = yield* provisioner.checkWork({ instanceId: current.instanceId });
    if (work.status !== "clean") return yield* ask(current, "work", settle);
    // The check takes seconds; an un-settle meanwhile still keeps the sandbox.
    if (!(yield* stillSettled(threadId))) return;
    yield* provisioner.delete({
      provider: current.provider,
      sandboxId: current.sandboxId,
      instanceId: current.instanceId,
    });
  });

  const applyOnSettle = Effect.fn("SandboxSettle.applyOnSettle")(
    function* (instanceId: string, threadId: ThreadId, settle: string) {
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
          if (action === "snapshot") return yield* applied(record, settle);
          return yield* ask(record, action === "delete" ? "work" : "ask", settle);
        default:
          return;
      }
      if (action === "ask") return yield* ask(record, "ask", settle);
      if (action === "snapshot") {
        return yield* provisioner.stop({ instanceId: record.instanceId }).pipe(
          Effect.andThen(applied(record, settle)),
          Effect.catch(() => ask(record, "ask", settle)),
        );
      }
      if (record.state !== "running") return yield* ask(record, "work", settle);
      yield* deleteWhenClean(record, threadId, settle).pipe(
        Effect.catch(() => ask(record, "work", settle)),
      );
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
          const settle = settleOf(event.payload.settledAt);
          if (handledSettles.get(event.threadId) === settle) return;
          handledSettles.set(event.threadId, settle);
          const record = yield* chatSandbox(event.threadId);
          if (record === undefined || !launchedBefore(record, event.payload.settledAt)) return;
          yield* FiberMap.run(
            inHand,
            record.instanceId,
            applyOnSettle(record.instanceId, event.threadId, settle),
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

  // A card on another device, or a click in flight, can answer after the chat was un-settled or
  // the question answered elsewhere; only a question still waiting on a settled chat is answered.
  const resolve: SandboxSettle["Service"]["resolve"] = Effect.fn("SandboxSettle.resolve")(
    function* (input) {
      const record = yield* recordOf(input.instanceId);
      if (
        record?.settlePending === undefined ||
        record.threadId === undefined ||
        !(yield* stillSettled(record.threadId).pipe(Effect.orDie))
      ) {
        return { warnings: [], resolved: false };
      }
      yield* FiberMap.remove(inHand, input.instanceId);
      if (input.choice === "keep") {
        // Keep is a snapshot on every client: a running sandbox stops, and its disk is kept.
        if (record.state === "running") yield* provisioner.stop({ instanceId: record.instanceId });
        yield* provisioner.setSettlePending(record.instanceId, undefined);
        return { warnings: [], resolved: true };
      }
      const deleted = yield* provisioner.delete({
        provider: record.provider,
        sandboxId: record.sandboxId,
        instanceId: record.instanceId,
      });
      return { ...deleted, resolved: true };
    },
  );

  const reconcile: SandboxSettle["Service"]["reconcile"] = Effect.gen(function* () {
    const { sandboxes } = yield* provisioner.list;
    for (const record of sandboxes) {
      const threadId = record.threadId;
      if (threadId === undefined || record.settlePending !== undefined) continue;
      if (record.state === "deleted" || record.state === "expired") continue;
      if (yield* FiberMap.has(inHand, record.instanceId)) continue;
      const shell = yield* orchestrator.getThreadShell(threadId);
      if (shell?.settledOverride !== "settled" || !launchedBefore(record, shell.settledAt))
        continue;
      const settle = settleOf(shell.settledAt);
      if (record.settleHandled === settle) continue;
      handledSettles.set(threadId, settle);
      yield* FiberMap.run(
        inHand,
        record.instanceId,
        applyOnSettle(record.instanceId, threadId, settle),
      );
    }
  }).pipe(
    Effect.withSpan("SandboxSettle.reconcile"),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not reconcile sandbox chats' settles", { cause }),
    ),
  );

  // The minute's reconcile, like the provisioner's sweep, also retries a settle that failed.
  const start: SandboxSettle["Service"]["start"] = () =>
    forkParked(
      Effect.all(
        [
          Stream.runForEach(orchestrator.streamDomainEvents, handle).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("sandbox settle event stream failed", { cause }),
            ),
          ),
          reconcile.pipe(Effect.repeat(Schedule.spaced("1 minute"))),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );

  return SandboxSettle.of({
    start,
    handle,
    reconcile,
    resolve,
    drain: FiberMap.awaitEmpty(inHand),
  });
});

export const layer = Layer.effect(SandboxSettle, make);
