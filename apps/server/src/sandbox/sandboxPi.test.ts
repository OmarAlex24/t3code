import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import {
  fetchHubModels,
  hubAgentModels,
  hubOpenAiBaseUrl,
  PI_SETTINGS_SCRUB,
  piHubProvider,
  piSetupScript,
} from "./sandboxPi.ts";
import type { SandboxScript } from "./sandboxSetup.ts";

// Providers keep command text, so a secret must not be in it, not even base64-encoded.
const revealsSecret = (text: string, secret: string) =>
  [text, ...(text.match(/[A-Za-z0-9+/=]{12,}/gu) ?? [])]
    .map((run) => (run === text ? run : Buffer.from(run, "base64").toString("utf8")))
    .some((candidate) => candidate.includes(secret));

// Runs in a throwaway HOME with this machine's sh and node, secrets in the environment as drivers
// pass them. A stub `pi` in ~/.local/bin stands in for the real one, so nothing is installed.
const runIn = (home: string, script: string | SandboxScript, path = process.env.PATH) => {
  const { command, secrets } = typeof script === "string" ? { command: script } : script;
  return ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) =>
      spawner.exitCode(
        ChildProcess.make("/bin/sh", ["-c", command], {
          cwd: home,
          env: { PATH: path, HOME: home, ...secrets },
          stdin: "ignore",
        }),
      ),
    ),
  );
};

const withHome = <A, E, R>(test: (home: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-pi-" });
    yield* fs.makeDirectory(`${home}/.local/bin`, { recursive: true });
    yield* fs.writeFileString(`${home}/.local/bin/pi`, "#!/bin/sh\necho 1.4.0\n");
    yield* fs.chmod(`${home}/.local/bin/pi`, 0o755);
    return yield* test(home);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const readJson = (file: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(file)),
    Effect.map((text) => JSON.parse(text) as Record<string, unknown>),
  );

describe("hubAgentModels", () => {
  it("drops Claude and keeps a vendor's model over the hub's bare alias for it", () => {
    expect(
      hubAgentModels([
        "claude-opus-5-5",
        "wafer/GLM-5.3",
        "GLM-5.3",
        "wafer/GLM-5.3-Flash",
        "GLM-5.3-Flash",
        "anthropic/claude-sonnet-5",
        "DeepSeek-V4.1-Flash-1017",
        "wafer/DeepSeek-V4.1-Flash-1017",
        "wafer/GLM-5.3",
        "Kimi-K3",
      ]),
    ).toEqual([
      "wafer/GLM-5.3",
      "wafer/GLM-5.3-Flash",
      "wafer/DeepSeek-V4.1-Flash-1017",
      "Kimi-K3",
    ]);
  });

  it("points Pi at the hub's /v1 whether or not Claude's endpoint names it", () => {
    for (const url of [
      "https://api.omaralex.dev",
      "https://api.omaralex.dev/",
      " https://api.omaralex.dev/v1/ ",
    ]) {
      expect(hubOpenAiBaseUrl(url)).toBe("https://api.omaralex.dev/v1");
    }
  });
});

describe("fetchHubModels", () => {
  it.effect("reads the ids the hub lists for the sandbox's key", () => {
    const seen: Array<{ url: string; authorization: string | undefined }> = [];
    const client = HttpClient.make((request) => {
      seen.push({ url: request.url, authorization: request.headers.authorization });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ object: "list", data: [{ id: "wafer/GLM-5.3", object: "model" }] }),
        ),
      );
    });
    return fetchHubModels("https://hub.test/", "t3-sandbox-key").pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.map((ids) => {
        expect(ids).toEqual(["wafer/GLM-5.3"]);
        expect(seen).toEqual([
          { url: "https://hub.test/v1/models", authorization: "Bearer t3-sandbox-key" },
        ]);
      }),
    );
  });

  it.effect("fails with a fixed detail, never the hub's answer", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ error: "bad key t3-sandbox-key" }, { status: 401 }),
        ),
      ),
    );
    return fetchHubModels("https://hub.test", "t3-sandbox-key").pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.flip,
      Effect.map((error) => {
        expect(error.detail).toBe("The hub did not list its models.");
        expect(JSON.stringify(error)).not.toContain("t3-sandbox-key");
      }),
    );
  });
});

describe("piSetupScript", () => {
  const key = "t3-sandbox-web-'$(touch pwned)\"";
  const provider = piHubProvider({
    claudeBaseUrl: "https://api.omaralex.dev",
    apiKey: key,
    models: ["wafer/GLM-5.3", "wafer/GLM-5.3-Flash", "Kimi-K3"],
  });
  const thinkingLevelMap = {
    off: "none",
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "max",
    max: "max",
  };

  it.live(
    "writes the hub provider and Pi's default, turns on T3's Pi, and keeps the key out of the command",
    () =>
      withHome((home) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          // Whatever Pi and T3 had stays.
          yield* fs.makeDirectory(`${home}/.pi/agent`, { recursive: true });
          yield* fs.makeDirectory(`${home}/.t3/userdata`, { recursive: true });
          yield* fs.writeFileString(
            `${home}/.pi/agent/models.json`,
            JSON.stringify({ providers: { ollama: { baseUrl: "http://localhost:11434/v1" } } }),
          );
          yield* fs.writeFileString(
            `${home}/.pi/agent/settings.json`,
            JSON.stringify({ theme: "dark", defaultModel: "old" }),
          );
          yield* fs.writeFileString(
            `${home}/.t3/userdata/settings.json`,
            JSON.stringify({ providerInstances: { codex: { driver: "codex" } } }),
          );
          const script = piSetupScript({ provider, model: "wafer/GLM-5.3", startsChats: true });
          expect(revealsSecret(script.command, key)).toBe(false);
          expect(yield* runIn(home, script)).toBe(0);
          expect(yield* fs.exists(`${home}/pwned`)).toBe(false);

          expect(yield* readJson(`${home}/.pi/agent/models.json`)).toEqual({
            providers: {
              ollama: { baseUrl: "http://localhost:11434/v1" },
              hub: {
                name: "CLIProxyAPI hub",
                baseUrl: "https://api.omaralex.dev/v1",
                api: "openai-completions",
                apiKey: key,
                compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
                models: [
                  {
                    id: "wafer/GLM-5.3",
                    name: "GLM 5.3",
                    reasoning: true,
                    thinkingLevelMap,
                    input: ["text", "image"],
                    contextWindow: 1_048_576,
                    maxTokens: 131_072,
                  },
                  {
                    id: "wafer/GLM-5.3-Flash",
                    name: "GLM 5.3 Flash",
                    reasoning: true,
                    thinkingLevelMap,
                    input: ["text", "image"],
                    contextWindow: 1_048_576,
                    maxTokens: 196_608,
                  },
                  // Limits T3 does not know are left to Pi's defaults.
                  { id: "Kimi-K3", name: "Kimi K3", reasoning: true, thinkingLevelMap },
                ],
              },
            },
          });
          expect((yield* fs.stat(`${home}/.pi/agent/models.json`)).mode & 0o777).toBe(0o600);
          expect(yield* readJson(`${home}/.pi/agent/settings.json`)).toEqual({
            theme: "dark",
            defaultProvider: "hub",
            defaultModel: "wafer/GLM-5.3",
          });
          expect(yield* readJson(`${home}/.t3/userdata/settings.json`)).toEqual({
            providerInstances: {
              codex: { driver: "codex" },
              pi: {
                driver: "pi",
                enabled: true,
                config: { enabled: true, binaryPath: `${home}/.local/bin/pi` },
              },
            },
            defaultModelSelection: { instanceId: "pi", model: "hub/wafer/GLM-5.3" },
          });

          // A template copy keeps Pi and the user's other providers, but not the hub or its key.
          expect(yield* runIn(home, PI_SETTINGS_SCRUB)).toBe(0);
          expect(yield* readJson(`${home}/.pi/agent/models.json`)).toEqual({
            providers: { ollama: { baseUrl: "http://localhost:11434/v1" } },
          });
          expect(yield* readJson(`${home}/.pi/agent/settings.json`)).toEqual({ theme: "dark" });
          expect(yield* fs.exists(`${home}/.local/bin/pi`)).toBe(true);
        }),
      ),
  );

  it.live("leaves T3's default model alone unless new chats start on Pi", () =>
    withHome((home) =>
      Effect.gen(function* () {
        yield* runIn(home, piSetupScript({ provider, model: "Kimi-K3", startsChats: false }));
        expect(yield* readJson(`${home}/.t3/userdata/settings.json`)).not.toHaveProperty(
          "defaultModelSelection",
        );
        expect(yield* readJson(`${home}/.pi/agent/settings.json`)).toEqual({
          defaultProvider: "hub",
          defaultModel: "Kimi-K3",
        });
      }),
    ),
  );

  it.live("fails without writing anything when Pi is missing and npm is not there", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(`${home}/.local/bin/pi`);
        const script = piSetupScript({ provider, model: "Kimi-K3", startsChats: false });
        // Nothing on PATH but the empty bin: no Pi and no npm to install it with.
        expect(yield* runIn(home, script, `${home}/.local/bin`)).toBe(3);
        expect(yield* fs.exists(`${home}/.pi/agent/models.json`)).toBe(false);
      }),
    ),
  );
});
