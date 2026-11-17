import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveSelection, type EnvironmentUsageStatus } from "./usage";

const status = (id: string, label: string): EnvironmentUsageStatus => ({
  environmentId: EnvironmentId.make(id),
  label,
  isPending: false,
  canReadDiagnostics: true,
  isConnected: true,
  error: null,
  summary: null,
});

describe("usage selection with sandboxes", () => {
  const host = status("host", "T3 Code Custom");
  const remote = status("remote", "t3-machine");
  const sandbox = status("sandbox", "zumith-v2 on Boat sandbox");
  const sandboxes = {
    hostEnvironmentId: host.environmentId,
    environmentIds: new Set([sandbox.environmentId]),
    key: "host:sandbox",
  };
  const counted = (selected: ReadonlySet<EnvironmentId> | null) =>
    deriveSelection(
      [host, remote, sandbox],
      selected,
      new Set(),
      sandboxes,
    ).countedEnvironments.map(({ environmentId, label }) => [environmentId, label]);

  it("lists no sandbox and counts its usage under its host", () => {
    const view = deriveSelection([host, remote, sandbox], null, new Set(), sandboxes);
    expect(view.environments).toEqual([host, remote]);
    expect(view.selectedEnvironments).toEqual([host, remote]);
    expect(counted(null)).toEqual([
      [host.environmentId, host.label],
      [remote.environmentId, remote.label],
      [sandbox.environmentId, host.label],
    ]);
    expect(counted(new Set([host.environmentId]))).toEqual([
      [host.environmentId, host.label],
      [sandbox.environmentId, host.label],
    ]);
    expect(counted(new Set([remote.environmentId]))).toEqual([
      [remote.environmentId, remote.label],
    ]);
  });
});
