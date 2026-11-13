import { pipe } from "effect/Function";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadPullRequestLink,
  VcsStatusResult,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
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
import {
  findProjectForChangeRequest,
  findProjectOnChangeRequestHost,
} from "@t3tools/client-runtime/change-request-links";

import type { ComposerThreadTarget } from "~/composerDraftStore";
import { useProjects, useQuietThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { useOpenPrLink } from "../../lib/openPullRequestLink";
import {
  linkedPullRequestSnapshotStatus,
  prStatusIndicator,
  useThreadDisplayedPullRequest,
} from "../ThreadStatusIndicators";

import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";

function ThreadDetailsPrLinkRow({
  environmentId,
  link,
  onOpen,
  onActed,
  onStopWatching,
  composerTarget,
}: {
  environmentId: EnvironmentId;
  link: ThreadPullRequestLink;
  onOpen: (event: ReactMouseEvent<HTMLElement>) => void;
  onActed?: (() => void) | undefined;
  onStopWatching?: (() => void) | undefined;
  composerTarget?: ComposerThreadTarget | undefined;
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
      composerTarget={composerTarget}
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

/** Linked pull requests need no repository; only the branch's own pull request comes from git. */
export function ThreadDetailsThreadPrRows({
  threadRef,
  project,
  branchPr = null,
  branchSourceControlProvider,
  onActed,
  composerTarget,
}: {
  threadRef: ScopedThreadRef;
  project: EnvironmentProject | null;
  branchPr?: VcsStatusResult["pr"];
  branchSourceControlProvider?: VcsStatusResult["sourceControlProvider"];
  onActed?: () => void;
  composerTarget?: ComposerThreadTarget | undefined;
}) {
  const thread = useQuietThreadShell(threadRef);
  const displayed = useThreadDisplayedPullRequest(
    threadRef.environmentId,
    thread,
    branchPr,
    branchSourceControlProvider,
  );
  const openPrLink = useOpenPrLink(threadRef);
  const { currentLink, pr, number, url } = displayed;
  const projects = useProjects();
  const parsed =
    currentLink === null
      ? undefined
      : sourceControlClients.parseChangeRequestUrl(currentLink.url)?.link;
  // Merge settings belong to the project holding the linked repository, the thread's own first.
  const rowProject =
    parsed === undefined || (project !== null && findProjectForChangeRequest([project], parsed))
      ? project
      : (findProjectForChangeRequest(
          projects.filter((candidate) => candidate.environmentId === threadRef.environmentId),
          parsed,
        ) ?? project);
  if (number === undefined || url === undefined) return null;
  return (
    <ThreadDetailsPrRows
      threadRef={threadRef}
      links={thread?.pullRequests ?? []}
      currentLink={currentLink}
      onOpenLink={openPrLink}
      environmentId={threadRef.environmentId}
      pr={pr}
      number={number}
      reference={currentLink}
      status={displayed.status}
      project={rowProject}
      label={`#${number}${pr?.title.trim() ? `: ${pr.title}` : ""}`}
      openAriaLabel={url}
      onOpen={(event) => openPrLink(event, url)}
      composerTarget={composerTarget}
      {...(onActed ? { onActed } : {})}
    />
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

function ThreadDetailsPrRows({
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
                  composerTarget={row.composerTarget}
                />
              ),
            }))
      }
    />
  );
}
