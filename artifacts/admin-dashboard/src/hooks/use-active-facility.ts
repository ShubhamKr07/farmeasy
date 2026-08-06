import { useEffect, useState } from "react";
import { useListFacilities } from "@workspace/api-client-react";
import { setFacilityId } from "@workspace/api-client-react";

const STORAGE_KEY = "farmsmart:activeFacilityId";

function readPersisted(): number | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolves and persists the active facility (TEN-008). Three cases, in
 * order:
 *   - 0 facilities: activeFacilityId stays null (the wizard gate handles
 *     first-time onboarding — this hook has nothing to pick from yet).
 *   - Exactly 1 facility: auto-selected silently, no picker ever shown
 *     (matches the design's "switcher hidden entirely for single-facility
 *     orgs").
 *   - 2+ facilities: uses the persisted selection if it's still one of the
 *     org's real facility ids; otherwise `needsPicker` is true and the
 *     caller (FacilityGate) must render an explicit picker before
 *     proceeding — never silently guesses which facility the user meant.
 *
 * `isAddingFacility`/`startAddFacility` are a separate, explicit flag (not
 * overloaded onto `activeFacilityId === null`, which already means "no
 * facilities yet" or "ambiguous, needs picker") — set when the user taps
 * "Add facility," consumed by FacilityGate to render the wizard for a
 * brand-new facility instead of the active one.
 */
export function useActiveFacility() {
  const { data: facilities, isLoading } = useListFacilities();
  const [activeFacilityId, setActiveFacilityId] = useState<number | null>(readPersisted());
  const [isAddingFacility, setIsAddingFacility] = useState(false);

  useEffect(() => {
    if (!facilities) return;
    if (facilities.length === 0) {
      setActiveFacilityId(null);
      return;
    }
    if (facilities.length === 1) {
      setActiveFacilityId(facilities[0]!.id);
      return;
    }
    const persisted = readPersisted();
    const stillValid = persisted !== null && facilities.some((f) => f.id === persisted);
    setActiveFacilityId(stillValid ? persisted : null);
  }, [facilities]);

  useEffect(() => {
    setFacilityId(activeFacilityId);
  }, [activeFacilityId]);

  const selectFacility = (id: number) => {
    localStorage.setItem(STORAGE_KEY, String(id));
    setActiveFacilityId(id);
    setIsAddingFacility(false);
  };

  const startAddFacility = () => setIsAddingFacility(true);
  const finishAddFacility = (newFacilityId: number) => {
    setIsAddingFacility(false);
    selectFacility(newFacilityId);
  };

  const needsPicker =
    !isLoading && !isAddingFacility && (facilities?.length ?? 0) > 1 && activeFacilityId === null;

  return {
    facilities: facilities ?? [],
    isLoading,
    activeFacilityId,
    needsPicker,
    selectFacility,
    isAddingFacility,
    startAddFacility,
    finishAddFacility,
  };
}
