import { ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function FieldLabel({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <span className="mb-1.5 flex items-center justify-between gap-2 text-xs font-medium text-foreground">
      {children}
      {trailing}
    </span>
  );
}

export function OptIn({
  checked,
  disabled,
  onCheckedChange,
  title,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  title: ReactNode;
  children?: ReactNode;
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
        {children === undefined ? null : (
          <span className="block text-2xs leading-relaxed text-muted-foreground">{children}</span>
        )}
      </span>
    </label>
  );
}

const COMPACT_ROW =
  "flex min-w-0 cursor-pointer items-center gap-2 py-1 text-xs text-foreground has-disabled:cursor-not-allowed has-disabled:text-muted-foreground";

/** A checkbox on one line, for long lists of things to copy. */
export function CompactOptIn({
  checked,
  disabled,
  onCheckedChange,
  title,
  detail,
  hint,
}: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  title: ReactNode;
  /** Muted text at the end of the line, such as a size or what gets copied. */
  detail?: ReactNode;
  /** The full explanation: a tooltip on hover, and the checkbox's description. */
  hint?: string;
}) {
  const hintId = useId();
  const content = (
    <>
      <Checkbox
        checked={checked}
        disabled={disabled}
        aria-describedby={hint === undefined ? undefined : hintId}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <span className="min-w-0 truncate font-medium">{title}</span>
      {detail === undefined ? null : (
        <span className="ms-auto shrink-0 ps-2 text-2xs text-muted-foreground">{detail}</span>
      )}
    </>
  );
  if (hint === undefined) return <label className={COMPACT_ROW}>{content}</label>;
  // Outside the label, so the hint describes the checkbox without lengthening its name.
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<label className={COMPACT_ROW} />}>{content}</TooltipTrigger>
        <TooltipPopup side="top" className="max-w-72">
          {hint}
        </TooltipPopup>
      </Tooltip>
      <span id={hintId} className="sr-only">
        {hint}
      </span>
    </>
  );
}

/** A small heading inside a config section. */
export function SubHeading({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <p className="text-xs font-semibold text-foreground">{children}</p>
      {trailing}
    </div>
  );
}

/**
 * One part of a sandbox config. Closed, it says in one line what's set, or what needs fixing.
 */
export function ConfigSection({
  id,
  title,
  summary,
  attention,
  open,
  onOpenChange,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  attention: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const summaryId = useId();
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        aria-labelledby={titleId}
        aria-describedby={summaryId}
        className="flex w-full items-start gap-3 px-4 py-3 text-start outline-none hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-panel-open:[&>svg]:rotate-90"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
          <span id={titleId} className="shrink-0 text-sm font-medium text-foreground sm:w-28">
            {title}
          </span>
          {attention === null ? (
            <span
              id={summaryId}
              data-testid={`sandbox-config-summary-${id}`}
              className="min-w-0 truncate text-xs text-muted-foreground"
            >
              {summary}
            </span>
          ) : (
            <span
              id={summaryId}
              data-testid={`sandbox-config-summary-${id}`}
              className="flex min-w-0 items-start gap-1.5 text-xs text-warning-foreground"
            >
              <CircleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
              {attention}
            </span>
          )}
        </span>
        <ChevronRightIcon
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-5 border-t border-border/50 px-4 pt-4 pb-5">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
