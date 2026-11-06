import { AsyncResult } from "effect/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";

const NOTHING_SAVED = {
  githubAppId: "",
  githubAppSlug: "",
  githubAppOwner: "",
  githubAppPrivateKey: "",
  northflankToken: "",
  mapleAdminKey: "",
  railwayToken: "",
  railwayWorkspaceId: "",
  railwayWorkspaceName: "",
};

const RAILWAY_WORKSPACES = [
  { id: "ws_1", name: "Omar's projects" },
  { id: "ws_2", name: "Team" },
];

const mocks = vi.hoisted(() => ({
  connect: vi.fn(
    async (_request: { input: { code: string } }) =>
      AsyncResult.success({
        slug: "t3-code-sandboxes",
        owner: "octo",
        installUrl: "https://github.com/apps/t3-code-sandboxes/installations/new",
      }) as unknown,
  ),
  // An account token reaches two workspaces, so the server asks which one until it is told.
  connectRailway: vi.fn(async (request: { input: { token: string; workspaceId?: string } }) =>
    request.input.workspaceId === undefined
      ? AsyncResult.success({
          workspaces: RAILWAY_WORKSPACES,
          problem: "This token reaches several workspaces. Pick the one sandboxes get tokens in.",
        })
      : AsyncResult.success({
          saved: RAILWAY_WORKSPACES.find((workspace) => workspace.id === request.input.workspaceId),
          workspaces: [],
          problem: null,
        }),
  ),
  update: vi.fn((_patch: unknown) => {}),
  saved: {} as Record<string, string>,
  tailscale: { clientId: "", clientSecret: "", tag: "" },
  openExternal: vi.fn(async (_url: string) => {}),
}));

vi.mock(import("~/localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ shell: { openExternal: mocks.openExternal } })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentHttpBaseUrl: (() => "http://127.0.0.1:3773/") as never,
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((_environmentId: unknown, select: (settings: unknown) => unknown) =>
    select({ sandboxTooling: mocks.saved, sandboxTailscale: mocks.tailscale })) as never,
  useUpdateEnvironmentSettings: (() => mocks.update) as never,
}));
// The row's chrome reads app-wide scope; its control and list are what is under test.
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
      sandboxesConnectRailway: mocks.connectRailway as never,
    },
  };
});

import { SandboxAccessRows } from "./SandboxAccessRows";
import { SettingsPageContainer } from "./settingsLayout";

const STATE_KEY = "t3code:sandbox-github-app-state";
const rows = () => (
  <SandboxAccessRows environmentId={EnvironmentId.make("11111111-1111-4111-8111-111111111111")} />
);
const connected = () => page.getByRole("list", { name: "Connected integrations" });
const add = async (name: string) => {
  await userEvent.click(page.getByRole("button", { name: "Add integration" }));
  await userEvent.click(page.getByRole("menuitem", { name }));
};
const actions = async (name: string) =>
  userEvent.click(page.getByRole("button", { name: `More actions for ${name}` }));

function setup(
  saved: Record<string, string>,
  tailscale = { clientId: "", clientSecret: "", tag: "" },
) {
  mocks.saved = saved;
  mocks.tailscale = tailscale;
  mocks.openExternal.mockClear();
  mocks.connect.mockClear();
  mocks.connectRailway.mockClear();
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

  it("lists nothing when nothing is connected, and offers every integration to add", async () => {
    setup(NOTHING_SAVED);
    await using _screen = await render(rows());

    await expect.element(connected()).not.toBeInTheDocument();
    await expect.element(page.getByText(/^None connected\./u)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Add integration" }));
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll('[role="menuitem"]'), (item) => item.textContent),
      )
      .toEqual(["Tailscale", "GitHub App", "Northflank", "Maple", "Railway"]);
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
      await add("GitHub App");
      await expect.element(page.getByRole("dialog", { name: "Connect GitHub App" })).toBeVisible();
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
              checks: "read",
              statuses: "read",
              actions: "read",
            },
          }),
        },
      ]);
      expect(submitted[0]!.manifest).not.toHaveProperty("hook_attributes");

      const connect = page.getByRole("button", { name: "Connect", exact: true });
      await expect.element(connect).toBeDisabled();
      await userEvent.fill(
        page.getByRole("textbox", { name: "Address GitHub opened" }),
        `http://127.0.0.1/t3-sandbox-github-app?code=pasted-code&state=${state}`,
      );
      await userEvent.click(connect);
      expect(mocks.connect).toHaveBeenCalledWith(
        expect.objectContaining({ input: { code: "pasted-code" } }),
      );
      // Connecting closes the panel.
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    } finally {
      submit.mockRestore();
    }
  });

  it("in the desktop app, opens the server's manifest page in the browser instead", async () => {
    setup(NOTHING_SAVED);
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit");
    window.desktopBridge = {} as NonNullable<typeof window.desktopBridge>;
    try {
      await using _screen = await render(rows());
      await add("GitHub App");
      await userEvent.click(page.getByRole("button", { name: "Create the app" }));

      const state = localStorage.getItem(STATE_KEY);
      expect(mocks.openExternal).toHaveBeenCalledWith(
        `http://127.0.0.1:3773/api/sandbox/github-app/new?state=${state}`,
      );
      expect(submit).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("textbox", { name: "Address GitHub opened" }))
        .toBeVisible();
    } finally {
      delete window.desktopBridge;
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
      .element(connected().getByRole("listitem", { name: "GitHub App" }))
      .toHaveTextContent("GitHub Appt3-code-sandboxes");
    await actions("GitHub App");
    await expect
      .element(page.getByRole("menuitem", { name: "Install on repositories" }))
      .toHaveAttribute("href", "https://github.com/apps/t3-code-sandboxes/installations/new");
    await userEvent.click(page.getByRole("menuitem", { name: "Remove" }));
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

    // Only what is connected is listed; the rest waits under Add integration.
    await expect
      .element(connected().getByRole("listitem", { name: "Maple" }))
      .toHaveTextContent("MapleAdmin key saved");
    expect(connected().getByRole("listitem").elements()).toHaveLength(1);
    await add("Northflank");
    await userEvent.fill(page.getByLabelText("Northflank API token"), "nf-not-a-real-token");
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    expect(mocks.update).toHaveBeenLastCalledWith({
      sandboxTooling: { northflankToken: "nf-not-a-real-token" },
    });
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

    await actions("Maple");
    await expect
      .element(page.getByRole("menuitem", { name: "API keys" }))
      .toHaveAttribute("href", "https://maple.dev/docs/reference/api/");
    await userEvent.click(page.getByRole("menuitem", { name: "Remove" }));
    expect(mocks.update).toHaveBeenLastCalledWith({ sandboxTooling: { mapleAdminKey: "" } });
  });

  it("checks a Railway token with the server, and asks for the workspace when there is a choice", async () => {
    setup(NOTHING_SAVED);
    await using _screen = await render(rows());

    await add("Railway");
    const railway = page.getByRole("dialog", { name: "Connect Railway" });
    await userEvent.fill(railway.getByLabelText("Railway token"), "account-token");
    await userEvent.click(railway.getByRole("button", { name: "Save" }));
    await expect
      .element(railway.getByText("This token reaches several workspaces.", { exact: false }))
      .toBeVisible();
    // The token is the server's to save, once Railway answers for a workspace.
    expect(mocks.update).not.toHaveBeenCalled();

    await expect.element(railway.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.click(railway.getByRole("combobox", { name: "Railway workspace" }));
    await userEvent.click(page.getByRole("option", { name: "Team" }));
    await userEvent.click(railway.getByRole("button", { name: "Save" }));
    expect(mocks.connectRailway).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: { token: "account-token", workspaceId: "ws_2" } }),
    );
    await expect.element(page.getByLabelText("Railway token")).not.toBeInTheDocument();
  });

  it("shows the saved Railway workspace, replaces the token in the same panel, and removes it", async () => {
    setup({
      ...NOTHING_SAVED,
      railwayToken: "••••••",
      railwayWorkspaceId: "ws_1",
      railwayWorkspaceName: "Omar's projects",
    });
    await using _screen = await render(rows());
    await expect
      .element(connected().getByRole("listitem", { name: "Railway" }))
      .toHaveTextContent("RailwayOmar's projects");

    await actions("Railway");
    await userEvent.click(page.getByRole("menuitem", { name: "Replace…" }));
    await expect
      .element(
        page.getByRole("dialog", { name: "Replace Railway" }).getByLabelText("Railway token"),
      )
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));

    await actions("Railway");
    await userEvent.click(page.getByRole("menuitem", { name: "Remove" }));
    expect(mocks.update).toHaveBeenLastCalledWith({
      sandboxTooling: { railwayToken: "", railwayWorkspaceId: "", railwayWorkspaceName: "" },
    });
  });

  it("opens the panel for a linked integration that isn't connected, and lands on one that is", async () => {
    setup({ ...NOTHING_SAVED, mapleAdminKey: "••••••" });
    {
      await using _screen = await render(<SettingsPageContainer>{rows()}</SettingsPageContainer>, {
        router: "/#sandbox-railway",
      });
      await expect.element(page.getByRole("dialog", { name: "Connect Railway" })).toBeVisible();
    }
    await using _screen = await render(<SettingsPageContainer>{rows()}</SettingsPageContainer>, {
      router: "/#sandbox-maple",
    });
    await vi.waitFor(() => expect(document.activeElement?.id).toBe("sandbox-maple"));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });
});
