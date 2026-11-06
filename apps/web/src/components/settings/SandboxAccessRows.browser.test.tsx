import { AsyncResult } from "effect/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const NOTHING_SAVED = {
  githubAppId: "",
  githubAppSlug: "",
  githubAppOwner: "",
  githubAppPrivateKey: "",
  northflankToken: "",
  mapleAdminKey: "",
};

const mocks = vi.hoisted(() => ({
  connect: vi.fn(
    async (_request: { input: { code: string } }) =>
      AsyncResult.success({
        slug: "t3-code-sandboxes",
        owner: "octo",
        installUrl: "https://github.com/apps/t3-code-sandboxes/installations/new",
      }) as unknown,
  ),
  update: vi.fn((_patch: unknown) => {}),
  saved: {} as Record<string, string>,
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((_environmentId: unknown, select: (settings: unknown) => unknown) =>
    select({ sandboxTooling: mocks.saved })) as never,
  useUpdateEnvironmentSettings: (() => mocks.update) as never,
}));
// The row's chrome reads app-wide scope; its control and form are what is under test.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({
    title,
    control,
    children,
  }: {
    title: ReactNode;
    control: ReactNode;
    children: ReactNode;
  }) => (
    <section aria-label={String(title)}>
      {control}
      {children}
    </section>
  )) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      sandboxesConnectGithubApp: mocks.connect as never,
    },
  };
});

import { SandboxAccessRows } from "./SandboxAccessRows";

const STATE_KEY = "t3code:sandbox-github-app-state";
const rows = () => (
  <SandboxAccessRows environmentId={EnvironmentId.make("11111111-1111-4111-8111-111111111111")} />
);
const githubRow = () => page.getByRole("region", { name: "GitHub App" });

function setup(saved: Record<string, string>) {
  mocks.saved = saved;
  mocks.connect.mockClear();
  mocks.update.mockClear();
  localStorage.removeItem(STATE_KEY);
}

describe("SandboxAccessRows", () => {
  // First, since a page reads the address GitHub opened it with only once.
  it("connects the app when GitHub sends the new tab back with the code it asked for", async () => {
    setup(NOTHING_SAVED);
    const original = window.location.href;
    localStorage.setItem(STATE_KEY, "state-1");
    window.history.replaceState(window.history.state, "", "?code=one-time-code&state=state-1");
    try {
      await using _screen = await render(rows());
      await vi.waitFor(() =>
        expect(mocks.connect).toHaveBeenCalledWith(
          expect.objectContaining({ input: { code: "one-time-code" } }),
        ),
      );
      // The code is used once and taken out of the address.
      expect(window.location.search).toBe("");
      expect(localStorage.getItem(STATE_KEY)).toBeNull();
    } finally {
      window.history.replaceState(window.history.state, "", original);
    }
  });

  it("opens GitHub with the manifest in a new tab and connects from a pasted address", async () => {
    setup(NOTHING_SAVED);
    const submitted: Array<{ action: string; target: string; manifest: unknown }> = [];
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (
      this: HTMLFormElement,
    ) {
      const input = this.querySelector<HTMLInputElement>('input[name="manifest"]');
      submitted.push({
        action: this.action,
        target: this.target,
        manifest: JSON.parse(input?.value ?? "null"),
      });
    });
    try {
      await using _screen = await render(rows());
      await userEvent.click(page.getByRole("button", { name: "Create the app" }));

      const state = localStorage.getItem(STATE_KEY);
      expect(state).not.toBeNull();
      expect(submitted).toEqual([
        {
          action: `https://github.com/settings/apps/new?state=${state}`,
          target: "_blank",
          manifest: expect.objectContaining({
            name: "T3 Code sandboxes",
            public: false,
            redirect_url: `${window.location.origin}/settings/connections`,
            default_permissions: {
              contents: "write",
              pull_requests: "write",
              metadata: "read",
            },
          }),
        },
      ]);
      expect(submitted[0]!.manifest).not.toHaveProperty("hook_attributes");

      const connect = page.getByRole("button", { name: "Connect" });
      await expect.element(connect).toBeDisabled();
      await userEvent.fill(
        page.getByRole("textbox", { name: "Address GitHub opened" }),
        `http://127.0.0.1/t3-sandbox-github-app?code=pasted-code&state=${state}`,
      );
      await userEvent.click(connect);
      expect(mocks.connect).toHaveBeenCalledWith(
        expect.objectContaining({ input: { code: "pasted-code" } }),
      );
    } finally {
      submit.mockRestore();
    }
  });

  it("links a connected app to its install page and removes it", async () => {
    setup({
      ...NOTHING_SAVED,
      githubAppId: "123",
      githubAppSlug: "t3-code-sandboxes",
      githubAppOwner: "octo",
      githubAppPrivateKey: "••••••",
    });
    await using _screen = await render(rows());

    await expect
      .element(githubRow().getByRole("link", { name: "Install on repositories" }))
      .toHaveAttribute("href", "https://github.com/apps/t3-code-sandboxes/installations/new");
    await userEvent.click(githubRow().getByRole("button", { name: "Remove" }));
    expect(mocks.update).toHaveBeenCalledWith({
      sandboxTooling: {
        githubAppId: "",
        githubAppSlug: "",
        githubAppOwner: "",
        githubAppPrivateKey: "",
      },
    });
  });

  it("saves and removes the shared Northflank token and the Maple admin key", async () => {
    setup({ ...NOTHING_SAVED, mapleAdminKey: "••••••" });
    await using _screen = await render(rows());

    const northflank = page.getByRole("region", { name: "Northflank token" });
    await userEvent.click(northflank.getByRole("button", { name: "Add" }));
    await userEvent.fill(northflank.getByLabelText("Northflank API token"), "nf-not-a-real-token");
    await userEvent.click(northflank.getByRole("button", { name: "Save" }));
    expect(mocks.update).toHaveBeenLastCalledWith({
      sandboxTooling: { northflankToken: "nf-not-a-real-token" },
    });

    const maple = page.getByRole("region", { name: "Maple admin key" });
    await expect.element(maple.getByText("Saved")).toBeVisible();
    await userEvent.click(maple.getByRole("button", { name: "Remove" }));
    expect(mocks.update).toHaveBeenLastCalledWith({ sandboxTooling: { mapleAdminKey: "" } });
  });
});
