import { ProviderInstanceId } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
// The route loads ChatView lazily; importing it here keeps its first transform out of the test.
import "~/components/ChatView";
import { useComposerDraftStore } from "~/composerDraftStore";
import { ENVIRONMENT_ID, type FakeDriver } from "../../test/fakeEnvironment";
import {
  launch,
  openChat,
  sandbox,
  SCREENSHOTS,
  sidebarRow,
  threadId,
} from "../../test/sandboxLaunchScenario";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

describe("a sandbox chat's first message", () => {
  it("is a thread right after send, with the setup in it and the message waiting", async () => {
    await using _chat = await openChat("waiting", {
      sandboxes: [sandbox("provisioning")],
      launches: [launch],
    });

    // In the thread, under the message it holds: the sandbox's setup, one row per stage.
    const card = page.getByRole("region", { name: "Sandbox setup" });
    await expect.element(card).toBeVisible();
    await expect.element(card.getByText("Starting a sandbox on Boat small…").first()).toBeVisible();
    await expect.element(card.getByText("Clone repository")).toBeVisible();
    await expect.element(page.getByText("Fix the flaky login test in CI").nth(1)).toBeVisible();

    // A real thread in the sidebar, setting up; not a draft.
    const row = sidebarRow();
    expect(row.textContent).toContain("Fix the flaky login test in CI");
    expect(row.textContent).toMatch(/Setting up/u);
    expect(document.querySelector("[data-sidebar-draft-block]")).toBeNull();

    await page.screenshot({ path: `${SCREENSHOTS}/setup-card-in-thread.png` });
    await page
      .elementLocator(row)
      .screenshot({ path: `${SCREENSHOTS}/sidebar-row-after-send.png` });
  });

  it("shows no context handoff once the launch hands the draft, with its model pick, over", async () => {
    // The draft's pick of a provider on this computer moves onto the host thread with it.
    const hostRef = { environmentId: ENVIRONMENT_ID, threadId };
    using _draft = {
      [Symbol.dispose]: () => useComposerDraftStore.getState().clearDraftThread(hostRef),
    };
    useComposerDraftStore
      .getState()
      .setModelSelection(
        hostRef,
        { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        { explicit: true },
      );
    await using _chat = await openChat("released", { sandboxes: [sandbox("running")] });

    await expect.element(page.getByText(/races the session cookie/u).first()).toBeVisible();
    await expect.element(page.getByText("Context handoff pending")).not.toBeInTheDocument();
  });
});
