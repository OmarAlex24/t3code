import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { shortSandboxId } from "../../state/sandboxThreads";
import { Elapsed, ShimmerOverlay } from "./WorktreeSetupCard";

/** "Starting sandbox bx_… · 0:42", shimmering like a running setup step, while a resume runs. */
export function SandboxStartingTitle({
  sandboxId,
  startedAt,
}: {
  readonly sandboxId: string;
  readonly startedAt: string;
}) {
  const text = `Starting sandbox ${shortSandboxId(sandboxId)}`;
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      <span
        ref={observeVisibleAnimation}
        className="relative min-w-0 shrink overflow-hidden whitespace-nowrap"
      >
        <span className="block truncate">{text}</span>
        <ShimmerOverlay>{text}</ShimmerOverlay>
      </span>
      <span aria-hidden>·</span>
      <span className="shrink-0 tabular-nums">
        <Elapsed startedAt={startedAt} endedAt={null} live />
      </span>
    </span>
  );
}
