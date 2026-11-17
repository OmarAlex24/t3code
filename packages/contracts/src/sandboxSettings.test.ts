import { describe, expect, it } from "@effect/vitest";

import { SANDBOX_FOLLOWED_SERVER_SETTING_KEYS } from "./sandboxSettings.ts";
import { ServerSettings } from "./settings.ts";

describe("sandbox followed settings", () => {
  it("follows only settings that still exist on the server", () => {
    const serverKeys = Object.keys(ServerSettings.fields);
    expect(new Set(SANDBOX_FOLLOWED_SERVER_SETTING_KEYS).size).toBe(
      SANDBOX_FOLLOWED_SERVER_SETTING_KEYS.length,
    );
    expect(SANDBOX_FOLLOWED_SERVER_SETTING_KEYS.filter((key) => !serverKeys.includes(key))).toEqual(
      [],
    );
  });
});
