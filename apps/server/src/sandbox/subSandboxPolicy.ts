import {
  DEFAULT_SANDBOX_SUB_SANDBOX_LIMITS,
  type ProjectId,
  type SandboxEnvironmentConfig,
  type SandboxMachineSize,
  type SandboxRecord,
  type ThreadId,
} from "@t3tools/contracts";

/**
 * The rules for sandboxes `delegate_task` starts for subagents, kept apart from the service that
 * starts them so each one can be checked on its own.
 */

/** Why a subagent cannot have a sandbox, in words the agent can pass on or act on. */
export interface SubSandboxRefusal {
  readonly code: "invalid_request" | "concurrency_full";
  readonly message: string;
}

/**
 * Who asked: an agent here through `delegate_task`'s `target.sandbox`, or an agent on a sandbox
 * through the helper T3 Code installs there (`sandbox_delegate`). Only the words differ.
 */
export type SubSandboxCaller = "delegate_task" | "sandbox";

const wordingFor = (caller: SubSandboxCaller) =>
  caller === "delegate_task"
    ? {
        runWithout: "Run the task without target.sandbox.",
        runThisWithout: "run this one without target.sandbox",
        runTaskWithout: "run this task without target.sandbox",
        sizeParameter: "target.sandbox.size",
      }
    : {
        runWithout: "Run the task here, on this sandbox.",
        runThisWithout: "run this one here, on this sandbox",
        runTaskWithout: "run this task here, on this sandbox",
        sizeParameter: "size",
      };

const refuse = (
  code: SubSandboxRefusal["code"],
  message: string,
): { readonly _tag: "refused"; readonly refusal: SubSandboxRefusal } => ({
  _tag: "refused",
  refusal: { code, message },
});

/**
 * The config a parent thread's subagents start their sandboxes from: its own sandbox's config when
 * the parent is a sandbox chat, else the one this project's sandbox chats last used, else the only
 * config there is. T3 keeps no other choice of config per project.
 */
export const resolveSubSandboxConfig = (input: {
  readonly parentThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly repositoryKey: string | null;
  readonly records: ReadonlyArray<SandboxRecord>;
  readonly configs: ReadonlyArray<SandboxEnvironmentConfig>;
}):
  | { readonly _tag: "config"; readonly config: SandboxEnvironmentConfig }
  | { readonly _tag: "refused"; readonly refusal: SubSandboxRefusal } => {
  const byId = new Map(input.configs.map((config) => [config.id, config]));
  const parentSandbox = input.records.find(
    (record) => record.threadId === input.parentThreadId && record.state !== "deleted",
  );
  if (parentSandbox !== undefined) {
    const config =
      parentSandbox.configId === undefined ? undefined : byId.get(parentSandbox.configId);
    if (config === undefined) {
      return refuse(
        "invalid_request",
        "This thread's sandbox config no longer exists, so it has no config to start a subagent's sandbox from.",
      );
    }
    return { _tag: "config", config };
  }
  const projectRecords = input.records
    .filter(
      (record) =>
        record.configId !== undefined &&
        byId.has(record.configId) &&
        (record.hostProjectId === input.projectId ||
          record.projectId === input.projectId ||
          (input.repositoryKey !== null &&
            record.repository?.toLowerCase() === input.repositoryKey)),
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  const recent = projectRecords[0];
  if (recent !== undefined) return { _tag: "config", config: byId.get(recent.configId!)! };
  if (input.configs.length === 1) return { _tag: "config", config: input.configs[0]! };
  return refuse(
    "invalid_request",
    input.configs.length === 0
      ? "There is no sandbox config on this machine. The user can add one under Settings → Connections → Sandboxes."
      : `No sandbox config is chosen for this project. The user picks one by starting a sandbox chat in this project with it (configs: ${input.configs.map((config) => config.label).join(", ")}).`,
  );
};

const subSandboxLimitsOf = (config: SandboxEnvironmentConfig) =>
  config.subSandboxes ?? DEFAULT_SANDBOX_SUB_SANDBOX_LIMITS;

/** A subagent's sandbox that costs money or holds a place: starting, or up. */
const holdsPlace = (record: SandboxRecord) =>
  record.parentThreadId !== undefined &&
  (record.state === "provisioning" || record.state === "running");

/**
 * Whether one more subagent sandbox fits `config`'s limits. `starting` are the ones still being
 * made, by instance id and parent, which may not have a record yet.
 */
export const checkSubSandboxCapacity = (input: {
  readonly config: SandboxEnvironmentConfig;
  readonly parentThreadId: ThreadId;
  readonly records: ReadonlyArray<SandboxRecord>;
  readonly starting: ReadonlyMap<string, ThreadId>;
  readonly caller?: SubSandboxCaller;
}): SubSandboxRefusal | null => {
  const words = wordingFor(input.caller ?? "delegate_task");
  const parents = new Map<string, ThreadId>(input.starting);
  for (const record of input.records) {
    if (holdsPlace(record)) parents.set(record.instanceId, record.parentThreadId!);
  }
  const limits = subSandboxLimitsOf(input.config);
  const forThread = [...parents.values()].filter((id) => id === input.parentThreadId).length;
  if (limits.perThread === 0 || limits.total === 0) {
    return {
      code: "concurrency_full",
      message: `The ${input.config.label} sandbox config does not let subagents start sandboxes. ${words.runWithout}`,
    };
  }
  if (forThread >= limits.perThread) {
    return {
      code: "concurrency_full",
      message: `This thread already has ${forThread} subagent ${forThread === 1 ? "sandbox" : "sandboxes"} running, the most the ${input.config.label} config allows. Wait for one of those tasks to finish, or ${words.runThisWithout}.`,
    };
  }
  if (parents.size >= limits.total) {
    return {
      code: "concurrency_full",
      message: `${parents.size} subagent sandboxes are already running on this machine, the most the ${input.config.label} config allows. Wait for one to finish, or ${words.runTaskWithout}.`,
    };
  }
  return null;
};

/**
 * The size a subagent's sandbox starts at: the config's own when none is asked for, and at most
 * one step up its provider's list. A config with a template keeps the template's size.
 */
export const resolveSubSandboxSize = (input: {
  readonly config: SandboxEnvironmentConfig;
  readonly sizes: ReadonlyArray<SandboxMachineSize>;
  readonly requested: string | undefined;
  readonly caller?: SubSandboxCaller;
}):
  | { readonly _tag: "size"; readonly size: string }
  | { readonly _tag: "refused"; readonly refusal: SubSandboxRefusal } => {
  const { config, sizes, requested } = input;
  const words = wordingFor(input.caller ?? "delegate_task");
  if (requested === undefined || requested === config.size) {
    return { _tag: "size", size: config.size };
  }
  if (config.template !== undefined) {
    return refuse(
      "invalid_request",
      `The ${config.label} config starts from the template ${config.template}, which decides the size. Omit ${words.sizeParameter}.`,
    );
  }
  const base = sizes.findIndex((size) => size.id === config.size);
  const allowed = base < 0 ? [config.size] : sizes.slice(0, base + 2).map((size) => size.id);
  if (!allowed.includes(requested)) {
    return refuse(
      "invalid_request",
      `${words.sizeParameter} can be ${allowed.join(" or ")} (the ${config.label} config's size or one step up).`,
    );
  }
  return { _tag: "size", size: requested };
};
