import type { Session } from "@supabase/supabase-js";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import Svg, { Polyline, Path, Line, Text as SvgText } from "react-native-svg";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  useGetDashboard,
  getGetDashboardQueryKey,
  type ActionRequiredItem,
} from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { elevation } from "@/constants/elevation";
import { supabase } from "@/lib/supabase";
import AppHeader from "@/components/AppHeader";

type ActionFilter = "all" | "fertigation" | "harvest";
type YieldPeriod = "week" | "month";

export default function HomeScreen() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const queryClient = useQueryClient();

  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_e, sess) => setSession(sess));
    return () => listener.subscription.unsubscribe();
  }, []);

  const [yieldPeriod, setYieldPeriod] = useState<YieldPeriod>("week");
  const [actionFilter, setActionFilter] = useState<ActionFilter>("all");

  const email = session?.user?.email;
  const fullName =
    (session?.user?.user_metadata?.full_name as string | undefined) ??
    (session?.user?.user_metadata?.name as string | undefined);
  const displayName = fullName ?? email?.split("@")[0] ?? "Technician";

  const { data: stats, isLoading, refetch, isRefetching } = useGetDashboard();

  const utilizationPct = Math.round((stats?.channelUtilization ?? 0) * 100);

  const filteredActions = (stats?.actionRequired ?? []).filter((item) => {
    if (actionFilter === "all") return true;
    return item.type === actionFilter;
  });

  const handleActionPress = (item: ActionRequiredItem) => {
    if (item.type === "fertigation") {
      router.push(`/fertigation/${item.cycleId}` as any);
    } else {
      router.push(`/harvest/${item.cycleId}` as any);
    }
  };

  return (
    <SafeAreaView style={s.safe} edges={["top"]}>
      <AppHeader />
      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => {
              refetch();
              queryClient.invalidateQueries({
                queryKey: getGetDashboardQueryKey(),
              });
            }}
            tintColor={colors.primary}
          />
        }
      >
        <View style={s.header}>
          <Text style={s.greeting}>
            Good {getGreeting()}, {displayName}!
          </Text>
        </View>

        {stats?.sensorStatus && (
          <View style={s.sensorRow}>
            {[
              { key: "ph", icon: "droplet", value: stats.sensorStatus.acidityPh, unit: "", label: "pH", error: stats.sensorStatus.acidityPhError, color: colors.chartPurple },
              { key: "temp", icon: "thermometer", value: stats.sensorStatus.tempCelsius, unit: "°C", label: "Temp", error: stats.sensorStatus.tempCelsiusError, color: colors.statusWarn },
              { key: "humidity", icon: "wind", value: stats.sensorStatus.humidityPct, unit: "%", label: "Humidity", error: stats.sensorStatus.humidityPctError, color: colors.chart2 },
              { key: "water", icon: "droplet", value: stats.sensorStatus.waterLevelPct, unit: "%", label: "Water", error: stats.sensorStatus.waterLevelPctError, color: colors.primary },
            ].map((m) => (
              <View key={m.key} style={[s.sensorChip, m.error && s.sensorChipError]}>
                <Feather
                  name={m.error ? "alert-triangle" : (m.icon as any)}
                  size={13}
                  color={m.error ? colors.destructive : m.color}
                />
                <Text style={[s.sensorValue, m.error && s.sensorValueError]}>
                  {m.error ? "Error" : `${m.value ?? "—"}${m.unit}`}
                </Text>
                <Text style={s.sensorLabel}>{m.label}</Text>
              </View>
            ))}
          </View>
        )}

        {isLoading ? (
          <View style={s.loadingWrap}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <>
            <View style={s.statsRow}>
              <Pressable
                style={s.statCard}
                onPress={() => router.push("/channel-availability" as any)}
              >
                <Text style={s.statLabel}>Channel Utilization</Text>
                <Text style={s.statValue}>{utilizationPct}%</Text>
                <Text style={s.statSub}>
                  {stats?.totalRunningCycles ?? 0}/
                  {stats?.totalChannels ?? 20} channels
                </Text>
              </Pressable>
              <View style={s.statCard}>
                <Text style={s.statLabel}>Running</Text>
                <Text style={s.statValue}>
                  {stats?.totalRunningCycles ?? 0}
                </Text>
                <Text style={s.statSub}>active cycles</Text>
              </View>
            </View>

            <View style={s.statsRow}>
              <View style={s.statCard}>
                <Text style={s.statLabel}>Total Yield</Text>
                <Text style={s.statValue}>{formatGrams(stats?.totalYieldThisWeek ?? 0)}</Text>
                <Text style={s.statSub}>last week</Text>
              </View>
              <View style={s.statCard}>
                <Text style={s.statLabel}>Total Waste</Text>
                <Text style={[s.statValue, { color: colors.chartPurple }]}>
                  {formatGrams(stats?.totalWasteThisWeek ?? 0)}
                </Text>
                <Text style={s.statSub}>last week</Text>
              </View>
            </View>

            <View style={s.card}>
              <View style={s.cardHeaderRow}>
                <View>
                  <Text style={s.cardTitle}>Recent Trends</Text>
                  <Text style={s.yieldInlineTotal}>
                    {yieldPeriod === "week" ? "7-day" : "Month"} total: {formatGrams(
                      yieldPeriod === "week" ? stats?.totalYieldThisWeek ?? 0 : stats?.totalYieldThisMonth ?? 0,
                    )}
                  </Text>
                </View>
                <View style={s.toggle}>
                  <Pressable
                    style={[s.toggleBtn, yieldPeriod === "week" && s.toggleBtnActive]}
                    onPress={() => setYieldPeriod("week")}
                  >
                    <Text style={[s.toggleBtnText, yieldPeriod === "week" && s.toggleBtnTextActive]}>
                      Week
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[s.toggleBtn, yieldPeriod === "month" && s.toggleBtnActive]}
                    onPress={() => setYieldPeriod("month")}
                  >
                    <Text style={[s.toggleBtnText, yieldPeriod === "month" && s.toggleBtnTextActive]}>
                      Month
                    </Text>
                  </Pressable>
                </View>
              </View>
              <YieldLineChart
                styles={s}
                colors={colors}
                yieldData={yieldPeriod === "week" ? ((stats as any)?.yieldByDay ?? []) : ((stats as any)?.yieldByWeek ?? [])}
                seedingData={yieldPeriod === "week" ? ((stats as any)?.seedingByDay ?? []) : ((stats as any)?.seedingByWeek ?? [])}
                badTrayData={yieldPeriod === "week" ? ((stats as any)?.badTrayByDay ?? []) : ((stats as any)?.badTrayByWeek ?? [])}
              />
            </View>

            <View style={s.card}>
              <View style={s.cardHeaderRow}>
                <View style={s.cardTitleWrap}>
                  <Text style={s.cardTitle}>Action Required</Text>
                  {(stats?.actionRequired?.length ?? 0) > 0 && (
                    <View style={s.badge}>
                      <Text style={s.badgeText}>
                        {stats!.actionRequired.length}
                      </Text>
                    </View>
                  )}
                </View>
              </View>

              <View style={s.filterChips}>
                {(["all", "fertigation", "harvest"] as ActionFilter[]).map((f) => (
                  <Pressable
                    key={f}
                    style={[s.chip, actionFilter === f && s.chipActive]}
                    onPress={() => setActionFilter(f)}
                  >
                    <Text style={[s.chipText, actionFilter === f && s.chipTextActive]}>
                      {f === "all" ? "All" : f === "fertigation" ? "Fertigation" : "Harvest"}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {!filteredActions.length ? (
                <Text style={s.emptyText}>
                  {actionFilter === "all"
                    ? "All cycles on schedule 🌿"
                    : `No ${actionFilter} actions pending`}
                </Text>
              ) : (
                filteredActions.map((item) => (
                  <Pressable
                    key={item.cycleId}
                    style={s.actionItem}
                    onPress={() => handleActionPress(item)}
                  >
                    <View style={s.actionLeft}>
                      <View
                        style={[
                          s.actionDot,
                          {
                            backgroundColor:
                              item.daysOverdue > 1
                                ? colors.destructive
                                : colors.statusWarn,
                          },
                        ]}
                      />
                      <View>
                        <Text style={s.actionName}>{item.seedName}</Text>
                        <Text style={s.actionSub}>
                          #{item.cycleShortId} ·{" "}
                          {item.type === "fertigation"
                            ? "Move to Fertigation"
                            : "Ready to Harvest"}
                        </Text>
                      </View>
                    </View>
                    <View style={s.actionRight}>
                      <Text style={s.overdueText}>
                        {item.daysOverdue}d overdue
                      </Text>
                      <Feather
                        name="chevron-right"
                        size={16}
                        color={colors.mutedForeground}
                      />
                    </View>
                  </Pressable>
                ))
              )}
            </View>
          </>
        )}
      </ScrollView>

      <Pressable style={s.fab} onPress={() => router.push("/seeding" as any)}>
        <Feather name="plus" size={26} color="#fff" />
      </Pressable>
    </SafeAreaView>
  );
}

function YieldLineChart({
  styles: s,
  colors,
  yieldData,
  seedingData,
  badTrayData,
}: {
  styles: ReturnType<typeof createStyles>;
  colors: ReturnType<typeof useColors>;
  yieldData: { label: string; value: number }[];
  seedingData: { label: string; value: number }[];
  badTrayData: { label: string; value: number }[];
}) {
  const VW = 300;
  const VH = 175;
  const PL = 28;
  const PR = 6;
  const PT = 6;
  const PB = 20;
  const chartW = VW - PL - PR;
  const chartH = VH - PT - PB;

  const n = Math.max(yieldData.length, 2);
  const allVals = [...yieldData, ...seedingData, ...badTrayData].map((d) => d.value);
  const maxVal = Math.max(...allVals, 1);

  function pts(data: { value: number }[]) {
    if (data.length < 2) return "";
    return data
      .map((d, i) => {
        const x = PL + (i / (n - 1)) * chartW;
        const y = PT + chartH - (d.value / maxVal) * chartH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }

  // Area chart (Phase 6): each series gets a filled region under its line,
  // not just a stroked polyline — a closed path from the line points down
  // to the baseline, semi-transparent fill.
  function areaPath(data: { value: number }[]) {
    if (data.length < 2) return "";
    const points = data.map((d, i) => ({
      x: PL + (i / (n - 1)) * chartW,
      y: PT + chartH - (d.value / maxVal) * chartH,
    }));
    const baselineY = PT + chartH;
    const first = points[0];
    const last = points[points.length - 1];
    const lineTo = points.slice(1).map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    return `M ${first.x.toFixed(1)} ${baselineY} L ${first.x.toFixed(1)} ${first.y.toFixed(1)} ${lineTo} L ${last.x.toFixed(1)} ${baselineY} Z`;
  }

  const labels = yieldData.map((d) => d.label);

  return (
    <View style={s.lineChartWrap}>
      <Svg width="100%" height={VH} viewBox={`0 0 ${VW} ${VH}`}>
        <Line x1={PL} y1={PT} x2={PL} y2={PT + chartH} stroke={colors.border} strokeWidth={1} />
        <Line x1={PL} y1={PT + chartH} x2={VW - PR} y2={PT + chartH} stroke={colors.border} strokeWidth={1} />
        {yieldData.length >= 2 && (
          <>
            <Path d={areaPath(yieldData)} fill={colors.primary + "26"} stroke="none" />
            <Polyline points={pts(yieldData)} fill="none" stroke={colors.primary} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
        {seedingData.length >= 2 && (
          <>
            <Path d={areaPath(seedingData)} fill={colors.chart2 + "26"} stroke="none" />
            <Polyline points={pts(seedingData)} fill="none" stroke={colors.chart2} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
        {badTrayData.length >= 2 && (
          <>
            <Path d={areaPath(badTrayData)} fill={colors.chartPurple + "26"} stroke="none" />
            <Polyline points={pts(badTrayData)} fill="none" stroke={colors.chartPurple} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
        {labels.map((label, i) => (
          <SvgText
            key={i}
            x={PL + (i / (n - 1)) * chartW}
            y={VH - 4}
            fontSize={8}
            fill={colors.mutedForeground}
            textAnchor="middle"
          >
            {label}
          </SvgText>
        ))}
      </Svg>
      <View style={s.chartLegend}>
        <View style={s.legendItem}>
          <View style={[s.legendDot, { backgroundColor: colors.primary }]} />
          <Text style={s.legendLabel}>Yield</Text>
        </View>
        <View style={s.legendItem}>
          <View style={[s.legendDot, { backgroundColor: colors.chart2 }]} />
          <Text style={s.legendLabel}>Seeding</Text>
        </View>
        <View style={s.legendItem}>
          <View style={[s.legendDot, { backgroundColor: colors.chartPurple }]} />
          <Text style={s.legendLabel}>Bad Trays</Text>
        </View>
      </View>
    </View>
  );
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

function formatGrams(g: number) {
  if (g >= 1000) return `${(g / 1000).toFixed(1)} kg`;
  return `${Math.round(g)} g`;
}

const createStyles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scroll: { padding: 16, paddingBottom: 100 },
  header: {
    marginBottom: 12,
  },
  greeting: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.foreground,
  },
  sensorRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 20,
  },
  sensorChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.card,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  sensorValue: { fontSize: 12, fontFamily: "Inter_700Bold", color: colors.foreground },
  sensorLabel: { fontSize: 10, fontFamily: "Inter_400Regular", color: colors.mutedForeground },
  sensorChipError: { backgroundColor: colors.destructive + "12", borderColor: colors.destructive + "40" },
  sensorValueError: { color: colors.destructive },
  loadingWrap: { flex: 1, alignItems: "center", padding: 60 },
  statsRow: { flexDirection: "row", gap: 12, marginBottom: 12 },
  statCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: colors.radius,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: colors.mutedForeground,
    marginBottom: 4,
  },
  statValue: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: colors.foreground,
    marginBottom: 8,
  },
  statSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
    marginTop: 4,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: colors.radius,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 12,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  cardTitleWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  cardTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.foreground,
  },
  yieldInlineTotal: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: colors.primary,
    marginTop: 2,
  },
  badge: {
    backgroundColor: colors.destructive,
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeText: {
    color: "#fff",
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  toggle: {
    flexDirection: "row",
    backgroundColor: colors.muted,
    borderRadius: 8,
    padding: 2,
  },
  toggleBtn: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 6,
  },
  toggleBtnActive: {
    backgroundColor: colors.card,
    ...elevation(1, colors),
  },
  toggleBtnText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: colors.mutedForeground,
  },
  toggleBtnTextActive: {
    color: colors.foreground,
    fontFamily: "Inter_600SemiBold",
  },
  lineChartWrap: {
    marginBottom: 8,
  },
  chartLegend: {
    flexDirection: "row",
    gap: 16,
    marginTop: 6,
    marginBottom: 4,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
  },
  filterChips: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: colors.muted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: colors.mutedForeground,
  },
  chipTextActive: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
  },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
    textAlign: "center",
    paddingVertical: 12,
  },
  actionItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  actionLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  actionDot: { width: 10, height: 10, borderRadius: 5 },
  actionName: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.foreground,
  },
  actionSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
    marginTop: 1,
  },
  actionRight: { flexDirection: "row", alignItems: "center", gap: 4 },
  overdueText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: colors.destructive,
  },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 100,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    ...elevation(2, colors),
  },
});
