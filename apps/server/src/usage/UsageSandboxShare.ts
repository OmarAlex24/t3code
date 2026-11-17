// @effect-diagnostics globalDate:off
import {
  SANDBOX_BRIDGE_INSTANCE_ID,
  type UsageSandboxShare as UsageSandboxShareValue,
  type UsageSandboxShareInput,
  UsageReadError,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SandboxRecords from "../persistence/SandboxRecords.ts";
import { aggregateSandboxShare, sandboxShareSince } from "./sandboxShare.ts";

const encodeThreadIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export class UsageSandboxShare extends Context.Service<
  UsageSandboxShare,
  {
    readonly read: (
      input: UsageSandboxShareInput,
    ) => Effect.Effect<UsageSandboxShareValue, UsageReadError>;
  }
>()("t3/usage/UsageSandboxShare") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* SandboxRecords.SandboxRecordRepository;

  const read = Effect.fn("UsageSandboxShare.read")(
    function* (input: UsageSandboxShareInput) {
      const nowMs = yield* Clock.currentTimeMillis;
      const since = sandboxShareSince(nowMs);

      // Subagents and side chats belong to their parent chat; runs that never started are not turns.
      const runs = yield* sql<{
        readonly thread_id: string;
        readonly instance_id: string | null;
        readonly started_at: string;
      }>`
      SELECT run.thread_id AS thread_id,
        COALESCE(run.provider_instance_id, run.provider) AS instance_id,
        json_extract(run.payload_json, '$.startedAt') AS started_at
      FROM orchestration_v2_projection_runs AS run
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = run.thread_id
      WHERE run.requested_at >= ${since.iso}
        AND json_extract(run.payload_json, '$.startedAt') IS NOT NULL
        AND COALESCE(json_extract(thread.payload_json, '$.lineage.relationshipToParent'), '') <> 'subagent'
        AND COALESCE(json_extract(thread.payload_json, '$.lineage.sideChat'), 0) = 0
    `.pipe(NodeSqliteClient.readOnly);

      const launched = (yield* records.list).flatMap((record) => {
        const launchedAtMs = Date.parse(record.createdAt);
        return record.threadId === undefined || !(launchedAtMs >= since.ms)
          ? []
          : [{ threadId: record.threadId, launchedAtMs }];
      });
      const hostThreads =
        launched.length === 0
          ? []
          : yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads
            WHERE thread_id IN (
              SELECT value FROM json_each(${encodeThreadIds(launched.map((chat) => chat.threadId))})
            )
          `.pipe(NodeSqliteClient.readOnly);
      const mirrored = new Set(hostThreads.map((row) => row.thread_id));

      return aggregateSandboxShare({
        runs: runs.map((row) => ({
          threadId: row.thread_id,
          startedAtMs: Date.parse(row.started_at),
          onSandbox: row.instance_id === SANDBOX_BRIDGE_INSTANCE_ID,
        })),
        unmirroredSandboxChats: launched.filter((chat) => !mirrored.has(chat.threadId)),
        nowMs,
        timeZone: input.timeZone,
      });
    },
    Effect.mapError(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Could not read local and sandbox chats.",
          cause,
        }),
    ),
  );

  return UsageSandboxShare.of({ read });
});

export const layer = Layer.effect(UsageSandboxShare, make).pipe(
  Layer.provide(SandboxRecords.layer),
);
