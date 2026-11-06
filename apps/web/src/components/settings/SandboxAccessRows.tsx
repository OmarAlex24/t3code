import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  sandboxGithubAppManifest,
  type SandboxToolingSettings,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { describeSandboxFailure } from "./SandboxStartLimits";
import { SettingsRow } from "./settingsLayout";

const STATE_KEY = "t3code:sandbox-github-app-state";
const GITHUB_NEW_APP = "https://github.com/settings/apps/new";
const HOMEPAGE = "https://github.com/OmarAlex24/t3code";
const NORTHFLANK_TOKEN_DOCS = "https://northflank.com/docs/v1/application/secure/grant-api-access";
const MAPLE_KEY_DOCS = "https://maple.dev/docs/reference/api/";

const readState = () => {
  try {
    return localStorage.getItem(STATE_KEY);
  } catch {
    return null;
  }
};
const writeState = (state: string | null) => {
  try {
    if (state === null) localStorage.removeItem(STATE_KEY);
    else localStorage.setItem(STATE_KEY, state);
  } catch {
    // Without storage the pasted address still connects the app.
  }
};

/** Where GitHub sends the browser back to; a page that can't load still shows its address. */
const redirectUrl = () =>
  window.location.protocol === "http:" || window.location.protocol === "https:"
    ? `${window.location.origin}/settings/connections`
    : "http://127.0.0.1/t3-sandbox-github-app";

/** The one-time code in the address GitHub opened, or in a bare code that was pasted. */
const githubAppCodeFrom = (text: string): { code: string; state: string | null } | null => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const url = URL.parse(trimmed);
  if (url === null) return /^[\w-]+$/u.test(trimmed) ? { code: trimmed, state: null } : null;
  const code = url.searchParams.get("code");
  return code === null || code === "" ? null : { code, state: url.searchParams.get("state") };
};

let redirectTaken: { code: string; trusted: boolean } | null | undefined;

/** The code GitHub sent this page back with, taken out of the address the first time it's read. */
const takeGithubRedirect = () => {
  if (redirectTaken !== undefined) return redirectTaken;
  const found = githubAppCodeFrom(window.location.href);
  if (found === null || found.state === null) {
    redirectTaken = null;
    return null;
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  window.history.replaceState(window.history.state, "", url);
  redirectTaken = { code: found.code, trusted: found.state === readState() };
  return redirectTaken;
};

const installUrlOf = (slug: string) => `https://github.com/apps/${slug}/installations/new`;

/** Opens GitHub's new-app page with the manifest filled in, in a new tab. */
const openManifestForm = (state: string) => {
  const form = document.createElement("form");
  form.method = "post";
  form.action = `${GITHUB_NEW_APP}?state=${encodeURIComponent(state)}`;
  form.target = "_blank";
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(
    sandboxGithubAppManifest({ redirectUrl: redirectUrl(), homepageUrl: HOMEPAGE }),
  );
  form.append(input);
  document.body.append(form);
  form.submit();
  form.remove();
};

function DocsLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3" />
    </a>
  );
}

function GithubAppRow({
  environmentId,
  saved,
}: {
  readonly environmentId: EnvironmentId;
  readonly saved: SandboxToolingSettings;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const connectApp = useAtomCommand(serverEnvironment.sandboxesConnectGithubApp, {
    reportFailure: false,
  });
  const connected = saved.githubAppId !== "" && saved.githubAppPrivateKey !== "";
  const [waiting, setWaiting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [problem, setProblem] = useState<string | null>(() =>
    takeGithubRedirect()?.trusted === false
      ? "GitHub sent back a code this page didn't ask for, so it wasn't used."
      : null,
  );

  const connect = async (code: string) => {
    setConnecting(true);
    setProblem(null);
    const result = await connectApp({ environmentId, input: { code } });
    setConnecting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setProblem(
          describeSandboxFailure(
            squashAtomCommandFailure(result),
            "Could not connect the GitHub App",
          ).description,
        );
      }
      return;
    }
    writeState(null);
    setWaiting(false);
    setPasted("");
  };

  // GitHub sends the new tab back here with the code; it connects once.
  const [redirect] = useState(takeGithubRedirect);
  const handledRedirect = useRef(false);
  const connectRedirect = useEffectEvent(() => {
    if (handledRedirect.current || redirect?.trusted !== true) return;
    handledRedirect.current = true;
    void connect(redirect.code);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the router address's one-time GitHub code to the server once on mount
  useEffect(() => connectRedirect(), []);

  const startCreate = () => {
    const state = randomUUID();
    writeState(state);
    openManifestForm(state);
    setWaiting(true);
    setProblem(null);
  };
  const pastedCode = githubAppCodeFrom(pasted);

  return (
    <SettingsRow
      id="sandbox-github-app"
      title="GitHub App"
      description={
        <>
          Gives each sandbox an hour-long GitHub token for its own repository, revoked when the
          sandbox is deleted. You create the app once on your account and install it on the
          repositories sandboxes may use.{" "}
          <DocsLink href="https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest">
            How it works
          </DocsLink>
        </>
      }
      serverScoped
      settingKeys={["sandboxTooling"]}
      control={
        connecting ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Connecting…
          </span>
        ) : connected ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckIcon aria-hidden className="size-3.5 text-success" />
            <span className="truncate">{saved.githubAppSlug}</span>
            <span aria-hidden>·</span>
            <Button
              variant="link"
              size="xs"
              render={
                <a href={installUrlOf(saved.githubAppSlug)} target="_blank" rel="noreferrer" />
              }
            >
              Install on repositories
            </Button>
            <span aria-hidden>·</span>
            <Button
              variant="link"
              size="xs"
              onClick={() =>
                updateSettings({
                  sandboxTooling: {
                    githubAppId: "",
                    githubAppSlug: "",
                    githubAppOwner: "",
                    githubAppPrivateKey: "",
                  },
                })
              }
            >
              Remove
            </Button>
          </div>
        ) : (
          <Button size="xs" variant="outline" onClick={startCreate}>
            Create the app
          </Button>
        )
      }
    >
      {waiting && !connected ? (
        <form
          className="space-y-2 pt-2 pb-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (pastedCode !== null) void connect(pastedCode.code);
          }}
        >
          <p className="text-xs text-muted-foreground">
            On GitHub, choose Create GitHub App. The new tab comes back here and connects the app.
            If that tab can't load, paste its address below.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label="Address GitHub opened"
              placeholder="Address GitHub opened, with ?code=…"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              disabled={connecting}
            />
            <div className="flex shrink-0 justify-end gap-2">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={connecting}
                onClick={() => setWaiting(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="xs"
                variant="outline"
                disabled={connecting || pastedCode === null}
              >
                Connect
              </Button>
            </div>
          </div>
        </form>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="pb-2 text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
    </SettingsRow>
  );
}

function TokenRow({
  environmentId,
  id,
  title,
  description,
  field,
  saved,
  inputLabel,
  placeholder,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly title: string;
  readonly description: ReactNode;
  readonly field: "northflankToken" | "mapleAdminKey";
  readonly saved: boolean;
  readonly inputLabel: string;
  readonly placeholder: string;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const persist = (next: string) => {
    updateSettings({ sandboxTooling: { [field]: next } });
    setEditing(false);
    setValue("");
  };
  return (
    <SettingsRow
      id={id}
      title={title}
      description={description}
      serverScoped
      settingKeys={["sandboxTooling"]}
      control={
        editing ? null : saved ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckIcon aria-hidden className="size-3.5 text-success" />
            <span>Saved</span>
            <span aria-hidden>·</span>
            <Button variant="link" size="xs" onClick={() => setEditing(true)}>
              Replace
            </Button>
            <span aria-hidden>·</span>
            <Button variant="link" size="xs" onClick={() => persist("")}>
              Remove
            </Button>
          </div>
        ) : (
          <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
            Add
          </Button>
        )
      }
    >
      {editing ? (
        <form
          className="flex flex-col gap-2 pt-2 pb-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim() !== "") persist(value.trim());
          }}
        >
          <Input
            aria-label={inputLabel}
            type="password"
            placeholder={placeholder}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="flex shrink-0 justify-end gap-2">
            <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" variant="outline" disabled={value.trim() === ""}>
              Save
            </Button>
          </div>
        </form>
      ) : null}
    </SettingsRow>
  );
}

/** Where sandboxes get GitHub, Northflank and Maple credentials. Secrets arrive redacted. */
export function SandboxAccessRows({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.sandboxTooling);
  return (
    <>
      <GithubAppRow environmentId={environmentId} saved={saved} />
      <TokenRow
        environmentId={environmentId}
        id="sandbox-northflank"
        title="Northflank token"
        description={
          <>
            Signs the Northflank CLI in on sandboxes that ask for it. Northflank can't make a token
            per sandbox, so every sandbox shares this one: create a token just for sandboxes, with
            only the access they need. <DocsLink href={NORTHFLANK_TOKEN_DOCS}>API tokens</DocsLink>
          </>
        }
        field="northflankToken"
        saved={saved.northflankToken !== ""}
        inputLabel="Northflank API token"
        placeholder="Northflank API token"
      />
      <TokenRow
        environmentId={environmentId}
        id="sandbox-maple"
        title="Maple admin key"
        description={
          <>
            Makes a Maple MCP key for each sandbox that copies your Maple server, revoked when the
            sandbox is deleted. Needs an org admin key with the api_keys:write scope; it never
            leaves this machine. <DocsLink href={MAPLE_KEY_DOCS}>API keys</DocsLink>
          </>
        }
        field="mapleAdminKey"
        saved={saved.mapleAdminKey !== ""}
        inputLabel="Maple admin key"
        placeholder="Maple admin API key"
      />
    </>
  );
}
