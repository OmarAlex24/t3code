import { CheckIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
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
import { SettingsRow } from "./settingsLayout";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

const TAILSCALE_OAUTH_DOCS = "https://tailscale.com/kb/1215/oauth-clients";

// The secret arrives redacted, so a non-empty value only says that one is saved.
export function SandboxTailscaleRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.sandboxTailscale);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const checkTailscale = useAtomCommand(serverEnvironment.sandboxesCheckTailscale, {
    reportFailure: false,
  });
  const configured = saved.clientId !== "" && saved.clientSecret !== "";
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tag, setTag] = useState("");
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // An OAuth client secret carries its client ID, so the secret alone is usually enough.
  const derivedClientId = tailscaleClientIdFromSecret(clientSecret);

  // A failed save reports itself with a toast and leaves the saved value showing.
  const persist = (next: { clientId: string; clientSecret: string; tag: string }) => {
    updateSettings({ sandboxTailscale: next });
    setEditing(false);
    setClientSecret("");
    setProblem(null);
  };
  const startEditing = () => {
    // A saved ID that the secret will carry again stays out of the Advanced field.
    setClientId("");
    setTag(saved.tag === DEFAULT_SANDBOX_TAILSCALE_TAG ? "" : saved.tag);
    setClientSecret("");
    setProblem(null);
    setEditing(true);
  };
  // Saves only a client that signs in and holds the scopes sandboxes need.
  const save = async () => {
    setChecking(true);
    setProblem(null);
    const result = await checkTailscale({
      environmentId,
      input: {
        clientSecret: clientSecret.trim(),
        ...(clientId.trim() === "" ? {} : { clientId: clientId.trim() }),
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
      setProblem(result.value.problem);
      return;
    }
    persist({
      clientId: result.value.clientId,
      clientSecret: clientSecret.trim(),
      tag: tag.trim() === "" ? DEFAULT_SANDBOX_TAILSCALE_TAG : tag.trim(),
    });
  };

  return (
    <SettingsRow
      id="sandbox-tailscale"
      title="Tailscale"
      description={
        <>
          Lets a sandbox join your tailnet to reach private endpoints. Each one gets a single-use,
          ephemeral key from a Tailscale OAuth client and leaves the tailnet when deleted.{" "}
          <a
            href={TAILSCALE_OAUTH_DOCS}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
          >
            OAuth clients
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        </>
      }
      serverScoped
      settingKeys={["sandboxTailscale"]}
      control={
        editing ? null : configured ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckIcon aria-hidden className="size-3.5 text-success" />
            <span className="truncate">{saved.tag}</span>
            <span aria-hidden>·</span>
            <Button variant="link" size="xs" onClick={startEditing}>
              Replace
            </Button>
            <span aria-hidden>·</span>
            <Button
              variant="link"
              size="xs"
              onClick={() => persist({ clientId: "", clientSecret: "", tag: "" })}
            >
              Remove
            </Button>
          </div>
        ) : (
          <Button size="xs" variant="outline" onClick={startEditing}>
            Set up
          </Button>
        )
      }
    >
      {editing ? (
        <form
          className="space-y-2 pt-2 pb-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
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
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={checking}
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="xs"
                variant="outline"
                disabled={
                  checking ||
                  clientSecret.trim() === "" ||
                  (derivedClientId === null && clientId.trim() === "")
                }
              >
                {checking ? <Spinner className="size-3" /> : null}
                {checking ? "Checking…" : "Save"}
              </Button>
            </div>
          </div>
          {problem === null ? (
            <p className="text-xs text-muted-foreground">
              {derivedClientId !== null
                ? `Client ID ${derivedClientId}, read from the secret. Saving signs in once to check its scopes.`
                : "Paste the OAuth client secret. It needs write access to Auth Keys and Devices Core for the tag."}
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
        </form>
      ) : null}
    </SettingsRow>
  );
}
