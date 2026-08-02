import { useEffect, useState } from "react";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { useGetUserSettings, usePutUserSetting } from "@workspace/api-client-react";

const SETTINGS_KEY = "farmsmart.farmReadiness.collapsed";

/**
 * Collapse state for the Farm Readiness card (dashboard mode only), persisted
 * via GET/PUT /api/users/me/settings (same M4 settings mechanism as
 * `useMetricSelection`). localStorage is kept as an instant-write cache/
 * signed-out fallback, matching that hook's hydrate pattern exactly.
 */
export function useFarmReadinessCollapsed() {
  const { session, loading } = useSupabaseSession();
  const uid = session?.user.id ?? "anon";
  const storageKey = `farmsmart.farmReadiness.collapsed.${uid}`;
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(storageKey) === "true");
  const { data: remote, isSuccess } = useGetUserSettings({ query: { enabled: !loading && !!session } });
  const putSetting = usePutUserSetting();

  useEffect(() => {
    // useGetUserSettings() returns { settings: {...} }, not a bare map —
    // read through .settings, matching use-metric-selection.ts's real,
    // already-shipped accessor pattern.
    if (isSuccess && remote?.settings?.[SETTINGS_KEY] !== undefined) {
      setCollapsed(Boolean(remote.settings[SETTINGS_KEY]));
    }
  }, [isSuccess, remote]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(storageKey, String(next));
    putSetting.mutate({ key: SETTINGS_KEY, data: { value: next } });
  };

  return { collapsed, toggle };
}
