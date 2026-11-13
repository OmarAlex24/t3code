import {
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  type RunId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  type SandboxRecord,
  type SandboxThreadMirror,
  type ServerProvider,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentThreadState } from "./threadState.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { deriveThreadTurnSubagents, type ThreadTurnSubagents } from "./threadSubagents.ts";

const bridgeInstanceId = ProviderInstanceId.make(SANDBOX_BRIDGE_INSTANCE_ID);

type MirrorTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/** A host thread the sandbox bridge drives: a sandbox chat's mirror. */
export const isSandboxMirrorThread = (thread: {
  readonly modelSelection: Pick<ModelSelection, "instanceId">;
}): boolean => thread.modelSelection.instanceId === bridgeInstanceId;

/**
 * What the host mirror's model picker shows of a sandbox chat: the sandbox's provider and
 * selection, under the bridge's instance, which a send on the mirror carries and the bridge hands
 * to the sandbox. The host's bridge lists one set of models and options for every sandbox, so its
 * own entry would show another chat's. Null while the provider is unknown.
 */
export const sandboxMirrorModelSource = (
  sandboxSelection: ModelSelection,
  sandboxProviders: ReadonlyArray<ServerProvider>,
): {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelSelection: ModelSelection;
} | null => {
  const provider = sandboxProviders.find(
    (candidate) => candidate.instanceId === sandboxSelection.instanceId,
  );
  return provider === undefined
    ? null
    : {
        providers: [{ ...provider, instanceId: bridgeInstanceId }],
        modelSelection: { ...sandboxSelection, instanceId: bridgeInstanceId } as ModelSelection,
      };
};

/** The picker's source from what the host read of the sandbox; see `sandboxMirrorModelSource`. */
export const sandboxMirrorModelSourceOf = (mirror: SandboxThreadMirror | null) =>
  mirror?.provider == null || mirror.modelSelection === null
    ? null
    : sandboxMirrorModelSource(mirror.modelSelection, [mirror.provider]);

/** Why a sandbox chat's mirror shows its model read-only; see `sandboxMirrorPickerSource`. */
export const SANDBOX_MIRROR_MODELS_PENDING_REASON =
  "The sandbox's models show once it has been reached.";

/**
 * Every picker on a sandbox chat's mirror: the sandbox's own thread where this client is paired
 * with it, else what the host last read of it. With neither, the mirror's pick on the bridge alone,
 * read-only: the bridge's shared list is another chat's, and the host refuses any other provider.
 */
export const sandboxMirrorPickerSource = (input: {
  readonly paired: ReturnType<typeof sandboxMirrorModelSource>;
  readonly hostMirror: SandboxThreadMirror | null;
  readonly mirrorSelection: ModelSelection;
  readonly hostProviders: ReadonlyArray<ServerProvider>;
}): {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelSelection: ModelSelection;
  readonly readOnly: boolean;
} => {
  const source = input.paired ?? sandboxMirrorModelSourceOf(input.hostMirror);
  return source !== null
    ? { ...source, readOnly: false }
    : {
        providers: input.hostProviders.filter(
          (provider) => provider.instanceId === bridgeInstanceId,
        ),
        modelSelection: input.mirrorSelection,
        readOnly: true,
      };
};

// "waiting" asks the user, which the bridge does only once it reaches the sandbox.
const AT_BRIDGE_BEFORE_SANDBOX = new Set(["preparing", "starting", "running"]);

/**
 * The run on a sandbox chat's host mirror that waits at the bridge while its stopped sandbox
 * starts: the run resumes the sandbox, and the bridge sends its message once the sandbox answers.
 * Null for any other thread, and once the host lists the sandbox running.
 */
export const sandboxStartRunId = (
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  sandboxes: ReadonlyArray<SandboxRecord>,
): RunId | null => {
  const runId = bridgeRunId(projection);
  if (runId === null) return null;
  const sandbox = sandboxes.find(
    (record) => record.threadId === projection.thread.id && record.state !== "deleted",
  );
  return sandbox !== undefined &&
    (sandbox.state === "stopped" || sandbox.resumingSince !== undefined)
    ? runId
    : null;
};

const bridgeRunId = (
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
): RunId | null =>
  isSandboxMirrorThread(projection.thread)
    ? (projection.runs.findLast(
        (run) =>
          run.providerInstanceId === bridgeInstanceId && AT_BRIDGE_BEFORE_SANDBOX.has(run.status),
      )?.id ?? null)
    : null;

/** The thread with `runId` first in its queue and none of its items shown yet. */
export const queueSandboxStartRun = <
  P extends Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems" | "visibleTurnItems">,
>(
  projection: P,
  runId: RunId,
): P => ({
  ...projection,
  runs: projection.runs.map((run) => {
    if (run.id === runId) {
      const { queueHeld: _queueHeld, ...rest } = run;
      return { ...rest, status: "queued" as const, queuePosition: 1 };
    }
    return run.status === "queued"
      ? { ...run, queuePosition: (run.queuePosition ?? run.ordinal) + 1 }
      : run;
  }),
  turnItems: projection.turnItems.filter((item) => item.runId !== runId),
  visibleTurnItems: projection.visibleTurnItems.filter(({ item }) => item.runId !== runId),
});

type ThreadStateAtom<E> = (
  environmentId: EnvironmentId,
  threadId: ThreadId,
) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>;

/**
 * Thread state in which a sandbox chat's message reads as queued while its sandbox starts (see
 * `sandboxStartRunId`). Only a mirror with a run at the bridge reads the host's sandbox list.
 */
export function createSandboxStartQueueAtoms<E>(input: {
  readonly threadStateAtom: ThreadStateAtom<E>;
  readonly sandboxesList: (key: {
    readonly environmentId: EnvironmentId;
    readonly input: undefined;
  }) => Atom.Atom<
    AsyncResult.AsyncResult<{ readonly sandboxes: ReadonlyArray<SandboxRecord> }, unknown>
  >;
}) {
  const startRunIdAtom = Atom.family((key: string) => {
    const { environmentId, threadId } = parseMirrorKey(key);
    return Atom.make((get): RunId | null => {
      const state = get(input.threadStateAtom(environmentId, threadId));
      const projection = AsyncResult.isSuccess(state) ? Option.getOrNull(state.value.data) : null;
      if (projection === null || bridgeRunId(projection) === null) return null;
      const list = get(input.sandboxesList({ environmentId, input: undefined }));
      return AsyncResult.isSuccess(list)
        ? sandboxStartRunId(projection, list.value.sandboxes)
        : null;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-data:sandboxes:start-run:${key}`));
  });

  const threadStateAtom = Atom.family((key: string) => {
    const { environmentId, threadId } = parseMirrorKey(key);
    return Atom.make((get) => {
      const state = get(input.threadStateAtom(environmentId, threadId));
      const runId = get(startRunIdAtom(key));
      return runId === null
        ? state
        : AsyncResult.map(state, (value) => ({
            ...value,
            data: Option.map(value.data, (projection) => queueSandboxStartRun(projection, runId)),
          }));
    }).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-data:sandboxes:start-queued-thread:${key}`),
    );
  });

  return {
    threadStateAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      threadStateAtom(mirrorKey({ environmentId, threadId })),
    /** The run that reads as queued while the chat's sandbox starts; it is stopped, not cancelled. */
    sandboxStartRunId: (target: MirrorTarget | null) =>
      target === null ? NO_START_RUN : startRunIdAtom(mirrorKey(target)),
  };
}

/** Changes whenever the host reports the agent behind `childThreadId` changed, so its read follows. */
const sandboxMirrorChildRevision = (
  mirror: SandboxThreadMirror | null,
  childThreadId: ThreadId,
): string => {
  const agent = mirror?.subagents.find((subagent) => subagent.childThreadId === childThreadId);
  return agent === undefined
    ? ""
    : `${agent.status}:${DateTime.toEpochMillis(agent.updatedAt)}:${mirror?.available === true}`;
};

const NO_START_RUN = Atom.make<RunId | null>(null).pipe(
  Atom.withLabel("environment-data:sandboxes:start-run:none"),
);

const NO_MIRROR = Atom.make<SandboxThreadMirror | null>(null).pipe(
  Atom.withLabel("environment-data:sandboxes:thread-mirror:none"),
);

const mirrorKey = (target: MirrorTarget) => JSON.stringify([target.environmentId, target.threadId]);
const parseMirrorKey = (key: string): MirrorTarget => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  return { environmentId, threadId };
};

export function createSandboxMirrorEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // The host holds a connection to the sandbox per subscriber, so it closes soon after the thread.
  const sandboxesThreadMirror = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:sandboxes:thread-mirror",
    tag: WS_METHODS.sandboxesSubscribeThreadMirror,
    idleTtlMs: 10_000,
  });
  const mirrorValueAtom = Atom.family((key: string) => {
    const { environmentId, threadId } = parseMirrorKey(key);
    return Atom.make((get) => {
      const result = get(sandboxesThreadMirror({ environmentId, input: { threadId } }));
      return AsyncResult.isSuccess(result) ? result.value : null;
    }).pipe(Atom.withLabel(`environment-data:sandboxes:thread-mirror-value:${key}`));
  });
  /** The sandbox chat's own thread as the host last read it; null until it has. */
  const sandboxesThreadMirrorValue = (target: MirrorTarget | null) =>
    target === null ? NO_MIRROR : mirrorValueAtom(mirrorKey(target));

  const turnSubagentsAtom = Atom.family((key: string) => {
    let previous: SandboxThreadMirror | null = null;
    let value: ThreadTurnSubagents | null = null;
    return Atom.make((get) => {
      const mirror = get(mirrorValueAtom(key));
      if (mirror !== previous) {
        previous = mirror;
        value = mirror === null ? null : deriveThreadTurnSubagents(mirror);
      }
      return value;
    }).pipe(Atom.withLabel(`environment-data:sandboxes:thread-mirror-agents:${key}`));
  });

  return {
    sandboxesThreadMirrorValue,
    /** The sandbox chat's agents on its mirror, derived as any thread's are. */
    sandboxesThreadMirrorTurnSubagents: (target: MirrorTarget) =>
      turnSubagentsAtom(mirrorKey(target)),
    sandboxesMirrorChild: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:sandboxes:mirror-child",
      tag: WS_METHODS.sandboxesReadMirrorChild,
      idleTtlMs: 0,
      // Read again when the host reports the agent changed, not on a timer.
      refreshTrigger: ({ environmentId, input }) =>
        Atom.make((get) =>
          sandboxMirrorChildRevision(
            get(mirrorValueAtom(mirrorKey({ environmentId, threadId: input.threadId }))),
            input.childThreadId,
          ),
        ),
    }),
    sandboxesSetThreadModel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:set-thread-model",
      tag: WS_METHODS.sandboxesSetThreadModel,
    }),
  };
}
