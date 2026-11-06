import type { EnvironmentMachineKind, SandboxProviderKind } from "@t3tools/contracts";

import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { SandboxProviderLogo } from "./settings/SandboxProviderLogo";
import { cn } from "~/lib/utils";

/** A machine's icon, or the provider's mark for a sandbox config or a thread's own sandbox. */
export function EnvironmentOptionIcon({
  option,
  className,
}: {
  readonly option: {
    readonly machine: EnvironmentMachineKind;
    readonly sandboxProvider?: SandboxProviderKind | null | undefined;
  } | null;
  readonly className?: string;
}) {
  if (option?.sandboxProvider != null) {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex shrink-0 items-center justify-center [&>svg]:size-full",
          className,
        )}
      >
        <SandboxProviderLogo kind={option.sandboxProvider} />
      </span>
    );
  }
  return <EnvironmentMachineIcon kind={option?.machine ?? "server"} className={className} />;
}
