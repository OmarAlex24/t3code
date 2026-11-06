import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SANDBOX_TAILSCALE_TAG,
  type EnvironmentId,
  tailscaleClientIdFromSecret,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { SandboxTailscaleSetup } from "./SandboxTailscaleSetup";

/**
 * Saves the Tailscale OAuth client sandboxes join the tailnet with. The secret arrives redacted,
 * so a non-empty saved value only says that one is saved.
 */
export function SandboxTailscaleForm({
  environmentId,
  onDone,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.sandboxTailscale);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const checkTailscale = useAtomCommand(serverEnvironment.sandboxesCheckTailscale, {
    reportFailure: false,
  });
  const configured = saved.clientId !== "" && saved.clientSecret !== "";
  // A saved ID that the secret will carry again stays out of the Advanced field.
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tag, setTag] = useState(() =>
    saved.tag === DEFAULT_SANDBOX_TAILSCALE_TAG ? "" : saved.tag,
  );
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The setup steps open for a first setup and stay folded when replacing a working client.
  const [stepsOpen, setStepsOpen] = useState(!configured);
  const effectiveTag = tag.trim() === "" ? DEFAULT_SANDBOX_TAILSCALE_TAG : tag.trim();
  // An OAuth client secret carries its client ID, so the secret alone is usually enough.
  const derivedClientId = tailscaleClientIdFromSecret(clientSecret);

  // Saves only a client that signs in and holds the scopes sandboxes need. A failed save
  // reports itself with a toast and leaves the saved value showing.
  const save = async () => {
    setChecking(true);
    setProblem(null);
    const result = await checkTailscale({
      environmentId,
      input: {
        clientSecret: clientSecret.trim(),
        ...(clientId.trim() === "" ? {} : { clientId: clientId.trim() }),
        tag: effectiveTag,
      },
    });
    setChecking(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setProblem("Could not check the OAuth client with this server.");
      }
      return;
    }
    if (result.value.problem !== null) {
      // The reason points at a step, so the steps open beside it.
      setProblem(result.value.problem);
      setStepsOpen(true);
      return;
    }
    updateSettings({
      sandboxTailscale: {
        clientId: result.value.clientId,
        clientSecret: clientSecret.trim(),
        tag: effectiveTag,
      },
    });
    onDone();
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <SandboxTailscaleSetup
        environmentId={environmentId}
        tag={effectiveTag}
        open={stepsOpen}
        onOpenChange={setStepsOpen}
      >
        <div className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label="Tailscale OAuth client secret"
              type="password"
              placeholder="tskey-client-…"
              value={clientSecret}
              onChange={(event) => {
                setClientSecret(event.target.value);
                setProblem(null);
              }}
              spellCheck={false}
              autoComplete="off"
              disabled={checking}
            />
            <div className="flex shrink-0 justify-end gap-2">
              <Button type="button" variant="ghost" disabled={checking} onClick={onCancel}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  checking ||
                  clientSecret.trim() === "" ||
                  (derivedClientId === null && clientId.trim() === "")
                }
              >
                {checking ? <Spinner className="size-3.5" /> : null}
                {checking ? "Checking…" : "Save"}
              </Button>
            </div>
          </div>
          {problem === null ? (
            <p className="text-xs text-muted-foreground">
              {derivedClientId !== null
                ? `Client ID ${derivedClientId}, read from the secret. Saving signs in once to check its scopes and tag.`
                : "Saving signs in once to check the client's scopes and tag."}
            </p>
          ) : (
            <p role="alert" className="text-xs text-destructive-foreground">
              {problem}
            </p>
          )}
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground data-panel-open:[&_svg]:rotate-90">
              <ChevronRightIcon aria-hidden className="size-3.5 transition-transform" />
              Advanced
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="grid gap-2 pt-2 sm:grid-cols-2">
                <Input
                  aria-label="Tailscale OAuth client ID"
                  placeholder={derivedClientId ?? "OAuth client ID, if the secret has another form"}
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={checking}
                />
                <Input
                  aria-label="Tailscale tag"
                  placeholder={DEFAULT_SANDBOX_TAILSCALE_TAG}
                  value={tag}
                  onChange={(event) => setTag(event.target.value)}
                  spellCheck={false}
                  disabled={checking}
                />
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </div>
      </SandboxTailscaleSetup>
    </form>
  );
}
