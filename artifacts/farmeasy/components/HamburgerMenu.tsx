import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useColors } from "@/hooks/useColors";
import { elevation } from "@/constants/elevation";
import LogoMark from "@/components/LogoMark";
import { FacilitySwitcherSheet } from "@/components/FacilitySwitcherSheet";

const PANEL_WIDTH = 280;

interface Props {
  open: boolean;
  onClose: () => void;
  userName: string;
  userInitial: string;
  roleLabel: string;
  onSignOut: () => void;
}

/**
 * Left-side slide-in account/navigation panel, triggered by the hamburger
 * icon in Home's header. Built with react-native-reanimated +
 * react-native-gesture-handler (both already installed) rather than adding
 * @react-navigation/drawer as a new dependency — same "don't add a library
 * the app doesn't already need" call made for web's drag-reorder (native
 * HTML5 DnD over dnd-kit).
 *
 * Houses the account identity + Sign Out (previously a direct tap-the
 * -avatar action in Home's header, now an explicit menu row) and Data Logs
 * (Alpha App Phase 4).
 */
export default function HamburgerMenu({
  open,
  onClose,
  userName,
  userInitial,
  roleLabel,
  onSignOut,
}: Props) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const { height } = useWindowDimensions();
  const [modalVisible, setModalVisible] = React.useState(open);

  const translateX = useSharedValue(-PANEL_WIDTH);
  const backdropOpacity = useSharedValue(0);

  useEffect(() => {
    if (open) {
      setModalVisible(true);
      translateX.value = withTiming(0, { duration: 220 });
      backdropOpacity.value = withTiming(1, { duration: 220 });
    } else {
      translateX.value = withTiming(-PANEL_WIDTH, { duration: 220 });
      backdropOpacity.value = withTiming(0, { duration: 220 }, (finished) => {
        if (finished) runOnJS(setModalVisible)(false);
      });
    }
  }, [open, translateX, backdropOpacity]);

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  return (
    <Modal
      transparent
      visible={modalVisible}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={[StyleSheet.absoluteFill, { height }]} pointerEvents={open ? "auto" : "none"}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close menu" />
        </Animated.View>

        <Animated.View style={[s.panel, panelStyle]}>
          <View style={s.brandRow}>
            <LogoMark size={22} />
            <Text style={s.brandText}>FarmSmart</Text>
          </View>

          <View style={s.accountBlock}>
            <View style={s.avatar}>
              <Text style={s.avatarText}>{userInitial}</Text>
            </View>
            <Text style={s.userName}>{userName}</Text>
            <View style={s.roleBadge}>
              <Text style={s.roleText}>{roleLabel}</Text>
            </View>
          </View>

          <View style={s.divider} />

          <FacilitySwitcherSheet onSelected={onClose} />

          <Pressable
            style={s.menuRow}
            onPress={() => {
              onClose();
              router.push("/search" as any);
            }}
          >
            <Feather name="search" size={18} color={colors.foreground} />
            <Text style={s.menuRowText}>Search</Text>
            <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
          </Pressable>

          <Pressable
            style={s.menuRow}
            onPress={() => {
              onClose();
              router.push("/logs" as any);
            }}
          >
            <Feather name="clipboard" size={18} color={colors.foreground} />
            <Text style={s.menuRowText}>Data Logs</Text>
            <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
          </Pressable>

          <View style={s.divider} />

          <Pressable style={s.menuRow} onPress={onSignOut} testID="menu-sign-out">
            <Feather name="log-out" size={18} color={colors.destructive} />
            <Text style={[s.menuRowText, { color: colors.destructive }]}>Sign Out</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
});

const createStyles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  panel: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: PANEL_WIDTH,
    backgroundColor: colors.card,
    paddingTop: 60,
    paddingHorizontal: 20,
    ...elevation(2, colors),
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 24 },
  brandText: { fontSize: 16, fontFamily: "Inter_700Bold", color: colors.primary },
  accountBlock: { alignItems: "flex-start", marginBottom: 20 },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  avatarText: { color: "#fff", fontSize: 18, fontFamily: "Inter_700Bold" },
  userName: { fontSize: 17, fontFamily: "Inter_700Bold", color: colors.foreground },
  roleBadge: {
    marginTop: 6,
    backgroundColor: colors.muted,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  roleText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: colors.primary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 8 },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
  },
  menuRowText: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.foreground,
  },
});
