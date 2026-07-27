import * as Linking from "expo-linking";
import { type Href, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
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

WebBrowser.maybeCompleteAuthSession();

function useWarmUpBrowser() {
  useEffect(() => {
    if (Platform.OS !== "web") void WebBrowser.warmUpAsync();
    return () => {
      if (Platform.OS !== "web") void WebBrowser.coolDownAsync();
    };
  }, []);
}

export default function SignInPage() {
  useWarmUpBrowser();
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const router = useRouter();

  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [oauthLoading, setOauthLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isLoading = submitLoading;

  const handleGoogleSignIn = async () => {
    setOauthLoading(true);
    setErrorMessage(null);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: Linking.createURL("/") },
      });
      if (error) {
        console.error("[SignIn] Google OAuth error:", error.message);
        setErrorMessage(error.message);
      }
    } catch (err: any) {
      console.error("[SignIn] Google OAuth exception:", err?.message ?? err);
      setErrorMessage(err?.message ?? "Unable to sign in with Google.");
    } finally {
      setOauthLoading(false);
    }
  };

  const handleSubmit = async () => {
    setSubmitLoading(true);
    setErrorMessage(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: emailAddress,
        password,
      });
      if (error) {
        console.error("[SignIn] password error:", JSON.stringify(error, null, 2));
        setErrorMessage(error.message);
        return;
      }
      router.push("/" as Href);
    } catch (err: any) {
      console.error("[SignIn] exception:", err?.message ?? err);
      setErrorMessage(err?.message ?? "Invalid email or password.");
    } finally {
      setSubmitLoading(false);
    }
  };

  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={s.container}>
            <View style={s.logoRow}>
              <LogoMark size={32} />
              <Text style={s.logoText}>FarmSmart</Text>
            </View>
            <Text style={s.title}>Welcome back</Text>
            <Text style={s.subtitle}>Sign in to your account</Text>

            <Pressable
              style={[s.oauthBtn, oauthLoading && s.btnDisabled]}
              onPress={handleGoogleSignIn}
              disabled={oauthLoading}
            >
              {oauthLoading ? (
                <ActivityIndicator color={colors.foreground} />
              ) : (
                <>
                  <Image
                    source={{ uri: "https://www.google.com/favicon.ico" }}
                    style={s.oauthIcon}
                  />
                  <Text style={s.oauthBtnText}>Continue with Google</Text>
                </>
              )}
            </Pressable>

            <View style={s.dividerRow}>
              <View style={s.dividerLine} />
              <Text style={s.dividerText}>or</Text>
              <View style={s.dividerLine} />
            </View>

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
              placeholder="••••••••"
              placeholderTextColor={colors.mutedForeground}
              secureTextEntry
              onChangeText={setPassword}
              autoComplete="current-password"
            />

            <Pressable style={s.linkBtnRight} onPress={() => router.push("/(auth)/forgot-password" as Href)}>
              <Text style={s.linkText}>Forgot password?</Text>
            </Pressable>

            <Pressable
              style={[
                s.btn,
                (!emailAddress || !password || isLoading) && s.btnDisabled,
              ]}
              onPress={handleSubmit}
              disabled={!emailAddress || !password || isLoading}
            >
              {isLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={s.btnText}>Sign in</Text>
              )}
            </Pressable>

            <View style={s.footerRow}>
              <Text style={s.footerText}>Don't have an account? </Text>
              <Pressable onPress={() => router.push("/(auth)/sign-up" as Href)}>
                <Text style={s.footerLink}>Sign up</Text>
              </Pressable>
            </View>

            {errorMessage && (
              <View style={s.errorBanner}>
                <Text style={s.errorBannerText}>{errorMessage}</Text>
              </View>
            )}
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
  logoRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 40,
  },
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
    marginBottom: 24,
  },
  oauthBtn: {
    flexDirection: "row",
    height: 50,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  oauthIcon: { width: 18, height: 18 },
  oauthBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.foreground,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 20,
    gap: 12,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
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
    marginBottom: 8,
  },
  errorText: {
    color: colors.destructive,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginBottom: 8,
  },
  btn: {
    height: 50,
    borderRadius: colors.radius,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 16,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  linkBtn: {
    alignSelf: "center",
    marginTop: 16,
    padding: 4,
  },
  linkBtnRight: {
    alignSelf: "flex-end",
    marginBottom: 4,
    padding: 4,
  },
  footerRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 24,
  },
  footerText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.mutedForeground,
  },
  footerLink: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: colors.primary,
  },
  linkText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.primary,
  },
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
