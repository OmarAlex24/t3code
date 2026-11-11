import { SANDBOX_SETUP_STAGE_ORDER, type SandboxSetupSnapshot, ThreadId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SandboxSetupCard } from "./SandboxSetupCard";

const refused = (recovery: SandboxSetupSnapshot["recovery"]): SandboxSetupSnapshot => ({
  threadId: ThreadId.make("thread-1"),
  instanceId: "instance-1",
  configId: "config-1",
  label: "Boat sandbox",
  provider: "boat",
  phase: "failed",
  startedAt: "2026-11-05T10:00:00.000Z",
  endedAt: "2026-11-05T10:00:01.000Z",
  stages: SANDBOX_SETUP_STAGE_ORDER.map((id) => ({
    id,
    status: id === "preflight" ? "failed" : "pending",
    startedAt: null,
    endedAt: null,
    detail: null,
  })),
  warnings: [],
  error:
    "The sandbox can't reach api.omaralex.dev, which only your private network or tailnet reaches. Set up Tailscale under Sandboxes in Settings → Connections so sandboxes can join your tailnet.",
  recovery,
  awaitingHandoff: false,
  sequence: 3,
});

const handlers = () => ({
  onCancel: vi.fn(),
  onRetry: vi.fn(),
  onDismiss: vi.fn(),
  onSetUpTailscale: vi.fn(),
});

describe("SandboxSetupCard", () => {
  it("points to the Tailscale setup when none is saved", async () => {
    const on = handlers();
    await using _screen = await render(
      <SandboxSetupCard snapshot={refused("set-up-tailscale")} {...on} />,
    );

    await expect.element(page.getByText(/Set up Tailscale under Sandboxes/u)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Set up Tailscale" }));
    expect(on.onSetUpTailscale).toHaveBeenCalledOnce();
    // Starting again stays possible once Tailscale is set up.
    await expect.element(page.getByRole("button", { name: "Start a new sandbox" })).toBeVisible();
  });
});
