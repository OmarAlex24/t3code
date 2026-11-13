import { it } from "@effect/vitest";
import {
  type OrchestrationV2DomainEvent,
  ProjectId,
  type SandboxCheckWorkResult,
  type SandboxEnvironmentConfig,
  type SandboxRecord,
  type SandboxSettleAction,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SandboxProvisioner from "./SandboxProvisioner.ts";
import * as SandboxSettle from "./SandboxSettle.ts";
import type { SandboxLaunchLifecycle } from "./sandboxLaunches.ts";

const threadId = ThreadId.make("thread-chat");

const record = (overrides: Partial<SandboxRecord> = {}): SandboxRecord =>
  ({
    instanceId: "sandbox-1",
    environmentId: "environment-sandbox-1",
    configId: "config-1",
    provider: "boat",
    sandboxId: "bx_1",
    label: "hello on Boat",
    state: "running",
    threadId,
    hostProjectId: ProjectId.make("project-host"),
    ...overrides,
  }) as SandboxRecord;

interface Harness {
  records: Array<SandboxRecord>;
  onSettle: SandboxSettleAction | undefined;
  work: SandboxCheckWorkResult["status"];
  settled: boolean;
  stops: Array<string>;
  deletes: Array<string>;
  checks: number;
  listChanges: Queue.Queue<number>;
  lifecycle: Queue.Queue<SandboxLaunchLifecycle>;
}

const settleEvent = (settledAt = "2026-11-13T10:00:00.000Z") =>
  ({
    type: "thread.settled",
    threadId,
    payload: {
      id: threadId,
      settledOverride: "settled",
      settledAt: DateTime.makeUnsafe(settledAt),
    },
  }) as unknown as OrchestrationV2DomainEvent;

const unsettleEvent = (type: "thread.unsettled" | "thread.pinned" = "thread.unsettled") =>
  ({
    type,
    threadId,
    payload: { id: threadId, settledOverride: "active", settledAt: null },
  }) as unknown as OrchestrationV2DomainEvent;

const withHarness = <A, E>(
  body: (harness: Harness) => Effect.Effect<A, E, SandboxSettle.SandboxSettle>,
) =>
  Effect.gen(function* () {
    const harness: Harness = {
      records: [record()],
      onSettle: undefined,
      work: "clean",
      settled: true,
      stops: [],
      deletes: [],
      checks: 0,
      listChanges: yield* Queue.unbounded<number>(),
      lifecycle: yield* Queue.unbounded<SandboxLaunchLifecycle>(),
    };
    const update = (instanceId: string, change: (current: SandboxRecord) => SandboxRecord) => {
      harness.records = harness.records.map((current) =>
        current.instanceId === instanceId ? change(current) : current,
      );
    };
    const provisioner: Partial<SandboxProvisioner.SandboxProvisioner["Service"]> = {
      list: Effect.sync(() => ({ sandboxes: harness.records, orphans: [] })),
      configs: Effect.sync(() => ({
        configs: [
          {
            id: "config-1",
            ...(harness.onSettle === undefined ? {} : { onSettle: harness.onSettle }),
          } as SandboxEnvironmentConfig,
        ],
      })),
      stop: (input) =>
        Effect.sync(() => {
          harness.stops.push(input.instanceId);
          update(input.instanceId, (current) => ({ ...current, state: "stopped" }));
          return { sandbox: record({ state: "stopped" }) };
        }),
      checkWork: () =>
        Effect.sync(() => {
          harness.checks += 1;
          return { status: harness.work, uncommittedFiles: 0, unpushedCommits: 0 };
        }),
      delete: (input) =>
        Effect.sync(() => {
          harness.deletes.push(input.instanceId ?? input.sandboxId);
          harness.records = harness.records.filter(
            (current) => current.instanceId !== input.instanceId,
          );
          return { warnings: [] };
        }),
      setSettlePending: (instanceId, pending) =>
        Effect.sync(() => {
          update(instanceId, ({ settlePending: _settlePending, ...rest }) =>
            pending === undefined ? rest : { ...rest, settlePending: pending },
          );
          return true;
        }),
      listChanges: Stream.fromQueue(harness.listChanges),
      launchLifecycle: Stream.fromQueue(harness.lifecycle),
    };
    const orchestrator = {
      streamDomainEvents: Stream.empty,
      getThreadShell: () =>
        Effect.sync(() => ({
          id: threadId,
          settledOverride: harness.settled ? "settled" : "active",
        })),
    } as unknown as Orchestrator.OrchestratorV2["Service"];
    const layer = SandboxSettle.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(
            SandboxProvisioner.SandboxProvisioner,
            provisioner as SandboxProvisioner.SandboxProvisioner["Service"],
          ),
          Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
        ),
      ),
    );
    return yield* body(harness).pipe(Effect.provide(layer));
  });

const settle = (event = settleEvent()) =>
  Effect.gen(function* () {
    const service = yield* SandboxSettle.SandboxSettle;
    yield* service.handle(event);
    return service;
  });

const pendingOf = (harness: Harness) => harness.records[0]?.settlePending?.reason;

describe("SandboxSettle", () => {
  it.effect("asks when the config says nothing, and un-settling the chat clears the question", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const service = yield* settle();
        yield* service.drain;
        expect(pendingOf(harness)).toBe("ask");
        expect(harness.stops).toEqual([]);
        harness.settled = false;
        yield* service.handle(unsettleEvent());
        expect(harness.records[0]?.settlePending).toBeUndefined();
      }),
    ),
  );

  it.effect("stops a running sandbox whose config keeps a snapshot", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        harness.onSettle = "snapshot";
        const service = yield* settle();
        yield* service.drain;
        expect(harness.stops).toEqual(["sandbox-1"]);
        expect(pendingOf(harness)).toBeUndefined();
      }),
    ),
  );

  it.effect("decides once per settle, even when the settled chat is settled again", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const service = yield* settle();
        yield* service.drain;
        yield* service.resolve({ instanceId: "sandbox-1", choice: "keep" });
        // Settled again from another client: the thread keeps its settle time.
        yield* service.handle(settleEvent());
        yield* service.drain;
        expect(harness.records[0]?.settlePending).toBeUndefined();
      }),
    ),
  );

  it.effect("leaves a stopped snapshot as it is", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        harness.onSettle = "snapshot";
        harness.records = [record({ state: "stopped" })];
        const service = yield* settle();
        yield* service.drain;
        expect(harness.stops).toEqual([]);
        expect(pendingOf(harness)).toBeUndefined();
      }),
    ),
  );

  it.effect("deletes a clean sandbox only after the undo window", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        harness.onSettle = "delete";
        const service = yield* settle();
        yield* TestClock.adjust("9 seconds");
        expect(harness.checks).toBe(0);
        expect(harness.deletes).toEqual([]);
        yield* TestClock.adjust("1 second");
        yield* service.drain;
        expect(harness.checks).toBe(1);
        expect(harness.deletes).toEqual(["sandbox-1"]);
      }),
    ),
  );

  it.effect("deletes nothing when the chat is un-settled during the undo window", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        harness.onSettle = "delete";
        const service = yield* settle();
        yield* TestClock.adjust("5 seconds");
        harness.settled = false;
        yield* service.handle(unsettleEvent("thread.pinned"));
        yield* TestClock.adjust("10 seconds");
        yield* service.drain;
        expect(harness.checks).toBe(0);
        expect(harness.deletes).toEqual([]);
        expect(pendingOf(harness)).toBeUndefined();
      }),
    ),
  );

  it.effect("re-checks that the chat is still settled before it deletes", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        harness.onSettle = "delete";
        const service = yield* settle();
        // Un-settled where this server's event never arrived in time, such as a race.
        harness.settled = false;
        yield* TestClock.adjust("10 seconds");
        yield* service.drain;
        expect(harness.deletes).toEqual([]);
      }),
    ),
  );

  it.effect.each(["dirty", "unknown"] as const)(
    "asks instead of deleting when the work check is %s",
    (work) =>
      withHarness((harness) =>
        Effect.gen(function* () {
          harness.onSettle = "delete";
          harness.work = work;
          const service = yield* settle();
          yield* TestClock.adjust("10 seconds");
          yield* service.drain;
          expect(harness.deletes).toEqual([]);
          expect(pendingOf(harness)).toBe("work");
        }),
      ),
  );

  it.effect(
    "asks at once for a stopped sandbox whose config deletes, since nothing can check it",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          harness.onSettle = "delete";
          harness.records = [record({ state: "stopped" })];
          const service = yield* settle();
          yield* service.drain;
          expect(harness.checks).toBe(0);
          expect(harness.deletes).toEqual([]);
          expect(pendingOf(harness)).toBe("work");
        }),
      ),
  );

  it.effect("waits for a resuming sandbox to finish, then applies its config", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        harness.onSettle = "snapshot";
        harness.records = [record({ resumingSince: "2026-11-13T09:59:00.000Z" })];
        const service = yield* settle();
        yield* TestClock.adjust("1 second");
        expect(harness.stops).toEqual([]);
        // The resume ends, and the provisioner says the list changed.
        harness.records = [record()];
        yield* Queue.offer(harness.listChanges, 1);
        yield* service.drain;
        expect(harness.stops).toEqual(["sandbox-1"]);
      }),
    ),
  );

  it.effect("ignores a settle of a thread no sandbox belongs to", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        harness.records = [record({ threadId: ThreadId.make("thread-other") })];
        const service = yield* settle();
        yield* service.drain;
        expect(harness.records[0]?.settlePending).toBeUndefined();
      }),
    ),
  );

  it.effect("resolves a pending decision with delete or keep", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const service = yield* settle();
        yield* service.drain;
        expect(pendingOf(harness)).toBe("ask");
        yield* service.resolve({ instanceId: "sandbox-1", choice: "keep" });
        expect(harness.records[0]?.settlePending).toBeUndefined();
        expect(harness.records).toHaveLength(1);
        yield* service.resolve({ instanceId: "sandbox-1", choice: "delete" });
        expect(harness.deletes).toEqual(["sandbox-1"]);
      }),
    ),
  );
});
