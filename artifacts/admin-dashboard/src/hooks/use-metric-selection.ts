import { useCallback, useEffect, useRef, useState } from "react";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { useGetUserSettings, usePutUserSetting, getGetUserSettingsQueryKey } from "@workspace/api-client-react";
import {
  type MetricDef,
  type MetricTab,
  defaultKeysForTab,
  metricsForTab,
} from "@workspace/metrics";

/**
 * Per-tab metric selection (and card order — array order = display order),
 * persisted via GET/PUT /api/users/me/settings (M4). localStorage is kept as
 * an instant-write cache so toggles/reorders feel immediate while the API
 * call is in flight, and as a fallback if the user is signed out or the API
 * request fails.
 */
export function useMetricSelection(tab: MetricTab) {
  const { session, loading } = useSupabaseSession();
  const uid = session?.user.id ?? "anon";
  const storageKey = `farmsmart.metrics.${tab}.${uid}`;
  const settingsKey = `farmsmart.metrics.${tab}`;

  /**
   * Metrics visible in this tab's picker.
   * - Tier A (dashboard/alerts/shipments/inventory): always selectable.
   * - Tier B (metrics): selectable once it has a query template (`template` +
   *   `templateParams`). Tier-B entries without a template are deferred to a
   *   later phase (custom query) and hidden.
   */
  const selectable: MetricDef[] = metricsForTab(tab).filter(
    (m) => m.source !== "metrics" || (m.template && m.templateParams),
  );

  const [selected, setSelected] = useState<string[]>(() =>
    defaultKeysForTab(tab),
  );
  const hydratedRef = useRef(false);

  const { data: remote, isSuccess: remoteLoaded } = useGetUserSettings({
    query: { enabled: !loading && !!session, queryKey: getGetUserSettingsQueryKey() },
  });
  const putSetting = usePutUserSetting();

  const validIds = useCallback(
    (ids: unknown): string[] => {
      if (!Array.isArray(ids)) return defaultKeysForTab(tab);
      const valid = new Set(selectable.map((m) => m.id));
      return (ids as string[]).filter((id) => valid.has(id));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, selectable.length],
  );

  // Hydrate: prefer the server value once loaded; fall back to localStorage
  // (covers signed-out/offline and the brief window before the server responds).
  useEffect(() => {
    if (loading) return;
    if (hydratedRef.current) return;

    if (session && remoteLoaded) {
      const serverValue = remote?.settings?.[settingsKey];
      if (serverValue !== undefined) {
        setSelected(validIds(serverValue));
        hydratedRef.current = true;
        return;
      }
    }

    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        setSelected(validIds(JSON.parse(raw)));
      } else {
        setSelected(defaultKeysForTab(tab));
      }
    } catch {
      setSelected(defaultKeysForTab(tab));
    }
    if (!session || remoteLoaded) hydratedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, session, remoteLoaded, remote, storageKey, settingsKey, tab, validIds]);

  const persist = useCallback(
    (next: string[]) => {
      setSelected(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* ignore quota / private-mode errors */
      }
      if (session) {
        putSetting.mutate({ key: settingsKey, data: { value: next } });
      }
    },
    [storageKey, settingsKey, session, putSetting],
  );

  const toggle = useCallback(
    (id: string) => {
      setSelected((cur) => {
        const next = cur.includes(id)
          ? cur.filter((x) => x !== id)
          : [...cur, id];
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        if (session) {
          putSetting.mutate({ key: settingsKey, data: { value: next } });
        }
        return next;
      });
    },
    [storageKey, settingsKey, session, putSetting],
  );

  const reorder = useCallback(
    (next: string[]) => {
      persist(next);
    },
    [persist],
  );

  const reset = useCallback(() => {
    persist(defaultKeysForTab(tab));
  }, [persist, tab]);

  return { selected, selectable, toggle, reorder, reset };
}
