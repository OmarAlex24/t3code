import type { SandboxHostAccess } from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AccessSwitch, DetailField } from "./SandboxFormParts";

const START_ON_CLAUDE = "__claude__";

/** Why Pi cannot be set up, or null: it runs on the key each sandbox gets on the hub for Claude. */
export const piUnavailableReason = (
  host: SandboxHostAccess | undefined,
  sendsClaude: boolean,
): string | null =>
  host?.claude?.key !== "hub"
    ? "Needs Claude on a CLIProxyAPI hub with a management key."
    : sendsClaude
      ? null
      : "Turn on Claude first; Pi uses its hub key.";

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
  // Without a hub there is nothing to offer, unless a saved config still asks for Pi.
  if (host?.claude?.key !== "hub" && !enabled) return null;
  const models = host?.piModels ?? [];
  // A saved model the hub no longer lists stays visible, so saving does not drop it silently.
  const choices =
    startModel === "" || models.includes(startModel) ? models : [...models, startModel];
  return (
    <AccessSwitch
      name="Pi"
      state={unavailable ?? "Your hub's other models, on Claude's key"}
      checked={enabled && unavailable === null}
      disabled={disabled || unavailable !== null}
      onCheckedChange={onEnabledChange}
    >
      <DetailField label="New chats on">
        <Select
          value={startModel === "" ? START_ON_CLAUDE : startModel}
          disabled={disabled}
          onValueChange={(value) => {
            if (value !== null) onStartModelChange(value === START_ON_CLAUDE ? "" : value);
          }}
        >
          <SelectTrigger aria-label="Start new chats on" size="sm">
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
      </DetailField>
      {models.length === 0 ? (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          Couldn't list your hub's models here; each sandbox reads them when it starts.
        </p>
      ) : null}
    </AccessSwitch>
  );
}
