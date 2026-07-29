import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import DateTimePicker from "@react-native-community/datetimepicker";
import { usePostFacilityLog } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { getLogTypeDef, type FieldConfig } from "@/constants/facilityLogTypes";
import { useRecentFieldValues } from "@/hooks/useRecentFieldValues";
import { useLayoutZoneSuggestions } from "@/hooks/useLayoutZoneSuggestions";
import { uploadPhoto } from "@/utils/uploadPhoto";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SAVED_CONFIRMATION_MS = 700;

function initialValues(fields: FieldConfig[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const f of fields) {
    if (f.type === "number" && f.defaultValue) values[f.key] = f.defaultValue();
  }
  return values;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Per-category entry form — one dynamic route driven by the field configs
 * in constants/facilityLogTypes.ts rather than 6 near-duplicate files.
 * Presented as a modal (matches the app's existing fertigation/harvest/
 * manual-check convention). Create-only, no history view (Phase 4.3).
 *
 * Phase 5 P0: numeric steppers + smart defaults, inline per-field errors
 * (shown after the first attempted save, not before), return-key focus
 * chaining, and a brief success confirmation instead of an instant close.
 */
export default function LogEntryScreen() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const { type } = useLocalSearchParams<{ type: string }>();
  const def = getLogTypeDef(type ?? "");

  const [values, setValues] = useState<Record<string, string>>(() => initialValues(def?.fields ?? []));
  const [months, setMonths] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pickerField, setPickerField] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Record<string, string[]>>({});
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const postLog = usePostFacilityLog();
  const fieldRefs = useRef<Record<string, TextInput | null>>({});

  const recentFieldKeys = (def?.fields ?? [])
    .filter((f): f is Extract<FieldConfig, { type: "text" }> => f.type === "text" && f.autocomplete === "recent")
    .map((f) => f.key);
  const { recentByKey, addRecent } = useRecentFieldValues(type ?? "", recentFieldKeys);
  const layoutSuggestions = useLayoutZoneSuggestions();

  if (!def) {
    return (
      <SafeAreaView style={s.safe}>
        <Text style={s.errorText}>Unknown log type.</Text>
      </SafeAreaView>
    );
  }

  const focusableKeys = [
    ...def.fields.filter((f) => f.type === "text" || f.type === "number").map((f) => f.key),
    "notes",
  ];

  const setValue = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));

  const toggleMonth = (m: string) =>
    setMonths((current) => (current.includes(m) ? current.filter((x) => x !== m) : [...current, m]));

  const fieldError = (f: FieldConfig): string | null => {
    if (f.type === "months" || f.type === "photo") return null;
    if (!attempted || f.optional) return null;
    return values[f.key]?.trim() ? null : "Required";
  };

  const requiredFieldsFilled = def.fields.every((f) => {
    if (f.type === "months" || f.type === "photo") return true;
    if (f.optional) return true;
    return !!values[f.key]?.trim();
  });

  const buildData = async (): Promise<Record<string, unknown>> => {
    const data: Record<string, unknown> = {};
    for (const f of def.fields) {
      if (f.type === "months") {
        data[f.key] = months;
        continue;
      }
      if (f.type === "photo") {
        const localUris = photos[f.key] ?? [];
        data[f.key] = localUris.length > 0 ? await Promise.all(localUris.map(uploadPhoto)) : [];
        continue;
      }
      const raw = values[f.key]?.trim();
      if (!raw) continue;
      data[f.key] = f.type === "number" ? Number(raw) : raw;
    }
    return data;
  };

  const focusNext = (key: string) => {
    const idx = focusableKeys.indexOf(key);
    const nextKey = focusableKeys[idx + 1];
    if (nextKey) fieldRefs.current[nextKey]?.focus();
  };

  const handleSave = async () => {
    if (!requiredFieldsFilled) {
      setAttempted(true);
      return;
    }
    setUploading(true);
    setUploadError(false);
    let data: Record<string, unknown>;
    try {
      data = await buildData();
    } catch {
      setUploading(false);
      setUploadError(true);
      return;
    }
    setUploading(false);
    postLog.mutate(
      {
        data: {
          logType: def.type as any,
          data,
          notes: notes.trim() || undefined,
        },
      },
      {
        onSuccess: () => {
          for (const key of recentFieldKeys) {
            if (values[key]?.trim()) addRecent(key, values[key]);
          }
          setSaved(true);
          setTimeout(() => router.back(), SAVED_CONFIRMATION_MS);
        },
      },
    );
  };

  const pickPhoto = async (fieldKey: string, max: number) => {
    if ((photos[fieldKey] ?? []).length >= max) return;
    const result = await ImagePicker.launchCameraAsync({ quality: 0.6, allowsEditing: false });
    if (!result.canceled) {
      setPhotos((p) => ({ ...p, [fieldKey]: [...(p[fieldKey] ?? []), result.assets[0].uri] }));
    }
  };

  const pickFromLibrary = async (fieldKey: string, max: number) => {
    if ((photos[fieldKey] ?? []).length >= max) return;
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.6, allowsEditing: false });
    if (!result.canceled) {
      setPhotos((p) => ({ ...p, [fieldKey]: [...(p[fieldKey] ?? []), result.assets[0].uri] }));
    }
  };

  const removePhoto = (fieldKey: string, index: number) => {
    setPhotos((p) => ({ ...p, [fieldKey]: (p[fieldKey] ?? []).filter((_, i) => i !== index) }));
  };

  const adjustStepper = (field: FieldConfig, delta: number) => {
    if (field.type !== "number") return;
    const current = Number(values[field.key] ?? "0") || 0;
    setValue(field.key, String(current + delta));
  };

  const renderField = (field: FieldConfig) => {
    if (field.type === "months") {
      return (
        <View key={field.key} style={s.fieldWrap}>
          <Text style={s.label}>{field.label}</Text>
          <View style={s.monthGrid}>
            {MONTHS.map((m) => {
              const active = months.includes(m);
              return (
                <Pressable
                  key={m}
                  style={[s.monthChip, active && s.monthChipActive]}
                  onPress={() => toggleMonth(m)}
                >
                  <Text style={[s.monthChipText, active && s.monthChipTextActive]}>{m}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      );
    }

    if (field.type === "select") {
      return (
        <View key={field.key} style={s.fieldWrap}>
          <Text style={s.label}>{field.label}</Text>
          <View style={s.selectRow}>
            {field.options.map((opt) => {
              const active = values[field.key] === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  style={[s.selectChip, active && s.selectChipActive]}
                  onPress={() => setValue(field.key, opt.value)}
                >
                  <Text style={[s.selectChipText, active && s.selectChipTextActive]}>{opt.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      );
    }

    if (field.type === "photo") {
      const max = field.maxPhotos ?? 4;
      const fieldPhotos = photos[field.key] ?? [];
      return (
        <View key={field.key} style={s.fieldWrap}>
          <Text style={s.label}>{field.label} ({fieldPhotos.length}/{max})</Text>
          <View style={s.photoGrid}>
            {fieldPhotos.map((uri, i) => (
              <View key={i} style={s.photoWrap}>
                <Image source={{ uri }} style={s.photo} />
                <Pressable style={s.removePhotoBtn} onPress={() => removePhoto(field.key, i)}>
                  <Feather name="x" size={12} color="#fff" />
                </Pressable>
              </View>
            ))}
            {fieldPhotos.length < max && (
              <View style={s.photoActions}>
                <Pressable style={s.photoBtn} onPress={() => pickPhoto(field.key, max)}>
                  <Feather name="camera" size={20} color={colors.primary} />
                </Pressable>
                <Pressable style={s.photoBtn} onPress={() => pickFromLibrary(field.key, max)}>
                  <Feather name="image" size={20} color={colors.primary} />
                </Pressable>
              </View>
            )}
          </View>
        </View>
      );
    }

    const error = fieldError(field);

    if (field.type === "date" || field.type === "time") {
      return (
        <View key={field.key} style={s.fieldWrap}>
          <Text style={s.label}>
            {field.label}
            {field.optional ? "" : " *"}
          </Text>
          <Pressable
            style={[s.input, s.pickerInput, error && s.inputError]}
            onPress={() => setPickerField(field.key)}
          >
            <Text style={values[field.key] ? s.pickerValueText : s.pickerPlaceholderText}>
              {values[field.key] || (field.type === "date" ? "Select date" : "Select time")}
            </Text>
            <Feather name={field.type === "date" ? "calendar" : "clock"} size={16} color={colors.mutedForeground} />
          </Pressable>
          {error && <Text style={s.fieldErrorText}>{error}</Text>}
          {pickerField === field.key && (
            <DateTimePicker
              value={new Date()}
              mode={field.type}
              display="default"
              onChange={(_event, selectedDate) => {
                setPickerField(null);
                if (selectedDate) {
                  setValue(field.key, field.type === "date" ? formatDate(selectedDate) : formatTime(selectedDate));
                }
              }}
            />
          )}
        </View>
      );
    }

    const isLast = focusableKeys[focusableKeys.length - 1] === field.key;

    return (
      <View key={field.key} style={s.fieldWrap}>
        <Text style={s.label}>
          {field.label}
          {field.optional ? "" : " *"}
        </Text>
        <View style={field.type === "number" && field.stepper ? s.stepperRow : undefined}>
          {field.type === "number" && field.stepper && (
            <Pressable style={s.stepperBtn} onPress={() => adjustStepper(field, -(field.step ?? 1))} hitSlop={6}>
              <Feather name="minus" size={16} color={colors.foreground} />
            </Pressable>
          )}
          <TextInput
            ref={(r) => { fieldRefs.current[field.key] = r; }}
            style={[s.input, error && s.inputError, field.type === "number" && field.stepper && s.stepperInput]}
            value={values[field.key] ?? ""}
            onChangeText={(v) => setValue(field.key, v)}
            placeholder={field.placeholder}
            placeholderTextColor={colors.mutedForeground}
            keyboardType={field.type === "number" ? "numeric" : "default"}
            returnKeyType={isLast ? "done" : "next"}
            onSubmitEditing={() => focusNext(field.key)}
            blurOnSubmit={false}
          />
          {field.type === "number" && field.stepper && (
            <Pressable style={s.stepperBtn} onPress={() => adjustStepper(field, field.step ?? 1)} hitSlop={6}>
              <Feather name="plus" size={16} color={colors.foreground} />
            </Pressable>
          )}
        </View>
        {error && <Text style={s.fieldErrorText}>{error}</Text>}
        {field.type === "text" && field.autocomplete && (() => {
          const suggestions = field.autocomplete === "layout" ? layoutSuggestions : recentByKey[field.key] ?? [];
          const visible = suggestions.filter((v) => v !== values[field.key]);
          if (visible.length === 0) return null;
          return (
            <View style={s.suggestionRow}>
              {visible.map((v) => (
                <Pressable key={v} style={s.suggestionChip} onPress={() => setValue(field.key, v)}>
                  <Text style={s.suggestionChipText}>{v}</Text>
                </Pressable>
              ))}
            </View>
          );
        })()}
      </View>
    );
  };

  return (
    <SafeAreaView style={s.safe} edges={["top", "bottom"]}>
      <View style={s.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Feather name="x" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={s.topTitle}>{def.title}</Text>
        <View style={{ width: 24 }} />
      </View>

      {saved ? (
        <View style={s.savedWrap}>
          <View style={s.savedIcon}>
            <Feather name="check" size={28} color="#fff" />
          </View>
          <Text style={s.savedText}>Saved</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          {def.fields.map(renderField)}

          <View style={s.fieldWrap}>
            <Text style={s.label}>Notes</Text>
            <TextInput
              ref={(r) => { fieldRefs.current.notes = r; }}
              style={[s.input, s.notesInput]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Optional notes"
              placeholderTextColor={colors.mutedForeground}
              multiline
              returnKeyType="done"
            />
          </View>

          {(postLog.isError || uploadError) && (
            <Text style={s.errorText}>Something went wrong. Try again.</Text>
          )}

          <Pressable
            style={[s.saveBtn, (postLog.isPending || uploading) && s.saveBtnDisabled]}
            onPress={handleSave}
            disabled={postLog.isPending || uploading}
          >
            {postLog.isPending || uploading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={s.saveBtnText}>Save Log</Text>
            )}
          </Pressable>
        </ScrollView>
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
  content: { padding: 16, gap: 16 },
  fieldWrap: { gap: 6 },
  label: { fontSize: 13, fontFamily: "Inter_500Medium", color: colors.mutedForeground },
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
  inputError: { borderColor: colors.destructive },
  pickerInput: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pickerValueText: { fontSize: 15, fontFamily: "Inter_400Regular", color: colors.foreground },
  pickerPlaceholderText: { fontSize: 15, fontFamily: "Inter_400Regular", color: colors.mutedForeground },
  fieldErrorText: { fontSize: 12, fontFamily: "Inter_400Regular", color: colors.destructive },
  suggestionRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
  suggestionChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: colors.muted,
  },
  suggestionChipText: { fontSize: 12, fontFamily: "Inter_500Medium", color: colors.mutedForeground },
  photoGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  photoWrap: { position: "relative" },
  photo: { width: 72, height: 72, borderRadius: colors.radius, backgroundColor: colors.muted },
  removePhotoBtn: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.destructive,
    alignItems: "center",
    justifyContent: "center",
  },
  photoActions: { flexDirection: "row", gap: 10 },
  photoBtn: {
    width: 72,
    height: 72,
    borderRadius: colors.radius,
    borderWidth: 2,
    borderColor: colors.border,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.card,
  },
  notesInput: { height: 90, paddingTop: 12, textAlignVertical: "top" },
  stepperRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  stepperBtn: {
    width: 40,
    height: 40,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperInput: { flex: 1, textAlign: "center" },
  monthGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  monthChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  monthChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  monthChipText: { fontSize: 13, fontFamily: "Inter_500Medium", color: colors.foreground },
  monthChipTextActive: { color: "#fff" },
  selectRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  selectChip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  selectChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  selectChipText: { fontSize: 14, fontFamily: "Inter_500Medium", color: colors.foreground },
  selectChipTextActive: { color: "#fff" },
  saveBtn: {
    height: 50,
    borderRadius: colors.radius,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
  errorText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.destructive,
    textAlign: "center",
  },
  savedWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  savedIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.statusOk,
    alignItems: "center",
    justifyContent: "center",
  },
  savedText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: colors.foreground },
});
