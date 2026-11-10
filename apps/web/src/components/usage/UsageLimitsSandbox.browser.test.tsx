import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const { checkedAt, notSignedIn, presentations } = vi.hoisted(() => {
  const checkedAt = "2026-11-10T16:00:00.000Z";
  const notSignedIn = "Codex CLI is not authenticated. Run `codex login` and try again.";
  const codex = {
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed", message: notSignedIn },
    },
  };
  const machine = (id: string, label: string) =>
    [id, { entry: { target: { label } }, serverConfig: { providers: [codex] } }] as const;
  const presentations = new Map([
    machine("host", "T3 Code Custom"),
    machine("t3-machine", "t3-machine"),
    machine("sandbox", "zumith-v2 on Boat sandbox"),
  ]);
  return { checkedAt, notSignedIn, presentations };
});

vi.mock(import("~/state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsWithProvidersAtom: Atom.make(presentations) as never,
    },
  };
});
// The third machine is a chat's sandbox, provisioned by the host.
vi.mock(import("~/state/sandboxes"), async (original) => ({
  ...(await original()),
  useSandboxEnvironmentIds: () => new Set([EnvironmentId.make("sandbox")]),
}));

import { UsageLimitsSection } from "./UsageLimits";

describe("usage limit notices with a sandbox", () => {
  it("reports the host's and other machines' providers, never the host's sandbox", async () => {
    await using _screen = await render(
      <UsageLimitsSection
        selectedEnvironmentIds={null}
        hiddenProviders={new Set()}
        now={Date.parse(checkedAt)}
      />,
    );

    await expect.element(page.getByText(`T3 Code Custom · Codex: ${notSignedIn}`)).toBeVisible();
    await expect.element(page.getByText(`t3-machine · Codex: ${notSignedIn}`)).toBeVisible();
    await expect.element(page.getByText(/zumith-v2 on Boat sandbox/)).not.toBeInTheDocument();
  });
});
