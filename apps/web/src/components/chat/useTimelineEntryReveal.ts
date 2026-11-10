import type { LegendListRef } from "@legendapp/list/react";
import { type RefObject, useEffect, useRef } from "react";

import type { TimelineEntry } from "../../session-logic";
import { toastManager } from "../ui/toast";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface TimelineEntryReveal {
  readonly entryId: string;
  readonly requestId: number;
}

const REVEAL_HIGHLIGHT_MS = 1600;

function highlightEntry(container: HTMLElement | null, entryId: string) {
  const element = container?.querySelector(`[data-milestone-item="${CSS.escape(entryId)}"]`);
  if (!element) return;
  element.setAttribute("data-revealed", "");
  window.setTimeout(() => element.removeAttribute("data-revealed"), REVEAL_HIGHLIGHT_MS);
}

/**
 * Brings one timeline entry into view and flashes it, paging history through the entry first when
 * it is older than what is loaded. Each request settles once: revealed, hidden, or gone.
 */
export function useTimelineEntryReveal({
  reveal,
  entries,
  rows,
  listRef,
  listReady,
  container,
  historyControls,
  reducedMotion,
  onManualNavigation,
  onSettled,
}: {
  reveal: TimelineEntryReveal | null;
  entries: ReadonlyArray<TimelineEntry>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: RefObject<LegendListRef | null>;
  listReady: boolean;
  container: HTMLElement | null;
  historyControls: MessagesTimelineHistoryControls | undefined;
  reducedMotion: boolean;
  onManualNavigation: () => void;
  onSettled: ((requestId: number) => void) | undefined;
}) {
  const pagedRef = useRef<{ requestId: number | null; cursors: Set<string> }>({
    requestId: null,
    cursors: new Set(),
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pages history toward the requested entry, then scrolls the list to it after commit
  useEffect(() => {
    if (reveal === null || !listReady) return;
    if (pagedRef.current.requestId !== reveal.requestId) {
      pagedRef.current = { requestId: reveal.requestId, cursors: new Set() };
    }
    const settle = () => onSettled?.(reveal.requestId);
    const rowIndex = rows.findIndex((row) => row.id === reveal.entryId);
    if (rowIndex >= 0) {
      onManualNavigation();
      const list = listRef.current;
      settle();
      if (!list) return;
      void list
        .scrollToIndex({ index: rowIndex, animated: !reducedMotion, viewOffset: 24 })
        .then(() => highlightEntry(container, reveal.entryId));
      return;
    }
    // Loaded but not shown as its own row (a filtered view): nothing to scroll to.
    if (entries.some((entry) => entry.id === reveal.entryId)) return settle();
    if (historyControls?.loading) return;
    if (!historyControls?.hasMoreHistory || historyControls.error !== null) {
      toastManager.add({
        type: "warning",
        title: "Could not find that point in the chat",
        description: "It may have been rolled back or removed.",
      });
      return settle();
    }
    // One page request per oldest loaded entry; the next render retries once the page lands.
    const cursor = entries[0]?.id ?? "first";
    if (pagedRef.current.cursors.has(cursor)) return;
    pagedRef.current.cursors.add(cursor);
    historyControls.onLoadEarlier(reveal.entryId);
  }, [
    container,
    entries,
    historyControls,
    listReady,
    listRef,
    onManualNavigation,
    onSettled,
    reducedMotion,
    reveal,
    rows,
  ]);
}
