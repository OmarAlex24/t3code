import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { DiyKitStatus, DiySetResolverInput, isDiyResolverEffort } from "./diy.ts";

const isInput = Schema.is(DiySetResolverInput);

describe("DiySetResolverInput", () => {
  it("takes an effort only when the provider's CLI runs at it", () => {
    expect(isInput({ provider: "claude", model: "opus", effort: "xhigh" })).toBe(true);
    expect(isInput({ provider: "codex", model: "gpt-5.5", effort: "minimal" })).toBe(true);
    expect(isInput({ provider: "claude", model: "opus", effort: "" })).toBe(true);
    // Workflow levels and prompt keywords are not effort for a headless rebase.
    expect(isInput({ provider: "claude", model: "opus", effort: "ultracode" })).toBe(false);
    expect(isInput({ provider: "claude", model: "opus", effort: "ultrathink" })).toBe(false);
    expect(isInput({ provider: "codex", model: "gpt-5.5", effort: "ultra" })).toBe(false);
    expect(isInput({ provider: "claude", model: "opus", effort: "minimal" })).toBe(false);
    expect(isInput({ provider: "claude", model: "opus", effort: "high; rm -rf ~" })).toBe(false);
  });

  it("leaves effort out for kits that predate it", () => {
    expect(isInput({ provider: "claude", model: "opus" })).toBe(true);
    expect(isDiyResolverEffort("codex", "")).toBe(true);
  });
});

describe("DiyKitStatus", () => {
  const status = {
    schema: 1,
    mode: "side-by-side",
    app: { name: "T3 Code Custom", installedVersion: null, latestBuild: null },
    fork: { url: "git@github.com:you/t3code.git", branch: "main" },
    upstream: { url: "https://github.com/pingdotgg/t3code.git", branch: "main" },
    schedule: { loaded: true, nextRun: null },
    running: false,
    lastRun: null,
  };

  it("reads the resolver's effort, and status from a kit without one", () => {
    const decode = Schema.decodeUnknownSync(DiyKitStatus);
    expect(
      decode({ ...status, resolver: { provider: "codex", model: "", effort: "high" } }).resolver,
    ).toEqual({ provider: "codex", model: "", effort: "high" });
    expect(decode({ ...status, resolver: { provider: "claude", model: "opus" } }).resolver).toEqual(
      { provider: "claude", model: "opus" },
    );
  });
});
