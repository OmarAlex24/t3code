import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  LayersIcon,
  PlusIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthSettingsWriteScope,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type ProviderInstanceId,
  type SandboxCreateResult,
  type SandboxCredentialEnvironment,
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SandboxProviderLogo } from "./SandboxProviderLogo";
import {
  describeSandboxFailure,
  SandboxQuotaLine,
  SandboxStartBlocked,
  SandboxStartConfirmation,
  useSandboxStartCheck,
} from "./SandboxStartLimits";
import { useSandboxTemplates } from "./SandboxTemplates";
import { openAddProjectToMachine } from "../AddProjectToMachineDialog";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { readEnvironmentScope } from "~/state/session";

const EMPTY_PROVIDERS: ReadonlyArray<SandboxProviderInfo> = [];
const EMPTY_CREDENTIAL_ENVIRONMENTS: ReadonlyArray<SandboxCredentialEnvironment> = [];
const NO_CREDENTIAL_ENVIRONMENT = "__none__";
const FRESH_MACHINE = "__fresh__";
const CODEX_INSTANCE = defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
const CLAUDE_INSTANCE = defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));

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

const formatFailure = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Failed to create sandbox.";

// T3's default sandbox lifetime; a plan with a shorter auto-stop maximum is called out.
const DEFAULT_TTL_MINUTES = 480;

const providerDefaultSize = (provider: SandboxProviderInfo): string =>
  provider.sizes[1]?.id ?? provider.sizes[0]?.id ?? "";

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

type ChecklistState = "done" | "todo" | "off";

function ChecklistRow({
  state,
  children,
  action,
}: {
  state: ChecklistState;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="flex min-h-8 items-center gap-2.5 text-sm">
      {state === "done" ? (
        <CheckIcon aria-hidden className="size-4 shrink-0 text-success" />
      ) : state === "todo" ? (
        <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-warning" />
      ) : (
        <CircleDashedIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </li>
  );
}

const MAX_PROJECT_CHOICES = 4;

// One row per repository, from the machine it is most likely set up on: this app's own machine
// first, then the most recently changed. Only projects with a remote can be cloned onto the sandbox.
const sandboxProjectChoices = (
  projects: ReadonlyArray<EnvironmentProject>,
  sandboxEnvironmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
) => {
  const onSandbox = new Set<string>();
  const byRepository = new Map<string, EnvironmentProject>();
  const rank = (project: EnvironmentProject) =>
    project.environmentId === primaryEnvironmentId ? 1 : 0;
  for (const project of projects) {
    const identity = project.repositoryIdentity;
    if (project.isScratch || !identity?.locator.remoteUrl) continue;
    const key = repositoryGroupingKeyOf(identity);
    if (project.environmentId === sandboxEnvironmentId) {
      onSandbox.add(key);
      continue;
    }
    const current = byRepository.get(key);
    if (
      current === undefined ||
      rank(project) > rank(current) ||
      (rank(project) === rank(current) && project.updatedAt > current.updatedAt)
    ) {
      byRepository.set(key, project);
    }
  }
  return [...byRepository.entries()]
    .toSorted(([, a], [, b]) => rank(b) - rank(a) || (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, MAX_PROJECT_CHOICES)
    .map(([key, project]) => ({ project, added: onSandbox.has(key) }));
};

function SandboxProjectStep({
  sandboxEnvironmentId,
  onLeave,
}: {
  sandboxEnvironmentId: EnvironmentId;
  onLeave: () => void;
}) {
  const choices = sandboxProjectChoices(
    useProjects(),
    sandboxEnvironmentId,
    usePrimaryEnvironmentId(),
  );
  const { environments } = useEnvironments();
  const sandbox = environments.find(
    (environment) => environment.environmentId === sandboxEnvironmentId,
  );
  // The add dialog only offers machines it can clone onto, and would pick another one otherwise.
  const sandboxReady =
    sandbox !== undefined &&
    sandbox.serverConfig !== null &&
    canCreateProjectInEnvironment(sandbox.connection.phase);
  const anyAdded = choices.some((choice) => choice.added);
  return (
    <li className="py-1.5">
      <div className="flex min-h-8 items-center gap-2.5 text-sm">
        {anyAdded ? (
          <CheckIcon aria-hidden className="size-4 shrink-0 text-success" />
        ) : (
          <CircleDashedIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          {choices.length === 0
            ? "Add your project from the composer's machine picker"
            : "Add your project"}
        </span>
      </div>
      {choices.length === 0 ? null : (
        <ul className="ms-6.5 space-y-0.5">
          {choices.map(({ project, added }) => (
            <li
              key={`${project.environmentId}:${project.id}`}
              className="flex min-h-7 items-center gap-2"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {project.title}
              </span>
              {added ? (
                <span className="text-2xs text-muted-foreground">Added</span>
              ) : (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={!sandboxReady}
                  onClick={() => {
                    // The add dialog opens a thread on the sandbox, which leaves this checklist.
                    onLeave();
                    openAddProjectToMachine({
                      projectRef: scopeProjectRef(project.environmentId, project.id),
                      targetEnvironmentId: sandboxEnvironmentId,
                    });
                  }}
                >
                  Add
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function SandboxSetupChecklist({
  sandbox,
  canSaveTemplates,
  onSetUpProvider,
  onShowSandboxes,
  onDone,
}: {
  sandbox: SandboxCreateResult;
  canSaveTemplates: boolean;
  onSetUpProvider: (instanceId: ProviderInstanceId) => void;
  onShowSandboxes: () => void;
  onDone: () => void;
}) {
  const { setup } = sandbox;
  const setUp = (label: string, instanceId: ProviderInstanceId) => (
    <Button variant="outline" size="xs" onClick={() => onSetUpProvider(instanceId)}>
      {label}
    </Button>
  );
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{sandbox.label} is running</p>
        <p className="text-xs text-muted-foreground">
          It is paired with this app and reconnects on startup.
        </p>
      </div>
      <ul className="divide-y divide-border/60">
        <ChecklistRow
          state={setup.claude === "ready" ? "done" : setup.claude === "failed" ? "todo" : "off"}
          action={setup.claude === "ready" ? null : setUp("Set up", CLAUDE_INSTANCE)}
        >
          {setup.claude === "ready"
            ? "Claude uses this machine's setup"
            : setup.claude === "failed"
              ? "Claude needs setup"
              : "Claude is not set up"}
        </ChecklistRow>
        <ChecklistRow state="off" action={setUp("Sign in", CODEX_INSTANCE)}>
          Codex needs a sign-in
        </ChecklistRow>
        <ChecklistRow
          state={setup.github === "ready" ? "done" : setup.github === "failed" ? "todo" : "off"}
        >
          {setup.github === "ready"
            ? "GitHub is connected for gh and git"
            : setup.github === "failed"
              ? "GitHub is not connected. Run gh auth login in the sandbox's terminal."
              : "GitHub is not connected"}
        </ChecklistRow>
        {setup.tailscale === "skipped" ? null : (
          <ChecklistRow state={setup.tailscale === "ready" ? "done" : "todo"}>
            {setup.tailscale === "ready" ? "On your tailnet" : "Not on your tailnet"}
          </ChecklistRow>
        )}
        <SandboxProjectStep sandboxEnvironmentId={sandbox.environmentId} onLeave={onDone} />
        {canSaveTemplates ? (
          <li className="flex items-start gap-2.5 py-1.5 text-sm">
            <LayersIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="block">Save it as a template</span>
              <span className="block text-2xs leading-relaxed text-muted-foreground">
                Once the project and its dependencies are set up, use Save as template… on this
                sandbox. New sandboxes then start ready.
              </span>
            </span>
            <Button variant="outline" size="xs" onClick={onShowSandboxes}>
              Show
            </Button>
          </li>
        ) : null}
      </ul>
      {setup.warnings.length === 0 ? null : (
        <Alert variant="warning">
          <AlertDescription>
            <ul className="space-y-1">
              {setup.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end">
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

export function SandboxEnvironmentFields({
  environmentId,
  error,
  onErrorChange,
  onProvisioningChange,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly error: string | null;
  readonly onErrorChange: (error: string | null) => void;
  /** Lets the dialog lock its mode cards and refuse to close while a machine is being created. */
  readonly onProvisioningChange?: (provisioning: boolean) => void;
  readonly onDone: () => void;
}) {
  const navigate = useNavigate();
  const providersQuery = useEnvironmentQuery(
    serverEnvironment.sandboxesProviders({ environmentId, input: undefined }),
  );
  const createSandbox = useAtomCommand(serverEnvironment.sandboxesCreate, {
    reportFailure: false,
  });
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const [selectedKind, setSelectedKind] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  // Edits to the provider's settings fields; untouched fields show the saved value.
  const [settingsDraft, setSettingsDraft] = useState<Readonly<Record<string, string>>>({});
  const [label, setLabel] = useState("");
  const [size, setSize] = useState("");
  const [credentialEnvironment, setCredentialEnvironment] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [allowCredentials, setAllowCredentials] = useState(false);
  const [useClaude, setUseClaude] = useState(false);
  // Null until edited, so the field follows the server's current endpoint.
  const [claudeBaseUrl, setClaudeBaseUrl] = useState<string | null>(null);
  const [passGithub, setPassGithub] = useState(false);
  // Null until toggled, so it follows whether the server's Claude endpoint is private.
  const [joinTailnet, setJoinTailnet] = useState<boolean | null>(null);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [created, setCreated] = useState<SandboxCreateResult | null>(null);
  const providers = providersQuery.data?.providers ?? EMPTY_PROVIDERS;
  const host = providersQuery.data?.host;
  const provider = providers.find((candidate) => candidate.kind === selectedKind) ?? providers[0];
  const templates = useSandboxTemplates(environmentId, provider);
  const template = templates.templates.find((candidate) => candidate.name === templateName);
  // A template keeps the machine size it was saved from.
  const selectedSize =
    template !== undefined
      ? (template.size ?? "")
      : size === ""
        ? provider
          ? providerDefaultSize(provider)
          : ""
        : size;
  const environmentsQuery = useEnvironmentQuery(
    provider?.capabilities.credentialEnvironments
      ? serverEnvironment.sandboxesEnvironments({
          environmentId,
          input: { provider: provider.kind },
        })
      : null,
  );
  const startCheck = useSandboxStartCheck({ environmentId, provider, size: selectedSize });
  const sizeAvailability = new Map(
    (startCheck.limits?.sizes ?? []).map((entry) => [entry.id, entry] as const),
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
  const sendsClaude = useClaude && host?.claude !== undefined;
  // Read from settings, so a client saved in the Sandboxes section applies without a refetch.
  const tailscaleReady = useEnvironmentSettings(
    environmentId,
    (settings) =>
      settings.sandboxTailscale.clientId !== "" && settings.sandboxTailscale.clientSecret !== "",
  );
  const joinsTailnet = tailscaleReady && (joinTailnet ?? host?.claude?.privateNetwork === true);
  const disabled =
    isProvisioning ||
    provider === undefined ||
    !canWriteSettings ||
    startCheck.blocked !== null ||
    (passesCredentials && !allowCredentials) ||
    (sendsClaude && claudeEndpoint === "");

  const settingsFields = provider?.settingsFields ?? [];
  const requiredSettingsFields = settingsFields.filter((field) => !field.optional);
  const optionalSettingsFields = settingsFields.filter((field) => field.optional);
  const settingValue = (id: string) => settingsDraft[id] ?? provider?.settings?.[id] ?? "";
  const showsKeyInput = provider !== undefined && (!provider.configured || replacingKey);

  const handleCreate = async () => {
    if (provider === undefined) return;
    startCheck.cancel();
    setIsProvisioning(true);
    onProvisioningChange?.(true);
    onErrorChange(null);
    const result = await createSandbox({
      environmentId,
      input: {
        provider: provider.kind,
        ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
        ...(settingsFields.length === 0
          ? {}
          : {
              settings: Object.fromEntries(
                settingsFields.map((field) => [field.id, settingValue(field.id).trim()]),
              ),
            }),
        ...(label.trim() === "" ? {} : { label: label.trim() }),
        ...(template !== undefined
          ? { template: template.name }
          : selectedSize === ""
            ? {}
            : { size: selectedSize }),
        ...(credentialEnvironment === ""
          ? {}
          : { environment: credentialEnvironment, allowCredentials: true }),
        ...(sendsClaude ? { agentAccess: { claude: { baseUrl: claudeEndpoint } } } : {}),
        ...(passGithub && host?.github === true ? { passGithubToken: true } : {}),
        ...(joinsTailnet ? { joinTailnet: true } : {}),
      },
    });
    // Any attempt can spend a start, so the quota line re-reads the provider either way.
    startCheck.refresh();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = describeSandboxFailure(
          squashAtomCommandFailure(result),
          "Could not create sandbox",
        );
        onErrorChange(failure.description);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failure.title,
            description: failure.description,
          }),
        );
      }
      setIsProvisioning(false);
      onProvisioningChange?.(false);
      return;
    }

    const sandbox = result.value as SandboxCreateResult;
    const connected = await connectPairing({
      host: sandbox.httpBaseUrl,
      pairingCode: sandbox.pairingCode,
    });
    setIsProvisioning(false);
    onProvisioningChange?.(false);
    if (connected._tag === "Failure") {
      if (!isAtomCommandInterrupted(connected)) {
        const message = formatFailure(squashAtomCommandFailure(connected));
        onErrorChange(
          `The sandbox is running, but pairing failed: ${message}. Add ${sandbox.httpBaseUrl} manually with pairing code ${sandbox.pairingCode}.`,
        );
      }
      return;
    }

    setApiKey("");
    setLabel("");
    setCreated(sandbox);
  };

  if (created !== null) {
    return (
      <SandboxSetupChecklist
        sandbox={created}
        canSaveTemplates={
          providers.find((candidate) => candidate.kind === created.provider)?.capabilities
            .templates === true
        }
        onDone={onDone}
        onShowSandboxes={() => {
          onDone();
          void navigate({ to: "/settings/connections", hash: "sandboxes" });
        }}
        onSetUpProvider={(instanceId) => {
          onDone();
          void navigate({
            to: "/settings/providers",
            search: { environmentId: created.environmentId, instanceId },
          });
        }}
      />
    );
  }

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
              disabled={isProvisioning}
              spellCheck={false}
            />
          </label>
        ))}
      </div>
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
            className="w-full"
            value={[provider.kind]}
            disabled={isProvisioning}
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
              <Toggle key={candidate.kind} value={candidate.kind} className="flex-1">
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
                disabled={isProvisioning}
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
                disabled={isProvisioning}
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
                disabled={isProvisioning}
                spellCheck={false}
              />
            </label>
            <label className="block">
              <FieldLabel>Machine</FieldLabel>
              <Select
                value={selectedSize}
                disabled={isProvisioning || template !== undefined}
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
                  {provider.sizes.map((candidate) => {
                    const availability = sizeAvailability.get(candidate.id);
                    const unavailable = availability !== undefined && !availability.available;
                    return (
                      <SelectItem key={candidate.id} value={candidate.id} disabled={unavailable}>
                        {candidate.label}, {candidate.detail}
                        {unavailable
                          ? `. ${availability.reason ?? "Not available on this plan."}`
                          : ""}
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            </label>
          </div>

          {templates.templates.length === 0 ? (
            provider.configured &&
            provider.capabilities.templates &&
            !templates.isPending &&
            templates.error === null ? (
              <p className="text-2xs leading-relaxed text-muted-foreground">
                No templates yet. Set up a sandbox with your project, then save it as a template so
                the next ones start ready.
              </p>
            ) : null
          ) : (
            <div className="space-y-1.5">
              <label className="block">
                <FieldLabel>Start from</FieldLabel>
                <Select
                  value={template?.name ?? FRESH_MACHINE}
                  disabled={isProvisioning}
                  onValueChange={(value) => {
                    if (value !== null) setTemplateName(value === FRESH_MACHINE ? "" : value);
                  }}
                >
                  <SelectTrigger aria-label="Start the sandbox from" size="default">
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
                  Starts with the template's tools, repositories, and files, at the size it was
                  saved from. T3 Code sets up as a new environment.
                </p>
              )}
            </div>
          )}

          {settingsFieldInputs(requiredSettingsFields)}

          {startCheck.limits === null ? null : (
            <SandboxQuotaLine limits={startCheck.limits} defaultTtlMinutes={DEFAULT_TTL_MINUTES} />
          )}

          <div className="space-y-3">
            {host?.claude === undefined ? null : (
              <div className="space-y-2">
                <OptIn
                  checked={useClaude}
                  disabled={isProvisioning}
                  onCheckedChange={setUseClaude}
                  title="Use this machine's Claude setup"
                >
                  {host.claude.key === "hub"
                    ? "Adds a key for this sandbox on your CLIProxyAPI hub. Deleting the sandbox removes the key."
                    : "Copies this machine's Claude token to the sandbox. Deleting the sandbox does not revoke it."}
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
                      {/* The Sandboxes section that holds the setup row needs a saved provider key. */}
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
                      disabled={isProvisioning}
                      spellCheck={false}
                    />
                  </label>
                ) : null}
              </div>
            )}
            {tailscaleReady ? (
              <OptIn
                checked={joinsTailnet}
                disabled={isProvisioning}
                onCheckedChange={setJoinTailnet}
                title="Join my tailnet"
              >
                Joins as an ephemeral, tagged Tailscale device so the sandbox can reach private
                endpoints. Deleting the sandbox removes the device.
              </OptIn>
            ) : null}
            <OptIn
              checked={passGithub && host?.github === true}
              disabled={isProvisioning || host?.github !== true}
              onCheckedChange={setPassGithub}
              title="Sign GitHub in with this machine's token"
            >
              {host?.github === true
                ? "The sandbox's gh and git can then reach every repository this token can."
                : "This machine has no GitHub token to share."}
            </OptIn>
          </div>

          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground data-panel-open:[&_svg]:rotate-90">
              <ChevronRightIcon aria-hidden className="size-3.5 transition-transform" />
              Advanced
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="space-y-4 pt-3">
                {settingsFieldInputs(optionalSettingsFields)}

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
                        disabled={isProvisioning || environmentsQuery.isPending}
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
                        ? `No ${provider.label} secrets, GitHub token, or agent logins reach the sandbox.`
                        : describeCredentialEnvironment(
                            selectedCredentialEnvironment,
                            provider.label,
                          )}
                    </p>
                    {environmentsQuery.error ? (
                      <p className="text-2xs text-destructive">
                        Could not list {provider.label} environments. The sandbox will start with no
                        credentials.
                      </p>
                    ) : null}
                    {passesCredentials ? (
                      <Alert variant="error">
                        <AlertDescription>
                          <label className="flex cursor-pointer items-start gap-2">
                            <Checkbox
                              className="mt-0.5"
                              checked={allowCredentials}
                              disabled={isProvisioning}
                              onCheckedChange={(checked) => setAllowCredentials(checked === true)}
                            />
                            <span>
                              I understand this sandbox will receive the credentials listed above.
                              Prefer a {provider.label} environment that is safe for third parties
                              or leaves out secrets.
                            </span>
                          </label>
                        </AlertDescription>
                      </Alert>
                    ) : null}
                  </div>
                ) : null}

                <p className="text-2xs leading-relaxed text-muted-foreground">
                  {credentialEnvironment === ""
                    ? `The sandbox starts without your ${provider.label} account's secrets, GitHub token, or agent logins, apart from what you share above.`
                    : `The sandbox receives what this ${provider.label} environment passes, plus what you share above.`}{" "}
                  The server creates the machine, installs T3 Code and any missing git, GitHub CLI,
                  or Claude Code, and pairs it. This usually takes one to three minutes and bills
                  the provider account that owns the key.
                </p>
              </div>
            </CollapsiblePanel>
          </Collapsible>

          {!canWriteSettings ? (
            <Alert variant="error">
              <AlertDescription>
                This connection cannot change settings on the environment that would provision the
                sandbox.
              </AlertDescription>
            </Alert>
          ) : null}
          {startCheck.blocked === null ? null : (
            <SandboxStartBlocked
              reason={startCheck.blocked.reason}
              billingUrl={startCheck.limits?.billingUrl}
            />
          )}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          {startCheck.isConfirming && !isProvisioning ? (
            <SandboxStartConfirmation
              warnings={startCheck.assessment?.warnings ?? []}
              confirmLabel="Create anyway"
              onConfirm={() => void handleCreate()}
              onCancel={startCheck.cancel}
            />
          ) : (
            <Button
              variant="outline"
              className="w-full"
              disabled={disabled}
              onClick={() =>
                startCheck.needsConfirmation ? startCheck.confirm() : void handleCreate()
              }
            >
              {isProvisioning ? (
                <Spinner className="size-3.5" />
              ) : (
                <PlusIcon className="size-3.5" />
              )}
              {isProvisioning ? "Provisioning sandbox…" : `Create ${provider.label} sandbox`}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
