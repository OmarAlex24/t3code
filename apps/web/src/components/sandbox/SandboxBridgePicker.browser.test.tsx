import {
  ProviderDriverKind,
  ProviderInstanceId,
  SANDBOX_BRIDGE_INSTANCE_ID,
  SANDBOX_BRIDGE_MODEL,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";

const provider = (
  instanceId: string,
  driver: string,
  displayName: string,
  model: { slug: string; name: string },
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  displayName,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-05T00:00:00.000Z",
  models: [{ ...model, isCustom: false, capabilities: {} }],
  slashCommands: [],
  skills: [],
});

const bridgeId = ProviderInstanceId.make(SANDBOX_BRIDGE_INSTANCE_ID);
const claudeId = ProviderInstanceId.make("claudeAgent");
// The bridge is turned on for a sandbox host project, so the project's composer lists it.
const entries = deriveProviderInstanceEntries([
  provider("claudeAgent", "claudeAgent", "Claude", { slug: "opus", name: "Claude Opus" }),
  provider(SANDBOX_BRIDGE_INSTANCE_ID, "acpRegistry", "Sandboxes", {
    slug: SANDBOX_BRIDGE_MODEL,
    name: "Sandbox agent",
  }),
]);
const options = new Map(entries.map((entry) => [entry.instanceId, entry.models]));

const picker = (activeInstanceId: ProviderInstanceId, model: string) => (
  <ProviderModelPicker
    environmentId={null}
    activeInstanceId={activeInstanceId}
    model={model}
    lockedProvider={null}
    instanceEntries={entries}
    modelOptionsByInstance={options}
    triggerAriaLabel="Model"
    onInstanceModelChange={() => {}}
  />
);

it("keeps the Sandboxes instance out of a picker that isn't already on it", async () => {
  await using screen = await render(picker(claudeId, "opus"));
  await screen.getByRole("button", { name: "Model" }).click();
  await expect.element(page.getByRole("button", { name: "Claude", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Sandboxes" })).not.toBeInTheDocument();
  await userEvent.keyboard("Sandbox");
  await expect.element(page.getByRole("option", { name: /Sandbox agent/ })).not.toBeInTheDocument();
});

it("still shows the Sandbox agent on a host thread the bridge drives", async () => {
  await using screen = await render(picker(bridgeId, SANDBOX_BRIDGE_MODEL));
  await expect.element(screen.getByText("Sandbox agent")).toBeVisible();
  await screen.getByRole("button", { name: "Model" }).click();
  await page.getByRole("button", { name: "Sandboxes" }).click();
  await expect.element(page.getByRole("option", { name: /Sandbox agent/ })).toBeVisible();
});
