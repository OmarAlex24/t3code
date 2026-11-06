import type { SandboxHostAccess } from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { FieldLabel, OptIn } from "./SandboxFormParts";

const START_ON_CLAUDE = "__claude__";

/** Why Pi cannot be set up, or null: it runs on the key each sandbox gets on the hub for Claude. */
export const piUnavailableReason = (
  host: SandboxHostAccess | undefined,
  sendsClaude: boolean,
): string | null =>
  host?.claude?.key !== "hub"
    ? "Needs this machine's Claude setup on a CLIProxyAPI hub with a management key, so each sandbox gets a key of its own."
    : sendsClaude
      ? null
      : "Uses the hub key each sandbox gets for Claude, so turn on this machine's Claude setup first.";

/** Pi with the hub's non-Claude models, and whether new chats start on it. */
export function SandboxPiFields({
  host,
  unavailable,
  enabled,
  startModel,
  disabled,
  onEnabledChange,
  onStartModelChange,
}: {
  readonly host: SandboxHostAccess | undefined;
  readonly unavailable: string | null;
  readonly enabled: boolean;
  /** A hub model id, or "" to keep new chats on Claude. */
  readonly startModel: string;
  readonly disabled: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onStartModelChange: (model: string) => void;
}) {
  const models = host?.piModels ?? [];
  // A saved model the hub no longer lists stays visible, so saving does not drop it silently.
  const choices =
    startModel === "" || models.includes(startModel) ? models : [...models, startModel];
  return (
    <div className="space-y-2">
      <OptIn
        checked={enabled && unavailable === null}
        disabled={disabled || unavailable !== null}
        onCheckedChange={onEnabledChange}
        title="Set up Pi with your hub's other models"
      >
        {unavailable ??
          "Pi uses the same hub key as Claude, so deleting the sandbox cuts it off too."}
      </OptIn>
      {enabled && unavailable === null ? (
        <div className="space-y-1.5 ps-6.5">
          <label className="block">
            <FieldLabel>Start new chats on</FieldLabel>
            <Select
              value={startModel === "" ? START_ON_CLAUDE : startModel}
              disabled={disabled}
              onValueChange={(value) => {
                if (value !== null) onStartModelChange(value === START_ON_CLAUDE ? "" : value);
              }}
            >
              <SelectTrigger aria-label="Start new chats on" size="default">
                <SelectValue>{startModel === "" ? "Claude" : `Pi · ${startModel}`}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={START_ON_CLAUDE}>Claude</SelectItem>
                {choices.map((model) => (
                  <SelectItem key={model} value={model}>
                    Pi · {model}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          {models.length === 0 ? (
            <p className="text-2xs leading-relaxed text-muted-foreground">
              This machine could not list your hub's models. Each sandbox reads them when it starts.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
