import { threadKey } from "@t3tools/client-runtime/state/entities";
import { createMemoryHistory } from "@tanstack/react-router";
import { EnvironmentId, type SandboxRecord } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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

const HOST = EnvironmentId.make("environment-host");
const thread = threadWithHistory("thread-copy", 1);

// The fake serves one environment, so it stands for the sandbox; the host thread is elsewhere.
vi.mock(import("~/state/sandboxes"), async (original) => ({
  ...(await original()),
  useBridgedSandboxCopies: () =>
    new Map([
      [
        threadKey({ environmentId: ENVIRONMENT_ID, threadId: thread.id }),
        { environmentId: HOST, threadId: thread.id },
      ],
    ]),
}));

it("the sandbox's own copy of a chat says why it exists and links back to the main chat", async () => {
  using _environment = installFakeEnvironment([thread], {
    sandboxes: [
      {
        instanceId: "instance-1",
        environmentId: ENVIRONMENT_ID,
        configId: "config-1",
        threadId: thread.id,
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
  // Opening the copy by link still shows it.
  await expect.element(page.getByText("Answer 0 for thread-copy.").first()).toBeVisible();

  await expect.element(page.getByText("Sandbox copy of this chat")).toBeVisible();
  await expect
    .element(
      page.getByText(
        "Reply in the main chat so your phone stays in sync. The sandbox's terminal, files and git are here.",
      ),
    )
    .toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Open main chat" }));
  await expect.poll(() => router.state.location.pathname).toBe(`/${HOST}/${thread.id}`);
});
