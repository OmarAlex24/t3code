import { describe, expect, it } from "vite-plus/test";
import {
  type OrchestrationV2Milestone,
  type OrchestrationV2Subagent,
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ThreadStructureTurnItem } from "./models.ts";
import {
  type AgentAsk,
  type MapMilestone,
  agentLine,
  BEFORE_PLAN_NODE_ID,
  deriveMilestoneMap,
  flattenAgents,
  layoutMilestoneGraph,
} from "./threadMilestoneMap.ts";

const BASE_MS = Date.parse("2026-11-10T10:00:00.000Z");
const sec = (seconds: number) => DateTime.makeUnsafe(BASE_MS + seconds * 1000);
const ENV = EnvironmentId.make("env-1");

const run = (ordinal: number, status: string, startS: number, endS: number | null = null) =>
  ({
    id: RunId.make(`run-${ordinal}`),
    ordinal,
    status,
    userMessageId: `msg-${ordinal}`,
    requestedAt: sec(startS),
    startedAt: sec(startS),
    completedAt: endS === null ? null : sec(endS),
  }) as never;

const message = (id: string, role: "user" | "assistant", text: string, runOrdinal: number) =>
  ({
    id,
    runId: RunId.make(`run-${runOrdinal}`),
    role,
    text,
    streaming: false,
    createdBy: role === "user" ? "user" : "agent",
  }) as never;

const anchor = (runOrdinal: number, id: string) => ({
  runId: RunId.make(`run-${runOrdinal}`),
  itemId: TurnItemId.make(`item-${id}`),
});

function milestone(
  id: string,
  setId: string,
  title: string,
  status: OrchestrationV2Milestone["status"],
  times: { readonly start?: number; readonly end?: number; readonly plannedIn?: number | null },
  extra: Partial<OrchestrationV2Milestone> = {},
): OrchestrationV2Milestone {
  const plannedIn = times.plannedIn === undefined ? 1 : times.plannedIn;
  return {
    id,
    setId,
    title,
    status,
    startedAt: times.start === undefined ? null : sec(times.start),
    completedAt: times.end === undefined ? null : sec(times.end),
    anchors: plannedIn === null ? {} : { planned: anchor(plannedIn, id) },
    ...extra,
  } as OrchestrationV2Milestone;
}

function agent(
  id: string,
  milestoneId: string,
  status: OrchestrationV2Subagent["status"],
  startS: number,
  endS: number | null,
  extra: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    parentNodeId: NodeId.make("root"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("claude"),
    providerInstanceId: ProviderInstanceId.make("claude"),
    providerThreadId: null,
    childThreadId: ThreadId.make(`child-${id}`),
    nativeTaskRef: null,
    prompt: id,
    title: id,
    model: null,
    status,
    result: null,
    milestoneId,
    startedAt: sec(startS),
    completedAt: endS === null ? null : sec(endS),
    updatedAt: sec(endS ?? startS),
    ...extra,
  } as OrchestrationV2Subagent;
}

const milestoneItem = (
  id: string,
  fields: Partial<Extract<ThreadStructureTurnItem, { type: "milestone" }>>,
): ThreadStructureTurnItem =>
  ({
    id: TurnItemId.make(id),
    type: "milestone",
    parentItemId: null,
    status: "completed",
    ...fields,
  }) as never;

const rows = (map: { readonly nodes: ReadonlyArray<{ id: string; col: number }> }) =>
  map.nodes.map(({ id, col }) => [id, col]);
const edges = (map: {
  readonly edges: ReadonlyArray<{ from: string; to: string; style: string }>;
}) => map.edges.map(({ from, to, style }) => [from, to, style]);
const card = (map: { readonly nodes: ReadonlyArray<{ id: string }> }, id: string) =>
  map.nodes.find((node) => node.id === id) as MapMilestone;

/** The mockup's live fixture: a GitHub OAuth task with a detour, a re-plan and two asks. */
const OAUTH = {
  runs: [run(1, "running", 0)],
  messages: [
    message("msg-1", "user", "Agrega login con GitHub OAuth.\nY que la sesión sobreviva.", 1),
  ],
  milestones: [
    milestone("m1", "s1", "Leer el módulo de auth", "done", { start: 10, end: 82 }),
    milestone("m2", "s1", "Reusar /api/session", "done", { start: 82, end: 205 }, {
      revision: { previousTitle: "Diseñar la API de sesión", reason: "Ya existe /api/session." },
    } as never),
    milestone("m3", "s1", "Backend y UI en paralelo", "done", { start: 205, end: 605 }),
    milestone("m5", "s1", "Tests", "done", { start: 695, end: 880 }),
    milestone("m6", "s1", "Docs", "planned", {}),
    milestone("m4", "s1", "Actualizar @octokit/oauth-app", "done", {
      start: 605,
      end: 695,
      plannedIn: null,
    }),
    milestone("m7", "s2", "Corregir refresh token", "active", { start: 880 }),
    milestone("m8", "s2", "Tests e2e", "planned", {}),
    milestone("m9", "s2", "Docs", "planned", {}),
  ],
  subagents: [
    agent("a3", "m3", "completed", 214, 380, { group: "Backend" } as never),
    agent("a4", "m3", "failed", 216, 281, { title: "Migración users", group: "Backend" } as never),
    agent("a1", "m3", "completed", 215, 345, { group: "UI" } as never),
    agent("a2", "m3", "completed", 218, 400, { group: "UI" } as never),
    agent("a5", "m3", "completed", 290, 390, {
      title: "Migración users",
      group: "Backend",
    } as never),
    agent("a3a", "m3", "completed", 300, 372, { parentNodeId: NodeId.make("a3") }),
    agent("a6", "m5", "completed", 700, 870),
    agent("a7", "m7", "running", 895, null, { group: "Backend" } as never),
    agent("a9", "m7", "completed", 900, 1010, { group: "UI" } as never),
    agent("a8", "m7", "running", 940, null, { group: "Backend" } as never),
  ],
};
const OAUTH_ASKS = new Map<string, AgentAsk>([
  [`${ENV}:child-a7`, { kind: "approval", command: "pnpm db:reset" }],
  [`${ENV}:child-a8`, { kind: "secret", label: "GITHUB_CLIENT_SECRET" }],
]);
const OAUTH_ITEMS = [
  milestoneItem("plan-2", {
    event: "plan",
    setId: "s2" as never,
    startedAt: sec(880),
    closedMilestoneId: "m5" as never,
  }),
];

/** "Trace groups check": two milestones started again by title, then a plan of ten. */
const TRACE_GROUPS = {
  runs: [run(1, "completed", 0, 30), run(2, "completed", 905, 1239)],
  messages: [
    message("msg-1", "user", "Plan two milestones: 'Construir' and 'Revisar'.", 1),
    message("msg-2", "user", "Segunda ronda, corta.", 2),
    message("reply-2", "assistant", "Done.\nAll ten planned.", 2),
  ],
  milestones: [
    milestone("m1", "s1", "Construir", "done", { start: 7, end: 10 }, {
      detailInTurnItem: true,
    } as never),
    milestone("m2", "s1", "Revisar", "planned", {}),
    milestone("m3", "s1", "Construir", "done", { start: 10, end: 26, plannedIn: null }),
    milestone("m4", "s1", "Revisar", "done", { start: 27, end: 30, plannedIn: null }),
    milestone("m5", "s2", "Fase A", "done", { start: 910, end: 910, plannedIn: 2 }),
    ...["B", "C", "D", "E", "F", "G", "H", "I", "J"].map((letter, index) =>
      milestone(`m${6 + index}`, "s2", `Fase ${letter}`, "planned", { plannedIn: 2 }),
    ),
    milestone("m15", "s2", "Fase A", "done", { start: 910.5, end: 1235, plannedIn: null }),
  ],
  subagents: ["r1", "r2", "r3", "r4"].map((id) => agent(id, "m3", "completed", 11, 16)),
};
const TRACE_GROUPS_ITEMS = [
  milestoneItem("started-m3", {
    event: "started",
    milestoneId: "m3" as never,
    setId: "s1" as never,
    closedMilestoneId: "m1" as never,
    note: "## Closed when a second “Construir” started.",
  }),
];

const derive = (
  projection: typeof OAUTH | typeof TRACE_GROUPS,
  turnItems: ReadonlyArray<ThreadStructureTurnItem>,
  asks: ReadonlyMap<string, AgentAsk> = new Map(),
) =>
  deriveMilestoneMap({
    environmentId: ENV,
    projection: projection as never,
    turnItems,
    asks,
    coordinatorAsks: false,
  })!;

/** id, set, in the plan, dropped, started (seconds). */
type GraphRow = readonly [string, string, boolean, boolean, number | null];

describe("layoutMilestoneGraph", () => {
  it.each([
    {
      name: "a detour that rejoins, and a plan forked from the last done milestone",
      sets: [
        { id: "s1", from: null, you: null },
        { id: "s2", from: "m5", you: null },
      ],
      milestones: [
        ["m1", "s1", true, false, 10],
        ["m2", "s1", true, false, 82],
        ["m3", "s1", true, false, 205],
        ["m4", "s1", false, false, 605],
        ["m5", "s1", true, false, 695],
        ["m6", "s1", true, true, null],
        ["m7", "s2", true, false, 880],
        ["m8", "s2", true, false, null],
        ["m9", "s2", true, false, null],
      ],
      nodes: [
        ["you", 0],
        ["m1", 0],
        ["m2", 0],
        ["m3", 0],
        ["m4", 1],
        ["m5", 0],
        ["m7", 1],
        ["m6", 0],
        ["m8", 1],
        ["m9", 1],
      ],
      edges: [
        ["you", "m1", "live"],
        ["m1", "m2", "live"],
        ["m2", "m3", "live"],
        ["m3", "m5", "live"],
        ["m5", "m6", "dropped"],
        ["m3", "m4", "live"],
        ["m4", "m5", "live"],
        ["m7", "m8", "future"],
        ["m8", "m9", "future"],
        ["m5", "m7", "live"],
      ],
    },
    {
      name: "milestones started again by title, and a plan you asked for forked from the detour",
      sets: [
        { id: "s1", from: null, you: null },
        { id: "s2", from: "m4", you: "Segunda ronda" },
      ],
      milestones: [
        ["m1", "s1", true, false, 7],
        ["m2", "s1", true, true, null],
        ["m3", "s1", false, false, 10],
        ["m4", "s1", false, false, 27],
        ["m5", "s2", true, false, 910],
        ...["m6", "m7", "m8", "m9", "m10", "m11", "m12", "m13", "m14"].map((id) => [
          id,
          "s2",
          true,
          false,
          null,
        ]),
        ["m15", "s2", false, false, 910.5],
      ],
      nodes: [
        ["you", 0],
        ["m1", 0],
        ["m3", 1],
        ["m2", 0],
        ["m4", 1],
        ["you-s2", 0],
        ["m5", 0],
        ["m15", 1],
        ...["m6", "m7", "m8", "m9", "m10", "m11", "m12", "m13", "m14"].map((id) => [id, 0]),
      ],
      edges: [
        ["you", "m1", "live"],
        ["m1", "m2", "dropped"],
        ["m3", "m4", "live"],
        ["m1", "m3", "live"],
        ["you-s2", "m5", "live"],
        ["m5", "m6", "future"],
        ["m6", "m7", "future"],
        ["m7", "m8", "future"],
        ["m8", "m9", "future"],
        ["m9", "m10", "future"],
        ["m10", "m11", "future"],
        ["m11", "m12", "future"],
        ["m12", "m13", "future"],
        ["m13", "m14", "future"],
        ["m4", "you-s2", "live"],
        ["m5", "m15", "live"],
        ["m15", "m6", "future"],
      ],
    },
  ] as const)("$name", ({ sets, milestones, nodes, edges: expected }) => {
    const layout = layoutMilestoneGraph({
      milestones: (milestones as ReadonlyArray<GraphRow>).map(
        ([id, setId, planned, dropped, start]) => ({
          id,
          setId,
          planned,
          dropped,
          startMs: start === null ? null : start * 1000,
        }),
      ),
      sets,
      request: "Your request",
    });
    expect(rows(layout)).toEqual(nodes);
    expect(edges(layout)).toEqual(expected);
  });
});

describe("deriveMilestoneMap", () => {
  it("lays out a live OAuth task with its detour, changes, nesting and asks", () => {
    const map = derive(OAUTH, OAUTH_ITEMS, OAUTH_ASKS);
    expect(rows(map)).toEqual([
      ["you", 0],
      ["m1", 0],
      ["m2", 0],
      ["m3", 0],
      ["m4", 1],
      ["m5", 0],
      ["m7", 1],
      ["m6", 0],
      ["m8", 1],
      ["m9", 1],
    ]);
    expect(map.title).toBe("Agrega login con GitHub OAuth.");
    expect(
      map.nodes.flatMap((node) =>
        node.kind === "milestone" ? [[node.id, node.status, node.subtitle, node.rollup.text]] : [],
      ),
    ).toEqual([
      ["m1", "done", "In the plan", "No agents"],
      ["m2", "done", "Changed from “Diseñar la API de sesión”", "No agents"],
      ["m3", "done", "In the plan", "1 failed · 6 agents"],
      ["m4", "done", "Not in the plan", "No agents"],
      ["m5", "done", "In the plan", "1 agent done"],
      ["m7", "needs-you", "New plan", "2 need you"],
      ["m6", "dropped", "In the plan", "No agents"],
      ["m8", "planned", "In the new plan", "No agents"],
      ["m9", "planned", "In the new plan", "No agents"],
    ]);
    expect(card(map, "m6").why).toBe("Replaced by the new plan");
    expect(card(map, "m2").revision?.reason).toBe("Ya existe /api/session.");

    const build = card(map, "m3");
    expect(
      build.groups.map(({ name, done, total, parallel, agents }) => [
        name,
        `${done}/${total}`,
        parallel,
        agents.map(({ agent: { id }, children }) => [id, children.map((child) => child.agent.id)]),
      ]),
    ).toEqual([
      [
        "Backend",
        "3/4",
        true,
        [
          ["a3", ["a3a"]],
          ["a4", []],
          ["a5", []],
        ],
      ],
      [
        "UI",
        "2/2",
        true,
        [
          ["a1", []],
          ["a2", []],
        ],
      ],
    ]);

    const live = card(map, "m7");
    expect(live.live).toBe(true);
    expect(live.endMs).toBeNull();
    expect(
      flattenAgents(live.groups.flatMap(({ agents }) => agents)).map(({ agent, status, ask }) => [
        agent.id,
        status,
        agentLine(ask, null, agent),
      ]),
    ).toEqual([
      ["a7", "needs-you", "Wants to run pnpm db:reset"],
      ["a8", "needs-you", "Asks you for GITHUB_CLIENT_SECRET"],
      ["a9", "done", null],
    ]);
    expect(map.stats).toMatchObject({
      done: 5,
      total: 8,
      agents: 10,
      running: 2,
      needsYou: 2,
      endMs: null,
    });
  });

  it("puts agents that ran before the first plan on their own node, outside the counts", () => {
    const { milestoneId: _unstamped, ...early } = agent("a0", "m1", "completed", 2, 8);
    const map = derive(
      { ...OAUTH, subagents: [early as never, ...OAUTH.subagents] },
      OAUTH_ITEMS,
      OAUTH_ASKS,
    );
    expect(rows(map).slice(0, 3)).toEqual([
      ["you", 0],
      [BEFORE_PLAN_NODE_ID, 0],
      ["m1", 0],
    ]);
    expect(card(map, BEFORE_PLAN_NODE_ID)).toMatchObject({
      title: "Before the plan",
      status: "done",
      milestone: null,
      rollup: { text: "1 agent done" },
    });
    expect(edges(map).slice(0, 2)).toEqual([
      ["you", BEFORE_PLAN_NODE_ID, "live"],
      [BEFORE_PLAN_NODE_ID, "m1", "live"],
    ]);
    expect(map.stats).toMatchObject({ done: 5, total: 8, agents: 11 });
  });

  it("turns titles started again into detours and forks the next plan from the last of them", () => {
    const map = derive(TRACE_GROUPS, TRACE_GROUPS_ITEMS);
    expect(rows(map)).toEqual([
      ["you", 0],
      ["m1", 0],
      ["m3", 1],
      ["m2", 0],
      ["m4", 1],
      ["you-s2", 0],
      ["m5", 0],
      ["m15", 1],
      ...["m6", "m7", "m8", "m9", "m10", "m11", "m12", "m13", "m14"].map((id) => [id, 0]),
    ]);
    expect(edges(map)).toContainEqual(["m4", "you-s2", "live"]);
    expect(map.nodes.find(({ id }) => id === "you-s2")).toMatchObject({
      text: "Segunda ronda, corta.",
    });
    expect(card(map, "m5").subtitle).toBe("New plan, 15m later");
    expect(card(map, "m3").subtitle).toBe("Not in the plan");
    expect(card(map, "m3").groups[0]).toMatchObject({ done: 4, total: 4, parallel: true });
    expect(card(map, "m1").note).toBe("Closed when a second “Construir” started.");
    expect(map.live).toBe(false);
    expect(map.stats).toMatchObject({ done: 5, total: 14, agents: 4, running: 0, needsYou: 0 });
    expect(map.stats.endMs).toBe(BASE_MS + 1239_000);

    const fromPlanItem = derive(TRACE_GROUPS, [
      ...TRACE_GROUPS_ITEMS,
      milestoneItem("plan-2", {
        event: "plan",
        setId: "s2" as never,
        closedMilestoneId: "m1" as never,
      }),
    ]);
    expect(edges(fromPlanItem)).toContainEqual(["m1", "you-s2", "live"]);
  });

  it("shows one row per turn on a thread that never planned", () => {
    const map = deriveMilestoneMap({
      environmentId: ENV,
      projection: {
        runs: [run(1, "completed", 0, 5), run(2, "completed", 66, 71)],
        messages: [
          message("msg-1", "user", "go", 1),
          message("reply-1", "assistant", "## Ran the showcase.\n- Details.", 1),
          message("msg-2", "user", "again", 2),
        ],
        milestones: [],
        subagents: [],
      } as never,
      turnItems: [],
      asks: new Map(),
      coordinatorAsks: false,
    })!;
    expect(map.mode).toBe("turns");
    expect(
      map.nodes.map((node) =>
        node.kind === "milestone"
          ? [node.id, node.col, node.title, node.subtitle, node.note, node.status]
          : [],
      ),
    ).toEqual([
      ["run-1", 0, "go", "Turn 1", "Ran the showcase. Details.", "done"],
      ["run-2", 0, "again", "Turn 2", null, "done"],
    ]);
    expect(edges(map)).toEqual([["run-1", "run-2", "live"]]);
  });
});

describe("agentLine", () => {
  const done = { status: "completed", result: "## Fase 1\n- `ok`", progress: "Reading" } as const;
  const running = { ...done, status: "running" } as const;
  it.each([
    [{ kind: "approval", command: "pnpm db:reset" }, null, done, "Wants to run pnpm db:reset"],
    [
      { kind: "secret", label: "GITHUB_CLIENT_SECRET" },
      { summary: "Ran tests" },
      done,
      "Asks you for GITHUB_CLIENT_SECRET",
    ],
    [null, { summary: "Read", detail: "src/auth/session.ts" }, done, "Read · src/auth/session.ts"],
    [null, null, done, "Fase 1 ok"],
    [null, null, running, "Reading"],
    [null, null, { status: "completed", result: null }, null],
  ] as const)("%o with %o and %o reads %s", (ask, action, agent, expected) => {
    expect(agentLine(ask, action, agent)).toBe(expected);
  });
});
