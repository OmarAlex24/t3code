/**
 * A sandbox chat's own thread for the host's clients. The phone never pairs with a sandbox, so the
 * host reads that thread through the bridge's link and bearer: its real provider and selection for
 * the mirror's picker, its agents and delegated tasks and their messages, its branch and the pull
 * requests linked to it.
 */
import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadStreamItem,
  ProviderInstanceId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  type SandboxMirrorChild,
  type SandboxMirrorChildInput,
  SandboxProviderError,
  type SandboxSetThreadModelInput,
  type SandboxThreadMirror,
  type SandboxThreadMirrorInput,
  type ServerProvider,
  type ThreadId,
  type ThreadPullRequestLink,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  connectSandbox,
  type SandboxBridgeError,
  type SandboxSession,
} from "@t3tools/sandbox-bridge";
import {
  bridgeLinkSecretName,
  type SandboxBridgeLink,
  SandboxBridgeLinkJson,
} from "@t3tools/sandbox-bridge/link";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "../sourceControl/threadPullRequests.ts";

export type SandboxConnect = (
  link: SandboxBridgeLink,
) => Effect.Effect<SandboxSession, SandboxBridgeError, Scope.Scope>;

/** How often a mirror whose sandbox is stopped or not answering tries it again. */
export const RECONNECT_SPACING = "20 seconds";
// A stopped sandbox's address can hang instead of refusing.
const CONNECT_TIMEOUT = "15 seconds";

const bridgeInstanceId = ProviderInstanceId.make(SANDBOX_BRIDGE_INSTANCE_ID);

const ENDED_RUN = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const LIVE_SUBAGENT = new Set<OrchestrationV2Subagent["status"]>(["pending", "running", "waiting"]);

/** Whether a thread still has a run or a delegated task that has not ended, queued ones included. */
export const hasLiveWork = (records: {
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>;
  readonly subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status">>;
}) =>
  records.runs.some((run) => !ENDED_RUN.has(run.status)) ||
  records.subagents.some((subagent) => LIVE_SUBAGENT.has(subagent.status));

/** What a sandbox chat's own thread is doing; `unknown` when it could not be read. */
export type SandboxActivity = "idle" | "busy" | "unknown";

/**
 * The runs a client needs to tell the agents' turn (see `deriveThreadTurnSubagents`): the agents'
 * own runs, the latest one that started, and any still to finish. A long thread's other runs would
 * only make each update bigger.
 */
export const mirrorRuns = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
): ReadonlyArray<OrchestrationV2Run> => {
  const agentRuns = new Set(subagents.map((subagent) => subagent.runId));
  const latestStarted = runs.reduce<OrchestrationV2Run | null>(
    (latest, run) =>
      run.startedAt !== null &&
      run.status !== "rolled_back" &&
      (latest === null || run.ordinal > latest.ordinal)
        ? run
        : latest,
    null,
  );
  return runs.filter(
    (run) => agentRuns.has(run.id) || run === latestStarted || !ENDED_RUN.has(run.status),
  );
};

interface MirrorRecords {
  readonly modelSelection: ModelSelection;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly branch: string | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
}

/** The links a mirror shows: the visible ones, without the watches only the sandbox acts on. */
const shownPullRequests = (links: ReadonlyArray<ThreadPullRequestLink>) =>
  visibleThreadPullRequests(links).map(
    ({ watch: _watch, endedWatch: _endedWatch, ...link }): ThreadPullRequestLink => link,
  );

// Each thread event decodes new link objects; keeping the old list lets an unchanged one send nothing.
const keepSameLinks = (
  previous: ReadonlyArray<ThreadPullRequestLink>,
  next: ReadonlyArray<ThreadPullRequestLink>,
) =>
  previous.length === next.length &&
  previous.every((link, index) => JSON.stringify(link) === JSON.stringify(next[index]))
    ? previous
    : next;

const withThread = (records: MirrorRecords, thread: OrchestrationV2AppThread): MirrorRecords => {
  const branch = thread.branch ?? null;
  const pullRequests = keepSameLinks(
    records.pullRequests,
    shownPullRequests(threadPullRequestsOf(thread)),
  );
  return branch === records.branch && pullRequests === records.pullRequests
    ? records
    : { ...records, branch, pullRequests };
};

const upsert = <A extends { readonly id: string }>(items: ReadonlyArray<A>, item: A) => {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  return index === -1 ? [...items, item] : items.with(index, item);
};

/** The thread's records after one item of its stream; the same object when nothing shown changed. */
const foldMirror = (
  records: MirrorRecords | null,
  item: OrchestrationV2ThreadStreamItem,
): MirrorRecords | null => {
  if (item.kind === "snapshot") {
    const { thread, runs, subagents } = item.projection;
    return {
      modelSelection: thread.modelSelection,
      runs,
      subagents,
      branch: thread.branch ?? null,
      pullRequests: shownPullRequests(threadPullRequestsOf(thread)),
    };
  }
  if (item.kind !== "event" || records === null) return records;
  const event = item.event;
  switch (event.type) {
    case "thread.model-selection-updated":
    case "thread.provider-switched":
      return withThread(
        { ...records, modelSelection: event.payload.modelSelection },
        event.payload,
      );
    case "thread.metadata-updated":
    case "thread.pull-request-synced":
      return withThread(records, event.payload);
    case "thread.pull-request-link-updated": {
      const [updated] = shownPullRequests([event.payload]);
      if (updated === undefined) return records;
      const pullRequests = keepSameLinks(
        records.pullRequests,
        records.pullRequests.map((link) =>
          threadPullRequestKeysEqual(link, updated) ? updated : link,
        ),
      );
      return pullRequests === records.pullRequests ? records : { ...records, pullRequests };
    }
    case "run.created":
    case "run.updated":
      return { ...records, runs: upsert(records.runs, event.payload) };
    case "subagent.updated":
      return { ...records, subagents: upsert(records.subagents, event.payload) };
    default:
      return records;
  }
};

const viewOf = (
  records: MirrorRecords,
  providers: ReadonlyArray<ServerProvider>,
): SandboxThreadMirror => ({
  available: true,
  provider:
    providers.find((provider) => provider.instanceId === records.modelSelection.instanceId) ?? null,
  modelSelection: records.modelSelection,
  runs: mirrorRuns(records.runs, records.subagents),
  subagents: records.subagents,
  branch: records.branch,
  pullRequests: records.pullRequests,
});

const sameItems = <A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

const sameView = (left: SandboxThreadMirror, right: SandboxThreadMirror) =>
  left.available === right.available &&
  left.provider === right.provider &&
  left.modelSelection === right.modelSelection &&
  sameItems(left.runs, right.runs) &&
  sameItems(left.subagents, right.subagents) &&
  left.branch === right.branch &&
  sameItems(left.pullRequests ?? [], right.pullRequests ?? []);

/**
 * For a client that keeps the provider it got: one connection's views share their provider
 * object, so it goes out with the first view and again only once it is another.
 */
const withProviderOnChange = <E, R>(views: Stream.Stream<SandboxThreadMirror, E, R>) =>
  views.pipe(
    Stream.mapAccum(
      () => Option.none<SandboxThreadMirror["provider"]>(),
      (sent, view) => {
        if (Option.isSome(sent) && sent.value === view.provider) {
          const { provider: _unchanged, ...rest } = view;
          return [sent, [rest]] as const;
        }
        return [Option.some(view.provider), [view]] as const;
      },
    ),
  );

const NOTHING_READ: SandboxThreadMirror = {
  available: false,
  provider: null,
  modelSelection: null,
  runs: [],
  subagents: [],
  branch: null,
  pullRequests: [],
};

export class SandboxMirror extends Context.Service<
  SandboxMirror,
  {
    /**
     * The sandbox thread as it changes, following the sandbox's own thread stream. While the
     * sandbox is stopped, not answering or not linked, one view with `available: false` and what
     * was last read, then the next live one once it answers.
     */
    readonly subscribe: (input: SandboxThreadMirrorInput) => Stream.Stream<SandboxThreadMirror>;
    /** One of the thread's agents' messages, read when asked; refuses a thread that is not one. */
    readonly readChild: (
      input: SandboxMirrorChildInput,
    ) => Effect.Effect<SandboxMirrorChild, SandboxProviderError>;
    /**
     * Sets a pick from the mirror's picker on the sandbox thread, on its own provider, and on the
     * mirror, so the bridge never hands the sandbox an older one. A stopped sandbox gets it from
     * the bridge with the next message instead.
     */
    readonly setModelSelection: (
      input: SandboxSetThreadModelInput,
    ) => Effect.Effect<{ readonly sandboxUpdated: boolean }, SandboxProviderError>;
    /** Reads once whether the sandbox thread or its delegated tasks still run. */
    readonly activity: (threadId: ThreadId) => Effect.Effect<SandboxActivity>;
  }
>()("t3/sandbox/SandboxMirror") {}

const decodeLink = Schema.decodeEffect(SandboxBridgeLinkJson);

// The mirror reads the bridge link, not the sandbox record, so its refusals name no provider.
const failed = (detail: string) => new SandboxProviderError({ stage: "pair", detail });

const make = Effect.fn("SandboxMirror.make")(function* (connect: SandboxConnect) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;
  // What each thread showed last, so a stopped sandbox's picker keeps its real model; a pick
  // made while it is away lands here too, so its mirror shows that at once.
  const lastRead = yield* SubscriptionRef.make<ReadonlyMap<ThreadId, SandboxThreadMirror>>(
    new Map(),
  );
  const remember = (threadId: ThreadId, view: SandboxThreadMirror) =>
    SubscriptionRef.update(lastRead, (known) => new Map(known).set(threadId, view));

  const readLink = (threadId: ThreadId) =>
    secrets.get(bridgeLinkSecretName(threadId)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (bytes) => decodeLink(new TextDecoder().decode(bytes)).pipe(Effect.asSome),
        }),
      ),
      Effect.orElseSucceed(() => Option.none<SandboxBridgeLink>()),
    );

  const reach = (link: SandboxBridgeLink) => connect(link).pipe(Effect.timeout(CONNECT_TIMEOUT));

  const liveViews = (threadId: ThreadId, link: SandboxBridgeLink) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const sandbox = yield* reach(link);
        return sandbox.subscribe(threadId).pipe(
          Stream.mapAccum(
            () => null as MirrorRecords | null,
            (records, item) => {
              const next = foldMirror(records, item);
              return [next, next === null || next === records ? [] : [next]] as const;
            },
          ),
          Stream.map((records) => viewOf(records, sandbox.providers)),
        );
      }),
    );

  const views = (threadId: ThreadId) => {
    // One connection until it drops (a resume moves the link, so each reads it again), then
    // what was read last until the next try.
    const attempt = Stream.unwrap(
      Effect.gen(function* () {
        const link = yield* readLink(threadId);
        return Option.isNone(link)
          ? Stream.empty
          : liveViews(threadId, link.value).pipe(
              Stream.tap((view) => remember(threadId, view)),
              Stream.catchCause(() => Stream.empty),
            );
      }),
    ).pipe(
      Stream.concat(
        SubscriptionRef.changes(lastRead).pipe(
          Stream.map((known): SandboxThreadMirror => ({
            ...(known.get(threadId) ?? NOTHING_READ),
            available: false,
          })),
          Stream.interruptWhen(Effect.sleep(RECONNECT_SPACING)),
        ),
      ),
    );
    return Stream.forever(attempt).pipe(Stream.changesWith(sameView));
  };
  // Every client of a thread shares one connection and one subscription to the sandbox, held
  // while any of them follows it; a client that joins late starts from the latest view.
  const shared = yield* RcMap.make({
    lookup: (threadId: ThreadId) =>
      Stream.share(views(threadId), { capacity: 16, strategy: "sliding", replay: 1 }),
  });
  const subscribe = (input: SandboxThreadMirrorInput) => {
    const followed = Stream.unwrap(RcMap.get(shared, input.threadId));
    return input.providerOnChange === true ? withProviderOnChange(followed) : followed;
  };

  const readChild = Effect.fn("SandboxMirror.readChild")(function* (
    input: SandboxMirrorChildInput,
  ) {
    const link = yield* readLink(input.threadId);
    if (Option.isNone(link)) return { available: false, messages: [] };
    const read = yield* Effect.gen(function* () {
      const sandbox = yield* reach(link.value);
      const parent = yield* sandbox.projection(input.threadId);
      const child = yield* sandbox.projection(input.childThreadId);
      return { parent, child };
    }).pipe(Effect.scoped, Effect.option);
    if (Option.isNone(read)) return { available: false, messages: [] };
    const { parent, child } = read.value;
    const isAgent =
      Option.isSome(parent) &&
      parent.value.subagents.some((subagent) => subagent.childThreadId === input.childThreadId);
    if (!isAgent || Option.isNone(child)) {
      return yield* failed("That thread is not one of this chat's agents on its sandbox.");
    }
    return {
      available: true,
      messages: child.value.messages
        .filter((message) => message.role !== "system")
        .map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })),
    };
  });

  const setModelSelection = Effect.fn("SandboxMirror.setModelSelection")(function* (
    input: SandboxSetThreadModelInput,
  ) {
    const mirror = yield* orchestrator
      .getThreadShell(input.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (mirror === null || mirror.modelSelection.instanceId !== bridgeInstanceId) {
      return yield* failed("This thread is not a sandbox chat on this computer.");
    }
    const pick = input.modelSelection;
    const id = yield* random.uuidV4().pipe(Effect.orDie);
    const link = yield* readLink(input.threadId);
    // None: the sandbox could not be reached; a refusal there fails the whole pick.
    const sandboxPick: Option.Option<ModelSelection> = Option.isNone(link)
      ? Option.none()
      : yield* Effect.gen(function* () {
          const reached = yield* Effect.gen(function* () {
            const sandbox = yield* reach(link.value);
            const projection = yield* sandbox.projection(input.threadId);
            return { sandbox, projection };
          }).pipe(Effect.option);
          if (Option.isNone(reached) || Option.isNone(reached.value.projection)) {
            return Option.none<ModelSelection>();
          }
          const { sandbox, projection } = reached.value;
          const instanceId = projection.value.thread.modelSelection.instanceId;
          const provider = sandbox.providers.find(
            (candidate) => candidate.instanceId === instanceId,
          );
          if (provider?.models.some((model) => model.slug === pick.model) !== true) {
            return yield* failed("The sandbox does not offer that model for this chat.");
          }
          const next = { ...pick, instanceId } as ModelSelection;
          yield* sandbox
            .dispatch({
              type: "thread.model-selection.set",
              commandId: CommandId.make(`sandbox-mirror-model:${id}`),
              threadId: input.threadId,
              modelSelection: next,
            })
            .pipe(Effect.mapError(() => failed("The sandbox did not take the model change.")));
          return Option.some(next);
        }).pipe(Effect.scoped);
    yield* orchestrator
      .dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`sandbox-mirror-model-host:${id}`),
        threadId: input.threadId,
        modelSelection: { ...pick, instanceId: bridgeInstanceId } as ModelSelection,
      })
      .pipe(Effect.mapError(() => failed("Could not set the model on this computer's copy.")));
    const known = (yield* SubscriptionRef.get(lastRead)).get(input.threadId);
    if (Option.isNone(sandboxPick) && known?.modelSelection != null) {
      yield* remember(input.threadId, {
        ...known,
        modelSelection: { ...pick, instanceId: known.modelSelection.instanceId } as ModelSelection,
      });
    }
    return { sandboxUpdated: Option.isSome(sandboxPick) };
  });

  const activity = Effect.fn("SandboxMirror.activity")(function* (threadId: ThreadId) {
    const link = yield* readLink(threadId);
    if (Option.isNone(link)) return "unknown" as const;
    const read = yield* Effect.gen(function* () {
      const sandbox = yield* reach(link.value);
      return yield* sandbox.projection(threadId);
    }).pipe(Effect.scoped, Effect.option);
    if (Option.isNone(read) || Option.isNone(read.value)) return "unknown" as const;
    return hasLiveWork(read.value.value) ? ("busy" as const) : ("idle" as const);
  });

  return SandboxMirror.of({ subscribe, readChild, setModelSelection, activity });
});

export const layerWith = (connect: SandboxConnect) => Layer.effect(SandboxMirror, make(connect));

export const layer = layerWith((link) =>
  connectSandbox(link).pipe(Effect.provide(FetchHttpClient.layer)),
);

/** The WebSocket handlers for a sandbox chat's own thread, read and picked for through the host. */
export const rpcHandlers = Effect.gen(function* () {
  const mirror = yield* SandboxMirror;
  return {
    [WS_METHODS.sandboxesSubscribeThreadMirror]: (input: SandboxThreadMirrorInput) =>
      mirror.subscribe(input),
    [WS_METHODS.sandboxesReadMirrorChild]: (input: SandboxMirrorChildInput) =>
      mirror.readChild(input),
    [WS_METHODS.sandboxesSetThreadModel]: (input: SandboxSetThreadModelInput) =>
      mirror.setModelSelection(input),
  };
});
