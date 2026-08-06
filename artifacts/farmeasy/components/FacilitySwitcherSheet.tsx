import { Feather } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useActiveFacility } from "@/context/ActiveFacilityContext";

/**
 * Facility switcher row group for the profile sheet (HamburgerMenu). Renders
 * nothing for a single-facility org — matches admin-dashboard's own
 * "hidden entirely when the org has exactly one facility" rule. Read-and-
 * switch only: no "Add facility" row exists here (TEN-008 §3a — mobile never
 * creates facilities).
 */
export function FacilitySwitcherSheet({ onSelected }: { onSelected?: () => void }) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const { facilities, activeFacilityId, selectFacility } = useActiveFacility();

  if (facilities.length <= 1) return null;

  return (
    <View>
      <Text style={s.sectionLabel}>Facilities</Text>
      {facilities.map((f) => (
        <Pressable
          key={f.id}
          style={s.menuRow}
          onPress={() => {
            selectFacility(f.id);
            onSelected?.();
          }}
          testID={`facility-option-${f.id}`}
        >
          <Feather
            name={f.id === activeFacilityId ? "check-circle" : "circle"}
            size={18}
            color={f.id === activeFacilityId ? colors.primary : colors.mutedForeground}
          />
          <Text style={s.menuRowText}>{f.facilityName}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const createStyles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  sectionLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 4,
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
  },
  menuRowText: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.foreground,
  },
});
