import { linkRequestTargetName } from "@t3tools/client-runtime/link-request";
import {
  deriveMilestoneMap,
  flattenAgents,
  type MapGroup,
  type MapMilestone,
} from "@t3tools/client-runtime/state/thread-milestone-map";
import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { GitBranchIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useThreadViewModeStore } from "../../threadViewModeStore";
import { AgentElapsed } from "./AgentElapsed";
import { type CoordinatorAsk, useAgentAsks } from "./AgentAsks";
import { MilestoneStatusIcon } from "./MilestoneMapCards";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const iso = (ms: number | null) =>
  ms === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));

function askLine(ask: CoordinatorAsk): string {
  switch (ask.kind) {
    case "card":
      return `Asks you for ${
        ask.item.type === "secret_request" ? ask.item.label : linkRequestTargetName(ask.item)
      }`;
    case "approval":
      return "Needs your approval";
    case "input":
      return "Has a question for you";
  }
}

const failed = (group: MapGroup) =>
  flattenAgents(group.agents).filter(({ status }) => status === "failed").length;
const needsYou = (group: MapGroup) =>
  flattenAgents(group.agents).some(({ status }) => status === "needs-you");

function Duration(props: { readonly row: MapMilestone }) {
  const { row } = props;
  if (row.startMs === null || row.status === "dropped") return null;
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      <AgentElapsed
        compact
        agent={{
          status: row.endMs === null ? "running" : "completed",
          startedAt: iso(row.startMs),
          completedAt: iso(row.endMs),
        }}
      />
    </span>
  );
}

/**
 * The milestone plan at the top of thread details, so Chat keeps it in view: progress, each
 * milestone, and how the live one's groups are doing. Selecting one opens Milestones on it.
 */
export function ThreadPlanSection(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "subagents" | "milestones" | "messages"
  >;
  readonly coordinatorAsk: CoordinatorAsk | null;
  readonly density: "full" | "compact" | "essential";
}) {
  const asks = useAgentAsks(props.threadRef);
  const openMilestones = useThreadViewModeStore((state) => state.openMilestones);
  const map = deriveMilestoneMap({
    environmentId: props.threadRef.environmentId,
    projection: props.projection,
    turnItems: [],
    asks,
    coordinatorAsks: props.coordinatorAsk !== null,
  });
  if (map === null || map.mode !== "milestones") return null;
  const currentSetId = props.projection.milestones.at(-1)?.setId;
  const rows = map.nodes
    .filter((node): node is MapMilestone => node.kind === "milestone")
    .filter(({ milestone }) => milestone !== null && milestone.setId === currentSetId);
  const segments = rows.filter(({ status }) => status !== "dropped");
  const activeIndex = segments.findIndex(({ live }) => live);
  const position =
    activeIndex === -1
      ? segments.filter(({ status }) => status === "done").length
      : activeIndex + 1;
  return (
    <ThreadDetailsSection headingId="thread-details-plan-heading" title="Plan" showHeading={false}>
      <div className="px-2.5 pt-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-foreground">Plan</span>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {position} of {segments.length} ·{" "}
            <AgentElapsed
              agent={{
                status: map.stats.endMs === null ? "running" : "completed",
                startedAt: iso(map.stats.startMs),
                completedAt: iso(map.stats.endMs),
              }}
            />
          </span>
        </div>
        <div aria-hidden className="mt-2 mb-1.5 flex h-[5px] gap-0.5">
          {segments.map((row) => (
            <span
              key={row.id}
              className={cn(
                "flex-1 rounded-xs",
                row.status === "done" ? "bg-success/45" : row.live ? "bg-info" : "bg-foreground/8",
              )}
            />
          ))}
        </div>
        {props.density === "essential" ? null : (
          <div data-thread-details-plan-list className="-mx-1.5 max-h-72 overflow-y-auto px-1.5">
            {rows.map((row) => (
              <div key={row.id}>
                <button
                  type="button"
                  onClick={() => openMilestones(props.threadRef, { rowId: row.id })}
                  className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none hover:bg-foreground/4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <MilestoneStatusIcon status={row.status} />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      row.live && "font-semibold",
                      row.status === "planned" && "text-muted-foreground",
                      row.status === "dropped" && "text-muted-foreground/70 line-through",
                    )}
                  >
                    {row.title}
                  </span>
                  <Duration row={row} />
                </button>
                {!row.live ? null : props.coordinatorAsk !== null ? (
                  <div className="mt-0.5 mb-1.5 ml-6 flex items-center gap-1.5 text-xs text-warning">
                    <TriangleAlertIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{askLine(props.coordinatorAsk)}</span>
                  </div>
                ) : row.agentCount === 0 ? null : (
                  <div className="mt-0.5 mb-1.5 ml-6 grid gap-0.75 text-xs text-muted-foreground">
                    {row.groups.map((group) => (
                      <div key={group.name ?? ""} className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-13 truncate">{group.name ?? "Agents"}</span>
                        <span className="relative h-[3px] max-w-[90px] flex-1 overflow-hidden rounded-full bg-foreground/8">
                          <span
                            className="absolute inset-y-0 left-0 rounded-full bg-info"
                            style={{ width: `${(group.done / group.total) * 100}%` }}
                          />
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {group.done}/{group.total}
                          {failed(group) > 0 ? (
                            <span className="text-destructive"> · {failed(group)} failed</span>
                          ) : null}
                          {needsYou(group) ? (
                            <span className="text-warning"> · needs you</span>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => openMilestones(props.threadRef, null)}
          className="mt-1.5 flex items-center gap-1.5 rounded-sm text-xs text-info outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <GitBranchIcon className="size-3.5" />
          Open in Milestones
        </button>
      </div>
    </ThreadDetailsSection>
  );
}
