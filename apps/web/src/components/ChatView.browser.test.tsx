import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  AuthStandardClientScopes,
  EnvironmentId,
  type SandboxRecord,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  takeFakeEnvironmentOffline,
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

const SANDBOX_THREAD = threadWithHistory("thread-sandbox", 1);
// The app keeps the host's Sandboxes list and connection across tests, so every test serves this
// list, and this test runs first, before an earlier test's session can stand in for the stopped one.
const SANDBOXES = [
  {
    instanceId: "instance-1",
    environmentId: EnvironmentId.make(ENVIRONMENT_ID),
    configId: "config-1",
    threadId: SANDBOX_THREAD.id,
    provider: "boat",
    sandboxId: "bx_46wrabcd",
    label: "render on Boat small",
    size: "small",
    state: "stopped",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    httpBaseUrl: "https://bx.example.test",
    runningSince: null,
    stoppedAt: "2026-11-01T11:00:00.000Z",
    maxRunningMinutes: 480,
  },
] satisfies ReadonlyArray<SandboxRecord>;

it("a send on a stopped sandbox's thread resumes the sandbox", async () => {
  const thread = SANDBOX_THREAD;
  // The thread's environment is a sandbox this server stopped, as its Sandboxes list reports. A
  // page opened while it was stopped never read its session, so no operate scope reads as granted.
  using _environment = installFakeEnvironment([thread], {
    scopes: AuthStandardClientScopes.filter((scope) => scope !== AuthOrchestrationOperateScope),
    sandboxes: SANDBOXES,
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
  await expect.element(page.getByText("Answer 0 for thread-sandbox.").first()).toBeVisible();

  await takeFakeEnvironmentOffline();
  await expect.element(page.getByText("Sandbox bx_46wr is stopped")).toBeVisible();
  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Carry on");
  await userEvent.click(page.getByRole("button", { name: "Submit message" }));

  // The send asks for the resume; the message goes once the sandbox's server answers.
  await expect.element(page.getByText("Resuming the sandbox")).toBeVisible();
});

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([], { sandboxes: SANDBOXES });
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});
