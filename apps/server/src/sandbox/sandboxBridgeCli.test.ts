import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { NOT_LINKED_MESSAGE, PROBE_CLIENT_NAME } from "@t3tools/sandbox-bridge";
import { SANDBOX_BRIDGE_SECRETS_DIR_ENV } from "@t3tools/sandbox-bridge/link";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as AcpClient from "effect-acp/client";
import type * as AcpSchema from "effect-acp/compat";

// Spawns the server's own entrypoint the way the `sandboxes` provider instance does.
it.live("runs as `sandbox-bridge`, answering the provider probe and unlinked threads", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const secretsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bridge-secrets-" });
    const bin = yield* path.fromFileUrl(new URL("../bin.ts", import.meta.url));
    const handle = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [bin, "sandbox-bridge"], {
        env: { ...process.env, [SANDBOX_BRIDGE_SECRETS_DIR_ENV]: secretsDir },
      }),
    );
    const updates: Array<AcpSchema.SessionNotification> = [];
    yield* Effect.gen(function* () {
      const acp = yield* AcpClient.AcpClient;
      yield* acp.handleSessionUpdate((notification) =>
        Effect.sync(() => void updates.push(notification)),
      );
      const init = yield* acp.agent.initialize({
        protocolVersion: 1,
        clientInfo: { name: PROBE_CLIENT_NAME, version: "1" },
      });
      assert.strictEqual(init.agentCapabilities?.loadSession, true);
      const probe = yield* acp.agent.createSession({ cwd: secretsDir, mcpServers: [] });
      assert.isTrue(probe.sessionId.startsWith("sandbox-dry-run:"));
      assert.deepStrictEqual(
        probe.configOptions?.map((option) => (option.type === "select" ? option.options : [])),
        [[{ value: "sandbox", name: "Sandbox agent" }]],
      );

      // A host MCP that does not answer leaves the session a dry run that explains itself.
      const unlinked = yield* acp.agent.createSession({
        cwd: secretsDir,
        mcpServers: [
          {
            name: "t3-code",
            command: "t3",
            args: [],
            env: [
              { name: "T3_ACP_MCP_ENDPOINT", value: "http://127.0.0.1:9/mcp" },
              { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer none" },
            ],
          },
        ],
      });
      const result = yield* acp.agent.prompt({
        sessionId: unlinked.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      assert.strictEqual(result.stopReason, "end_turn");
      assert.include(JSON.stringify(updates), NOT_LINKED_MESSAGE);
    }).pipe(Effect.provide(AcpClient.layerChildProcess(handle)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
