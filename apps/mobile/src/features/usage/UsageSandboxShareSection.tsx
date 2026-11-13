import {
  sandboxShareChangeLabel,
  type SandboxShareSummary,
} from "@t3tools/client-runtime/state/usage-sandbox-share";
import { formatCount, formatDayShort, formatPercent } from "@t3tools/shared/usageFormat";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useUsageMixColors } from "./usageProviders";

function sideLabel(side: { readonly chats: number; readonly turns: number }): string {
  return `${formatCount(side.chats)} ${side.chats === 1 ? "chat" : "chats"} · ${formatCount(side.turns)} ${side.turns === 1 ? "turn" : "turns"}`;
}

/** How much of a host's work runs on sandboxes, by week; the web Usage page shows the same. */
export function UsageSandboxShareSection(props: {
  readonly summary: SandboxShareSummary;
  readonly label: string | null;
}) {
  const { summary } = props;
  const mix = useUsageMixColors();
  const current = summary.current;
  if (current === null) return null;
  const change = sandboxShareChangeLabel(summary);
  const colors = { sandbox: mix.output, local: mix.other };

  return (
    <SettingsSection
      title={props.label === null ? "Local vs sandboxes" : `Local vs sandboxes · ${props.label}`}
    >
      <View className="gap-4 p-4">
        <View className="gap-0.5">
          <Text className="text-4xl font-t3-bold tabular-nums text-foreground">
            {current.sandboxShare === null ? "-" : formatPercent(current.sandboxShare, 0)}
          </Text>
          <Text className="text-sm text-foreground-muted">
            of this week's turns ran on sandboxes
          </Text>
          {change === null ? null : <Text className="text-sm text-foreground">{change}</Text>}
        </View>
        {(
          [
            { label: "Sandboxes", color: colors.sandbox, side: current.sandbox },
            { label: "Local", color: colors.local, side: current.local },
          ] as const
        ).map((row) => (
          <View key={row.label} className="flex-row items-baseline justify-between gap-3">
            <View className="flex-row items-center gap-2">
              <View className="size-2.5 rounded-full" style={{ backgroundColor: row.color }} />
              <Text className="text-base text-foreground">{row.label}</Text>
            </View>
            <Text className="text-sm tabular-nums text-foreground-muted">
              {sideLabel(row.side)}
            </Text>
          </View>
        ))}
        <View className="gap-1.5">
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={`Share of turns on sandboxes by week: ${summary.weeks
              .map(
                (week) =>
                  `${formatDayShort(week.weekStart)} ${week.sandboxShare === null ? "no turns" : formatPercent(week.sandboxShare, 0)}`,
              )
              .join("; ")}`}
            className="h-20 flex-row items-end gap-1.5"
          >
            {summary.weeks.map((week) => (
              <View
                key={week.weekStart}
                className="h-full flex-1 flex-col-reverse overflow-hidden rounded-sm bg-subtle"
              >
                {week.sandboxShare === null ? null : (
                  <>
                    <View
                      style={{
                        height: `${week.sandboxShare * 100}%`,
                        backgroundColor: colors.sandbox,
                      }}
                    />
                    <View className="flex-1" style={{ backgroundColor: colors.local }} />
                  </>
                )}
              </View>
            ))}
          </View>
          <View className="flex-row justify-between">
            <Text className="text-xs text-foreground-tertiary">
              {summary.weeks[0] === undefined ? "" : formatDayShort(summary.weeks[0].weekStart)}
            </Text>
            <Text className="text-xs text-foreground-tertiary">This week</Text>
          </View>
        </View>
      </View>
    </SettingsSection>
  );
}
