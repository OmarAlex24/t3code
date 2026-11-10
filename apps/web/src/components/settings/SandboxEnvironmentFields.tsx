import { CheckIcon, CircleAlertIcon, ExternalLinkIcon, Trash2Icon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  AuthSettingsWriteScope,
  DEFAULT_SANDBOX_IDLE_MINUTES,
  DEFAULT_SANDBOX_MAX_RUNNING_MINUTES,
  type EnvironmentId,
  type SandboxCredentialEnvironment,
  type SandboxEnvironmentConfig,
  type SandboxProviderInfo,
  type SandboxSettleAction,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  AccessSwitch,
  ConfigSection,
  DetailField,
  Disclosure,
  FieldLabel,
  OptIn,
  SubHeading,
} from "./SandboxFormParts";
import { piUnavailableReason, SandboxPiFields } from "./SandboxPiFields";
import { SandboxProviderLogo } from "./SandboxProviderLogo";
import {
  SandboxAgentToolingFields,
  SandboxMcpServerFields,
  SandboxSetupToolingFields,
  useSandboxToolingDraft,
} from "./SandboxToolingFields";
import { describeSandboxFailure } from "./SandboxStartLimits";
import { useSandboxTemplates } from "./SandboxTemplates";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useProjects } from "~/state/entities";
import { hostCopyOf, sandboxRepositoryOf } from "~/state/sandboxRepositories";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";

const EMPTY_PROVIDERS: ReadonlyArray<SandboxProviderInfo> = [];
const EMPTY_CREDENTIAL_ENVIRONMENTS: ReadonlyArray<SandboxCredentialEnvironment> = [];
const NO_CREDENTIAL_ENVIRONMENT = "__none__";
const FRESH_MACHINE = "__fresh__";

const describeCredentialEnvironment = (
  environment: SandboxCredentialEnvironment,
  providerLabel: string,
): string => {
  if (environment.safeForThirdParties) {
    return environment.proxyAiCredentials
      ? `Passes nothing. AI calls go through ${providerLabel}'s proxy, so real keys stay outside the sandbox.`
      : "Passes nothing: no secrets, GitHub token, or agent logins.";
  }
  const passes = [
    environment.passGithub ? "GitHub token and repositories" : null,
    environment.passSecrets ? "environment secrets" : null,
    environment.passAgentsCredentials ? "agent logins" : null,
    environment.passSandboxCredentials ? "sandbox credentials" : null,
  ].filter((value): value is string => value !== null);
  return passes.length === 0 ? "Passes no credentials." : `Passes ${passes.join(", ")}.`;
};

const SETTLE_LABELS: Record<SandboxSettleAction, string> = {
  ask: "Ask me",
  snapshot: "Keep a snapshot",
  delete: "Delete without asking",
};

// What each choice does to the machine and the conversation on it, and what the provider bills.
const settleHint = (
  action: SandboxSettleAction,
  providerLabel: string,
  retentionDays: number | undefined,
) => {
  const kept =
    retentionDays === undefined
      ? `${providerLabel} bills for a stopped disk while it keeps it.`
      : `${providerLabel} keeps a stopped disk for ${retentionDays} days and bills for it.`;
  if (action === "snapshot") {
    return `Stops the sandbox and keeps its disk; sending a message resumes it. ${kept}`;
  }
  if (action === "delete") {
    return "Deletes the sandbox without asking, 10 seconds after the settle; the settle's Undo cancels it. It still asks first when it finds unpushed work or can't check.";
  }
  return `Asks whether to keep a snapshot or delete the sandbox. ${kept}`;
};

const SETTLE_SUMMARY: Record<SandboxSettleAction, string | null> = {
  ask: null,
  snapshot: "keeps a snapshot when settled",
  delete: "deleted when settled",
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const CONFIG_SECTIONS = ["machine", "agent", "setup"] as const;
type ConfigSectionId = (typeof CONFIG_SECTIONS)[number];

const formatMinutes = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

function MinutesField({
  label,
  hint,
  unit = "minutes",
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (minutes: number) => void;
}) {
  return (
    <div className="space-y-1">
      <FieldLabel>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <NumberField
          value={value}
          min={min}
          max={max}
          step={5}
          size="sm"
          className="w-32"
          disabled={disabled}
          onValueChange={(next) => {
            if (next !== null) onChange(Math.min(max, Math.max(min, Math.round(next))));
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={`Decrease ${label.toLowerCase()}`} />
            <NumberFieldInput aria-label={`${label} in minutes`} />
            <NumberFieldIncrement aria-label={`Increase ${label.toLowerCase()}`} />
          </NumberFieldGroup>
        </NumberField>
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
      <p className="text-2xs leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}

const parseFileList = (text: string) =>
  text
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

/** Keeps the Add environment dialog open while a config is being saved. */
export function useSandboxProvisioningLock() {
  const [isProvisioning, setIsProvisioning] = useState(false);
  // The dialog's close handler runs in the same tick as the completion callback, before React
  // re-renders, so the lock has to be readable synchronously.
  const lockedRef = useRef(false);
  const onProvisioningChange = (provisioning: boolean) => {
    lockedRef.current = provisioning;
    setIsProvisioning(provisioning);
  };
  return { isProvisioning, lockedRef, onProvisioningChange };
}

/**
 * Creates or edits a sandbox config: what each thread's sandbox is made from. Saving makes no
 * machine; a thread started on the config gets its own.
 */
export function SandboxEnvironmentFields({
  environmentId,
  config,
  error,
  onErrorChange,
  onProvisioningChange,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  /** The config being edited; omit to add one. */
  readonly config?: SandboxEnvironmentConfig;
  readonly error: string | null;
  readonly onErrorChange: (error: string | null) => void;
  /** Lets the dialog lock its mode cards and refuse to close while the config saves. */
  readonly onProvisioningChange?: (saving: boolean) => void;
  readonly onDone: () => void;
}) {
  const navigate = useNavigate();
  const providersQuery = useEnvironmentQuery(
    serverEnvironment.sandboxesProviders({ environmentId, input: undefined }),
  );
  const refreshProviders = useEffectEvent(() => providersQuery.refresh());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- skills, MCP servers and credentials on the server change outside this client, so each opened form reads them fresh
  useEffect(() => refreshProviders(), []);
  const saveConfig = useAtomCommand(serverEnvironment.sandboxesSaveConfig, {
    reportFailure: false,
  });
  const deleteConfig = useAtomCommand(serverEnvironment.sandboxesDeleteConfig, {
    reportFailure: false,
  });
  const [selectedKind, setSelectedKind] = useState<string | null>(config?.provider ?? null);
  const [apiKey, setApiKey] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  // Edits to the provider's settings fields; untouched fields show the saved value.
  const [settingsDraft, setSettingsDraft] = useState<Readonly<Record<string, string>>>({});
  const [label, setLabel] = useState(config?.label ?? "");
  const [size, setSize] = useState(config?.size ?? "");
  const [credentialEnvironment, setCredentialEnvironment] = useState(
    config?.credentialEnvironment ?? "",
  );
  const [templateName, setTemplateName] = useState(config?.template ?? "");
  const [allowCredentials, setAllowCredentials] = useState(
    config?.credentialEnvironment !== undefined,
  );
  const [useClaude, setUseClaude] = useState(config?.claude !== undefined);
  // Null until edited, so the field follows the server's current endpoint.
  const [claudeBaseUrl, setClaudeBaseUrl] = useState<string | null>(
    config?.claude?.baseUrl ?? null,
  );
  const [agentProviderAccess, setAgentProviderAccess] = useState(
    config?.agentProviderAccess ?? false,
  );
  const [usePi, setUsePi] = useState(config?.pi !== undefined);
  const [piStartModel, setPiStartModel] = useState(config?.pi?.startModel ?? "");
  const [onSettle, setOnSettle] = useState<SandboxSettleAction>(config?.onSettle ?? "ask");
  // Null until toggled, so it follows whether the server's Claude endpoint is private.
  // Stored off means automatic: a launch joins anyway while Claude's endpoint is private.
  const [joinTailnet, setJoinTailnet] = useState(config?.joinTailnet ?? false);
  const [tailnetOnly, setTailnetOnly] = useState(config?.access === "tailnet");
  const projects = useProjects();
  // Files picked for a repository before; any other repository on this machine gets its env files.
  const [envFiles, setEnvFiles] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(
      Object.entries(config?.envFiles ?? {}).map(([key, files]) => [key, files.join(", ")]),
    ),
  );
  const [idleMinutes, setIdleMinutes] = useState(
    config?.idleMinutes ?? DEFAULT_SANDBOX_IDLE_MINUTES,
  );
  // Null is no hard limit: a sandbox that keeps itself up runs as long as its threads work.
  const [runningCapMinutes, setRunningCapMinutes] = useState<number | null>(
    config?.runningCapMinutes ?? null,
  );
  // Offered only to a config that already has it, so it can be turned off.
  const offersTailnetOnly = config?.access === "tailnet";
  const [editingEndpoint, setEditingEndpoint] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [maxRunningMinutes, setMaxRunningMinutes] = useState(
    config?.maxRunningMinutes ?? DEFAULT_SANDBOX_MAX_RUNNING_MINUTES,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const providers = providersQuery.data?.providers ?? EMPTY_PROVIDERS;
  const host = providersQuery.data?.host;
  const tooling = useSandboxToolingDraft(config, host);
  const provider = providers.find((candidate) => candidate.kind === selectedKind) ?? providers[0];
  const templates = useSandboxTemplates(environmentId, provider);
  const template = templates.templates.find((candidate) => candidate.name === templateName);
  // A template keeps the machine size it was saved from.
  const selectedSize =
    template !== undefined
      ? (template.size ?? provider?.defaultSize ?? "")
      : size === ""
        ? (provider?.defaultSize ?? "")
        : size;
  const environmentsQuery = useEnvironmentQuery(
    provider?.capabilities.credentialEnvironments
      ? serverEnvironment.sandboxesEnvironments({
          environmentId,
          input: { provider: provider.kind },
        })
      : null,
  );
  const credentialEnvironments =
    environmentsQuery.data?.environments ?? EMPTY_CREDENTIAL_ENVIRONMENTS;
  const selectedCredentialEnvironment = credentialEnvironments.find(
    (candidate) => candidate.name === credentialEnvironment,
  );
  const passesCredentials =
    selectedCredentialEnvironment !== undefined &&
    !selectedCredentialEnvironment.safeForThirdParties &&
    (selectedCredentialEnvironment.passGithub ||
      selectedCredentialEnvironment.passSecrets ||
      selectedCredentialEnvironment.passAgentsCredentials ||
      selectedCredentialEnvironment.passSandboxCredentials);
  const canWriteSettings = readEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const claudeEndpoint = (claudeBaseUrl ?? host?.claude?.baseUrl ?? "").trim();
  const sendsClaude = useClaude && (host?.claude !== undefined || config?.claude !== undefined);
  const piUnavailable = piUnavailableReason(host, sendsClaude);
  const sendsPi = usePi && piUnavailable === null;
  // Read from settings, so a client saved in the Sandboxes section applies without a refetch.
  const tailscaleReady = useEnvironmentSettings(
    environmentId,
    (settings) =>
      settings.sandboxTailscale.clientId !== "" && settings.sandboxTailscale.clientSecret !== "",
  );
  // The server judged only its own endpoint; each launch judges the saved one again.
  const privateClaude =
    sendsClaude && host?.claude?.privateNetwork === true && claudeEndpoint === host.claude.baseUrl;
  const claudeHost = URL.parse(claudeEndpoint)?.host ?? claudeEndpoint;
  const autoJoinsTailnet = tailscaleReady && privateClaude;
  const joinsTailnet = tailscaleReady && (joinTailnet || autoJoinsTailnet);
  // Forks of a sandbox share its environment, so a credential environment rules this out.
  const canGiveAgentAccess =
    provider?.capabilities.agentProviderAccess === true && credentialEnvironment === "";
  const disabled =
    isSaving ||
    provider === undefined ||
    !canWriteSettings ||
    (passesCredentials && !allowCredentials) ||
    (sendsClaude && claudeEndpoint === "") ||
    tooling.attention !== null ||
    (provider !== undefined && !provider.configured && apiKey.trim() === "");

  const settingsFields = provider?.settingsFields ?? [];
  const requiredSettingsFields = settingsFields.filter((field) => !field.optional);
  const optionalSettingsFields = settingsFields.filter((field) => field.optional);
  const settingValue = (id: string) => settingsDraft[id] ?? provider?.settings?.[id] ?? "";
  const showsKeyInput = provider !== undefined && (!provider.configured || replacingKey);

  // Every problem is about what the agent gets, so it names the Agent access field to fix; it has
  // to show while that section is closed.
  const attention =
    sendsClaude && claudeEndpoint === ""
      ? "Enter a Claude endpoint"
      : sendsClaude && privateClaude && !tailscaleReady
        ? `${claudeHost} is private, so sandboxes need Tailscale to reach Claude`
        : passesCredentials && !allowCredentials
          ? `Confirm the credentials the ${provider?.label ?? ""} environment passes`
          : tooling.attention;
  // Where the provider keeps a sandbox up while it works, the running limit is only a fallback.
  const keepsItselfUp = provider?.capabilities.keepAlive === true;
  const machineSummary = [
    ...(keepsItselfUp
      ? [
          `stops after ${formatMinutes(idleMinutes)} without work`,
          runningCapMinutes === null ? null : `at most ${formatMinutes(runningCapMinutes)} running`,
        ]
      : [`stops after ${formatMinutes(maxRunningMinutes)} running`]),
    joinsTailnet
      ? tailnetOnly
        ? "reached only through your tailnet"
        : "joins your tailnet"
      : null,
    SETTLE_SUMMARY[onSettle],
  ].filter((part): part is string => part !== null);
  const agentSummary = [
    sendsClaude ? `Claude via ${claudeHost}` : null,
    sendsPi
      ? piStartModel === ""
        ? "Pi with hub models"
        : `Pi with hub models, new chats on ${piStartModel}`
      : null,
    ...tooling.agentSummaryParts,
    agentProviderAccess && canGiveAgentAccess && provider !== undefined
      ? `agent can use ${provider.label}`
      : null,
    selectedCredentialEnvironment === undefined
      ? null
      : `${selectedCredentialEnvironment.name} environment`,
  ].filter((part): part is string => part !== null);
  const customEnvFiles = Object.values(envFiles).filter((text) => text.trim() !== "").length;
  const setupSummary = [
    ...tooling.setupSummaryParts,
    customEnvFiles === 0
      ? null
      : `picked env files for ${customEnvFiles} ${customEnvFiles === 1 ? "repository" : "repositories"}`,
  ].filter((part): part is string => part !== null);
  // One section at a time, so the dialog stays short.
  const [openSection, setOpenSection] = useState<ConfigSectionId | null>(null);
  const setSectionOpen = (section: ConfigSectionId, open: boolean) =>
    setOpenSection((current) => (open ? section : current === section ? null : current));
  // Opens Agent access each time a new problem shows up, such as once the server's endpoint
  // loads; closing it again stays the user's call.
  const [shownAttention, setShownAttention] = useState<string | null>(null);
  if (attention !== shownAttention) {
    setShownAttention(attention);
    if (attention !== null) setSectionOpen("agent", true);
  }

  const setSaving = (saving: boolean) => {
    setIsSaving(saving);
    onProvisioningChange?.(saving);
  };

  const reportFailure = (
    result: Parameters<typeof isAtomCommandInterrupted>[0] &
      Parameters<typeof squashAtomCommandFailure>[0],
    title: string,
  ) => {
    if (isAtomCommandInterrupted(result)) return;
    onErrorChange(describeSandboxFailure(squashAtomCommandFailure(result), title).description);
  };

  const handleSave = async () => {
    if (provider === undefined) return;
    setSaving(true);
    onErrorChange(null);
    const result = await saveConfig({
      environmentId,
      input: {
        config: {
          ...(config === undefined ? {} : { id: config.id }),
          label: label.trim() || `${provider.label} sandbox`,
          provider: provider.kind,
          size: selectedSize,
          ...(template === undefined ? {} : { template: template.name }),
          ...(credentialEnvironment === "" ? {} : { credentialEnvironment }),
          ...(sendsClaude ? { claude: { baseUrl: claudeEndpoint } } : {}),
          ...(sendsPi ? { pi: piStartModel === "" ? {} : { startModel: piStartModel } } : {}),
          ...tooling.toConfig(),
          ...(agentProviderAccess && canGiveAgentAccess ? { agentProviderAccess: true } : {}),
          ...(onSettle === "ask" ? {} : { onSettle }),
          // A tailnet-only sandbox has to ask to join; otherwise the launch decides.
          joinTailnet: tailscaleReady && (joinTailnet || (autoJoinsTailnet && tailnetOnly)),
          access: joinsTailnet && tailnetOnly ? "tailnet" : "public",
          envFiles: Object.fromEntries(
            Object.entries(envFiles)
              .map(([id, text]) => [id, parseFileList(text)] as const)
              .filter(([, files]) => files.length > 0),
          ),
          idleMinutes,
          maxRunningMinutes,
          ...(keepsItselfUp && runningCapMinutes !== null ? { runningCapMinutes } : {}),
        },
        ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
        ...(settingsFields.length === 0
          ? {}
          : {
              settings: Object.fromEntries(
                settingsFields.map((field) => [field.id, settingValue(field.id).trim()]),
              ),
            }),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      reportFailure(result, "Could not save the sandbox config");
      return;
    }
    setApiKey("");
    onDone();
  };

  const handleDelete = async () => {
    if (config === undefined) return;
    setSaving(true);
    onErrorChange(null);
    const result = await deleteConfig({ environmentId, input: { configId: config.id } });
    setSaving(false);
    if (result._tag === "Failure") {
      reportFailure(result, "Could not delete the sandbox config");
      return;
    }
    onDone();
  };

  const settingsFieldInputs = (fields: typeof settingsFields) =>
    fields.length === 0 ? null : (
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => (
          <label key={field.id} className="block">
            <FieldLabel>
              <span>
                {field.label}
                {field.optional ? (
                  <span className="font-normal text-muted-foreground"> (optional)</span>
                ) : null}
              </span>
            </FieldLabel>
            <Input
              value={settingValue(field.id)}
              onChange={(event) =>
                setSettingsDraft({ ...settingsDraft, [field.id]: event.target.value })
              }
              placeholder={field.placeholder}
              disabled={isSaving}
              spellCheck={false}
            />
          </label>
        ))}
      </div>
    );

  // Keyed by repository, or by a project on this machine for configs saved before that.
  const envFilesLabel = (key: string) => {
    const project =
      projects.find(
        (candidate) => candidate.environmentId === environmentId && candidate.id === key,
      ) ?? hostCopyOf(projects, environmentId, key);
    return project === null ? key : (sandboxRepositoryOf(project)?.label ?? project.title);
  };

  return (
    <div className="space-y-4">
      {providersQuery.error ? (
        <Alert variant="error">
          <AlertDescription>{providersQuery.error}</AlertDescription>
        </Alert>
      ) : null}
      {providers.length === 0 && providersQuery.isPending ? (
        <p className="text-xs text-muted-foreground">Loading sandbox providers…</p>
      ) : provider === undefined ? null : (
        <div className="space-y-1.5">
          <ToggleGroup
            aria-label="Sandbox provider"
            className="w-full flex-wrap"
            value={[provider.kind]}
            // A config's sandboxes stay with the provider they were made on.
            disabled={isSaving || config !== undefined}
            onValueChange={(values) => {
              const next = values[0];
              if (next === undefined || next === provider.kind) return;
              setSelectedKind(next);
              setSize("");
              setTemplateName("");
              // Never carry one provider's key into another provider's replacement field.
              setApiKey("");
              setReplacingKey(false);
              setSettingsDraft({});
              setCredentialEnvironment("");
              setAllowCredentials(false);
            }}
          >
            {providers.map((candidate) => (
              <Toggle key={candidate.kind} value={candidate.kind} className="grow">
                <SandboxProviderLogo kind={candidate.kind} />
                {candidate.label}
                {candidate.configured ? (
                  <span className="text-2xs font-normal text-muted-foreground">Key saved</span>
                ) : null}
              </Toggle>
            ))}
          </ToggleGroup>
          <p className="text-2xs text-muted-foreground">{provider.detail}</p>
        </div>
      )}

      {provider === undefined ? null : (
        <>
          {showsKeyInput ? (
            <label className="block">
              <FieldLabel
                trailing={
                  <a
                    href={provider.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-2xs font-normal text-muted-foreground hover:text-foreground"
                  >
                    Get a key
                    <ExternalLinkIcon aria-hidden className="size-3" />
                  </a>
                }
              >
                {provider.apiKeyLabel}
              </FieldLabel>
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={provider.apiKeyPlaceholder}
                disabled={isSaving}
                spellCheck={false}
              />
            </label>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckIcon aria-hidden className="size-3.5 text-success" />
              <span>{provider.apiKeyLabel} saved</span>
              <span aria-hidden>·</span>
              <Button
                variant="link"
                size="xs"
                disabled={isSaving}
                onClick={() => setReplacingKey(true)}
              >
                Replace
              </Button>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
            <label className="block">
              <FieldLabel>Name</FieldLabel>
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={`${provider.label} sandbox`}
                disabled={isSaving}
                spellCheck={false}
              />
            </label>
            <label className="block">
              <FieldLabel>Size</FieldLabel>
              <Select
                value={selectedSize}
                disabled={isSaving || template !== undefined}
                onValueChange={(value) => {
                  if (value !== null) setSize(value);
                }}
              >
                <SelectTrigger aria-label="Sandbox machine size" size="default">
                  <SelectValue>
                    {provider.sizes.find((candidate) => candidate.id === selectedSize)?.label ??
                      (template === undefined ? "Choose a size" : "Template's size")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {provider.sizes.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.label}, {candidate.detail}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          </div>

          {templates.templates.length === 0 ? null : (
            <div className="space-y-1.5">
              <label className="block">
                <FieldLabel>Start from</FieldLabel>
                <Select
                  value={template?.name ?? FRESH_MACHINE}
                  disabled={isSaving}
                  onValueChange={(value) => {
                    if (value !== null) setTemplateName(value === FRESH_MACHINE ? "" : value);
                  }}
                >
                  <SelectTrigger aria-label="Start each sandbox from" size="default">
                    <SelectValue>{template?.name ?? "Fresh machine"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={FRESH_MACHINE}>Fresh machine</SelectItem>
                    {templates.templates.map((candidate) => (
                      <SelectItem key={candidate.name} value={candidate.name}>
                        {candidate.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              {template === undefined ? null : (
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  Each sandbox starts with the template's tools and files, at the size it was saved
                  from.
                </p>
              )}
            </div>
          )}

          {settingsFieldInputs(requiredSettingsFields)}

          <div className="rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50">
            <ConfigSection
              id="machine"
              title="Machine"
              summary={capitalize(machineSummary.join(" · "))}
              attention={null}
              open={openSection === "machine"}
              onOpenChange={(open) => setSectionOpen("machine", open)}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="block">
                    <FieldLabel>When a chat is settled</FieldLabel>
                    <Select
                      value={onSettle}
                      disabled={isSaving}
                      onValueChange={(value) => {
                        if (value !== null) setOnSettle(value);
                      }}
                    >
                      <SelectTrigger aria-label="When a chat is settled" size="default">
                        <SelectValue>{SETTLE_LABELS[onSettle]}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="ask">{SETTLE_LABELS.ask}</SelectItem>
                        {provider.capabilities.stopResume ? (
                          <SelectItem value="snapshot">{SETTLE_LABELS.snapshot}</SelectItem>
                        ) : null}
                        <SelectItem value="delete">{SETTLE_LABELS.delete}</SelectItem>
                      </SelectPopup>
                    </Select>
                  </label>
                  <p className="text-2xs leading-relaxed text-muted-foreground">
                    {settleHint(onSettle, provider.label, provider.diskRetentionDays)}
                  </p>
                </div>
                {keepsItselfUp ? (
                  <MinutesField
                    label="Stop when idle"
                    hint="Keeps running while any of its threads work, even with this app closed, and stops this long after they finish. The disk stays until you delete it."
                    unit="min without work"
                    value={idleMinutes}
                    min={5}
                    max={1440}
                    disabled={isSaving}
                    onChange={setIdleMinutes}
                  />
                ) : (
                  <MinutesField
                    label="Running limit"
                    hint="Stopped after running this long since its last start. The disk stays until you delete it."
                    value={maxRunningMinutes}
                    min={10}
                    max={43_200}
                    disabled={isSaving}
                    onChange={setMaxRunningMinutes}
                  />
                )}
              </div>
              {keepsItselfUp ? (
                <div className="space-y-2">
                  <OptIn
                    checked={runningCapMinutes !== null}
                    disabled={isSaving}
                    onCheckedChange={(checked) =>
                      setRunningCapMinutes(checked ? maxRunningMinutes : null)
                    }
                    title="Hard limit"
                  >
                    Stops the sandbox after running this long since its last start, even while its
                    threads work.
                  </OptIn>
                  {runningCapMinutes === null ? null : (
                    <div className="ps-6.5">
                      <MinutesField
                        label="Hard limit"
                        hint="Sending a message resumes it."
                        value={runningCapMinutes}
                        min={10}
                        max={43_200}
                        disabled={isSaving}
                        onChange={setRunningCapMinutes}
                      />
                    </div>
                  )}
                </div>
              ) : null}
              {tailscaleReady ? (
                <div className="space-y-2">
                  {autoJoinsTailnet ? (
                    <p className="flex items-start gap-2 text-xs text-foreground">
                      <CheckIcon aria-hidden className="mt-px size-3.5 shrink-0 text-success" />
                      <span>Joins your tailnet automatically because {claudeHost} is private.</span>
                    </p>
                  ) : (
                    <OptIn
                      checked={joinTailnet}
                      disabled={isSaving}
                      onCheckedChange={setJoinTailnet}
                      title="Join my tailnet"
                    >
                      As an ephemeral, tagged device, removed with the sandbox.
                    </OptIn>
                  )}
                  {joinsTailnet && offersTailnetOnly ? (
                    <div className="ps-6.5">
                      <OptIn
                        checked={tailnetOnly}
                        disabled={isSaving}
                        onCheckedChange={setTailnetOnly}
                        title="Reach it only through my tailnet"
                      >
                        No public URL, so the machine running this app has to be on your tailnet.
                      </OptIn>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {settingsFieldInputs(optionalSettingsFields)}
            </ConfigSection>
            <ConfigSection
              id="agent"
              title="Agent access"
              summary={
                agentSummary.length === 0
                  ? "Nothing from this machine"
                  : capitalize(agentSummary.join(" · "))
              }
              attention={attention}
              open={openSection === "agent"}
              onOpenChange={(open) => setSectionOpen("agent", open)}
            >
              <div className="-mt-2.5 space-y-1">
                <div className="divide-y divide-border/50">
                  {host?.claude === undefined ? null : (
                    <AccessSwitch
                      name="Claude"
                      state={
                        host.claude.key === "hub"
                          ? "Its own key on your hub, removed on delete"
                          : "A copy of this machine's token, not revoked on delete"
                      }
                      checked={useClaude}
                      disabled={isSaving}
                      onCheckedChange={setUseClaude}
                    >
                      {editingEndpoint ||
                      claudeEndpoint === "" ||
                      claudeEndpoint !== host.claude.baseUrl ? (
                        <DetailField label="Endpoint">
                          <Input
                            type="url"
                            size="sm"
                            aria-label="Claude endpoint"
                            value={claudeBaseUrl ?? host.claude.baseUrl}
                            onChange={(event) => {
                              setEditingEndpoint(true);
                              setClaudeBaseUrl(event.target.value);
                            }}
                            disabled={isSaving}
                            spellCheck={false}
                          />
                        </DetailField>
                      ) : (
                        <DetailField label="Endpoint">
                          <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
                            <span className="truncate">{claudeEndpoint}</span>
                            <Button
                              variant="link"
                              size="xs"
                              aria-label="Edit Claude endpoint"
                              disabled={isSaving}
                              onClick={() => setEditingEndpoint(true)}
                            >
                              Edit
                            </Button>
                          </span>
                        </DetailField>
                      )}
                      {/* Judged by the server for its own endpoint only; an edited URL is checked live. */}
                      {!host.claude.privateNetwork ||
                      claudeEndpoint !== host.claude.baseUrl ||
                      tailscaleReady ? null : (
                        <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-warning-foreground">
                          <CircleAlertIcon aria-hidden className="mt-px size-3 shrink-0" />
                          <span className="min-w-0 flex-1">
                            Resolves to a private address, so sandboxes need your tailnet to reach
                            it.
                            {!provider.configured ? null : (
                              <>
                                {" "}
                                <button
                                  type="button"
                                  className="font-medium underline underline-offset-2 hover:text-foreground"
                                  onClick={() => {
                                    onDone();
                                    void navigate({
                                      to: "/settings/connections",
                                      hash: "sandbox-tailscale",
                                    });
                                  }}
                                >
                                  Set up Tailscale
                                </button>
                              </>
                            )}
                          </span>
                        </p>
                      )}
                    </AccessSwitch>
                  )}
                  <SandboxPiFields
                    host={host}
                    unavailable={piUnavailable}
                    enabled={usePi}
                    startModel={piStartModel}
                    disabled={isSaving}
                    onEnabledChange={setUsePi}
                    onStartModelChange={setPiStartModel}
                  />
                  <SandboxAgentToolingFields
                    draft={tooling}
                    disabled={isSaving}
                    onOpenSettings={() => {
                      onDone();
                      void navigate({ to: "/settings/connections", hash: "sandbox-github-app" });
                    }}
                  />
                  <SandboxMcpServerFields draft={tooling} disabled={isSaving} />
                </div>
                <button
                  type="button"
                  className="text-2xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => {
                    onDone();
                    void navigate({ to: "/settings/connections", hash: "sandbox-integrations" });
                  }}
                >
                  Connect more in Settings
                </button>
              </div>
              {provider.capabilities.agentProviderAccess ||
              provider.capabilities.credentialEnvironments ? (
                <div className="border-t border-border/50 pt-2">
                  <Disclosure
                    title="Advanced"
                    // The acknowledgement gates saving, so it can't hide behind a fold.
                    open={advancedOpen || (passesCredentials && !allowCredentials)}
                    onOpenChange={setAdvancedOpen}
                  >
                    {provider.capabilities.agentProviderAccess ? (
                      <AccessSwitch
                        name={`Let the agent use ${provider.label}`}
                        state={
                          canGiveAgentAccess
                            ? "It can fork its own sandbox, host its ports, and delete only the forks it made. Forks bill like new sandboxes."
                            : `Needs No credentials as the ${provider.label} environment, so forks never get its secrets.`
                        }
                        checked={agentProviderAccess && canGiveAgentAccess}
                        disabled={isSaving || !canGiveAgentAccess}
                        onCheckedChange={setAgentProviderAccess}
                      />
                    ) : null}
                    {provider.capabilities.credentialEnvironments ? (
                      <div className="space-y-2">
                        <label className="block">
                          <FieldLabel>{provider.label} environment</FieldLabel>
                          <Select
                            value={
                              credentialEnvironment === ""
                                ? NO_CREDENTIAL_ENVIRONMENT
                                : credentialEnvironment
                            }
                            disabled={isSaving || environmentsQuery.isPending}
                            onValueChange={(value) => {
                              if (value === null) return;
                              setCredentialEnvironment(
                                value === NO_CREDENTIAL_ENVIRONMENT ? "" : value,
                              );
                              setAllowCredentials(false);
                            }}
                          >
                            <SelectTrigger
                              aria-label={`${provider.label} credential environment`}
                              size="default"
                            >
                              <SelectValue>
                                {selectedCredentialEnvironment?.name ??
                                  "No credentials (recommended)"}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectPopup>
                              <SelectItem value={NO_CREDENTIAL_ENVIRONMENT}>
                                No credentials (recommended)
                              </SelectItem>
                              {credentialEnvironments.map((candidate) => (
                                <SelectItem key={candidate.name} value={candidate.name}>
                                  {candidate.name}
                                  {candidate.safeForThirdParties ? " (safe for third parties)" : ""}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        </label>
                        <p className="text-2xs leading-relaxed text-muted-foreground">
                          {selectedCredentialEnvironment === undefined
                            ? `No ${provider.label} secrets, GitHub token, or agent logins reach the sandboxes.`
                            : describeCredentialEnvironment(
                                selectedCredentialEnvironment,
                                provider.label,
                              )}
                        </p>
                        {passesCredentials ? (
                          <Alert variant="error">
                            <AlertDescription>
                              <label className="flex cursor-pointer items-start gap-2">
                                <Checkbox
                                  className="mt-0.5"
                                  checked={allowCredentials}
                                  disabled={isSaving}
                                  onCheckedChange={(checked) =>
                                    setAllowCredentials(checked === true)
                                  }
                                />
                                <span>
                                  I understand every sandbox from this config will receive the
                                  credentials listed above.
                                </span>
                              </label>
                            </AlertDescription>
                          </Alert>
                        ) : null}
                      </div>
                    ) : null}
                  </Disclosure>
                </div>
              ) : null}
            </ConfigSection>
            <ConfigSection
              id="setup"
              title="Setup"
              summary={
                setupSummary.length === 0
                  ? "Copies env files only"
                  : capitalize(setupSummary.join(" · "))
              }
              attention={null}
              open={openSection === "setup"}
              onOpenChange={(open) => setSectionOpen("setup", open)}
            >
              <SandboxSetupToolingFields draft={tooling} disabled={isSaving} />
              <div className="space-y-1.5">
                <SubHeading>Env files</SubHeading>
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  When a project is also open on this machine, each sandbox gets a copy of its
                  git-ignored env files (.env files, .envrc, .dev.vars).
                </p>
                {Object.keys(envFiles).length === 0 ? null : (
                  <>
                    <FieldLabel>Files copied from this machine</FieldLabel>
                    {Object.keys(envFiles).map((key) => (
                      <label key={key} className="block">
                        <span className="mb-1 block text-2xs text-muted-foreground">
                          {envFilesLabel(key)}
                        </span>
                        <Input
                          value={envFiles[key] ?? ""}
                          onChange={(event) =>
                            setEnvFiles({ ...envFiles, [key]: event.target.value })
                          }
                          placeholder=".env files, .envrc, .dev.vars"
                          disabled={isSaving}
                          spellCheck={false}
                        />
                      </label>
                    ))}
                    <p className="text-2xs leading-relaxed text-muted-foreground">
                      Paths relative to the project, separated by commas. Leave empty for the env
                      files.
                    </p>
                  </>
                )}
              </div>
            </ConfigSection>
          </div>

          <p className="text-2xs leading-relaxed text-muted-foreground">
            Saving makes no machine. Each thread you start on this config gets its own sandbox,
            billed to the {provider.label} account that owns the key.
          </p>

          {!canWriteSettings ? (
            <Alert variant="error">
              <AlertDescription>
                This connection cannot change settings on the environment that keeps sandbox
                configs.
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          {attention === null ? null : (
            <p
              role="status"
              data-testid="sandbox-config-attention"
              className="flex items-start gap-1.5 text-xs leading-relaxed text-warning-foreground"
            >
              <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0">{attention}, under Agent access.</span>
            </p>
          )}

          {confirmingDelete && config !== undefined ? (
            <div
              role="group"
              aria-label="Delete this config"
              className="space-y-3 rounded-lg border border-destructive/32 bg-destructive/4 p-3"
            >
              <p className="text-xs leading-relaxed text-foreground">
                Delete {config.label}? Sandboxes already made from it keep running until you delete
                them.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
                  Keep
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={isSaving}
                  onClick={() => void handleDelete()}
                >
                  {isSaving ? <Spinner className="size-3.5" /> : <Trash2Icon aria-hidden />}
                  Delete config
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
              {config === undefined ? null : (
                <Button
                  variant="destructive-outline"
                  size="sm"
                  disabled={isSaving}
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2Icon aria-hidden />
                  Delete config…
                </Button>
              )}
              <Button className="ms-auto" disabled={disabled} onClick={() => void handleSave()}>
                {isSaving ? <Spinner className="size-3.5" /> : null}
                {config === undefined ? "Add sandbox config" : "Save changes"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
