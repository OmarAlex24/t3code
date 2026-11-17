import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A per-thread sandbox has a record from the moment the provider creates its machine, before T3
  // answers there with an environment id, so records are keyed by an id T3 picks itself.
  yield* sql`
    CREATE TABLE sandbox_instances (
      instance_id TEXT PRIMARY KEY,
      environment_id TEXT,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX sandbox_instances_environment_idx ON sandbox_instances(environment_id)
  `;
  // An existing sandbox keeps its environment id as its instance id. Its lifetime from creation
  // becomes a running limit counted from its last start, which a stopped one does not have yet.
  yield* sql`
    INSERT INTO sandbox_instances (instance_id, environment_id, record_json, updated_at)
    SELECT
      environment_id,
      environment_id,
      json_set(
        json_remove(record_json, '$.hardDeadlineAt', '$.ttlMinutes'),
        '$.instanceId', environment_id,
        '$.maxRunningMinutes', coalesce(json_extract(record_json, '$.ttlMinutes'), 480),
        '$.runningSince',
        CASE
          WHEN json_extract(record_json, '$.state') IN ('running', 'error')
            THEN json_extract(record_json, '$.updatedAt')
          ELSE NULL
        END
      ),
      updated_at
    FROM sandbox_records
  `;
  yield* sql`DROP TABLE sandbox_records`;

  yield* sql`
    CREATE TABLE sandbox_configs (
      config_id TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
