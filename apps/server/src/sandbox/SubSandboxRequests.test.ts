// @effect-diagnostics nodeBuiltinImport:off - the sandbox is a temp HOME the real scripts run in with sh.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type SandboxEnvironmentConfig,
  SandboxProviderError,
  type SandboxRecord,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SandboxProvisioner from "./SandboxProvisioner.ts";
import * as SubSandboxes from "./SubSandboxes.ts";
import * as SubSandboxRequests from "./SubSandboxRequests.ts";

// The sandbox's side is a throwaway HOME the real poll and response scripts run in with sh, as a
// provider's exec would; everything on this host past the scripts is a fake.

const chatThreadId = ThreadId.make("thread:sandbox-chat");
const hostProjectId = ProjectId.make("project:host-placeholder");
const subEnvironmentId = EnvironmentId.make("environment:sub");
const subProjectId = ProjectId.make("project:on-sub");
const bridgeInstance = ProviderInstanceId.make("sandboxes");
const taskId = NodeId.make("node:sub-task");

const SHELL_PATH = process.env.PATH;

const config: SandboxEnvironmentConfig = {
  id: "config-boat",
  label: "Boat",
  provider: "boat",
  size: "small",
  passGithubToken: false,
  joinTailnet: false,
  access: "public",
  envFiles: {},
  idleMinutes: 30,
  maxRunningMinutes: 480,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const chatRecord = (overrides: Partial<SandboxRecord> = {}): SandboxRecord => ({
  instanceId: "chat",
  environmentId: EnvironmentId.make("environment:chat"),
  configId: config.id,
  threadId: chatThreadId,
  provider: "boat",
  sandboxId: "bx_chat",
  label: "app on Boat",
  size: "small",
  state: "running",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  httpBaseUrl: "https://bx-chat.example",
  runningSince: "2026-11-01T00:00:00.000Z",
  maxRunningMinutes: 480,
  repoDir: "/home/boat/work/app",
  repository: "acme/app",
  hostProjectId,
  ...overrides,
});

const subRecord = (instanceId: string): SandboxRecord => {
  const { threadId: _threadId, hostProjectId: _project, ...rest } = chatRecord();
  return {
    ...rest,
    instanceId,
    parentThreadId: chatThreadId,
    environmentId: subEnvironmentId,
    sandboxId: `bx_${instanceId}`,
    label: "app subagent on Boat",
    sandboxProjectId: subProjectId,
  };
};

interface Fakes {
  readonly home: string;
  records: Array<SandboxRecord>;
  configs: Array<SandboxEnvironmentConfig>;
  linkedEnvironments: boolean;
  /** The chat's runs on this host: one running turn the bridge relays, unless emptied. */
  runs: Array<unknown>;
  /** The delegated task on the chat's thread here, once recorded. */
  task: { status: string; result: string | null } | null;
  /** Response writes that fail before one goes through, as on a sandbox that stopped. */
  failWrites: number;
  readonly scripts: Array<string>;
  readonly created: Array<
    Parameters<SandboxProvisioner.SandboxProvisioner["Service"]["createSubSandbox"]>[0]
  >;
  readonly delegated: Array<{
    readonly scope: Parameters<RemoteDelegation.RemoteDelegation["Service"]["delegate"]>[0];
    readonly input: Parameters<RemoteDelegation.RemoteDelegation["Service"]["delegate"]>[1];
  }>;
}

const makeFakes = (overrides: Partial<Fakes> = {}): Fakes => ({
  home: NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sub-requests-"))),
  records: [chatRecord()],
  configs: [config],
  linkedEnvironments: true,
  runs: [
    {
      id: RunId.make("run:chat"),
      status: "running",
      rootNodeId: NodeId.make("node:chat"),
      providerInstanceId: bridgeInstance,
      ordinal: 3,
    },
  ],
  task: null,
  failWrites: 0,
  scripts: [],
  created: [],
  delegated: [],
  ...overrides,
});

const queue = (fakes: Fakes, ...parts: Array<string>) =>
  NodePath.join(fakes.home, ".t3/userdata/sub-sandbox", ...parts);

/** What the helper leaves on the sandbox: itself, and a request. */
const installHelper = (fakes: Fakes) => {
  for (const folder of ["requests", "claimed", "responses", "withdrawn", "done"]) {
    NodeFS.mkdirSync(queue(fakes, folder), { recursive: true });
  }
  NodeFS.writeFileSync(queue(fakes, "mcp.mjs"), "// helper");
};
const ask = (fakes: Fakes, id: string, extra: Record<string, unknown> = {}) =>
  NodeFS.writeFileSync(
    queue(fakes, "requests", `${id}.json`),
    JSON.stringify({
      version: 1,
      id,
      task: "Run the full build and its tests",
      threadId: "thread:on-sandbox",
      cwd: "/home/boat/work/app",
      upstream: "origin/feature/fast",
      model: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
      ...extra,
    }),
  );
const responseOf = (fakes: Fakes, id: string) => {
  const file = queue(fakes, "responses", `${id}.json`);
  return NodeFS.existsSync(file) ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : undefined;
};
const polls = (fakes: Fakes) =>
  fakes.scripts.filter((script) => script.includes("T3_SUB_END")).length;

const layerFor = (fakes: Fakes) =>
  SubSandboxRequests.layer.pipe(
    Layer.provideMerge(SubSandboxes.layer),
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(SandboxProvisioner.SandboxProvisioner)({
          list: Effect.sync(() => ({ sandboxes: [...fakes.records], orphans: [] })),
          configs: Effect.sync(() => ({ configs: [...fakes.configs] })),
          providers: Effect.succeed({
            providers: [
              {
                kind: "boat",
                sizes: [
                  { id: "small", label: "Small", detail: "" },
                  { id: "default", label: "Default", detail: "" },
                  { id: "large", label: "Large", detail: "" },
                ],
              },
            ],
          } as never),
          createSubSandbox: (input) =>
            Effect.sync(() => {
              fakes.created.push(input);
              fakes.records.push(subRecord(input.instanceId));
              return {
                instanceId: input.instanceId,
                provider: "boat" as const,
                sandboxId: `bx_${input.instanceId}`,
                environmentId: subEnvironmentId,
                label: "app subagent on Boat",
                httpBaseUrl: "https://bx-sub.example",
                pairingCode: "PAIR-CODE",
                setup: { claude: "ready", github: "ready", tailscale: "skipped", warnings: [] },
              };
            }),
          delete: ({ instanceId }) =>
            Effect.sync(() => {
              fakes.records = fakes.records.filter((record) => record.instanceId !== instanceId);
              return { warnings: [] };
            }),
          runScript: ({ script }) =>
            Effect.suspend(() => {
              fakes.scripts.push(script.command);
              if (script.command.includes("T3_SUB_RESPONSE") && fakes.failWrites > 0) {
                fakes.failWrites -= 1;
                return Effect.fail(
                  new SandboxProviderError({ provider: "boat", stage: "start", detail: "down" }),
                );
              }
              const ran = NodeChildProcess.spawnSync("sh", ["-c", script.command], {
                env: { PATH: SHELL_PATH, HOME: fakes.home, ...script.secrets },
                encoding: "utf8",
              });
              return Effect.succeed({
                exitCode: ran.status ?? 1,
                stdout: ran.stdout,
                stderr: ran.stderr,
              });
            }),
        }),
        Layer.mock(PeerLinks.PeerLinks)({
          enabled: Effect.sync(() => fakes.linkedEnvironments),
          link: () => Effect.succeed({} as never),
          unlink: () => Effect.succeed(true),
        }),
        Layer.mock(ProjectService.ProjectService)({
          // The chat's host project is the placeholder folder a sandbox chat gets, no checkout.
          getById: () =>
            Effect.succeedSome({
              id: hostProjectId,
              title: "app",
              workspaceRoot: "/home/me/.t3/sandbox-projects/acme/app",
            } as never),
        }),
        // A parent on a sandbox has no checkout here to read.
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.die("read a checkout on the host"),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          statusDetailsLocal: () => Effect.die("read a checkout on the host"),
        }),
        Layer.mock(RemoteDelegation.RemoteDelegation)({
          delegate: (scope, input) =>
            Effect.sync(() => {
              fakes.delegated.push({ scope, input });
              fakes.task = { status: "running", result: null };
              return { taskId };
            }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (_threadId, fields) =>
            Effect.sync(
              () =>
                ({
                  thread: { id: chatThreadId, projectId: hostProjectId, title: "app" },
                  runs: fakes.runs,
                  subagents:
                    (fields as ReadonlyArray<string>).includes("subagents") && fakes.task !== null
                      ? [{ id: taskId, ...fakes.task }]
                      : [],
                }) as never,
            ),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:host")),
        }),
      ),
    ),
  );

/** Lets the request a tick forked finish; every fake answers at once. */
const settle = Effect.gen(function* () {
  for (let index = 0; index < 200; index += 1) yield* Effect.yieldNow;
});

const tick = SubSandboxRequests.SubSandboxRequests.pipe(
  Effect.flatMap((requests) => requests.tick),
  Effect.andThen(settle),
);

const cleanUp = (fakes: Fakes) =>
  Effect.sync(() => NodeFS.rmSync(fakes.home, { recursive: true, force: true }));

describe("SubSandboxRequests", () => {
  it.effect(
    "starts a request's task on a new sandbox for the sandbox's chat, once, and writes each status back",
    () => {
      const fakes = makeFakes();
      installHelper(fakes);
      ask(fakes, "req-1", { size: "default" });
      return Effect.gen(function* () {
        yield* tick;
        // The same config, limits and size rules as delegate_task's target.sandbox.
        assert.equal(fakes.created.length, 1);
        const created = fakes.created[0]!;
        assert.equal(created.config.id, config.id);
        assert.equal(created.parentThreadId, chatThreadId);
        assert.equal(created.size, "default");
        // The sandbox's clone, at its pushed branch; no env files from a placeholder folder.
        assert.deepEqual(created.project, {
          id: hostProjectId,
          title: "app",
          remoteUrl: "https://github.com/acme/app.git",
          baseRef: "feature/fast",
        });
        // Recorded on the chat's thread here, on its running turn, with the model it runs.
        assert.equal(fakes.delegated.length, 1);
        const { scope, input } = fakes.delegated[0]!;
        assert.equal(scope.thread.threadId, chatThreadId);
        assert.equal(scope.thread.providerInstanceId, bridgeInstance);
        assert.equal(input.task, "Run the full build and its tests");
        assert.equal(input.mode, "wait");
        assert.equal(input.clientRequestId, "sub-sandbox-request:req-1");
        assert.deepEqual(input.target, {
          environmentId: subEnvironmentId,
          projectId: subProjectId,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-5-5",
        });
        assert.deepInclude(responseOf(fakes, "req-1"), {
          status: "running",
          taskId,
          subSandbox: {
            label: "app subagent on Boat",
            sandboxId: `bx_${fakes.created[0]!.instanceId}`,
            environmentId: subEnvironmentId,
          },
        });

        // Later polls never start it again.
        yield* TestClock.adjust("15 seconds");
        yield* tick;
        yield* TestClock.adjust("15 seconds");
        yield* tick;
        assert.equal(fakes.created.length, 1);
        assert.equal(fakes.delegated.length, 1);
        assert.equal(responseOf(fakes, "req-1").status, "running");

        // Its result, with where the sub-sandbox's work went, goes back with the last status.
        fakes.task = {
          status: "completed",
          result:
            "Build green.\n\n[Sub-sandbox] Its sandbox held no unpushed work and was deleted.",
        };
        yield* tick;
        assert.deepInclude(responseOf(fakes, "req-1"), {
          status: "completed",
          result:
            "Build green.\n\n[Sub-sandbox] Its sandbox held no unpushed work and was deleted.",
        });
        assert.isTrue(NodeFS.existsSync(queue(fakes, "done", "req-1.json")));
        assert.isFalse(NodeFS.existsSync(queue(fakes, "claimed", "req-1.json")));
      }).pipe(Effect.provide(layerFor(fakes)), Effect.ensuring(cleanUp(fakes)));
    },
  );

  it.effect("starts nothing until the sandbox has its first answer", () => {
    const fakes = makeFakes({ failWrites: 1 });
    installHelper(fakes);
    ask(fakes, "req-1");
    return Effect.gen(function* () {
      yield* tick;
      assert.equal(fakes.created.length, 0);
      assert.isUndefined(responseOf(fakes, "req-1"));
      // Still claimed without an answer, so the next poll offers it again.
      yield* TestClock.adjust("15 seconds");
      yield* tick;
      assert.equal(fakes.created.length, 1);
      assert.equal(responseOf(fakes, "req-1").status, "running");
    }).pipe(Effect.provide(layerFor(fakes)), Effect.ensuring(cleanUp(fakes)));
  });

  describe("refusals reach the sandbox", () => {
    const refused = (fakes: Fakes, id = "req-1") =>
      Effect.gen(function* () {
        installHelper(fakes);
        ask(fakes, id);
        yield* tick;
        assert.equal(fakes.created.length, 0);
        assert.equal(fakes.delegated.length, 0);
        const response = responseOf(fakes, id);
        assert.equal(response.status, "failed");
        assert.isTrue(NodeFS.existsSync(queue(fakes, "done", `${id}.json`)));
        return response as { readonly code: string; readonly message: string };
      }).pipe(Effect.provide(layerFor(fakes)), Effect.ensuring(cleanUp(fakes)));

    it.effect("when the chat already has as many sub-sandboxes as its config allows", () => {
      const fakes = makeFakes();
      fakes.records.push(subRecord("one"), subRecord("two"));
      return Effect.gen(function* () {
        const response = yield* refused(fakes);
        assert.equal(response.code, "concurrency_full");
        assert.include(response.message, "the most the Boat config allows");
        assert.include(response.message, "here, on this sandbox");
        assert.notInclude(response.message, "target.sandbox");
      });
    });

    it.effect("when the config allows none", () => {
      const fakes = makeFakes({
        configs: [{ ...config, subSandboxes: { perThread: 0, total: 0 } }],
      });
      return Effect.gen(function* () {
        const response = yield* refused(fakes);
        assert.equal(response.code, "concurrency_full");
        assert.include(response.message, "does not let subagents start sandboxes");
      });
    });

    it.effect("when Linked environments is off", () => {
      const fakes = makeFakes({ linkedEnvironments: false });
      return Effect.gen(function* () {
        const response = yield* refused(fakes);
        assert.equal(response.code, "invalid_request");
        assert.include(response.message, "Settings → Labs");
      });
    });

    it.effect("when the sandbox's config is gone", () => {
      const fakes = makeFakes({ configs: [] });
      return Effect.gen(function* () {
        const response = yield* refused(fakes);
        assert.equal(response.code, "invalid_request");
        assert.include(response.message, "config no longer exists");
      });
    });

    it.effect("when the chat runs no turn on this host", () => {
      const fakes = makeFakes({ runs: [] });
      return Effect.gen(function* () {
        const response = yield* refused(fakes);
        assert.equal(response.code, "parent_not_active");
        assert.include(response.message, "Run this work here, on this sandbox");
      });
    });

    it.effect("when it asks for more than one size up", () => {
      const fakes = makeFakes();
      return Effect.gen(function* () {
        installHelper(fakes);
        ask(fakes, "req-1", { size: "large" });
        yield* tick;
        const response = responseOf(fakes, "req-1");
        assert.equal(response.status, "failed");
        assert.include(response.message, "size can be small or default");
      }).pipe(Effect.provide(layerFor(fakes)), Effect.ensuring(cleanUp(fakes)));
    });
  });

  it.effect("picks up where it left off after a restart without running a request twice", () => {
    const fakes = makeFakes();
    installHelper(fakes);
    ask(fakes, "req-1");
    // Picked up before a restart, but the server stopped while starting its sandbox.
    NodeFS.writeFileSync(
      queue(fakes, "claimed", "req-2.json"),
      JSON.stringify({ version: 1, id: "req-2", task: "Lint" }),
    );
    NodeFS.writeFileSync(
      queue(fakes, "responses", "req-2.json"),
      JSON.stringify({
        version: 1,
        id: "req-2",
        status: "starting_sandbox",
        message: "",
        updatedAt: "",
      }),
    );
    return Effect.gen(function* () {
      yield* tick.pipe(Effect.provide(layerFor(fakes)));
      assert.equal(fakes.created.length, 1);
      assert.equal(responseOf(fakes, "req-1").status, "running");
      const interrupted = responseOf(fakes, "req-2");
      assert.equal(interrupted.status, "failed");
      assert.include(interrupted.message, "restarted while it was starting this sandbox");

      // A new server finds req-1 open with its task, and follows it to the end.
      yield* Effect.gen(function* () {
        yield* tick;
        yield* TestClock.adjust("15 seconds");
        yield* tick;
        assert.equal(fakes.created.length, 1);
        assert.equal(fakes.delegated.length, 1);
        fakes.task = { status: "failed", result: "Out of disk." };
        yield* tick;
        assert.deepInclude(responseOf(fakes, "req-1"), {
          status: "failed",
          result: "Out of disk.",
        });
      }).pipe(Effect.provide(layerFor(fakes)));
    }).pipe(Effect.ensuring(cleanUp(fakes)));
  });

  it.effect("polls a working chat's sandbox every 15 s and an idle one every 60 s", () => {
    const fakes = makeFakes({ runs: [] });
    installHelper(fakes);
    return Effect.gen(function* () {
      yield* tick;
      assert.equal(polls(fakes), 1);
      for (let second = 5; second < 60; second += 5) {
        yield* TestClock.adjust("5 seconds");
        yield* tick;
      }
      assert.equal(polls(fakes), 1);
      yield* TestClock.adjust("5 seconds");
      yield* tick;
      assert.equal(polls(fakes), 2);

      // A turn on the chat is when its agents can ask.
      fakes.runs = makeFakes().runs;
      for (let second = 0; second < 60; second += 5) {
        yield* TestClock.adjust("5 seconds");
        yield* tick;
      }
      assert.equal(polls(fakes), 6);

      // A stopped sandbox, and a subagent's own, are never polled.
      fakes.records = [chatRecord({ state: "stopped", runningSince: null }), subRecord("sub")];
      for (let second = 0; second < 60; second += 5) {
        yield* TestClock.adjust("5 seconds");
        yield* tick;
      }
      assert.equal(polls(fakes), 6);
    }).pipe(Effect.provide(layerFor(fakes)), Effect.ensuring(cleanUp(fakes)));
  });

  it.effect("polls a sandbox without the helper once per running stretch", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* tick;
      for (let second = 0; second < 120; second += 5) {
        yield* TestClock.adjust("5 seconds");
        yield* tick;
      }
      assert.equal(fakes.scripts.length, 1);
      // A resume may have added it.
      fakes.records = [chatRecord({ runningSince: "2026-11-02T00:00:00.000Z" })];
      yield* tick;
      assert.equal(fakes.scripts.length, 2);
    }).pipe(Effect.provide(layerFor(fakes)), Effect.ensuring(cleanUp(fakes)));
  });
});
