import type { EnvironmentId, SandboxEnvironmentConfig } from "@t3tools/contracts";
import { useState } from "react";

import { SandboxEnvironmentFields } from "./SandboxEnvironmentFields";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** Adds or edits a sandbox config, from the Sandboxes settings or the composer's Run on menu. */
export function SandboxConfigDialog({
  environmentId,
  editing,
  onClose,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  /** The config to edit, `"new"` to add one, or null while closed. */
  readonly editing: SandboxEnvironmentConfig | "new" | null;
  readonly onClose: () => void;
  readonly onSaved?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => {
        if (open) return;
        setError(null);
        onClose();
      }}
    >
      <DialogPopup className="max-h-[80dvh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing === "new" ? "Add sandbox config" : "Edit sandbox config"}
          </DialogTitle>
          <DialogDescription>
            Each thread started on a config gets its own machine, made this way.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {editing === null ? null : (
            <SandboxEnvironmentFields
              key={editing === "new" ? "new" : editing.id}
              environmentId={environmentId}
              {...(editing === "new" ? {} : { config: editing })}
              error={error}
              onErrorChange={setError}
              onDone={() => {
                setError(null);
                onClose();
                onSaved?.();
              }}
            />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
