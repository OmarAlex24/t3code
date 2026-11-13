import {
  type EnvironmentId,
  type ModelSelection,
  ProviderInstanceId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  type SandboxThreadMirror,
  type ServerProvider,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
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
