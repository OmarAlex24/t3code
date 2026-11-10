import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  EnvironmentId,
  type OrchestrationV2Command,
  type SandboxRecord,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the test.
import "~/components/ChatView";
import { useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  dispatchedCommands,
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
const mirrored = threadWithHistory("thread-mirror", 1);
const stoppedOwn = threadWithHistory("thread-stopped-own", 1);
const queued = threadWithHistory("thread-queued", 1);
const other = threadWithHistory("thread-other", 1);
// The app keeps its shell subscription across tests, so each one serves every thread.
const THREADS = [mirrored, stoppedOwn, queued, other];

// `queued` is the host's mirror of a chat whose sandbox is stopped; its own thread is on SANDBOX.
const SANDBOXES = [
  {
    instanceId: "instance-queued",
    environmentId: SANDBOX,
    configId: "config-1",
    threadId: queued.id,
    hostProjectId: PROJECT_ID,
    provider: "boat",
    sandboxId: "bx_9kq2wxyz",
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

// The fake serves one environment, so a thread on it stands for either thread of a sandbox chat;
// a test that sets these says which one stands for it. Unset, the app works it out.
let aliases: ReadonlyMap<string, ScopedThreadRef> | null = null;
vi.mock(import("~/state/sandboxes"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useSandboxChatAliases: () => {
      const own = actual.useSandboxChatAliases();
      return aliases ?? own;
    },
  };
});

const openApp = async (path: string) => {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const app = await render(<AppRoot router={router} />, { router: false });
  return { router, app };
};

const messageDispatches = () =>
  dispatchedCommands().filter(
    (command): command is Extract<OrchestrationV2Command, { type: "message.dispatch" }> =>
      command.type === "message.dispatch",
  );

it("opening the host's mirror of a running sandbox's chat opens the sandbox's own thread", async () => {
  using _environment = installFakeEnvironment(THREADS, { sandboxes: SANDBOXES });
  aliases = new Map([
    [
      threadKey({ environmentId: ENVIRONMENT_ID, threadId: mirrored.id }),
      { environmentId: SANDBOX, threadId: mirrored.id },
    ],
  ]);
  using _aliases = { [Symbol.dispose]: () => (aliases = null) };

  const { router, app } = await openApp(`/${ENVIRONMENT_ID}/${mirrored.id}`);
  await using _app = app;
  // The app's first render loads the chat lazily, so the move can take a while.
  await expect
    .poll(() => router.state.location.pathname, { interval: 100, timeout: 15_000 })
    .toBe(`/${SANDBOX}/${mirrored.id}`);
});

it("a stopped sandbox's own thread opens the host's mirror, taking the unsent draft along", async () => {
  using _environment = installFakeEnvironment(THREADS, { sandboxes: SANDBOXES });
  // Here the listed thread is the sandbox's own, and the mirror is on the other environment.
  const own = scopeThreadRef(ENVIRONMENT_ID, stoppedOwn.id);
  const mirror = scopeThreadRef(SANDBOX, stoppedOwn.id);
  aliases = new Map([[threadKey(own), mirror]]);
  using _aliases = { [Symbol.dispose]: () => (aliases = null) };
  useComposerDraftStore.getState().setPrompt(own, "Half a thought");

  const { router, app } = await openApp(`/${ENVIRONMENT_ID}/${stoppedOwn.id}`);
  await using _app = app;
  await expect
    .poll(() => router.state.location.pathname, { interval: 100, timeout: 15_000 })
    .toBe(`/${SANDBOX}/${stoppedOwn.id}`);
  const drafts = useComposerDraftStore.getState();
  expect(drafts.getComposerDraft(mirror)?.prompt).toBe("Half a thought");
  expect(drafts.getComposerDraft(own)?.prompt ?? "").toBe("");
});

it("a message to a stopped sandbox goes to the host's mirror once and stays there when the user leaves", async () => {
  using _environment = installFakeEnvironment(THREADS, {
    sandboxes: SANDBOXES,
    acceptCommands: true,
  });

  const { router, app } = await openApp(`/${ENVIRONMENT_ID}/${queued.id}`);
  await using _app = app;
  await expect.element(page.getByText("Answer 0 for thread-queued.").first()).toBeVisible();
  // The mirror is the conversation while its sandbox is stopped, so the route stays on it.
  await expect.element(page.getByText("Sandbox bx_9kq2 is stopped")).toBeVisible();
  expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${queued.id}`);

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("Pick this up when you are back");
  await userEvent.click(page.getByRole("button", { name: "Submit message" }));

  // A run on the host, which resumes the sandbox and delivers it; nothing waits in this client.
  await vi.waitFor(() =>
    expect(messageDispatches()).toEqual([
      expect.objectContaining({
        threadId: queued.id,
        text: "Pick this up when you are back",
      }),
    ]),
  );
  await expect.element(page.getByText("Resuming the sandbox")).not.toBeInTheDocument();

  // Leaving the chat sends nothing more and cancels nothing: the run is the host's.
  await router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: ENVIRONMENT_ID, threadId: other.id },
  });
  await expect.element(page.getByText("Answer 0 for thread-other.").first()).toBeVisible();
  expect(messageDispatches()).toHaveLength(1);
  expect(
    dispatchedCommands().filter(
      (command) => command.type === "run.interrupt" || command.type === "queued-run.cancel",
    ),
  ).toEqual([]);
});
