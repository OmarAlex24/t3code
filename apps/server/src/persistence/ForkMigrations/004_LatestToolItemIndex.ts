import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keep this predicate aligned with the shell's latest tool action lookup in ProjectionStore.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_latest_tool_idx
    ON orchestration_v2_projection_turn_items(thread_id, ordinal DESC, turn_item_id DESC)
    WHERE type IN ('command_execution', 'file_change', 'file_search', 'web_search', 'dynamic_tool')
  `;
});
