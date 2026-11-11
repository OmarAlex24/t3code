import {
  EnvironmentId,
  SANDBOX_SETUP_STAGE_ORDER,
  type SandboxSetupSnapshot,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";

const HOST_ENV = "11111111-1111-4111-8111-111111111111";
const SANDBOX_ENV = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    version: 0,
    snapshot: null as unknown,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bump: () => {
      state.version += 1;
      for (const listener of listeners) listener();
    },
  };
  return {
    state,
    launchStateFor: [] as Array<unknown>,
    cancelLaunch: vi.fn(async () => ({ _tag: "Success", value: { cancelled: true } })),
    retryLaunch: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  };
});

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      sandboxesLaunchState: ((input: unknown) => {
        mocks.launchStateFor.push(input);
        return "launch-state";
      }) as never,
      sandboxesCancelLaunch: mocks.cancelLaunch as never,
      sandboxesRetryLaunch: mocks.retryLaunch as never,
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => {
    useSyncExternalStore(mocks.state.subscribe, () => mocks.state.version);
    return {
      data: atom === "launch-state" ? mocks.state.snapshot : undefined,
      isPending: false,
      error: null,
      refresh: () => {},
    };
  }) as never,
}));
vi.mock(import("~/state/sandboxes"), async (original) => ({
  ...(await original()),
  useSandboxProvisionerEnvironmentId: (() => EnvironmentId.make(HOST_ENV)) as never,
}));

import { useSandboxThreadSetup } from "./useSandboxThreadSetup";

const threadId = ThreadId.make("thread-sandbox");
const hostRef = { environmentId: EnvironmentId.make(HOST_ENV), threadId };

const snapshot = (overrides: Partial<SandboxSetupSnapshot> = {}): SandboxSetupSnapshot => ({
  threadId,
  instanceId: "instance-1",
  configId: "config-1",
  label: "Boat small",
  provider: "boat",
  phase: "running",
  startedAt: "2026-11-10T10:00:00.000Z",
  endedAt: null,
  stages: SANDBOX_SETUP_STAGE_ORDER.map((id, index) => ({
    id,
    status: index < 3 ? "done" : index === 3 ? "running" : "pending",
    startedAt: index <= 3 ? "2026-11-10T10:00:00.000Z" : null,
    endedAt: index < 3 ? "2026-11-10T10:00:20.000Z" : null,
    detail: null,
  })),
  warnings: [],
  error: null,
  recovery: null,
  awaitingHandoff: false,
  sequence: 1,
  ...overrides,
});

function Harness({ threadRef }: { readonly threadRef: ScopedThreadRef | null }) {
  return <div data-testid="thread">{useSandboxThreadSetup(threadRef)}</div>;
}

describe("useSandboxThreadSetup", () => {
  it("shows the launch's setup in its host thread while the first message waits", async () => {
    mocks.state.snapshot = snapshot();
    mocks.state.bump();
    await using _screen = await render(<Harness threadRef={hostRef} />);

    await expect.element(page.getByText("Starting a sandbox on Boat small…").first()).toBeVisible();
    expect(mocks.launchStateFor.at(-1)).toEqual({
      environmentId: HOST_ENV,
      input: { threadId },
    });

    // Once the launch is done the message goes out and the thread shows the work instead.
    mocks.state.snapshot = snapshot({ phase: "done", endedAt: "2026-11-10T10:03:00.000Z" });
    mocks.state.bump();
    await expect
      .element(page.getByRole("region", { name: "Sandbox setup" }))
      .not.toBeInTheDocument();
  });

  it("retries a failed launch on the host, where the message waits again", async () => {
    mocks.retryLaunch.mockClear();
    mocks.state.snapshot = snapshot({
      phase: "failed",
      error: "Could not clone acme/web.",
      recovery: "retry",
    });
    mocks.state.bump();
    await using _screen = await render(<Harness threadRef={hostRef} />);

    await userEvent.click(page.getByRole("button", { name: "Retry" }));
    expect(mocks.retryLaunch).toHaveBeenCalledWith({
      environmentId: HOST_ENV,
      input: { threadId },
    });
  });

  it("shows nothing on a thread that is not the host's", async () => {
    mocks.state.snapshot = snapshot();
    mocks.state.bump();
    await using _screen = await render(
      <Harness threadRef={{ environmentId: EnvironmentId.make(SANDBOX_ENV), threadId }} />,
    );
    await expect.element(page.getByTestId("thread")).toBeEmptyDOMElement();
  });
});
