import type { ScopedThreadRef } from "@t3tools/contracts";
import { GitBranchIcon, MessageSquareIcon } from "lucide-react";

import { selectThreadViewMode, useThreadViewModeStore } from "../../threadViewModeStore";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Chat | Milestones for one thread; the choice is remembered per thread. */
export function ThreadViewToggle(props: {
  readonly threadRef: ScopedThreadRef;
  readonly shortcutLabel: string | null;
}) {
  const mode = useThreadViewModeStore((state) => selectThreadViewMode(state, props.threadRef));
  const setMode = useThreadViewModeStore((state) => state.setMode);
  const hint = props.shortcutLabel === null ? "" : ` (${props.shortcutLabel})`;
  return (
    <ToggleGroup
      aria-label="Thread view"
      className="shrink-0"
      variant="segmented"
      value={[mode]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "chat" || next === "milestones") setMode(props.threadRef, next);
      }}
    >
      <Tooltip>
        <TooltipTrigger render={<Toggle aria-label="Chat" value="chat" />}>
          <MessageSquareIcon className="size-3.5" />
          <span className="max-md:hidden">Chat</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">Chat{mode === "milestones" ? hint : ""}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<Toggle aria-label="Milestones" value="milestones" />}>
          <GitBranchIcon className="size-3.5" />
          <span className="max-md:hidden">Milestones</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">Milestones{mode === "chat" ? hint : ""}</TooltipPopup>
      </Tooltip>
    </ToggleGroup>
  );
}
