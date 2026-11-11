import { createMemoryHistory } from "@tanstack/react-router";
import {
  EnvironmentId,
  type OrchestrationV2Command,
  type SandboxRecord,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the test.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  bringFakeEnvironmentOnline,
  dispatchedCommands,
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

// Each resume this client asks for, answered when the test says its sandbox is back.
const resumes = vi.hoisted(
  () => new Map<string, { readonly resolve: (running: boolean) => void }>(),
);
vi.mock(import("~/state/sandboxThreads"), async (original) => ({
  ...(await original()),
  ensureSandboxThreadRunning: (threadRef: ScopedThreadRef) =>
    new Promise<boolean>((resolve) => {
      resumes.set(threadRef.threadId, { resolve });
    }),
}));

const first = threadWithHistory("thread-first", 1);
const second = threadWithHistory("thread-second", 1);

// Two chats kept as their own stopped sandboxes, with no host mirror: the legacy path, where this
// client resumes the sandbox and sends the message itself once its server answers.
const stoppedSandbox = (threadId: ThreadId, instanceId: string, sandboxId: string) =>
  ({
    instanceId,
    environmentId: EnvironmentId.make(ENVIRONMENT_ID),
    configId: "config-1",
    threadId,
    provider: "boat",
    sandboxId,
    label: "render on Boat small",
    size: "small",
    state: "stopped",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    httpBaseUrl: "https://bx.example.test",
    runningSince: null,
    stoppedAt: "2026-11-01T11:00:00.000Z",
    maxRunningMinutes: 480,
  }) satisfies SandboxRecord;

const messageDispatches = () =>
  dispatchedCommands()
    .filter(
      (command): command is Extract<OrchestrationV2Command, { type: "message.dispatch" }> =>
        command.type === "message.dispatch",
    )
    .map((command) => ({ threadId: command.threadId, text: command.text }));

it("two stopped sandboxes resumed back to back each show their own wait and send their own message", async () => {
  using _environment = installFakeEnvironment([first, second], {
    sandboxes: [
      stoppedSandbox(first.id, "instance-first", "bx_aaaa1111"),
      stoppedSandbox(second.id, "instance-second", "bx_bbbb2222"),
    ],
    acceptCommands: true,
  });
  using _resumes = { [Symbol.dispose]: () => resumes.clear() };
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1100, 700);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${second.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const open = async (threadId: ThreadId, answer: string) => {
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId },
    });
    await expect.element(page.getByText(answer).first()).toBeVisible();
  };
  // Both chats were read while their sandboxes ran.
  await expect.element(page.getByText("Answer 0 for thread-second.").first()).toBeVisible();
  await open(first.id, "Answer 0 for thread-first.");
  const send = async (text: string) => {
    await userEvent.click(page.getByTestId("composer-editor"));
    await userEvent.keyboard(text);
    await userEvent.click(page.getByRole("button", { name: "Submit message" }));
  };

  // Both sandboxes' servers are off.
  await takeFakeEnvironmentOffline();
  await expect.element(page.getByText("Sandbox bx_aaaa is stopped")).toBeVisible();
  await send("Hello from the first");
  await expect.element(page.getByText("Resuming sandbox bx_aaaa")).toBeVisible();
  expect([...resumes.keys()]).toEqual([first.id]);

  // The second chat has its own state: stopped, with nothing of the first chat's wait.
  await open(second.id, "Answer 0 for thread-second.");
  await expect.element(page.getByText("Sandbox bx_bbbb is stopped")).toBeVisible();
  await expect
    .element(page.getByText("Your message sends once it is running again."))
    .not.toBeInTheDocument();
  await expect.element(page.getByText(/Resuming sandbox/)).not.toBeInTheDocument();

  // And it resumes too, while the first one still starts.
  await send("Hello from the second");
  await expect.element(page.getByText("Resuming sandbox bx_bbbb")).toBeVisible();
  expect([...resumes.keys()]).toEqual([first.id, second.id]);
  await page.screenshot({ path: "__screenshots__/sandbox-resume-second-waiting.png" });

  // The first sandbox comes back while the user is on the second: the second keeps its own
  // wait, the first's message is not sent from here, and the user hears where it waits.
  resumes.get(first.id)!.resolve(true);
  await expect.element(page.getByText("Sandbox running again")).toBeVisible();
  await expect.element(page.getByText("Resuming sandbox bx_bbbb")).toBeVisible();
  expect(messageDispatches()).toEqual([]);

  // The second's server answers: it sends its own message, and only that.
  bringFakeEnvironmentOnline();
  resumes.get(second.id)!.resolve(true);
  await vi.waitFor(() =>
    expect(messageDispatches()).toEqual([{ threadId: second.id, text: "Hello from the second" }]),
  );

  // Back on the first chat, its message goes from its own composer.
  await userEvent.click(page.getByRole("button", { name: "Open chat" }));
  await expect.element(page.getByText("Answer 0 for thread-first.").first()).toBeVisible();
  await vi.waitFor(() =>
    expect(messageDispatches()).toEqual([
      { threadId: second.id, text: "Hello from the second" },
      { threadId: first.id, text: "Hello from the first" },
    ]),
  );
});
