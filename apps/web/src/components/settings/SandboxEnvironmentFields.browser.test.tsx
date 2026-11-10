import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, type SandboxEnvironmentConfig } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  tailscaleClientId: "",
  /** Whether Boat says its sandboxes keep themselves up while they work. */
  keepAlive: false,
  host: {} as Record<string, unknown>,
  projects: [] as Array<Record<string, unknown>>,
  saveConfig: vi.fn(async (request: { input: { config: Record<string, unknown> } }) =>
    AsyncResult.success({ config: { id: "config-1", ...request.input.config } }),
  ),
  deleteConfig: vi.fn(async () => AsyncResult.success(undefined)),
  refreshProviders: vi.fn(() => {}),
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
                  keepAlive: mocks.keepAlive,
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
    refresh: atom === "providers" ? mocks.refreshProviders : () => {},
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
    keepAlive?: boolean;
  } = {},
) {
  mocks.tailscaleClientId = options.tailscale === true ? "kCLIENT" : "";
  mocks.keepAlive = options.keepAlive ?? false;
  mocks.host = options.host ?? {};
  mocks.projects = options.projects ?? [];
  mocks.saveConfig.mockClear();
  mocks.deleteConfig.mockClear();
  mocks.refreshProviders.mockClear();
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

const section = (name: "Machine" | "Agent access" | "Setup") =>
  page.getByRole("button", { name, exact: true });
const summary = (id: "machine" | "agent" | "setup") =>
  page.getByTestId(`sandbox-config-summary-${id}`);
const attention = () => page.getByTestId("sandbox-config-attention");
const access = (name: string) => page.getByRole("switch", { name, exact: true });
const mcpServers = () => page.getByRole("button", { name: /^MCP servers/u });

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

  it("shows the name and the machine, with the rest in closed sections that sum it up", async () => {
    setup({
      projects: [project(REMOTE, "hello", "git@github.com:OmarAlex24/Hello-World.git")],
    });
    await using _screen = await render(fields());

    await expect.element(page.getByRole("textbox", { name: "Name" })).toBeVisible();
    await expect
      .element(page.getByRole("combobox", { name: "Sandbox machine size" }))
      .toBeVisible();
    await expect.element(summary("machine")).toHaveTextContent("Stops after 8 h running");
    await expect.element(summary("agent")).toHaveTextContent("Nothing from this machine");
    await expect.element(summary("setup")).toHaveTextContent("Copies env files only");
    for (const name of ["Machine", "Agent access", "Setup"] as const) {
      await expect.element(section(name)).toHaveAttribute("aria-expanded", "false");
    }
    await expect.element(access("Claude")).not.toBeInTheDocument();
    await expect.element(page.getByText("When a chat is settled")).not.toBeInTheDocument();
    // Every GitHub project can start on every config, so there is nothing to pick.
    await expect.element(page.getByText("Projects", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("OmarAlex24/Hello-World")).not.toBeInTheDocument();

    await userEvent.click(section("Agent access"));
    await expect.element(access("Claude")).toBeVisible();
    await expect.element(page.getByText("When a chat is settled")).not.toBeInTheDocument();
    // One section at a time: opening Machine closes Agent access.
    await userEvent.click(section("Machine"));
    await expect.element(page.getByText("When a chat is settled")).toBeVisible();
    await expect.element(section("Agent access")).toHaveAttribute("aria-expanded", "false");
    await expect.element(access("Claude")).not.toBeInTheDocument();
    // A provider that cannot keep a sandbox up while it works has only the running limit.
    await expect.element(page.getByText("Stop when idle")).not.toBeInTheDocument();
    await expect.element(page.getByText("Projects", { exact: true })).not.toBeInTheDocument();
  });

  it("stops a sandbox that keeps itself up when idle, with an optional hard limit", async () => {
    setup({ keepAlive: true });
    await using _screen = await render(editing(saved({ idleMinutes: 45 })));

    await expect.element(summary("machine")).toHaveTextContent("Stops after 45 min without work");
    await userEvent.click(section("Machine"));
    await expect.element(page.getByText("Running limit")).not.toBeInTheDocument();
    await userEvent.fill(page.getByRole("textbox", { name: "Stop when idle in minutes" }), "60");
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    // No hard limit until asked for: it runs as long as its threads work.
    expect(savedConfig()).toMatchObject({ idleMinutes: 60, maxRunningMinutes: 240 });
    expect(savedConfig()).not.toHaveProperty("runningCapMinutes");

    await userEvent.click(page.getByRole("checkbox", { name: /Hard limit/u }));
    await expect
      .element(summary("machine"))
      .toHaveTextContent("Stops after 1 h without work · at most 4 h running");
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    expect(savedConfig(1)).toMatchObject({ idleMinutes: 60, runningCapMinutes: 240 });
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
      .element(summary("machine"))
      .toHaveTextContent(
        "Stops after 4 h running · joins your tailnet · keeps a snapshot when settled",
      );
    await expect
      .element(summary("agent"))
      .toHaveTextContent(
        "Claude via hub.example.test · GitHub signed in with this machine's token · agent can use Boat",
      );
    await expect.element(section("Agent access")).toHaveAttribute("aria-expanded", "false");
  });

  it("opens Agent access and says why when a private Claude endpoint has no Tailscale", async () => {
    setup();
    await using _screen = await render(
      editing(saved({ claude: { baseUrl: "https://hub.example.test" } })),
    );

    await expect
      .element(summary("agent"))
      .toHaveTextContent(
        "hub.example.test is private, so sandboxes need Tailscale to reach Claude",
      );
    await expect.element(section("Agent access")).toHaveAttribute("aria-expanded", "true");
    await expect.element(section("Machine")).toHaveAttribute("aria-expanded", "false");
    await expect.element(page.getByText(/Resolves to a private address/u)).toBeVisible();
    // It stays the user's to close.
    await userEvent.click(section("Agent access"));
    await expect.element(section("Agent access")).toHaveAttribute("aria-expanded", "false");
  });

  it("names a field that needs input even after its section closes", async () => {
    setup({ tailscale: true });
    await using _screen = await render(
      editing(saved({ claude: { baseUrl: "https://hub.example.test" } })),
    );

    await userEvent.click(section("Agent access"));
    // The server's endpoint is the usual answer, so the field waits behind Edit.
    await expect
      .element(page.getByRole("textbox", { name: "Claude endpoint" }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Edit Claude endpoint" }));
    await userEvent.fill(page.getByRole("textbox", { name: "Claude endpoint" }), "");
    await expect.element(summary("agent")).toHaveTextContent("Enter a Claude endpoint");
    await userEvent.click(section("Agent access"));
    await expect.element(section("Agent access")).toHaveAttribute("aria-expanded", "false");
    await expect.element(summary("agent")).toHaveTextContent("Enter a Claude endpoint");
    await expect
      .element(attention())
      .toHaveTextContent("Enter a Claude endpoint, under Agent access.");
    await expect.element(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("reports a failed save and keeps a single section open", async () => {
    setup();
    mocks.saveConfig.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(new Error("A tailnet-only sandbox has to join your tailnet.")),
      ) as never,
    );
    const onErrorChange = vi.fn();
    await using _screen = await render(editing(saved(), onErrorChange));

    await userEvent.click(section("Machine"));
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    expect(onErrorChange).toHaveBeenLastCalledWith(
      "A tailnet-only sandbox has to join your tailnet.",
    );
    await expect.element(section("Machine")).toHaveAttribute("aria-expanded", "true");
    for (const name of ["Agent access", "Setup"] as const) {
      await expect.element(section(name)).toHaveAttribute("aria-expanded", "false");
    }
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

    await expect.element(summary("setup")).toHaveTextContent("Picked env files for 1 repository");
    await userEvent.click(section("Setup"));
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
    await userEvent.click(section("Machine"));
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

    await userEvent.click(section("Agent access"));
    await userEvent.click(access("Claude"));
    const privateWarning = page.getByText(/Resolves to a private address/u);
    await expect.element(privateWarning).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Edit Claude endpoint" }));
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

  it("offers Pi only on a hub key for Claude, and saves the model new chats start on", async () => {
    setup({
      host: {
        claude: { baseUrl: "https://hub.example.test", key: "hub", privateNetwork: false },
        piModels: ["wafer/GLM-5.3", "wafer/GLM-5.3-Flash"],
      },
    });
    await using _screen = await render(fields());

    await userEvent.click(section("Agent access"));
    const pi = access("Pi");
    // Pi runs on the key the sandbox gets for Claude, so it waits for Claude.
    await expect.element(pi).toBeDisabled();
    await expect.element(pi).toHaveAccessibleDescription(/Turn on Claude first/u);
    await userEvent.click(access("Claude"));
    await userEvent.click(pi);
    await userEvent.click(page.getByRole("combobox", { name: "Start new chats on" }));
    await userEvent.click(page.getByRole("option", { name: "Pi · wafer/GLM-5.3-Flash" }));
    await expect
      .element(summary("agent"))
      .toHaveTextContent(
        "Claude via hub.example.test · Pi with hub models, new chats on wafer/GLM-5.3-Flash",
      );
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    expect(savedConfig()).toMatchObject({
      claude: { baseUrl: "https://hub.example.test" },
      pi: { startModel: "wafer/GLM-5.3-Flash" },
    });

    // Turning Claude off takes Pi with it.
    await userEvent.click(access("Claude"));
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    expect(savedConfig(1)).not.toHaveProperty("pi");
  });

  it("explains that Pi needs a hub when Claude's token is copied", async () => {
    setup({
      host: {
        claude: { baseUrl: "https://claude.example.test", key: "copy", privateNetwork: false },
      },
    });
    await using _screen = await render(
      editing(saved({ claude: { baseUrl: "https://claude.example.test" }, pi: {} })),
    );

    await userEvent.click(section("Agent access"));
    // Shown only because the config asks for Pi, so it can be dropped.
    await expect.element(access("Pi")).toBeDisabled();
    await expect
      .element(page.getByText(/on a CLIProxyAPI hub with a management key/u))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    expect(savedConfig()).not.toHaveProperty("pi");
  });

  it("lets the agent use Boat only when asked, and only where the provider can", async () => {
    setup();
    await using _screen = await render(fields());

    await userEvent.click(section("Agent access"));
    await userEvent.click(page.getByRole("button", { name: "Advanced" }));
    await expect
      .element(page.getByText(/delete only the forks it made. Forks bill like new sandboxes./u))
      .toBeVisible();
    await userEvent.click(page.getByText("Let the agent use Boat"));
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    expect(savedConfig()).toMatchObject({ agentProviderAccess: true });

    // Vercel cannot scope a key to one sandbox, so it offers nothing.
    await userEvent.click(page.getByRole("button", { name: /^Vercel/u }));
    await expect.element(page.getByText(/Let the agent use/u)).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Advanced" })).not.toBeInTheDocument();
  });

  it("joins the tailnet on its own when Claude's endpoint is private", async () => {
    setup({ tailscale: true });
    await using _screen = await render(fields());

    await userEvent.click(section("Agent access"));
    await userEvent.click(access("Claude"));
    await userEvent.click(section("Machine"));
    // Decided at each launch, so there is nothing to tick.
    await expect
      .element(
        page.getByText("Joins your tailnet automatically because hub.example.test is private."),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("checkbox", { name: /Join my tailnet/u }))
      .not.toBeInTheDocument();
    // A new config is never made tailnet-only.
    await expect
      .element(page.getByText("Reach it only through my tailnet"))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    // Stored off means automatic: the launch joins while the endpoint stays private.
    expect(savedConfig()).toMatchObject({ joinTailnet: false, access: "public" });
  });

  it("keeps a tailnet-only config's setting, and can turn it off", async () => {
    setup({ tailscale: true });
    await using _screen = await render(editing(saved({ joinTailnet: true, access: "tailnet" })));

    await expect
      .element(summary("machine"))
      .toHaveTextContent("Stops after 4 h running · reached only through your tailnet");
    await userEvent.click(section("Machine"));
    const tailnetOnly = page.getByRole("checkbox", { name: /Reach it only through my tailnet/u });
    await expect.element(tailnetOnly).toBeChecked();
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    expect(savedConfig()).toMatchObject({ joinTailnet: true, access: "tailnet" });

    await userEvent.click(tailnetOnly);
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    expect(savedConfig(1)).toMatchObject({ joinTailnet: true, access: "public" });
  });

  it("offers to join the tailnet when Claude's endpoint is not a private one", async () => {
    setup({ tailscale: true });
    await using _screen = await render(fields());

    await userEvent.click(section("Machine"));
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

    await userEvent.click(page.getByRole("button", { name: "Delete config…" }));
    expect(mocks.deleteConfig).not.toHaveBeenCalled();
    await expect
      .element(
        page
          .getByRole("group", { name: "Delete this config" })
          .getByText(
            "Delete Boat small? Sandboxes already made from it keep running until you delete them.",
          ),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Save changes" }))
      .not.toBeInTheDocument();
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
    await expect.element(summary("agent")).toHaveTextContent("GitHub signed in");
    await expect.element(summary("setup")).toHaveTextContent("Copies CLAUDE.md");
    await userEvent.click(section("Agent access"));
    await expect
      .element(page.getByRole("combobox", { name: "GitHub sign-in" }))
      .toHaveTextContent("GitHub App (recommended)");
    await expect
      .element(page.getByRole("textbox", { name: "Git name" }))
      .toHaveAttribute("placeholder", "Omar");
    // This machine has no Railway token, so there is no Railway switch.
    await expect.element(access("Railway")).not.toBeInTheDocument();
    // Folded to one line that counts what is copied.
    await expect.element(mcpServers()).toHaveTextContent("MCP servers0 of 3");
    await expect.element(page.getByRole("checkbox", { name: /railway/u })).not.toBeInTheDocument();
    await userEvent.click(mcpServers());
    // One line each; what happens to a server's credentials shows on hover.
    await expect.element(page.getByRole("checkbox", { name: /railway/u })).toBeDisabled();
    await expect.element(page.getByText("can't be copied")).toBeVisible();
    await expect
      .element(page.getByRole("checkbox", { name: /railway/u }))
      .toHaveAccessibleDescription("Runs a program on this machine, so it can't be copied.");
    const docs = page.getByRole("checkbox", { name: /^docs/u });
    await expect.element(page.getByText("copies X-Key")).toBeVisible();
    await expect
      .element(docs)
      .toHaveAccessibleDescription(
        "docs.example.test. Copies this machine's X-Key header. Deleting the sandbox doesn't revoke it.",
      );
    // A hover while the list is still unfolding never reaches the tooltip.
    await vi.waitFor(() => expect(document.getAnimations()).toHaveLength(0));
    await userEvent.hover(page.getByText("copies X-Key"));
    await expect
      .poll(() => document.querySelector('[data-slot="tooltip-popup"]')?.textContent)
      .toBe(
        "docs.example.test. Copies this machine's X-Key header. Deleting the sandbox doesn't revoke it.",
      );
    await userEvent.click(access("Northflank"));
    await userEvent.click(page.getByText("docs", { exact: true }));
    await userEvent.click(page.getByText("maple", { exact: true }));
    await expect.element(mcpServers()).toHaveTextContent("MCP servers2 of 3");

    await userEvent.click(section("Setup"));
    await expect.element(page.getByRole("checkbox", { name: /synced/u })).toBeDisabled();
    await expect.element(page.getByText("too large to copy")).toBeVisible();
    await userEvent.fill(
      page.getByRole("textbox", { name: "Tools to install" }),
      "command -v psql || sudo apt-get install -y postgresql-client",
    );
    await userEvent.click(page.getByText("frontend-design", { exact: true }));
    await expect
      .element(summary("agent"))
      .toHaveTextContent("GitHub signed in · Northflank signed in · 2 MCP servers");
    await expect
      .element(summary("setup"))
      .toHaveTextContent("Runs your setup script · copies CLAUDE.md and 1 skill");
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

    await userEvent.click(section("Setup"));
    await expect.element(page.getByRole("checkbox", { name: /Your CLAUDE.md/u })).not.toBeChecked();
    await userEvent.click(section("Agent access"));
    await expect
      .element(page.getByRole("combobox", { name: "GitHub sign-in" }))
      .toHaveTextContent("This machine's token (legacy)");
    await userEvent.fill(page.getByRole("textbox", { name: "Git name" }), "Sandbox Bot");
    await expect
      .element(attention())
      .toHaveTextContent(
        "Enter both a git name and email, or leave both empty, under Agent access.",
      );
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

  it("reads the server's credentials afresh when opened, and follows them while open", async () => {
    setup();
    await using screen = await render(fields());
    expect(mocks.refreshProviders).toHaveBeenCalledOnce();

    await userEvent.click(section("Agent access"));
    await userEvent.click(access("GitHub"));
    await userEvent.click(page.getByRole("combobox", { name: "GitHub sign-in" }));
    await userEvent.click(page.getByRole("option", { name: "GitHub App (recommended)" }));
    await expect.element(page.getByText(/The GitHub App isn't connected yet./u)).toBeVisible();
    await expect.element(access("Northflank")).not.toBeInTheDocument();

    // The app and the Northflank token were saved under Sandboxes meanwhile.
    mocks.host = TOOLING_HOST;
    await screen.rerender(fields());
    await expect
      .element(page.getByText(/The GitHub App isn't connected yet./u))
      .not.toBeInTheDocument();
    await expect.element(attention()).not.toBeInTheDocument();
    await expect.element(access("Northflank")).toBeEnabled();
    expect(mocks.refreshProviders).toHaveBeenCalledOnce();
  });

  it("asks to connect the GitHub App before a config can use it", async () => {
    setup();
    await using _screen = await render(fields());

    await userEvent.click(section("Agent access"));
    // This machine has only its own token, so turning GitHub on starts there.
    await userEvent.click(access("GitHub"));
    await expect
      .element(page.getByRole("combobox", { name: "GitHub sign-in" }))
      .toHaveTextContent("This machine's token (legacy)");
    await userEvent.click(page.getByRole("combobox", { name: "GitHub sign-in" }));
    await userEvent.click(page.getByRole("option", { name: "GitHub App (recommended)" }));
    await expect
      .element(summary("agent"))
      .toHaveTextContent("Connect the GitHub App under Sandboxes, or pick another GitHub option");
    await expect.element(page.getByText(/The GitHub App isn't connected yet./u)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Add sandbox config" })).toBeDisabled();
    // Without a token on this machine there is nothing to switch on.
    await expect.element(access("Northflank")).not.toBeInTheDocument();
    await expect.element(access("Railway")).not.toBeInTheDocument();
  });

  it("gives Railway's MCP server the sandbox's own token only with Railway turned on", async () => {
    setup({
      host: {
        ...TOOLING_HOST,
        railway: true,
        tooling: {
          ...TOOLING_HOST.tooling,
          mcpServers: [
            {
              name: "railway",
              scope: "user",
              transport: "stdio",
              headerNames: [],
              copy: "mint",
              mintedBy: "railway",
              reason:
                "Runs the Railway CLI on the sandbox with a token of its own, revoked when the sandbox is deleted.",
            },
          ],
        },
      },
    });
    await using _screen = await render(fields());
    await userEvent.click(section("Agent access"));
    await userEvent.click(mcpServers());

    const mcp = page.getByRole("checkbox", { name: /^railway/u });
    await expect.element(mcp).toBeDisabled();
    await expect.element(page.getByText("turn on Railway above")).toBeVisible();

    await userEvent.click(access("Railway"));
    await expect.element(mcp).toBeEnabled();
    await expect
      .element(mcp)
      .toHaveAccessibleDescription(
        "Runs the Railway CLI on the sandbox with a token of its own, revoked when the sandbox is deleted.",
      );
    await userEvent.click(page.getByText("railway", { exact: true }));
    await expect
      .element(summary("agent"))
      .toHaveTextContent("GitHub signed in · Railway signed in · 1 MCP server");

    // Without Railway there is no token for it to sign in with, so it does not go either.
    await userEvent.click(access("Railway"));
    await expect.element(mcp).not.toBeChecked();
    await expect.element(summary("agent")).not.toHaveTextContent("MCP server");
    await userEvent.click(access("Railway"));
    await expect.element(mcp).toBeChecked();
    await userEvent.click(page.getByRole("button", { name: "Add sandbox config" }));
    expect(savedConfig()).toMatchObject({ railway: true, mcpServers: ["railway"] });
  });
});
