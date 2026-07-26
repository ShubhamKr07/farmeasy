import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import { posthog } from "@/src/config/posthog";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePostRecommend } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";

const EXAMPLE_QUESTIONS = [
  "why are my basil trays failing?",
  "what's my yield this week?",
  "best EC and pH for lettuce?",
  "recommend a nutrient supplier",
];

/**
 * Mobile "Ask Me" — a modal screen (matches the app's existing modal
 * convention: /seeding, /fertigation/[id], /harvest/[id]) reached via the
 * floating action button rendered over the tab bar. Reuses the same
 * POST /api/recommend backend as the web dashboard's Ask Me bar — no
 * server changes needed.
 */
export default function AskScreen() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [submittedQuestion, setSubmittedQuestion] = useState<string | null>(null);
  const recommend = usePostRecommend();

  const handleSubmit = () => {
    const trimmed = question.trim();
    if (!trimmed) return;
    setSubmittedQuestion(trimmed);
    posthog.capture("ai_question_asked", {
      question_length: trimmed.length,
    });
    recommend.mutate({ data: { question: trimmed } });
  };

  return (
    <SafeAreaView style={s.safe} edges={["top", "bottom"]}>
      <View style={s.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Feather name="x" size={24} color={colors.foreground} />
        </Pressable>
        <View style={s.topTitleWrap}>
          <Feather name="zap" size={16} color={colors.primary} />
          <Text style={s.topTitle}>Ask Me</Text>
        </View>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.intro}>
          Ask anything about vertical farming — crop setpoints, troubleshooting, market data.
          Answers combine your own farm data with external knowledge.
        </Text>

        <View style={s.inputRow}>
          <TextInput
            style={s.input}
            value={question}
            onChangeText={setQuestion}
            placeholder={`e.g. ${EXAMPLE_QUESTIONS[0]}`}
            placeholderTextColor={colors.mutedForeground}
            multiline
            onSubmitEditing={handleSubmit}
          />
          <Pressable
            style={[s.askBtn, (!question.trim() || recommend.isPending) && s.askBtnDisabled]}
            onPress={handleSubmit}
            disabled={!question.trim() || recommend.isPending}
          >
            {recommend.isPending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Feather name="arrow-up" size={18} color="#fff" />
            )}
          </Pressable>
        </View>

        {recommend.isPending && (
          <Text style={s.thinking}>Thinking…</Text>
        )}

        {recommend.isError && (
          <Text style={s.errorText}>Something went wrong. Try again in a moment.</Text>
        )}

        {recommend.isSuccess && submittedQuestion && (
          <View style={s.answerBlock}>
            <Text style={s.questionLabel}>Q: {submittedQuestion}</Text>
            <Text style={s.answerText}>{recommend.data.answer}</Text>

            {recommend.data.sources.length > 0 && (
              <View style={s.sourcesWrap}>
                <Text style={s.sourcesLabel}>Sources</Text>
                {recommend.data.sources.map((src) => (
                  <Pressable
                    key={src.url}
                    style={s.sourceRow}
                    onPress={() => Linking.openURL(src.url)}
                  >
                    <Text style={s.sourceTitle} numberOfLines={1}>{src.title || src.url}</Text>
                    <View style={s.sourceMeta}>
                      <Text style={s.sourceSim}>{Math.round(src.similarity * 100)}%</Text>
                      <Feather name="external-link" size={12} color={colors.mutedForeground} />
                    </View>
                  </Pressable>
                ))}
              </View>
            )}

            {recommend.data.cache_hit && (
              <Text style={s.cacheNote}>Answered from cached knowledge.</Text>
            )}
          </View>
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
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  topTitleWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  topTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: colors.foreground },
  content: { padding: 16, gap: 14 },
  intro: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
    lineHeight: 19,
  },
  inputRow: { flexDirection: "row", gap: 8, alignItems: "flex-end" },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: colors.radius,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.foreground,
    backgroundColor: colors.card,
  },
  askBtn: {
    width: 48,
    height: 48,
    borderRadius: colors.radius,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  askBtnDisabled: { opacity: 0.4 },
  thinking: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
  },
  errorText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.destructive,
  },
  answerBlock: {
    backgroundColor: colors.card,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 10,
  },
  questionLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: colors.mutedForeground,
  },
  answerText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.foreground,
    lineHeight: 21,
  },
  sourcesWrap: { gap: 6, marginTop: 4 },
  sourcesLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sourceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  sourceTitle: {
    flex: 1,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.foreground,
  },
  sourceMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  sourceSim: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: colors.mutedForeground,
  },
  cacheNote: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
    fontStyle: "italic",
  },
});
