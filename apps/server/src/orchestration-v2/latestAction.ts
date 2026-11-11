import type {
  OrchestrationV2LatestActionSummary,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  deriveToolActivityPresentation,
  dynamicToolTitle,
  type ToolActivityPresentation,
} from "@t3tools/shared/toolActivity";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";

/** Keep in sync with the latest-tool index and the shell row query in ProjectionStore. */
export const LATEST_ACTION_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
] as const;

const LATEST_ACTION_TEXT_LIMIT = 120;

const clip = (text: string) =>
  text.length > LATEST_ACTION_TEXT_LIMIT
    ? `${text.slice(0, LATEST_ACTION_TEXT_LIMIT - 1).trimEnd()}…`
    : text;

const withoutMcpPrefix = (name: string) => name.replace(/^mcp__.+?__(?=.)/, "");

function presentation(item: OrchestrationV2TurnItem): ToolActivityPresentation | null {
  switch (item.type) {
    case "command_execution":
      return deriveToolActivityPresentation({
        itemType: "command_execution",
        title: item.title,
        data: { command: item.input },
      });
    case "file_change":
      return deriveToolActivityPresentation({
        itemType: "file_change",
        title: item.title,
        data: { path: item.fileName },
      });
    case "file_search":
      return deriveToolActivityPresentation({
        title: item.title,
        data: { kind: "search", pattern: item.pattern },
        fallbackSummary: "Searched files",
      });
    case "web_search":
      return deriveToolActivityPresentation({
        itemType: "web_search",
        title: item.title,
        data: { query: item.patterns?.join(", ") },
      });
    case "dynamic_tool": {
      const t3Tool = resolveT3McpToolDefinition(item.toolName, item.input);
      if (t3Tool !== null) {
        const [action, , completed, detail] = t3Tool.labels;
        return {
          summary:
            item.status === "failed"
              ? `Failed to ${action.toLowerCase()} ${detail}`
              : `${completed} ${detail}`,
        };
      }
      const title = dynamicToolTitle(item.toolName, item.input, item.title) ?? item.title;
      return deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: title && withoutMcpPrefix(title),
        data: { toolName: item.toolName ?? undefined, input: item.input },
        fallbackSummary: item.toolName && withoutMcpPrefix(item.toolName),
      });
    }
    default:
      return null;
  }
}

export function latestActionFromTurnItem(
  item: OrchestrationV2TurnItem | null,
): OrchestrationV2LatestActionSummary | null {
  if (item === null) return null;
  const presented = presentation(item);
  if (presented === null) return null;
  return {
    summary: clip(presented.summary),
    ...(presented.detail ? { detail: clip(presented.detail) } : {}),
    at: item.startedAt ?? item.updatedAt,
  };
}
