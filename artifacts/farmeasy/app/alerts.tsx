import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useMemo, useEffect } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useListAlerts, getListAlertsQueryKey, type Alert } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { posthog } from "@/src/config/posthog";

const SEVERITY_ICON: Record<string, string> = {
  critical: "alert-octagon",
  warning: "alert-triangle",
  info: "info",
};

/**
 * Alerts list — reached from AlertsBell (Phase 4.1), the global persistent
 * affordance mobile lacked entirely before this. Mirrors web's severity
 * coloring: destructive for critical, statusWarn for warning, muted otherwise.
 */
export default function AlertsScreen() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();

  const alerts = useListAlerts(
    { status: "current", limit: 50 },
    { query: { queryKey: getListAlertsQueryKey({ status: "current", limit: 50 }) } },
  );

  useEffect(() => {
    posthog.capture("alerts_viewed");
  }, []);

  const severityColor = (severity: string) =>
    severity === "critical" ? colors.destructive : severity === "warning" ? colors.statusWarn : colors.mutedForeground;

  const renderItem = ({ item }: { item: Alert }) => (
    <View style={s.row}>
      <Feather name={(SEVERITY_ICON[item.severity] ?? "info") as any} size={18} color={severityColor(item.severity)} />
      <View style={s.rowText}>
        <Text style={s.rowTitle}>{item.title}</Text>
        {item.description && <Text style={s.rowDesc}>{item.description}</Text>}
        {item.location && <Text style={s.rowLocation}>{item.location}</Text>}
      </View>
    </View>
  );

  return (
    <SafeAreaView style={s.safe} edges={["top", "bottom"]}>
      <View style={s.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Feather name="x" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={s.topTitle}>Alerts</Text>
        <View style={{ width: 24 }} />
      </View>

      {alerts.isLoading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
      ) : (
        <FlatList
          data={alerts.data ?? []}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={s.divider} />}
          contentContainerStyle={s.list}
          ListEmptyComponent={<Text style={s.emptyText}>No current alerts.</Text>}
        />
      )}
    </SafeAreaView>
  );
}

const createStyles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  topTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: colors.foreground },
  list: { padding: 16 },
  row: { flexDirection: "row", gap: 12, paddingVertical: 12 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: colors.foreground },
  rowDesc: { fontSize: 13, fontFamily: "Inter_400Regular", color: colors.mutedForeground },
  rowLocation: { fontSize: 12, fontFamily: "Inter_500Medium", color: colors.mutedForeground },
  divider: { height: 1, backgroundColor: colors.border },
  emptyText: {
    textAlign: "center",
    marginTop: 40,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
  },
});
