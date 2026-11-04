import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as SandboxRecords from "../SandboxRecords.ts";

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });
const layer = it.layer(
  Layer.mergeAll(
    sqlite,
    SandboxRecords.layer.pipe(Layer.provide(sqlite)),
    SandboxRecords.layerConfigs.pipe(Layer.provide(sqlite)),
  ),
);

const running = EnvironmentId.make("11111111-1111-4111-8111-111111111111");
const stopped = EnvironmentId.make("22222222-2222-4222-8222-222222222222");
const legacy = (environmentId: string, state: string) => ({
  environmentId,
  provider: "boat",
  sandboxId: `bx_${state}`,
  label: `${state} sandbox`,
  size: "small",
  state,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  httpBaseUrl: "https://boat.example/t3",
  hardDeadlineAt: "2026-10-01T08:00:00.000Z",
  ttlMinutes: 240,
});

layer("081_SandboxPerThread", (it) => {
  it.effect(
    "keys existing sandboxes by instance and turns their lifetime into a running limit",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 80 });
        for (const [id, state] of [
          [running, "running"],
          [stopped, "stopped"],
        ] as const) {
          yield* sql`
          INSERT INTO sandbox_records (environment_id, record_json, updated_at)
          VALUES (${id}, ${JSON.stringify(legacy(id, state))}, '2026-10-02T00:00:00.000Z')
        `;
        }
        yield* runMigrations({ toMigrationInclusive: 81 });

        const records = yield* SandboxRecords.SandboxRecordRepository;
        const migrated = yield* records.get(running);
        assert.deepStrictEqual(Option.getOrThrow(migrated), {
          instanceId: running,
          environmentId: running,
          provider: "boat",
          sandboxId: "bx_running",
          label: "running sandbox",
          size: "small",
          state: "running",
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-02T00:00:00.000Z",
          httpBaseUrl: "https://boat.example/t3",
          maxRunningMinutes: 240,
          runningSince: "2026-10-02T00:00:00.000Z",
        });
        const stoppedRecord = Option.getOrThrow(yield* records.findByEnvironmentId(stopped));
        assert.strictEqual(stoppedRecord.runningSince, null);
        assert.strictEqual(stoppedRecord.instanceId, stopped);

        const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sandbox_%' ORDER BY name
      `;
        assert.deepStrictEqual(
          tables.map((table) => table.name),
          ["sandbox_configs", "sandbox_instances"],
        );

        // A launch writes its record before the machine answers with an environment id.
        yield* records.put({
          ...Option.getOrThrow(migrated),
          instanceId: "launching",
          environmentId: null,
          sandboxId: "bx_new",
          state: "provisioning",
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          projectTitle: "hello",
          configId: "config-1",
        });
        assert.strictEqual((yield* records.list).length, 3);
        yield* records.remove("launching");
        assert.strictEqual((yield* records.list).length, 2);

        const configs = yield* SandboxRecords.SandboxConfigRepository;
        const config = {
          id: "config-1",
          label: "Boat small",
          provider: "boat",
          size: "small",
          passGithubToken: false,
          joinTailnet: false,
          access: "public",
          projectIds: [],
          envFiles: { "project-1": [".env"] },
          idleMinutes: 30,
          maxRunningMinutes: 480,
          createdAt: "2026-10-03T00:00:00.000Z",
          updatedAt: "2026-10-03T00:00:00.000Z",
        } as const;
        yield* configs.put(config);
        assert.deepStrictEqual(Option.getOrThrow(yield* configs.get("config-1")), config);
        yield* configs.remove("config-1");
        assert.deepStrictEqual(yield* configs.list, []);
      }),
  );
});
