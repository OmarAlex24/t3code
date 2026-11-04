import {
  ArrowUpRightIcon,
  CheckIcon,
  ExternalLinkIcon,
  LayersIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SANDBOX_TAILSCALE_TAG,
  type EnvironmentId,
  type SandboxEnvironmentConfig,
  type SandboxOrphan,
  type SandboxProviderInfo,
  type SandboxRecord,
} from "@t3tools/contracts";

import { environmentCatalog } from "~/connection/catalog";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useThreadShells } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useSandboxProvisionerEnvironmentId } from "~/state/sandboxes";
import { useEnvironmentQuery } from "~/state/query";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  describeSandboxFailure,
  SandboxQuotaLine,
  SandboxStartBlocked,
  SandboxStartConfirmation,
  useSandboxStartCheck,
} from "./SandboxStartLimits";
import { SandboxEnvironmentFields } from "./SandboxEnvironmentFields";
import { SandboxProviderLogo } from "./SandboxProviderLogo";
import { SandboxTemplateList, SaveSandboxTemplateDialog } from "./SandboxTemplates";
import { Badge } from "../ui/badge";
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
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;

const formatDuration = (minutes: number) => {
  if (minutes >= 2 * DAY_MINUTES) return `${Math.floor(minutes / DAY_MINUTES)} days`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${Math.max(1, rest)} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

const minutesSince = (iso: string | null | undefined, nowMillis: number) =>
  iso === null || iso === undefined
    ? null
    : Math.max(0, Math.floor((nowMillis - Date.parse(iso)) / MINUTE));

const stateLabel = (sandbox: SandboxRecord): string => {
  switch (sandbox.state) {
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "provisioning":
      return "Starting";
    case "error":
      return "Error";
    case "expired":
      return "Disk expired";
    case "deleted":
      return "Deleted";
  }
};

// States the user has to act on get a badge and one line on what happened.
const ATTENTION: Partial<
  Record<SandboxRecord["state"], { readonly variant: "error" | "warning"; readonly line: string }>
> = {
  error: {
    variant: "error",
    line: "The provider reported an error, or T3 Code is not answering on this sandbox.",
  },
  expired: {
    variant: "warning",
    line: "The provider no longer keeps this stopped sandbox's disk, so it cannot be resumed.",
  },
  deleted: {
    variant: "warning",
    line: "This sandbox was deleted outside T3 Code. Deleting it here only clears it from this list.",
  },
};

const formatCost = (dollars: number) =>
  dollars < 0.01 ? "under $0.01 this month" : `$${dollars.toFixed(2)} this month`;

// A stopped disk this close to the provider's limit gets a warning that recommends deleting it.
const RETENTION_WARNING_DAYS = 3;

/** Per-thread sandboxes under their config, in the order the configs were made. */
const groupByConfig = (
  sandboxes: ReadonlyArray<SandboxRecord>,
  configs: ReadonlyArray<SandboxEnvironmentConfig>,
) => {
  const known = new Set(configs.map((config) => config.id));
  return {
    groups: configs.map((config) => ({
      config,
      sandboxes: sandboxes.filter((sandbox) => sandbox.configId === config.id),
    })),
    other: sandboxes.filter(
      (sandbox) => sandbox.configId === undefined || !known.has(sandbox.configId),
    ),
  };
};

export function SandboxManagementSection() {
  const provisionerEnvironmentId = useSandboxProvisionerEnvironmentId();
  const list = useEnvironmentQuery(
    provisionerEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesList({
          environmentId: provisionerEnvironmentId,
          input: undefined,
        }),
  );
  const configsQuery = useEnvironmentQuery(
    provisionerEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesConfigs({
          environmentId: provisionerEnvironmentId,
          input: undefined,
        }),
  );
  const providersQuery = useEnvironmentQuery(
    provisionerEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesProviders({
          environmentId: provisionerEnvironmentId,
          input: undefined,
        }),
  );
  const [editing, setEditing] = useState<SandboxEnvironmentConfig | "new" | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const sandboxes = list.data?.sandboxes ?? [];
  const orphans = list.data?.orphans ?? [];
  const configs = configsQuery.data?.configs ?? [];
  const providers = providersQuery.data?.providers ?? [];
  // Templates outlive the sandbox they came from, so they keep the section open on their own.
  const templateProviders = providers.filter(
    (provider) => provider.configured && provider.capabilities.templates,
  );
  // A saved provider key is enough: the server-wide sandbox settings matter before the first one.
  const anyConfigured = providers.some((provider) => provider.configured);
  if (
    provisionerEnvironmentId === null ||
    (sandboxes.length === 0 && configs.length === 0 && !anyConfigured)
  ) {
    return null;
  }
  const { groups, other } = groupByConfig(sandboxes, configs);
  const providerOf = (kind: string) => providers.find((candidate) => candidate.kind === kind);
  const refresh = () => {
    void list.refresh();
    void configsQuery.refresh();
  };
  const row = (sandbox: SandboxRecord) => (
    <SandboxRow
      key={sandbox.instanceId}
      environmentId={provisionerEnvironmentId}
      sandbox={sandbox}
      provider={providerOf(sandbox.provider)}
      onChanged={refresh}
    />
  );

  return (
    <SettingsSection
      id="sandboxes"
      title="Sandboxes"
      headerAction={
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setEditError(null);
            setEditing("new");
          }}
        >
          <PlusIcon className="size-3" />
          Add config
        </Button>
      }
    >
      <SandboxTailscaleRow environmentId={provisionerEnvironmentId} />
      {list.error ? <p className="px-1 pb-2 text-xs text-destructive">{list.error}</p> : null}
      {groups.map(({ config, sandboxes: members }) => (
        <div key={config.id} className="space-y-2 py-2">
          <div className="flex items-center justify-between gap-3 px-1">
            <div className="flex min-w-0 items-center gap-2">
              <SandboxProviderLogo kind={config.provider} />
              <p className="truncate text-sm font-medium text-foreground">{config.label}</p>
              <span className="truncate text-xs text-muted-foreground">
                {[
                  providerOf(config.provider)?.sizes.find((size) => size.id === config.size)
                    ?.label ?? config.size,
                  ...(config.template === undefined ? [] : [`from ${config.template}`]),
                  `stops after ${formatDuration(config.maxRunningMinutes)} running`,
                ].join(" · ")}
              </span>
            </div>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => {
                setEditError(null);
                setEditing(config);
              }}
            >
              <PencilIcon className="size-3" />
              Edit
            </Button>
          </div>
          {members.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">
              No sandboxes. Pick Sandbox: {config.label} in the composer to start a thread on its
              own machine.
            </p>
          ) : (
            members.map(row)
          )}
        </div>
      ))}
      {other.length === 0 ? null : (
        <div className="space-y-2 py-2">
          {groups.length === 0 ? null : (
            <p className="px-1 text-sm font-medium text-foreground">Other sandboxes</p>
          )}
          {other.map(row)}
        </div>
      )}
      {orphans.length === 0 ? null : (
        <div className="space-y-2 py-2">
          <div className="px-1">
            <p className="text-sm font-medium text-foreground">Not tracked by T3 Code</p>
            <p className="text-xs text-muted-foreground">
              These sandboxes carry this server's tag but no record, usually after a crash. They may
              still bill. Delete the ones you don't need.
            </p>
          </div>
          {orphans.map((orphan) => (
            <OrphanRow
              key={`${orphan.provider}:${orphan.sandboxId}`}
              environmentId={provisionerEnvironmentId}
              orphan={orphan}
              onChanged={refresh}
            />
          ))}
        </div>
      )}
      {templateProviders.map((provider) => (
        <SandboxTemplateList
          key={provider.kind}
          environmentId={provisionerEnvironmentId}
          provider={provider}
        />
      ))}
      <Dialog open={editing !== null} onOpenChange={(open) => (open ? null : setEditing(null))}>
        <DialogPopup className="max-h-[80dvh] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editing === "new" ? "Add sandbox config" : "Edit sandbox config"}
            </DialogTitle>
            <DialogDescription>
              Each thread started on a config gets its own machine, made this way.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {editing === null ? null : (
              <SandboxEnvironmentFields
                key={editing === "new" ? "new" : editing.id}
                environmentId={provisionerEnvironmentId}
                {...(editing === "new" ? {} : { config: editing })}
                error={editError}
                onErrorChange={setEditError}
                onDone={() => {
                  setEditing(null);
                  refresh();
                }}
              />
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}

function OrphanRow({
  environmentId,
  orphan,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly orphan: SandboxOrphan;
  readonly onChanged: () => void;
}) {
  const deleteSandbox = useAtomCommand(serverEnvironment.sandboxesDelete, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const remove = async () => {
    setPending(true);
    const result = await deleteSandbox({
      environmentId,
      input: { provider: orphan.provider, sandboxId: orphan.sandboxId },
    });
    setPending(false);
    setConfirming(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = describeSandboxFailure(
        squashAtomCommandFailure(result),
        "Could not delete sandbox",
      );
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failure.title,
          description: failure.description,
        }),
      );
      return;
    }
    onChanged();
  };
  return (
    <div className="space-y-2 rounded-lg border border-border/60 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <SandboxProviderLogo kind={orphan.provider} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{orphan.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {orphan.sandboxId}
              {orphan.createdAt === undefined
                ? ""
                : ` · made ${new Date(orphan.createdAt).toLocaleDateString()}`}
            </p>
          </div>
        </div>
        {confirming ? null : (
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            {pending ? <Spinner className="size-3" /> : <Trash2Icon className="size-3" />}
            Delete
          </Button>
        )}
      </div>
      {confirming && !pending ? (
        <SandboxStartConfirmation
          warnings={["This deletes the machine and its disk at the provider. It cannot be undone."]}
          confirmLabel="Delete sandbox"
          destructive
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}

const TAILSCALE_OAUTH_DOCS = "https://tailscale.com/kb/1215/oauth-clients";

// The secret arrives redacted, so a non-empty value only says that one is saved.
function SandboxTailscaleRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.sandboxTailscale);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const configured = saved.clientId !== "" && saved.clientSecret !== "";
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tag, setTag] = useState("");

  // A failed save reports itself with a toast and leaves the saved value showing.
  const persist = (next: { clientId: string; clientSecret: string; tag: string }) => {
    updateSettings({ sandboxTailscale: next });
    setEditing(false);
    setClientSecret("");
  };
  const startEditing = () => {
    setClientId(saved.clientId);
    setTag(saved.tag === DEFAULT_SANDBOX_TAILSCALE_TAG ? "" : saved.tag);
    setClientSecret("");
    setEditing(true);
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
          className="grid gap-2 pt-2 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            persist({
              clientId: clientId.trim(),
              clientSecret: clientSecret.trim(),
              tag: tag.trim() === "" ? DEFAULT_SANDBOX_TAILSCALE_TAG : tag.trim(),
            });
          }}
        >
          <Input
            aria-label="Tailscale OAuth client ID"
            placeholder="OAuth client ID"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}

            spellCheck={false}
            autoComplete="off"
          />
          <Input
            aria-label="Tailscale OAuth client secret"
            type="password"
            placeholder="Client secret"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}

            spellCheck={false}
            autoComplete="off"
          />
          <Input
            aria-label="Tailscale tag"
            placeholder={DEFAULT_SANDBOX_TAILSCALE_TAG}
            value={tag}
            onChange={(event) => setTag(event.target.value)}

            spellCheck={false}
          />
          <div className="flex justify-end gap-2 sm:col-span-3">
            <Button
              type="button"
              size="xs"
              variant="ghost"

              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="xs"
              variant="outline"
              disabled={clientId.trim() === "" || clientSecret.trim() === ""}
            >
              Save
            </Button>
          </div>
        </form>
      ) : null}
    </SettingsRow>
  );
}

function SandboxRow({
  environmentId,
  sandbox,
  provider,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly sandbox: SandboxRecord;
  readonly provider: SandboxProviderInfo | undefined;
  readonly onChanged: () => void;
}) {
  const navigate = useNavigate();
  const stopSandbox = useAtomCommand(serverEnvironment.sandboxesStop, { reportFailure: false });
  const resumeSandbox = useAtomCommand(serverEnvironment.sandboxesResume, {
    reportFailure: false,
  });
  const deleteSandbox = useAtomCommand(serverEnvironment.sandboxesDelete, {
    reportFailure: false,
  });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const { entries } = useAtomValue(environmentCatalog.catalogValueAtom);
  const { environments } = useEnvironments();
  const threads = useThreadShells();
  const minute = useNowMinute();
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  // The tick is UTC truncated to the minute; a minute's precision is all these labels show.
  const nowMillis = Date.parse(`${minute}:00.000Z`);
  const sandboxEnvironment =
    sandbox.environmentId === null
      ? undefined
      : environments.find((environment) => environment.environmentId === sandbox.environmentId);
  const thread =
    sandbox.threadId === undefined || sandbox.environmentId === null
      ? undefined
      : threads.find(
          (candidate) =>
            candidate.environmentId === sandbox.environmentId && candidate.id === sandbox.threadId,
        );
  // A message still waiting in the composer has no thread yet, but its draft keeps the sandbox.
  const hasDraft = useComposerDraftStore((state) =>
    Object.values(state.draftThreadsByThreadKey).some(
      (draft) => draft.threadId === sandbox.threadId && draft.promotedTo == null,
    ),
  );
  // Only a connected sandbox can say its thread is gone; an offline one simply has not loaded it.
  const threadGone =
    sandbox.threadId !== undefined &&
    thread === undefined &&
    !hasDraft &&
    sandboxEnvironment?.connection.phase === "connected" &&
    sandboxEnvironment.serverConfig !== null;
  const runningMinutes =
    sandbox.state === "running" ? minutesSince(sandbox.runningSince, nowMillis) : null;
  const stoppedMinutes =
    sandbox.state === "stopped"
      ? minutesSince(sandbox.stoppedAt ?? sandbox.updatedAt, nowMillis)
      : null;
  const retentionDays = provider?.diskRetentionDays;
  const stoppedDays = stoppedMinutes === null ? null : Math.floor(stoppedMinutes / DAY_MINUTES);
  const nearRetention =
    retentionDays !== undefined &&
    stoppedDays !== null &&
    stoppedDays >= retentionDays - RETENTION_WARNING_DAYS;
  // Until providers load, keep the controls; the server refuses what the driver cannot do.
  const canStopResume = provider?.capabilities.stopResume ?? true;
  const canStop = canStopResume && (sandbox.state === "running" || sandbox.state === "error");
  const canResume = canStopResume && sandbox.state === "stopped";
  // Delete is always offered; it stays an icon beside Stop or Resume so it never reads as the
  // main action, and becomes the labeled action once neither can move the sandbox forward.
  const deleteIsSecondary = (canStop || canResume) && !nearRetention && !threadGone;
  // Only a stopped sandbox can spend a start, so only it reads the provider's limits.
  const startCheck = useSandboxStartCheck({
    environmentId,
    provider: canResume ? provider : undefined,
  });
  const attention = ATTENTION[sandbox.state];
  // Saving a template deletes its source, so a thread's machine is never offered.
  const canSaveTemplate =
    provider !== undefined &&
    provider.capabilities.templates &&
    sandbox.state === "running" &&
    sandbox.threadId === undefined;

  const run = async (action: "stop" | "resume" | "delete") => {
    startCheck.cancel();
    setConfirmingDelete(false);
    setPending(true);
    const input = { environmentId, input: { instanceId: sandbox.instanceId } };
    const result =
      action === "stop"
        ? await stopSandbox(input)
        : action === "resume"
          ? await resumeSandbox(input)
          : await deleteSandbox({
              environmentId,
              input: {
                provider: sandbox.provider,
                sandboxId: sandbox.sandboxId,
                instanceId: sandbox.instanceId,
              },
            });
    if (action === "resume") startCheck.refresh();
    if (result._tag === "Failure") {
      setPending(false);
      if (!isAtomCommandInterrupted(result)) {
        const failure = describeSandboxFailure(
          squashAtomCommandFailure(result),
          action === "stop"
            ? "Could not stop sandbox"
            : action === "resume"
              ? "Could not resume sandbox"
              : "Could not delete sandbox",
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failure.title,
            description: failure.description,
          }),
        );
      }
      return;
    }
    // A deleted sandbox's connection has nothing left to reach, so it leaves this client too.
    if (
      action === "delete" &&
      sandbox.environmentId !== null &&
      entries.has(sandbox.environmentId)
    ) {
      await removeEnvironment(sandbox.environmentId);
    }
    setPending(false);
    // A delete always succeeds once the machine is gone, and a resume once T3 answers; cleanup or
    // setup either could not finish is a warning.
    const warnings =
      (action === "delete" || action === "resume") &&
      result.value !== undefined &&
      "warnings" in result.value
        ? (result.value.warnings ?? [])
        : [];
    for (const warning of warnings) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: action === "delete" ? "Sandbox deleted" : "Sandbox resumed",
          description: warning,
        }),
      );
    }
    onChanged();
  };

  const title =
    sandbox.threadId === undefined
      ? sandbox.label
      : (thread?.title ?? sandbox.projectTitle ?? sandbox.label);
  const subtitle = [
    ...(sandbox.threadId === undefined
      ? [provider?.label ?? sandbox.provider]
      : [sandbox.projectTitle ?? "Project"]),
    provider?.sizes.find((size) => size.id === sandbox.size)?.label ?? sandbox.size,
    ...(sandbox.template === undefined ? [] : [`from ${sandbox.template}`]),
    ...(attention === undefined ? [stateLabel(sandbox)] : []),
    ...(runningMinutes === null
      ? []
      : [
          `up ${formatDuration(runningMinutes)}, stops at ${formatDuration(sandbox.maxRunningMinutes)}`,
        ]),
    ...(stoppedMinutes === null ? [] : [`disk kept ${formatDuration(stoppedMinutes)}`]),
    ...(sandbox.costDollars === undefined ? [] : [formatCost(sandbox.costDollars)]),
  ].join(" · ");

  return (
    <div className="space-y-2 rounded-lg border border-border/60 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background text-muted-foreground">
            <SandboxProviderLogo kind={sandbox.provider} />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-sm font-medium text-foreground">{title}</p>
              {attention === undefined ? null : (
                <Badge variant={attention.variant} size="sm">
                  {stateLabel(sandbox)}
                </Badge>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
            {attention === undefined ? null : (
              <p className="mt-0.5 text-xs text-muted-foreground">{attention.line}</p>
            )}
            {threadGone ? (
              <p className="mt-0.5 text-xs text-warning-foreground">
                Its thread was deleted. Delete the sandbox unless you still need its disk.
              </p>
            ) : null}
            {nearRetention ? (
              <p className="mt-0.5 text-xs text-warning-foreground">
                {provider?.label ?? sandbox.provider} keeps a stopped disk for {retentionDays} days;
                this one has been stopped {stoppedDays} {stoppedDays === 1 ? "day" : "days"}. Delete
                it unless you need what is on it. T3 Code never deletes it for you.
              </p>
            ) : null}
            {startCheck.limits === null ? null : <SandboxQuotaLine limits={startCheck.limits} />}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {thread === undefined ? null : (
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
                })
              }
            >
              <ArrowUpRightIcon className="size-3" />
              Open thread
            </Button>
          )}
          {canStop ? (
            <Button size="xs" variant="outline" disabled={pending} onClick={() => void run("stop")}>
              {pending ? <Spinner className="size-3" /> : <SquareIcon className="size-3" />}
              Stop
            </Button>
          ) : null}
          {canResume && !startCheck.isConfirming ? (
            <Button
              size="xs"
              variant="outline"
              disabled={pending || startCheck.blocked !== null}
              onClick={() =>
                startCheck.needsConfirmation ? startCheck.confirm() : void run("resume")
              }
            >
              {pending ? <Spinner className="size-3" /> : <PlayIcon className="size-3" />}
              Resume
            </Button>
          ) : null}
          {canSaveTemplate ? (
            <Button
              size="xs"
              variant="outline"
              disabled={pending}
              onClick={() => setSavingTemplate(true)}
            >
              <LayersIcon className="size-3" />
              Save as template…
            </Button>
          ) : null}
          {confirmingDelete ? null : deleteIsSecondary ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-destructive"
                    aria-label="Delete sandbox"
                    disabled={pending}
                    onClick={() => setConfirmingDelete(true)}
                  />
                }
              >
                <Trash2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Delete sandbox</TooltipPopup>
            </Tooltip>
          ) : (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={pending}
              onClick={() =>
                // A deleted sandbox has nothing left at the provider to lose.
                sandbox.state === "deleted" ? void run("delete") : setConfirmingDelete(true)
              }
            >
              {pending ? <Spinner className="size-3" /> : <Trash2Icon className="size-3" />}
              Delete
            </Button>
          )}
        </div>
      </div>
      {startCheck.blocked === null ? null : (
        <SandboxStartBlocked
          reason={startCheck.blocked.reason}
          billingUrl={startCheck.limits?.billingUrl}
        />
      )}
      {startCheck.isConfirming && !pending ? (
        <SandboxStartConfirmation
          warnings={startCheck.assessment?.warnings ?? []}
          confirmLabel="Resume anyway"
          onConfirm={() => void run("resume")}
          onCancel={startCheck.cancel}
        />
      ) : null}
      {confirmingDelete && !pending ? (
        <SandboxStartConfirmation
          warnings={[
            `This deletes the machine and its disk at ${provider?.label ?? sandbox.provider}${sandbox.threadId === undefined ? "" : ", along with any work in its thread that is not pushed"}. It cannot be undone.`,
          ]}
          confirmLabel="Delete sandbox"
          destructive
          onConfirm={() => void run("delete")}
          onCancel={() => setConfirmingDelete(false)}
        />
      ) : null}
      {canSaveTemplate ? (
        <SaveSandboxTemplateDialog
          environmentId={environmentId}
          sandbox={sandbox}
          provider={provider}
          open={savingTemplate}
          onOpenChange={setSavingTemplate}
          onSaved={onChanged}
        />
      ) : null}
    </div>
  );
}
