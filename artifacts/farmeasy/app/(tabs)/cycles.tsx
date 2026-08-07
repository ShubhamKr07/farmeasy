import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  useListCycles,
  getListCyclesQueryKey,
  type Cycle,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useColors } from "@/hooks/useColors";
import AppHeader from "@/components/AppHeader";
import CycleCard from "@/components/CycleCard";
import { useUserRole } from "@/hooks/useUserRole";
import { matchesSearch, matchesStage, matchesDateRange } from "@/utils/cycleFilters";

type Tab = "ongoing" | "history";
type StageFilter = "germination" | "fertigation" | "harvest" | "completed" | null;

const ONGOING_STAGES: { label: string; value: StageFilter }[] = [
  { label: "All", value: null },
  { label: "Germinating", value: "germination" },
  { label: "Fertigation", value: "fertigation" },
  { label: "Harvesting", value: "harvest" },
];

const HISTORY_STAGES: { label: string; value: StageFilter }[] = [
  { label: "All", value: null },
  { label: "Completed", value: "completed" },
];

export default function CyclesScreen() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const { isPrivileged } = useUserRole();
  const [activeTab, setActiveTab] = useState<Tab>("ongoing");
  const router = useRouter();
  const queryClient = useQueryClient();

  const [searchText, setSearchText] = useState("");
  const [stageFilter, setStageFilter] = useState<StageFilter>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const { data: cycles, isLoading, refetch, isRefetching } = useListCycles(
    { status: activeTab },
  );

  const handleTabSwitch = (tab: Tab) => {
    setActiveTab(tab);
    setStageFilter(null);
  };

  const activeFilterCount =
    (stageFilter ? 1 : 0) +
    (dateFrom ? 1 : 0) +
    (dateTo ? 1 : 0);

  const hasAnyFilter = !!searchText.trim() || activeFilterCount > 0;

  const filteredCycles = useMemo(() => {
    const all = Array.isArray(cycles) ? cycles : [];
    return all.filter(
      (c) =>
        matchesSearch(c, searchText) &&
        matchesStage(c, stageFilter) &&
        matchesDateRange(c, dateFrom, dateTo),
    );
  }, [cycles, searchText, stageFilter, dateFrom, dateTo]);

  const stageOptions = activeTab === "ongoing" ? ONGOING_STAGES : HISTORY_STAGES;

  const handleClearAll = () => {
    setSearchText("");
    setStageFilter(null);
    setDateFrom("");
    setDateTo("");
  };

  return (
    <SafeAreaView style={s.safe} edges={["top"]}>
      <AppHeader />
      <View style={s.header}>
        <Text style={s.title}>Crop Cycles</Text>
      </View>

      <View style={s.tabBar}>
        <Pressable
          style={[s.tab, activeTab === "ongoing" && s.tabActive]}
          onPress={() => handleTabSwitch("ongoing")}
        >
          <Text style={[s.tabText, activeTab === "ongoing" && s.tabTextActive]}>
            Ongoing
          </Text>
        </Pressable>
        {isPrivileged ? (
          <Pressable
            style={[s.tab, activeTab === "history" && s.tabActive]}
            onPress={() => handleTabSwitch("history")}
          >
            <Text style={[s.tabText, activeTab === "history" && s.tabTextActive]}>
              History
            </Text>
          </Pressable>
        ) : (
          <View style={[s.tab, s.lockedTab]}>
            <Feather name="lock" size={12} color={colors.mutedForeground} />
            <Text style={s.lockedTabText}> History</Text>
          </View>
        )}
      </View>

      {/* Search bar */}
      <View style={s.searchRow}>
        <View style={s.searchInputWrap}>
          <Feather name="search" size={16} color={colors.mutedForeground} style={s.searchIcon} />
          <TextInput
            style={s.searchInput}
            value={searchText}
            onChangeText={setSearchText}
            placeholder="Search by name, seed, lot code…"
            placeholderTextColor={colors.mutedForeground}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />
          {searchText.length > 0 && (
            <Pressable onPress={() => setSearchText("")} style={s.clearInputBtn}>
              <Feather name="x" size={14} color={colors.mutedForeground} />
            </Pressable>
          )}
        </View>
        <Pressable
          style={[s.filterBtn, showFilters && s.filterBtnActive]}
          onPress={() => setShowFilters((v) => !v)}
        >
          <Feather
            name="sliders"
            size={16}
            color={showFilters ? "#fff" : colors.foreground}
          />
          {activeFilterCount > 0 && (
            <View style={s.filterBadge}>
              <Text style={s.filterBadgeText}>{activeFilterCount}</Text>
            </View>
          )}
        </Pressable>
      </View>

      {/* Expandable filter panel */}
      {showFilters && (
        <View style={s.filterPanel}>
          {/* Stage filter */}
          <Text style={s.filterLabel}>Growth Stage</Text>
          <View style={s.stageChips}>
            {stageOptions.map((opt) => (
              <Pressable
                key={String(opt.value)}
                style={[s.stageChip, stageFilter === opt.value && s.stageChipActive]}
                onPress={() => setStageFilter(opt.value)}
              >
                <Text
                  style={[
                    s.stageChipText,
                    stageFilter === opt.value && s.stageChipTextActive,
                  ]}
                >
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Date range */}
          <Text style={s.filterLabel}>Seeding Date Range</Text>
          <View style={s.dateRow}>
            <View style={s.dateInputWrap}>
              <Text style={s.dateInputLabel}>From</Text>
              <TextInput
                style={s.dateInput}
                value={dateFrom}
                onChangeText={setDateFrom}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.mutedForeground}
                autoCorrect={false}
                keyboardType="numbers-and-punctuation"
              />
            </View>
            <View style={s.dateSep}>
              <Feather name="arrow-right" size={14} color={colors.mutedForeground} />
            </View>
            <View style={s.dateInputWrap}>
              <Text style={s.dateInputLabel}>To</Text>
              <TextInput
                style={s.dateInput}
                value={dateTo}
                onChangeText={setDateTo}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.mutedForeground}
                autoCorrect={false}
                keyboardType="numbers-and-punctuation"
              />
            </View>
          </View>

          {activeFilterCount > 0 && (
            <Pressable style={s.clearFiltersBtn} onPress={handleClearAll}>
              <Feather name="x-circle" size={14} color={colors.destructive} />
              <Text style={s.clearFiltersText}>Clear all filters</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Active filter summary strip */}
      {hasAnyFilter && !showFilters && (
        <View style={s.filterSummary}>
          <Feather name="filter" size={12} color={colors.primary} />
          <Text style={s.filterSummaryText} numberOfLines={1}>
            {[
              searchText.trim() && `"${searchText.trim()}"`,
              stageFilter && stageOptions.find((o) => o.value === stageFilter)?.label,
              dateFrom && `from ${dateFrom}`,
              dateTo && `to ${dateTo}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          <Pressable onPress={handleClearAll}>
            <Text style={s.filterSummaryClear}>Clear</Text>
          </Pressable>
        </View>
      )}

      {isLoading ? (
        <View style={s.loadingWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={filteredCycles}
          keyExtractor={(c) => String(c.id)}
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() => {
                refetch();
                queryClient.invalidateQueries({
                  queryKey: getListCyclesQueryKey({ status: activeTab }),
                });
              }}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={s.emptyWrap}>
              <Feather
                name={hasAnyFilter ? "search" : "inbox"}
                size={40}
                color={colors.mutedForeground}
              />
              <Text style={s.emptyText}>
                {hasAnyFilter
                  ? "No cycles match your search"
                  : activeTab === "ongoing"
                    ? "No active cycles"
                    : "No completed cycles"}
              </Text>
              {hasAnyFilter ? (
                <Pressable style={s.emptyBtn} onPress={handleClearAll}>
                  <Text style={s.emptyBtnText}>Clear search</Text>
                </Pressable>
              ) : activeTab === "ongoing" ? (
                <Pressable
                  style={s.emptyBtn}
                  onPress={() => router.push("/seeding" as any)}
                >
                  <Text style={s.emptyBtnText}>Start a new cycle</Text>
                </Pressable>
              ) : null}
            </View>
          }
          renderItem={({ item }) => (
            <CycleCard
              cycle={item}
              onPress={() => router.push(`/cycle/${item.id}` as any)}
              onAction={(action) => {
                if (action === "fertigation") {
                  router.push(`/fertigation/${item.id}` as any);
                } else if (action === "harvest") {
                  router.push(`/harvest/${item.id}` as any);
                }
              }}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

const createStyles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.foreground,
  },
  tabBar: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: colors.radius,
    backgroundColor: colors.muted,
    alignItems: "center",
  },
  tabActive: { backgroundColor: colors.primary },
  tabText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.mutedForeground,
  },
  tabTextActive: { color: "#fff", fontFamily: "Inter_600SemiBold" },

  /* Search bar */
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  searchInputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    height: 40,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: colors.radius,
    backgroundColor: colors.card,
    paddingHorizontal: 10,
    gap: 6,
  },
  searchIcon: { marginRight: 2 },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.foreground,
    paddingVertical: 0,
  },
  clearInputBtn: { padding: 2 },
  filterBtn: {
    width: 40,
    height: 40,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  filterBtnActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  filterBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.destructive,
    alignItems: "center",
    justifyContent: "center",
  },
  filterBadgeText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },

  /* Filter panel */
  filterPanel: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: colors.card,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 8,
  },
  filterLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  stageChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 8,
  },
  stageChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: colors.muted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stageChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  stageChipText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.mutedForeground,
  },
  stageChipTextActive: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
  },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  dateInputWrap: { flex: 1 },
  dateInputLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: colors.mutedForeground,
    marginBottom: 4,
  },
  dateInput: {
    height: 38,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: colors.radius - 2,
    paddingHorizontal: 10,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.foreground,
    backgroundColor: colors.background,
  },
  dateSep: {
    paddingTop: 18,
    alignItems: "center",
  },
  clearFiltersBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingVertical: 4,
  },
  clearFiltersText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.destructive,
  },

  /* Active filter summary strip */
  filterSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: colors.secondary,
    borderRadius: colors.radius - 2,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  filterSummaryText: {
    flex: 1,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.primary,
  },
  filterSummaryClear: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: colors.primary,
  },

  /* List */
  loadingWrap: { flex: 1, alignItems: "center", padding: 60 },
  list: { padding: 16, paddingBottom: 100 },
  emptyWrap: { alignItems: "center", paddingTop: 60, gap: 12 },
  emptyText: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
  },
  emptyBtn: {
    backgroundColor: colors.primary,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: colors.radius,
    marginTop: 8,
  },
  emptyBtnText: {
    color: "#fff",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  lockedTab: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    opacity: 0.45,
  },
  lockedTabText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.mutedForeground,
  },
});
