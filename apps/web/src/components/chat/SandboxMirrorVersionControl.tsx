import { useAtomValue } from "@effect/atom-react";
import { isSandboxMirrorThread } from "@t3tools/client-runtime/state/sandbox-mirror";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { GitBranchIcon } from "lucide-react";

import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { useQuietThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";

import { MiddleTruncate } from "../ui/middle-truncate";
import { ThreadDetailsLinkedPrRows } from "./ThreadDetailsPrRows";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";

/**
 * A sandbox chat's branch and pull requests on its host mirror, whose own folder has neither: the
 * host reads them from the sandbox's thread (`sandboxes.subscribeThreadMirror`), paired or not.
 */
export function SandboxMirrorVersionControl({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useQuietThreadShell(threadRef);
  const mirror = useAtomValue(
    serverEnvironment.sandboxesThreadMirrorValue(
      thread !== null && isSandboxMirrorThread(thread) ? threadRef : null,
    ),
  );
  const openPrLink = useOpenPrLink(threadRef);
  if (mirror === null) return null;
  return (
    <>
      {mirror.branch ? (
        <span
          className={cn("inline-flex items-center", THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS)}
          aria-label={`Branch on the sandbox: ${mirror.branch}`}
        >
          <GitBranchIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn("min-w-0 flex-1", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            <MiddleTruncate value={mirror.branch} variant="cap-aligned" className="w-full" />
          </span>
        </span>
      ) : null}
      <ThreadDetailsLinkedPrRows
        environmentId={threadRef.environmentId}
        links={mirror.pullRequests ?? []}
        onOpenLink={openPrLink}
      />
    </>
  );
}
