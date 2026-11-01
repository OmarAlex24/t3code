import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, type SandboxProviderLimits } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  limits: null as SandboxProviderLimits | null,
  createSandbox: vi.fn(async () =>
    AsyncResult.success({
      provider: "boat",
      sandboxId: "sb-1",
      environmentId: "22222222-2222-4222-8222-222222222222",
      label: "Boat sandbox",
      httpBaseUrl: "https://sb-1.example.test",
      pairingCode: "PAIR",
      setup: {
        claude: "ready",
        github: "failed",
        warnings: ["The GitHub CLI could not be installed on the sandbox."],
      },
    }),
  ),
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/connection/onboarding"), async (original) => ({
  ...(await original()),
  connectPairing: (async () => AsyncResult.success(undefined)) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (() => true) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      sandboxesProviders: (() => "providers") as never,
      sandboxesEnvironments: (() => "environments") as never,
      sandboxesLimits: (() => "limits") as never,
      sandboxesCreate: mocks.createSandbox as never,
    },
  };
});
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data:
      atom === "providers"
        ? {
            providers: [
              {
                kind: "boat",
                label: "Boat",
                detail: "Full Ubuntu VMs.",
                apiKeyLabel: "Boat API key",
                apiKeyPlaceholder: "boat_...",
                docsUrl: "https://docs.boat.dev/api-keys",
                configured: true,
                sizes: [
                  { id: "small", label: "Small", detail: "2 vCPU" },
                  { id: "default", label: "Default", detail: "4 vCPU" },
                ],
                capabilities: {
                  limits: true,
                  stopResume: true,
                  credentialEnvironments: false,
                  extend: true,
                  templates: false,
                },
              },
              {
                kind: "vercel",
                label: "Vercel",
                detail: "Firecracker microVMs.",
                apiKeyLabel: "Vercel access token",
                apiKeyPlaceholder: "vcp_...",
                docsUrl: "https://vercel.com/account/settings/tokens",
                configured: true,
                sizes: [{ id: "vercel-2", label: "Small", detail: "2 vCPU" }],
                settingsFields: [
                  { id: "teamId", label: "Team", optional: true },
                  {
                    id: "projectId",
                    label: "Project",
                    placeholder: "t3-sandboxes",
                    optional: true,
                  },
                ],
                settings: { teamId: "", projectId: "saved-project" },
                capabilities: {
                  limits: false,
                  stopResume: true,
                  credentialEnvironments: false,
                  extend: true,
                  templates: false,
                },
              },
            ],
            host: {
              claude: { baseUrl: "https://hub.example.test", key: "hub", privateNetwork: true },
              github: true,
            },
          }
        : atom === "limits"
          ? { limits: mocks.limits }
          : null,
    isPending: false,
    error: null,
    refresh: () => {},
  })) as never,
}));

import { SandboxEnvironmentFields } from "./SandboxEnvironmentFields";

function setup(limits: SandboxProviderLimits) {
  mocks.limits = limits;
  mocks.createSandbox.mockClear();
}

const fields = () => (
  <SandboxEnvironmentFields
    environmentId={EnvironmentId.make("11111111-1111-4111-8111-111111111111")}
    error={null}
    onErrorChange={() => {}}
    onDone={() => {}}
  />
);

describe("SandboxEnvironmentFields", () => {
  it("asks once before a start the provider will charge for", async () => {
    setup({
      canStart: true,
      startCost: "paid",
      startDollars: 0.03,
      starts: [{ window: "hour", limit: 60, used: 60, remaining: 0 }],
    });
    await using _screen = await render(fields());

    await userEvent.click(page.getByRole("button", { name: "Create Boat sandbox" }));
    await expect.element(page.getByText("This start will be charged about $0.03.")).toBeVisible();
    expect(mocks.createSandbox).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: "Create anyway" }));
    expect(mocks.createSandbox).toHaveBeenCalledOnce();
  });

  it("sends the provider's settings fields, starting from the saved values", async () => {
    setup({ canStart: true });
    await using _screen = await render(fields());

    await userEvent.click(page.getByRole("button", { name: /^Vercel/u }));
    await userEvent.click(page.getByRole("button", { name: "Advanced" }));
    await userEvent.fill(page.getByRole("textbox", { name: "Team (optional)" }), "acme");
    await userEvent.click(page.getByRole("button", { name: "Create Vercel sandbox" }));
    expect(mocks.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          provider: "vercel",
          settings: { teamId: "acme", projectId: "saved-project" },
        }),
      }),
    );
  });

  it("disables creating when the provider would refuse the start", async () => {
    setup({
      canStart: false,
      blockedReason: "Your trial has ended.",
      billingUrl: "https://boat.dev/dashboard?tab=billing",
    });
    await using _screen = await render(fields());

    await expect.element(page.getByText("Your trial has ended.", { exact: false })).toBeVisible();
    await expect.element(page.getByRole("link", { name: "Open billing" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Create Boat sandbox" })).toBeDisabled();
  });

  it("sends only the agent access the user opted into, then shows what the sandbox got", async () => {
    setup({ canStart: true });
    const onDone = vi.fn();
    await using _screen = await render(
      <SandboxEnvironmentFields
        environmentId={EnvironmentId.make("11111111-1111-4111-8111-111111111111")}
        error={null}
        onErrorChange={() => {}}
        onDone={onDone}
      />,
    );

    await userEvent.click(page.getByText("Use this machine's Claude setup"));
    const privateWarning = page.getByText(/Resolves to a private address/u);
    await expect.element(privateWarning).toBeVisible();
    await userEvent.fill(
      page.getByRole("textbox", { name: "Claude endpoint" }),
      "https://alt.test",
    );
    // The server only judged its own endpoint, so an edited one drops the warning.
    await expect.element(privateWarning).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Create Boat sandbox" }));
    expect(mocks.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          agentAccess: { claude: { baseUrl: "https://alt.test" } },
        }),
      }),
    );
    expect(mocks.createSandbox).not.toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ passGithubToken: true }) }),
    );

    // The dialog stays open on the checklist until the user is done with it.
    await expect.element(page.getByText("Claude uses this machine's setup")).toBeVisible();
    await expect.element(page.getByText(/Run gh auth login/u)).toBeVisible();
    await expect
      .element(page.getByText("The GitHub CLI could not be installed on the sandbox."))
      .toBeVisible();
    expect(onDone).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledOnce();
  });
});
