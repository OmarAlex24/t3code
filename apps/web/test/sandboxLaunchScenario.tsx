import { createMemoryHistory } from "@tanstack/react-router";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  RunId,
  SANDBOX_SETUP_STAGE_ORDER,
  type SandboxRecord,
  type SandboxSetupSnapshot,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import { expect } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  assistantItem,
  ENVIRONMENT_ID,
  type FakeThread,
  installFakeEnvironment,
  userItem,
} from "./fakeEnvironment";
import { render } from "./render";

/** A sandbox chat on the host: its first message waiting on the launch, or sent through the bridge. */
// Kept for a look at the in-thread state, like the sidebar's sandbox rows.
export const SCREENSHOTS = "__screenshots__/sandbox-launch";
const bridge = ProviderInstanceId.make("sandboxes");
export const threadId = ThreadId.make("thread-sandbox-chat");
const runId = RunId.make("run-sandbox-chat");
const messageId = "message-sandbox-chat";
const startedAt = new Date(Date.now() - 74_000).toISOString();
const at = DateTime.makeUnsafe(startedAt);

const firstRun = (status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: bridge,
  modelSelection: { instanceId: bridge, model: "claude-opus-5-5" },
  providerThreadId: null,
  userMessageId: MessageId.make(messageId),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: at,
  startedAt: status === "preparing" ? null : at,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});

// The host's placeholder for the work the run waits on, as the orchestrator adds it.
const preparation = (done: boolean): OrchestrationV2TurnItem => ({
  id: TurnItemId.make("item-preparation"),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: done ? "completed" : "running",
  title: done ? "Workspace ready" : "Preparing workspace",
  startedAt: at,
  completedAt: done ? at : null,
  updatedAt: at,
  type: "command_execution",
  input: "Preparing workspace",
  ...(done ? { output: "Workspace preparation completed.", exitCode: 0 } : {}),
});

const userMessage = userItem(threadId, runId, messageId, 0, "Fix the flaky login test in CI");

const chat = (stage: "waiting" | "released"): FakeThread => ({
  id: threadId,
  title: "Fix the flaky login test in CI",
  modelSelection: { instanceId: bridge, model: "claude-opus-5-5" },
  shellStatus: stage === "waiting" ? "preparing" : "running",
  runs: [firstRun(stage === "waiting" ? "preparing" : "running")],
  items:
    stage === "waiting"
      ? [userMessage, preparation(false)]
      : [
          userMessage,
          preparation(true),
          assistantItem(
            threadId,
            runId,
            "item-answer",
            2,
            "Looking at `login.spec.ts`: the test races the session cookie. I'll wait for the redirect before asserting.",
            true,
          ),
        ],
});

export const sandbox = (state: SandboxRecord["state"]): SandboxRecord => ({
  instanceId: "instance-1",
  environmentId: EnvironmentId.make("environment-sandbox"),
  configId: "config-1",
  threadId,
  provider: "boat",
  sandboxId: "bx_46wrabcd",
  label: "render on Boat small",
  size: "small",
  state,
  createdAt: startedAt,
  updatedAt: startedAt,
  httpBaseUrl: "https://bx.example.test",
  runningSince: startedAt,
  maxRunningMinutes: 480,
  ...(state === "running"
    ? {
        hostProjectId: ProjectId.make("project-render"),
        bridge: {
          sessionId: "bridge-session-1",
          secret: "sandbox-bridge-1",
          expiresAt: "2027-11-01T00:00:00.000Z",
        },
      }
    : {}),
});

export const launch: SandboxSetupSnapshot = {
  threadId,
  instanceId: "instance-1",
  configId: "config-1",
  label: "Boat small",
  provider: "boat",
  phase: "running",
  startedAt,
  endedAt: null,
  stages: SANDBOX_SETUP_STAGE_ORDER.map((id, index) => ({
    id,
    status: index < 5 ? "done" : index === 5 ? "running" : "pending",
    startedAt: index <= 5 ? startedAt : null,
    endedAt: index < 5 ? startedAt : null,
    detail: id === "create" ? "small · 2 CPU" : null,
  })),
  warnings: [],
  error: null,
  recovery: null,
  awaitingHandoff: false,
  sequence: 7,
};

export async function openChat(
  stage: "waiting" | "released",
  options: Parameters<typeof installFakeEnvironment>[1],
) {
  const environment = installFakeEnvironment([chat(stage)], options);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1200, 760);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threadId}`] }),
  );
  await router.load();
  const app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText("Fix the flaky login test in CI").first()).toBeVisible();
  return {
    async [Symbol.asyncDispose]() {
      await app[Symbol.asyncDispose]();
      environment[Symbol.dispose]();
    },
  };
}

export const sidebarRow = () => {
  const row = document.querySelector<HTMLElement>(`li[data-thread-item] [data-sidebar-row]`);
  expect(row).not.toBeNull();
  return row!.closest("li[data-thread-item]") as HTMLElement;
};
