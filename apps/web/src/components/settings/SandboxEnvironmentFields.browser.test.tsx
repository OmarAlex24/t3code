import { AsyncResult } from "effect/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  tailscaleClientId: "",
  projects: [] as Array<Record<string, unknown>>,
  saveConfig: vi.fn(async (request: { input: { config: Record<string, unknown> } }) =>
    AsyncResult.success({ config: { id: "config-1", ...request.input.config } }),
  ),
  deleteConfig: vi.fn(async () => AsyncResult.success(undefined)),
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((_environmentId: unknown, select: (settings: unknown) => unknown) =>
    select({
      sandboxTailscale: {
        clientId: mocks.tailscaleClientId,
        clientSecret: mocks.tailscaleClientId === "" ? "" : "••••••",
        tag: "tag:t3-sandbox",
      },
    })) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => mocks.projects) as never,
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
      sandboxesSaveConfig: mocks.saveConfig as never,
      sandboxesDeleteConfig: mocks.deleteConfig as never,
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
                defaultSize: "default",
                capabilities: {
                  limits: true,
                  stopResume: true,
                  credentialEnvironments: false,
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
                sizes: [
                  { id: "vercel-2", label: "Small", detail: "2 vCPU" },
                  { id: "vercel-4", label: "Medium", detail: "4 vCPU" },
                ],
                defaultSize: "vercel-2",
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
                  templates: false,
                },
              },
            ],
            host: {
              claude: { baseUrl: "https://hub.example.test", key: "hub", privateNetwork: true },
              github: true,
            },
          }
        : null,
    isPending: false,
    error: null,
    refresh: () => {},
  })) as never,
}));

import { SandboxEnvironmentFields } from "./SandboxEnvironmentFields";

const HOST = "11111111-1111-4111-8111-111111111111";
const REMOTE = "22222222-2222-4222-8222-222222222222";
const project = (environmentId: string, id: string, remoteUrl: string) => ({
  environmentId,
  id,
  title: id,
  workspaceRoot: `/work/${id}`,
  repositoryIdentity: {
    canonicalKey: remoteUrl,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl },
  },
  scripts: [],
  defaultModelSelection: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

function setup(options: { tailscale?: boolean; projects?: Array<Record<string, unknown>> } = {}) {
  mocks.tailscaleClientId = options.tailscale === true ? "kCLIENT" : "";
  mocks.projects = options.projects ?? [];
  mocks.saveConfig.mockClear();
  mocks.deleteConfig.mockClear();
}

const savedConfig = (request: number = 0) =>
  (mocks.saveConfig.mock.calls[request]![0] as { input: { config: Record<string, unknown> } }).input
    .config;

const fields = (onDone: () => void = () => {}) => (
  <SandboxEnvironmentFields
    environmentId={EnvironmentId.make("11111111-1111-4111-8111-111111111111")}
    error={null}
    onErrorChange={() => {}}
    onDone={onDone}
  />
);

describe("SandboxEnvironmentFields", () => {
  it("saves a config without making a machine, with the running limit it shows", async () => {
    setup();
    const onDone = vi.fn();
    await using _screen = await render(fields(onDone));

    await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Boat small");
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    expect(savedConfig()).toEqual({
      label: "Boat small",
      provider: "boat",
      size: "default",
      passGithubToken: false,
      joinTailnet: false,
      access: "public",
      projectIds: [],
      repositories: [],
      envFiles: {},
      idleMinutes: 30,
      maxRunningMinutes: 480,
    });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("lists every machine's GitHub projects once, by repository, and limits by repository", async () => {
    // The user's projects live on a paired machine; this host has none of its own.
    setup({
      projects: [
        project(REMOTE, "hello", "git@github.com:OmarAlex24/Hello-World.git"),
        project(REMOTE, "hello-copy", "https://github.com/omaralex24/hello-world"),
        project(REMOTE, "api", "https://github.com/OmarAlex24/api.git"),
        project(REMOTE, "lab", "https://gitlab.com/omar/lab.git"),
      ],
    });
    await using _screen = await render(fields());

    await expect.element(page.getByText("OmarAlex24/Hello-World")).toBeVisible();
    await expect.element(page.getByText("OmarAlex24/api")).toBeVisible();
    await expect.element(page.getByText(/gitlab|omar\/lab/u)).not.toBeInTheDocument();
    expect(page.getByRole("checkbox", { name: /Hello-World/u }).elements()).toHaveLength(1);

    await userEvent.click(page.getByText("OmarAlex24/Hello-World"));
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    expect(savedConfig()).toMatchObject({
      projectIds: [],
      repositories: ["omaralex24/hello-world"],
    });
  });

  it("opens a config saved with host project ids as their repositories", async () => {
    setup({ projects: [project(HOST, "hello-host", "https://github.com/octo/hello.git")] });
    await using _screen = await render(
      <SandboxEnvironmentFields
        environmentId={EnvironmentId.make(HOST)}
        config={{
          id: "config-1",
          label: "Boat small",
          provider: "boat",
          size: "small",
          passGithubToken: false,
          joinTailnet: false,
          access: "public",
          projectIds: ["hello-host" as never],
          envFiles: { "hello-host": [".env.local"] },
          idleMinutes: 30,
          maxRunningMinutes: 240,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        }}
        error={null}
        onErrorChange={() => {}}
        onDone={() => {}}
      />,
    );

    await expect.element(page.getByRole("checkbox", { name: "octo/hello" })).toBeChecked();
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    expect(savedConfig()).toMatchObject({
      projectIds: [],
      repositories: ["octo/hello"],
      envFiles: { "octo/hello": [".env.local"] },
    });
  });

  it("sends the provider's settings fields, starting from the saved values", async () => {
    setup();
    await using _screen = await render(fields());

    await userEvent.click(page.getByRole("button", { name: /^Vercel/u }));
    await userEvent.click(page.getByRole("button", { name: "Advanced" }));
    await userEvent.fill(page.getByRole("textbox", { name: "Team (optional)" }), "acme");
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    expect(mocks.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          config: expect.objectContaining({ provider: "vercel", size: "vercel-2" }),
          settings: { teamId: "acme", projectId: "saved-project" },
        }),
      }),
    );
  });

  it("saves only the agent access the user opted into", async () => {
    setup();
    await using _screen = await render(fields());

    await userEvent.click(page.getByText("Use this machine's Claude setup"));
    const privateWarning = page.getByText(/Resolves to a private address/u);
    await expect.element(privateWarning).toBeVisible();
    await userEvent.fill(
      page.getByRole("textbox", { name: "Claude endpoint" }),
      "https://alt.test",
    );
    // The server only judged its own endpoint, so an edited one drops the warning.
    await expect.element(privateWarning).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    expect(savedConfig()).toMatchObject({
      claude: { baseUrl: "https://alt.test" },
      passGithubToken: false,
    });
  });

  it("joins the tailnet by default when Claude's endpoint is private, and can stay off the internet", async () => {
    setup({ tailscale: true });
    await using _screen = await render(fields());

    const join = page.getByRole("checkbox", { name: /Join my tailnet/u });
    await expect.element(join).toBeChecked();
    await expect.element(page.getByText(/reached through your tailnet/u)).toBeVisible();
    // Opting out brings the warning back.
    await userEvent.click(page.getByText("Join my tailnet"));
    await expect.element(page.getByText(/unless it joins your tailnet/u)).toBeVisible();
    await userEvent.click(page.getByText("Join my tailnet"));
    await userEvent.click(page.getByText("Reach it only through my tailnet"));
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    expect(savedConfig()).toMatchObject({ joinTailnet: true, access: "tailnet" });
  });

  it("edits a saved config in place and deletes it after a confirmation", async () => {
    setup();
    const onDone = vi.fn();
    await using _screen = await render(
      <SandboxEnvironmentFields
        environmentId={EnvironmentId.make("11111111-1111-4111-8111-111111111111")}
        config={{
          id: "config-1",
          label: "Boat small",
          provider: "boat",
          size: "small",
          passGithubToken: false,
          joinTailnet: false,
          access: "public",
          projectIds: [],
          envFiles: {},
          idleMinutes: 30,
          maxRunningMinutes: 240,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        }}
        error={null}
        onErrorChange={() => {}}
        onDone={onDone}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    expect(savedConfig()).toMatchObject({ id: "config-1", size: "small", maxRunningMinutes: 240 });

    await userEvent.click(page.getByRole("button", { name: "Delete…" }));
    expect(mocks.deleteConfig).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Delete config" }));
    expect(mocks.deleteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ input: { configId: "config-1" } }),
    );
    expect(onDone).toHaveBeenCalledTimes(2);
  });
});
