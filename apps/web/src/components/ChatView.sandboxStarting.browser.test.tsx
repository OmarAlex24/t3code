import { secondTick } from "@t3tools/client-runtime/clock";
import { createMemoryHistory } from "@tanstack/react-router";
import { EnvironmentId, type SandboxRecord } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the test.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

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

const thread = threadWithHistory("thread-starting", 1);

it("the composer says a sandbox is starting, and for how long, while its resume runs", async () => {
  // Begun 42 seconds ago by the clock the elapsed time reads.
  const resumingSince = new Date(secondTick.getSnapshot() - 42_000).toISOString();
  // A resume this server runs, started by the bridge for a run on the host or by another client.
  const sandboxes = [
    {
      instanceId: "instance-1",
      environmentId: EnvironmentId.make(ENVIRONMENT_ID),
      configId: "config-1",
      threadId: thread.id,
      provider: "boat",
      sandboxId: "bx_46wrabcd",
      label: "render on Boat small",
      size: "small",
      state: "stopped",
      createdAt: "2026-11-01T10:00:00.000Z",
      updatedAt: resumingSince,
      httpBaseUrl: "https://bx.example.test",
      runningSince: null,
      stoppedAt: "2026-11-10T11:00:00.000Z",
      resumingSince,
      maxRunningMinutes: 480,
    },
  ] satisfies ReadonlyArray<SandboxRecord>;
  using _environment = installFakeEnvironment([thread], { sandboxes });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1100, 700);

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText("Answer 0 for thread-starting.").first()).toBeVisible();

  const title = page.getByText(/^Starting sandbox bx_46wr$/).first();
  await expect.element(title).toBeVisible();
  // Not the stopped notice: the resume is already under way.
  await expect.element(page.getByText("Sandbox bx_46wr is stopped")).not.toBeInTheDocument();
  // The time since the resume began, ticking beside it (the shimmer repeats the label).
  expect(title.element().parentElement?.parentElement?.textContent).toMatch(
    /^Starting sandbox bx_46wr(Starting sandbox bx_46wr)?·4\ds$/,
  );
  await page.screenshot({ path: "__screenshots__/sandbox-state-banner.png" });
});
