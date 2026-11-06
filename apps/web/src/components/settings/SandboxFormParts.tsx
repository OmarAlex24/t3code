import type { ReactNode } from "react";

import { Checkbox } from "../ui/checkbox";

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
