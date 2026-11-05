import { createMemoryHistory } from "@tanstack/react-router";
import { EnvironmentId, type SandboxRecord } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the test.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
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

const thread = threadWithHistory("thread-bridged", 1);

it("a sandbox thread's placeholder project offers no git or terminal on its empty folder", async () => {
  // The host thread the sandbox bridge drives, in the lightweight project T3 made for its repository.
  using _environment = installFakeEnvironment([thread], {
    projectWorkspaceRoot: "/Users/me/.t3/sandbox-projects/acme/render",
    sandboxes: [
      {
        instanceId: "instance-1",
        environmentId: EnvironmentId.make("sandbox-environment"),
        configId: "config-1",
        threadId: thread.id,
        hostProjectId: PROJECT_ID,
        provider: "boat",
        sandboxId: "bx_46wrabcd",
        label: "render on Boat small",
        size: "small",
        state: "running",
        createdAt: "2026-11-01T10:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
        httpBaseUrl: "https://bx.example.test",
        runningSince: "2026-11-01T10:00:00.000Z",
        maxRunningMinutes: 480,
      },
    ] satisfies ReadonlyArray<SandboxRecord>,
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText("Answer 0 for thread-bridged.").first()).toBeVisible();

  await expect.element(page.getByText("No checkout on this computer")).toBeVisible();
  await expect
    .element(page.getByText(/Files, diffs and terminals are on sandbox bx_46wr/u))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Open sandbox thread" }).first())
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Toggle terminal drawer" })).toBeDisabled();
});
