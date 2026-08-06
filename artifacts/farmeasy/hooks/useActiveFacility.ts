import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useListFacilities, setFacilityId } from "@workspace/api-client-react";

const STORAGE_KEY = "farmsmart:activeFacilityId";

/**
 * Mobile's facility resolution — same 0/1/2+ rule as admin-dashboard's
 * useActiveFacility (web), persisted via AsyncStorage instead of
 * localStorage. Deliberately has NO add-facility affordance: technicians
 * authenticate on mobile only and, by design, never create facilities or
 * run the onboarding wizard here (TEN-008 design doc §3a) — a facility
 * switched to on mobile must already exist. Switching is a pure client-side
 * selection change, re-validated per request by the API server's
 * resolveTenantContext; there is no separate "check access" step to build.
 */
export function useActiveFacility() {
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

  const selectFacility = (id: number) => {
    AsyncStorage.setItem(STORAGE_KEY, String(id));
    setActiveFacilityId(id);
    setNeedsPicker(false);
  };

  return { facilities: facilities ?? [], isLoading: isLoading || !hydrated, activeFacilityId, needsPicker, selectFacility };
}
