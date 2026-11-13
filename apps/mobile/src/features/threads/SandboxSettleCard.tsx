import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  describeSandboxWork,
  type SandboxSettleDecision,
} from "@t3tools/client-runtime/state/sandbox-settle";
import {
  type EnvironmentId,
  isSandboxProviderError,
  type SandboxCheckWorkResult,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useSandboxSettleDecision } from "../../state/sandbox-settle";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

type Step =
  | { readonly kind: "ask" }
  | { readonly kind: "delete"; readonly work: SandboxCheckWorkResult | null }
  | { readonly kind: "answering" };

const failureText = (cause: unknown, fallback: string) =>
  isSandboxProviderError(cause) ? cause.detail : cause instanceof Error ? cause.message : fallback;

/** A sandbox chat's pending settle decision on its thread screen; nothing for any other thread. */
export function SandboxSettleCard(props: {
  readonly thread: Parameters<typeof useSandboxSettleDecision>[0];
}) {
  const decision = useSandboxSettleDecision(props.thread);
  return decision === null || props.thread === null ? null : (
    <SettleQuestion
      key={decision.instanceId}
      environmentId={props.thread.environmentId}
      decision={decision}
    />
  );
}

/**
 * The host's question after a sandbox chat settled: keep its sandbox, or delete it. Delete runs
 * the sandbox's work check first and shows what would be lost, as web's delete confirmation does.
 */
function SettleQuestion(props: {
  readonly environmentId: EnvironmentId;
  readonly decision: SandboxSettleDecision;
}) {
  const { environmentId, decision } = props;
  const canAnswer = useAtomValue(
    serverEnvironment.sandboxesResolveSettle.permissionAtom(environmentId),
  );
  const resolveSettle = useAtomCommand(serverEnvironment.sandboxesResolveSettle, {
    reportFailure: false,
  });
  const checkWork = useAtomCommand(serverEnvironment.sandboxesCheckWork, {
    reportFailure: false,
  });
  const [step, setStep] = useState<Step>({ kind: "ask" });
  const [error, setError] = useState<string | null>(null);

  const answer = async (choice: "keep" | "delete") => {
    setStep({ kind: "answering" });
    setError(null);
    const result = await resolveSettle({
      environmentId,
      input: { instanceId: decision.instanceId, choice },
    });
    // On success the host's list drops the question and this card goes with it.
    if (AsyncResult.isFailure(result)) {
      setStep({ kind: "ask" });
      setError(
        failureText(
          squashAtomCommandFailure(result),
          choice === "keep" ? "Could not keep the sandbox." : "Could not delete the sandbox.",
        ),
      );
    }
  };

  const startDelete = async () => {
    setStep({ kind: "delete", work: null });
    setError(null);
    const result = await checkWork({
      environmentId,
      input: { instanceId: decision.instanceId },
    });
    setStep((current) =>
      current.kind !== "delete"
        ? current
        : {
            kind: "delete",
            work: AsyncResult.isSuccess(result)
              ? result.value
              : {
                  status: "unknown",
                  uncommittedFiles: 0,
                  unpushedCommits: 0,
                  detail: failureText(squashAtomCommandFailure(result), ""),
                },
          },
    );
  };

  const busy = step.kind === "answering";
  return (
    <View
      accessibilityRole="alert"
      className="mx-3 mb-2 gap-1 rounded-xl border border-warning-foreground/25 bg-screen p-3"
    >
      <Text className="text-sm font-t3-medium text-foreground">Keep this chat's sandbox?</Text>
      <Text className="text-sm text-foreground-muted">
        {decision.reason === "work"
          ? "Its settings delete it on settle, but it may hold work that hasn't been pushed. "
          : ""}
        {decision.stopped ? "It is stopped, so its work can't be checked. " : ""}
        If you delete the sandbox, the chat is kept, under Settled; only work on its disk is lost.
      </Text>
      {step.kind === "delete" ? (
        <Text
          className={
            step.work === null || step.work.status === "clean"
              ? "text-sm text-foreground-muted"
              : "text-sm text-warning-foreground"
          }
        >
          {step.work === null ? "Checking for unpushed work…" : describeSandboxWork(step.work)}
        </Text>
      ) : null}
      {!canAnswer ? (
        <Text className="text-sm text-foreground-muted">
          Answer from a device that can manage this computer's sandboxes.
        </Text>
      ) : (
        // The margins cancel the 44pt touch height so the actions sit 8pt under the text.
        <View className="-mb-3 -mt-2 flex-row flex-wrap gap-x-4">
          {step.kind === "delete" ? (
            <>
              <SettleAction
                label="Delete sandbox"
                destructive
                disabled={step.work === null}
                onPress={() => void answer("delete")}
              />
              <SettleAction label="Cancel" onPress={() => setStep({ kind: "ask" })} />
            </>
          ) : (
            <>
              <SettleAction label="Keep" disabled={busy} onPress={() => void answer("keep")} />
              <SettleAction
                label="Delete sandbox…"
                destructive
                disabled={busy}
                onPress={() => void startDelete()}
              />
            </>
          )}
        </View>
      )}
      {error === null ? null : (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      )}
    </View>
  );
}

function SettleAction(props: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const disabled = props.disabled === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={{ left: 8, right: 8 }}
      onPress={props.onPress}
      className="min-h-11 justify-center active:opacity-70"
    >
      <Text
        className={
          disabled
            ? "text-sm font-t3-medium text-foreground-muted"
            : props.destructive === true
              ? "text-sm font-t3-medium text-destructive"
              : "text-sm font-t3-medium text-primary"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
