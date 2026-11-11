import type * as Context from "effect/Context";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
// The route loads ChatView lazily; importing it here keeps its first transform out of the test.
import "~/components/ChatView";
import type { FakeDriver } from "../../test/fakeEnvironment";
import { openChat, sandbox, SCREENSHOTS, sidebarRow } from "../../test/sandboxLaunchScenario";

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
  it("goes out on its own once the sandbox is ready, and the setup steps aside", async () => {
    await using _chat = await openChat("released", { sandboxes: [sandbox("running")] });

    await expect.element(page.getByText(/the test races the session cookie/u)).toBeVisible();
    expect(document.querySelector('[aria-label="Sandbox setup"]')).toBeNull();
    expect(sidebarRow().textContent).not.toMatch(/Setting up/u);

    await page.screenshot({ path: `${SCREENSHOTS}/thread-after-release.png` });
  });
});
