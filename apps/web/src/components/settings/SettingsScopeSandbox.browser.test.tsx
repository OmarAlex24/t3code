import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { Project } from "../../types";

const hostId = EnvironmentId.make("host");
const remoteId = EnvironmentId.make("t3-machine");
const sandboxId = EnvironmentId.make("sandbox");
const hostProjectId = ProjectId.make("zumith-host");
const cloneId = ProjectId.make("zumith-clone");

const machine = (environmentId: EnvironmentId, label: string) => ({
  environmentId,
  label,
  displayUrl: `https://${environmentId}.example.test`,
  connection: { phase: "connected" },
  serverConfig: {
    settings: DEFAULT_SERVER_SETTINGS,
    environment: { platform: { machine: "server" }, capabilities: {} },
  },
});
const environments = [
  machine(hostId, "T3 Code Custom"),
  machine(remoteId, "t3-machine"),
  machine(sandboxId, "zumith-v2 on Boat sandbox"),
];
const project = (id: ProjectId, environmentId: EnvironmentId, workspaceRoot: string): Project =>
  ({
    id,
    environmentId,
    title: "zumith-v2",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  }) as unknown as Project;
const projects = [
  project(hostProjectId, hostId, "/Users/omar/code/zumith-v2"),
  project(cloneId, sandboxId, "/home/user/work/zumith-v2"),
];

const sandboxList = vi.hoisted(() => ({ known: true }));

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments })) as never,
  usePrimaryEnvironmentId: () => hostId,
}));
// The third machine is a chat's sandbox, provisioned by the host for its zumith-v2 project.
vi.mock(import("~/state/sandboxes"), async (original) => ({
  ...(await original()),
  useSandboxFollowers: () => ({
    hostEnvironmentId: hostId,
    followers: [{ environmentId: sandboxId, hostProjectId, projectId: cloneId }],
    environmentIds: new Set([sandboxId]),
    known: sandboxList.known,
  }),
  useSandboxEnvironmentIds: () => new Set([sandboxId]),
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => projects) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
}));
vi.mock(import("../files/projectFilesQueryState"), async (original) => ({
  ...(await original()),
  getProjectFileQueryAtom: () => Atom.make(AsyncResult.initial<never, never>()),
}));

import { SettingsScopeProvider } from "./SettingsScopeContext";
import { SettingsScopeSentence } from "./SettingsScopeSentence";
import type { SettingsScopeSearch } from "./settingsScope";

const mount = (search: SettingsScopeSearch) =>
  render(
    <SettingsScopeProvider search={search} onChange={() => {}}>
      <SettingsScopeSentence />
    </SettingsScopeProvider>,
    { router: "/settings/threads" },
  );

describe("settings scope with a sandbox", () => {
  const environmentMenu = (label: string) =>
    page.getByRole("button", { name: `Environment scope: ${label}` });

  it("offers the host and other machines, never the host's sandbox", async () => {
    sandboxList.known = true;
    await using _screen = await mount({});

    await userEvent.click(environmentMenu("All environments"));
    await expect
      .element(page.getByRole("menuitemradio", { name: /^T3 Code Custom/ }))
      .toBeVisible();
    await expect.element(page.getByRole("menuitemradio", { name: /^t3-machine/ })).toBeVisible();
    await expect.element(page.getByText("zumith-v2 on Boat sandbox")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    // The project is the host's; its sandbox clone is no checkout of it.
    await userEvent.click(page.getByRole("button", { name: "Project scope: All projects" }));
    await expect.element(page.getByText("/Users/omar/code/zumith-v2")).toBeVisible();
    await expect.element(page.getByText("/home/user/work/zumith-v2")).not.toBeInTheDocument();
  });

  it("offers only the host until the host lists its sandboxes", async () => {
    sandboxList.known = false;
    await using _screen = await mount({});

    await userEvent.click(environmentMenu("All environments"));
    await expect
      .element(page.getByRole("menuitemradio", { name: /^T3 Code Custom/ }))
      .toBeVisible();
    await expect.element(page.getByText("t3-machine")).not.toBeInTheDocument();
    await expect.element(page.getByText("zumith-v2 on Boat sandbox")).not.toBeInTheDocument();
  });

  it("opens a link to the sandbox on its host", async () => {
    sandboxList.known = true;
    await using _screen = await mount({ machine: sandboxId });
    await expect.element(environmentMenu("T3 Code Custom")).toBeVisible();

    await using _project = await mount({
      project: `${sandboxId}:/home/user/work/zumith-v2`,
      machine: sandboxId,
    });
    await expect.element(page.getByText("Unavailable environment")).not.toBeInTheDocument();
  });
});
