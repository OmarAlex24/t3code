import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { FORK_MIGRATIONS_TABLE, runAllMigrations } from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import SandboxRecords from "./ForkMigrations/001_SandboxRecords.ts";
import SandboxPerThread from "./ForkMigrations/002_SandboxPerThread.ts";

const forkHistory: Array<readonly [number, string]> = [
  [1, "SandboxRecords"],
  [2, "SandboxPerThread"],
  [3, "ProjectionMilestones"],
];

const history = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `;
    return rows.map((row) => [row.migration_id, row.name] as const);
  });

const sandboxTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sandbox_%' ORDER BY name
  `;
  return rows.map((row) => row.name);
});

describe("runAllMigrations", () => {
  it.effect(
    "moves fork migrations a build recorded as upstream's 80 and 81 to their own table",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 79 });
        yield* SandboxRecords;
        yield* SandboxPerThread;
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES
          (80, 'SandboxRecords', '2026-11-04 18:46:23'),
          (81, 'SandboxPerThread', '2026-11-05 00:15:09')
      `;
        yield* sql`
        INSERT INTO sandbox_instances (instance_id, environment_id, record_json, updated_at)
        VALUES ('instance-1', 'env-1', '{"state":"running"}', '2026-11-05T00:00:00.000Z')
      `;
        yield* sql`
        INSERT INTO sandbox_configs (config_id, config_json, updated_at)
        VALUES ('config-1', '{"label":"Boat small"}', '2026-11-05T00:00:00.000Z')
      `;
        yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
          task_id: "continues-thread",
          title: "task",
          prompt: "Run",
          enabled: 1,
          schedule_json: '{"type":"interval","everyMs":60000}',
          project_id: "project",
          thread_id: "thread-1",
          workspace_strategy_json: '{"type":"root"}',
          model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
          runtime_mode: "full-access",
          interaction_mode: "default",
          created_by: "user",
          creation_source: "web",
          created_at: "2026-10-01T00:00:00.000Z",
          updated_at: "2026-10-01T00:00:00.000Z",
          next_run_at: null,
          last_run_at: null,
          last_run_status: "never",
          last_run_error: null,
          run_count: 0,
        })}`;

        const upstreamAfter79 = migrationManifest.filter(([id]) => id > 79);
        assert.deepStrictEqual(yield* runAllMigrations(), upstreamAfter79);
        assert.deepStrictEqual(yield* history("effect_sql_migrations"), migrationManifest);
        assert.deepStrictEqual(yield* history(FORK_MIGRATIONS_TABLE), forkHistory);
        const forkCreatedAt = yield* sql<{ readonly created_at: string }>`
        SELECT created_at FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id
      `;
        assert.deepStrictEqual(
          forkCreatedAt.slice(0, 2).map((row) => row.created_at),
          ["2026-11-04 18:46:23", "2026-11-05 00:15:09"],
        );
        assert.deepStrictEqual(yield* sql`SELECT task_id, thread_mode FROM scheduled_tasks`, [
          { task_id: "continues-thread", thread_mode: "continue" },
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT instance_id, environment_id FROM sandbox_instances`,
          [{ instance_id: "instance-1", environment_id: "env-1" }],
        );
        assert.deepStrictEqual(yield* sql`SELECT config_id FROM sandbox_configs`, [
          { config_id: "config-1" },
        ]);

        assert.deepStrictEqual(yield* runAllMigrations(), []);
        assert.deepStrictEqual(yield* history("effect_sql_migrations"), migrationManifest);
        assert.deepStrictEqual(yield* history(FORK_MIGRATIONS_TABLE), forkHistory);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("migrates a new database, then finds nothing to do", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* runAllMigrations(), migrationManifest);
      assert.deepStrictEqual(yield* history(FORK_MIGRATIONS_TABLE), forkHistory);
      assert.deepStrictEqual(yield* sandboxTables, ["sandbox_configs", "sandbox_instances"]);

      assert.deepStrictEqual(yield* runAllMigrations(), []);
      assert.deepStrictEqual(yield* history("effect_sql_migrations"), migrationManifest);
      assert.deepStrictEqual(yield* history(FORK_MIGRATIONS_TABLE), forkHistory);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("adds fork tables to a database upstream's build already migrated", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(yield* runAllMigrations(), []);
      assert.deepStrictEqual(yield* history("effect_sql_migrations"), migrationManifest);
      assert.deepStrictEqual(yield* history(FORK_MIGRATIONS_TABLE), forkHistory);
      assert.deepStrictEqual(yield* sandboxTables, ["sandbox_configs", "sandbox_instances"]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
