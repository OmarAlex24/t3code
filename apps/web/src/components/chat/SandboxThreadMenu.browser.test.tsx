import { EnvironmentId, type SandboxRecord, ThreadId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";

const HOST_ENV = "11111111-1111-4111-8111-111111111111";
const SANDBOX_ENV = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  sandboxes: [] as Array<unknown>,
  navigate: vi.fn(async () => undefined),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => mocks.navigate) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/state/sandboxes"), async (original) => ({
  ...(await original()),
  useSandboxProvisionerEnvironmentId: (() => EnvironmentId.make(HOST_ENV)) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      sandboxesList: (() => "list") as never,
      sandboxesProviders: (() => "providers") as never,
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data:
      atom === "list"
        ? { sandboxes: mocks.sandboxes, orphans: [] }
        : atom === "providers"
          ? {
              providers: [
                {
                  kind: "boat",
                  label: "Boat",
                  diskRetentionDays: 14,
                  capabilities: { stopResume: true },
                },
              ],
            }
          : null,
    isPending: false,
    error: null,
    refresh: () => {},
  })) as never,
}));

import { SandboxThreadMenu } from "./SandboxThreadMenu";

const threadId = ThreadId.make("thread-1");

const sandbox: SandboxRecord = {
  instanceId: "instance-1",
  environmentId: EnvironmentId.make(SANDBOX_ENV),
  configId: "config-1",
  threadId,
  provider: "boat",
  sandboxId: "bx_46wrabcd",
  label: "web on Boat small",
  size: "small",
  state: "running",
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  httpBaseUrl: "https://bx.example.test",
  runningSince: "2026-11-01T10:00:00.000Z",
  maxRunningMinutes: 480,
};

describe("SandboxThreadMenu", () => {
  it("opens the sandbox's own thread from the host thread the bridge drives", async () => {
    mocks.sandboxes = [{ ...sandbox, hostProjectId: "project-host" }];
    mocks.navigate.mockClear();
    await using _screen = await render(
      <SandboxThreadMenu threadRef={{ environmentId: EnvironmentId.make(HOST_ENV), threadId }} />,
    );

    await userEvent.click(page.getByRole("button", { name: /Sandbox bx_46wr/u }));
    await userEvent.click(page.getByRole("menuitem", { name: "Open sandbox thread" }));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: SANDBOX_ENV, threadId: "thread-1" },
    });
  });

  it("does not offer the sandbox thread on the sandbox thread itself", async () => {
    mocks.sandboxes = [{ ...sandbox, hostProjectId: "project-host" }];
    await using _screen = await render(
      <SandboxThreadMenu
        threadRef={{ environmentId: EnvironmentId.make(SANDBOX_ENV), threadId }}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: /Sandbox bx_46wr/u }));
    await expect.element(page.getByRole("menuitem", { name: "Delete sandbox…" })).toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: "Open sandbox thread" }))
      .not.toBeInTheDocument();
  });

  it("does not claim a host thread for a sandbox the bridge never linked", async () => {
    mocks.sandboxes = [sandbox];
    await using _screen = await render(
      <SandboxThreadMenu threadRef={{ environmentId: EnvironmentId.make(HOST_ENV), threadId }} />,
    );

    await expect
      .element(page.getByRole("button", { name: /Sandbox bx_46wr/u }))
      .not.toBeInTheDocument();
  });
});
