import {
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Milestone,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useThreadViewModeStore } from "../../threadViewModeStore";

vi.mock("./AgentAsks", () => ({ useAgentAsks: () => new Map(), focusAgentAsk: () => {} }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null, useProject: () => null }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { providersValueAtom: () => Atom.make(null) },
}));
vi.mock("./ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("./V2LifecycleRow", () => ({ useSubagentLink: () => ({ open: null, timing: {} }) }));

import { ThreadMilestonesView } from "./ThreadMilestonesView";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const at = (minute: number) =>
  DateTime.makeUnsafe(`2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z`);
const milestone = (
  id: string,
  title: string,
  status: OrchestrationV2Milestone["status"],
  start: number | null,
): OrchestrationV2Milestone =>
  ({
    id,
    setId: "s1",
    title,
    status,
    startedAt: start === null ? null : at(start),
    completedAt: status === "done" ? at((start ?? 0) + 1) : null,
    anchors: { planned: { runId: RunId.make("run-1"), itemId: TurnItemId.make(`item-${id}`) } },
  }) as OrchestrationV2Milestone;

const projection = {
  runs: [
    {
      id: RunId.make("run-1"),
      ordinal: 1,
      status: "completed",
      userMessageId: "msg-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
      requestedAt: at(0),
      startedAt: at(0),
      completedAt: at(9),
    },
  ],
  messages: [
    { id: "msg-1", runId: RunId.make("run-1"), role: "user", text: "Ship it", streaming: false },
  ],
  subagents: [],
  milestones: [
    milestone("m1", "Read the code", "done", 1),
    milestone("m2", "Build it", "done", 3),
    milestone("m3", "Test it", "done", 5),
  ],
} as never;

function setup() {
  useThreadViewModeStore.setState({ zoomByThreadKey: {}, byThreadKey: {} });
}

async function renderView() {
  return render(
    <div style={{ width: 960, height: 720 }}>
      <input aria-label="Composer" />
      <ThreadMilestonesView
        threadRef={threadRef}
        projection={projection}
        turnItems={[]}
        coordinatorAsk={null}
        bottomInset={96}
        onOpenThread={() => {}}
        onComment={null}
      />
    </div>,
  );
}

it("zooms into a milestone, steps with the arrows and zooms out with Esc", async () => {
  setup();
  await using screen = await renderView();
  await screen.getByRole("button", { name: "Zoom into Build it" }).click();
  await expect.element(screen.getByText("2 of 3")).toBeInTheDocument();
  const canvas = document.querySelector<HTMLElement>("[data-milestone-zoom]");
  await vi.waitFor(() => expect(document.activeElement).toBe(canvas));

  await userEvent.keyboard("{ArrowDown}");
  await expect.element(screen.getByText("3 of 3")).toBeInTheDocument();
  await userEvent.keyboard("{ArrowUp}{ArrowUp}");
  await expect.element(screen.getByText("1 of 3")).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByText("1 of 3")).not.toBeInTheDocument();
  expect(document.querySelector("[data-milestone-zoom]")).toBeNull();
});

it("leaves keys typed in a field alone and keeps focus there when the zoom comes from elsewhere", async () => {
  setup();
  await using screen = await renderView();
  const composer = screen.getByRole("textbox", { name: "Composer" });
  await composer.click();
  useThreadViewModeStore.getState().setZoom(threadRef, { rowId: "m1" });
  await expect.element(screen.getByText("1 of 3")).toBeInTheDocument();
  await expect.element(composer).toHaveFocus();

  await userEvent.keyboard("{ArrowDown}{Escape}");
  await expect.element(screen.getByText("1 of 3")).toBeInTheDocument();
});

it("still selects a milestone after a pan", async () => {
  setup();
  await using screen = await renderView();
  const canvas = screen.container.querySelector<HTMLElement>(
    "[data-thread-milestones-view] > .cursor-grab",
  )!;
  await userEvent.dragAndDrop(canvas, screen.getByRole("button", { name: "Zoom in" }));
  await screen.getByRole("button", { name: "Zoom into Test it" }).click();
  await expect.element(screen.getByText("3 of 3")).toBeInTheDocument();
});
