import React, { createContext, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import { useListFacilities, setFacilityId, type Facility } from "@workspace/api-client-react";

const STORAGE_KEY = "farmsmart:activeFacilityId";

interface ActiveFacilityContextValue {
  facilities: Facility[];
  isLoading: boolean;
  activeFacilityId: number | null;
  needsPicker: boolean;
  selectFacility: (id: number) => void;
}

const ActiveFacilityContext = createContext<ActiveFacilityContextValue | null>(null);

/**
 * Mobile's facility resolution — same 0/1/2+ rule as admin-dashboard's
 * useActiveFacility (web), persisted via AsyncStorage instead of
 * localStorage. Deliberately has NO add-facility affordance: technicians
 * authenticate on mobile only and, by design, never create facilities or
 * run the onboarding wizard here (TEN-008 design doc §3a) — a facility
 * switched to on mobile must already exist. Switching is a pure client-side
 * selection change, re-validated per request by the API server's
 * resolveTenantContext; there is no separate "check access" step to build.
 *
 * This state is provider-hosted (a sibling to AppShellContext, not merged
 * into it — active-facility state has different mount-timing needs than the
 * hamburger-menu's open/close flag: it must be available BEFORE
 * AuthedTabLayout decides whether to render the facility picker or
 * TabShell, while AppShellProvider only ever wraps TabShell) so there's
 * exactly one source of truth for `activeFacilityId`/`needsPicker`, shared
 * by `AuthedTabLayout` and `FacilitySwitcherSheet` instead of each owning an
 * independent copy that could diverge.
 */
function useActiveFacilityState(): ActiveFacilityContextValue {
  const queryClient = useQueryClient();
  const { data: facilities, isLoading } = useListFacilities();
  const [activeFacilityId, setActiveFacilityId] = useState<number | null>(null);
  const [needsPicker, setNeedsPicker] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      const parsed = raw ? Number(raw) : NaN;
      setActiveFacilityId(Number.isInteger(parsed) && parsed > 0 ? parsed : null);
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!hydrated || !facilities) return;
    if (facilities.length === 0) {
      setActiveFacilityId(null);
      setNeedsPicker(false);
      return;
    }
    if (facilities.length === 1) {
      setActiveFacilityId(facilities[0]!.id);
      setNeedsPicker(false);
      return;
    }
    const stillValid = activeFacilityId !== null && facilities.some((f) => f.id === activeFacilityId);
    setNeedsPicker(!stillValid);
  }, [facilities, hydrated]);

  useEffect(() => {
    setFacilityId(activeFacilityId);
  }, [activeFacilityId]);

  // Mirrors admin-dashboard's selectFacility: a full invalidateQueries() on
  // every explicit, user-initiated facility switch (not a hot path) is the
  // simple, safe option — no query key in this codebase is
  // facility-namespaced, so there's no narrower key to target. Without this,
  // a user switching facilities kept seeing the PREVIOUS facility's cached
  // cycles/inventory/alerts/tasks/readiness until some unrelated refetch
  // trigger happened to fire.
  const selectFacility = (id: number) => {
    AsyncStorage.setItem(STORAGE_KEY, String(id));
    setActiveFacilityId(id);
    setNeedsPicker(false);
    void queryClient.invalidateQueries();
  };

  return {
    facilities: facilities ?? [],
    isLoading: isLoading || !hydrated,
    activeFacilityId,
    needsPicker,
    selectFacility,
  };
}

/**
 * Mounts the single, shared active-facility state. Must be mounted inside
 * `QueryClientProvider` (it calls `useQueryClient()` internally) and above
 * both `AuthedTabLayout` and `FacilitySwitcherSheet` in the tree — see
 * `app/(tabs)/_layout.tsx`, which wraps `AuthedTabLayout` itself (not just
 * `TabShell`) so the facility-picker branch also has access.
 */
export function ActiveFacilityProvider({ children }: { children: React.ReactNode }) {
  const value = useActiveFacilityState();
  return <ActiveFacilityContext.Provider value={value}>{children}</ActiveFacilityContext.Provider>;
}

export function useActiveFacility(): ActiveFacilityContextValue {
  const ctx = useContext(ActiveFacilityContext);
  if (!ctx) throw new Error("useActiveFacility must be used within ActiveFacilityProvider");
  return ctx;
}
