import {
  SANDBOX_SETUP_DETAIL_MAX_LENGTH,
  SANDBOX_SETUP_ERROR_MAX_LENGTH,
  SANDBOX_SETUP_STAGE_ORDER,
  type SandboxProviderKind,
  type SandboxSetupRecovery,
  type SandboxSetupSnapshot,
  type SandboxSetupStage,
  type SandboxSetupStageId,
  type ThreadId,
  type WorktreeSetupStageStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

// A finished launch's card stays this long so the client can show the result. A failed one stays
// until it is retried or dismissed, since its card holds the way to retry.
const FINISHED_RETENTION = "30 seconds";

const clamp = (text: string, maxLength: number) =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const emptyStage = (id: SandboxSetupStageId): SandboxSetupStage => ({
  id,
  status: "pending",
  startedAt: null,
  endedAt: null,
  detail: null,
});

export interface SandboxLaunchTracker {
  readonly begin: (input: {
    readonly threadId: ThreadId;
    readonly instanceId: string;
    readonly configId: string;
    readonly label: string;
    readonly provider: SandboxProviderKind;
  }) => Effect.Effect<void>;
  readonly stage: (
    threadId: ThreadId,
    id: SandboxSetupStageId,
    status: WorktreeSetupStageStatus,
    detail?: string | null,
  ) => Effect.Effect<void>;
  readonly warn: (threadId: ThreadId, warning: string) => Effect.Effect<void>;
  readonly update: (
    threadId: ThreadId,
    patch: Partial<Pick<SandboxSetupSnapshot, "phase" | "error" | "recovery" | "awaitingHandoff">>,
  ) => Effect.Effect<void>;
  /** Ends the launch; a running stage takes the outcome. */
  readonly finish: (
    threadId: ThreadId,
    phase: "done" | "failed" | "cancelled",
    options?: { readonly error?: string; readonly recovery?: SandboxSetupRecovery | null },
  ) => Effect.Effect<void>;
  readonly remove: (threadId: ThreadId) => Effect.Effect<void>;
  readonly get: (threadId: ThreadId) => Effect.Effect<SandboxSetupSnapshot | null>;
  readonly stream: (threadId: ThreadId) => Stream.Stream<SandboxSetupSnapshot | null>;
}

export const makeSandboxLaunchTracker = Effect.gen(function* () {
  const launches = yield* Ref.make(new Map<ThreadId, SandboxSetupSnapshot>());
  const changes = yield* PubSub.unbounded<{
    readonly threadId: ThreadId;
    readonly snapshot: SandboxSetupSnapshot | null;
  }>();
  const retention = new Map<ThreadId, Fiber.Fiber<void>>();
  // Sequences keep rising across launches of one thread, so a subscriber accepts the next one.
  const lastSequence = new Map<ThreadId, number>();

  const publish = (threadId: ThreadId, snapshot: SandboxSetupSnapshot | null) =>
    PubSub.publish(changes, { threadId, snapshot }).pipe(Effect.asVoid);

  const clearRetention = (threadId: ThreadId) => {
    const fiber = retention.get(threadId);
    retention.delete(threadId);
    return fiber === undefined ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.ignore);
  };

  const modify = (
    threadId: ThreadId,
    mutate: (snapshot: SandboxSetupSnapshot, at: string) => SandboxSetupSnapshot,
  ) =>
    nowIso.pipe(
      Effect.flatMap((at) =>
        Ref.modify(launches, (current) => {
          const existing = current.get(threadId);
          if (existing === undefined) return [null, current] as const;
          const next = { ...mutate(existing, at), sequence: existing.sequence + 1 };
          lastSequence.set(threadId, next.sequence);
          return [next, new Map(current).set(threadId, next)] as const;
        }),
      ),
      Effect.flatMap((snapshot) => (snapshot === null ? Effect.void : publish(threadId, snapshot))),
    );

  const remove: SandboxLaunchTracker["remove"] = (threadId) =>
    clearRetention(threadId).pipe(
      Effect.andThen(
        Ref.update(launches, (current) => {
          if (!current.has(threadId)) return current;
          const next = new Map(current);
          next.delete(threadId);
          return next;
        }),
      ),
      Effect.andThen(publish(threadId, null)),
      Effect.tap(() => Effect.sync(() => lastSequence.delete(threadId))),
    );

  const begin: SandboxLaunchTracker["begin"] = Effect.fn("SandboxLaunchTracker.begin")(
    function* (input) {
      yield* clearRetention(input.threadId);
      const snapshot: SandboxSetupSnapshot = {
        threadId: input.threadId,
        instanceId: input.instanceId,
        configId: input.configId,
        label: input.label,
        provider: input.provider,
        phase: "running",
        startedAt: yield* nowIso,
        endedAt: null,
        stages: SANDBOX_SETUP_STAGE_ORDER.map(emptyStage),
        warnings: [],
        error: null,
        recovery: null,
        awaitingHandoff: false,
        sequence: (lastSequence.get(input.threadId) ?? -1) + 1,
      };
      lastSequence.set(input.threadId, snapshot.sequence);
      yield* Ref.update(launches, (current) => new Map(current).set(input.threadId, snapshot));
      yield* publish(input.threadId, snapshot);
    },
  );

  const stage: SandboxLaunchTracker["stage"] = (threadId, id, status, detail) =>
    modify(threadId, (snapshot, at) => ({
      ...snapshot,
      stages: snapshot.stages.map((entry) => {
        if (entry.id !== id) return entry;
        const running = status === "running" || status === "pending";
        return {
          ...entry,
          status,
          // A stage that runs again, after a retry, times its new attempt.
          startedAt:
            status === "pending" ? null : status === "running" ? at : (entry.startedAt ?? at),
          endedAt: running ? null : at,
          ...(detail === undefined
            ? {}
            : {
                detail: detail === null ? null : clamp(detail, SANDBOX_SETUP_DETAIL_MAX_LENGTH),
              }),
        };
      }),
    }));

  const warn: SandboxLaunchTracker["warn"] = (threadId, warning) =>
    modify(threadId, (snapshot) => ({
      ...snapshot,
      warnings: [...snapshot.warnings, clamp(warning, SANDBOX_SETUP_DETAIL_MAX_LENGTH)],
    }));

  const update: SandboxLaunchTracker["update"] = (threadId, patch) =>
    modify(threadId, (snapshot) => ({
      ...snapshot,
      ...patch,
      ...(patch.error === undefined || patch.error === null
        ? {}
        : { error: clamp(patch.error, SANDBOX_SETUP_ERROR_MAX_LENGTH) }),
    }));

  const finish: SandboxLaunchTracker["finish"] = Effect.fn("SandboxLaunchTracker.finish")(
    function* (threadId, phase, options = {}) {
      yield* modify(threadId, (snapshot, at) => ({
        ...snapshot,
        phase,
        endedAt: at,
        awaitingHandoff: false,
        error:
          options.error === undefined ? null : clamp(options.error, SANDBOX_SETUP_ERROR_MAX_LENGTH),
        recovery: options.recovery ?? null,
        stages: snapshot.stages.map((entry) =>
          entry.status === "running"
            ? {
                ...entry,
                status: phase === "done" ? "done" : phase === "cancelled" ? "skipped" : "failed",
                endedAt: at,
              }
            : entry,
        ),
      }));
      if (phase === "failed") return;
      yield* clearRetention(threadId);
      const fiber = yield* remove(threadId).pipe(
        Effect.delay(FINISHED_RETENTION),
        Effect.forkDetach,
      );
      retention.set(threadId, fiber);
    },
  );

  const get: SandboxLaunchTracker["get"] = (threadId) =>
    Ref.get(launches).pipe(Effect.map((current) => current.get(threadId) ?? null));

  // A one-slot sliding mailbox keeps a slow socket on the newest snapshot.
  const stream: SandboxLaunchTracker["stream"] = (threadId) =>
    Stream.callback<SandboxSetupSnapshot | null>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const initial = yield* get(threadId);
          let sequence = initial?.sequence ?? -1;
          Queue.offerUnsafe(mailbox, initial);
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((change) =>
              Effect.sync(() => {
                if (change.threadId !== threadId) return;
                if (change.snapshot !== null && change.snapshot.sequence <= sequence) return;
                sequence = change.snapshot?.sequence ?? -1;
                Queue.offerUnsafe(mailbox, change.snapshot);
              }),
            ),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  return { begin, stage, warn, update, finish, remove, get, stream } satisfies SandboxLaunchTracker;
});
