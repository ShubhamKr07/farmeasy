import type { Session } from "@supabase/supabase-js";
import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Redirect, Tabs } from "expo-router";
import { Icon, Label, NativeTabs } from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import { Platform, StyleSheet, View, useColorScheme } from "react-native";
import { setAuthTokenGetter } from "@workspace/api-client-react";

import { supabase } from "@/lib/supabase";
import { useColors } from "@/hooks/useColors";
import { useUserRole } from "@/hooks/useUserRole";
import { useSignOutAndClear } from "@/hooks/useSignOutAndClear";
import { useActiveFacility } from "@/hooks/useActiveFacility";
import { AppShellProvider, useAppShell } from "@/context/AppShellContext";
import AskMeFab from "@/components/AskMeFab";
import HamburgerMenu from "@/components/HamburgerMenu";
import { FacilityPickerScreen } from "@/components/FacilityPickerScreen";

function NativeTabBar() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: "house", selected: "house.fill" }} />
        <Label>Home</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="cycles">
        <Icon sf={{ default: "leaf", selected: "leaf.fill" }} />
        <Label>Cycles</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="scan">
        <Icon sf={{ default: "qrcode.viewfinder", selected: "qrcode.viewfinder" }} />
        <Label>Scan</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function ClassicTabBar() {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: "absolute",
          backgroundColor: isIOS ? "transparent" : colors.background,
          borderTopWidth: isWeb ? 1 : 0,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={100}
              tint={isDark ? "dark" : "light"}
              style={StyleSheet.absoluteFill}
            />
          ) : isWeb ? (
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: colors.background },
              ]}
            />
          ) : null,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="house" tintColor={color} size={24} />
            ) : (
              <Feather name="home" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="cycles"
        options={{
          title: "Cycles",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="leaf" tintColor={color} size={24} />
            ) : (
              <Feather name="list" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="scan"
        options={{
          title: "Scan",
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="qrcode.viewfinder" tintColor={color} size={24} />
            ) : (
              <Feather name="maximize" size={22} color={color} />
            ),
        }}
      />
    </Tabs>
  );
}

function AppShellHamburger() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => listener.subscription.unsubscribe();
  }, []);

  const { label: roleLabel } = useUserRole();
  const signOut = useSignOutAndClear();
  const { menuOpen, closeMenu } = useAppShell();

  const email = session?.user?.email;
  const fullName =
    (session?.user?.user_metadata?.full_name as string | undefined) ??
    (session?.user?.user_metadata?.name as string | undefined);
  const displayName = fullName ?? email?.split("@")[0] ?? "Technician";
  const userInitial = (fullName?.[0] ?? email?.[0] ?? "T").toUpperCase();

  return (
    <HamburgerMenu
      open={menuOpen}
      onClose={closeMenu}
      userName={displayName}
      userInitial={userInitial}
      roleLabel={roleLabel}
      onSignOut={() => {
        closeMenu();
        signOut();
      }}
    />
  );
}

function TabShell() {
  return (
    <View style={{ flex: 1 }}>
      {isLiquidGlassAvailable() ? <NativeTabBar /> : <ClassicTabBar />}
      <AskMeFab />
      <AppShellHamburger />
    </View>
  );
}

/**
 * TEN-008: `useActiveFacility()` lives here — a child mounted only once
 * `TabLayout` has confirmed a session — rather than at `TabLayout`'s own
 * top level. Mirrors admin-dashboard's `App.tsx`, where the equivalent hook
 * is only ever called inside `FacilityGate`, itself only rendered after
 * `AuthGate` confirms `session`. Calling it any earlier would mount the
 * facilities query before the Supabase auth-token getter is wired up,
 * sending the first request out unauthenticated.
 */
function AuthedTabLayout() {
  const { facilities, needsPicker, selectFacility } = useActiveFacility();

  if (needsPicker) {
    return <FacilityPickerScreen facilities={facilities} onSelect={selectFacility} />;
  }

  return (
    <AppShellProvider>
      <TabShell />
    </AppShellProvider>
  );
}

export default function TabLayout() {
  const [session, setSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoaded(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    setAuthTokenGetter(() =>
      supabase.auth.getSession().then(({ data }) => data.session?.access_token ?? null),
    );
  }, []);

  if (!loaded) return null;
  if (!session) {
    return <Redirect href="/sign-in" />;
  }

  return <AuthedTabLayout />;
}
