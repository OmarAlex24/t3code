import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, type SandboxRecord } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  sandboxes: [] as Array<unknown>,
  deleteSandbox: vi.fn(async () => AsyncResult.success({ warnings: [] })),
  stopSandbox: vi.fn(async () => AsyncResult.success(undefined)),
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => 1440) as never,
  useUpdateEnvironmentSettings: (() => () => {}) as never,
}));
vi.mock(import("~/hooks/useNowMinute"), () => ({ useNowMinute: () => "2026-11-01T12:00" }));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useSandboxProvisionerEnvironmentId: (() =>
    EnvironmentId.make("11111111-1111-4111-8111-111111111111")) as never,
}));
// The settings chrome reads app-wide scope; the row is what is under test.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSection: (({ children }: { children: unknown }) => children) as never,
  SettingsRow: (() => null) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      sandboxesList: (() => "list") as never,
      sandboxesProviders: (() => "providers") as never,
      sandboxesLimits: (() => "limits") as never,
      sandboxesStop: mocks.stopSandbox as never,
      sandboxesDelete: mocks.deleteSandbox as never,
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data:
      atom === "list"
        ? { sandboxes: mocks.sandboxes }
        : atom === "providers"
          ? { providers: [], host: { github: false } }
          : null,
    isPending: false,
    error: null,
    refresh: () => {},
  })) as never,
}));

import { SandboxManagementSection } from "./SandboxManagementSection";

const sandbox = (state: SandboxRecord["state"]): SandboxRecord => ({
  environmentId: EnvironmentId.make("22222222-2222-4222-8222-222222222222"),
  provider: "boat",
  sandboxId: "bx_1",
  label: "Web Stack",
  size: "default",
  state,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  httpBaseUrl: "https://bx-1.example.test",
  hardDeadlineAt: "2026-11-01T18:00:00.000Z",
  ttlMinutes: 480,
});

function setup(state: SandboxRecord["state"]) {
  mocks.sandboxes = [sandbox(state)];
  mocks.deleteSandbox.mockClear();
  mocks.stopSandbox.mockClear();
}

describe("SandboxManagementSection", () => {
  it("deletes a running sandbox after the user confirms", async () => {
    setup("running");
    await using _screen = await render(<SandboxManagementSection />);

    await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Delete sandbox" }));
    expect(mocks.deleteSandbox).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: "Delete sandbox" }));
    expect(mocks.deleteSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          provider: "boat",
          sandboxId: "bx_1",
          environmentId: "22222222-2222-4222-8222-222222222222",
        },
      }),
    );
    expect(mocks.stopSandbox).not.toHaveBeenCalled();
  });
});
