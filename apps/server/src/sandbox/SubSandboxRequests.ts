import {
  isSandboxHostProjectRoot,
  type NodeId,
  type OrchestrationV2Subagent,
  ProviderInstanceId,
  type SandboxRecord,
  type ThreadId,
} from "@t3tools/contracts";
import { CLAUDE_FALLBACK_MODEL } from "@t3tools/sandbox-bridge";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as SandboxProvisioner from "./SandboxProvisioner.ts";
import {
  parseSubSandboxPoll,
  SUB_SANDBOX_POLL_SCRIPT,
  SUB_SANDBOX_REQUEST_ID,
  subSandboxRespondScript,
} from "./subSandboxHelper.ts";
import * as SubSandboxes from "./SubSandboxes.ts";

/**
 * Requests from agents on a sandbox (`sandbox_delegate`), started as `delegate_task` with
 * `target.sandbox` would, for the sandbox's chat. One exec per poll: every 15 s while the chat runs
 * a turn here or has a request open or recent, else every 60 s; never while stopped.
 */
export class SubSandboxRequests extends Context.Service<
  SubSandboxRequests,
  {
    /** One pass: polls the sandboxes that are due and writes what changed. Tests step it. */
    readonly tick: Effect.Effect<void>;
    /** Ticks every few seconds for as long as the server runs. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/sandbox/SubSandboxRequests") {}

/** How often a sandbox whose agents are working, or that has requests, is polled. */
const ACTIVE_POLL_SECONDS = 15;
/** How often any other running sandbox with the helper is polled. */
const IDLE_POLL_SECONDS = 60;
/** A sandbox stays on the active cadence this long after a request. */
const RECENT_REQUEST_SECONDS = 300;
const TICK_SECONDS = 5;
const POLL_TIMEOUT_SECONDS = 30;
const WRITE_TIMEOUT_SECONDS = 30;
/** The longest result written back; the agent reads the rest in the chat on the computer. */
const MAX_RESULT_LENGTH = 50_000;

const SubSandboxRequestFile = Schema.Struct({
  id: Schema.String,
  task: Schema.String,
  size: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  upstream: Schema.optional(Schema.String),
  model: Schema.optional(Schema.Struct({ instanceId: Schema.String, model: Schema.String })),
});
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(SubSandboxRequestFile));

export const SubSandboxResponseStatus = Schema.Literals([
  "queued",
  "starting_sandbox",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type SubSandboxResponseStatus = typeof SubSandboxResponseStatus.Type;

/** What the helper reads from `responses/<id>.json`. */
export const SubSandboxResponse = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  status: SubSandboxResponseStatus,
  message: Schema.String,
  updatedAt: Schema.String,
  /** Why it was refused, as `delegate_task` would say: `concurrency_full`, `invalid_request`… */
  code: Schema.optional(Schema.String),
  /** The task on the sandbox chat's thread on this host, once it is recorded. */
  taskId: Schema.optional(Schema.String),
  subSandbox: Schema.optional(
    Schema.Struct({ label: Schema.String, sandboxId: Schema.String, environmentId: Schema.String }),
  ),
  /** The subagent's last reply, with where its sandbox's work went. */
  result: Schema.optional(Schema.String),
});
export type SubSandboxResponse = typeof SubSandboxResponse.Type;
const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(SubSandboxResponse));

const TERMINAL: ReadonlySet<SubSandboxResponseStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const NO_TURN_HERE =
  "Not started: T3 Code on the user's computer records a sub-sandbox's task on this chat's running turn, and it sees none there. That happens when a turn did not go through T3 Code on the computer or phone. Run this work here, on this sandbox.";
const INTERRUPTED =
  "T3 Code on the user's computer restarted while it was starting this sandbox, so it does not know whether one was made. Nothing will run for this request; ask again with a new id. If a sandbox from it shows under Settings → Connections → Sandboxes, delete it there.";

/** A branch name `git clone --branch` takes from a tracking ref such as `origin/feature/x`. */
const branchOf = (upstream: string | undefined) => {
  if (upstream === undefined) return undefined;
  const slash = upstream.indexOf("/");
  const branch = slash < 0 ? "" : upstream.slice(slash + 1);
  return /^[A-Za-z0-9._/-]{1,200}$/u.test(branch) &&
    !branch.includes("..") &&
    !branch.startsWith("-")
    ? branch
    : undefined;
};

const statusOfTask = (task: OrchestrationV2Subagent): SubSandboxResponseStatus =>
  task.status === "completed" ? "completed" : task.status === "cancelled" ? "cancelled" : "failed";

const clip = (text: string) =>
  text.length <= MAX_RESULT_LENGTH
    ? text
    : `${text.slice(0, MAX_RESULT_LENGTH)}\n\n[Cut at ${MAX_RESULT_LENGTH} characters. The whole result is in the chat's task on the user's computer.]`;

interface OpenRequest {
  readonly id: string;
  readonly parentThreadId: ThreadId;
  status: SubSandboxResponseStatus;
  taskId: NodeId | undefined;
  subSandbox: SubSandboxResponse["subSandbox"];
  /** Being started; its handler writes its statuses, not the tick. */
  starting: boolean;
  /** The newest response the sandbox has not taken yet, as when it stopped meanwhile. */
  unwritten: SubSandboxResponse | null;
}

interface Watched {
  lastPolledAt: number | null;
  lastRequestAt: number | null;
  /** The running stretch a poll found no helper in; the next stretch polls again. */
  noHelperIn: string | null;
  polling: boolean;
  readonly open: Map<string, OpenRequest>;
}

const make = Effect.gen(function* () {
  const provisioner = yield* SandboxProvisioner.SandboxProvisioner;
  const subSandboxes = yield* SubSandboxes.SubSandboxes;
  const remoteDelegation = yield* RemoteDelegation.RemoteDelegation;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  // Requests being started live as long as this service, so shutting down stops them.
  const scope = yield* Scope.Scope;
  const watched = new Map<string, Watched>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const watchOf = (instanceId: string) => {
    const existing = watched.get(instanceId);
    if (existing !== undefined) return existing;
    const created: Watched = {
      lastPolledAt: null,
      lastRequestAt: null,
      noHelperIn: null,
      polling: false,
      open: new Map(),
    };
    watched.set(instanceId, created);
    return created;
  };

  const response = (
    request: Pick<OpenRequest, "id" | "taskId" | "subSandbox">,
    status: SubSandboxResponseStatus,
    message: string,
    extra: { readonly code?: string; readonly result?: string } = {},
  ) =>
    nowIso.pipe(
      Effect.map((updatedAt): SubSandboxResponse => ({
        version: 1,
        id: request.id,
        status,
        message,
        updatedAt,
        ...(extra.code === undefined ? {} : { code: extra.code }),
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        ...(request.subSandbox === undefined ? {} : { subSandbox: request.subSandbox }),
        ...(extra.result === undefined ? {} : { result: clip(extra.result) }),
      })),
    );

  /** Writes `next` on the sandbox, or keeps it for the next tick when that fails. */
  const write = (record: SandboxRecord, request: OpenRequest, next: SubSandboxResponse) =>
    provisioner
      .runScript({
        instanceId: record.instanceId,
        script: subSandboxRespondScript(request.id, next, TERMINAL.has(next.status)),
        timeoutSeconds: WRITE_TIMEOUT_SECONDS,
      })
      .pipe(
        Effect.map((result) => result.exitCode === 0),
        Effect.orElseSucceed(() => false),
        Effect.map((written) => {
          request.status = next.status;
          request.unwritten = written ? null : next;
          if (written && TERMINAL.has(next.status)) {
            watchOf(record.instanceId).open.delete(request.id);
          }
          return written;
        }),
      );

  const refuse = (record: SandboxRecord, request: OpenRequest, message: string, code: string) =>
    response(request, "failed", message, { code }).pipe(
      Effect.flatMap((next) => write(record, request, next)),
      Effect.asVoid,
    );

  /**
   * Starts one request's task: on behalf of the sandbox's chat, whose thread on this host is the
   * parent, through the same sandbox config, limits and sizes as `delegate_task`'s `target.sandbox`.
   */
  const handle = Effect.fn("SubSandboxRequests.handle")(function* (
    record: SandboxRecord,
    request: OpenRequest,
    json: string,
  ) {
    const decoded = decodeRequest(json);
    if (Option.isNone(decoded) || decoded.value.task.trim() === "") {
      return yield* refuse(
        record,
        request,
        "Not started: the request could not be read.",
        "invalid_request",
      );
    }
    const asked = decoded.value;
    const parent = yield* threads
      .getThreadRecords(request.parentThreadId, ["runs"])
      .pipe(Effect.option);
    if (Option.isNone(parent)) {
      return yield* refuse(record, request, NO_TURN_HERE, "parent_not_active");
    }
    const parentRun = parent.value.runs
      .filter(ThreadManagement.isActiveRun)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    if (parentRun === undefined || parentRun.rootNodeId === null) {
      return yield* refuse(record, request, NO_TURN_HERE, "parent_not_active");
    }
    if (record.repository === undefined) {
      return yield* refuse(
        record,
        request,
        "Not started: T3 Code on the user's computer does not know which repository this sandbox cloned.",
        "invalid_request",
      );
    }
    yield* write(
      record,
      request,
      yield* response(
        request,
        "starting_sandbox",
        "T3 Code on the user's computer is starting a sandbox for it.",
      ),
    );
    const projectId = parent.value.thread.projectId;
    const project = yield* projects.getById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    const workspaceRoot = project?.workspaceRoot ?? "";
    const started = yield* subSandboxes
      .start({
        parentThreadId: request.parentThreadId,
        projectId,
        cwd: workspaceRoot,
        size: asked.size,
        repository: {
          remoteUrl: `https://github.com/${record.repository}.git`,
          canonicalKey: `github.com/${record.repository}`,
          baseRef: branchOf(asked.upstream),
          // Env files come from the host's own checkout, never from a placeholder folder.
          hostCheckout: workspaceRoot !== "" && !isSandboxHostProjectRoot(workspaceRoot),
        },
        caller: "sandbox",
      })
      .pipe(Effect.result);
    if (started._tag === "Failure") {
      return yield* refuse(
        record,
        request,
        `Not started: ${started.failure.message}`,
        started.failure.code,
      );
    }
    const sub = started.success;
    const model = asked.model ?? CLAUDE_FALLBACK_MODEL;
    const threadScope: McpInvocationContext.McpThreadInvocationScope = {
      environmentId: hereId,
      requestNamespace: `sub-sandbox-request:${record.instanceId}`,
      thread: {
        threadId: request.parentThreadId,
        providerSessionId: `sub-sandbox-request:${record.instanceId}`,
        providerInstanceId: parentRun.providerInstanceId,
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    };
    const delegated = yield* remoteDelegation
      .delegate(threadScope, {
        task: asked.task.trim(),
        // A result reaching a turn still running is read through sandbox_task_status; one that
        // arrives after the turn ended wakes the chat, as a local delegated task would.
        mode: "wait",
        clientRequestId: `sub-sandbox-request:${request.id}`,
        target: {
          environmentId: sub.environmentId,
          ...(sub.projectId === undefined ? {} : { projectId: sub.projectId }),
          providerInstanceId: ProviderInstanceId.make(model.instanceId),
          model: model.model,
        },
      })
      .pipe(Effect.result);
    if (delegated._tag === "Failure") {
      yield* subSandboxes.discard(sub.instanceId);
      return yield* refuse(
        record,
        request,
        `Not started: the sandbox started, but its task could not: ${delegated.failure.message} The sandbox was deleted.`,
        delegated.failure.code,
      );
    }
    const made = yield* provisioner.list.pipe(
      Effect.map((listed) =>
        listed.sandboxes.find((candidate) => candidate.instanceId === sub.instanceId),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    request.taskId = delegated.success.taskId;
    request.subSandbox = {
      label: made?.label ?? "a new sandbox",
      sandboxId: made?.sandboxId ?? "",
      environmentId: sub.environmentId,
    };
    yield* write(
      record,
      request,
      yield* response(
        request,
        "running",
        "The subagent is working on its own sandbox. It shows under this chat on the user's computer.",
      ),
    );
  });

  /** A task this side recorded: its result, once it has one, goes back to the sandbox. */
  const follow = Effect.fn("SubSandboxRequests.follow")(function* (
    record: SandboxRecord,
    request: OpenRequest,
  ) {
    if (request.taskId === undefined) return;
    const task = yield* threads
      .getThreadRecords(request.parentThreadId, ["subagents"], { subagentIds: [request.taskId] })
      .pipe(
        Effect.map(({ subagents }) => subagents[0]),
        Effect.orElseSucceed(() => undefined),
      );
    if (task === undefined || task.result === null) return;
    const status = statusOfTask(task);
    yield* write(
      record,
      request,
      yield* response(
        request,
        status,
        status === "completed"
          ? "The subagent finished."
          : status === "cancelled"
            ? "The task was cancelled on the user's computer."
            : "The subagent's task ended without finishing.",
        { result: task.result },
      ),
    );
  });

  /** A request this server has not tracked since it started: picked up before a restart. */
  const recover = Effect.fn("SubSandboxRequests.recover")(function* (
    record: SandboxRecord,
    watch: Watched,
    id: string,
    json: string,
  ) {
    const previous = decodeResponse(json);
    const request: OpenRequest = {
      id,
      parentThreadId: record.threadId!,
      status: Option.isSome(previous) ? previous.value.status : "queued",
      taskId:
        Option.isSome(previous) && previous.value.taskId !== undefined
          ? (previous.value.taskId as NodeId)
          : undefined,
      subSandbox: Option.isSome(previous) ? previous.value.subSandbox : undefined,
      starting: false,
      unwritten: null,
    };
    watch.open.set(id, request);
    // Already answered: only moving it to done/ was missed.
    if (Option.isSome(previous) && TERMINAL.has(previous.value.status)) {
      return yield* write(record, request, previous.value);
    }
    // It never reached a task, so whatever started it is gone; it is never started twice.
    if (request.taskId === undefined) {
      return yield* write(
        record,
        request,
        yield* response(request, "failed", INTERRUPTED, { code: "orchestration_error" }),
      );
    }
    return true;
  });

  const poll = Effect.fn("SubSandboxRequests.poll")(function* (
    record: SandboxRecord,
    watch: Watched,
    now: number,
  ) {
    watch.lastPolledAt = now;
    const result = yield* provisioner
      .runScript({
        instanceId: record.instanceId,
        script: { command: SUB_SANDBOX_POLL_SCRIPT },
        timeoutSeconds: POLL_TIMEOUT_SECONDS,
      })
      .pipe(Effect.option);
    if (Option.isNone(result)) return;
    const polled = parseSubSandboxPoll(result.value.stdout);
    if (polled === null) return;
    if (!polled.installed) {
      watch.noHelperIn = record.runningSince;
      return;
    }
    for (const open of polled.open) {
      if (!watch.open.has(open.id)) yield* recover(record, watch, open.id, open.json);
    }
    for (const asked of polled.requests) {
      if (watch.open.has(asked.id) || !SUB_SANDBOX_REQUEST_ID.test(asked.id)) continue;
      watch.lastRequestAt = now;
      const request: OpenRequest = {
        id: asked.id,
        parentThreadId: record.threadId!,
        status: "queued",
        taskId: undefined,
        subSandbox: undefined,
        starting: true,
        unwritten: null,
      };
      watch.open.set(asked.id, request);
      // Nothing starts until the sandbox has the first answer: a request whose first answer
      // never landed is offered again by the next poll, and one that has it is never started
      // twice, a restart included (see `recover`).
      const queued = yield* write(
        record,
        request,
        yield* response(request, "queued", "T3 Code on the user's computer picked it up."),
      );
      if (!queued) {
        watch.open.delete(asked.id);
        continue;
      }
      yield* handle(record, request, asked.json).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("sub-sandbox request failed", { id: asked.id, cause }).pipe(
            Effect.andThen(
              refuse(
                record,
                request,
                "Not started: T3 Code on the user's computer hit an error starting it.",
                "orchestration_error",
              ),
            ),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            request.starting = false;
          }),
        ),
        Effect.forkIn(scope),
      );
    }
  });

  /** Whether the chat runs a turn on this host, which is when its agents can ask. */
  const chatIsWorking = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.map(({ runs }) => runs.some(ThreadManagement.isActiveRun)),
      Effect.orElseSucceed(() => false),
    );

  const visit = Effect.fn("SubSandboxRequests.visit")(function* (
    record: SandboxRecord,
    now: number,
  ) {
    const watch = watchOf(record.instanceId);
    for (const request of watch.open.values()) {
      if (request.starting) continue;
      if (request.unwritten !== null) {
        yield* write(record, request, request.unwritten);
      } else {
        yield* follow(record, request);
      }
    }
    if (watch.polling || watch.noHelperIn === record.runningSince) return;
    const recent =
      watch.lastRequestAt !== null && now - watch.lastRequestAt < RECENT_REQUEST_SECONDS * 1000;
    const active = watch.open.size > 0 || recent || (yield* chatIsWorking(record.threadId!));
    const every = (active ? ACTIVE_POLL_SECONDS : IDLE_POLL_SECONDS) * 1000;
    // A tick's own delay is not held against the next poll.
    if (watch.lastPolledAt !== null && now - watch.lastPolledAt < every - 1000) return;
    watch.polling = true;
    yield* poll(record, watch, now).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          watch.polling = false;
        }),
      ),
    );
  });

  const tick: SubSandboxRequests["Service"]["tick"] = Effect.gen(function* () {
    const listed = yield* provisioner.list.pipe(Effect.option);
    if (Option.isNone(listed)) return;
    const live = new Set(listed.value.sandboxes.map((record) => record.instanceId));
    for (const instanceId of watched.keys()) {
      if (!live.has(instanceId)) watched.delete(instanceId);
    }
    const now = yield* Clock.currentTimeMillis;
    // A chat's sandbox only: a subagent's sandbox has no chat on this host to hold more tasks.
    const due = listed.value.sandboxes.filter(
      (record) =>
        record.state === "running" &&
        record.resumingSince === undefined &&
        record.threadId !== undefined &&
        record.parentThreadId === undefined &&
        record.environmentId !== null,
    );
    yield* Effect.forEach(due, (record) => visit(record, now), {
      concurrency: 4,
      discard: true,
    });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("sub-sandbox requests tick failed", { cause })),
  );

  const start: SubSandboxRequests["Service"]["start"] = () =>
    forkParked(tick.pipe(Effect.repeat(Schedule.spaced(`${TICK_SECONDS} seconds`)), Effect.asVoid));

  return SubSandboxRequests.of({ tick, start });
});

export const layer = Layer.effect(SubSandboxRequests, make);
