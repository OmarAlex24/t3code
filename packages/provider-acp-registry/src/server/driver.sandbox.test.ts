import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderInstanceId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  SANDBOX_BRIDGE_MODEL,
  type ServerProvider,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { AcpRegistryDriver } from "./driver.ts";
import { normalizeAcpRegistryLiveConfiguration } from "./probe.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

function catalogWithInspection(
  inspection: AcpRegistrySupport.AcpRegistryInspection,
): AcpRegistrySupport.AcpRegistryCatalog["Service"] {
  return {
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () => Effect.succeed(inspection),
    resolve: () => Effect.die("unused resolve"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
  };
}

const fakeAgentSource = `
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    send({
      id,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: "fake", version: "1.5.9" } },
    });
  } else if (method === "session/new") {
    const modelIds = JSON.parse(readFileSync(process.argv[2], "utf8"));
    send({
      id,
      result: {
        sessionId: "probe-session",
        models: {
          currentModelId: modelIds[0],
          availableModels: modelIds.map((modelId) => ({ modelId, name: modelId })),
        },
      },
    });
    send({
      method: "session/update",
      params: {
        sessionId: "probe-session",
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      },
    });
  } else {
    send({ id, result: {} });
  }
});
`;

const driverLayer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(AcpRegistryRuntimeCoordinator.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.layer(driverLayer, { excludeTestServices: true })(
  "AcpRegistryDriver for sandbox chats",
  (it) => {
    it.effect(
      "lists what every sandbox chat reported, without the placeholder, across a restart",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-driver-" });
          const agentPath = path.join(directory, "agent.mjs");
          const modelsPath = path.join(directory, "models.json");
          yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
          // As the bridge's probe session does: only its placeholder.
          yield* fileSystem.writeFileString(modelsPath, JSON.stringify([SANDBOX_BRIDGE_MODEL]));
          const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
          const start = (instanceId: ProviderInstanceId) =>
            AcpRegistryDriver.create({
              instanceId,
              displayName: "Sandboxes",
              enabled: true,
              environment: [],
              config: decodeSettings({ source: "local", commandPath: "agent" }),
            }).pipe(
              Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
                ...catalogWithInspection({
                  status: "ready",
                  agentId: "agent",
                  version: null,
                  distribution: "local",
                }),
                resolve: () =>
                  Effect.succeed({
                    distribution: "local" as const,
                    spawn: { command: process.execPath, args: [agentPath, modelsPath] },
                  }),
              }),
            );
          const report = (
            models: ReadonlyArray<string>,
            levels: ReadonlyArray<string> = [],
            defaultModelId?: string,
          ) => ({
            ...normalizeAcpRegistryLiveConfiguration([
              {
                id: "model",
                name: "Model",
                category: "model",
                type: "select",
                currentValue: models[0] ?? SANDBOX_BRIDGE_MODEL,
                options: models.map((model) => ({ value: model, name: model })),
              },
              ...levels.slice(0, 1).map((currentValue) => ({
                id: "effort",
                name: "Effort",
                category: "thought_level" as const,
                type: "select" as const,
                currentValue,
                options: levels.map((level) => ({ value: level, name: level })),
              })),
            ]),
            ...(defaultModelId === undefined ? {} : { defaultModelId }),
          });
          const listing = (snapshot: ServerProvider) =>
            snapshot.models
              .map((model) => {
                const effort = model.capabilities?.optionDescriptors?.find(
                  (descriptor) => descriptor.id === "effort",
                );
                const levels =
                  effort?.type === "select"
                    ? `(${effort.options.map((choice) => choice.id).join("|")})`
                    : "";
                return `${model.slug}${model.isDefault ? "*" : ""}${levels}`;
              })
              .join();
          const reportAndList = Effect.fn(function* (
            instanceId: ProviderInstanceId,
            instance: Effect.Success<ReturnType<typeof start>>,
            configuration: ReturnType<typeof report>,
          ) {
            yield* coordinator.publishLiveConfiguration(instanceId, configuration);
            yield* instance.snapshot.refresh;
            return listing(yield* instance.snapshot.getSnapshot);
          });
          const first = report(["opus", "sonnet", SANDBOX_BRIDGE_MODEL], ["low", "high"], "sonnet");
          const second = report(["opus", "haiku", SANDBOX_BRIDGE_MODEL], ["medium", "max"]);

          const sandboxes = ProviderInstanceId.make(SANDBOX_BRIDGE_INSTANCE_ID);
          const host = yield* start(sandboxes);
          yield* host.snapshot.refresh;
          expect(yield* reportAndList(sandboxes, host, first)).toBe("opus(low|high),sonnet*");
          // A sandbox that did not answer, then a session that only has the placeholder.
          expect(yield* reportAndList(sandboxes, host, report([]))).toBe("opus(low|high),sonnet*");
          expect(yield* reportAndList(sandboxes, host, report([SANDBOX_BRIDGE_MODEL]))).toBe(
            "opus(low|high),sonnet*",
          );
          // Another sandbox's chat adds its models and has the newest word on the ones they share.
          expect(yield* reportAndList(sandboxes, host, second)).toBe(
            "opus(medium|max),sonnet*,haiku",
          );
          yield* host.invalidateCaches ?? Effect.void;

          const restarted = yield* start(sandboxes);
          yield* restarted.snapshot.refresh;
          expect(listing(yield* restarted.snapshot.getSnapshot)).toBe(
            "opus(medium|max),sonnet*,haiku",
          );

          // Any other ACP agent lists what its newest session reported, as before.
          const otherId = ProviderInstanceId.make("acpRegistry_other");
          const other = yield* start(otherId);
          yield* other.snapshot.refresh;
          yield* reportAndList(otherId, other, first);
          expect(yield* reportAndList(otherId, other, second)).toBe(
            `opus*(medium|max),haiku,${SANDBOX_BRIDGE_MODEL}`,
          );
        }),
    );
  },
);
