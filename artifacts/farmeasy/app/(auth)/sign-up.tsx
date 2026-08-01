import { type Href, useRouter } from "expo-router";
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
import { supabase } from "@/lib/supabase";
import { useColors } from "@/hooks/useColors";
import LogoMark from "@/components/LogoMark";

export default function SignUpPage() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();

  const [emailAddress, setEmailAddress] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [pendingVerification, setPendingVerification] = React.useState(false);
  const [submitLoading, setSubmitLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const isLoading = submitLoading;

  const handleCreateAccount = async () => {
    setSubmitLoading(true);
    setError(null);
    try {
      // Auth-only sign-up: no raw_user_meta_data (the client must not carry a
      // role claim — Task 1's auth trigger strips/ignores it server-side and
      // always assigns technician) and NO public.users insert. Task 1's
      // `on_auth_user_created` trigger provisions the profile row server-side,
      // so the client never writes to public.users anymore. The legacy
      // duplicate-only INSERT policy / 23505-swallow path is gone with it.
      const { data, error: createError } = await supabase.auth.signUp({
        email: emailAddress,
        password,
      });
      if (createError) {
        setError(createError.message ?? "Couldn't create account.");
        return;
      }
      if (!data.user) {
        setError("Couldn't create account.");
        return;
      }
      // Email confirmation step. Task 8 configured the project's Auth email
      // template to OTP; the code-input screen below collects the 6-digit OTP.
      setPendingVerification(true);
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong.");
    } finally {
      setSubmitLoading(false);
    }
  };

  const handleVerify = async () => {
    setSubmitLoading(true);
    setError(null);
    try {
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email: emailAddress,
        token: code,
        type: "signup",
      });
      if (verifyError) {
        setError(verifyError.message ?? "Invalid code.");
        return;
      }
      router.push("/" as Href);
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong.");
    } finally {
      setSubmitLoading(false);
    }
  };

  const handleResend = async () => {
    setError(null);
    try {
      const { error: resendError } = await supabase.auth.resend({
        email: emailAddress,
        type: "signup",
      });
      if (resendError) {
        setError(resendError.message ?? "Couldn't resend code.");
      }
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong.");
    }
  };

  if (pendingVerification) {
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.container}>
          <View style={s.logoRow}>
            <LogoMark size={32} />
            <Text style={s.logoText}>FarmSmart</Text>
          </View>
          <Text style={s.title}>Verify your email</Text>
          <Text style={s.subtitle}>Enter the code sent to {emailAddress}</Text>
          <TextInput
            style={s.input}
            value={code}
            placeholder="6-digit code"
            placeholderTextColor={colors.mutedForeground}
            onChangeText={setCode}
            keyboardType="numeric"
            autoComplete="one-time-code"
          />
          <Pressable
            style={[s.btn, (!code || isLoading) && s.btnDisabled]}
            onPress={handleVerify}
            disabled={!code || isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={s.btnText}>Verify</Text>
            )}
          </Pressable>
          {error && (
            <View style={s.errorBanner}>
              <Text style={s.errorBannerText}>{error}</Text>
            </View>
          )}
          <Pressable style={s.linkBtn} onPress={handleResend}>
            <Text style={s.linkText}>Resend code</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

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
            <Text style={s.title}>Create your account</Text>
            <Text style={s.subtitle}>Welcome! Please fill in the details to get started</Text>

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

            <Text style={s.label}>Password</Text>
            <TextInput
              style={s.input}
              value={password}
              placeholder="Create a password"
              placeholderTextColor={colors.mutedForeground}
              secureTextEntry
              onChangeText={setPassword}
              autoComplete="new-password"
            />

            <Pressable
              style={[s.btn, (!emailAddress || !password || isLoading) && s.btnDisabled]}
              onPress={handleCreateAccount}
              disabled={!emailAddress || !password || isLoading}
            >
              {isLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={s.btnText}>Continue</Text>
              )}
            </Pressable>

            {error && (
              <View style={s.errorBanner}>
                <Text style={s.errorBannerText}>{error}</Text>
              </View>
            )}

            <View style={s.footerRow}>
              <Text style={s.footerText}>Already have an account? </Text>
              <Pressable onPress={() => router.back()}>
                <Text style={s.footerLink}>Sign in</Text>
              </Pressable>
            </View>
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
  footerRow: { flexDirection: "row", justifyContent: "center", marginTop: 24 },
  footerText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
  },
  footerLink: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: colors.primary },
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
