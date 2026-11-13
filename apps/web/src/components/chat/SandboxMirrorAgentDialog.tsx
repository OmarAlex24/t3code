import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const ROLE_LABEL = { user: "Task", assistant: "Agent", system: "System" } as const;

/**
 * One of a sandbox chat's agents, read only through the host, as the phone reads it, for a client
 * not connected to the sandbox. The host reads it again whenever it reports the agent changed.
 * Mount only while open.
 */
export function SandboxMirrorAgentDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.sandboxesMirrorChild({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, childThreadId: props.childThreadId },
    }),
  );
  const child = query.data;
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>
            Read only. This agent runs on the chat's sandbox, which this app is not connected to.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {query.error !== null ? (
            <p className="text-sm text-destructive">{query.error}</p>
          ) : child === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !child.available ? (
            <p className="text-sm text-muted-foreground">
              The sandbox is stopped or not answering, so this agent's messages can't be read now.
            </p>
          ) : child.messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages yet.</p>
          ) : (
            <div className="space-y-4">
              {child.messages.map((message) => (
                <section key={message.id} className="space-y-1 text-sm">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {ROLE_LABEL[message.role]}
                  </h3>
                  <p className="whitespace-pre-wrap break-words">{message.text}</p>
                </section>
              ))}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={query.isPending} onClick={query.refresh}>
            Refresh
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
