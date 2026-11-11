import type { MilestoneBoardItem } from "@t3tools/client-runtime/state/thread-milestone-board";
import type {
  GraphEdge,
  MapAgent,
  MapBubble,
  MapGroup,
  MapMilestone,
  MilestoneMap,
} from "@t3tools/client-runtime/state/thread-milestone-map";

export const CARD_W = 288;
const FULL_H = 108;
const COMPACT_H = 40;
const MSG_H = 40;
const GAP = 12;
const LANE_W = 18;
const RAIL_X = 18;
const COL_GAP = 44;
const INDENT = 32;
const R = 8;
/** Below this canvas width a milestone's agents nest under it instead of fanning out right. */
export const WIDE_MIN_WIDTH = 690;

export interface NodeBox {
  readonly x: number;
  readonly top: number;
  readonly h: number;
  readonly dotX: number;
  readonly dotY: number;
  readonly full: boolean;
}

export type DetailPart =
  | { readonly kind: "revision"; readonly x: number; readonly y: number }
  | {
      readonly kind: "note";
      readonly note: "dropped" | "not-started" | "no-agents";
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: "group"; readonly group: MapGroup; readonly x: number; readonly y: number }
  | {
      readonly kind: "agent";
      readonly agent: MapAgent;
      readonly x: number;
      readonly y: number;
      readonly width: number;
    }
  | { readonly kind: "posts"; readonly count: number; readonly x: number; readonly y: number }
  | {
      readonly kind: "board";
      readonly item: MilestoneBoardItem;
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: "comment"; readonly x: number; readonly y: number };

export interface MapLayout {
  readonly boxes: ReadonlyMap<string, NodeBox>;
  readonly rail: ReadonlyArray<{ readonly edge: GraphEdge; readonly d: string }>;
  readonly detail: {
    readonly parts: ReadonlyArray<DetailPart>;
    readonly wires: ReadonlyArray<string>;
    readonly ports: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  } | null;
  readonly width: number;
  readonly height: number;
}

/** Rounded orthogonal wires: out of a port, then into the child's title row. */
function wireRight(x1: number, y1: number, x2: number, y2: number) {
  const mid = x1 + COL_GAP / 2;
  if (Math.abs(y2 - y1) < 1) return `M${x1},${y1} H${x2}`;
  const dir = y2 > y1 ? 1 : -1;
  return `M${x1},${y1} H${mid - R} Q${mid},${y1} ${mid},${y1 + dir * R} V${y2 - dir * R} Q${mid},${y2} ${mid + R},${y2} H${x2}`;
}
const wireDown = (x1: number, y1: number, x2: number, y2: number) =>
  `M${x1},${y1} V${y2 - R} Q${x1},${y2} ${x1 + R},${y2} H${x2}`;
function wireRail(x1: number, y1: number, x2: number, y2: number) {
  if (x1 === x2) return `M${x1},${y1} V${y2}`;
  const r = 7;
  const ym = y2 - 20;
  const dir = x2 > x1 ? 1 : -1;
  return `M${x1},${y1} V${ym - r} Q${x1},${ym} ${x1 + dir * r},${ym} H${x2 - dir * r} Q${x2},${ym} ${x2},${ym + r} V${y2}`;
}

const BOARD_H: Record<MilestoneBoardItem["kind"], number> = { post: 84, visual: 124, comment: 70 };

function buildDetail(
  node: MapMilestone,
  card: NodeBox,
  origin: { readonly x: number; readonly y: number },
  wide: boolean,
  board: ReadonlyArray<MilestoneBoardItem>,
  commentable: boolean,
) {
  const parts: Array<DetailPart> = [];
  const wires: Array<string> = [];
  const port = wide
    ? { x: card.x + CARD_W, y: card.top + card.h / 2 }
    : { x: card.x + 22, y: card.top + card.h };
  const ports = [port];
  const { x } = origin;
  let { y } = origin;
  const link = (targetY: number) =>
    wires.push(wide ? wireRight(port.x, port.y, x, targetY) : wireDown(port.x, port.y, x, targetY));
  if (node.revision !== null) {
    parts.push({ kind: "revision", x, y });
    link(y + 20);
    y += 68;
  }
  if (!node.started || node.agentCount === 0) {
    parts.push({
      kind: "note",
      note: node.started ? "no-agents" : node.status === "dropped" ? "dropped" : "not-started",
      x,
      y,
    });
    link(y + 18);
    y += 50;
  } else {
    const named = node.groups.some(({ name }) => name !== null);
    for (const group of node.groups) {
      if (named) {
        parts.push({ kind: "group", group, x: x + 2, y });
        y += 26;
      }
      for (const agent of group.agents) {
        parts.push({ kind: "agent", agent, x, y, width: CARD_W });
        link(y + 26);
        const parentTop = y;
        y += FULL_H + 10;
        for (const child of agent.children) {
          const childPort = { x: x + 22, y: parentTop + FULL_H };
          ports.push(childPort);
          parts.push({ kind: "agent", agent: child, x: x + INDENT, y, width: CARD_W - INDENT });
          wires.push(wireDown(childPort.x, childPort.y, x + INDENT, y + 26));
          y += FULL_H + 10;
        }
      }
    }
  }
  if (board.length > 0 || node.started) {
    y += 6;
    if (board.length > 0) {
      parts.push({ kind: "posts", count: board.length, x: x + 2, y });
      y += 26;
    }
    for (const item of board) {
      parts.push({ kind: "board", item, x, y });
      y += BOARD_H[item.kind];
    }
    if (node.started && commentable) {
      parts.push({ kind: "comment", x, y });
      y += 44;
    }
  }
  return { parts, wires, ports, bottom: y };
}

/**
 * Where every card, dot and line of the map sits. A selected milestone's agents and posts fan out
 * to its right, or nest under it when the canvas is narrow.
 */
export function layoutMilestoneMap(input: {
  readonly map: MilestoneMap;
  readonly selectedId: string | null;
  readonly wide: boolean;
  readonly board: (milestoneId: string) => ReadonlyArray<MilestoneBoardItem>;
  readonly commentable: boolean;
}): MapLayout {
  const { map, selectedId, wide } = input;
  const cardX = RAIL_X + map.maxCol * LANE_W + 22;
  const colX = cardX + CARD_W + COL_GAP;
  const boxes = new Map<string, NodeBox>();
  let y = 18;
  let detail: ReturnType<typeof buildDetail> | null = null;
  for (const node of map.nodes) {
    const full = node.kind === "milestone" && node.started;
    const h = node.kind === "you" ? MSG_H : full ? FULL_H : COMPACT_H;
    const box = {
      x: cardX,
      top: y,
      h,
      dotX: RAIL_X + node.col * LANE_W,
      dotY: y + (full ? 26 : h / 2),
      full,
    };
    boxes.set(node.id, box);
    y += h + GAP;
    if (node.kind === "milestone" && node.id === selectedId) {
      detail = buildDetail(
        node,
        box,
        wide ? { x: colX, y: box.top } : { x: cardX + INDENT, y },
        wide,
        input.board(node.id),
        input.commentable && node.milestone !== null,
      );
      if (!wide) y = detail.bottom + GAP;
    }
  }
  const rail = map.edges.flatMap((edge) => {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    return from === undefined || to === undefined
      ? []
      : [{ edge, d: wireRail(from.dotX, from.dotY, to.dotX, to.dotY) }];
  });
  return {
    boxes,
    rail,
    detail,
    width: (wide && detail !== null ? colX + CARD_W : cardX + CARD_W + (detail ? INDENT : 0)) + 14,
    height: Math.max(y, detail?.bottom ?? 0) + 24,
  };
}

export const isMilestoneNode = (node: MapMilestone | MapBubble): node is MapMilestone =>
  node.kind === "milestone";
