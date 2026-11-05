import { useAtomValue } from "@effect/atom-react";
import {
  DIY_RESOLVER_MODEL_PATTERN,
  DiyKitError,
  type DiyKitStatus,
  type DiyResolverProvider,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, ChevronRightIcon, CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { type ReactNode, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings, useEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  DIY_RESOLVER_DRIVERS,
  type DiyRunTone,
  describeLastRun,
  nextRunLabel,
  repositoryName,
} from "./DiyBuildSection.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";

const LOG_LINES = 200;
const isDiyKitError = Schema.is(DiyKitError);
const RESOLVER_NAMES: Record<DiyResolverProvider, string> = { claude: "Claude", codex: "Codex" };

/**
 * Settings, About: the t3code-diy build this app came from. Only the primary environment's own
 * server answers, and only when the kit built this app, so everyone else never sees the section.
 */
export function DiyBuildSection() {
  const environmentId = usePrimaryEnvironmentId();
  const statusQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.diyStatus({ environmentId, input: undefined }),
  );
  if (environmentId === null) return null;
  const data = statusQuery.data;
  if (data === null) {
    return isDiyKitError(statusQuery.failure) ? (
      <SettingsSection id="custom-build" title="Custom build">
        <SettingsRow
          title="t3code-diy didn't answer"
          description={`${statusQuery.failure.message} Run t3code-diy status in a terminal to see more.`}
        />
      </SettingsSection>
    ) : null;
  }
  if (!data.available) return null;
  return <ConnectedDiyBuildCard environmentId={environmentId} status={data.status} />;
}

function ConnectedDiyBuildCard({
  environmentId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: DiyKitStatus;
}) {
  const runNow = useAtomCommand(serverEnvironment.diyRunNow, "Could not start the update");
  const canRun = useAtomValue(serverEnvironment.diyRunNow.permissionAtom(environmentId));
  const [starting, setStarting] = useState(false);
  return (
    <DiyBuildCard
      status={status}
      starting={starting}
      canRun={canRun}
      onRunNow={async () => {
        setStarting(true);
        await runNow({ environmentId, input: undefined });
        setStarting(false);
      }}
      resolverControl={<ResolverPicker environmentId={environmentId} status={status} />}
      log={<DiyLogTail environmentId={environmentId} />}
    />
  );
}

export function DiyBuildCard({
  status,
  starting,
  canRun,
  onRunNow,
  resolverControl,
  log,
}: {
  readonly status: DiyKitStatus;
  readonly starting: boolean;
  readonly canRun: boolean;
  readonly onRunNow: () => void;
  readonly resolverControl: ReactNode;
  /** Mounted only while the log is open, so its query runs only then. */
  readonly log: ReactNode;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const nowMs = Date.parse(`${useNowMinute()}Z`);
  const lastRun = describeLastRun(status, timestampFormat, nowMs);
  const nextRun = nextRunLabel(status, timestampFormat, nowMs);
  const updating = status.running || starting;
  const installed = status.app.installedVersion;

  return (
    <SettingsSection id="custom-build" title="Custom build">
      <SettingsRow
        title={`${status.app.name}${installed ? ` ${installed}` : ""}`}
        description={<Lineage status={status} />}
      />
      <SettingsRow
        title="Last update"
        description={<RunSentence tone={updating ? "running" : lastRun.tone} text={lastRun.text} />}
        status={nextRun}
        control={
          <Button size="sm" variant="outline" disabled={updating || !canRun} onClick={onRunNow}>
            {updating ? <Spinner aria-hidden /> : null}
            {updating ? "Updating…" : "Update now"}
          </Button>
        }
      />
      <SettingsRow
        title="Resolves conflicts with"
        description="When upstream and your branch change the same lines, this agent settles the rebase. It can't push; the update pushes only after the tests pass."
        control={resolverControl}
      />
      <LogFold>{log}</LogFold>
    </SettingsSection>
  );
}

/** Upstream's branch flowing into the fork's: what the daily rebase actually does. */
function Lineage({ status }: { readonly status: DiyKitStatus }) {
  const ref = (repository: string, branch: string) => (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      <span className="truncate">{repositoryName(repository)}</span>
      <span className="truncate font-medium text-foreground">{branch}</span>
    </span>
  );
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {ref(status.upstream.url, status.upstream.branch)}
      <ArrowRightIcon aria-label="rebased into" className="size-3 shrink-0 opacity-60" />
      {ref(status.fork.url, status.fork.branch)}
    </span>
  );
}

const TONE_ICON: Record<DiyRunTone, ReactNode> = {
  ok: <CircleCheckIcon aria-hidden className="mt-px size-3.5 shrink-0 text-success" />,
  failed: <CircleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />,
  running: <Spinner aria-hidden size="sm" className="mt-px shrink-0" />,
  idle: null,
};

function RunSentence({ tone, text }: { readonly tone: DiyRunTone; readonly text: string }) {
  return (
    <span className={cn("flex items-start gap-1.5", tone === "failed" && "text-foreground")}>
      {TONE_ICON[tone]}
      <span>{text}</span>
    </span>
  );
}

function LogFold({ children }: { readonly children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex min-h-10 w-full items-center gap-1.5 rounded-b-xl px-3 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-panel-open:rounded-none sm:px-4">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        View log
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="border-t border-border/50 px-3 py-3 sm:px-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function DiyLogTail({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    serverEnvironment.diyLog({ environmentId, input: { lines: LOG_LINES } }),
  );
  return <DiyLogText text={query.data?.text ?? null} error={query.error} />;
}

export function DiyLogText({
  text,
  error,
}: {
  readonly text: string | null;
  readonly error: string | null;
}) {
  if (text === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {error ?? `Loading the last ${LOG_LINES} lines…`}
      </p>
    );
  }
  // column-reverse keeps the newest line in view without scrolling by hand.
  return (
    <div className="flex max-h-80 flex-col-reverse overflow-auto rounded-lg bg-muted/40 px-3 py-2">
      <pre className="whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-muted-foreground">
        {text.trimEnd() || "The log is empty."}
      </pre>
    </div>
  );
}

/** Claude and Codex instances the user already has in T3 Code; the kit runs no other provider. */
function ResolverPicker({
  environmentId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: DiyKitStatus;
}) {
  const navigate = useNavigate();
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const setResolver = useAtomCommand(
    serverEnvironment.diySetResolver,
    "Could not change the resolver",
  );
  const canChange = useAtomValue(serverEnvironment.diySetResolver.permissionAtom(environmentId));
  const [saving, setSaving] = useState(false);
  const entries = providerInstanceEntriesFor(providers, settings, null).filter(
    (entry) => DIY_RESOLVER_DRIVERS.has(entry.driverKind) && entry.enabled,
  );
  const current = status.resolver.provider === "codex" ? "codex" : "claude";
  const active =
    entries.find(
      (entry) => DIY_RESOLVER_DRIVERS.get(entry.driverKind) === current && entry.isDefault,
    ) ?? entries.find((entry) => DIY_RESOLVER_DRIVERS.get(entry.driverKind) === current);

  if (active === undefined) {
    return (
      <span className="text-sm text-muted-foreground">
        {RESOLVER_NAMES[current]}
        {status.resolver.model ? ` (${status.resolver.model})` : ""}. Add Claude or Codex in
        Providers to change it here.
      </span>
    );
  }

  const handleChange = async (instanceId: ProviderInstanceId, model: string) => {
    const entry = entries.find((candidate) => candidate.instanceId === instanceId);
    const provider = entry ? DIY_RESOLVER_DRIVERS.get(entry.driverKind) : undefined;
    if (provider === undefined) return;
    if (!DIY_RESOLVER_MODEL_PATTERN.test(model)) {
      toastManager.add({
        type: "error",
        title: "Could not change the resolver",
        description: `t3code-diy can't pass the model name "${model}" to ${RESOLVER_NAMES[provider]}.`,
      });
      return;
    }
    setSaving(true);
    await setResolver({ environmentId, input: { provider, model } });
    setSaving(false);
  };

  return (
    <ProviderModelPicker
      environmentId={environmentId}
      activeInstanceId={active.instanceId}
      model={status.resolver.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={getCustomModelOptionsByInstance(
        settings,
        providers.filter((provider) =>
          entries.some((entry) => entry.instanceId === provider.instanceId),
        ),
        active.instanceId,
        status.resolver.model,
      )}
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      triggerAriaLabel="Conflict resolver"
      disabled={!canChange || saving}
      onOpenProviderSetup={(instanceId) => {
        void navigate({ to: "/settings/providers", search: { environmentId, instanceId } });
      }}
      onInstanceModelChange={(instanceId, model) => void handleChange(instanceId, model)}
    />
  );
}
