import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isForeignSandbox, keepsSandboxEnvironment } from "./sandboxComposer";

const sandboxA = EnvironmentId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const host = EnvironmentId.make("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const owners = new Map([[sandboxA, threadA]]);

describe("sandbox environments in the composer", () => {
  it("treats another thread's sandbox as foreign", () => {
    // A new draft for the same repository landed on thread A's machine.
    expect(isForeignSandbox(owners, sandboxA, threadB)).toBe(true);
  });

  it("keeps a thread on its own sandbox", () => {
    expect(isForeignSandbox(owners, sandboxA, threadA)).toBe(false);
    expect(isForeignSandbox(owners, host, threadB)).toBe(false);
    expect(isForeignSandbox(owners, null, threadB)).toBe(false);
  });

  it("offers only the thread's own sandbox in the machine picker", () => {
    expect(keepsSandboxEnvironment(owners, sandboxA, threadB)).toBe(false);
    expect(keepsSandboxEnvironment(owners, sandboxA, threadA)).toBe(true);
    expect(keepsSandboxEnvironment(owners, host, threadB)).toBe(true);
  });
});
