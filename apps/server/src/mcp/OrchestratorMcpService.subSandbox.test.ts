import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SubSandboxes from "../sandbox/SubSandboxes.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const parentThreadId = ThreadId.make("thread:sub-parent");
const projectId = ProjectId.make("project:sub");
const providerInstanceId = ProviderInstanceId.make("claude");
const environmentId = EnvironmentId.make("environment:sub-sandbox");
const sandboxProjectId = ProjectId.make("project:on-sub-sandbox");
const taskId = NodeId.make("node:sub-task");

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:host"),
  requestNamespace: "provider-session:sub",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:sub",
    providerInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const parentProjection = {
  thread: { id: parentThreadId, projectId, worktreePath: "/home/me/app-worktree" },
  runs: [
    {
      id: RunId.make("run:sub-parent"),
      status: "running",
      rootNodeId: NodeId.make("node:sub-parent"),
      providerInstanceId,
      ordinal: 1,
    },
  ],
  messages: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  contextTransfers: [],
  turnItems: [],
};

const remoteTask = {
  id: taskId,
  threadId: parentThreadId,
  origin: "app_owned",
  childThreadId: null,
  remoteChild: {
    environmentId,
    threadId: ThreadId.make("thread:on-sub-sandbox"),
    label: "app subagent on Boat",
    title: "Build",
  },
  providerInstanceId,
  model: "claude-opus-5-5",
  status: "running",
  result: null,
};

interface Calls {
  started: Array<Parameters<SubSandboxes.SubSandboxes["Service"]["start"]>[0]>;
  delegated: Array<Parameters<RemoteDelegation.RemoteDelegation["Service"]["delegate"]>[1]>;
  discarded: Array<string>;
}

const layerFor = (calls: Calls, options: { readonly delegateFails?: boolean } = {}) =>
  OrchestratorMcpService.layer.pipe(
    Layer.provideMerge(
      Layer.mock(SubSandboxes.SubSandboxes)({
        start: (input) =>
          Effect.sync(() => {
            calls.started.push(input);
            return { instanceId: "instance-sub", environmentId, projectId: sandboxProjectId };
          }),
        discard: (instanceId) =>
          Effect.sync(() => {
            calls.discarded.push(instanceId);
          }),
      }),
    ),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (_threadId, fields) =>
            Effect.succeed(
              (fields.includes("subagents")
                ? { thread: parentProjection.thread, subagents: [remoteTask] }
                : parentProjection) as never,
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/home/me/app" } as never)),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({
          delegate: (_scope, input) =>
            Effect.suspend(() => {
              calls.delegated.push(input);
              return options.delegateFails === true
                ? Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "invalid_request",
                      message: "refused there",
                    }),
                  )
                : Effect.succeed({ taskId });
            }),
        }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      ),
    ),
  );

const delegate = (input: OrchestratorMcpDelegateTaskInput) =>
  OrchestratorMcpService.OrchestratorMcpService.pipe(
    Effect.flatMap((service) => service.delegateTask(scope, input)),
  );

const newCalls = (): Calls => ({ started: [], delegated: [], discarded: [] });

describe("OrchestratorMcpService delegate_task on a sub-sandbox", () => {
  it.effect("starts the sandbox and runs the task there as a linked task", () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      const result = yield* delegate({
        task: "Run the full build",
        target: { model: "claude-opus-5-5", sandbox: { size: "large" } },
      });
      assert.deepEqual(calls.started, [
        { parentThreadId, projectId, cwd: "/home/me/app-worktree", size: "large" },
      ]);
      assert.equal(calls.delegated.length, 1);
      const delegated = calls.delegated[0]!;
      assert.deepEqual(delegated.target, {
        model: "claude-opus-5-5",
        environmentId,
        projectId: sandboxProjectId,
      });
      assert.equal(delegated.task, "Run the full build");
      assert.equal(result.taskId, taskId);
      assert.equal(result.remoteChild?.environmentId, environmentId);
      assert.equal(result.status, "running");
      assert.deepEqual(calls.discarded, []);
    }).pipe(Effect.provide(layerFor(calls)));
  });

  it.effect("refuses target.sandbox with target.environmentId before starting anything", () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      const error = yield* delegate({
        task: "Build",
        target: { environmentId: EnvironmentId.make("environment:vps"), sandbox: {} },
      }).pipe(Effect.flip);
      assert.equal(error.code, "invalid_request");
      assert.include(error.message, "target.environmentId");
      assert.deepEqual(calls.started, []);
      assert.deepEqual(calls.delegated, []);
    }).pipe(Effect.provide(layerFor(calls)));
  });

  it.effect("refuses a linked caller", () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const error = yield* service
        .delegateTask(
          {
            ...scope,
            client: { sessionId: "link", label: "Laptop", access: "full-access", linked: true },
          },
          { task: "Build", target: { sandbox: {} } },
        )
        .pipe(Effect.flip);
      assert.equal(error.code, "capability_denied");
      assert.deepEqual(calls.started, []);
    }).pipe(Effect.provide(layerFor(calls)));
  });

  it.effect("deletes the sandbox when the task cannot start there", () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      const error = yield* delegate({ task: "Build", target: { sandbox: {} } }).pipe(Effect.flip);
      assert.equal(error.message, "refused there");
      assert.deepEqual(calls.discarded, ["instance-sub"]);
    }).pipe(Effect.provide(layerFor(calls, { delegateFails: true })));
  });
});
