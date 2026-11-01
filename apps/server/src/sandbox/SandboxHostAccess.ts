import { ClaudeSettings, defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { readClaudeSettingsEndpoint } from "../provider/Drivers/ClaudeSkills.ts";
import * as ServerSettings from "../serverSettings.ts";

export interface SandboxHostClaude {
  /** The endpoint this server's own Claude talks to, from Claude's settings or its env. */
  readonly baseUrl?: string;
  readonly authToken?: Redacted.Redacted<string>;
}

/** What this server's own machine can share with a sandbox it provisions. Never sent to clients. */
export class SandboxHostAccess extends Context.Service<
  SandboxHostAccess,
  {
    readonly claude: Effect.Effect<SandboxHostClaude>;
  }
>()("t3/sandbox/SandboxHostAccess") {}

const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const CLAUDE_INSTANCE = defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));

const nonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
};

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Resolved the way the default Claude instance resolves its endpoint (ClaudeProvider), so a
  // sandbox gets exactly what `claude` on this machine uses.
  const claude = Effect.gen(function* () {
    const instance = (yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null)))
      ?.providerInstances[CLAUDE_INSTANCE];
    const config = yield* decodeClaudeSettings(instance?.config ?? {}).pipe(
      Effect.orElseSucceed(() => ({ homePath: "" })),
    );
    const environment = yield* mergeProviderInstanceEnvironment(instance?.environment);
    const fromSettings = yield* readClaudeSettingsEndpoint(config, undefined, environment);
    const baseUrl = nonEmpty(fromSettings.ANTHROPIC_BASE_URL ?? environment.ANTHROPIC_BASE_URL);
    const authToken = nonEmpty(
      fromSettings.ANTHROPIC_AUTH_TOKEN ?? environment.ANTHROPIC_AUTH_TOKEN,
    );
    return {
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(authToken === undefined ? {} : { authToken: Redacted.make(authToken) }),
    } satisfies SandboxHostClaude;
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  return SandboxHostAccess.of({ claude });
});

export const layer = Layer.effect(SandboxHostAccess, make);

export const layerTest = (claude: SandboxHostClaude = {}) =>
  Layer.succeed(SandboxHostAccess, SandboxHostAccess.of({ claude: Effect.succeed(claude) }));
