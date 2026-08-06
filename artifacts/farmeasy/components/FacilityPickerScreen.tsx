import { Feather } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useColors } from "@/hooks/useColors";

type Facility = { id: number; facilityName: string };

/**
 * Full-screen blocking facility picker — mobile's equivalent of
 * admin-dashboard's `FacilityPicker` (src/App.tsx). Shown by `TabLayout`
 * only when `useActiveFacility()` reports `needsPicker: true` (2+
 * facilities, no valid persisted selection yet — fresh install, or a
 * technician freshly invited into a multi-facility org). Replaces the
 * entire tab shell, not just a sheet row: nothing is facility-scoped until
 * a choice is made, so no tab content may render underneath it.
 */
export function FacilityPickerScreen({
  facilities,
  onSelect,
}: {
  facilities: Facility[];
  onSelect: (id: number) => void;
}) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={s.container}>
      <Text style={s.title}>Choose a facility</Text>
      <Text style={s.subtitle}>Select a facility to continue</Text>
      <View style={s.list}>
        {facilities.map((f) => (
          <Pressable
            key={f.id}
            style={s.row}
            onPress={() => onSelect(f.id)}
            testID={`facility-picker-${f.id}`}
          >
            <Text style={s.rowText}>{f.facilityName}</Text>
            <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const createStyles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 8,
  },
  title: {
    fontSize: 20,
    fontFamily: "Inter_600SemiBold",
    color: colors.foreground,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.mutedForeground,
    marginBottom: 24,
  },
  list: {
    width: "100%",
    maxWidth: 400,
    gap: 10,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  rowText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.cardForeground,
  },
});
