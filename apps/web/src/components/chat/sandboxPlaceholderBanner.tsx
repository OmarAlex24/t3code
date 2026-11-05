import { CloudIcon } from "lucide-react";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * The notice on a project T3 made only to hold sandbox threads. Its folder is empty, so it says
 * where the repository's files are instead, and opens the sandbox's thread when there is one.
 */
export function sandboxPlaceholderBannerItem(input: {
  readonly projectId: string;
  readonly projectTitle: string;
  /** The thread's sandbox, as its short id, when the thread has one. */
  readonly sandboxShortId: string | null;
  readonly onOpenSandboxThread: (() => void) | null;
}): ComposerBannerStackItem {
  return {
    id: `sandbox-placeholder:${input.projectId}`,
    variant: "default",
    group: "environment",
    icon: <CloudIcon />,
    title: "No checkout on this computer",
    description:
      input.sandboxShortId === null
        ? `${input.projectTitle} is an empty folder that holds threads run on sandboxes. Start one from a sandbox config to work on the repository.`
        : `${input.projectTitle} is an empty folder that holds this thread here. Files, diffs and terminals are on sandbox ${input.sandboxShortId}.`,
    ...(input.onOpenSandboxThread === null
      ? {}
      : {
          actions: (
            <Button size="xs" variant="ghost" onClick={input.onOpenSandboxThread}>
              Open sandbox thread
            </Button>
          ),
        }),
  };
}
