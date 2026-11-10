import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, XIcon } from "lucide-react";
import { useEffect } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { hostRightPanel } from "../../rightPanelStore";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  useThreadStatus,
} from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BackgroundThreadContext } from "./backgroundThread";

/** A subagent's chat as a tab beside its coordinator, so the milestones view stays in sight. */
export default function SubagentPane(props: {
  readonly parentRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly parentPanel: SideChatParentPanel;
  readonly onClose: () => void;
}) {
  const { parentRef, threadId } = props;
  const threadRef = scopeThreadRef(parentRef.environmentId, threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the parent panel as host in the panel store
  useEffect(
    () => hostRightPanel(scopeThreadRef(parentRef.environmentId, threadId), parentRef),
    [parentRef, threadId],
  );
  // Idle subagents are left out of the shell, so the thread detail decides whether it exists.
  const shell = useQuietThreadShell(threadRef);
  const deleted = useThreadStatus(threadRef) === "deleted";
  const subagentTitle = useQuietThreadProjection(parentRef)?.projection.subagents.find(
    (subagent) => subagent.childThreadId === threadId,
  )?.title;
  const title = shell?.title ?? (subagentTitle ? formatSubagentDisplayTitle(subagentTitle) : null);
  const navigate = useNavigate();

  return (
    // Marked as a side pane so the coordinator's chat ignores keys and drops that start here.
    <div data-side-chat-pane className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title ?? "Subagent"}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Open full chat"
                disabled={deleted}
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(threadRef),
                  })
                }
              >
                <ArrowUpRightIcon />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Open full chat</TooltipPopup>
        </Tooltip>
        <Button variant="ghost" size="icon-xs" aria-label="Close subagent" onClick={props.onClose}>
          <XIcon />
        </Button>
      </div>
      {deleted ? (
        <p className="p-3 text-xs text-muted-foreground">This subagent's chat is gone.</p>
      ) : (
        <BackgroundThreadContext value>
          <ComposerHandleContext value={null}>
            <ChatView
              environmentId={parentRef.environmentId}
              threadId={threadId}
              routeKind="server"
              embedded={props.parentPanel}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      )}
    </div>
  );
}
