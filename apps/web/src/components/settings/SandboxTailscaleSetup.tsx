import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { Button } from "../ui/button";
import {
  TAILNET_ADDRESS_PLACEHOLDER,
  endpointPort,
  tailscalePolicySnippet,
} from "./sandboxTailscalePolicy";

const POLICY_FILE_URL = "https://login.tailscale.com/admin/acls/file";
const TRUST_CREDENTIALS_URL = "https://login.tailscale.com/admin/settings/trust-credentials";

function ExternalLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3" />
    </a>
  );
}

// One step on the rail: its number sits on the line that runs down to the next step.
function Step({
  number,
  title,
  link,
  last = false,
  children,
}: {
  readonly number: number;
  readonly title: string;
  readonly link?: ReactNode;
  readonly last?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <li className="relative flex gap-3">
      {last ? null : (
        <span aria-hidden className="absolute top-6 bottom-0 left-2.5 w-px bg-border" />
      )}
      <span
        aria-hidden
        className="relative flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-2xs font-medium text-muted-foreground tabular-nums"
      >
        {number}
      </span>
      <div className={last ? "min-w-0 flex-1" : "min-w-0 flex-1 pb-4"}>
        <div className="flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h4 className="text-xs font-medium text-foreground">{title}</h4>
          {link}
        </div>
        <div className="mt-1.5 space-y-2">{children}</div>
      </div>
    </li>
  );
}

function PolicySnippet({ snippet }: { readonly snippet: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500, target: "policy" });
  return (
    <div className="relative rounded-lg border border-border bg-muted/50">
      <pre className="overflow-x-auto px-3 py-2.5 pr-20 font-mono text-2xs leading-relaxed text-foreground/90">
        {snippet}
      </pre>
      <Button
        size="xs"
        variant="outline"
        className="absolute top-1.5 right-1.5"
        aria-label="Copy policy"
        onClick={() => copyToClipboard(snippet, undefined)}
      >
        {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        {isCopied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/**
 * The Tailscale setup as three steps: the tag and its access rule in the policy file, the OAuth
 * client, then the secret field, passed in as `children`. Folded, only the field shows.
 */
export function SandboxTailscaleSetup({
  environmentId,
  tag,
  open,
  onOpenChange,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly tag: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="mb-2 flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-expanded:[&_svg]:rotate-90"
      >
        <ChevronRightIcon aria-hidden className="size-3.5 transition-transform" />
        Setup steps
      </button>
      {open ? (
        <ol className="space-y-0">
          <PolicyStep environmentId={environmentId} tag={tag} />
          <Step
            number={2}
            title="Create the OAuth client"
            link={<ExternalLink href={TRUST_CREDENTIALS_URL}>Open trust credentials</ExternalLink>}
          >
            <ol className="list-decimal space-y-0.5 pl-4 text-xs text-muted-foreground marker:text-muted-foreground/70">
              <li>
                Select <Em>Credential</Em>, then <Em>OAuth</Em>.
              </li>
              <li>
                Under <Em>Scopes</Em>, choose <Em>Custom scopes</Em>.
              </li>
              <li>
                Expand <Em>Devices</Em> and set <Em>Core</Em> to <Em>Write</Em>.
              </li>
              <li>
                Expand <Em>Keys</Em> and set <Em>Auth Keys</Em> to <Em>Write</Em>.
              </li>
              <li>
                Pick <Em>{tag}</Em> as the tag for both.
              </li>
              <li>
                Select <Em>Generate credential</Em> and copy the secret. Tailscale shows it only
                once.
              </li>
            </ol>
          </Step>
          <Step number={3} title="Paste the secret here" last>
            {children}
          </Step>
        </ol>
      ) : (
        children
      )}
    </div>
  );
}

function Em({ children }: { readonly children: ReactNode }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

function PolicyStep({
  environmentId,
  tag,
}: {
  readonly environmentId: EnvironmentId;
  readonly tag: string;
}) {
  // The server resolves its Claude endpoint, so the rule can name its real tailnet address.
  const providersQuery = useEnvironmentQuery(
    serverEnvironment.sandboxesProviders({ environmentId, input: undefined }),
  );
  const claude = providersQuery.data?.host.claude;
  const address = claude?.tailnetAddress ?? null;
  const snippet = tailscalePolicySnippet({ tag, address, port: endpointPort(claude?.baseUrl) });
  return (
    <Step
      number={1}
      title="Add the tag and an access rule"
      link={<ExternalLink href={POLICY_FILE_URL}>Open policy file</ExternalLink>}
    >
      <p className="text-xs text-muted-foreground">
        {address === null ? (
          <>
            Merge these into your policy file. Replace {TAILNET_ADDRESS_PLACEHOLDER} with your
            endpoint&apos;s tailnet IP.
          </>
        ) : (
          <>
            Merge these into your policy file. {address} is where this server&apos;s Claude endpoint
            resolves.
          </>
        )}
      </p>
      <PolicySnippet snippet={snippet} />
      <p className="flex items-start gap-1.5 text-xs text-warning-foreground">
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Tailscale&apos;s default grant lets every device reach every other, sandboxes included.
          Narrow it to the commented one.
        </span>
      </p>
    </Step>
  );
}
