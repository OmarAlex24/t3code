import { AsyncResult } from "effect/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  check: vi.fn(
    async (_request: { input: { clientSecret: string; clientId?: string } }) =>
      AsyncResult.success({ clientId: "kABC", scopes: [] as string[], problem: null }) as unknown,
  ),
  update: vi.fn((_patch: unknown) => {}),
  saved: { clientId: "", clientSecret: "", tag: "tag:t3-sandbox" },
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => mocks.saved) as never,
  useUpdateEnvironmentSettings: (() => mocks.update) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      sandboxesCheckTailscale: mocks.check as never,
      sandboxesProviders: (() => "providers") as never,
    },
  };
});
// The endpoint this server's Claude uses resolves to a tailnet address.
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data:
      atom === "providers"
        ? {
            providers: [],
            host: {
              claude: {
                baseUrl: "https://hub.example.ts.net",
                key: "hub",
                privateNetwork: true,
                tailnetAddress: "100.92.23.53",
              },
              github: false,
              tailscale: false,
            },
          }
        : undefined,
    error: null,
    isPending: false,
  })) as never,
}));

import { SandboxTailscaleForm } from "./SandboxTailscaleForm";

const SECRET = "tskey-client-kABC-not-a-real-secret";
const NOTHING_SAVED = { clientId: "", clientSecret: "", tag: "tag:t3-sandbox" };
const SAVED = { clientId: "kABC", clientSecret: "••••••", tag: "tag:t3-sandbox" };

const form = (onDone: () => void = () => {}) => (
  <SandboxTailscaleForm
    environmentId={EnvironmentId.make("11111111-1111-4111-8111-111111111111")}
    onDone={onDone}
    onCancel={() => {}}
  />
);

describe("SandboxTailscaleForm", () => {
  it("walks through the tag, the OAuth client and the secret when nothing is saved", async () => {
    mocks.saved = NOTHING_SAVED;
    await using _screen = await render(form());

    await expect.element(page.getByText("Add the tag and an access rule")).toBeVisible();
    // The rule lets sandboxes reach the Claude endpoint at its tailnet address, and nothing else.
    await expect
      .element(page.getByText(/"dst": \["100\.92\.23\.53"\], "ip": \["tcp:443"\]/u))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Copy policy" })).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: /Open policy file/u }))
      .toHaveAttribute("href", "https://login.tailscale.com/admin/acls/file");
    await expect
      .element(page.getByRole("link", { name: /Open trust credentials/u }))
      .toHaveAttribute("href", "https://login.tailscale.com/admin/settings/trust-credentials");
    await expect.element(page.getByText("Custom scopes")).toBeVisible();
    await expect.element(page.getByLabelText("Tailscale OAuth client secret")).toBeVisible();
  });

  it("keeps the steps folded when replacing a saved client", async () => {
    mocks.saved = SAVED;
    await using _screen = await render(form());

    await expect.element(page.getByLabelText("Tailscale OAuth client secret")).toBeVisible();
    await expect.element(page.getByText("Add the tag and an access rule")).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Setup steps" }));
    await expect.element(page.getByText("Add the tag and an access rule")).toBeVisible();
  });

  it("opens the steps with the reason when Tailscale refuses the tag", async () => {
    mocks.saved = SAVED;
    mocks.update.mockClear();
    mocks.check.mockImplementationOnce(async () =>
      AsyncResult.success({
        clientId: "kABC",
        scopes: [],
        problem: "Tailscale won't give this client tag:t3-sandbox. Add the tag to tagOwners.",
      }),
    );
    await using _screen = await render(form());

    await userEvent.fill(page.getByLabelText("Tailscale OAuth client secret"), SECRET);
    await userEvent.click(page.getByRole("button", { name: "Save" }));

    await expect.element(page.getByText("Add the tag and an access rule")).toBeVisible();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Tailscale won't give this client tag:t3-sandbox. Add the tag to tagOwners.",
      );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("sets up from the secret alone, saving the client ID read from it", async () => {
    mocks.saved = NOTHING_SAVED;
    mocks.check.mockClear();
    mocks.update.mockClear();
    const onDone = vi.fn();
    await using _screen = await render(form(onDone));

    await userEvent.fill(page.getByLabelText("Tailscale OAuth client secret"), SECRET);
    await expect.element(page.getByText(/Client ID kABC, read from the secret/u)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Save" }));

    expect(mocks.check).toHaveBeenCalledWith(
      expect.objectContaining({ input: { clientSecret: SECRET, tag: "tag:t3-sandbox" } }),
    );
    expect(mocks.update).toHaveBeenCalledWith({
      sandboxTailscale: { clientId: "kABC", clientSecret: SECRET, tag: "tag:t3-sandbox" },
    });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("keeps the form open with the reason when the client lacks a scope", async () => {
    mocks.saved = NOTHING_SAVED;
    mocks.update.mockClear();
    mocks.check.mockImplementationOnce(async () =>
      AsyncResult.success({
        clientId: "kABC",
        scopes: ["auth_keys"],
        problem: "This OAuth client is missing the devices:core scope.",
      }),
    );
    await using _screen = await render(form());

    await userEvent.fill(page.getByLabelText("Tailscale OAuth client secret"), SECRET);
    await userEvent.click(page.getByRole("button", { name: "Save" }));

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This OAuth client is missing the devices:core scope.");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("takes a separate client ID under Advanced for a secret of another form", async () => {
    mocks.saved = NOTHING_SAVED;
    mocks.check.mockClear();
    await using _screen = await render(form());

    await userEvent.fill(page.getByLabelText("Tailscale OAuth client secret"), "other-secret");
    await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.click(page.getByRole("button", { name: "Advanced" }));
    await userEvent.fill(page.getByLabelText("Tailscale OAuth client ID"), "kOTHER");
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    expect(mocks.check).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { clientSecret: "other-secret", clientId: "kOTHER", tag: "tag:t3-sandbox" },
      }),
    );
  });
});
