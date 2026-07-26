import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import { posthog } from "@/src/config/posthog";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  useGetCycle,
  useMoveCycleToFertigation,
  getListCyclesQueryKey,
  getGetDashboardQueryKey,
  getGetCycleQueryKey,
} from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import QRScanner from "@/components/QRScanner";
import RackReadingsCard from "@/components/RackReadingsCard";
import StageTracker from "@/components/StageTracker";
import { parseQR, type RackPositionQR } from "@/utils/parseQR";

type Step = 1 | 2 | 3;

export default function FertigationWizard() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>(1);
  const [scannedQr, setScannedQr] = useState("");
  const [rackQr, setRackQr] = useState("");
  const [rackReadings, setRackReadings] = useState<RackPositionQR | null>(null);
  const [error, setError] = useState("");

  const cycleId = parseInt(id ?? "0");
  const { data: cycle } = useGetCycle(cycleId);
  const { mutateAsync: moveFertigation, isPending } = useMoveCycleToFertigation();

  const daysSinceGermination = useMemo(() => {
    if (!cycle?.germinationStartedAt) return 0;
    return Math.floor(
      (Date.now() - new Date(cycle.germinationStartedAt).getTime()) / 864e5
    );
  }, [cycle?.germinationStartedAt]);

  const germinationProgress = useMemo(() => {
    if (!cycle?.germinationDays) return 0;
    return Math.min(100, Math.round((daysSinceGermination / cycle.germinationDays) * 100));
  }, [daysSinceGermination, cycle?.germinationDays]);

  const handleSeedLotScanned = (qr: string) => {
    setScannedQr(qr);
    setError("");
    const qrCodes = cycle?.seedLotQrCodes ?? [];
    if (qrCodes.length > 0 && !qrCodes.includes(qr)) {
      setError(`QR code "${qr}" doesn't match this cycle's seed lots`);
    } else {
      setStep(2);
    }
  };

  const handleRackScanned = (qr: string) => {
    setRackQr(qr);
    setError("");
    const parsed = parseQR(qr);
    if (parsed?.type === "rack_position") {
      setRackReadings(parsed as RackPositionQR);
    } else {
      setRackReadings(null);
    }
  };

  const handleConfirm = async () => {
    if (!rackQr) {
      setError("Please scan the rack position QR code first.");
      return;
    }
    try {
      await moveFertigation({
        id: cycleId,
        data: {
          seedLotQrCode: scannedQr,
          ...(rackReadings
            ? {
                humidity: rackReadings.humidity,
                temperature: rackReadings.temperature,
                ph: rackReadings.ph,
                waterLevel: rackReadings.waterLevel,
                nutrientMix: rackReadings.nutrientMix,
              }
            : {}),
        },
      });
      queryClient.invalidateQueries({ queryKey: getListCyclesQueryKey({ status: "ongoing" }) });
      queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetCycleQueryKey(cycleId) });
      posthog.capture("cycle_moved_to_fertigation", {
        cycle_id: cycleId,
        cycle_short_id: cycle?.shortId ?? null,
        seed_name: cycle?.seedName ?? null,
        days_in_germination: daysSinceGermination,
        germination_progress_pct: germinationProgress,
        fertigation_days: cycle?.fertigationDays ?? null,
      });
      Alert.alert(
        "Moved to Fertigation!",
        `${cycle?.seedName} cycle #${cycle?.shortId} has started its ${cycle?.fertigationDays}-day fertigation period.`,
        [{ text: "OK", onPress: () => router.back() }]
      );
    } catch (err) {
      console.error(err);
      setError("Failed to move cycle to fertigation. Please try again.");
    }
  };

  if (!cycle) {
    return (
      <SafeAreaView style={s.safe}>
        <ActivityIndicator color={colors.primary} style={{ flex: 1 }} />
      </SafeAreaView>
    );
  }

  function SummaryRow({ label, value }: { label: string; value: string }) {
    return (
      <View style={s.summaryRow}>
        <Text style={s.summaryLabel}>{label}</Text>
        <Text style={s.summaryValue}>{value}</Text>
      </View>
    );
  }

  function DetailItem({ label, value }: { label: string; value: string }) {
    return (
      <View style={s.detailItem}>
        <Text style={s.detailLabel}>{label}</Text>
        <Text style={s.detailValue}>{value}</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={["top", "bottom"]}>
      <View style={s.topBar}>
        <Pressable onPress={() => (step > 1 ? setStep((x) => (x - 1) as Step) : router.back())}>
          <Feather
            name={step === 1 ? "x" : "arrow-left"}
            size={24}
            color={colors.foreground}
          />
        </Pressable>
        <Text style={s.topTitle}>Move to Fertigation</Text>
        <Text style={s.stepNum}>Step {step}/3</Text>
      </View>

      <View style={s.stepDots}>
        {[1, 2, 3].map((n) => (
          <View key={n} style={[s.dot, n <= step && s.dotActive]} />
        ))}
      </View>

      <ScrollView contentContainerStyle={s.content}>
        <View style={s.cycleInfo}>
          <Text style={s.cycleName}>{cycle.seedName}</Text>
          <Text style={s.cycleId}>#{cycle.shortId}</Text>
          <StageTracker status="germination" />
        </View>

        {/* ── Step 1: Scan Seed Lot QR ── */}
        {step === 1 && (
          <>
            <Text style={s.stepTitle}>Scan Seed Lot QR</Text>
            <Text style={s.stepSub}>
              Scan one of the seed lot QR codes for this cycle to verify.
            </Text>
            {cycle.seedLotQrCodes.length > 0 && (
              <View style={s.infoBox}>
                <Text style={s.infoLabel}>Expected QR codes:</Text>
                {cycle.seedLotQrCodes.map((qr) => (
                  <Text key={qr} style={s.infoValue}>• {qr}</Text>
                ))}
              </View>
            )}
            <View style={s.scannerBox}>
              <QRScanner onScanned={handleSeedLotScanned} hint="Scan seed lot QR code" />
            </View>
            {error ? <Text style={s.errorText}>{error}</Text> : null}
          </>
        )}

        {/* ── Step 2: Germination Review ── */}
        {step === 2 && (
          <>
            <Text style={s.stepTitle}>Germination Review</Text>
            <Text style={s.stepSub}>
              Confirm germination is complete before moving to fertigation.
            </Text>

            <View style={s.progressCard}>
              <View style={s.progressHeader}>
                <Text style={s.progressLabel}>Days in Germination</Text>
                <Text style={s.progressDays}>
                  {daysSinceGermination} / {cycle.germinationDays} days
                </Text>
              </View>
              <View style={s.progressTrack}>
                <View
                  style={[
                    s.progressFill,
                    {
                      width: `${germinationProgress}%` as any,
                      backgroundColor:
                        germinationProgress >= 100
                          ? colors.primary
                          : colors.statusWarn,
                    },
                  ]}
                />
              </View>
              <Text style={s.progressSub}>
                {germinationProgress >= 100
                  ? "Germination period complete ✓"
                  : `${100 - germinationProgress}% remaining`}
              </Text>
            </View>

            <View style={s.detailGrid}>
              <DetailItem label="Full Trays" value={`${cycle.fullTrays}`} />
              <DetailItem label="Half Trays" value={`${cycle.halfTrays}`} />
              <DetailItem label="Profile" value={cycle.growthProfileName} />
              <DetailItem label="Fertigation period" value={`${cycle.fertigationDays} days`} />
            </View>

            <Pressable style={s.nextBtn} onPress={() => setStep(3)}>
              <Text style={s.nextBtnText}>Looks Good — Scan Rack Slot</Text>
              <Feather name="arrow-right" size={18} color="#fff" />
            </Pressable>
          </>
        )}

        {/* ── Step 3: Scan Rack Position QR + Confirm ── */}
        {step === 3 && (
          <>
            <Text style={s.stepTitle}>Scan Rack Position</Text>
            <Text style={s.stepSub}>
              Scan the rack slot QR code to record current environmental readings at this position.
            </Text>
            <View style={s.qrTypeHint}>
              <Feather name="info" size={13} color={colors.primary} />
              <Text style={s.qrTypeHintText}>
                Rack QR codes contain humidity, temperature, pH, water level and nutrient mix.
              </Text>
            </View>
            <View style={s.scannerBox}>
              <QRScanner
                onScanned={handleRackScanned}
                hint="Scan rack position QR code"
              />
            </View>

            {rackQr && (
              rackReadings ? (
                <RackReadingsCard
                  data={rackReadings}
                  position={rackReadings.position ?? rackQr}
                />
              ) : (
                <View style={s.rackRawChip}>
                  <Feather name="grid" size={14} color={colors.primary} />
                  <Text style={s.rackRawText}>{rackQr}</Text>
                </View>
              )
            )}

            {rackQr && (
              <View style={s.summaryCard}>
                <SummaryRow label="Cycle" value={`#${cycle.shortId}`} />
                <SummaryRow label="Seed" value={cycle.seedName} />
                <SummaryRow
                  label="Trays"
                  value={`${cycle.fullTrays}F + ${cycle.halfTrays}H`}
                />
                <SummaryRow label="Profile" value={cycle.growthProfileName} />
                <SummaryRow label="Fertigation period" value={`${cycle.fertigationDays} days`} />
                <SummaryRow label="Verified QR" value={scannedQr} />
              </View>
            )}

            {error ? <Text style={s.errorText}>{error}</Text> : null}

            <Pressable
              style={[s.confirmBtn, (isPending || !rackQr) && s.btnDisabled]}
              onPress={handleConfirm}
              disabled={isPending || !rackQr}
            >
              {isPending ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Text style={s.confirmBtnText}>Confirm — Move to Fertigation</Text>
                  <Feather name="check" size={18} color="#fff" />
                </>
              )}
            </Pressable>

            {!rackQr && (
              <Text style={s.waitingText}>Waiting for rack position scan…</Text>
            )}
          </>
        )}
      </ScrollView>
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
  },
  topTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: colors.foreground,
  },
  stepNum: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.mutedForeground,
  },
  stepDots: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    marginBottom: 16,
  },
  dot: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.muted },
  dotActive: { backgroundColor: colors.primary },
  content: { padding: 20, paddingBottom: 40 },
  cycleInfo: {
    backgroundColor: colors.secondary,
    borderRadius: colors.radius,
    padding: 14,
    marginBottom: 20,
    gap: 4,
  },
  cycleName: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.foreground,
  },
  cycleId: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
    marginBottom: 8,
  },
  stepTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.foreground,
    marginBottom: 6,
  },
  stepSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
    marginBottom: 14,
  },
  qrTypeHint: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: colors.secondary,
    borderRadius: 8,
    padding: 10,
    marginBottom: 14,
  },
  qrTypeHintText: {
    flex: 1,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.primary,
    lineHeight: 18,
  },
  infoBox: {
    backgroundColor: colors.muted,
    borderRadius: colors.radius,
    padding: 12,
    marginBottom: 12,
  },
  infoLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.mutedForeground,
    marginBottom: 4,
  },
  infoValue: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.foreground,
  },
  scannerBox: {
    width: "100%",
    borderRadius: colors.radius,
    overflow: "hidden",
    backgroundColor: colors.muted,
    marginBottom: 16,
  },
  rackRawChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.secondary,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  rackRawText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.foreground,
  },
  progressCard: {
    backgroundColor: colors.card,
    borderRadius: colors.radius,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 16,
  },
  progressHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  progressLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.foreground,
  },
  progressDays: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: colors.primary,
  },
  progressTrack: {
    height: 8,
    backgroundColor: colors.muted,
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 8,
  },
  progressFill: {
    height: "100%",
    borderRadius: 4,
  },
  progressSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
  },
  detailGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 20,
  },
  detailItem: {
    flex: 1,
    minWidth: "45%",
    backgroundColor: colors.card,
    borderRadius: colors.radius,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  detailLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: colors.mutedForeground,
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  detailValue: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.foreground,
  },
  errorText: {
    color: colors.destructive,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginTop: 8,
  },
  waitingText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
    textAlign: "center",
    marginTop: 12,
  },
  summaryCard: {
    backgroundColor: colors.card,
    borderRadius: colors.radius,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 16,
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  summaryLabel: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
  },
  summaryValue: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.foreground,
    flex: 1,
    textAlign: "right",
    marginLeft: 8,
  },
  nextBtn: {
    flexDirection: "row",
    height: 52,
    borderRadius: colors.radius,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 8,
  },
  nextBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  confirmBtn: {
    flexDirection: "row",
    height: 52,
    borderRadius: colors.radius,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 8,
  },
  confirmBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  btnDisabled: { opacity: 0.4 },
});
