import { AsyncResult } from "effect/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  check: vi.fn(
    async (_request: { input: { clientSecret: string; clientId?: string } }) =>
      AsyncResult.success({ clientId: "kABC", scopes: [] as string[], problem: null }) as unknown,
  ),
  update: vi.fn((_patch: unknown) => {}),
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => ({
    clientId: "",
    clientSecret: "",
    tag: "tag:t3-sandbox",
  })) as never,
  useUpdateEnvironmentSettings: (() => mocks.update) as never,
}));
// The row's chrome reads app-wide scope; its control and form are what is under test.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({ control, children }: { control: ReactNode; children: ReactNode }) => (
    <div>
      {control}
      {children}
    </div>
  )) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      sandboxesCheckTailscale: mocks.check as never,
    },
  };
});

import { SandboxTailscaleRow } from "./SandboxTailscaleRow";

const SECRET = "tskey-client-kABC-not-a-real-secret";

const row = () => (
  <SandboxTailscaleRow environmentId={EnvironmentId.make("11111111-1111-4111-8111-111111111111")} />
);

describe("SandboxTailscaleRow", () => {
  it("sets up from the secret alone, saving the client ID read from it", async () => {
    mocks.check.mockClear();
    mocks.update.mockClear();
    await using _screen = await render(row());

    await userEvent.click(page.getByRole("button", { name: "Set up" }));
    await userEvent.fill(page.getByLabelText("Tailscale OAuth client secret"), SECRET);
    await expect.element(page.getByText(/Client ID kABC, read from the secret/u)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Save" }));

    expect(mocks.check).toHaveBeenCalledWith(
      expect.objectContaining({ input: { clientSecret: SECRET } }),
    );
    expect(mocks.update).toHaveBeenCalledWith({
      sandboxTailscale: { clientId: "kABC", clientSecret: SECRET, tag: "tag:t3-sandbox" },
    });
  });

  it("keeps the form open with the reason when the client lacks a scope", async () => {
    mocks.update.mockClear();
    mocks.check.mockImplementationOnce(async () =>
      AsyncResult.success({
        clientId: "kABC",
        scopes: ["auth_keys"],
        problem: "This OAuth client is missing the devices:core scope.",
      }),
    );
    await using _screen = await render(row());

    await userEvent.click(page.getByRole("button", { name: "Set up" }));
    await userEvent.fill(page.getByLabelText("Tailscale OAuth client secret"), SECRET);
    await userEvent.click(page.getByRole("button", { name: "Save" }));

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This OAuth client is missing the devices:core scope.");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("takes a separate client ID under Advanced for a secret of another form", async () => {
    mocks.check.mockClear();
    await using _screen = await render(row());

    await userEvent.click(page.getByRole("button", { name: "Set up" }));
    await userEvent.fill(page.getByLabelText("Tailscale OAuth client secret"), "other-secret");
    await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.click(page.getByRole("button", { name: "Advanced" }));
    await userEvent.fill(page.getByLabelText("Tailscale OAuth client ID"), "kOTHER");
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    expect(mocks.check).toHaveBeenCalledWith(
      expect.objectContaining({ input: { clientSecret: "other-secret", clientId: "kOTHER" } }),
    );
  });
});
