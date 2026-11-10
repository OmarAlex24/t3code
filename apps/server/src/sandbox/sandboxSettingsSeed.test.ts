import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, SANDBOX_HOST_ONLY_SERVER_SETTING_KEYS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import { sandboxSettingsSeed } from "./sandboxSettingsSeed.ts";
import { t3SettingsSeedScript } from "./sandboxSetup.ts";

const SECRET = "t3-seed-secret-value";

// In a throwaway HOME with this machine's sh and node, secrets in the environment as drivers pass them.
const runIn = (home: string, script: ReturnType<typeof t3SettingsSeedScript>) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) =>
      spawner.string(
        ChildProcess.make("sh", ["-c", script.command], {
          cwd: home,
          env: { PATH: process.env.PATH, HOME: home, ...script.secrets },
          stdin: "ignore",
        }),
      ),
    ),
  );

describe("sandboxSettingsSeed", () => {
  it.effect("copies only followed settings that differ from the defaults", () =>
    Effect.gen(function* () {
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      const seed = yield* sandboxSettingsSeed(settings);
      expect(seed).toEqual({ branchNamePrefix: "ada", defaultRuntimeMode: "approval-required" });
      for (const key of SANDBOX_HOST_ONLY_SERVER_SETTING_KEYS) expect(seed).not.toHaveProperty(key);
      expect(JSON.stringify(seed)).not.toContain(SECRET);
      expect(JSON.stringify(seed)).not.toContain("/Users/ada");
    }).pipe(
      Effect.provide(
        ServerSettings.ServerSettingsService.layerTest({
          branchNamePrefix: "ada",
          defaultRuntimeMode: "approval-required",
          worktreesDirectory: "/Users/ada/trees",
          addProjectBaseDirectory: "/Users/ada/code",
          cloudSpeechCredentials: { openai: SECRET, xai: SECRET, openrouter: SECRET },
          usageLimitSources: {
            hub: {
              kind: "cliproxy",
              url: "https://hub.test",
              managementKey: SECRET,
              enabled: true,
            },
          },
          sandboxProviders: { boat: { apiKey: SECRET } },
          sandboxTailscale: { clientId: "id", clientSecret: SECRET },
          sandboxTooling: { githubAppPrivateKey: SECRET, railwayToken: SECRET },
          environmentIcon: "laptop",
          defaultModelSelection: { instanceId: "codex", model: "gpt-5.5" },
        } as Parameters<typeof ServerSettings.ServerSettingsService.layerTest>[0]),
      ),
    ),
  );

  it.effect("is empty for a host on the defaults", () =>
    Effect.gen(function* () {
      expect(yield* sandboxSettingsSeed(DEFAULT_SERVER_SETTINGS)).toEqual({});
    }),
  );
});

describe("t3SettingsSeedScript", () => {
  it.live("merges the seed into T3's settings.json and keeps what setup wrote", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-seed-" });
      const file = `${home}/.t3/userdata/settings.json`;
      yield* fs.makeDirectory(`${home}/.t3/userdata`, { recursive: true });
      const pi = { pi: { driver: "pi", enabled: true } };
      yield* fs.writeFileString(
        file,
        JSON.stringify({ providerInstances: pi, branchNamePrefix: "old" }),
      );
      const seed = { branchNamePrefix: "ada", threadTitleInstructions: "'$(touch pwned)\"" };
      const script = t3SettingsSeedScript(seed);
      expect(script.command).not.toContain("ada");
      expect(yield* runIn(home, script)).toBe("");
      expect(yield* fs.exists(`${home}/pwned`)).toBe(false);
      expect(JSON.parse(yield* fs.readFileString(file))).toEqual({
        providerInstances: pi,
        ...seed,
      });
      expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
