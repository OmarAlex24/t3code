import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { hasPendingMigrations, runMigrations, type RunMigrationsOptions } from "./Migrations.ts";
import Migration0001 from "./ForkMigrations/001_SandboxRecords.ts";
import Migration0002 from "./ForkMigrations/002_SandboxPerThread.ts";
import Migration0003 from "./ForkMigrations/003_ProjectionMilestones.ts";

// This fork's migrations keep their own history so upstream's numbered list stays identical to
// upstream's and its future ids never collide with them. Add new fork migrations here only.
const forkMigrationEntries = [
  [1, "SandboxRecords", Migration0001],
  [2, "SandboxPerThread", Migration0002],
  [3, "ProjectionMilestones", Migration0003],
] as const;

export const FORK_MIGRATIONS_TABLE = "t3_fork_migrations";

const makeForkMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const runForkMigrator = Migrator.make({});

// Builds before this table recorded fork migrations in upstream's history (as 80 and 81), where
// they hide upstream's own migrations with those ids. Move them here without re-running them.
const reconcileForkMigrationHistory = Effect.fn("reconcileForkMigrationHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const forkIds = new Map<string, number>(forkMigrationEntries.map(([id, name]) => [name, id]));
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
      if (tables.length === 0) return [];
      const misplaced = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`
          SELECT migration_id, name, created_at FROM effect_sql_migrations
          WHERE name IN ${sql.in([...forkIds.keys()])}
        `;
      if (misplaced.length === 0) return [];
      // Same schema the migrator creates, so it reads this table as its own.
      yield* sql`
          CREATE TABLE IF NOT EXISTS ${sql(FORK_MIGRATIONS_TABLE)} (
            migration_id integer PRIMARY KEY NOT NULL,
            created_at datetime NOT NULL DEFAULT current_timestamp,
            name VARCHAR(255) NOT NULL
          )
        `;
      const moved: Array<readonly [number, string]> = [];
      for (const row of misplaced) {
        const forkId = forkIds.get(row.name);
        if (forkId === undefined) continue;
        yield* sql`
            INSERT INTO ${sql(FORK_MIGRATIONS_TABLE)} (migration_id, name, created_at)
            VALUES (${forkId}, ${row.name}, ${row.created_at})
          `;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${row.migration_id}`;
        moved.push([forkId, row.name]);
      }
      return moved;
    }),
  );
});

const latestForkMigrationId = Math.max(...forkMigrationEntries.map(([id]) => id));

/**
 * Whether `runAllMigrations` would write anything: upstream's own check, plus fork history still
 * in upstream's table (which can make upstream's check read as current) or a fork migration not
 * yet recorded.
 */
export const hasPendingAllMigrations = Effect.fn("hasPendingAllMigrations")(function* () {
  if (yield* hasPendingMigrations()) return true;
  const sql = yield* SqlClient.SqlClient;
  const misplaced = yield* sql`
    SELECT 1 FROM effect_sql_migrations
    WHERE name IN ${sql.in(forkMigrationEntries.map(([, name]) => name))}
    LIMIT 1
  `;
  if (misplaced.length > 0) return true;
  const forkTables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${FORK_MIGRATIONS_TABLE}
  `;
  if (forkTables.length === 0) return true;
  const rows = yield* sql<{ readonly latestId: number | null }>`
    SELECT MAX(migration_id) AS latestId FROM ${sql(FORK_MIGRATIONS_TABLE)}
  `;
  return (rows[0]?.latestId ?? 0) < latestForkMigrationId;
});

export interface RunAllMigrationsOptions extends RunMigrationsOptions {
  readonly toForkMigrationInclusive?: number | undefined;
}

/** Upstream's migrations, then this fork's. Returns upstream's executed migrations. */
export const runAllMigrations = Effect.fn("runAllMigrations")(function* ({
  toMigrationInclusive,
  toForkMigrationInclusive,
}: RunAllMigrationsOptions = {}) {
  const moved = yield* reconcileForkMigrationHistory();
  if (moved.length > 0) {
    yield* Effect.log("Moved fork migration history to its own table").pipe(
      Effect.annotateLogs({ migrations: moved.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  const executed = yield* runMigrations({ toMigrationInclusive });
  // Fork migrations may build on any upstream table, so they only run on a fully migrated schema.
  if (toMigrationInclusive !== undefined) return executed;
  const forkExecuted = yield* runForkMigrator({
    loader: makeForkMigrationLoader(toForkMigrationInclusive),
    table: FORK_MIGRATIONS_TABLE,
  });
  if (forkExecuted.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: forkExecuted.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
