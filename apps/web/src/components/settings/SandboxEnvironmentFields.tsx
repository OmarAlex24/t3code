import { CheckIcon, ChevronRightIcon, CircleAlertIcon, ExternalLinkIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";
import {
  AuthSettingsWriteScope,
  DEFAULT_SANDBOX_IDLE_MINUTES,
  DEFAULT_SANDBOX_MAX_RUNNING_MINUTES,
  type EnvironmentId,
  type SandboxCredentialEnvironment,
  type SandboxEnvironmentConfig,
  type SandboxProviderInfo,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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
import { SandboxProviderLogo } from "./SandboxProviderLogo";
import { describeSandboxFailure } from "./SandboxStartLimits";
import { useSandboxTemplates } from "./SandboxTemplates";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useProjects } from "~/state/entities";
import {
  repositoriesFromLegacyConfig,
  sandboxRepositoryChoices,
} from "~/state/sandboxRepositories";
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

function FieldLabel({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <span className="mb-1.5 flex items-center justify-between gap-2 text-xs font-medium text-foreground">
      {children}
      {trailing}
    </span>
  );
}

function OptIn({
  checked,
  disabled,
  onCheckedChange,
  title,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 has-disabled:cursor-not-allowed">
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <span className="min-w-0 space-y-0.5">
        <span className="block text-xs font-medium text-foreground">{title}</span>
        <span className="block text-2xs leading-relaxed text-muted-foreground">{children}</span>
      </span>
    </label>
  );
}

function MinutesField({
  label,
  hint,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
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
        <span className="text-xs text-muted-foreground">minutes</span>
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
  const [passGithub, setPassGithub] = useState(config?.passGithubToken ?? false);
  // Null until toggled, so it follows whether the server's Claude endpoint is private.
  const [joinTailnet, setJoinTailnet] = useState<boolean | null>(config?.joinTailnet ?? null);
  const [tailnetOnly, setTailnetOnly] = useState(config?.access === "tailnet");
  const projects = useProjects();
  // A config saved with host project ids opens as the repositories those projects clone.
  const [initialAccess] = useState(() =>
    config === undefined
      ? { repositories: [], envFiles: {} }
      : (config.repositories ?? []).length > 0
        ? { repositories: config.repositories ?? [], envFiles: config.envFiles }
        : repositoriesFromLegacyConfig(config, projects, environmentId),
  );
  const [repositories, setRepositories] = useState<ReadonlyArray<string>>(
    initialAccess.repositories,
  );
  const [envFiles, setEnvFiles] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(
      Object.entries(initialAccess.envFiles).map(([key, files]) => [key, files.join(", ")]),
    ),
  );
  const [idleMinutes, setIdleMinutes] = useState(
    config?.idleMinutes ?? DEFAULT_SANDBOX_IDLE_MINUTES,
  );
  const [maxRunningMinutes, setMaxRunningMinutes] = useState(
    config?.maxRunningMinutes ?? DEFAULT_SANDBOX_MAX_RUNNING_MINUTES,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const providers = providersQuery.data?.providers ?? EMPTY_PROVIDERS;
  const host = providersQuery.data?.host;
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
  // Read from settings, so a client saved in the Sandboxes section applies without a refetch.
  const tailscaleReady = useEnvironmentSettings(
    environmentId,
    (settings) =>
      settings.sandboxTailscale.clientId !== "" && settings.sandboxTailscale.clientSecret !== "",
  );
  const joinsTailnet = tailscaleReady && (joinTailnet ?? host?.claude?.privateNetwork === true);
  // Any machine's project can start on a config: the sandbox clones its repository from GitHub.
  const repositoryChoices = sandboxRepositoryChoices(projects, environmentId);
  const disabled =
    isSaving ||
    provider === undefined ||
    !canWriteSettings ||
    (passesCredentials && !allowCredentials) ||
    (sendsClaude && claudeEndpoint === "") ||
    (provider !== undefined && !provider.configured && apiKey.trim() === "");

  const settingsFields = provider?.settingsFields ?? [];
  const requiredSettingsFields = settingsFields.filter((field) => !field.optional);
  const optionalSettingsFields = settingsFields.filter((field) => field.optional);
  const settingValue = (id: string) => settingsDraft[id] ?? provider?.settings?.[id] ?? "";
  const showsKeyInput = provider !== undefined && (!provider.configured || replacingKey);

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
          passGithubToken: passGithub && host?.github === true,
          joinTailnet: joinsTailnet,
          access: joinsTailnet && tailnetOnly ? "tailnet" : "public",
          // Ids that named no repository stay until the list is edited, so access never widens
          // just by opening and saving an older config.
          projectIds:
            repositories === initialAccess.repositories && repositories.length === 0
              ? (config?.projectIds ?? [])
              : [],
          repositories,
          envFiles: Object.fromEntries(
            Object.entries(envFiles)
              .map(([id, text]) => [id, parseFileList(text)] as const)
              .filter(([, files]) => files.length > 0),
          ),
          idleMinutes,
          maxRunningMinutes,
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

  // Env files come from the host's own copy, so only repositories open on it can pick them.
  const allowedHostCopies = repositoryChoices.filter(
    (choice) => choice.hostProject !== null && repositories.includes(choice.key),
  );

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
              <FieldLabel>Machine</FieldLabel>
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

          <div className="space-y-3">
            {host?.claude === undefined ? null : (
              <div className="space-y-2">
                <OptIn
                  checked={useClaude}
                  disabled={isSaving}
                  onCheckedChange={setUseClaude}
                  title="Use this machine's Claude setup"
                >
                  {host.claude.key === "hub"
                    ? "Adds a key for each sandbox on your CLIProxyAPI hub. Deleting the sandbox removes its key."
                    : "Copies this machine's Claude token to each sandbox. Deleting a sandbox does not revoke it."}
                </OptIn>
                {/* Judged by the server for its own endpoint only; an edited URL is checked live. */}
                {!host.claude.privateNetwork ||
                claudeEndpoint !== host.claude.baseUrl ? null : joinsTailnet ? (
                  <p className="flex items-start gap-1.5 ps-6.5 text-2xs leading-relaxed text-muted-foreground">
                    <CheckIcon aria-hidden className="mt-px size-3 shrink-0 text-success" />
                    Private address, reached through your tailnet.
                  </p>
                ) : (
                  <p className="flex flex-wrap items-start gap-x-1.5 ps-6.5 text-2xs leading-relaxed text-warning-foreground">
                    <CircleAlertIcon aria-hidden className="mt-px size-3 shrink-0" />
                    <span className="min-w-0 flex-1">
                      Resolves to a private address; a cloud sandbox can't reach it
                      {tailscaleReady ? " unless it joins your tailnet." : "."}
                      {tailscaleReady || !provider.configured ? null : (
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
                {useClaude ? (
                  <label className="block ps-6.5">
                    <FieldLabel>Claude endpoint</FieldLabel>
                    <Input
                      type="url"
                      value={claudeBaseUrl ?? host.claude.baseUrl}
                      onChange={(event) => setClaudeBaseUrl(event.target.value)}
                      disabled={isSaving}
                      spellCheck={false}
                    />
                  </label>
                ) : null}
              </div>
            )}
            {tailscaleReady ? (
              <div className="space-y-2">
                <OptIn
                  checked={joinsTailnet}
                  disabled={isSaving}
                  onCheckedChange={setJoinTailnet}
                  title="Join my tailnet"
                >
                  Each sandbox joins as an ephemeral, tagged Tailscale device so it can reach
                  private endpoints. Deleting the sandbox removes the device.
                </OptIn>
                {joinsTailnet ? (
                  <div className="ps-6.5">
                    <OptIn
                      checked={tailnetOnly}
                      disabled={isSaving}
                      onCheckedChange={setTailnetOnly}
                      title="Reach it only through my tailnet"
                    >
                      No public URL. This app connects over the tailnet, so the machine running it
                      has to be on your tailnet too.
                    </OptIn>
                  </div>
                ) : null}
              </div>
            ) : null}
            <OptIn
              checked={passGithub && host?.github === true}
              disabled={isSaving || host?.github !== true}
              onCheckedChange={setPassGithub}
              title="Sign GitHub in with this machine's token"
            >
              {host?.github === true
                ? "Each sandbox can then clone private repositories and push with gh and git."
                : "This machine has no GitHub token to share, so sandboxes can clone public repositories only."}
            </OptIn>
          </div>

          <div className="space-y-2">
            <FieldLabel>Projects</FieldLabel>
            {repositoryChoices.length === 0 ? (
              <p className="text-2xs leading-relaxed text-muted-foreground">
                Any project with a GitHub remote can start a thread on this config, on whichever
                machine it is open.
              </p>
            ) : (
              <>
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  {repositories.length === 0
                    ? "Any project with a GitHub remote can start a thread here, on whichever machine it is open. Pick repositories to limit it."
                    : "Only these repositories can start a thread here."}
                </p>
                <ul className="grid gap-1.5 sm:grid-cols-2">
                  {repositoryChoices.map((choice) => (
                    <li key={choice.key}>
                      <label className="flex cursor-pointer items-center gap-2 text-xs">
                        <Checkbox
                          checked={repositories.includes(choice.key)}
                          disabled={isSaving}
                          onCheckedChange={(checked) =>
                            setRepositories(
                              checked === true
                                ? [...repositories, choice.key]
                                : repositories.filter((key) => key !== choice.key),
                            )
                          }
                        />
                        <span className="min-w-0 truncate">{choice.label}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground data-panel-open:[&_svg]:rotate-90">
              <ChevronRightIcon aria-hidden className="size-3.5 transition-transform" />
              Advanced
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="space-y-4 pt-3">
                {settingsFieldInputs(optionalSettingsFields)}

                <div className="grid gap-4 sm:grid-cols-2">
                  <MinutesField
                    label="Running limit"
                    hint="A sandbox that has run this long since its last start is stopped. Its disk stays until you delete it."
                    value={maxRunningMinutes}
                    min={10}
                    max={43_200}
                    disabled={isSaving}
                    onChange={setMaxRunningMinutes}
                  />
                  <MinutesField
                    label="Idle stop"
                    hint="Saved for idle detection. For now only the running limit stops sandboxes."
                    value={idleMinutes}
                    min={5}
                    max={1440}
                    disabled={isSaving}
                    onChange={setIdleMinutes}
                  />
                </div>

                {allowedHostCopies.length === 0 ? (
                  <p className="text-2xs leading-relaxed text-muted-foreground">
                    When the repository is also open on this machine, each sandbox gets a copy of
                    its git-ignored env files (.env files, .envrc, .dev.vars). Pick repositories
                    above to choose other files.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <FieldLabel>Files copied from this machine</FieldLabel>
                    {allowedHostCopies.map((choice) => (
                      <label key={choice.key} className="block">
                        <span className="mb-1 block text-2xs text-muted-foreground">
                          {choice.label}
                        </span>
                        <Input
                          value={envFiles[choice.key] ?? ""}
                          onChange={(event) =>
                            setEnvFiles({ ...envFiles, [choice.key]: event.target.value })
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
                  </div>
                )}

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
                            {selectedCredentialEnvironment?.name ?? "No credentials (recommended)"}
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
                              onCheckedChange={(checked) => setAllowCredentials(checked === true)}
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
              </div>
            </CollapsiblePanel>
          </Collapsible>

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

          <div className="flex flex-wrap items-center justify-end gap-2">
            {config === undefined ? null : confirmingDelete ? (
              <>
                <span className="me-auto text-xs text-muted-foreground">
                  Sandboxes already made from it keep running until you delete them.
                </span>
                <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
                  Keep
                </Button>
                <Button
                  variant="destructive-outline"
                  size="sm"
                  disabled={isSaving}
                  onClick={() => void handleDelete()}
                >
                  Delete config
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="me-auto"
                disabled={isSaving}
                onClick={() => setConfirmingDelete(true)}
              >
                Delete…
              </Button>
            )}
            {confirmingDelete ? null : (
              <Button disabled={disabled} onClick={() => void handleSave()}>
                {isSaving ? <Spinner className="size-3.5" /> : null}
                {config === undefined ? "Add sandbox config" : "Save changes"}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
