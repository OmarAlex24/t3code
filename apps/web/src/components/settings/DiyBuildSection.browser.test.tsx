import {
  defaultInstanceIdForDriver,
  type DiyKitStatus,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  DiyBuildCard,
  DiyLogText,
  DiyResolverPicker,
  type DiyResolverSelection,
} from "./DiyBuildSection";

const status = (overrides: Partial<DiyKitStatus>): DiyKitStatus => ({
  schema: 1,
  mode: "side-by-side",
  app: {
    name: "T3 Code Custom",
    installedVersion: "0.1.8-nightly.20261105.900004",
    latestBuild: "0.1.8-nightly.20261105.900004",
  },
  fork: { url: "git@github.com:you/t3code.git", branch: "my-changes" },
  upstream: { url: "https://github.com/pingdotgg/t3code.git", branch: "main" },
  resolver: { provider: "claude", model: "opus" },
  schedule: { loaded: true, nextRun: null },
  running: false,
  lastRun: {
    result: "conflict_unresolved",
    reason: "Claude Code (opus) could not resolve the rebase conflicts in 2 file(s)",
    startedAt: "2026-11-05T05:00:00-06:00",
    endedAt: "2026-11-05T05:31:00-06:00",
    version: null,
    log: "/kit/logs/update-20261105-050000.log",
  },
  ...overrides,
});

it("says a failed update left the app alone, shows the log, and locks Update now while one runs", async () => {
  const onRunNow = vi.fn();
  const card = (kitStatus: DiyKitStatus) => (
    <DiyBuildCard
      status={kitStatus}
      starting={false}
      canRun
      onRunNow={onRunNow}
      resolverControl={null}
      log={<DiyLogText text={"[05:31:00] FAILED (conflict_unresolved)\n"} error={null} />}
    />
  );
  await using screen = await render(card(status({})));

  await expect
    .element(
      screen.getByText(
        /on a rebase conflict: Claude Code \(opus\) could not resolve .+\. Your installed app is unchanged\.$/,
      ),
    )
    .toBeVisible();
  await screen.getByRole("button", { name: "View log" }).click();
  await expect.element(screen.getByText(/FAILED \(conflict_unresolved\)/)).toBeVisible();
  await screen.getByRole("button", { name: "Update now" }).click();
  expect(onRunNow).toHaveBeenCalledOnce();

  await screen.rerender(card(status({ running: true })));
  await expect.element(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
});

// Shaped like the server's catalogs: Claude's levels end in Ultracode and the prompt-only Ultrathink,
// next to Fast mode and a context window; Codex models list their own levels, some with Ultra.
const level = (id: string, label: string, isDefault = false) => ({
  id,
  label,
  ...(isDefault ? { isDefault: true } : {}),
});
const claudeModel = (slug: string, name: string): ServerProviderModel => ({
  slug,
  name,
  isCustom: false,
  capabilities: createModelCapabilities({
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          level("low", "Low"),
          level("medium", "Medium", true),
          level("high", "High"),
          level("xhigh", "Extra High"),
          level("max", "Max"),
          level("ultracode", "Ultracode"),
          level("ultrathink", "Ultrathink"),
        ],
        promptInjectedValues: ["ultrathink"],
      },
      { id: "fastMode", label: "Fast Mode", type: "boolean" },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [level("200k", "200k", true), level("1m", "1M")],
      },
    ],
  }),
});
const CODEX_LEVEL_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};
const codexModel = (slug: string, name: string, levels: ReadonlyArray<string>) => ({
  slug,
  name,
  isCustom: false,
  capabilities: createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select" as const,
        options: levels.map((id) => level(id, CODEX_LEVEL_LABELS[id] ?? id, id === "medium")),
      },
      {
        id: "serviceTier",
        label: "Speed",
        type: "select" as const,
        options: [level("default", "Standard", true), level("fast", "Fast")],
      },
    ],
  }),
});

const provider = (driver: string, models: ReadonlyArray<ServerProviderModel>): ServerProvider => ({
  instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make(driver)),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-05T00:00:00.000Z",
  models,
  slashCommands: [],
  skills: [],
});

const entries = deriveProviderInstanceEntries([
  provider("claudeAgent", [claudeModel("opus-5-5", "Claude Opus 5.5")]),
  provider("codex", [
    codexModel("gpt-6-sol", "GPT-6 Sol", ["low", "medium", "high", "xhigh", "max", "ultra"]),
    codexModel("gpt-5.5", "GPT-5.5", ["low", "medium", "high", "xhigh"]),
  ]),
]);

function Picker(props: {
  readonly initial: DiyResolverSelection;
  readonly onChange: (next: DiyResolverSelection) => void;
}) {
  const [selection, setSelection] = useState(props.initial);
  return (
    <DiyResolverPicker
      environmentId={null}
      selection={selection}
      entries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      disabled={false}
      onChange={(next) => {
        props.onChange(next);
        setSelection(next);
      }}
    />
  );
}

const levelNames = async () =>
  (await page.getByRole("radiogroup", { name: "Reasoning" }).getByRole("radio").all()).map(
    (radio) => radio.element().textContent,
  );

it("lists only the effort levels claude --effort takes, and none of the chat's other controls", async () => {
  const onChange = vi.fn();
  await using screen = await render(
    <Picker initial={{ provider: "claude", model: "opus-5-5", effort: "" }} onChange={onChange} />,
  );

  await screen.getByRole("button", { name: /Conflict resolver/ }).click();
  // Empty effort is the CLI's default, shown as the model's Default level.
  await expect
    .element(page.getByRole("radio", { name: /Medium/ }))
    .toHaveAttribute("aria-checked", "true");
  expect(await levelNames()).toEqual(["Low", "MediumDefault", "High", "Extra High", "Max"]);
  for (const hidden of ["Ultracode", "Ultrathink", "Fast", "Standard", "Context Window"]) {
    await expect.element(page.getByText(hidden, { exact: true })).not.toBeInTheDocument();
  }
  await expect.element(page.getByRole("button", { name: /^Permissions/ })).not.toBeInTheDocument();

  await page.getByRole("radio", { name: "Extra High" }).click();
  expect(onChange).toHaveBeenLastCalledWith({
    provider: "claude",
    model: "opus-5-5",
    effort: "xhigh",
  });
  await expect
    .element(page.getByRole("radio", { name: "Extra High" }))
    .toHaveAttribute("aria-checked", "true");
});

it("switches provider and model from the rail, keeping the effort only where the model has it", async () => {
  const onChange = vi.fn();
  await using screen = await render(
    <Picker
      initial={{ provider: "claude", model: "opus-5-5", effort: "max" }}
      onChange={onChange}
    />,
  );

  await screen.getByRole("button", { name: /Conflict resolver/ }).click();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await page.getByRole("option", { name: /GPT-6 Sol/ }).click();
  expect(onChange).toHaveBeenLastCalledWith({
    provider: "codex",
    model: "gpt-6-sol",
    effort: "max",
  });
  // Codex's Ultra delegates to more agents; it isn't an effort for a headless rebase.
  expect(await levelNames()).toEqual(["Low", "MediumDefault", "High", "Extra High", "Max"]);

  // GPT-5.5 stops at Extra High, so Max goes back to the CLI's default.
  await page.getByRole("option", { name: /GPT-5\.5/ }).click();
  expect(onChange).toHaveBeenLastCalledWith({ provider: "codex", model: "gpt-5.5", effort: "" });
  await page.getByRole("radio", { name: "High", exact: true }).click();
  expect(onChange).toHaveBeenLastCalledWith({
    provider: "codex",
    model: "gpt-5.5",
    effort: "high",
  });
});

it("leaves the effort column out for a kit that predates RESOLVER_EFFORT", async () => {
  const onChange = vi.fn();
  await using screen = await render(
    <Picker initial={{ provider: "claude", model: "opus-5-5" }} onChange={onChange} />,
  );

  await screen.getByRole("button", { name: /Conflict resolver/ }).click();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await page.getByRole("option", { name: /GPT-5\.5/ }).click();
  expect(onChange).toHaveBeenLastCalledWith({ provider: "codex", model: "gpt-5.5" });
  await expect.element(page.getByRole("radiogroup", { name: "Reasoning" })).not.toBeInTheDocument();
});
