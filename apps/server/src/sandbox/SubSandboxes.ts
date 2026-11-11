import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type ProjectId,
  type SandboxCheckWorkResult,
  type SandboxRecord,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SandboxProvisioner from "./SandboxProvisioner.ts";
import {
  checkSubSandboxCapacity,
  resolveSubSandboxConfig,
  resolveSubSandboxSize,
  type SubSandboxCaller,
} from "./subSandboxPolicy.ts";

/** A subagent's sandbox, linked here and ready for its task. */
export interface StartedSubSandbox {
  readonly instanceId: string;
  readonly environmentId: EnvironmentId;
  /** The project T3 made for the clone on the sandbox, where the task's thread runs. */
  readonly projectId: ProjectId | undefined;
}

/**
 * Sandboxes `delegate_task` starts for subagents that need more than this machine gives them.
 * Each one is made from the parent's sandbox config within its limits, linked here as an
 * environment so the task runs there like any linked task, and ended with its task: deleted when
 * it holds no unpushed work, else stopped and kept.
 */
export class SubSandboxes extends Context.Service<
  SubSandboxes,
  {
    readonly start: (input: {
      readonly parentThreadId: ThreadId;
      readonly projectId: ProjectId;
      /** The parent's checkout, whose repository and pushed branch the sandbox clones. */
      readonly cwd: string;
      readonly size: string | undefined;
      /**
       * For a parent that works on a sandbox of its own, whose clone is there and not at `cwd`:
       * the repository and pushed branch that clone tracks. `cwd` is then only the host
       * project's folder, read for env files when it is a real checkout of the repository.
       */
      readonly repository?: {
        readonly remoteUrl: string;
        readonly canonicalKey: string;
        readonly baseRef: string | undefined;
        readonly hostCheckout: boolean;
      };
      /** Who asked, for the words of a refusal. `delegate_task` when absent. */
      readonly caller?: SubSandboxCaller;
    }) => Effect.Effect<StartedSubSandbox, OrchestratorMcpFailure>;
    /** Deletes a sandbox whose task never started. */
    readonly discard: (instanceId: string) => Effect.Effect<void>;
    /**
     * Ends the subagent sandbox at `environmentId` once its task is over, and says where its work
     * went, for the task's result. Nothing, for an environment that is no subagent's sandbox.
     */
    readonly settle: (environmentId: EnvironmentId) => Effect.Effect<string | undefined>;
  }
>()("t3/sandbox/SubSandboxes") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const linkedEnvironmentsNeeded = (caller: SubSandboxCaller) =>
  caller === "delegate_task"
    ? "A subagent's sandbox runs its task as a linked environment, and Linked environments is off on this machine. Ask the user to turn it on in Settings → Labs, then try again, or run the task without target.sandbox."
    : "A sub-sandbox runs its task as a linked environment of the user's computer, and Linked environments is off there. Ask the user to turn it on in T3 Code's Settings → Labs on their computer, then try again, or run the task here, on this sandbox.";

/** The branch name a remote-tracking ref such as `origin/feature/x` points at. */
const branchOfUpstream = (upstreamRef: string | null) => {
  if (upstreamRef === null) return undefined;
  const slash = upstreamRef.indexOf("/");
  return slash < 0 ? undefined : upstreamRef.slice(slash + 1) || undefined;
};

const workSummary = (work: SandboxCheckWorkResult) =>
  [
    work.uncommittedFiles === 0
      ? null
      : `${work.uncommittedFiles} uncommitted ${work.uncommittedFiles === 1 ? "file" : "files"}`,
    work.unpushedCommits === 0
      ? null
      : `${work.unpushedCommits} unpushed ${work.unpushedCommits === 1 ? "commit" : "commits"}`,
  ]
    .filter((part) => part !== null)
    .join(" and ");

/** Where a kept sandbox's work is, for the parent agent and the user it reports to. */
const keptNote = (record: SandboxRecord, work: SandboxCheckWorkResult | null, stopped: boolean) => {
  const where = `${record.label} (${record.sandboxId}, environment ${record.environmentId})${record.repoDir === undefined ? "" : ` in ${record.repoDir}`}`;
  const what =
    work === null
      ? "Its work"
      : work.status === "dirty"
        ? `Its work (${workSummary(work)})`
        : `T3 Code could not check its sandbox for work (${work.detail ?? "no answer"}), so its work`;
  return stopped
    ? `[Sub-sandbox] ${what} is kept on the stopped sandbox ${where}. Resume it under Settings → Connections → Sandboxes to reach it, and delete it there when done.`
    : `[Sub-sandbox] ${what} is on the sandbox ${where}, which T3 Code could not stop. Delete it under Settings → Connections → Sandboxes when done.`;
};

const make = Effect.gen(function* () {
  const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
  const peerLinks = yield* PeerLinks.PeerLinks;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const random = yield* SecureRandom.SecureRandom;
  // Places held by sandboxes still being made, by instance id: their records may not exist yet.
  const starting = new Map<string, ThreadId>();
  // Counting and holding a place happen as one step, so two calls cannot both take the last one.
  const placeLock = yield* Semaphore.make(1);
  // One end per sandbox at a time; a second waits and then finds it already ended.
  const settleLock = yield* Semaphore.make(1);

  const records = provisioner.list.pipe(
    Effect.map((listed) => listed.sandboxes),
    Effect.mapError((error) =>
      failure("orchestration_error", `Could not read this machine's sandboxes: ${error.detail}`),
    ),
  );

  const deleteRecord = (record: SandboxRecord) =>
    provisioner
      .delete({
        provider: record.provider,
        sandboxId: record.sandboxId,
        instanceId: record.instanceId,
      })
      .pipe(
        Effect.andThen(
          record.environmentId === null
            ? Effect.void
            : peerLinks.unlink(record.environmentId).pipe(Effect.ignore),
        ),
      );

  const discard: SubSandboxes["Service"]["discard"] = (instanceId) =>
    provisioner.list.pipe(
      Effect.map((listed) => listed.sandboxes.find((record) => record.instanceId === instanceId)),
      Effect.flatMap((record) => (record === undefined ? Effect.void : deleteRecord(record))),
      Effect.catchCause((cause) =>
        Effect.logWarning("sub-sandbox discard failed", { instanceId, cause }),
      ),
    );

  /** The repository and pushed branch of the parent's checkout on this machine. */
  const checkoutSource = Effect.fn("SubSandboxes.checkoutSource")(function* (cwd: string) {
    const identity = yield* repositoryIdentities.resolve(cwd);
    const remoteUrl = identity?.locator.remoteUrl;
    if (remoteUrl === undefined) {
      return yield* failure(
        "invalid_request",
        "This thread's checkout has no git remote, so a sandbox has nothing to clone.",
      );
    }
    // The sandbox clones from GitHub, so it gets the parent's branch only once that is pushed.
    const status = yield* git.statusDetailsLocal(cwd).pipe(Effect.orElseSucceed(() => null));
    return {
      remoteUrl,
      repositoryKey: identity?.canonicalKey.toLowerCase() ?? null,
      baseRef:
        status !== null && status.hasUpstream ? branchOfUpstream(status.upstreamRef) : undefined,
      hostCheckout: true,
    };
  });

  const start: SubSandboxes["Service"]["start"] = Effect.fn("SubSandboxes.start")(
    function* (input) {
      const caller = input.caller ?? "delegate_task";
      if (!(yield* peerLinks.enabled)) {
        return yield* failure("invalid_request", linkedEnvironmentsNeeded(caller));
      }
      const project = yield* projects.getById(input.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (project === undefined) {
        return yield* failure("invalid_request", `Project ${input.projectId} was not found.`);
      }
      const source = yield* input.repository === undefined
        ? checkoutSource(input.cwd)
        : Effect.succeed({
            remoteUrl: input.repository.remoteUrl,
            repositoryKey: input.repository.canonicalKey.toLowerCase(),
            baseRef: input.repository.baseRef,
            hostCheckout: input.repository.hostCheckout,
          });
      const { remoteUrl, baseRef } = source;
      const providers = yield* provisioner.providers;
      const instanceId = yield* random.uuidV4();

      const { config, size } = yield* placeLock.withPermits(1)(
        Effect.gen(function* () {
          const listed = yield* records;
          const configs = yield* provisioner.configs.pipe(
            Effect.map((result) => result.configs),
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not read the sandbox configs: ${error.detail}`),
            ),
          );
          const resolved = resolveSubSandboxConfig({
            parentThreadId: input.parentThreadId,
            projectId: input.projectId,
            repositoryKey: source.repositoryKey,
            records: listed,
            configs,
          });
          if (resolved._tag === "refused") {
            return yield* failure(resolved.refusal.code, resolved.refusal.message);
          }
          const full = checkSubSandboxCapacity({
            config: resolved.config,
            parentThreadId: input.parentThreadId,
            records: listed,
            starting,
            caller,
          });
          if (full !== null) return yield* failure(full.code, full.message);
          const sized = resolveSubSandboxSize({
            config: resolved.config,
            sizes:
              providers.providers.find((provider) => provider.kind === resolved.config.provider)
                ?.sizes ?? [],
            requested: input.size,
            caller,
          });
          if (sized._tag === "refused") {
            return yield* failure(sized.refusal.code, sized.refusal.message);
          }
          starting.set(instanceId, input.parentThreadId);
          return { config: resolved.config, size: sized.size };
        }),
      );

      return yield* Effect.gen(function* () {
        const created = yield* provisioner
          .createSubSandbox({
            instanceId,
            config,
            parentThreadId: input.parentThreadId,
            size,
            project: {
              id: project.id,
              title: project.title,
              remoteUrl,
              ...(baseRef === undefined ? {} : { baseRef }),
              ...(source.hostCheckout
                ? { hostCopy: { projectId: project.id, workspaceRoot: project.workspaceRoot } }
                : {}),
            },
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `The subagent's sandbox could not be started: ${error.detail}`,
              ),
            ),
          );
        yield* peerLinks
          .link({
            url: created.httpBaseUrl,
            pairingCode: created.pairingCode,
            // The sandbox is this machine's own; each call still carries the caller's limits.
            access: "full-access",
            expectedEnvironmentId: created.environmentId,
            expectedLabel: created.label,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `The subagent's sandbox started but could not be linked, so it was deleted: ${error.message}`,
              ),
            ),
          );
        const record = (yield* records).find((candidate) => candidate.instanceId === instanceId);
        return {
          instanceId,
          environmentId: created.environmentId,
          projectId: record?.sandboxProjectId,
        } satisfies StartedSubSandbox;
      }).pipe(
        // A sandbox made for a task that will not run on it is deleted, however that came about.
        Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : discard(instanceId))),
        Effect.ensuring(Effect.sync(() => starting.delete(instanceId))),
      );
    },
  );

  const settle: SubSandboxes["Service"]["settle"] = (environmentId) =>
    settleLock.withPermits(1)(
      Effect.gen(function* () {
        const listed = yield* provisioner.list;
        const record = listed.sandboxes.find(
          (candidate) =>
            candidate.environmentId === environmentId && candidate.parentThreadId !== undefined,
        );
        if (record === undefined) return undefined;
        // Ended before, as when completing the task is tried again.
        if (record.state === "stopped") return keptNote(record, null, true);
        const work = yield* provisioner.checkWork({ instanceId: record.instanceId }).pipe(
          Effect.orElseSucceed((): SandboxCheckWorkResult => ({
            status: "unknown",
            uncommittedFiles: 0,
            unpushedCommits: 0,
            detail: "the check failed",
          })),
        );
        if (work.status === "clean") {
          const deleted = yield* deleteRecord(record).pipe(Effect.exit);
          if (deleted._tag === "Success") {
            return "[Sub-sandbox] Its sandbox held no unpushed work and was deleted.";
          }
          yield* Effect.logWarning("sub-sandbox delete failed", {
            instanceId: record.instanceId,
            cause: deleted.cause,
          });
          return `[Sub-sandbox] Its sandbox ${record.label} (${record.sandboxId}) held no unpushed work but could not be deleted. Delete it under Settings → Connections → Sandboxes.`;
        }
        const stopped = yield* provisioner
          .stop({ instanceId: record.instanceId })
          .pipe(Effect.exit);
        if (stopped._tag === "Failure") {
          yield* Effect.logWarning("sub-sandbox stop failed", {
            instanceId: record.instanceId,
            cause: stopped.cause,
          });
        }
        return keptNote(record, work, stopped._tag === "Success");
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("sub-sandbox settle failed", { environmentId, cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      ),
    );

  return SubSandboxes.of({ start, discard, settle });
});

export const layer = Layer.effect(SubSandboxes, make);
