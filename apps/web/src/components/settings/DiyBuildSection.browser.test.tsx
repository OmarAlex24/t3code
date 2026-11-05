import type { DiyKitStatus } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { DiyBuildCard, DiyLogText } from "./DiyBuildSection";

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
