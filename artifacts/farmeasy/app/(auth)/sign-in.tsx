import { useSSO, useSignIn } from "@clerk/expo";
import * as Linking from "expo-linking";
import { type Href, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import React, { useCallback, useEffect, useMemo } from "react";
import { posthog } from "@/src/config/posthog";
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
  const { signIn, errors, fetchStatus } = useSignIn();
  const { startSSOFlow } = useSSO();
  const router = useRouter();

  const [emailAddress, setEmailAddress] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [verifyCode, setVerifyCode] = React.useState("");
  const [oauthLoading, setOauthLoading] = React.useState(false);

  const isLoading = fetchStatus === "fetching";

  const finalizeAndGoHome = useCallback(async () => {
    await signIn.finalize({
      navigate: ({ session, decorateUrl }) => {
        if (session?.currentTask) {
          console.log("[SignIn] pending task:", session.currentTask);
          return;
        }
        const url = decorateUrl("/");
        if (url.startsWith("http")) {
          (window as any).location.href = url;
        } else {
          router.push(url as Href);
        }
      },
    });
  }, [signIn, router]);

  const handleGoogleSignIn = async () => {
    setOauthLoading(true);
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: "oauth_google",
        redirectUrl: Linking.createURL("/"),
      });
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        posthog.capture("user_signed_in_google", { method: "google_oauth" });
        router.push("/" as Href);
      }
    } catch (err: any) {
      console.error("[SignIn] Google OAuth error:", err?.message ?? err);
    } finally {
      setOauthLoading(false);
    }
  };

  const handleSubmit = async () => {
    try {
      const { error } = await signIn.password({ emailAddress, password });
      if (error) {
        console.error("[SignIn] password error:", JSON.stringify(error, null, 2));
        return;
      }

      if (signIn.status === "complete") {
        posthog.capture("user_signed_in", { method: "email_password" });
        await finalizeAndGoHome();
      } else if (signIn.status === "needs_client_trust") {
        const emailCodeFactor = signIn.supportedSecondFactors.find(
          (f) => f.strategy === "email_code"
        );
        if (emailCodeFactor) {
          await signIn.mfa.sendEmailCode();
        }
      } else {
        console.error("[SignIn] unexpected status:", signIn.status);
      }
    } catch (err: any) {
      console.error("[SignIn] exception:", err?.message ?? err);
    }
  };

  const handleVerify = async () => {
    try {
      await signIn.mfa.verifyEmailCode({ code: verifyCode });
      if (signIn.status === "complete") {
        await finalizeAndGoHome();
      } else {
        console.error("[SignIn] verify: unexpected status:", signIn.status);
      }
    } catch (err: any) {
      console.error("[SignIn] verify exception:", err?.message ?? err);
    }
  };

  if (signIn.status === "needs_client_trust") {
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.container}>
          <View style={s.logoRow}>
            <LogoMark size={32} />
            <Text style={s.logoText}>FarmSmart</Text>
          </View>
          <Text style={s.title}>Verify your identity</Text>
          <Text style={s.subtitle}>Enter the code sent to your email</Text>
          <TextInput
            style={s.input}
            value={verifyCode}
            placeholder="6-digit code"
            placeholderTextColor={colors.mutedForeground}
            onChangeText={setVerifyCode}
            keyboardType="numeric"
            autoComplete="one-time-code"
          />
          {errors.fields.code && (
            <Text style={s.errorText}>{errors.fields.code.message}</Text>
          )}
          <Pressable
            style={[s.btn, isLoading && s.btnDisabled]}
            onPress={handleVerify}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={s.btnText}>Verify</Text>
            )}
          </Pressable>
          <Pressable style={s.linkBtn} onPress={() => signIn.mfa.sendEmailCode()}>
            <Text style={s.linkText}>Resend code</Text>
          </Pressable>
          <Pressable style={s.linkBtn} onPress={() => signIn.reset()}>
            <Text style={s.linkText}>Start over</Text>
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
            {errors.fields.identifier && (
              <Text style={s.errorText}>{errors.fields.identifier.message}</Text>
            )}

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
            {errors.fields.password && (
              <Text style={s.errorText}>{errors.fields.password.message}</Text>
            )}

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

            {(errors.global?.length || errors.fields.identifier || errors.fields.password) && (
              <View style={s.errorBanner}>
                <Text style={s.errorBannerText}>
                  {errors.global?.[0]?.message
                    ?? errors.fields.identifier?.message
                    ?? errors.fields.password?.message
                    ?? "Invalid email or password."}
                </Text>
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
