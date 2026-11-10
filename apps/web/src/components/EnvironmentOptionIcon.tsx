import type { EnvironmentMachineKind, SandboxProviderKind } from "@t3tools/contracts";
import { PauseIcon } from "lucide-react";

import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { SandboxProviderLogo } from "./settings/SandboxProviderLogo";
import type { SandboxRowPhase } from "../state/sandboxThreads";
import { cn } from "~/lib/utils";

/**
 * A machine's icon, or the provider's mark for a sandbox config or a thread's own sandbox. A
 * thread's sandbox that is stopped wears a pause badge; one starting pulses.
 */
export function EnvironmentOptionIcon({
  option,
  className,
  sandboxPhase = null,
  badgeRingClassName = "ring-background",
}: {
  readonly option: {
    readonly machine: EnvironmentMachineKind;
    readonly sandboxProvider?: SandboxProviderKind | null | undefined;
  } | null;
  readonly className?: string;
  readonly sandboxPhase?: SandboxRowPhase;
  /** The surface under the badge, so its ring cuts the logo cleanly. */
  readonly badgeRingClassName?: string;
}) {
  if (option?.sandboxProvider != null) {
    const logo = (
      <span
        aria-hidden
        className={cn(
          "inline-flex shrink-0 items-center justify-center [&>svg]:size-full",
          sandboxPhase === "stopped" && "opacity-55 grayscale",
          sandboxPhase === "starting" && "motion-safe:animate-status-pulse",
          className,
        )}
      >
        <SandboxProviderLogo kind={option.sandboxProvider} />
      </span>
    );
    if (sandboxPhase !== "stopped") return logo;
    return (
      <span aria-hidden data-sandbox-phase="stopped" className="relative inline-flex shrink-0">
        {logo}
        <span
          className={cn(
            "absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-background ring-2",
            badgeRingClassName,
          )}
        >
          <PauseIcon className="size-1.5" strokeWidth={4} />
        </span>
      </span>
    );
  }
  return <EnvironmentMachineIcon kind={option?.machine ?? "server"} className={className} />;
}
