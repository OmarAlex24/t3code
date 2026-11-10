import { describe, expect, it } from "@effect/vitest";

import {
  SANDBOX_FOLLOWED_SERVER_SETTING_KEYS,
  SANDBOX_HOST_ONLY_SERVER_SETTING_KEYS,
} from "./sandboxSettings.ts";
import { ServerSettings } from "./settings.ts";

describe("sandbox followed settings", () => {
  it("classifies every server setting exactly once", () => {
    const classified = [
      ...SANDBOX_FOLLOWED_SERVER_SETTING_KEYS,
      ...SANDBOX_HOST_ONLY_SERVER_SETTING_KEYS,
    ];
    expect(new Set(classified).size).toBe(classified.length);
    expect(classified.toSorted()).toEqual(Object.keys(ServerSettings.fields).toSorted());
  });
});
