import { useRouter } from "expo-router";
import * as Linking from "expo-linking";
import { supabase } from "@/lib/supabase";
import React, { useMemo } from "react";
import {
  ActivityIndicator,
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
import { useColors } from "@/hooks/useColors";
import LogoMark from "@/components/LogoMark";

type Step = "email" | "reset";

export default function ForgotPasswordPage() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();

  const [step, setStep] = React.useState<Step>("email");
  const [emailAddress, setEmailAddress] = React.useState("");
  const [code, setCode] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);

  const handleSendCode = async () => {
    setError(null);
    setIsLoading(true);
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(emailAddress, {
        redirectTo: Linking.createURL("/reset-password"),
      });
      if (resetError) {
        setError(resetError.message ?? "Couldn't send reset code.");
        return;
      }
      setStep("reset");
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async () => {
    setError(null);
    setIsLoading(true);
    try {
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email: emailAddress,
        token: code,
        type: "recovery",
      });
      if (verifyError) {
        setError(verifyError.message ?? "Invalid code.");
        return;
      }
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) {
        setError(updateError.message ?? "Couldn't reset password.");
        return;
      }
      router.push("/");
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <View style={s.container}>
            <View style={s.logoRow}>
              <LogoMark size={32} />
              <Text style={s.logoText}>FarmSmart</Text>
            </View>

            {step === "email" ? (
              <>
                <Text style={s.title}>Reset your password</Text>
                <Text style={s.subtitle}>
                  Enter your email and we'll send you a reset code
                </Text>

                <Text style={s.label}>Email address</Text>
                <TextInput
                  style={s.input}
                  autoCapitalize="none"
                  value={emailAddress}
                  placeholder="you@example.com"
                  placeholderTextColor={colors.mutedForeground}
                  onChangeText={setEmailAddress}
                  keyboardType="email-address"
                  autoCorrect={false}
                  autoComplete="email"
                />

                <Pressable
                  style={[s.btn, (!emailAddress || isLoading) && s.btnDisabled]}
                  onPress={handleSendCode}
                  disabled={!emailAddress || isLoading}
                >
                  {isLoading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={s.btnText}>Send reset code</Text>
                  )}
                </Pressable>
              </>
            ) : (
              <>
                <Text style={s.title}>Check your email</Text>
                <Text style={s.subtitle}>
                  Enter the code we sent you and choose a new password
                </Text>

                <Text style={s.label}>Reset code</Text>
                <TextInput
                  style={s.input}
                  value={code}
                  placeholder="6-digit code"
                  placeholderTextColor={colors.mutedForeground}
                  onChangeText={setCode}
                  keyboardType="numeric"
                  autoComplete="one-time-code"
                />

                <Text style={s.label}>New password</Text>
                <TextInput
                  style={s.input}
                  value={newPassword}
                  placeholder="••••••••"
                  placeholderTextColor={colors.mutedForeground}
                  secureTextEntry
                  onChangeText={setNewPassword}
                  autoComplete="new-password"
                />

                <Pressable
                  style={[s.btn, (!code || !newPassword || isLoading) && s.btnDisabled]}
                  onPress={handleResetPassword}
                  disabled={!code || !newPassword || isLoading}
                >
                  {isLoading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={s.btnText}>Reset password</Text>
                  )}
                </Pressable>
              </>
            )}

            {error && (
              <View style={s.errorBanner}>
                <Text style={s.errorBannerText}>{error}</Text>
              </View>
            )}

            <Pressable style={s.linkBtn} onPress={() => router.back()}>
              <Text style={s.linkText}>Back to sign in</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1 },
  container: {
    flex: 1,
    padding: 28,
    justifyContent: "center",
    maxWidth: 440,
    alignSelf: "center",
    width: "100%",
  },
  logoRow: { flexDirection: "row", alignItems: "center", marginBottom: 40 },
  logoText: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: colors.primary,
    marginLeft: 10,
  },
  title: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: colors.foreground,
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
    marginBottom: 32,
  },
  label: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.foreground,
    marginBottom: 6,
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
    marginBottom: 16,
  },
  btn: {
    height: 50,
    borderRadius: colors.radius,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
  linkBtn: { alignSelf: "center", marginTop: 20, padding: 4 },
  linkText: { fontSize: 14, fontFamily: "Inter_500Medium", color: colors.primary },
  errorBanner: {
    marginTop: 16,
    padding: 12,
    borderRadius: colors.radius,
    backgroundColor: colors.destructive + "18",
    borderWidth: 1,
    borderColor: colors.destructive + "40",
  },
  errorBannerText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.destructive,
    textAlign: "center",
  },
});
