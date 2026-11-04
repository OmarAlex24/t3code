import { EnvironmentId, SandboxEnvironmentConfig, SandboxRecord } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

const RecordRow = Schema.Struct({
  record: Schema.fromJsonString(SandboxRecord),
});

const ConfigRow = Schema.Struct({
  config: Schema.fromJsonString(SandboxEnvironmentConfig),
});

type RepositoryError = PersistenceSqlError | PersistenceDecodeError;

export class SandboxRecordRepository extends Context.Service<
  SandboxRecordRepository,
  {
    readonly list: Effect.Effect<ReadonlyArray<SandboxRecord>, RepositoryError>;
    readonly get: (
      instanceId: string,
    ) => Effect.Effect<Option.Option<SandboxRecord>, RepositoryError>;
    readonly findByEnvironmentId: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<SandboxRecord>, RepositoryError>;
    readonly put: (record: SandboxRecord) => Effect.Effect<void, RepositoryError>;
    readonly remove: (instanceId: string) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/persistence/SandboxRecords/SandboxRecordRepository") {}

export class SandboxConfigRepository extends Context.Service<
  SandboxConfigRepository,
  {
    readonly list: Effect.Effect<ReadonlyArray<SandboxEnvironmentConfig>, RepositoryError>;
    readonly get: (
      configId: string,
    ) => Effect.Effect<Option.Option<SandboxEnvironmentConfig>, RepositoryError>;
    readonly put: (config: SandboxEnvironmentConfig) => Effect.Effect<void, RepositoryError>;
    readonly remove: (configId: string) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/persistence/SandboxRecords/SandboxConfigRepository") {}

const mapReadError = (entity: string, operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(entity, cause)
    : new PersistenceSqlError({ operation, cause });

const makeRecords = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findOne = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: RecordRow,
    execute: (instanceId) =>
      sql`
        SELECT record_json AS "record"
        FROM sandbox_instances
        WHERE instance_id = ${instanceId}
      `,
  });
  const findByEnvironment = SqlSchema.findOneOption({
    Request: EnvironmentId,
    Result: RecordRow,
    execute: (environmentId) =>
      sql`
        SELECT record_json AS "record"
        FROM sandbox_instances
        WHERE environment_id = ${environmentId}
      `,
  });
  const listAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RecordRow,
    execute: () =>
      sql`
        SELECT record_json AS "record"
        FROM sandbox_instances
        ORDER BY updated_at DESC
      `,
  });
  const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(SandboxRecord));

  return SandboxRecordRepository.of({
    list: listAll(undefined).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(mapReadError("SandboxRecord", "listSandboxRecords")),
      Effect.map((rows): ReadonlyArray<SandboxRecord> => rows.map((row) => row.record)),
    ),
    get: Effect.fn("SandboxRecordRepository.get")(function (instanceId) {
      return findOne(instanceId).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.map((row) => row.record)),
        Effect.mapError(mapReadError("SandboxRecord", "getSandboxRecord")),
      );
    }),
    findByEnvironmentId: Effect.fn("SandboxRecordRepository.findByEnvironmentId")(
      function (environmentId) {
        return findByEnvironment(environmentId).pipe(
          NodeSqliteClient.readOnly,
          Effect.map(Option.map((row) => row.record)),
          Effect.mapError(mapReadError("SandboxRecord", "findSandboxRecordByEnvironment")),
        );
      },
    ),
    put: Effect.fn("SandboxRecordRepository.put")(function (record) {
      return encodeRecord(record).pipe(
        Effect.mapError((cause) => PersistenceDecodeError.fromSchemaError("SandboxRecord", cause)),
        Effect.flatMap((recordJson) =>
          sql`
            INSERT INTO sandbox_instances (instance_id, environment_id, record_json, updated_at)
            VALUES (${record.instanceId}, ${record.environmentId}, ${recordJson}, ${record.updatedAt})
            ON CONFLICT (instance_id) DO UPDATE SET
              environment_id = excluded.environment_id,
              record_json = excluded.record_json,
              updated_at = excluded.updated_at
          `.pipe(
            Effect.mapError(
              (cause) => new PersistenceSqlError({ operation: "putSandboxRecord", cause }),
            ),
          ),
        ),
        Effect.asVoid,
      );
    }),
    remove: Effect.fn("SandboxRecordRepository.remove")(function (instanceId) {
      return sql`
        DELETE FROM sandbox_instances WHERE instance_id = ${instanceId}
      `.pipe(
        Effect.mapError(
          (cause) => new PersistenceSqlError({ operation: "removeSandboxRecord", cause }),
        ),
        Effect.asVoid,
      );
    }),
  });
});

const makeConfigs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findOne = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ConfigRow,
    execute: (configId) =>
      sql`
        SELECT config_json AS "config"
        FROM sandbox_configs
        WHERE config_id = ${configId}
      `,
  });
  const listAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ConfigRow,
    execute: () =>
      sql`
        SELECT config_json AS "config"
        FROM sandbox_configs
        ORDER BY json_extract(config_json, '$.createdAt'), config_id
      `,
  });
  const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(SandboxEnvironmentConfig));

  return SandboxConfigRepository.of({
    list: listAll(undefined).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(mapReadError("SandboxEnvironmentConfig", "listSandboxConfigs")),
      Effect.map((rows): ReadonlyArray<SandboxEnvironmentConfig> => rows.map((row) => row.config)),
    ),
    get: Effect.fn("SandboxConfigRepository.get")(function (configId) {
      return findOne(configId).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.map((row) => row.config)),
        Effect.mapError(mapReadError("SandboxEnvironmentConfig", "getSandboxConfig")),
      );
    }),
    put: Effect.fn("SandboxConfigRepository.put")(function (config) {
      return encodeConfig(config).pipe(
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError("SandboxEnvironmentConfig", cause),
        ),
        Effect.flatMap((configJson) =>
          sql`
            INSERT INTO sandbox_configs (config_id, config_json, updated_at)
            VALUES (${config.id}, ${configJson}, ${config.updatedAt})
            ON CONFLICT (config_id) DO UPDATE SET
              config_json = excluded.config_json,
              updated_at = excluded.updated_at
          `.pipe(
            Effect.mapError(
              (cause) => new PersistenceSqlError({ operation: "putSandboxConfig", cause }),
            ),
          ),
        ),
        Effect.asVoid,
      );
    }),
    remove: Effect.fn("SandboxConfigRepository.remove")(function (configId) {
      return sql`
        DELETE FROM sandbox_configs WHERE config_id = ${configId}
      `.pipe(
        Effect.mapError(
          (cause) => new PersistenceSqlError({ operation: "removeSandboxConfig", cause }),
        ),
        Effect.asVoid,
      );
    }),
  });
});

export const layer = Layer.effect(SandboxRecordRepository, makeRecords);
export const layerConfigs = Layer.effect(SandboxConfigRepository, makeConfigs);
