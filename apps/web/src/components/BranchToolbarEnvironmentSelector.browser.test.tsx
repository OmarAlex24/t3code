import { EnvironmentId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import type { EnvironmentOption } from "./BranchToolbar.logic";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { sandboxOptionId } from "../state/sandboxComposer";

const mac = EnvironmentId.make("11111111-1111-4111-8111-111111111111");
const remote = EnvironmentId.make("22222222-2222-4222-8222-222222222222");
const machines: EnvironmentOption[] = [
  {
    environmentId: mac,
    projectId: null,
    label: "Omar's MacBook Pro",
    isPrimary: true,
    machine: "laptop",
  },
  {
    environmentId: remote,
    projectId: null,
    label: "t3-machine",
    isPrimary: false,
    machine: "server",
  },
];
const boatSmall: EnvironmentOption = {
  environmentId: sandboxOptionId("config-1"),
  projectId: null,
  label: "Boat small",
  isPrimary: false,
  machine: "cloud",
  sandboxProvider: "boat",
};

describe("BranchToolbarEnvironmentSelector", () => {
  it("lists sandbox configs in their own group under the machines", async () => {
    const onEnvironmentChange = vi.fn();
    await using _screen = await render(
      <BranchToolbarEnvironmentSelector
        envLocked={false}
        environmentId={remote}
        availableEnvironments={[...machines, boatSmall]}
        onEnvironmentChange={onEnvironmentChange}
      />,
    );

    await userEvent.click(page.getByRole("combobox", { name: "Run on" }));
    await expect.element(page.getByText("Sandbox", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "t3-machine" })).toBeVisible();
    await userEvent.click(page.getByRole("option", { name: "Boat small" }));
    expect(onEnvironmentChange).toHaveBeenCalledWith(sandboxOptionId("config-1"));
  });

  it("offers to make a config when there is none", async () => {
    const onNewSandboxConfig = vi.fn();
    await using _screen = await render(
      <BranchToolbarEnvironmentSelector
        envLocked={false}
        environmentId={remote}
        availableEnvironments={machines.slice(1)}
        onEnvironmentChange={() => {}}
        onNewSandboxConfig={onNewSandboxConfig}
      />,
    );

    await userEvent.click(page.getByRole("combobox", { name: "Run on" }));
    await userEvent.click(page.getByRole("option", { name: "New sandbox config…" }));
    expect(onNewSandboxConfig).toHaveBeenCalledOnce();
  });
});
