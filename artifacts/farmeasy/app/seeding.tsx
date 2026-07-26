import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import { posthog } from "@/src/config/posthog";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  useCreateCycle,
  useListGrowthProfiles,
  useLookupSeedLot,
  getLookupSeedLotQueryOptions,
  getResolveLayoutQrQueryOptions,
  getListCyclesQueryKey,
  getGetDashboardQueryKey,
} from "@workspace/api-client-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useColors } from "@/hooks/useColors";
import QRScanner from "@/components/QRScanner";
import RackReadingsCard from "@/components/RackReadingsCard";
import { parseQR, type RackPositionQR, type SeedLotQR, type LayoutQR } from "@/utils/parseQR";

type Step = 1 | 2 | 3;

interface FormData {
  seedLotQrCodes: string[];
  seedName: string;
  fullTrays: string;
  halfTrays: string;
  seedWeightTray: string;
  growthProfileId: number | null;
  seedingDate: string;
  trayPosition: string;
}

interface ScannedLotMeta {
  qr: string;
  seedName?: string;
  variety?: string;
  lotId?: string;
  batchWeight?: number;
  unit?: string;
}

const today = new Date().toISOString().split("T")[0];

export default function SeedingWizard() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<FormData>({
    seedLotQrCodes: [],
    seedName: "",
    fullTrays: "0",
    halfTrays: "0",
    seedWeightTray: "0",
    growthProfileId: null,
    seedingDate: today,
    trayPosition: "",
  });
  const [pendingQr, setPendingQr] = useState("");
  const [autoFillChip, setAutoFillChip] = useState<string | null>(null);
  const [rackReadings, setRackReadings] = useState<RackPositionQR | null>(null);
  const [scannedLots, setScannedLots] = useState<ScannedLotMeta[]>([]);
  const [scannedChannelQR, setScannedChannelQR] = useState<LayoutQR | null>(null);

  const { data: profiles } = useListGrowthProfiles();
  const { mutateAsync: createCycle, isPending } = useCreateCycle();
  const { data: seedLotData } = useLookupSeedLot(
    { qrCode: pendingQr },
    { query: { enabled: !!pendingQr, retry: false } },
  );

  const lotDbQueries = useQueries({
    queries: form.seedLotQrCodes.map((qr) =>
      getLookupSeedLotQueryOptions({ qrCode: qr }, { query: { retry: false } }),
    ),
  });

  const { data: channelStatus, isLoading: channelLoading } = useQuery(
    getResolveLayoutQrQueryOptions(
      { room: scannedChannelQR?.room ?? "", channel: scannedChannelQR?.channel ?? "" },
      { query: { enabled: !!scannedChannelQR, retry: false } },
    ),
  );

  useEffect(() => {
    if (seedLotData?.seedName) {
      setForm((f) => ({ ...f, seedName: seedLotData.seedName }));
      setAutoFillChip(seedLotData.seedName);
    }
  }, [seedLotData]);

  const handleLotScanned = (qr: string) => {
    if (form.seedLotQrCodes.includes(qr)) return;
    setForm((f) => ({ ...f, seedLotQrCodes: [...f.seedLotQrCodes, qr] }));
    const parsed = parseQR(qr);
    const meta: ScannedLotMeta = { qr };
    if (parsed?.type === "seed_lot") {
      const lot = parsed as SeedLotQR;
      meta.seedName = lot.seedName;
      meta.variety = lot.variety;
      meta.lotId = lot.lotId;
      meta.batchWeight = lot.batchWeight;
      meta.unit = lot.unit;
      if (lot.seedName) {
        setForm((f) => ({ ...f, seedName: lot.seedName! }));
        setAutoFillChip(lot.seedName!);
      }
      if (lot.batchWeight && lot.batchWeight > 0) {
        setForm((f) => ({ ...f, seedWeightTray: String(lot.batchWeight) }));
      }
    }
    setScannedLots((prev) => [...prev.filter((l) => l.qr !== qr), meta]);
    setPendingQr(qr);
  };

  const handleRackScanned = (qr: string) => {
    setForm((f) => ({ ...f, trayPosition: qr }));
    const parsed = parseQR(qr);
    if (parsed?.type === "rack_position") {
      setRackReadings(parsed as RackPositionQR);
      setScannedChannelQR(null);
    } else if (parsed?.type === "layout") {
      setScannedChannelQR(parsed as LayoutQR);
      setRackReadings(null);
    } else {
      setRackReadings(null);
      setScannedChannelQR(null);
    }
  };

  const handleConfirm = async () => {
    if (!form.growthProfileId || !form.trayPosition) return;
    try {
      const cycle = await createCycle({
        data: {
          seedLotQrCodes: form.seedLotQrCodes,
          seedName: form.seedName,
          fullTrays: parseInt(form.fullTrays) || 0,
          halfTrays: parseInt(form.halfTrays) || 0,
          seedWeightTray: parseFloat(form.seedWeightTray) || 0,
          growthProfileId: form.growthProfileId!,
          seedingDate: form.seedingDate,
          trayPosition: form.trayPosition,
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
      posthog.capture("cycle_seeded", {
        seed_name: cycle.seedName,
        full_trays: parseInt(form.fullTrays) || 0,
        half_trays: parseInt(form.halfTrays) || 0,
        growth_profile_id: form.growthProfileId,
        growth_profile_name: selectedProfile?.name ?? null,
        seed_lot_count: form.seedLotQrCodes.length,
        seeding_date: form.seedingDate,
      });
      Alert.alert(
        "Cycle Started!",
        `${cycle.seedName} cycle #${cycle.shortId} is now in Germination.`,
        [{ text: "OK", onPress: () => router.back() }]
      );
    } catch (err) {
      console.error(err);
    }
  };

  const profileList = Array.isArray(profiles) ? profiles : [];
  const selectedProfile = profileList.find(
    (p) => p.id === form.growthProfileId,
  );

  return (
    <SafeAreaView style={s.safe} edges={["top", "bottom"]}>
      <View style={s.topBar}>
        <Pressable onPress={() => (step > 1 ? setStep((s) => (s - 1) as Step) : router.back())}>
          <Feather
            name={step === 1 ? "x" : "arrow-left"}
            size={24}
            color={colors.foreground}
          />
        </Pressable>
        <Text style={s.topTitle}>New Seeding</Text>
        <Text style={s.stepNum}>Step {step}/3</Text>
      </View>

      <View style={s.stepDots}>
        {[1, 2, 3].map((n) => (
          <View
            key={n}
            style={[s.dot, n <= step && s.dotActive]}
          />
        ))}
      </View>

      {step === 1 && (
        <ScrollView contentContainerStyle={s.stepContent}>
          <Text style={s.stepTitle}>Scan Seed Lot QR</Text>
          <Text style={s.stepSubtitle}>
            Point the camera at a seed lot QR code. Scanned codes appear below.
          </Text>
          <View style={s.qrTypeHint}>
            <Feather name="info" size={13} color={colors.primary} />
            <Text style={s.qrTypeHintText}>
              Seed lot QR codes contain the seed name, lot ID, variety and batch weight.
            </Text>
          </View>
          <View style={s.scannerBox}>
            <QRScanner
              onScanned={handleLotScanned}
              hint="Point camera at seed lot QR code"
              multiScan
            />
          </View>
          {form.seedLotQrCodes.length > 0 && (
            <View style={s.lotCards}>
              {form.seedLotQrCodes.map((qr, idx) => {
                const dbResult = lotDbQueries[idx];
                const db = dbResult?.data;
                const qrMeta = scannedLots.find((l) => l.qr === qr);
                const displayName = db?.seedName ?? qrMeta?.seedName ?? qr;
                return (
                  <View key={qr} style={s.lotCard}>
                    <View style={s.lotCardHeader}>
                      <Feather
                        name={dbResult?.isLoading ? "loader" : "check-circle"}
                        size={14}
                        color={colors.primary}
                      />
                      <Text style={s.lotCardName} numberOfLines={1}>
                        {displayName}
                      </Text>
                      <Pressable
                        onPress={() => {
                          setForm((f) => ({ ...f, seedLotQrCodes: f.seedLotQrCodes.filter((q) => q !== qr) }));
                          setScannedLots((prev) => prev.filter((l) => l.qr !== qr));
                        }}
                      >
                        <Feather name="x" size={15} color={colors.mutedForeground} />
                      </Pressable>
                    </View>
                    <View style={s.lotCardMeta}>
                      {db?.type && <Text style={s.lotMetaText}>Type: {db.type}</Text>}
                      {db?.supplier && <Text style={s.lotMetaText}>Supplier: {db.supplier}</Text>}
                      {db?.vendorShort && <Text style={s.lotMetaText}>Vendor: {db.vendorShort}</Text>}
                      {db?.itemNumber && <Text style={s.lotMetaText}>Item #: {db.itemNumber}</Text>}
                      {db?.growTime && <Text style={s.lotMetaText}>Grow Time: {db.growTime}</Text>}
                      {db?.success && <Text style={s.lotMetaText}>Success: {db.success}</Text>}
                      {qrMeta?.lotId && <Text style={s.lotMetaText}>Lot ID: {qrMeta.lotId}</Text>}
                      {qrMeta?.variety && <Text style={s.lotMetaText}>Variety: {qrMeta.variety}</Text>}
                      {qrMeta?.batchWeight != null && (
                        <Text style={s.lotMetaText}>Batch: {qrMeta.batchWeight}{qrMeta.unit ?? "g"}</Text>
                      )}
                      {!db && !dbResult?.isLoading && !qrMeta?.lotId && !qrMeta?.variety && (
                        <Text style={s.lotMetaText} numberOfLines={1}>{qr}</Text>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
          <Pressable
            style={[
              s.nextBtn,
              form.seedLotQrCodes.length === 0 && s.btnDisabled,
            ]}
            onPress={() => setStep(2)}
            disabled={form.seedLotQrCodes.length === 0}
          >
            <Text style={s.nextBtnText}>Add Details</Text>
            <Feather name="arrow-right" size={18} color="#fff" />
          </Pressable>
        </ScrollView>
      )}

      {step === 2 && (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={s.formScroll}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={s.stepTitle}>Tray Details</Text>

            <Text style={s.label}>Seed Name</Text>
            {autoFillChip && (
              <View style={s.autoFillChip}>
                <Feather name="check-circle" size={13} color={colors.primary} />
                <Text style={s.autoFillChipText}>Auto-filled: {autoFillChip} — change?</Text>
                <Pressable onPress={() => setAutoFillChip(null)}>
                  <Feather name="x" size={14} color={colors.mutedForeground} />
                </Pressable>
              </View>
            )}
            <TextInput
              style={s.input}
              value={form.seedName}
              onChangeText={(v) => {
                setForm((f) => ({ ...f, seedName: v }));
                setAutoFillChip(null);
              }}
              placeholder="e.g. Arugula"
              placeholderTextColor={colors.mutedForeground}
            />

            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={s.label}>Full Trays</Text>
                <View style={s.counter}>
                  <Pressable
                    style={s.ctrBtn}
                    onPress={() =>
                      setForm((f) => ({
                        ...f,
                        fullTrays: String(Math.max(0, parseInt(f.fullTrays || "0") - 1)),
                      }))
                    }
                  >
                    <Feather name="minus" size={18} color={colors.foreground} />
                  </Pressable>
                  <Text style={s.ctrVal}>{form.fullTrays}</Text>
                  <Pressable
                    style={s.ctrBtn}
                    onPress={() =>
                      setForm((f) => ({
                        ...f,
                        fullTrays: String(parseInt(f.fullTrays || "0") + 1),
                      }))
                    }
                  >
                    <Feather name="plus" size={18} color={colors.foreground} />
                  </Pressable>
                </View>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.label}>Half Trays</Text>
                <View style={s.counter}>
                  <Pressable
                    style={s.ctrBtn}
                    onPress={() =>
                      setForm((f) => ({
                        ...f,
                        halfTrays: String(Math.max(0, parseInt(f.halfTrays || "0") - 1)),
                      }))
                    }
                  >
                    <Feather name="minus" size={18} color={colors.foreground} />
                  </Pressable>
                  <Text style={s.ctrVal}>{form.halfTrays}</Text>
                  <Pressable
                    style={s.ctrBtn}
                    onPress={() =>
                      setForm((f) => ({
                        ...f,
                        halfTrays: String(parseInt(f.halfTrays || "0") + 1),
                      }))
                    }
                  >
                    <Feather name="plus" size={18} color={colors.foreground} />
                  </Pressable>
                </View>
              </View>
            </View>

            <Text style={s.label}>Seed Weight / Tray (g)</Text>
            <TextInput
              style={s.input}
              value={form.seedWeightTray}
              onChangeText={(v) => setForm((f) => ({ ...f, seedWeightTray: v }))}
              keyboardType="numeric"
              placeholder="0"
              placeholderTextColor={colors.mutedForeground}
            />

            <Text style={s.label}>Growth Profile</Text>
            <View style={s.profileList}>
              {profileList.map((p) => (
                <Pressable
                  key={p.id}
                  style={[
                    s.profileOption,
                    form.growthProfileId === p.id && s.profileOptionSelected,
                  ]}
                  onPress={() =>
                    setForm((f) => ({
                      ...f,
                      growthProfileId: p.id,
                      seedName: f.seedName || p.seedName,
                    }))
                  }
                >
                  <Text
                    style={[
                      s.profileName,
                      form.growthProfileId === p.id && s.profileNameSelected,
                    ]}
                  >
                    {p.name}
                  </Text>
                  <Text style={s.profileMeta}>
                    Germ {p.germinationDays}d · Fert {p.fertigationDays}d
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={s.label}>Seeding Date</Text>
            <TextInput
              style={s.input}
              value={form.seedingDate}
              onChangeText={(v) => setForm((f) => ({ ...f, seedingDate: v }))}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.mutedForeground}
            />

            <Pressable
              style={[
                s.nextBtn,
                (!form.seedName || !form.growthProfileId) && s.btnDisabled,
              ]}
              onPress={() => setStep(3)}
              disabled={!form.seedName || !form.growthProfileId}
            >
              <Text style={s.nextBtnText}>Scan Channel</Text>
              <Feather name="arrow-right" size={18} color="#fff" />
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {step === 3 && (
        <ScrollView contentContainerStyle={s.stepContent}>
          <Text style={s.stepTitle}>Scan Channel QR</Text>
          <Text style={s.stepSubtitle}>
            Scan the QR code on the channel where the trays will be placed.
          </Text>
          <View style={s.qrTypeHint}>
            <Feather name="info" size={13} color={colors.primary} />
            <Text style={s.qrTypeHintText}>
              Channel QR codes are generated from the Layout tab in the admin dashboard.
            </Text>
          </View>
          <View style={s.scannerBox}>
            <QRScanner
              onScanned={handleRackScanned}
              hint="Point camera at channel QR code"
            />
          </View>

          {form.trayPosition ? (
            <>
              {channelLoading && (
                <View style={s.rackRawChip}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={s.rackRawText}>Resolving channel…</Text>
                </View>
              )}

              {scannedChannelQR && channelStatus && (
                <View style={[s.channelCard, channelStatus.isFull && s.channelCardFull]}>
                  <View style={s.channelCardHeader}>
                    <Feather name="layers" size={16} color={channelStatus.isFull ? colors.destructive : colors.primary} />
                    <Text style={[s.channelCardTitle, channelStatus.isFull && s.channelCardTitleFull]}>
                      {channelStatus.channel}
                    </Text>
                    {channelStatus.isFull && (
                      <View style={s.fullBadge}>
                        <Text style={s.fullBadgeText}>FULL</Text>
                      </View>
                    )}
                  </View>
                  <Text style={s.channelCardRoom}>
                    {channelStatus.room.charAt(0).toUpperCase() + channelStatus.room.slice(1)} room
                  </Text>
                  <View style={s.channelCapacityRow}>
                    <View style={s.channelStat}>
                      <Text style={s.channelStatVal}>{channelStatus.totalTrays}</Text>
                      <Text style={s.channelStatLabel}>Total trays</Text>
                    </View>
                    <View style={s.channelStatDivider} />
                    <View style={s.channelStat}>
                      <Text style={[s.channelStatVal, { color: colors.destructive }]}>{channelStatus.activeCycles}</Text>
                      <Text style={s.channelStatLabel}>In use</Text>
                    </View>
                    <View style={s.channelStatDivider} />
                    <View style={s.channelStat}>
                      <Text style={[s.channelStatVal, { color: channelStatus.availableTrays > 0 ? colors.statusOk : colors.destructive }]}>
                        {channelStatus.availableTrays}
                      </Text>
                      <Text style={s.channelStatLabel}>Available</Text>
                    </View>
                  </View>
                  {!channelStatus.isFull && channelStatus.totalTrays > 0 && (
                    <Text style={s.channelTraysLeft}>
                      {channelStatus.availableTrays} tray{channelStatus.availableTrays !== 1 ? "s" : ""} left to scan for this channel
                    </Text>
                  )}
                  {channelStatus.isFull && (
                    <Text style={s.channelFullWarning}>
                      This channel is at full capacity. Consider choosing a different channel.
                    </Text>
                  )}
                  {channelStatus.totalTrays === 0 && (
                    <Text style={s.channelFullWarning}>
                      No trays defined in layout for this channel. Add racks and trays in the admin dashboard.
                    </Text>
                  )}
                </View>
              )}

              {rackReadings ? (
                <RackReadingsCard
                  data={rackReadings}
                  position={rackReadings.position ?? form.trayPosition}
                />
              ) : !scannedChannelQR && (
                <View style={s.rackRawChip}>
                  <Feather name="grid" size={14} color={colors.primary} />
                  <Text style={s.rackRawText}>{form.trayPosition}</Text>
                </View>
              )}

              <View style={s.summaryCard}>
                <Text style={s.summaryTitle}>Confirm Seeding</Text>
                <Row styles={s} label="Seed Name" value={form.seedName} />
                <Row
                  styles={s}
                  label="Trays"
                  value={`${form.fullTrays} full + ${form.halfTrays} half`}
                />
                <Row styles={s} label="Weight/Tray" value={`${form.seedWeightTray} g`} />
                <Row styles={s} label="Profile" value={selectedProfile?.name ?? "-"} />
                <Row styles={s} label="Seeding Date" value={form.seedingDate} />
                {channelStatus && (
                  <Row
                    styles={s}
                    label="Channel"
                    value={`${channelStatus.channel} (${channelStatus.room})`}
                  />
                )}
                {form.seedLotQrCodes.length > 0 && (
                  <View style={s.summaryLots}>
                    <Text style={s.summaryLotsTitle}>
                      Seed Lots ({form.seedLotQrCodes.length})
                    </Text>
                    {form.seedLotQrCodes.map((qr, idx) => {
                      const db = lotDbQueries[idx]?.data;
                      const qrMeta = scannedLots.find((l) => l.qr === qr);
                      const name = db?.seedName ?? qrMeta?.seedName ?? qr;
                      const sub = [
                        db?.type,
                        db?.supplier ?? qrMeta?.variety,
                        db?.growTime && `${db.growTime} grow`,
                        qrMeta?.batchWeight != null && `${qrMeta.batchWeight}${qrMeta.unit ?? "g"}`,
                      ].filter(Boolean).join("  ·  ");
                      return (
                        <View key={qr} style={s.summaryLotRow}>
                          <Feather name="package" size={12} color={colors.primary} />
                          <View style={{ flex: 1 }}>
                            <Text style={s.summaryLotName}>{name}</Text>
                            {!!sub && <Text style={s.summaryLotSub}>{sub}</Text>}
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            </>
          ) : (
            <Text style={s.stepSubtitle}>Waiting for rack slot scan…</Text>
          )}

          <Pressable
            style={[s.nextBtn, (!form.trayPosition || isPending) && s.btnDisabled]}
            onPress={handleConfirm}
            disabled={!form.trayPosition || isPending}
          >
            {isPending ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Text style={s.nextBtnText}>Confirm & Save</Text>
                <Feather name="check" size={18} color="#fff" />
              </>
            )}
          </Pressable>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Row({ styles: s, label, value }: { styles: ReturnType<typeof createStyles>; label: string; value: string }) {
  return (
    <View style={s.summaryRow}>
      <Text style={s.summaryLabel}>{label}</Text>
      <Text style={s.summaryValue}>{value}</Text>
    </View>
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
  dot: {
    width: 28,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.muted,
  },
  dotActive: { backgroundColor: colors.primary },
  stepContent: { padding: 20, paddingBottom: 40 },
  formScroll: { padding: 20, paddingBottom: 40 },
  stepTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.foreground,
    marginBottom: 6,
  },
  stepSubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
    marginBottom: 12,
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
  scannerBox: {
    width: "100%",
    borderRadius: colors.radius,
    overflow: "hidden",
    marginBottom: 16,
    backgroundColor: colors.muted,
  },
  lotCards: { gap: 8, marginBottom: 16 },
  lotCard: {
    backgroundColor: colors.secondary,
    borderRadius: colors.radius,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.primary + "30",
  },
  lotCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  lotCardName: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.primary,
  },
  lotCardMeta: { gap: 2, paddingLeft: 22 },
  lotMetaText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
  },
  summaryLots: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 8,
  },
  summaryLotsTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  summaryLotRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  summaryLotName: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.foreground,
  },
  summaryLotSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
    marginTop: 1,
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
  channelCard: {
    backgroundColor: colors.secondary,
    borderRadius: colors.radius,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.primary + "40",
    gap: 6,
  },
  channelCardFull: {
    borderColor: colors.destructive + "40",
    backgroundColor: colors.destructive + "12",
  },
  channelCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  channelCardTitle: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.primary,
  },
  channelCardTitleFull: {
    color: colors.destructive,
  },
  channelCardRoom: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
    marginLeft: 24,
  },
  channelCapacityRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  channelStat: {
    flex: 1,
    alignItems: "center",
    gap: 2,
  },
  channelStatVal: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.foreground,
  },
  channelStatLabel: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
  },
  channelStatDivider: {
    width: 1,
    height: 32,
    backgroundColor: colors.border,
  },
  channelTraysLeft: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.statusOk,
    marginTop: 4,
    textAlign: "center",
  },
  channelFullWarning: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.destructive,
    marginTop: 4,
    textAlign: "center",
  },
  fullBadge: {
    backgroundColor: colors.destructive,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  fullBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.foreground,
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: colors.radius,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.foreground,
    backgroundColor: colors.card,
  },
  row: { flexDirection: "row", gap: 12 },
  counter: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: colors.radius,
    height: 48,
    overflow: "hidden",
  },
  ctrBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.muted,
    height: "100%",
  },
  ctrVal: {
    flex: 1,
    textAlign: "center",
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: colors.foreground,
  },
  profileList: { gap: 8, marginBottom: 4 },
  profileOption: {
    padding: 12,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  profileOptionSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.secondary,
  },
  profileName: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.foreground,
  },
  profileNameSelected: { color: colors.primary, fontFamily: "Inter_600SemiBold" },
  profileMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
    marginTop: 2,
  },
  summaryCard: {
    backgroundColor: colors.card,
    borderRadius: colors.radius,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
    marginBottom: 4,
  },
  summaryTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: colors.foreground,
    marginBottom: 12,
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  summaryLabel: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
  },
  autoFillChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.primary + "40",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 6,
  },
  autoFillChipText: {
    flex: 1,
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: colors.primary,
  },
  summaryValue: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: colors.foreground,
    maxWidth: "60%",
    textAlign: "right",
  },
  nextBtn: {
    flexDirection: "row",
    height: 50,
    borderRadius: colors.radius,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 20,
  },
  nextBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  btnDisabled: { opacity: 0.4 },
});
