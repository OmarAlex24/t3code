import {
  CornerDownRightIcon,
  LayersIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type SandboxEnvironmentConfig,
  type SandboxOrphan,
  type SandboxProviderInfo,
  type SandboxRecord,
} from "@t3tools/contracts";

import { environmentCatalog } from "~/connection/catalog";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useThreadShells } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useSandboxProvisionerEnvironmentId } from "~/state/sandboxes";
import { useEnvironmentQuery } from "~/state/query";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./settingsLayout";
import {
  describeSandboxFailure,
  SandboxQuotaLine,
  SandboxStartBlocked,
  SandboxStartConfirmation,
  useSandboxStartCheck,
} from "./SandboxStartLimits";
import { SandboxConfigDialog } from "./SandboxConfigDialog";
import { SandboxTailscaleRow } from "./SandboxTailscaleRow";
import { SandboxProviderLogo } from "./SandboxProviderLogo";
import { SandboxTemplateList, SaveSandboxTemplateDialog } from "./SandboxTemplates";
import { Button } from "../ui/button";
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

// The dot reuses the connection colours: green running, pulsing amber while it starts, red on an
// error, amber once the disk is gone, grey while stopped.
const STATE_DOT: Record<
  SandboxRecord["state"],
  { readonly dot: string; readonly ping?: string; readonly meta: string }
> = {
  running: { dot: "bg-success", meta: "running" },
  provisioning: { dot: "bg-warning", ping: "bg-warning/60 duration-2000", meta: "starting" },
  stopped: { dot: "bg-muted-foreground/40", meta: "stopped" },
  error: { dot: "bg-destructive", meta: "error" },
  expired: { dot: "bg-warning", meta: "disk expired" },
  deleted: { dot: "bg-muted-foreground/40", meta: "deleted outside T3 Code" },
};

// Enough of the provider's id to tell two sandboxes with one thread title apart; hover shows it all.
const shortSandboxId = (sandboxId: string) => {
  const separator = sandboxId.indexOf("_");
  return separator === -1 ? sandboxId.slice(0, 7) : sandboxId.slice(0, separator + 5);
};

// Rows sit straight in the group with the insets of every settings row and a hairline between them.
const ROW_CLASSNAME = "@container/sandbox-row px-3 py-3 sm:px-4";
// Under its sandbox, past that row's status dot.
const FORK_ROW_CLASSNAME = "@container/sandbox-row py-2.5 pr-3 pl-8 sm:pr-4 sm:pl-9";
const ROW_INNER_CLASSNAME =
  "flex flex-col gap-2 @min-[32rem]/sandbox-row:flex-row @min-[32rem]/sandbox-row:items-start @min-[32rem]/sandbox-row:justify-between @min-[32rem]/sandbox-row:gap-4";
// Lines under the title start where the title does, past the status dot.
const ROW_INDENT_CLASSNAME = "pl-5";
const ROW_ACTIONS_CLASSNAME = `flex shrink-0 items-center gap-1.5 ${ROW_INDENT_CLASSNAME} @min-[32rem]/sandbox-row:pl-0`;

// States the user has to act on get one line on what happened.
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

// A config, its sandboxes and the orphans each read as one block of the section's group.
const GROUP_CLASSNAME = "divide-y divide-border/50";

const formatCost = (dollars: number) =>
  dollars < 0.01 ? "<$0.01 this month" : `$${dollars.toFixed(2)} this month`;

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
  // A fork an agent made sits under its sandbox; one whose sandbox is gone is simply untracked.
  const tracked = new Set(sandboxes.map((sandbox) => sandbox.instanceId));
  const forksOf = (instanceId: string) => orphans.filter((orphan) => orphan.forkOf === instanceId);
  const untracked = orphans.filter(
    (orphan) => orphan.forkOf === undefined || !tracked.has(orphan.forkOf),
  );
  const providerOf = (kind: string) => providers.find((candidate) => candidate.kind === kind);
  const refresh = () => {
    void list.refresh();
    void configsQuery.refresh();
  };
  const row = (sandbox: SandboxRecord, inConfig: boolean) => {
    const forks = forksOf(sandbox.instanceId);
    return (
      <Fragment key={sandbox.instanceId}>
        <SandboxRow
          environmentId={provisionerEnvironmentId}
          sandbox={sandbox}
          provider={providerOf(sandbox.provider)}
          inConfig={inConfig}
          forkCount={forks.length}
          onChanged={refresh}
        />
        {forks.map((fork) => (
          <OrphanRow
            key={`${fork.provider}:${fork.sandboxId}`}
            environmentId={provisionerEnvironmentId}
            orphan={fork}
            onChanged={refresh}
          />
        ))}
      </Fragment>
    );
  };

  return (
    <SettingsSection
      id="sandboxes"
      title="Sandboxes"
      headerAction={
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setEditing("new");
          }}
        >
          <PlusIcon className="size-3" />
          Add config
        </Button>
      }
    >
      <SandboxTailscaleRow environmentId={provisionerEnvironmentId} />
      {list.error ? (
        <p className="px-3 py-3 text-xs text-destructive sm:px-4">{list.error}</p>
      ) : null}
      {groups.map(({ config, sandboxes: members }) => (
        <div key={config.id} className={GROUP_CLASSNAME}>
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 sm:px-4">
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
                setEditing(config);
              }}
            >
              <PencilIcon className="size-3" />
              Edit
            </Button>
          </div>
          {members.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
              No sandboxes. Choose {config.label} under Sandbox in the composer's Run on menu to
              start a thread on its own machine.
            </p>
          ) : (
            members.map((sandbox) => row(sandbox, true))
          )}
        </div>
      ))}
      {other.length === 0 ? null : (
        <div className={GROUP_CLASSNAME}>
          {groups.length === 0 ? null : (
            <p className="px-3 py-2.5 text-sm font-medium text-foreground sm:px-4">
              Other sandboxes
            </p>
          )}
          {other.map((sandbox) => row(sandbox, false))}
        </div>
      )}
      {untracked.length === 0 ? null : (
        <div className={GROUP_CLASSNAME}>
          <div className="px-3 py-2.5 sm:px-4">
            <p className="text-sm font-medium text-foreground">Not tracked by T3 Code</p>
            <p className="text-xs text-muted-foreground">
              These sandboxes carry this server's tag but no record, usually after a crash. They may
              still bill. Delete the ones you don't need.
            </p>
          </div>
          {untracked.map((orphan) => (
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
      <SandboxConfigDialog
        environmentId={provisionerEnvironmentId}
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />
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
  // A fork hangs off the sandbox above it: the agent made it, and it bills on its own.
  const fork = orphan.forkOf !== undefined;
  return (
    <div className={fork ? FORK_ROW_CLASSNAME : ROW_CLASSNAME}>
      <div className={ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1">
          <div className="flex min-h-6 min-w-0 items-center gap-2">
            {fork ? (
              <CornerDownRightIcon
                aria-hidden
                className="size-3 shrink-0 text-muted-foreground/70"
              />
            ) : (
              <ConnectionStatusDot tooltipText="Not tracked by T3 Code" dotClassName="bg-warning" />
            )}
            <p className="truncate text-sm font-medium text-foreground">{orphan.name}</p>
          </div>
          <p className={`${ROW_INDENT_CLASSNAME} truncate text-xs text-muted-foreground`}>
            {fork ? "Fork made by the agent · " : ""}
            {orphan.sandboxId}
            {orphan.createdAt === undefined
              ? ""
              : ` · made ${new Date(orphan.createdAt).toLocaleDateString()}`}
            {fork ? " · bills like a sandbox" : ""}
          </p>
        </div>
        <div className={ROW_ACTIONS_CLASSNAME}>
          <DeleteSandboxButton
            pending={pending}
            confirming={confirming}
            onClick={() => setConfirming(true)}
          />
        </div>
      </div>
      {confirming && !pending ? (
        <div className={`${ROW_INDENT_CLASSNAME} pt-2`}>
          <SandboxStartConfirmation
            warnings={[
              "This deletes the machine and its disk at the provider. It cannot be undone.",
            ]}
            confirmLabel="Delete sandbox"
            destructive
            onConfirm={() => void remove()}
            onCancel={() => setConfirming(false)}
          />
        </div>
      ) : null}
    </div>
  );
}

// Delete is the same quiet icon in every state and always last, so the actions never shift.
function DeleteSandboxButton({
  pending,
  confirming,
  onClick,
}: {
  readonly pending: boolean;
  readonly confirming: boolean;
  readonly onClick: () => void;
}) {
  // While its confirmation is open an empty slot holds its place, so the other actions stay put.
  if (confirming) return <span aria-hidden className="size-7 shrink-0 sm:size-6" />;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-destructive"
            aria-label="Delete sandbox"
            disabled={pending}
            onClick={onClick}
          />
        }
      >
        {pending ? <Spinner className="size-3.5" /> : <Trash2Icon className="size-3.5" />}
      </TooltipTrigger>
      <TooltipPopup side="top">Delete sandbox</TooltipPopup>
    </Tooltip>
  );
}

function SandboxRow({
  environmentId,
  sandbox,
  provider,
  inConfig,
  forkCount,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly sandbox: SandboxRecord;
  readonly provider: SandboxProviderInfo | undefined;
  /** Under its config's header, which already names the size and template. */
  readonly inConfig: boolean;
  /** Forks its agent made, which deleting it deletes too. */
  readonly forkCount: number;
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
  const dot = STATE_DOT[sandbox.state];
  const meta = [
    sandbox.threadId === undefined
      ? (provider?.label ?? sandbox.provider)
      : (sandbox.projectTitle ?? "Project"),
    ...(inConfig
      ? []
      : [
          provider?.sizes.find((size) => size.id === sandbox.size)?.label ?? sandbox.size,
          ...(sandbox.template === undefined ? [] : [`from ${sandbox.template}`]),
        ]),
    ...(runningMinutes === null
      ? [dot.meta + (stoppedMinutes === null ? "" : ` ${formatDuration(stoppedMinutes)}`)]
      : [
          `up ${formatDuration(runningMinutes)}`,
          `stops in ${formatDuration(Math.max(0, sandbox.maxRunningMinutes - runningMinutes))}`,
        ]),
    ...(sandbox.costDollars === undefined ? [] : [formatCost(sandbox.costDollars)]),
  ];
  const warningClassName = `${ROW_INDENT_CLASSNAME} mt-0.5 text-xs text-warning-foreground`;

  return (
    <div className={ROW_CLASSNAME}>
      <div className={ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1">
          <div className="flex min-h-6 min-w-0 items-center gap-2">
            <ConnectionStatusDot
              tooltipText={stateLabel(sandbox)}
              dotClassName={dot.dot}
              pingClassName={dot.ping ?? null}
            />
            <p className="truncate text-sm font-medium text-foreground">{title}</p>
          </div>
          <p className={`${ROW_INDENT_CLASSNAME} text-xs text-muted-foreground`}>
            {meta[0]}
            {" · "}
            <Tooltip>
              <TooltipTrigger render={<span />}>{shortSandboxId(sandbox.sandboxId)}</TooltipTrigger>
              <TooltipPopup side="top">{sandbox.sandboxId}</TooltipPopup>
            </Tooltip>
            {meta
              .slice(1)
              .map((part) => ` · ${part}`)
              .join("")}
          </p>
          {attention === undefined ? null : (
            <p
              className={
                attention.variant === "error"
                  ? `${ROW_INDENT_CLASSNAME} mt-0.5 text-xs text-destructive-foreground`
                  : warningClassName
              }
            >
              {attention.line}
            </p>
          )}
          {threadGone ? (
            <p className={warningClassName}>
              Its thread was deleted. Delete the sandbox unless you still need its disk.
            </p>
          ) : null}
          {nearRetention ? (
            <p className={warningClassName}>
              {provider?.label ?? sandbox.provider} keeps a stopped disk for {retentionDays} days;
              this one has been stopped {stoppedDays} {stoppedDays === 1 ? "day" : "days"}. Delete
              it unless you need what is on it. T3 Code never deletes it for you.
            </p>
          ) : null}
          {startCheck.limits === null ? null : (
            <div className={ROW_INDENT_CLASSNAME}>
              <SandboxQuotaLine limits={startCheck.limits} />
            </div>
          )}
        </div>
        <div className={ROW_ACTIONS_CLASSNAME}>
          {thread === undefined ? null : (
            <span className="text-muted-foreground">
              <Button
                size="xs"
                variant="link"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
                  })
                }
              >
                Open thread
              </Button>
            </span>
          )}
          {canStop ? (
            <Button size="xs" variant="outline" disabled={pending} onClick={() => void run("stop")}>
              {pending ? (
                <Spinner className="size-3" />
              ) : (
                <SquareIcon aria-hidden className="size-2.5 fill-current" />
              )}
              Stop
            </Button>
          ) : null}
          {canResume ? (
            <Button
              size="xs"
              variant="outline"
              disabled={pending || startCheck.blocked !== null || startCheck.isConfirming}
              onClick={() =>
                startCheck.needsConfirmation ? startCheck.confirm() : void run("resume")
              }
            >
              {pending ? (
                <Spinner className="size-3" />
              ) : (
                <PlayIcon aria-hidden className="size-3 fill-current" />
              )}
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
          <DeleteSandboxButton
            pending={pending}
            confirming={confirmingDelete}
            onClick={() =>
              // A deleted sandbox has nothing left at the provider to lose.
              sandbox.state === "deleted" ? void run("delete") : setConfirmingDelete(true)
            }
          />
        </div>
      </div>
      {startCheck.blocked === null ? null : (
        <div className={`${ROW_INDENT_CLASSNAME} pt-2`}>
          <SandboxStartBlocked
            reason={startCheck.blocked.reason}
            billingUrl={startCheck.limits?.billingUrl}
          />
        </div>
      )}
      {startCheck.isConfirming && !pending ? (
        <div className={`${ROW_INDENT_CLASSNAME} pt-2`}>
          <SandboxStartConfirmation
            warnings={startCheck.assessment?.warnings ?? []}
            confirmLabel="Resume anyway"
            onConfirm={() => void run("resume")}
            onCancel={startCheck.cancel}
          />
        </div>
      ) : null}
      {confirmingDelete && !pending ? (
        <div className={`${ROW_INDENT_CLASSNAME} pt-2`}>
          <SandboxStartConfirmation
            warnings={[
              `This deletes the machine and its disk at ${provider?.label ?? sandbox.provider}${sandbox.threadId === undefined ? "" : ", along with any work in its thread that is not pushed"}. It cannot be undone.`,
              ...(forkCount === 0
                ? []
                : [
                    `It also deletes the ${forkCount === 1 ? "fork" : `${forkCount} forks`} its agent made.`,
                  ]),
            ]}
            confirmLabel="Delete sandbox"
            destructive
            onConfirm={() => void run("delete")}
            onCancel={() => setConfirmingDelete(false)}
          />
        </div>
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
