import type { EnvironmentId, SandboxMirrorChild, ThreadId } from "@t3tools/contracts";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const ROLE_LABEL = { user: "Task", assistant: "Agent", system: "System" } as const;

/**
 * Read-only messages of one of a sandbox chat's agents, read through the host, which reads them
 * again whenever it reports the agent changed. Mount only while open.
 */
export function SandboxAgentSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const query = useEnvironmentQuery<SandboxMirrorChild, unknown>(
    serverEnvironment.sandboxesMirrorChild({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, childThreadId: props.childThreadId },
    }),
  );
  const child = query.data;
  return (
    <Sheet title="Agent" onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          gap: 16,
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        <Text className="font-sans text-xs text-foreground-secondary">
          Read only. This agent runs on the chat's sandbox.
        </Text>
        {query.error !== null ? (
          <Text selectable className="font-sans text-sm text-danger-foreground">
            {query.error}
          </Text>
        ) : child === null ? (
          <Text className="font-sans text-sm text-foreground-secondary">Loading…</Text>
        ) : !child.available ? (
          <Text className="font-sans text-sm text-foreground-secondary">
            The sandbox is stopped or not answering, so this agent's messages can't be read now.
          </Text>
        ) : child.messages.length === 0 ? (
          <Text className="font-sans text-sm text-foreground-secondary">No messages yet.</Text>
        ) : (
          child.messages.map((message) => (
            <View key={message.id} className="gap-1">
              <Text className="font-t3-bold text-xs text-foreground-secondary">
                {ROLE_LABEL[message.role]}
              </Text>
              <Text selectable className="font-sans text-sm text-foreground">
                {message.text}
              </Text>
            </View>
          ))
        )}
        <View className="flex-row justify-end">
          <Button
            label="Refresh"
            tone="secondary"
            disabled={query.isPending}
            onPress={query.refresh}
          />
        </View>
      </ScrollView>
    </Sheet>
  );
}
