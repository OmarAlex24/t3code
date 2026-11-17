import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type SandboxRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SandboxRecords from "../persistence/SandboxRecords.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as UsageSandboxShare from "./UsageSandboxShare.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const testLayer = Layer.mergeAll(UsageSandboxShare.layer, SandboxRecords.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);

const seedThread = (threadId: string, lineage: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
      thread_id: threadId,
      project_id: "project",
      title: threadId,
      default_provider: "codex",
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_at: "2026-11-01T00:00:00.000Z",
      updated_at: "2026-11-01T00:00:00.000Z",
      payload_json: encodeJson({
        lineage: { parentThreadId: null, relationshipToParent: null, ...lineage },
      }),
    })}`;
  });

const seedRun = (threadId: string, ordinal: number, instanceId: string, startedAt: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
      run_id: `${threadId}-run-${ordinal}`,
      thread_id: threadId,
      ordinal,
      provider: instanceId,
      provider_instance_id: instanceId,
      status: startedAt === null ? "cancelled" : "completed",
      requested_at: startedAt ?? "2026-11-12T08:00:00.000Z",
      payload_json: encodeJson({ startedAt }),
    })}`;
  });

const sandboxRecord = (threadId: string, createdAt: string): SandboxRecord => ({
  instanceId: `instance-${threadId}`,
  environmentId: EnvironmentId.make(`environment-${threadId}`),
  threadId: ThreadId.make(threadId),
  provider: "boat",
  sandboxId: `bx_${threadId}`,
  label: threadId,
  size: "small",
  state: "running",
  createdAt,
  updatedAt: createdAt,
  httpBaseUrl: "",
  runningSince: null,
  maxRunningMinutes: 480,
});

it.effect("reads this host's chats on the computer and on sandboxes, once each", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-13T12:00:00Z"));
    yield* seedThread("local");
    yield* seedRun("local", 1, "codex", "2026-11-10T08:00:00.000Z");
    // Never started: not a turn.
    yield* seedRun("local", 2, "codex", null);
    yield* seedThread("subagent", { relationshipToParent: "subagent", parentThreadId: "local" });
    yield* seedRun("subagent", 1, "codex", "2026-11-10T09:00:00.000Z");
    yield* seedThread("mirror");
    yield* seedRun("mirror", 1, "sandboxes", "2026-11-11T08:00:00.000Z");
    yield* seedRun("mirror", 2, "sandboxes", "2026-11-11T09:00:00.000Z");

    const records = yield* SandboxRecords.SandboxRecordRepository;
    yield* records.put(sandboxRecord("mirror", "2026-11-11T07:00:00.000Z"));
    yield* records.put(sandboxRecord("unmirrored", "2026-11-12T07:00:00.000Z"));

    const service = yield* UsageSandboxShare.UsageSandboxShare;
    const share = yield* service.read({ timeZone: "UTC" });
    assert.strictEqual(share.weeks.length, 8);
    assert.deepStrictEqual(share.weeks.at(-1), {
      weekStart: "2026-11-09",
      local: { chats: 1, turns: 1 },
      sandbox: { chats: 2, turns: 2 },
    });
  }).pipe(Effect.provide(testLayer)),
);
