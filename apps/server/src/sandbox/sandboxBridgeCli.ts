/**
 * `t3 sandbox-bridge`: the ACP agent behind the `sandboxes` provider instance. It runs on the host,
 * one process per thread, and forwards the thread to its sandbox's own T3 server. It reads the
 * sandbox's address and bearer from this server's secret store, named by the instance environment,
 * so no credential ever appears on a command line.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RuntimeMode, ThreadId } from "@t3tools/contracts";
import {
  connectSandbox,
  runSandboxBridge,
  SandboxBridgeError,
  type SandboxBridgePorts,
} from "@t3tools/sandbox-bridge";
import {
  bridgeLinkSecretName,
  SANDBOX_BRIDGE_SECRETS_DIR_ENV,
  SandboxBridgeLinkJson,
} from "@t3tools/sandbox-bridge/link";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as AcpAgent from "effect-acp/agent";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession } from "../mcp/AcpMcpStdioBridge.ts";

const HostThreadConfiguration = Schema.Struct({ threadId: ThreadId, runtimeMode: RuntimeMode });
const decodeHostThread = Schema.decodeUnknownEffect(
  Schema.Struct({ structuredContent: HostThreadConfiguration }),
);
const decodeLink = Schema.decodeEffect(SandboxBridgeLinkJson);

const program = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const ports: SandboxBridgePorts = {
    // The host's thread-scoped MCP credential answers for exactly the thread this process serves.
    readHostThread: (mcp) =>
      mcpToolSession({ ...mcp, clientName: "t3-sandbox-bridge" }).pipe(
        Effect.flatMap((session) => session.call("t3_thread_configure", {})),
        Effect.scoped,
        Effect.flatMap(decodeHostThread),
        Effect.map((result) => result.structuredContent),
        Effect.mapError(
          (cause) => new SandboxBridgeError({ message: "Could not read the host thread.", cause }),
        ),
      ),
    findLink: (threadId) =>
      secrets.get(bridgeLinkSecretName(threadId)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (bytes) => decodeLink(new TextDecoder().decode(bytes)).pipe(Effect.asSome),
          }),
        ),
        Effect.mapError(
          (cause) =>
            new SandboxBridgeError({
              message: "Could not read this thread's sandbox link.",
              cause,
            }),
        ),
      ),
    connect: (link) => connectSandbox(link).pipe(Effect.provide(FetchHttpClient.layer)),
  };
  return yield* runSandboxBridge(ports);
});

export async function runSandboxBridgeCli(): Promise<void> {
  const secretsDir = process.env[SANDBOX_BRIDGE_SECRETS_DIR_ENV];
  if (secretsDir === undefined || secretsDir === "") {
    process.stderr.write(`sandbox-bridge requires ${SANDBOX_BRIDGE_SECRETS_DIR_ENV}.\n`);
    process.exitCode = 2;
    return;
  }
  // stdout carries ACP, so every log line, including a failure runMain reports, goes to stderr.
  console.log = console.info = console.debug = console.error;
  // The secret store only reads `secretsDir`; the rest of the server's config does not apply here.
  const config = Layer.succeed(ServerConfig.ServerConfig, {
    secretsDir,
  } as unknown as ServerConfig.ServerConfig["Service"]);
  const secrets = Layer.effect(ServerSecretStore.ServerSecretStore, ServerSecretStore.make).pipe(
    Layer.provide(Layer.mergeAll(config, SecureRandom.layerWebCrypto)),
  );
  // The agent answers stdin as soon as it is built, so everything the handlers use is built first.
  const services = AcpAgent.layerStdio().pipe(
    Layer.provideMerge(Layer.mergeAll(secrets, SecureRandom.layerWebCrypto)),
    Layer.provideMerge(NodeServices.layer),
  );
  program.pipe(Effect.provide(services), NodeRuntime.runMain);
}
