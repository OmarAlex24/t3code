import {
  EllipsisIcon,
  ExternalLinkIcon,
  GithubIcon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  SANDBOX_GITHUB_APP_HOMEPAGE,
  SANDBOX_GITHUB_APP_NEW_ROUTE,
  SANDBOX_GITHUB_APP_PASTE_REDIRECT_URL,
  sandboxGithubAppManifest,
  type SandboxRailwayWorkspace,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import { randomUUID } from "~/lib/utils";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { describeSandboxFailure } from "./SandboxStartLimits";
import { SandboxTailscaleForm } from "./SandboxTailscaleForm";
import {
  SettingsRow,
  useSettingsSearchTarget,
  useSettingsSearchTargetRequest,
} from "./settingsLayout";

const STATE_KEY = "t3code:sandbox-github-app-state";
const GITHUB_NEW_APP = "https://github.com/settings/apps/new";
const NORTHFLANK_TOKEN_DOCS = "https://northflank.com/docs/v1/application/secure/grant-api-access";
const MAPLE_KEY_DOCS = "https://maple.dev/docs/reference/api/";
const RAILWAY_TOKEN_DOCS = "https://docs.railway.com/guides/public-api";

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
    : SANDBOX_GITHUB_APP_PASTE_REDIRECT_URL;

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

/**
 * How this client opens GitHub's new-app form with the manifest filled in. A browser posts it from
 * this page; the desktop app can only hand a URL to the user's browser, which loses a POST body,
 * so it opens the server's page that posts it from there.
 */
const githubAppFormLaunch = (input: {
  readonly inDesktopApp: boolean;
  readonly httpBaseUrl: string | null;
  readonly state: string;
}): { readonly kind: "post" } | { readonly kind: "external"; readonly url: string } => {
  if (!input.inDesktopApp || input.httpBaseUrl === null) return { kind: "post" };
  const url = URL.parse(
    `${SANDBOX_GITHUB_APP_NEW_ROUTE}?state=${encodeURIComponent(input.state)}`,
    input.httpBaseUrl,
  );
  return url === null ? { kind: "post" } : { kind: "external", url: url.href };
};

/** Posts the manifest to GitHub's new-app page from this page, in a new tab. */
const postManifestForm = (state: string) => {
  const form = document.createElement("form");
  form.method = "post";
  form.action = `${GITHUB_NEW_APP}?state=${encodeURIComponent(state)}`;
  form.target = "_blank";
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(
    sandboxGithubAppManifest({
      redirectUrl: redirectUrl(),
      homepageUrl: SANDBOX_GITHUB_APP_HOMEPAGE,
    }),
  );
  form.append(input);
  document.body.append(form);
  form.submit();
  form.remove();
};

const TAILSCALE_OAUTH_DOCS = "https://tailscale.com/kb/1215/oauth-clients";
const GITHUB_APP_DOCS =
  "https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest";

/** Tailscale's mark: a three-by-three grid of dots, the middle row and bottom centre solid. */
function TailscaleMark() {
  const dots = [0, 1, 2].flatMap((row) => [0, 1, 2].map((column) => ({ row, column })));
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="currentColor">
      {dots.map(({ row, column }) => (
        <circle
          key={`${row}-${column}`}
          cx={4 + column * 8}
          cy={4 + row * 8}
          r={2.9}
          opacity={row === 1 || (row === 2 && column === 1) ? 1 : 0.25}
        />
      ))}
    </svg>
  );
}

type IntegrationId = "tailscale" | "github" | "northflank" | "maple" | "railway";

const INTEGRATION_IDS: ReadonlyArray<IntegrationId> = [
  "tailscale",
  "github",
  "northflank",
  "maple",
  "railway",
];

/** What the add panel says about each one; the docs link sits in its menu too. */
const INTEGRATIONS: Record<
  IntegrationId,
  {
    readonly anchor: string;
    readonly name: string;
    readonly about: string;
    readonly docs: { readonly href: string; readonly label: string };
  }
> = {
  tailscale: {
    anchor: "sandbox-tailscale",
    name: "Tailscale",
    about:
      "Lets a sandbox join your tailnet to reach private endpoints. Each gets a single-use, ephemeral key and leaves the tailnet when deleted.",
    docs: { href: TAILSCALE_OAUTH_DOCS, label: "OAuth clients" },
  },
  github: {
    anchor: "sandbox-github-app",
    name: "GitHub App",
    about:
      "Gives each sandbox an hour-long token for its own repository, revoked when it's deleted. Create the app once, then install it on the repositories sandboxes may use.",
    docs: { href: GITHUB_APP_DOCS, label: "How it works" },
  },
  northflank: {
    anchor: "sandbox-northflank",
    name: "Northflank",
    about:
      "Signs the Northflank CLI in on sandboxes that ask for it. Every sandbox shares this token, so make one just for sandboxes, with only the access they need.",
    docs: { href: NORTHFLANK_TOKEN_DOCS, label: "API tokens" },
  },
  maple: {
    anchor: "sandbox-maple",
    name: "Maple",
    about:
      "Makes a Maple MCP key for each sandbox, revoked when it's deleted. Needs an org admin key with the api_keys:write scope; it never leaves this machine.",
    docs: { href: MAPLE_KEY_DOCS, label: "API keys" },
  },
  railway: {
    anchor: "sandbox-railway",
    name: "Railway",
    about:
      "Makes a Railway token for each sandbox, revoked when it's deleted. Use a workspace token; it never leaves this machine.",
    docs: { href: RAILWAY_TOKEN_DOCS, label: "Tokens" },
  },
};

function IntegrationIcon({ id }: { readonly id: IntegrationId }) {
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-foreground"
    >
      {id === "tailscale" ? (
        <TailscaleMark />
      ) : id === "github" ? (
        <GithubIcon className="size-4" />
      ) : (
        <KeyRoundIcon className="size-3.5 text-muted-foreground" />
      )}
    </span>
  );
}

/**
 * Creating the GitHub App, from the manifest form to the code GitHub sends back. It lives with
 * the list, which is always mounted, so the tab GitHub returns to connects even with no panel open.
 */
function useGithubAppConnect(environmentId: EnvironmentId, onConnected: () => void) {
  const connectApp = useAtomCommand(serverEnvironment.sandboxesConnectGithubApp, {
    reportFailure: false,
  });
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  // How GitHub's form was opened, while the app isn't connected yet.
  const [waiting, setWaiting] = useState<"post" | "external" | null>(null);
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
    setWaiting(null);
    setPasted("");
    onConnected();
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
    setProblem(null);
    const launch = githubAppFormLaunch({
      inDesktopApp: window.desktopBridge !== undefined,
      httpBaseUrl,
      state,
    });
    setWaiting(launch.kind);
    if (launch.kind === "post") {
      postManifestForm(state);
      return;
    }
    void readLocalApi()
      ?.shell.openExternal(launch.url)
      .catch(() => setProblem("Could not open your browser. Try again."));
  };

  const reset = () => {
    setWaiting(null);
    setPasted("");
    setProblem(null);
  };

  return {
    waiting,
    pasted,
    setPasted,
    connecting,
    problem,
    connect,
    startCreate,
    reset,
  };
}

type GithubAppConnect = ReturnType<typeof useGithubAppConnect>;

function GithubAppForm({
  flow,
  onCancel,
}: {
  readonly flow: GithubAppConnect;
  readonly onCancel: () => void;
}) {
  const pastedCode = githubAppCodeFrom(flow.pasted);
  return (
    <div className="space-y-3">
      {flow.connecting ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Connecting…
        </p>
      ) : flow.waiting === null ? (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={flow.startCreate}>
            <GithubIcon />
            Create the app
          </Button>
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (pastedCode !== null) void flow.connect(pastedCode.code);
          }}
        >
          <p className="text-xs text-muted-foreground">
            {flow.waiting === "post"
              ? "On GitHub, choose Create GitHub App. The new tab comes back here and connects the app. If that tab can't load, paste its address below."
              : "On GitHub, in your browser, choose Create GitHub App. GitHub then opens a page that won't load: copy its address and paste it below."}
          </p>
          <Input
            aria-label="Address GitHub opened"
            placeholder="Address GitHub opened, with ?code=…"
            value={flow.pasted}
            onChange={(event) => flow.setPasted(event.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={pastedCode === null}>
              Connect
            </Button>
          </div>
        </form>
      )}
      {flow.problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {flow.problem}
        </p>
      )}
    </div>
  );
}

function TokenForm({
  environmentId,
  field,
  inputLabel,
  placeholder,
  onDone,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly field: "northflankToken" | "mapleAdminKey";
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [value, setValue] = useState("");
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim() === "") return;
        updateSettings({ sandboxTooling: { [field]: value.trim() } });
        onDone();
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
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={value.trim() === ""}>
          Save
        </Button>
      </div>
    </form>
  );
}

/**
 * The Railway token sandboxes get theirs from. The server checks it with Railway before saving,
 * and asks for the workspace only when the token reaches more than one, or can't say which.
 */
function RailwayForm({
  environmentId,
  onDone,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const connectRailway = useAtomCommand(serverEnvironment.sandboxesConnectRailway, {
    reportFailure: false,
  });
  const [token, setToken] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [choices, setChoices] = useState<ReadonlyArray<SandboxRailwayWorkspace>>([]);
  // The token reached no workspace it could name, so the user enters the ID.
  const [askId, setAskId] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const connect = async () => {
    setConnecting(true);
    setProblem(null);
    const result = await connectRailway({
      environmentId,
      input: {
        token: token.trim(),
        ...(workspaceId.trim() === "" ? {} : { workspaceId: workspaceId.trim() }),
      },
    });
    setConnecting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setProblem(
          describeSandboxFailure(squashAtomCommandFailure(result), "Could not save the token")
            .description,
        );
      }
      return;
    }
    if (result.value.saved !== undefined) {
      onDone();
      return;
    }
    setChoices(result.value.workspaces);
    setAskId(result.value.workspaces.length === 0);
    setProblem(result.value.problem);
  };

  const choiceName = choices.find((choice) => choice.id === workspaceId)?.name;

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (token.trim() !== "") void connect();
      }}
    >
      <Input
        aria-label="Railway token"
        type="password"
        placeholder="Railway workspace token"
        value={token}
        onChange={(event) => {
          setToken(event.target.value);
          setChoices([]);
          setAskId(false);
        }}
        spellCheck={false}
        autoComplete="off"
        disabled={connecting}
      />
      {choices.length > 1 ? (
        <Select
          value={workspaceId}
          disabled={connecting}
          onValueChange={(value) => {
            if (value !== null) setWorkspaceId(value);
          }}
        >
          <SelectTrigger aria-label="Railway workspace">
            <SelectValue>{choiceName ?? "Pick a workspace"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {choices.map((choice) => (
              <SelectItem key={choice.id} value={choice.id}>
                {choice.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : askId ? (
        <Input
          aria-label="Railway workspace ID"
          placeholder="Workspace ID"
          value={workspaceId}
          onChange={(event) => setWorkspaceId(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={connecting}
        />
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        {connecting ? <Spinner className="size-3.5" /> : null}
        <Button type="button" variant="ghost" disabled={connecting} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={
            connecting || token.trim() === "" || (choices.length > 1 && choiceName === undefined)
          }
        >
          Save
        </Button>
      </div>
    </form>
  );
}

function IntegrationRow({
  id,
  status,
  extraItems,
  onReplace,
  onRemove,
}: {
  readonly id: IntegrationId;
  readonly status: string;
  readonly extraItems?: ReactNode;
  readonly onReplace: () => void;
  readonly onRemove: () => void;
}) {
  const { anchor, name, docs } = INTEGRATIONS[id];
  const targetRef = useSettingsSearchTarget<HTMLLIElement>(anchor);
  return (
    <li
      id={anchor}
      ref={targetRef}
      tabIndex={-1}
      aria-label={name}
      className="flex min-h-11 items-center gap-3 px-3 py-1.5 outline-none"
    >
      <IntegrationIcon id={id} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 text-sm font-medium text-foreground">{name}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{status}</span>
      </span>
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              aria-label={`More actions for ${name}`}
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          {extraItems}
          <MenuItem onClick={onReplace}>
            <RefreshCwIcon />
            Replace…
          </MenuItem>
          <MenuItem render={<a href={docs.href} target="_blank" rel="noreferrer" />}>
            <ExternalLinkIcon />
            {docs.label}
          </MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={onRemove}>
            <Trash2Icon />
            Remove
          </MenuItem>
        </MenuPopup>
      </Menu>
    </li>
  );
}

type Panel = { readonly id: IntegrationId; readonly replacing: boolean };

/**
 * The credentials sandboxes get from this server: one line per connected integration, and an
 * Add menu for the rest. Secrets arrive redacted, so a non-empty value only says one is saved.
 */
export function SandboxAccessRows({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const tooling = useEnvironmentSettings(environmentId, (settings) => settings.sandboxTooling);
  const tailscale = useEnvironmentSettings(environmentId, (settings) => settings.sandboxTailscale);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const connected: Record<IntegrationId, boolean> = {
    tailscale: tailscale.clientId !== "" && tailscale.clientSecret !== "",
    github: tooling.githubAppId !== "" && tooling.githubAppPrivateKey !== "",
    northflank: tooling.northflankToken !== "",
    maple: tooling.mapleAdminKey !== "",
    railway: tooling.railwayToken !== "" && tooling.railwayWorkspaceId !== "",
  };
  // The tab GitHub sends back opens on the GitHub panel, so its progress or problem shows.
  const [panel, setPanel] = useState<Panel | null>(() =>
    takeGithubRedirect() === null ? null : { id: "github", replacing: false },
  );
  const github = useGithubAppConnect(environmentId, () => setPanel(null));
  const open = (id: IntegrationId) => {
    if (id === "github") github.reset();
    setPanel({ id, replacing: connected[id] });
  };

  // A link to an integration that isn't connected has no row to land on, so it opens its panel.
  const { targetId, onTargetHandled } = useSettingsSearchTargetRequest();
  const requested = INTEGRATION_IDS.find(
    (id) => INTEGRATIONS[id].anchor === targetId && !connected[id],
  );
  const [answered, setAnswered] = useState<IntegrationId | null>(null);
  if ((requested ?? null) !== answered) {
    setAnswered(requested ?? null);
    if (requested !== undefined) open(requested);
  }
  const clearTarget = useEffectEvent(() => onTargetHandled());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the router address's settings target once its panel opened
  useEffect(() => {
    if (requested !== undefined) clearTarget();
  }, [requested]);

  const close = () => setPanel(null);
  const status: Record<IntegrationId, string> = {
    tailscale: tailscale.tag,
    github: tooling.githubAppSlug,
    northflank: "Token saved",
    maple: "Admin key saved",
    railway: tooling.railwayWorkspaceName || "Token saved",
  };
  const remove: Record<IntegrationId, () => void> = {
    tailscale: () =>
      updateSettings({ sandboxTailscale: { clientId: "", clientSecret: "", tag: "" } }),
    github: () =>
      updateSettings({
        sandboxTooling: {
          githubAppId: "",
          githubAppSlug: "",
          githubAppOwner: "",
          githubAppPrivateKey: "",
        },
      }),
    northflank: () => updateSettings({ sandboxTooling: { northflankToken: "" } }),
    maple: () => updateSettings({ sandboxTooling: { mapleAdminKey: "" } }),
    railway: () =>
      updateSettings({
        sandboxTooling: { railwayToken: "", railwayWorkspaceId: "", railwayWorkspaceName: "" },
      }),
  };
  const listed = INTEGRATION_IDS.filter((id) => connected[id]);
  const addable = INTEGRATION_IDS.filter((id) => !connected[id]);
  const shown = panel === null ? null : INTEGRATIONS[panel.id];

  return (
    <SettingsRow
      id="sandbox-integrations"
      title="Integrations"
      serverScoped
      settingKeys={["sandboxTooling", "sandboxTailscale"]}
      control={
        addable.length === 0 ? null : (
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="outline" />}>
              <PlusIcon className="size-3" />
              Add integration
            </MenuTrigger>
            <MenuPopup align="end">
              {addable.map((id) => (
                <MenuItem key={id} onClick={() => open(id)}>
                  <IntegrationIcon id={id} />
                  {INTEGRATIONS[id].name}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        )
      }
    >
      <div className="pb-3 pt-1">
        {listed.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            None connected. Sandboxes get no credentials from this machine until you add one.
          </p>
        ) : (
          <ul
            aria-label="Connected integrations"
            className="divide-y divide-border/50 rounded-lg border border-border/60"
          >
            {listed.map((id) => (
              <IntegrationRow
                key={id}
                id={id}
                status={status[id]}
                onReplace={() => open(id)}
                onRemove={remove[id]}
                {...(id === "github"
                  ? {
                      extraItems: (
                        <MenuItem
                          render={
                            <a
                              href={installUrlOf(tooling.githubAppSlug)}
                              target="_blank"
                              rel="noreferrer"
                            />
                          }
                        >
                          <GithubIcon />
                          Install on repositories
                        </MenuItem>
                      ),
                    }
                  : {})}
              />
            ))}
          </ul>
        )}
      </div>
      <Dialog
        open={panel !== null}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogPopup className="sm:max-w-lg">
          {panel === null || shown === null ? null : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {panel.replacing ? `Replace ${shown.name}` : `Connect ${shown.name}`}
                </DialogTitle>
                <DialogDescription>
                  {shown.about}{" "}
                  <a
                    href={shown.docs.href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
                  >
                    {shown.docs.label}
                    <ExternalLinkIcon aria-hidden className="size-3" />
                  </a>
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                {panel.id === "tailscale" ? (
                  <SandboxTailscaleForm
                    environmentId={environmentId}
                    onDone={close}
                    onCancel={close}
                  />
                ) : panel.id === "github" ? (
                  <GithubAppForm flow={github} onCancel={close} />
                ) : panel.id === "railway" ? (
                  <RailwayForm environmentId={environmentId} onDone={close} onCancel={close} />
                ) : (
                  <TokenForm
                    environmentId={environmentId}
                    field={panel.id === "northflank" ? "northflankToken" : "mapleAdminKey"}
                    inputLabel={
                      panel.id === "northflank" ? "Northflank API token" : "Maple admin key"
                    }
                    placeholder={
                      panel.id === "northflank" ? "Northflank API token" : "Maple admin API key"
                    }
                    onDone={close}
                    onCancel={close}
                  />
                )}
              </DialogPanel>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </SettingsRow>
  );
}
