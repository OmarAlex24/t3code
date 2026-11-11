import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  PeerLinkError,
  ProjectId,
  type SandboxCheckWorkResult,
  type SandboxEnvironmentConfig,
  type SandboxRecord,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SandboxProvisioner from "./SandboxProvisioner.ts";
import * as SubSandboxes from "./SubSandboxes.ts";

const parentThreadId = ThreadId.make("thread:parent");
const projectId = ProjectId.make("project:host");
const sandboxProjectId = ProjectId.make("project:on-sandbox");
const environmentId = EnvironmentId.make("environment:sub");

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

const subRecord = (overrides: Partial<SandboxRecord> = {}): SandboxRecord => ({
  instanceId: "instance-sub",
  environmentId,
  configId: config.id,
  parentThreadId,
  provider: "boat",
  sandboxId: "bx_sub",
  label: "app subagent on Boat",
  size: "default",
  state: "running",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  httpBaseUrl: "https://bx-sub.example",
  runningSince: "2026-11-01T00:00:00.000Z",
  maxRunningMinutes: 480,
  repoDir: "/root/work/app",
  sandboxProjectId,
  ...overrides,
});

/** A sandbox chat's own sandbox, which no subagent asked for. */
const chatRecord = (overrides: Partial<SandboxRecord>): SandboxRecord => {
  const { parentThreadId: _parent, ...record } = subRecord(overrides);
  return record;
};

interface Fakes {
  records: Array<SandboxRecord>;
  linkedEnvironments: boolean;
  linkFails: boolean;
  work: SandboxCheckWorkResult;
  created: Array<
    Parameters<SandboxProvisioner.SandboxProvisioner["Service"]["createSubSandbox"]>[0]
  >;
  linked: Array<Parameters<PeerLinks.PeerLinks["Service"]["link"]>[0]>;
  deleted: Array<string>;
  stopped: Array<string>;
  unlinked: Array<EnvironmentId>;
  /** When set, provisioning waits on it, as a slow machine would. */
  gate: Deferred.Deferred<void> | null;
  /** Completed once two machines are being made. */
  twoStarted: Deferred.Deferred<void> | null;
}

const makeFakes = (overrides: Partial<Fakes> = {}): Fakes => ({
  records: [],
  linkedEnvironments: true,
  linkFails: false,
  work: { status: "clean", uncommittedFiles: 0, unpushedCommits: 0 },
  created: [],
  linked: [],
  deleted: [],
  stopped: [],
  unlinked: [],
  gate: null,
  twoStarted: null,
  ...overrides,
});

const layerFor = (fakes: Fakes) =>
  SubSandboxes.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(SandboxProvisioner.SandboxProvisioner)({
          list: Effect.sync(() => ({ sandboxes: [...fakes.records], orphans: [] })),
          configs: Effect.succeed({ configs: [config] }),
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
            Effect.gen(function* () {
              fakes.created.push(input);
              if (fakes.twoStarted !== null && fakes.created.length === 2) {
                yield* Deferred.succeed(fakes.twoStarted, undefined);
              }
              if (fakes.gate !== null) yield* Deferred.await(fakes.gate);
              fakes.records.push(
                subRecord({ instanceId: input.instanceId, size: input.size, environmentId }),
              );
              return {
                instanceId: input.instanceId,
                provider: "boat" as const,
                sandboxId: "bx_sub",
                environmentId,
                label: "app subagent on Boat",
                httpBaseUrl: "https://bx-sub.example",
                pairingCode: "PAIR-CODE",
                setup: { claude: "ready", github: "ready", tailscale: "skipped", warnings: [] },
              };
            }),
          checkWork: () => Effect.sync(() => fakes.work),
          stop: ({ instanceId }) =>
            Effect.sync(() => {
              fakes.stopped.push(instanceId);
              const index = fakes.records.findIndex((record) => record.instanceId === instanceId);
              const stopped = { ...fakes.records[index]!, state: "stopped" as const };
              fakes.records[index] = stopped;
              return { sandbox: stopped };
            }),
          delete: ({ instanceId }) =>
            Effect.sync(() => {
              fakes.deleted.push(instanceId!);
              fakes.records = fakes.records.filter((record) => record.instanceId !== instanceId);
              return { warnings: [] };
            }),
        }),
        Layer.mock(PeerLinks.PeerLinks)({
          enabled: Effect.sync(() => fakes.linkedEnvironments),
          link: (input) =>
            Effect.suspend(() => {
              fakes.linked.push(input);
              return fakes.linkFails
                ? Effect.fail(new PeerLinkError({ reason: "unreachable", message: "no answer" }))
                : Effect.succeed({} as never);
            }),
          unlink: (id) =>
            Effect.sync(() => {
              fakes.unlinked.push(id);
              return true;
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              id: projectId,
              title: "app",
              workspaceRoot: "/home/me/app",
            } as never),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              canonicalKey: "github.com/acme/app",
              locator: { remoteUrl: "git@github.com:acme/app.git" },
            } as never),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          statusDetailsLocal: () =>
            Effect.succeed({ hasUpstream: true, upstreamRef: "origin/feature/fast" } as never),
        }),
      ),
    ),
  );

const startInput = { parentThreadId, projectId, cwd: "/home/me/app", size: "default" };

describe("SubSandboxes", () => {
  it.effect("starts a sandbox from the project's config, links it and names its project", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const subSandboxes = yield* SubSandboxes.SubSandboxes;
      const started = yield* subSandboxes.start(startInput);
      assert.equal(started.environmentId, environmentId);
      assert.equal(started.projectId, sandboxProjectId);
      assert.equal(fakes.created.length, 1);
      const created = fakes.created[0]!;
      assert.equal(created.config.id, config.id);
      assert.equal(created.size, "default");
      assert.equal(created.parentThreadId, parentThreadId);
      assert.deepEqual(created.project, {
        id: projectId,
        title: "app",
        remoteUrl: "git@github.com:acme/app.git",
        baseRef: "feature/fast",
        hostCopy: { projectId, workspaceRoot: "/home/me/app" },
      });
      assert.deepEqual(fakes.linked, [
        {
          url: "https://bx-sub.example",
          pairingCode: "PAIR-CODE",
          access: "full-access",
          expectedEnvironmentId: environmentId,
          expectedLabel: "app subagent on Boat",
        },
      ]);
    }).pipe(Effect.provide(layerFor(fakes)));
  });

  it.effect("says how to turn on Linked environments and starts nothing while it is off", () => {
    const fakes = makeFakes({ linkedEnvironments: false });
    return Effect.gen(function* () {
      const subSandboxes = yield* SubSandboxes.SubSandboxes;
      const error = yield* subSandboxes.start(startInput).pipe(Effect.flip);
      assert.equal(error.code, "invalid_request");
      assert.include(error.message, "Settings → Labs");
      assert.equal(fakes.created.length, 0);
    }).pipe(Effect.provide(layerFor(fakes)));
  });

  it.effect("counts sandboxes still starting against the parent's limit", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const twoStarted = yield* Deferred.make<void>();
      fakes.gate = gate;
      fakes.twoStarted = twoStarted;
      const subSandboxes = yield* SubSandboxes.SubSandboxes;
      const first = yield* subSandboxes.start(startInput).pipe(Effect.forkChild);
      const second = yield* subSandboxes.start(startInput).pipe(Effect.forkChild);
      // Both hold their places before either machine has a record.
      yield* Deferred.await(twoStarted);
      const third = yield* subSandboxes.start(startInput).pipe(Effect.flip);
      assert.equal(third.code, "concurrency_full");
      assert.equal(fakes.created.length, 2);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }).pipe(Effect.provide(layerFor(fakes)));
  });

  it.effect("deletes a sandbox it could not link", () => {
    const fakes = makeFakes({ linkFails: true });
    return Effect.gen(function* () {
      const subSandboxes = yield* SubSandboxes.SubSandboxes;
      const error = yield* subSandboxes.start(startInput).pipe(Effect.flip);
      assert.equal(error.code, "orchestration_error");
      assert.include(error.message, "could not be linked");
      assert.deepEqual(fakes.deleted, [fakes.created[0]!.instanceId]);
      assert.deepEqual(fakes.records, []);
    }).pipe(Effect.provide(layerFor(fakes)));
  });

  it.effect("deletes a clean sandbox when its task ends", () => {
    const fakes = makeFakes({ records: [subRecord()] });
    return Effect.gen(function* () {
      const subSandboxes = yield* SubSandboxes.SubSandboxes;
      const note = yield* subSandboxes.settle(environmentId);
      assert.include(note, "was deleted");
      assert.deepEqual(fakes.deleted, ["instance-sub"]);
      assert.deepEqual(fakes.unlinked, [environmentId]);
      assert.deepEqual(fakes.stopped, []);
    }).pipe(Effect.provide(layerFor(fakes)));
  });

  it.effect("stops and keeps a sandbox with work, and says where the work is", () => {
    const fakes = makeFakes({
      records: [subRecord()],
      work: { status: "dirty", uncommittedFiles: 3, unpushedCommits: 1 },
    });
    return Effect.gen(function* () {
      const subSandboxes = yield* SubSandboxes.SubSandboxes;
      const note = yield* subSandboxes.settle(environmentId);
      assert.deepEqual(fakes.stopped, ["instance-sub"]);
      assert.deepEqual(fakes.deleted, []);
      assert.deepEqual(fakes.unlinked, []);
      assert.include(note, "3 uncommitted files and 1 unpushed commit");
      assert.include(note, "stopped sandbox app subagent on Boat (bx_sub");
      assert.include(note, "/root/work/app");
      // Ending it again, as a retried completion does, keeps it and says the same place.
      const again = yield* subSandboxes.settle(environmentId);
      assert.include(again, "stopped sandbox app subagent on Boat");
      assert.deepEqual(fakes.stopped, ["instance-sub"]);
    }).pipe(Effect.provide(layerFor(fakes)));
  });

  it.effect("keeps a sandbox it could not check, and leaves other environments alone", () => {
    const fakes = makeFakes({
      records: [
        subRecord(),
        chatRecord({
          instanceId: "chat",
          environmentId: EnvironmentId.make("environment:chat"),
          threadId: parentThreadId,
        }),
      ],
      work: { status: "unknown", uncommittedFiles: 0, unpushedCommits: 0, detail: "no answer" },
    });
    return Effect.gen(function* () {
      const subSandboxes = yield* SubSandboxes.SubSandboxes;
      const note = yield* subSandboxes.settle(environmentId);
      assert.include(note, "could not check");
      assert.deepEqual(fakes.stopped, ["instance-sub"]);
      assert.isUndefined(yield* subSandboxes.settle(EnvironmentId.make("environment:chat")));
      assert.isUndefined(yield* subSandboxes.settle(EnvironmentId.make("environment:elsewhere")));
    }).pipe(Effect.provide(layerFor(fakes)));
  });
});
