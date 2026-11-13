import { it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  SANDBOX_BRIDGE_INSTANCE_ID,
  type SandboxThreadMirror,
  type ServerProvider,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { SandboxBridgeError, type SandboxSession } from "@t3tools/sandbox-bridge";
import { bridgeLinkSecretName, type SandboxBridgeLink } from "@t3tools/sandbox-bridge/link";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SandboxMirror from "./SandboxMirror.ts";

const threadId = ThreadId.make("thread-on-sandbox");
const childThreadId = ThreadId.make("child-on-sandbox");
const at = DateTime.makeUnsafe("2026-11-13T10:00:00.000Z");

const link: SandboxBridgeLink = {
  threadId,
  instanceId: "sandbox-1",
  sandboxId: "bx_1",
  label: "hello on Boat",
  httpBaseUrl: "https://sandbox.example",
  sandboxProjectId: "project-remote",
  token: "bearer",
} as SandboxBridgeLink;

const claude = {
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  enabled: true,
  status: "ready",
  models: [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  ],
} as unknown as ServerProvider;

const opus = {
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "xhigh" }],
} as unknown as ModelSelection;

const run = (id: string, ordinal: number, status: string): OrchestrationV2Run =>
  ({
    id,
    ordinal,
    status,
    startedAt: status === "queued" ? null : at,
  }) as unknown as OrchestrationV2Run;

const subagent = (id: string, runId: string, status: string): OrchestrationV2Subagent =>
  ({
    id,
    threadId,
    runId,
    childThreadId,
    title: "Review the parser",
    status,
    updatedAt: at,
  }) as unknown as OrchestrationV2Subagent;

const pullRequest = (number: number, overrides: Partial<ThreadPullRequestLink> = {}) =>
  ({
    host: "github.com",
    repository: "acme/app",
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    source: "agent",
    linkedAt: "2026-11-13T10:00:00.000Z",
    snapshot: null,
    stack: null,
    ...overrides,
  }) as ThreadPullRequestLink;

const projection = (overrides: Partial<OrchestrationV2ThreadProjection> = {}) =>
  ({
    thread: { id: threadId, modelSelection: opus },
    runs: [],
    subagents: [],
    messages: [],
    ...overrides,
  }) as unknown as OrchestrationV2ThreadProjection;

const snapshot = (value: OrchestrationV2ThreadProjection) =>
  ({ kind: "snapshot", snapshotSequence: 1, projection: value }) as OrchestrationV2ThreadStreamItem;

const event = (type: string, payload: unknown) =>
  ({
    kind: "event",
    sequence: 2,
    event: { id: "event", threadId, occurredAt: at, type, payload },
  }) as unknown as OrchestrationV2ThreadStreamItem;

interface FakeSandbox {
  reachable: boolean;
  readonly projections: Map<string, OrchestrationV2ThreadProjection>;
  readonly items: Queue.Queue<OrchestrationV2ThreadStreamItem | "end" | "fail">;
  readonly dispatched: Array<OrchestrationV2Command>;
}

const makeHarness = Effect.gen(function* () {
  const sandbox: FakeSandbox = {
    reachable: true,
    projections: new Map([[threadId, projection()]]),
    items: yield* Queue.unbounded<OrchestrationV2ThreadStreamItem | "end" | "fail">(),
    dispatched: [],
  };
  const hostCommands: Array<Record<string, unknown>> = [];
  const secrets = new Map<string, Uint8Array>([
    [bridgeLinkSecretName(threadId), new TextEncoder().encode(JSON.stringify(link))],
  ]);
  const connect: SandboxMirror.SandboxConnect = () =>
    sandbox.reachable
      ? Effect.succeed({
          threadStop: true,
          defaultModelSelection: null,
          providers: [claude],
          projection: (id: ThreadId) =>
            Effect.succeed(Option.fromUndefinedOr(sandbox.projections.get(id))),
          dispatch: (command: OrchestrationV2Command) =>
            Effect.sync(() => {
              sandbox.dispatched.push(command);
            }),
          subscribe: () =>
            Stream.fromQueue(sandbox.items).pipe(
              Stream.takeWhile((item) => item !== "end"),
              Stream.mapEffect((item) =>
                item === "fail"
                  ? Effect.fail(
                      new SandboxBridgeError({ message: "Lost the sandbox's thread stream." }),
                    )
                  : Effect.succeed(item as OrchestrationV2ThreadStreamItem),
              ),
            ),
        } as unknown as SandboxSession)
      : Effect.fail(new SandboxBridgeError({ message: "Sandbox bx_1 did not answer." }));
  const layer = SandboxMirror.layerWith(connect).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ServerSecretStore.ServerSecretStore, {
          get: (name: string) => Effect.succeed(Option.fromUndefinedOr(secrets.get(name))),
        } as unknown as ServerSecretStore.ServerSecretStore["Service"]),
        Layer.succeed(Orchestrator.OrchestratorV2, {
          getThreadShell: (id: ThreadId) =>
            Effect.succeed(
              id === threadId
                ? {
                    id,
                    modelSelection: { instanceId: SANDBOX_BRIDGE_INSTANCE_ID, model: "sandbox" },
                  }
                : null,
            ),
          dispatch: (command: Record<string, unknown>) =>
            Effect.sync(() => {
              hostCommands.push(command);
              return { sequence: 1 };
            }),
        } as unknown as Orchestrator.OrchestratorV2["Service"]),
        NodeCrypto.layer,
      ),
    ),
  );
  return { sandbox, hostCommands, secrets, layer };
});

/** Follows the mirror into a queue the test takes views from. */
const follow = (id: ThreadId) =>
  Effect.gen(function* () {
    const mirror = yield* SandboxMirror.SandboxMirror;
    const views = yield* Queue.unbounded<SandboxThreadMirror>();
    yield* mirror.subscribe(id).pipe(
      Stream.runForEach((view) => Queue.offer(views, view)),
      Effect.forkScoped,
    );
    return views;
  });

describe("SandboxMirror", () => {
  it.effect("shows the sandbox thread's provider, selection and agents, as they change", () =>
    Effect.gen(function* () {
      const { sandbox, layer } = yield* makeHarness;
      yield* Effect.gen(function* () {
        const views = yield* follow(threadId);
        yield* Queue.offer(
          sandbox.items,
          snapshot(projection({ runs: [run("run-1", 1, "running")] })),
        );
        const first = yield* Queue.take(views);
        expect(first).toMatchObject({ available: true, modelSelection: opus, subagents: [] });
        expect(first.provider?.instanceId).toBe("claudeAgent");

        yield* Queue.offer(
          sandbox.items,
          event("subagent.updated", subagent("agent-1", "run-1", "running")),
        );
        // Streamed text changes nothing the mirror shows, so it sends nothing.
        yield* Queue.offer(
          sandbox.items,
          event("message.updated", { id: "message-1", text: "Hi" }),
        );
        yield* Queue.offer(
          sandbox.items,
          event("subagent.updated", subagent("agent-1", "run-1", "completed")),
        );
        expect((yield* Queue.take(views)).subagents.map((agent) => agent.status)).toEqual([
          "running",
        ]);
        expect((yield* Queue.take(views)).subagents.map((agent) => agent.status)).toEqual([
          "completed",
        ]);

        const sonnet = { instanceId: "claudeAgent", model: "claude-sonnet-5-5" } as ModelSelection;
        yield* Queue.offer(
          sandbox.items,
          event("thread.model-selection-updated", { id: threadId, modelSelection: sonnet }),
        );
        expect((yield* Queue.take(views)).modelSelection).toEqual(sonnet);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("shows the sandbox thread's branch and linked pull requests, not its watches", () =>
    Effect.gen(function* () {
      const { sandbox, layer } = yield* makeHarness;
      yield* Effect.gen(function* () {
        const views = yield* follow(threadId);
        const watched = pullRequest(48, {
          watch: { startedAt: "2026-11-13T10:00:00.000Z" } as ThreadPullRequestLink["watch"],
        });
        const thread = {
          id: threadId,
          modelSelection: opus,
          branch: "fix/one",
          pullRequests: [watched, pullRequest(47, { source: "stack-dismissed" })],
        };
        yield* Queue.offer(
          sandbox.items,
          snapshot(projection({ thread } as unknown as Partial<OrchestrationV2ThreadProjection>)),
        );
        const first = yield* Queue.take(views);
        expect(first.branch).toBe("fix/one");
        expect(first.pullRequests).toEqual([pullRequest(48)]);

        // A thread event that changes neither sends nothing.
        yield* Queue.offer(sandbox.items, event("thread.visited", thread));
        yield* Queue.offer(
          sandbox.items,
          event("thread.pull-request-synced", {
            ...thread,
            pullRequests: [watched, pullRequest(49)],
          }),
        );
        expect((yield* Queue.take(views)).pullRequests?.map((link) => link.number)).toEqual([
          48, 49,
        ]);

        const synced = pullRequest(49, {
          snapshot: { state: "merged", title: "Ship it" } as ThreadPullRequestLink["snapshot"],
        });
        yield* Queue.offer(sandbox.items, event("thread.pull-request-link-updated", synced));
        expect((yield* Queue.take(views)).pullRequests?.[1]).toEqual(synced);

        yield* Queue.offer(
          sandbox.items,
          event("thread.metadata-updated", {
            ...thread,
            branch: "fix/two",
            pullRequests: [watched, synced],
          }),
        );
        const moved = yield* Queue.take(views);
        expect(moved.branch).toBe("fix/two");
        expect(moved.pullRequests).toEqual([pullRequest(48), synced]);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("keeps only the runs the agents' turn is told from", () =>
    Effect.sync(() => {
      const runs = [
        run("run-1", 1, "completed"),
        run("run-2", 2, "completed"),
        run("run-3", 3, "rolled_back"),
        run("run-4", 4, "completed"),
        run("run-5", 5, "queued"),
      ];
      const kept = SandboxMirror.mirrorRuns(runs, [subagent("agent-1", "run-2", "completed")]);
      // Its agents' run, the latest started one, and any still to finish.
      expect(kept.map((candidate) => candidate.id)).toEqual(["run-2", "run-4", "run-5"]);
    }),
  );

  it.effect(
    "shows a stopped sandbox as not available with what it last read, until it answers",
    () =>
      Effect.gen(function* () {
        const { sandbox, layer } = yield* makeHarness;
        yield* Effect.gen(function* () {
          const views = yield* follow(threadId);
          yield* Queue.offer(sandbox.items, snapshot(projection()));
          expect((yield* Queue.take(views)).available).toBe(true);

          sandbox.reachable = false;
          yield* Queue.offer(sandbox.items, "fail");
          const stopped = yield* Queue.take(views);
          expect(stopped).toMatchObject({ available: false, modelSelection: opus });
          expect(stopped.provider?.instanceId).toBe("claudeAgent");

          // A pick made meanwhile shows at once; the sandbox gets it with the next message.
          const mirror = yield* SandboxMirror.SandboxMirror;
          yield* mirror.setModelSelection({
            threadId,
            modelSelection: {
              instanceId: SANDBOX_BRIDGE_INSTANCE_ID,
              model: "claude-sonnet-5-5",
            } as ModelSelection,
          });
          expect((yield* Queue.take(views)).modelSelection).toEqual({
            instanceId: "claudeAgent",
            model: "claude-sonnet-5-5",
          });

          sandbox.reachable = true;
          yield* TestClock.adjust(SandboxMirror.RECONNECT_SPACING);
          yield* Queue.offer(sandbox.items, snapshot(projection()));
          expect((yield* Queue.take(views)).available).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.effect("shows a thread with no sandbox link as not available", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness;
      yield* Effect.gen(function* () {
        const views = yield* follow(ThreadId.make("thread-elsewhere"));
        expect(yield* Queue.take(views)).toEqual({
          available: false,
          provider: null,
          modelSelection: null,
          runs: [],
          subagents: [],
          branch: null,
          pullRequests: [],
        });
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("sets a pick on the sandbox thread's own provider and on the mirror", () =>
    Effect.gen(function* () {
      const { sandbox, hostCommands, layer } = yield* makeHarness;
      const mirror = yield* SandboxMirror.SandboxMirror.pipe(Effect.provide(layer));
      const pick = {
        instanceId: SANDBOX_BRIDGE_INSTANCE_ID,
        model: "claude-sonnet-5-5",
        options: [{ id: "effort", value: "high" }],
      } as unknown as ModelSelection;
      expect(yield* mirror.setModelSelection({ threadId, modelSelection: pick })).toEqual({
        sandboxUpdated: true,
      });
      expect(sandbox.dispatched).toMatchObject([
        {
          type: "thread.model-selection.set",
          threadId,
          modelSelection: { ...pick, instanceId: "claudeAgent" },
        },
      ]);
      expect(hostCommands).toMatchObject([
        { type: "thread.model-selection.set", threadId, modelSelection: pick },
      ]);
    }),
  );

  it.effect("leaves a pick for the bridge to hand over when the sandbox is stopped", () =>
    Effect.gen(function* () {
      const { sandbox, hostCommands, layer } = yield* makeHarness;
      sandbox.reachable = false;
      const mirror = yield* SandboxMirror.SandboxMirror.pipe(Effect.provide(layer));
      const pick = {
        instanceId: SANDBOX_BRIDGE_INSTANCE_ID,
        model: "claude-sonnet-5-5",
      } as ModelSelection;
      expect(yield* mirror.setModelSelection({ threadId, modelSelection: pick })).toEqual({
        sandboxUpdated: false,
      });
      expect(hostCommands).toMatchObject([
        { type: "thread.model-selection.set", modelSelection: pick },
      ]);
    }),
  );

  it.effect("says whether the sandbox thread or its tasks still run, or that it cannot tell", () =>
    Effect.gen(function* () {
      const { sandbox, secrets, layer } = yield* makeHarness;
      const mirror = yield* SandboxMirror.SandboxMirror.pipe(Effect.provide(layer));
      sandbox.projections.set(
        threadId,
        projection({ runs: [run("run-1", 1, "completed")], subagents: [] }),
      );
      expect(yield* mirror.activity(threadId)).toBe("idle");
      sandbox.projections.set(
        threadId,
        projection({
          runs: [run("run-1", 1, "completed")],
          subagents: [subagent("task-1", "run-1", "running")],
        }),
      );
      expect(yield* mirror.activity(threadId)).toBe("busy");
      sandbox.projections.set(threadId, projection({ runs: [run("run-2", 2, "queued")] }));
      expect(yield* mirror.activity(threadId)).toBe("busy");
      sandbox.reachable = false;
      expect(yield* mirror.activity(threadId)).toBe("unknown");
      sandbox.reachable = true;
      secrets.clear();
      expect(yield* mirror.activity(threadId)).toBe("unknown");
    }),
  );

  it.effect("refuses a model the sandbox does not offer, changing neither thread", () =>
    Effect.gen(function* () {
      const { sandbox, hostCommands, layer } = yield* makeHarness;
      const mirror = yield* SandboxMirror.SandboxMirror.pipe(Effect.provide(layer));
      const error = yield* mirror
        .setModelSelection({
          threadId,
          modelSelection: {
            instanceId: SANDBOX_BRIDGE_INSTANCE_ID,
            model: "gpt-9",
          } as ModelSelection,
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("SandboxProviderError");
      // The mirror reads no sandbox record, so it names no provider rather than a wrong one.
      expect(error.provider).toBeUndefined();
      expect(error.message).toBe("The sandbox does not offer that model for this chat.");
      expect(sandbox.dispatched).toEqual([]);
      expect(hostCommands).toEqual([]);
    }),
  );

  it.effect("reads an agent's messages, only for an agent of this chat", () =>
    Effect.gen(function* () {
      const { sandbox, layer } = yield* makeHarness;
      sandbox.projections.set(
        threadId,
        projection({ subagents: [subagent("agent-1", "run-1", "running")] }),
      );
      sandbox.projections.set(
        childThreadId,
        projection({
          messages: [
            { id: "m-1", role: "user", text: "Review the parser", createdAt: at },
            { id: "m-2", role: "assistant", text: "Looking at it.", createdAt: at },
          ] as unknown as OrchestrationV2ThreadProjection["messages"],
        }),
      );
      const mirror = yield* SandboxMirror.SandboxMirror.pipe(Effect.provide(layer));
      const child = yield* mirror.readChild({ threadId, childThreadId });
      expect(child.available).toBe(true);
      expect(child.messages.map((message) => message.text)).toEqual([
        "Review the parser",
        "Looking at it.",
      ]);
      const stranger = yield* mirror
        .readChild({ threadId, childThreadId: ThreadId.make("not-an-agent") })
        .pipe(Effect.flip);
      expect(stranger._tag).toBe("SandboxProviderError");

      sandbox.reachable = false;
      expect(yield* mirror.readChild({ threadId, childThreadId })).toEqual({
        available: false,
        messages: [],
      });
    }),
  );
});
