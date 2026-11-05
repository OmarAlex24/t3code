import { threadKey } from "@t3tools/client-runtime/state/entities";
import { createMemoryHistory } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";

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

const SANDBOX = EnvironmentId.make("environment-sandbox");
const thread = threadWithHistory("thread-mirror", 1);

// The fake serves one environment, so it stands for the host; the sandbox's thread is elsewhere.
vi.mock(import("~/state/sandboxes"), async (original) => ({
  ...(await original()),
  useSandboxHostMirrors: () =>
    new Map([
      [
        threadKey({ environmentId: ENVIRONMENT_ID, threadId: thread.id }),
        { environmentId: SANDBOX, threadId: thread.id },
      ],
    ]),
}));

it("opening the host's mirror of a sandbox chat opens the sandbox's own thread", async () => {
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  // The app's first render loads the chat lazily, so the move can take a while.
  await expect
    .poll(() => router.state.location.pathname, { interval: 100, timeout: 15_000 })
    .toBe(`/${SANDBOX}/${thread.id}`);
});
