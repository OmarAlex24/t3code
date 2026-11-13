import { pipe } from "effect/Function";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import type { EnvironmentId, ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  pullRequestListLines,
  resolveThreadCurrentPullRequestLink,
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import {
  Fragment,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { findProjectOnChangeRequestHost } from "@t3tools/client-runtime/change-request-links";

import { useProjects } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { linkedPullRequestSnapshotStatus, prStatusIndicator } from "../ThreadStatusIndicators";

import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";

function ThreadDetailsPrLinkRow({
  environmentId,
  link,
  onOpen,
  onActed,
  onStopWatching,
}: {
  environmentId: EnvironmentId;
  link: ThreadPullRequestLink;
  onOpen: (event: ReactMouseEvent<HTMLElement>) => void;
  onActed?: (() => void) | undefined;
  onStopWatching?: (() => void) | undefined;
}) {
  const projects = useProjects();
  const parsed = sourceControlClients.parseChangeRequestUrl(link.url)?.link;
  const project =
    parsed === undefined
      ? null
      : (findProjectOnChangeRequestHost(
          projects.filter((candidate) => candidate.environmentId === environmentId),
          parsed,
        ) ?? null);
  const linked = linkedPullRequestSnapshotStatus(link);
  const pr = linked?.pr ?? null;
  return (
    <ThreadDetailsPrRow
      environmentId={environmentId}
      pr={pr}
      number={link.number}
      reference={link}
      status={prStatusIndicator(pr, linked?.sourceControlProvider)}
      project={project}
      label={`#${link.number}${link.snapshot === null ? "" : `: ${link.snapshot.title}`}`}
      openAriaLabel={link.url}
      onOpen={onOpen}
      onStopWatching={onStopWatching}
      {...(onActed ? { onActed } : {})}
    />
  );
}

/** The thread's other visible pull requests, in list order, after the one shown first. */
const otherPullRequests = (
  links: ReadonlyArray<ThreadPullRequestLink>,
  current: ThreadPullRequestLink,
) =>
  pipe(visibleThreadPullRequests(links), resolveThreadPullRequestChains, pullRequestListLines)
    .map((line) => line.link)
    .filter((link) => threadPullRequestKeyOf(link) !== threadPullRequestKeyOf(current));

function ExpandablePrRows({
  first,
  rest,
}: {
  first: ReactNode;
  rest: ReadonlyArray<{ key: string; row: ReactNode }>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rest.length === 0) return first;

  return (
    <>
      {first}
      {expanded ? (
        <div data-thread-details-pr-list className="flex flex-col">
          {rest.map(({ key, row }) => (
            <Fragment key={key}>{row}</Fragment>
          ))}
        </div>
      ) : null}
      <ThreadDetailsControl
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(!expanded)}
        part="row"
        tone="muted"
        className="w-full active:scale-100"
      >
        {/* Chevrons, not plus and minus: the plus already means "add" in this card. */}
        {expanded ? (
          <ChevronUpIcon aria-hidden className="size-4 shrink-0" />
        ) : (
          <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
        )}
        {expanded ? "Show less" : `Show ${rest.length} more`}
      </ThreadDetailsControl>
    </>
  );
}

/**
 * Pull requests linked to a thread this client reads from elsewhere (a sandbox chat's own thread,
 * through its host mirror): the current one, then the rest on demand. Their watches stay there.
 */
export function ThreadDetailsLinkedPrRows({
  environmentId,
  links,
  onOpenLink,
}: {
  environmentId: EnvironmentId;
  links: ReadonlyArray<ThreadPullRequestLink>;
  onOpenLink: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}) {
  const current = resolveThreadCurrentPullRequestLink(links);
  if (current === null) return null;
  const row = (link: ThreadPullRequestLink) => (
    <ThreadDetailsPrLinkRow
      environmentId={environmentId}
      link={link}
      onOpen={(event) => onOpenLink(event, link.url)}
    />
  );
  return (
    <ExpandablePrRows
      first={row(current)}
      rest={otherPullRequests(links, current).map((link) => ({
        key: threadPullRequestKeyOf(link),
        row: row(link),
      }))}
    />
  );
}

export function ThreadDetailsPrRows({
  threadRef,
  links,
  currentLink,
  onOpenLink,
  ...row
}: ComponentProps<typeof ThreadDetailsPrRow> & {
  threadRef: ScopedThreadRef;
  links: ReadonlyArray<ThreadPullRequestLink>;
  currentLink: ThreadPullRequestLink | null;
  onOpenLink: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}) {
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const stopWatching = (link: ThreadPullRequestLink | null) =>
    link?.watch === undefined
      ? undefined
      : () =>
          void watch({
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              host: link.host,
              repository: link.repository,
              number: link.number,
              watching: false,
            },
          });
  const currentRow = <ThreadDetailsPrRow {...row} onStopWatching={stopWatching(currentLink)} />;
  return (
    <ExpandablePrRows
      first={currentRow}
      rest={
        currentLink === null
          ? []
          : otherPullRequests(links, currentLink).map((link) => ({
              key: threadPullRequestKeyOf(link),
              row: (
                <ThreadDetailsPrLinkRow
                  environmentId={row.environmentId}
                  link={link}
                  onOpen={(event) => onOpenLink(event, link.url)}
                  onActed={row.onActed}
                  onStopWatching={stopWatching(link)}
                />
              ),
            }))
      }
    />
  );
}
