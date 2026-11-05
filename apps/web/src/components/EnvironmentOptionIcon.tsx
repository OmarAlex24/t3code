import type { EnvironmentOption } from "./BranchToolbar.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { SandboxProviderLogo } from "./settings/SandboxProviderLogo";
import { cn } from "~/lib/utils";

/** A machine's icon, or the provider's mark for a sandbox config. */
export function EnvironmentOptionIcon({
  option,
  className,
}: {
  readonly option: Pick<EnvironmentOption, "machine" | "sandboxProvider"> | null;
  readonly className?: string;
}) {
  if (option?.sandboxProvider !== undefined) {
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
