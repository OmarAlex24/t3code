import {
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  LayersIcon,
  PlayIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SANDBOX_TAILSCALE_TAG,
  type EnvironmentId,
  SANDBOX_LIFETIME_CAP_MAX_MINUTES,
  SANDBOX_LIFETIME_CAP_MIN_MINUTES,
  type SandboxProviderInfo,
  type SandboxRecord,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { useNowMinute } from "~/hooks/useNowMinute";
import { serverEnvironment } from "~/state/server";
import { useSandboxProvisionerEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  describeSandboxFailure,
  SandboxQuotaLine,
  SandboxStartBlocked,
  SandboxStartConfirmation,
  useSandboxStartCheck,
} from "./SandboxStartLimits";
import { SandboxProviderLogo } from "./SandboxProviderLogo";
import { SandboxTemplateList, SaveSandboxTemplateDialog } from "./SandboxTemplates";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";

const EXTEND_CHOICES_MINUTES = [120, 240, 480] as const;

const formatDuration = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${Math.max(1, rest)} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

// The choices that fit under the cap, plus "the rest" when the cap falls between two of them.
const extendChoices = (headroomMinutes: number): ReadonlyArray<number> => {
  const fitting = EXTEND_CHOICES_MINUTES.filter((minutes) => minutes < headroomMinutes);
  return headroomMinutes <= EXTEND_CHOICES_MINUTES.at(-1)!
    ? [...fitting, headroomMinutes]
    : fitting;
};

const stateLabel = (sandbox: SandboxRecord): string => {
  switch (sandbox.state) {
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "provisioning":
      return "Provisioning";
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
  const providersQuery = useEnvironmentQuery(
    provisionerEnvironmentId === null
      ? null
      : serverEnvironment.sandboxesProviders({
          environmentId: provisionerEnvironmentId,
          input: undefined,
        }),
  );
  const sandboxes = list.data?.sandboxes ?? [];
  // Templates outlive the sandbox they came from, so they keep the section open on their own.
  const templateProviders = (providersQuery.data?.providers ?? []).filter(
    (provider) => provider.configured && provider.capabilities.templates,
  );
  // A saved provider key is enough: the server-wide sandbox settings matter before the first one.
  const anyConfigured = (providersQuery.data?.providers ?? []).some(
    (provider) => provider.configured,
  );
  if (provisionerEnvironmentId === null || (sandboxes.length === 0 && !anyConfigured)) {
    return null;
  }

  return (
    <SettingsSection id="sandboxes" title="Sandboxes">
      <SandboxLifetimeCapRow environmentId={provisionerEnvironmentId} />
      <SandboxTailscaleRow environmentId={provisionerEnvironmentId} />
      {list.error ? <p className="px-1 pb-2 text-xs text-destructive">{list.error}</p> : null}
      {sandboxes.map((sandbox) => (
        <SandboxRow
          key={sandbox.environmentId}
          environmentId={provisionerEnvironmentId}
          sandbox={sandbox}
          provider={providersQuery.data?.providers.find(
            (candidate) => candidate.kind === sandbox.provider,
          )}
          onChanged={() => void list.refresh()}
        />
      ))}
      {templateProviders.map((provider) => (
        <SandboxTemplateList
          key={provider.kind}
          environmentId={provisionerEnvironmentId}
          provider={provider}
        />
      ))}
    </SettingsSection>
  );
}

function SandboxLifetimeCapRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const capMinutes = useEnvironmentSettings(
    environmentId,
    (settings) => settings.sandboxLifetimeCapMinutes,
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  return (
    <SettingsRow
      title="Lifetime limit"
      description="The longest a sandbox can run, counted from when it was created. Extending a sandbox never goes past it."
      serverScoped
      settingKeys={["sandboxLifetimeCapMinutes"]}
      control={
        <div className="flex items-center gap-2">
          <NumberField
            value={capMinutes / 60}
            min={SANDBOX_LIFETIME_CAP_MIN_MINUTES / 60}
            max={SANDBOX_LIFETIME_CAP_MAX_MINUTES / 60}
            step={1}
            size="sm"
            className="w-28"
            onValueChange={(hours) => {
              if (hours === null) return;
              updateSettings({
                sandboxLifetimeCapMinutes: Math.min(
                  SANDBOX_LIFETIME_CAP_MAX_MINUTES,
                  Math.max(SANDBOX_LIFETIME_CAP_MIN_MINUTES, Math.round(hours * 60)),
                ),
              });
            }}
          >
            <NumberFieldGroup>
              <NumberFieldDecrement aria-label="Decrease sandbox lifetime limit" />
              <NumberFieldInput aria-label="Sandbox lifetime limit in hours" />
              <NumberFieldIncrement aria-label="Increase sandbox lifetime limit" />
            </NumberFieldGroup>
          </NumberField>
          <span className="text-xs text-muted-foreground">hours</span>
        </div>
      }
    />
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
  const stopSandbox = useAtomCommand(serverEnvironment.sandboxesStop, { reportFailure: false });
  const resumeSandbox = useAtomCommand(serverEnvironment.sandboxesResume, {
    reportFailure: false,
  });
  const deleteSandbox = useAtomCommand(serverEnvironment.sandboxesDelete, {
    reportFailure: false,
  });
  const extendSandbox = useAtomCommand(serverEnvironment.sandboxesExtend, {
    reportFailure: false,
  });
  const capMinutes = useEnvironmentSettings(
    environmentId,
    (settings) => settings.sandboxLifetimeCapMinutes,
  );
  const minute = useNowMinute();
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  // The tick is UTC truncated to the minute; a minute's precision is all these labels show.
  const nowMillis = Date.parse(`${minute}:00.000Z`);
  const remainingMinutes =
    sandbox.hardDeadlineAt === null
      ? null
      : Math.ceil((Date.parse(sandbox.hardDeadlineAt) - nowMillis) / 60_000);
  const pastDeadline = remainingMinutes !== null && remainingMinutes <= 0;
  const headroomMinutes = capMinutes - sandbox.ttlMinutes;
  // Until providers load, keep the controls; the server refuses what the driver cannot do.
  const canStopResume = provider?.capabilities.stopResume ?? true;
  const canStop = canStopResume && (sandbox.state === "running" || sandbox.state === "error");
  const canResume = canStopResume && sandbox.state === "stopped" && !pastDeadline;
  // Delete is always offered; it stays an icon beside Stop or Resume so it never reads as the
  // main action, and becomes the labeled action once neither can move the sandbox forward.
  const deleteIsSecondary = canStop || canResume;
  // Only a stopped sandbox can spend a start, so only it reads the provider's limits.
  const startCheck = useSandboxStartCheck({
    environmentId,
    provider: canResume ? provider : undefined,
  });
  const attention = ATTENTION[sandbox.state];
  const canExtend =
    (provider?.capabilities.extend ?? false) &&
    (sandbox.state === "running" || sandbox.state === "stopped") &&
    remainingMinutes !== null &&
    !pastDeadline;

  const canSaveTemplate =
    provider !== undefined && provider.capabilities.templates && sandbox.state === "running";

  const run = async (action: "stop" | "resume" | "delete" | { readonly extend: number }) => {
    startCheck.cancel();
    setConfirmingDelete(false);
    setPending(true);
    const input = { environmentId, input: { environmentId: sandbox.environmentId } };
    const result =
      action === "stop"
        ? await stopSandbox(input)
        : action === "resume"
          ? await resumeSandbox(input)
          : action === "delete"
            ? await deleteSandbox({
                environmentId,
                input: {
                  provider: sandbox.provider,
                  sandboxId: sandbox.sandboxId,
                  environmentId: sandbox.environmentId,
                },
              })
            : await extendSandbox({
                environmentId,
                input: { environmentId: sandbox.environmentId, minutes: action.extend },
              });
    setPending(false);
    if (action === "resume") startCheck.refresh();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = describeSandboxFailure(
          squashAtomCommandFailure(result),
          action === "stop"
            ? "Could not stop sandbox"
            : action === "resume"
              ? "Could not resume sandbox"
              : action === "delete"
                ? "Could not delete sandbox"
                : "Could not extend sandbox",
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

  const subtitle = [
    provider?.label ?? sandbox.provider,
    sandbox.size,
    ...(sandbox.template === undefined ? [] : [`from ${sandbox.template}`]),
    ...(attention === undefined ? [stateLabel(sandbox)] : []),
    ...(sandbox.costDollars === undefined ? [] : [formatCost(sandbox.costDollars)]),
    ...(remainingMinutes === null || attention !== undefined
      ? []
      : [
          pastDeadline
            ? "Lifetime limit reached"
            : sandbox.state === "running"
              ? `Stops in ${formatDuration(remainingMinutes)}`
              : `${formatDuration(remainingMinutes)} of lifetime left`,
        ]),
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
              <p className="truncate text-sm font-medium text-foreground">{sandbox.label}</p>
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
            {startCheck.limits === null ? null : <SandboxQuotaLine limits={startCheck.limits} />}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
          {canExtend ? (
            headroomMinutes > 0 ? (
              <Menu>
                <MenuTrigger render={<Button size="xs" variant="outline" disabled={pending} />}>
                  Extend
                  <ChevronDownIcon className="size-3" />
                </MenuTrigger>
                <MenuPopup align="end">
                  {extendChoices(headroomMinutes).map((minutes) => (
                    <MenuItem key={minutes} onClick={() => void run({ extend: minutes })}>
                      +{formatDuration(minutes)}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            ) : (
              <Tooltip>
                <TooltipTrigger render={<span tabIndex={0} />}>
                  <Button size="xs" variant="outline" disabled>
                    Extend
                  </Button>
                </TooltipTrigger>
                <TooltipPopup side="top">
                  At the {formatDuration(capMinutes)} lifetime limit set above.
                </TooltipPopup>
              </Tooltip>
            )
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
            `This deletes the machine and its disk at ${provider?.label ?? sandbox.provider}. It cannot be undone.`,
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
