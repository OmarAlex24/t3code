import type {
  SandboxCheckWorkResult,
  SandboxProviderKind,
  SandboxRecord,
  ThreadId,
} from "@t3tools/contracts";

/** What the host waits on after a sandbox chat settled: keep its sandbox, or delete it. */
export interface SandboxSettleDecision {
  readonly instanceId: string;
  readonly provider: SandboxProviderKind;
  /** `work`: its config deletes on settle, but the sandbox may hold work that is not pushed. */
  readonly reason: "ask" | "work";
  /** A stopped sandbox's work cannot be checked before a delete. */
  readonly stopped: boolean;
}

/**
 * The pending settle decision of the chat whose host thread is `threadId`, from the host's
 * sandbox list. The chat's thread on the host has its sandbox's thread id.
 */
export const sandboxSettleDecisionOf = (
  sandboxes: ReadonlyArray<SandboxRecord>,
  threadId: ThreadId,
): SandboxSettleDecision | null => {
  const sandbox = sandboxes.find(
    (candidate) => candidate.threadId === threadId && candidate.state !== "deleted",
  );
  return sandbox?.settlePending === undefined
    ? null
    : {
        instanceId: sandbox.instanceId,
        provider: sandbox.provider,
        reason: sandbox.settlePending.reason,
        stopped: sandbox.state === "stopped",
      };
};

/** What a sandbox's work check says a delete would lose. */
export const describeSandboxWork = (work: SandboxCheckWorkResult): string => {
  if (work.status === "clean") return "No uncommitted or unpushed work.";
  if (work.status === "unknown") {
    return `Couldn't check for unpushed work. ${work.detail ?? ""}`.trim();
  }
  const parts = [
    ...(work.uncommittedFiles === 0
      ? []
      : [`${work.uncommittedFiles} uncommitted ${work.uncommittedFiles === 1 ? "file" : "files"}`]),
    ...(work.unpushedCommits === 0
      ? []
      : [`${work.unpushedCommits} unpushed ${work.unpushedCommits === 1 ? "commit" : "commits"}`]),
  ];
  return `${parts.join(" and ")} would be lost.`;
};

/** Says why answering a settle question changed nothing (`resolved: false` from the host). */
export const SANDBOX_SETTLE_STALE_ANSWER =
  "Nothing was changed: the chat is no longer settled, or its sandbox was already decided.";
