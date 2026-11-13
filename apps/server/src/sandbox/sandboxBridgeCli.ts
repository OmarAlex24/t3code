/**
 * `t3 sandbox-bridge`: the ACP agent behind the `sandboxes` provider instance. It runs on the host,
 * one process per thread, and forwards the thread to its sandbox's own T3 server. It reads the
 * sandbox's address and bearer from this server's secret store, named by the instance environment,
 * so no credential ever appears on a command line.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ModelSelection, ProviderInteractionMode, RuntimeMode, ThreadId } from "@t3tools/contracts";
import {
  connectSandbox,
  type HostMcp,
  type HostSecretAnswer,
  type HostSecretRequest,
  runSandboxBridge,
  SandboxBridgeError,
  type SandboxBridgePorts,
} from "@t3tools/sandbox-bridge";
import {
  bridgeLinkSecretName,
  bridgeResumeFailureSecretName,
  SANDBOX_BRIDGE_SECRETS_DIR_ENV,
  SandboxBridgeLinkJson,
  SandboxBridgeResumeFailureJson,
} from "@t3tools/sandbox-bridge/link";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as AcpAgent from "effect-acp/agent";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession } from "../mcp/AcpMcpStdioBridge.ts";

const HostThreadConfiguration = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
const decodeHostThread = Schema.decodeUnknownEffect(
  Schema.Struct({ structuredContent: HostThreadConfiguration }),
);
// `request_secret` with `delivery: "file"`; only the status and the file matter here.
const decodeSecretResult = Schema.decodeUnknownEffect(
  Schema.Struct({
    structuredContent: Schema.Struct({
      status: Schema.Literals(["saved", "declined", "cancelled", "timed_out"]),
      file: Schema.optional(Schema.String),
    }),
  }),
);
// Below fetch's five-minute wait for response headers, which the blocking call sends only at the end.
const SECRET_CARD_TIMEOUT_MS = 280_000;
const decodeLink = Schema.decodeEffect(SandboxBridgeLinkJson);
const decodeResumeFailure = Schema.decodeEffect(SandboxBridgeResumeFailureJson);

const program = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  // A file request hands back an owner-only file; the bridge takes the value and removes it.
  const takeSecretFile = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.ensuring(fileSystem.remove(file, { force: true }).pipe(Effect.ignore)),
      Effect.map((value) => ({ status: "saved" as const, value: Redacted.make(value) })),
    );
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
    findResumeFailure: (threadId) =>
      secrets.get(bridgeResumeFailureSecretName(threadId)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (bytes) =>
              decodeResumeFailure(new TextDecoder().decode(bytes)).pipe(Effect.asSome),
          }),
        ),
        Effect.mapError(
          (cause) =>
            new SandboxBridgeError({
              message: "Could not read whether this thread's sandbox failed to start.",
              cause,
            }),
        ),
      ),
    connect: (link) => connectSandbox(link).pipe(Effect.provide(FetchHttpClient.layer)),
    requestSecret: Effect.fn("SandboxBridge.requestSecret")(
      function* (mcp: HostMcp, request: HostSecretRequest) {
        const answer = yield* mcpToolSession({ ...mcp, clientName: "t3-sandbox-bridge" }).pipe(
          Effect.flatMap((session) =>
            session.call("request_secret", {
              ...request,
              delivery: "file",
              timeoutMs: SECRET_CARD_TIMEOUT_MS,
            }),
          ),
          Effect.scoped,
          Effect.flatMap(decodeSecretResult),
        );
        const { status, file } = answer.structuredContent;
        const unsaved: HostSecretAnswer | undefined = status === "saved" ? undefined : { status };
        if (unsaved !== undefined) return unsaved;
        if (file === undefined) {
          return yield* new SandboxBridgeError({
            message: "The host kept no file for the secret.",
          });
        }
        return yield* takeSecretFile(file);
      },
      // No cause: nothing about the answer leaves this function but the value itself.
      Effect.mapError(
        () => new SandboxBridgeError({ message: "Could not ask for the sandbox's secret." }),
      ),
    ),
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
