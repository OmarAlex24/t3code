import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per milestone a coordinator marked; ids (`m1`…) are unique only within a thread.
  // `ordinal` is the id's number, which is creation order and set order.
  yield* sql`
    CREATE TABLE orchestration_v2_projection_milestones (
      thread_id TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, milestone_id)
    )
  `;
  // A new subagent looks up its thread's active milestone.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_milestones_status_idx
    ON orchestration_v2_projection_milestones(thread_id, status)
  `;
});
