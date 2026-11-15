import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Unused since the shell's latest tool action was removed; kept so the migration history stays intact.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_latest_tool_idx
    ON orchestration_v2_projection_turn_items(thread_id, ordinal DESC, turn_item_id DESC)
    WHERE type IN ('command_execution', 'file_change', 'file_search', 'web_search', 'dynamic_tool')
  `;
});
