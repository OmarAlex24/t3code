import {
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  SANDBOX_FOLLOWED_SERVER_SETTING_KEYS,
  ServerSettings,
  withIdleCompaction,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";

const encodeSettings = Schema.encodeEffect(ServerSettings);
// Loading always fills in `idleCompaction`, so a default file reads back with it.
const LOADED_DEFAULTS = withIdleCompaction(
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction(DEFAULT_SERVER_SETTINGS),
);

/**
 * The host's settings a new sandbox starts with: only followed keys, and only those that differ
 * from the defaults, so a sandbox server older than the host decodes as little of it as possible.
 */
export const sandboxSettingsSeed = Effect.fn("SandboxSettingsSeed.build")(function* (
  settings: ServerSettings,
) {
  const current = (yield* encodeSettings(settings)) as Readonly<Record<string, unknown>>;
  const defaults = (yield* encodeSettings(LOADED_DEFAULTS)) as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    SANDBOX_FOLLOWED_SERVER_SETTING_KEYS.flatMap((key) =>
      current[key] === undefined || Equal.equals(current[key], defaults[key])
        ? []
        : [[key, current[key]] as const],
    ),
  ) as Readonly<Record<string, unknown>>;
});
