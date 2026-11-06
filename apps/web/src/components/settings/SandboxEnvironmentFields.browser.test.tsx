import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, type SandboxEnvironmentConfig } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  tailscaleClientId: "",
  host: {} as Record<string, unknown>,
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
                  agentProviderAccess: true,
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
                  agentProviderAccess: false,
                  templates: false,
                },
              },
            ],
            host: {
              claude: { baseUrl: "https://hub.example.test", key: "hub", privateNetwork: true },
              github: true,
              ...mocks.host,
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

function setup(
  options: {
    tailscale?: boolean;
    projects?: Array<Record<string, unknown>>;
    host?: Record<string, unknown>;
  } = {},
) {
  mocks.tailscaleClientId = options.tailscale === true ? "kCLIENT" : "";
  mocks.host = options.host ?? {};
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

const saved = (overrides: Partial<SandboxEnvironmentConfig> = {}): SandboxEnvironmentConfig => ({
  id: "config-1",
  label: "Boat small",
  provider: "boat",
  size: "small",
  passGithubToken: false,
  joinTailnet: false,
  access: "public",
  envFiles: {},
  idleMinutes: 30,
  maxRunningMinutes: 240,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

const editing = (
  config: SandboxEnvironmentConfig,
  onErrorChange: (error: string | null) => void = () => {},
) => (
  <SandboxEnvironmentFields
    environmentId={EnvironmentId.make(HOST)}
    config={config}
    error={null}
    onErrorChange={onErrorChange}
    onDone={() => {}}
  />
);

const TOOLING_HOST = {
  githubApp: { slug: "t3-code-sandboxes", owner: "OmarAlex24" },
  northflank: true,
  maple: true,
  tooling: {
    gitIdentity: { name: "Omar", email: "omar@example.test" },
    claudeMd: true,
    skills: [
      { name: "frontend-design", bytes: 12_000, copyable: true },
      { name: "synced", bytes: 30_000_000, copyable: false },
    ],
    mcpServers: [
      {
        name: "docs",
        scope: "project",
        transport: "http",
        host: "docs.example.test",
        headerNames: ["X-Key"],
        copy: "copy",
      },
      {
        name: "maple",
        scope: "user",
        transport: "http",
        host: "api.maple.dev",
        headerNames: [],
        copy: "mint",
      },
      {
        name: "railway",
        scope: "user",
        transport: "stdio",
        headerNames: [],
        copy: "unavailable",
        reason: "Runs a program on this machine, so it can't be copied.",
      },
    ],
  },
};

const advanced = () => page.getByRole("button", { name: "Advanced" });
const summary = () => page.getByTestId("sandbox-config-summary");

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
      envFiles: {},
      idleMinutes: 30,
      maxRunningMinutes: 480,
    });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("shows the name, the machine and a summary, with the rest under a closed Advanced", async () => {
    setup({
      projects: [project(REMOTE, "hello", "git@github.com:OmarAlex24/Hello-World.git")],
    });
    await using _screen = await render(fields());

    await expect.element(page.getByRole("textbox", { name: "Name" })).toBeVisible();
    await expect
      .element(page.getByRole("combobox", { name: "Sandbox machine size" }))
      .toBeVisible();
    await expect.element(summary()).toHaveTextContent("Shares nothing from this machine");
    await expect.element(advanced()).toHaveAttribute("aria-expanded", "false");
    await expect.element(page.getByText("Use this machine's Claude setup")).not.toBeInTheDocument();
    await expect.element(page.getByText("When a chat is settled")).not.toBeInTheDocument();
    // Every GitHub project can start on every config, so there is nothing to pick.
    await expect.element(page.getByText("Projects", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("OmarAlex24/Hello-World")).not.toBeInTheDocument();

    await userEvent.click(advanced());
    await expect.element(page.getByText("Use this machine's Claude setup")).toBeVisible();
    await expect.element(page.getByText("When a chat is settled")).toBeVisible();
    await expect.element(page.getByText("Projects", { exact: true })).not.toBeInTheDocument();
  });

  it("sums up what a saved config's sandboxes get from this machine", async () => {
    setup({ tailscale: true });
    await using _screen = await render(
      editing(
        saved({
          claude: { baseUrl: "https://hub.example.test" },
          passGithubToken: true,
          agentProviderAccess: true,
          onSettle: "snapshot",
        }),
      ),
    );

    await expect
      .element(summary())
      .toHaveTextContent(
        "Claude via hub.example.test · joins your tailnet · GitHub signed in with this machine's token · agent can use Boat · keeps a snapshot when settled",
      );
    await expect.element(advanced()).toHaveAttribute("aria-expanded", "false");
  });

  it("opens Advanced and says why when a private Claude endpoint has no Tailscale", async () => {
    setup();
    await using _screen = await render(
      editing(saved({ claude: { baseUrl: "https://hub.example.test" } })),
    );

    await expect
      .element(summary())
      .toHaveTextContent(
        "hub.example.test is private, so sandboxes need Tailscale to reach Claude",
      );
    await expect.element(advanced()).toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByText(/Resolves to a private address/u)).toBeVisible();
    // It stays the user's to close.
    await userEvent.click(advanced());
    await expect.element(advanced()).toHaveAttribute("aria-expanded", "false");
  });

  it("names a field under Advanced that needs input even after Advanced closes", async () => {
    setup({ tailscale: true });
    await using _screen = await render(
      editing(saved({ claude: { baseUrl: "https://hub.example.test" } })),
    );

    await userEvent.click(advanced());
    await userEvent.fill(page.getByRole("textbox", { name: "Claude endpoint" }), "");
    await expect.element(summary()).toHaveTextContent("Enter a Claude endpoint");
    await userEvent.click(advanced());
    await expect.element(advanced()).toHaveAttribute("aria-expanded", "false");
    await expect.element(summary()).toHaveTextContent("Enter a Claude endpoint");
    await expect.element(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("opens Advanced when saving fails", async () => {
    setup();
    mocks.saveConfig.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(new Error("A tailnet-only sandbox has to join your tailnet.")),
      ) as never,
    );
    const onErrorChange = vi.fn();
    await using _screen = await render(editing(saved(), onErrorChange));

    await expect.element(advanced()).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    expect(onErrorChange).toHaveBeenLastCalledWith(
      "A tailnet-only sandbox has to join your tailnet.",
    );
    await expect.element(advanced()).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps a saved config's env files and drops the repositories it was once limited to", async () => {
    setup({ projects: [project(HOST, "hello-host", "https://github.com/octo/hello.git")] });
    // Saved when a config could be limited to some repositories; those fields no longer exist.
    const legacy = {
      ...saved({ envFiles: { "octo/hello": [".env.local"] } }),
      projectIds: ["hello-host"],
      repositories: ["octo/hello"],
    } as SandboxEnvironmentConfig;
    await using _screen = await render(editing(legacy));

    await userEvent.click(advanced());
    await expect.element(page.getByText("Projects", { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("textbox", { name: "octo/hello" }))
      .toHaveValue(".env.local");
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    const config = savedConfig();
    expect(config).toMatchObject({ envFiles: { "octo/hello": [".env.local"] } });
    expect(config).not.toHaveProperty("projectIds");
    expect(config).not.toHaveProperty("repositories");
  });

  it("sends the provider's settings fields, starting from the saved values", async () => {
    setup();
    await using _screen = await render(fields());

    await userEvent.click(page.getByRole("button", { name: /^Vercel/u }));
    await userEvent.click(advanced());
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

    await userEvent.click(advanced());
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

  it("lets the agent use Boat only when asked, and only where the provider can", async () => {
    setup();
    await using _screen = await render(fields());

    await userEvent.click(advanced());
    await expect
      .element(page.getByText(/delete only the forks it made. Forks bill like new sandboxes./u))
      .toBeVisible();
    await userEvent.click(page.getByText("Let the agent use Boat"));
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    expect(savedConfig()).toMatchObject({ agentProviderAccess: true });

    // Vercel cannot scope a key to one sandbox, so it offers nothing.
    await userEvent.click(page.getByRole("button", { name: /^Vercel/u }));
    await expect.element(page.getByText(/Let the agent use/u)).not.toBeInTheDocument();
  });

  it("joins the tailnet on its own when Claude's endpoint is private", async () => {
    setup({ tailscale: true });
    await using _screen = await render(fields());

    await userEvent.click(advanced());
    await userEvent.click(page.getByText("Use this machine's Claude setup"));
    // Decided at each launch, so there is nothing to tick.
    await expect
      .element(
        page.getByText("Joins your tailnet automatically because hub.example.test is private."),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("checkbox", { name: /Join my tailnet/u }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    // Stored off means automatic: the launch joins while the endpoint stays private.
    expect(savedConfig()).toMatchObject({ joinTailnet: false, access: "public" });
  });

  it("can keep a sandbox that joins on its own off the internet", async () => {
    setup({ tailscale: true });
    await using _screen = await render(fields());

    await userEvent.click(advanced());
    await userEvent.click(page.getByText("Use this machine's Claude setup"));
    await userEvent.click(page.getByText("Reach it only through my tailnet"));
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    expect(savedConfig()).toMatchObject({ joinTailnet: true, access: "tailnet" });
  });

  it("offers to join the tailnet when Claude's endpoint is not a private one", async () => {
    setup({ tailscale: true });
    await using _screen = await render(fields());

    await userEvent.click(advanced());
    const join = page.getByRole("checkbox", { name: /Join my tailnet/u });
    await expect.element(join).not.toBeChecked();
    await userEvent.click(page.getByText("Join my tailnet"));
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    expect(savedConfig()).toMatchObject({ joinTailnet: true, access: "public" });
  });

  it("edits a saved config in place and deletes it after a confirmation", async () => {
    setup();
    const onDone = vi.fn();
    await using _screen = await render(
      <SandboxEnvironmentFields
        environmentId={EnvironmentId.make("11111111-1111-4111-8111-111111111111")}
        config={saved()}
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
  it("gives a new config the GitHub App, git identity, tools, MCP servers and Claude files", async () => {
    setup({ host: TOOLING_HOST });
    await using _screen = await render(fields());

    // The GitHub App and CLAUDE.md are on by default once this machine has them.
    await expect.element(summary()).toHaveTextContent("GitHub signed in · copies CLAUDE.md");
    await userEvent.click(advanced());
    await expect
      .element(page.getByRole("combobox", { name: "GitHub sign-in" }))
      .toHaveTextContent("GitHub App (recommended)");
    await expect
      .element(page.getByRole("textbox", { name: "Git name" }))
      .toHaveAttribute("placeholder", "Omar");
    await expect.element(page.getByRole("checkbox", { name: /railway/u })).toBeDisabled();
    await expect
      .element(page.getByText("Runs a program on this machine, so it can't be copied."))
      .toBeVisible();
    await expect
      .element(page.getByText(/Copies this machine's X-Key header. Deleting the sandbox/u))
      .toBeVisible();
    await expect.element(page.getByRole("checkbox", { name: /synced/u })).toBeDisabled();

    await userEvent.fill(
      page.getByRole("textbox", { name: "Tools to install" }),
      "command -v psql || sudo apt-get install -y postgresql-client",
    );
    await userEvent.click(page.getByText("Sign the Northflank CLI in"));
    await userEvent.click(page.getByText("docs", { exact: true }));
    await userEvent.click(page.getByText("maple", { exact: true }));
    await userEvent.click(page.getByText("frontend-design", { exact: true }));
    await expect
      .element(summary())
      .toHaveTextContent(
        "GitHub signed in · runs your setup script · Northflank signed in · 2 MCP servers · copies CLAUDE.md and 1 skill",
      );
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    expect(savedConfig()).toMatchObject({
      passGithubToken: false,
      githubApp: true,
      setupScript: "command -v psql || sudo apt-get install -y postgresql-client",
      northflank: true,
      mcpServers: ["docs", "maple"],
      claudeMd: true,
      skills: ["frontend-design"],
    });
    expect(savedConfig()).not.toHaveProperty("gitIdentity");
  });

  it("keeps a saved config's tooling, and asks for both parts of a git identity", async () => {
    setup({ host: TOOLING_HOST });
    await using _screen = await render(
      editing(
        saved({
          passGithubToken: true,
          mcpServers: ["docs"],
          skills: ["frontend-design"],
          setupScript: "make tools",
        }),
      ),
    );

    await userEvent.click(advanced());
    await expect
      .element(page.getByRole("combobox", { name: "GitHub sign-in" }))
      .toHaveTextContent("This machine's token (legacy)");
    await expect.element(page.getByRole("checkbox", { name: /Your CLAUDE.md/u })).not.toBeChecked();
    await userEvent.fill(page.getByRole("textbox", { name: "Git name" }), "Sandbox Bot");
    await expect
      .element(summary())
      .toHaveTextContent("Enter both a git name and email, or leave both empty");
    await expect.element(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await userEvent.fill(page.getByRole("textbox", { name: "Git email" }), "bot@example.test");
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    const config = savedConfig();
    expect(config).toMatchObject({
      passGithubToken: true,
      gitIdentity: { name: "Sandbox Bot", email: "bot@example.test" },
      setupScript: "make tools",
      mcpServers: ["docs"],
      skills: ["frontend-design"],
    });
    expect(config).not.toHaveProperty("githubApp");
    expect(config).not.toHaveProperty("claudeMd");
  });

  it("asks to connect the GitHub App before a config can use it", async () => {
    setup();
    await using _screen = await render(fields());

    await userEvent.click(advanced());
    await userEvent.click(page.getByRole("combobox", { name: "GitHub sign-in" }));
    await userEvent.click(page.getByRole("option", { name: "GitHub App (recommended)" }));
    await expect
      .element(summary())
      .toHaveTextContent("Connect the GitHub App under Sandboxes, or pick another GitHub option");
    await expect.element(page.getByText(/The GitHub App isn't connected yet./u)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Add sandbox config" })).toBeDisabled();
    await expect
      .element(page.getByRole("checkbox", { name: /Sign the Northflank CLI in/u }))
      .toBeDisabled();
  });
});
