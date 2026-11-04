import { sandboxSetupStageLabel, type SandboxSetupSnapshot } from "@t3tools/contracts";
import { RotateCwIcon, XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";
import { WorkLogRow } from "./WorkLog";
import { Elapsed, ShimmerOverlay, StageIcon, stageRowClassName } from "./WorktreeSetupCard";

function headerLabel(snapshot: SandboxSetupSnapshot, connecting: boolean): string {
  switch (snapshot.phase) {
    case "running":
      return connecting
        ? `Connecting to ${snapshot.label}…`
        : `Starting a sandbox on ${snapshot.label}…`;
    case "done":
      return `Sandbox on ${snapshot.label} is ready`;
    case "failed":
      return snapshot.recovery === "retry"
        ? `The sandbox on ${snapshot.label} needs a retry`
        : `The sandbox on ${snapshot.label} could not start`;
    case "cancelled":
      return "Sandbox cancelled";
  }
}

/**
 * A thread's sandbox as it is made: one row per stage, beside where the worktree card sits. The
 * message waits in the composer until the thread moves onto the sandbox.
 */
export function SandboxSetupCard({
  snapshot,
  connecting,
  localError,
  onCancel,
  onRetry,
  onDismiss,
}: {
  readonly snapshot: SandboxSetupSnapshot;
  /** The host handed the sandbox over and this client is pairing with it. */
  readonly connecting: boolean;
  /** A failure on this client's side of the handoff, which the host does not know about. */
  readonly localError: string | null;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}) {
  const running = snapshot.phase === "running";
  const failed = snapshot.phase === "failed" || localError !== null;
  const text = headerLabel(snapshot, connecting);
  const error = localError ?? snapshot.error;
  return (
    <section
      aria-label="Sandbox setup"
      data-sandbox-setup-phase={snapshot.phase}
      className="space-y-0.5"
    >
      <div className="border-b border-border/60 pb-2 pt-1">
        <div
          className={cn(
            "flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed tabular-nums",
            failed ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          <span
            ref={running ? observeVisibleAnimation : undefined}
            className="relative min-w-0 shrink overflow-hidden whitespace-nowrap"
          >
            <span className="block truncate">{text}</span>
            {running && !failed ? <ShimmerOverlay>{text}</ShimmerOverlay> : null}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground empty:hidden">
            <Elapsed startedAt={snapshot.startedAt} endedAt={snapshot.endedAt} live={running} />
          </span>
        </div>
      </div>
      <div className="pt-1.5">
        {snapshot.stages.map((stage) => {
          const label = sandboxSetupStageLabel(stage.id);
          const stageRunning = stage.status === "running";
          const trailing =
            stage.status === "pending"
              ? null
              : stage.status === "skipped"
                ? (stage.detail ?? "skipped")
                : stage.detail;
          return (
            <WorkLogRow
              key={stage.id}
              data-sandbox-setup-stage={stage.id}
              data-sandbox-setup-status={stage.status}
              icon={
                <span className={cn("text-icon-muted", stage.status === "pending" && "opacity-40")}>
                  <StageIcon status={stage.status} />
                </span>
              }
              label={
                <span
                  ref={stageRunning ? observeVisibleAnimation : undefined}
                  className={cn("relative block truncate", stageRowClassName(stage.status))}
                >
                  {label}
                  {stageRunning ? <ShimmerOverlay>{label}</ShimmerOverlay> : null}
                </span>
              }
              trailing={
                <>
                  {trailing ? (
                    <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
                      {trailing}
                    </span>
                  ) : null}
                  {stage.status !== "skipped" && stage.status !== "pending" ? (
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums empty:hidden">
                      <Elapsed
                        startedAt={stage.startedAt}
                        endedAt={stage.endedAt ?? snapshot.endedAt}
                        live={running}
                      />
                    </span>
                  ) : null}
                </>
              }
            />
          );
        })}
      </div>

      {snapshot.warnings.length === 0 ? null : (
        <ul className="mt-1 ml-8 space-y-0.5 text-xs text-warning-foreground">
          {snapshot.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {failed && error ? <p className="mt-1 ml-8 text-xs text-muted-foreground">{error}</p> : null}

      <div className="mt-0.5 ml-[calc(--spacing(6)+2px-(--spacing(2)-1px))] flex flex-wrap items-center gap-0.5">
        {failed ? (
          <Button type="button" size="xs" variant="ghost-muted" onClick={onRetry}>
            <RotateCwIcon aria-hidden />
            {snapshot.recovery === "relaunch" && localError === null
              ? "Start a new sandbox"
              : "Retry"}
          </Button>
        ) : null}
        {running ? (
          <Button type="button" size="xs" variant="ghost-muted" onClick={onCancel}>
            <XIcon aria-hidden />
            {failed ? "Discard sandbox" : "Cancel"}
          </Button>
        ) : (
          <Button type="button" size="xs" variant="ghost-muted" onClick={onDismiss}>
            <XIcon aria-hidden />
            {/* A stage that waits for a retry still holds its machine. */}
            {snapshot.phase === "failed" && snapshot.recovery === "retry"
              ? "Discard sandbox"
              : "Dismiss"}
          </Button>
        )}
      </div>
    </section>
  );
}
