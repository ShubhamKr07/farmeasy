import { Feather } from "@expo/vector-icons";
import React, { useMemo, useState, useCallback } from "react";
import { posthog } from "@/src/config/posthog";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useResolveLayoutQr } from "@workspace/api-client-react";
import type { ChannelResolved } from "@workspace/api-client-react";
import QRScanner from "@/components/QRScanner";
import ChannelMonitoringCard from "@/components/ChannelMonitoringCard";
import { parseQR, type LayoutQR } from "@/utils/parseQR";
import { useColors } from "@/hooks/useColors";
import AppHeader from "@/components/AppHeader";

type ScanState =
  | { status: "idle" }
  | { status: "resolving"; qr: LayoutQR }
  | { status: "done"; qr: LayoutQR; data: ChannelResolved }
  | { status: "error"; qr: LayoutQR; message: string };

export default function ScanScreen() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [scanState, setScanState] = useState<ScanState>({ status: "idle" });
  const [resolveParams, setResolveParams] = useState<{
    room: string;
    channel: string;
    rack?: string;
  } | null>(null);

  const { data: resolved, isLoading, isError } = useResolveLayoutQr(
    resolveParams ?? { room: "", channel: "" },
    {
      query: {
        enabled: !!resolveParams,
        retry: false,
        staleTime: 0,
      },
    }
  );

  React.useEffect(() => {
    if (!resolveParams) return;
    if (isLoading) return;
    if (resolved && scanState.status === "resolving") {
      setScanState({ status: "done", qr: scanState.qr, data: resolved });
      posthog.capture("channel_qr_scanned", {
        room: scanState.qr.room,
        channel: scanState.qr.channel,
        rack: scanState.qr.rack ?? null,
        total_trays: resolved.totalTrays,
        active_cycles: resolved.activeCycles,
        available_trays: resolved.availableTrays,
        is_full: resolved.isFull,
      });
    } else if (isError && scanState.status === "resolving") {
      setScanState({
        status: "error",
        qr: scanState.qr,
        message: "Channel not found in the facility layout.",
      });
    }
  }, [resolved, isLoading, isError, resolveParams]);

  const handleScanned = useCallback((raw: string) => {
    if (scanState.status === "resolving") return;

    const parsed = parseQR(raw);
    if (!parsed || parsed.type !== "layout") {
      setScanState({
        status: "error",
        qr: { type: "layout", facility: "", room: "", channel: "" },
        message: "This QR code is not a facility layout code. Please scan a channel or rack QR.",
      });
      return;
    }

    const qr = parsed as LayoutQR;
    setScanState({ status: "resolving", qr });
    setResolveParams({
      room: qr.room,
      channel: qr.channel,
      ...(qr.rack ? { rack: qr.rack } : {}),
    });
  }, [scanState.status]);

  const handleReset = useCallback(() => {
    setScanState({ status: "idle" });
    setResolveParams(null);
  }, []);

  return (
    <SafeAreaView style={s.safe} edges={["top"]}>
      <AppHeader />
      <View style={s.header}>
        <Text style={s.title}>Scan Channel QR</Text>
        <Text style={s.subtitle}>Point the camera at a channel or rack QR code to view live environmental readings.</Text>
      </View>

      {scanState.status === "idle" && (
        <View style={s.scannerWrap}>
          <QRScanner onScanned={handleScanned} hint="Scan a facility layout QR" />
        </View>
      )}

      {scanState.status === "resolving" && (
        <View style={s.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={s.resolving}>Resolving channel…</Text>
        </View>
      )}

      {(scanState.status === "done" || scanState.status === "error") && (
        <ScrollView contentContainerStyle={s.results}>
          {scanState.status === "done" ? (
            <ChannelMonitoringCard data={scanState.data} />
          ) : (
            <View style={s.errorCard}>
              <Feather name="alert-circle" size={28} color={colors.destructive} />
              <Text style={s.errorTitle}>Not Recognized</Text>
              <Text style={s.errorMessage}>{scanState.message}</Text>
            </View>
          )}

          <Pressable style={s.scanAgain} onPress={handleReset}>
            <Feather name="refresh-cw" size={16} color={colors.primaryForeground} />
            <Text style={s.scanAgainText}>Scan Another</Text>
          </Pressable>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const createStyles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
  },
  title: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.foreground,
  },
  subtitle: {
    marginTop: 4,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
    lineHeight: 18,
  },
  scannerWrap: {
    marginHorizontal: 20,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
  },
  resolving: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.mutedForeground,
  },
  results: {
    padding: 20,
    paddingBottom: 40,
  },
  errorCard: {
    backgroundColor: colors.destructive + "12",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.destructive + "40",
    padding: 24,
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
  },
  errorTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.destructive,
  },
  errorMessage: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.destructive,
    textAlign: "center",
    lineHeight: 19,
  },
  scanAgain: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  scanAgainText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.primaryForeground,
  },
});
