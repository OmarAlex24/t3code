import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import {
  deriveMilestoneBoards,
  type MilestoneBoardItem,
} from "@t3tools/client-runtime/state/thread-milestone-board";
import {
  deriveMilestoneMap,
  type MapMilestone,
  type MilestoneMap,
} from "@t3tools/client-runtime/state/thread-milestone-map";
import type {
  OrchestrationV2Milestone,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ImageIcon,
  MessageSquareIcon,
  MinusIcon,
  PlusIcon,
  ScanIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { threadFamilies } from "../../state/threads";
import { useThreadViewModeStore } from "../../threadViewModeStore";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { AgentElapsed } from "./AgentElapsed";
import { type CoordinatorAsk, focusAgentAsk, useAgentAsks } from "./AgentAsks";
import { AgentCard, MilestoneCard, ProviderTile, RailDot } from "./MilestoneMapCards";
import {
  CARD_W,
  type DetailPart,
  isMilestoneNode,
  layoutMilestoneMap,
  type MapLayout,
  WIDE_MIN_WIDTH,
} from "./milestoneMapLayout";

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "subagents" | "milestones" | "messages"
>;
interface Camera {
  readonly x: number;
  readonly y: number;
  readonly s: number;
}

const MIN_SCALE = 0.35;
const MAX_SCALE = 1.6;
const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
const iso = (ms: number | null) =>
  ms === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));
const plural = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;

/** Zooming in, from the view or the Plan panel, takes focus so Esc and the arrows reach the view. */
function focusZoomedPanel(node: HTMLDivElement | null) {
  const active = document.activeElement;
  if (
    node === null ||
    (active instanceof HTMLElement &&
      (active.isContentEditable || active.closest("input, textarea, select") !== null))
  )
    return;
  node.focus({ preventScroll: true });
}

const RAIL_STROKE = {
  live: "stroke-info/45 [stroke-width:1.6]",
  future: "stroke-foreground/20 [stroke-width:1.4] [stroke-dasharray:3_4]",
  dropped: "stroke-foreground/20 [stroke-width:1.4] [stroke-dasharray:1_4]",
} as const;

function MapHeader(props: {
  readonly map: MilestoneMap;
  readonly lead: ReactNode;
  readonly narrow: boolean;
  readonly selected: {
    readonly node: MapMilestone;
    readonly index: number;
    readonly count: number;
  } | null;
  readonly onZoomOut: () => void;
  readonly onStep: (delta: number) => void;
}) {
  const { map, selected } = props;
  const turns = map.mode === "turns";
  if (selected !== null) {
    return (
      <div className="flex h-13 shrink-0 items-center gap-2.5 border-b bg-background px-3.5">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={turns ? "All turns" : "All milestones"}
          onClick={props.onZoomOut}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
          <span className="shrink-2 truncate font-medium text-muted-foreground">
            {turns ? "All turns" : "All milestones"}
          </span>
          <span className="shrink-0 font-normal text-muted-foreground/60">/</span>
          <span className="min-w-0 truncate">{selected.node.title}</span>
        </div>
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
          {selected.index + 1} of {selected.count}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Previous"
          disabled={selected.index === 0}
          onClick={() => props.onStep(-1)}
        >
          <ChevronUpIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Next"
          disabled={selected.index === selected.count - 1}
          onClick={() => props.onStep(1)}
        >
          <ChevronDownIcon />
        </Button>
        <Kbd variant="outline">Esc</Kbd>
      </div>
    );
  }
  const { stats } = map;
  const items = [
    props.narrow ? null : (
      <span key="done">
        {turns ? plural(stats.total, "turn") : `${stats.done} of ${stats.total} done`}
      </span>
    ),
    stats.agents > 0 && !props.narrow ? (
      <span key="agents">{plural(stats.agents, "agent")}</span>
    ) : null,
    stats.running > 0 && !props.narrow ? <span key="running">{stats.running} running</span> : null,
    stats.needsYou > 0 ? (
      <span key="needs" className="text-warning">
        {stats.needsYou} need{stats.needsYou === 1 ? "s" : ""} you
      </span>
    ) : null,
    <span key="time" className="font-semibold text-foreground">
      <AgentElapsed
        agent={{
          status: stats.endMs === null ? "running" : "completed",
          startedAt: iso(stats.startMs),
          completedAt: iso(stats.endMs),
        }}
      />
    </span>,
  ];
  return (
    <div className="flex h-13 shrink-0 items-center gap-2.5 border-b bg-background px-3.5">
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
        {props.lead}
        <span className="min-w-0 truncate">{map.title ?? "Plan"}</span>
      </div>
      <div className="flex shrink-0 gap-3.5 text-sm whitespace-nowrap text-muted-foreground tabular-nums">
        {items}
      </div>
    </div>
  );
}

function DetailNote(props: { readonly children: ReactNode; readonly style: CSSProperties }) {
  return (
    <div
      style={props.style}
      className="absolute w-72 rounded-xl border border-dashed px-3 py-2.25 text-xs text-muted-foreground motion-safe:animate-map-enter [&_b]:font-medium [&_b]:text-foreground/80"
    >
      {props.children}
    </div>
  );
}

function DetailLabel(props: {
  readonly name: string;
  readonly text: string;
  readonly style: CSSProperties;
}) {
  return (
    <div
      style={props.style}
      className="absolute flex h-5 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground motion-safe:animate-map-enter"
    >
      <b className="font-semibold text-foreground/80">{props.name}</b>
      <span>{props.text}</span>
    </div>
  );
}

function BoardCard(props: {
  readonly item: MilestoneBoardItem;
  readonly lead: ReactNode;
  readonly style: CSSProperties;
  readonly onJump: (entryId: string) => void;
}) {
  const { item } = props;
  const base =
    "absolute grid w-72 gap-1.25 rounded-xl border px-3 py-2.5 text-sm text-foreground/78 motion-safe:animate-map-enter";
  if (item.kind === "visual") {
    return (
      <button
        type="button"
        style={props.style}
        onClick={() => props.onJump(item.id)}
        aria-label={`Show ${item.title} in chat`}
        className={cn(
          base,
          "bg-card text-left shadow-xs/5 hover:shadow-lg/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
        )}
      >
        <span className="grid h-18.5 place-items-center rounded-lg border bg-linear-135 from-info/14 to-success/10 text-muted-foreground">
          <ImageIcon className="size-3.5" />
        </span>
        <span className="truncate text-xs text-muted-foreground">{item.title}</span>
      </button>
    );
  }
  if (item.kind === "comment") {
    return (
      <div style={props.style} className={cn(base, "border-transparent bg-foreground/6")}>
        <b className="text-xs font-medium text-foreground">You</b>
        <p className="line-clamp-2">{item.text}</p>
      </div>
    );
  }
  const images = item.attachments.length;
  return (
    <button
      type="button"
      style={props.style}
      onClick={() => props.onJump(item.id)}
      aria-label="Show this post in chat"
      className={cn(
        base,
        "bg-card text-left shadow-xs/5 hover:shadow-lg/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
      )}
    >
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {props.lead}
        Coordinator
        {images > 0 ? (
          <span className="ml-auto inline-flex items-center gap-1">
            <ImageIcon className="size-3" />
            {images}
          </span>
        ) : null}
      </span>
      {item.text === null ? null : <span className="line-clamp-2">{item.text}</span>}
    </button>
  );
}

function DetailPartView(props: {
  readonly part: DetailPart;
  readonly node: MapMilestone;
  readonly turns: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly leadSmall: ReactNode;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onJump: (entryId: string) => void;
  readonly onComment: ((milestone: OrchestrationV2Milestone) => void) | null;
}) {
  const { part, node } = props;
  const style = { left: part.x, top: part.y };
  switch (part.kind) {
    case "revision":
      return (
        <DetailNote style={style}>
          <b>Changed from “{node.revision?.previousTitle}”.</b> {node.revision?.reason}
        </DetailNote>
      );
    case "note":
      return (
        <DetailNote style={style}>
          {part.note === "dropped" ? (
            <>
              <b>Dropped.</b> {node.why ?? ""}
            </>
          ) : part.note === "not-started" ? (
            <>
              <b>Not started yet.</b> Its agents show up here once it starts.
            </>
          ) : (
            <>
              <b>No agents.</b> The {props.turns ? "agent" : "coordinator"} did this one itself.
            </>
          )}
        </DetailNote>
      );
    case "group":
      return (
        <DetailLabel
          style={style}
          name={part.group.name ?? "Other"}
          text={`${part.group.done}/${part.group.total} done${part.group.parallel ? " · in parallel" : ""}`}
        />
      );
    case "agent":
      return (
        <AgentCard
          entry={part.agent}
          threadRef={props.threadRef}
          style={style}
          width={part.width}
          onOpenThread={props.onOpenThread}
          onAnswer={focusAgentAsk}
        />
      );
    case "posts":
      return <DetailLabel style={style} name="Posts" text={String(part.count)} />;
    case "board":
      return (
        <BoardCard item={part.item} lead={props.leadSmall} style={style} onJump={props.onJump} />
      );
    case "comment": {
      const { milestone } = node;
      const comment = props.onComment;
      if (milestone === null || comment === null) return null;
      return (
        <button
          type="button"
          style={style}
          onClick={() => comment(milestone)}
          className="absolute flex h-8.5 w-72 items-center gap-1.75 rounded-lg border border-dashed px-2.75 text-xs text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none motion-safe:animate-map-enter"
        >
          <MessageSquareIcon className="size-3.25" />
          Comment on this milestone…
        </button>
      );
    }
  }
}

function MapWorld(props: {
  readonly map: MilestoneMap;
  readonly layout: MapLayout;
  readonly selected: MapMilestone | null;
  readonly threadRef: ScopedThreadRef;
  readonly leadSmall: ReactNode;
  readonly leadDriver: Parameters<typeof MilestoneCard>[0]["lead"];
  readonly onSelect: (id: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onJump: (entryId: string) => void;
  readonly onComment: ((milestone: OrchestrationV2Milestone) => void) | null;
}) {
  const { map, layout, selected } = props;
  const faded = (id: string) => selected !== null && id !== selected.id;
  const fadeClass = "transition-opacity duration-200 motion-reduce:transition-none";
  return (
    <>
      <svg
        aria-hidden
        width={layout.width}
        height={layout.height}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute top-0 left-0 overflow-visible"
      >
        {layout.rail.map(({ edge, d }) => (
          <path
            key={`${edge.from}>${edge.to}`}
            d={d}
            className={cn(RAIL_STROKE[edge.style], fadeClass, faded(edge.to) && "opacity-42")}
          />
        ))}
        {layout.detail?.wires.map((d) => (
          <path key={d} d={d} className={RAIL_STROKE.live} />
        ))}
        {layout.detail?.ports.map((port) => (
          <circle
            key={`${port.x},${port.y}`}
            cx={port.x}
            cy={port.y}
            r={4}
            className="fill-card stroke-info/45 [stroke-width:1.6]"
          />
        ))}
      </svg>
      {map.nodes.map((node) => {
        const box = layout.boxes.get(node.id)!;
        const dot = (
          <span key={`dot:${node.id}`} className={cn(fadeClass, faded(node.id) && "opacity-42")}>
            <RailDot
              status={node.kind === "you" ? "you" : node.status}
              style={{ left: box.dotX, top: box.dotY }}
            />
          </span>
        );
        if (node.kind === "you") {
          return [
            dot,
            <div
              key={node.id}
              style={{ left: box.x, top: box.top, width: CARD_W }}
              className={cn(
                "absolute flex h-10 items-center gap-1.5 overflow-hidden rounded-xl bg-foreground/6 px-3 text-sm whitespace-nowrap text-foreground/78",
                fadeClass,
                selected !== null && "opacity-42",
              )}
            >
              <b className="shrink-0 font-semibold text-foreground">You</b>
              <span className="truncate">{node.text}</span>
            </div>,
          ];
        }
        return [
          dot,
          <MilestoneCard
            key={node.id}
            node={node}
            threadRef={props.threadRef}
            lead={props.leadDriver}
            style={{ left: box.x, top: box.top }}
            selected={selected?.id === node.id}
            faded={faded(node.id)}
            onSelect={() => props.onSelect(node.id)}
          />,
        ];
      })}
      {selected === null || layout.detail === null
        ? null
        : layout.detail.parts.map((part, index) => (
            <DetailPartView
              key={part.kind === "agent" ? part.agent.agent.id : `${part.kind}:${index}`}
              part={part}
              node={selected}
              turns={map.mode === "turns"}
              threadRef={props.threadRef}
              leadSmall={props.leadSmall}
              onOpenThread={props.onOpenThread}
              onJump={props.onJump}
              onComment={props.onComment}
            />
          ))}
    </>
  );
}

/**
 * The thread as a map: milestones down a rail in the order work started, with detours and new
 * plans on their own lanes. Selecting one zooms in and fans its agents and posts out beside it.
 */
export function ThreadMilestonesView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projection: Projection;
  readonly turnItems: ReadonlyArray<ThreadStructureTurnItem>;
  readonly coordinatorAsk: CoordinatorAsk | null;
  readonly bottomInset: number;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** Starts a comment on `milestone` in the composer; null when this client cannot send. */
  readonly onComment: ((milestone: OrchestrationV2Milestone) => void) | null;
}) {
  const { threadRef, projection } = props;
  const environmentId = threadRef.environmentId;
  const asks = useAgentAsks(threadRef);
  const threadId = threadRef.threadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the shell omits finished subagent threads; their family read brings in the rows that hold each agent's last action
  useEffect(
    () => threadFamilies.mount(appAtomRegistry, environmentId, threadId),
    [environmentId, threadId],
  );
  const map = deriveMilestoneMap({
    environmentId,
    projection,
    turnItems: props.turnItems,
    asks,
    coordinatorAsks: props.coordinatorAsk !== null,
  });
  const boards = deriveMilestoneBoards(props.turnItems, (item) =>
    item.textOmitted
      ? (projection.messages.find(({ id }) => id === item.messageId)?.text ?? "")
      : item.text,
  );
  const leadInstance = map?.coordinatorRun?.providerInstanceId ?? null;
  const leadDriver = useAtomValue(
    serverEnvironment.providersValueAtom(environmentId),
    (providers) =>
      providers?.find((provider) => provider.instanceId === leadInstance)?.driver ?? null,
  );
  const storedZoom = useThreadViewModeStore(
    (state) => state.zoomByThreadKey[scopedThreadKey(threadRef)] ?? null,
  );
  const setStoredZoom = useThreadViewModeStore((state) => state.setZoom);
  const revealInChat = useThreadViewModeStore((state) => state.revealInChat);

  const canvasRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const camera = useRef<Camera>({ x: 0, y: 0, s: 1 });
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  // Survives pointerup, so the click that ends a pan doesn't select the card under it.
  const dragged = useRef(false);
  const firstPlace = useRef(true);
  const [scale, setScale] = useState(1);
  const [width, setWidth] = useState(0);

  const milestones = map?.nodes.filter(isMilestoneNode) ?? [];
  const index =
    storedZoom === null ? -1 : milestones.findIndex(({ id }) => id === storedZoom.rowId);
  const selected = milestones[index] ?? null;
  const wide = width >= WIDE_MIN_WIDTH;
  const layout =
    map === null || width === 0
      ? null
      : layoutMilestoneMap({
          map,
          selectedId: selected?.id ?? null,
          wide,
          board: (id) => boards.get(id) ?? [],
          commentable: props.onComment !== null,
        });

  const setCamera = (next: Camera, animate: boolean) => {
    camera.current = next;
    const world = worldRef.current;
    if (world !== null) {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      world.style.transition =
        animate && !reduced ? "transform 320ms cubic-bezier(.22,.8,.24,1)" : "none";
      world.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.s})`;
    }
    setScale(next.s);
  };
  const insets = () => ({ top: 14, bottom: props.bottomInset + 12, side: 12 });
  const place = useEffectEvent((animate: boolean, zoomedId: string | null) => {
    const canvas = canvasRef.current;
    if (canvas === null || layout === null || map === null || zoomedId !== (selected?.id ?? null))
      return;
    const { top, bottom, side } = insets();
    const room = canvas.clientWidth - side * 2;
    const s = selected !== null ? 1 : Math.min(1, Math.max(0.86, room / layout.width));
    const x = side + Math.max(0, (room - layout.width * s) / 2);
    let y = top;
    if (selected !== null) {
      y = top - layout.boxes.get(selected.id)!.top + 4;
    } else if (map.live) {
      const current =
        milestones.find(({ live }) => live) ??
        milestones.findLast(({ endMs }) => endMs !== null) ??
        milestones.at(-1);
      const box = current === undefined ? undefined : layout.boxes.get(current.id);
      if (box !== undefined) {
        y = Math.min(top, canvas.clientHeight - bottom - (box.top + box.h + 30) * s);
      }
    }
    setCamera({ x, y, s }, animate);
    if (selected !== null) focusZoomedPanel(canvas);
  });
  const placed = width > 0;
  const selectedId = selected?.id ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the camera, which lives on the DOM, to the zoomed milestone or the overview whenever the zoom changes
  useLayoutEffect(() => {
    if (!placed) return;
    place(!firstPlace.current, selectedId);
    firstPlace.current = false;
  }, [selectedId, placed]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the canvas width, which picks between fanning agents out and nesting them
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    return observeResize(canvas, ([entry]) => setWidth(entry?.contentRect.width ?? 0));
  }, []);

  const zoomAt = (cx: number, cy: number, factor: number, animate: boolean) => {
    const { x, y, s } = camera.current;
    const next = clampScale(s * factor);
    setCamera({ x: cx - ((cx - x) * next) / s, y: cy - ((cy - y) * next) / s, s: next }, animate);
  };
  const zoomBy = (factor: number) => {
    const canvas = canvasRef.current;
    if (canvas !== null) zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor, true);
  };
  const fitAll = () => {
    const canvas = canvasRef.current;
    if (canvas === null || layout === null) return;
    const { top, bottom, side } = insets();
    const room = canvas.clientWidth - side * 2;
    const s = Math.max(
      MIN_SCALE,
      Math.min(1, room / layout.width, (canvas.clientHeight - top - bottom) / layout.height),
    );
    setCamera({ x: side + Math.max(0, (room - layout.width * s) / 2), y: top, s }, true);
  };
  const onWheel = useEffectEvent((event: WheelEvent) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = canvasRef.current!.getBoundingClientRect();
      zoomAt(
        event.clientX - rect.left,
        event.clientY - rect.top,
        Math.exp(-event.deltaY * 0.01),
        false,
      );
    } else {
      const { x, y, s } = camera.current;
      setCamera({ x: x - event.deltaX, y: y - event.deltaY, s }, false);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- React's wheel listener is passive, and panning and pinch-zoom must stop the page from scrolling
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const listener = (event: WheelEvent) => onWheel(event);
    canvas.addEventListener("wheel", listener, { passive: false });
    return () => canvas.removeEventListener("wheel", listener);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragged.current = false;
    if (event.button !== 0 || (event.target as Element).closest("button, a, input, textarea"))
      return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      cx: camera.current.x,
      cy: camera.current.y,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null) return;
    if (
      !dragged.current &&
      Math.abs(event.clientX - current.x) + Math.abs(event.clientY - current.y) > 4
    ) {
      dragged.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.dragging = "";
    }
    if (!dragged.current) return;
    // Panning writes the transform directly so cards don't re-render per frame.
    camera.current = {
      ...camera.current,
      x: current.cx + event.clientX - current.x,
      y: current.cy + event.clientY - current.y,
    };
    const world = worldRef.current;
    if (world !== null) {
      world.style.transition = "none";
      world.style.transform = `translate(${camera.current.x}px, ${camera.current.y}px) scale(${camera.current.s})`;
    }
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    delete event.currentTarget.dataset.dragging;
    if (dragged.current) setScale(camera.current.s);
  };

  const zoom = (id: string | null) => setStoredZoom(threadRef, id === null ? null : { rowId: id });
  const step = (delta: number) => {
    const next = milestones[index + delta];
    if (next !== undefined) zoom(next.id);
  };
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      selected === null ||
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const target = event.target;
    // Keys reach the view only from the page itself or from inside the view, never from the
    // composer, a dialog or a field.
    if (
      !(target instanceof Element) ||
      (target !== document.body && !canvasRef.current?.parentElement?.contains(target)) ||
      target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
    )
      return;
    if (event.key === "Escape") zoom(null);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowDown" || event.key === "ArrowRight") step(1);
    else return;
    event.preventDefault();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens on the window for Esc and the arrow keys that zoom out and step milestones
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const lead = <ProviderTile driver={leadDriver} size="sm" />;
  const leadSmall = <ProviderTile driver={leadDriver} size="xs" />;
  return (
    <div
      data-thread-milestones-view
      className="relative flex h-full min-h-0 flex-col bg-background"
    >
      {map === null ? null : (
        <MapHeader
          map={map}
          lead={lead}
          narrow={!wide}
          selected={selected === null ? null : { node: selected, index, count: milestones.length }}
          onZoomOut={() => zoom(null)}
          onStep={step}
        />
      )}
      <div
        ref={canvasRef}
        tabIndex={selected === null ? undefined : -1}
        data-milestone-zoom={selected === null ? undefined : ""}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={(event) => {
          // A drag that ends over a card is a pan, not a click on it.
          if (dragged.current) {
            event.stopPropagation();
            event.preventDefault();
          }
        }}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-foreground/[0.022] outline-none data-dragging:cursor-grabbing"
      >
        {map === null ? (
          <div className="px-6 pt-6">
            <h3 className="text-sm font-medium">Describe what you want built</h3>
            <p className="mt-0.5 max-w-120 text-xs text-muted-foreground">
              The coordinator's plan shows up here as milestones while it works.
            </p>
          </div>
        ) : (
          <div ref={worldRef} className="absolute top-0 left-0 origin-top-left">
            {layout === null ? null : (
              <MapWorld
                map={map}
                layout={layout}
                selected={selected}
                threadRef={threadRef}
                leadSmall={leadSmall}
                leadDriver={leadDriver}
                onSelect={zoom}
                onOpenThread={props.onOpenThread}
                onJump={(entryId) => revealInChat(threadRef, entryId)}
                onComment={props.onComment}
              />
            )}
          </div>
        )}
      </div>
      {map === null ? null : (
        <div
          style={{ bottom: props.bottomInset + 12 }}
          className="absolute left-3 z-11 flex flex-col items-center gap-px rounded-lg border bg-card p-0.75 shadow-xs/5"
        >
          <Button size="icon-xs" variant="ghost" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>
            <MinusIcon />
          </Button>
          <span className="py-0.5 text-2xs text-muted-foreground tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <Button size="icon-xs" variant="ghost" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
            <PlusIcon />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Fit everything" onClick={fitAll}>
            <ScanIcon />
          </Button>
        </div>
      )}
    </div>
  );
}
