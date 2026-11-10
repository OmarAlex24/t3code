import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

type MilestoneItem = Extract<OrchestrationV2TurnItem, { readonly type: "milestone" }>;

const EVENT_WORD: Record<MilestoneItem["event"], string> = {
  plan: "planned",
  started: "started",
  changed: "changed",
  done: "done",
  dropped: "dropped",
  post: "posted",
};

/** Where a milestone transition happened in the chat; the milestones view jumps here. */
export function MilestoneDivider(props: { readonly item: MilestoneItem }) {
  const { item } = props;
  const planCount = item.planned?.length ?? 0;
  return (
    <div
      role="separator"
      data-milestone-item={item.id}
      className="flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors duration-500 data-[revealed]:bg-primary/12"
    >
      <span aria-hidden className="h-px flex-1 bg-border/70" />
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          item.event === "done" || item.event === "started"
            ? item.event === "done"
              ? "bg-success"
              : "bg-info"
            : item.event === "changed"
              ? "border border-warning"
              : "border border-muted-foreground/60",
        )}
      />
      <span className="min-w-0 truncate">
        {item.event === "plan" ? (
          <>
            <span className="font-medium text-foreground/85">Plan</span> · {planCount}{" "}
            {planCount === 1 ? "milestone" : "milestones"}
          </>
        ) : (
          <>
            <span className="font-medium text-foreground/85">{item.title ?? "Milestone"}</span> ·{" "}
            {EVENT_WORD[item.event]}
          </>
        )}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border/70" />
    </div>
  );
}
