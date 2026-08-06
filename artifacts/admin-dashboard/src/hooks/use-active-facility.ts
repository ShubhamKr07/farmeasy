import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListFacilities, getListFacilitiesQueryKey, FacilityUnits, type Facility } from "@workspace/api-client-react";
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
  const queryClient = useQueryClient();
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

  // Called the instant `POST /facilities` resolves (FarmBasics.tsx's
  // onSaved, via Wizard.tsx), in the same render batch as advancing the
  // wizard to the next step. `useListFacilities`'s cache is still the
  // pre-creation list at this point — invalidateQueries would only trigger
  // an async background refetch that resolves in a LATER render, so
  // FacilityGate would still fail `facilities.find(f => f.id === newId)` on
  // THIS render and fall through to <Router/>, unmounting the wizard before
  // the refetch ever lands. Instead, write the new facility into the cache
  // synchronously (React 18 batches this setQueryData-driven update together
  // with the selectFacility state updates below into one render), so
  // FacilityGate's very next render already sees it. Only `id` and
  // `onboarded` matter for FacilityGate's own routing logic; the display
  // fields are blank placeholders until the next real `useListFacilities`
  // refetch (e.g. a later cache invalidation elsewhere) fills them in — an
  // acceptable transient gap since nothing renders this facility's name
  // before then.
  const finishAddFacility = (newFacilityId: number, organizationId: number) => {
    queryClient.setQueryData<Facility[]>(getListFacilitiesQueryKey(), (old) => {
      if (old?.some((f) => f.id === newFacilityId)) return old;
      const placeholder: Facility = {
        id: newFacilityId,
        organizationId,
        name: "",
        facilityName: "",
        timezone: "",
        units: FacilityUnits.metric,
        currency: "",
        onboarded: false,
      };
      return [...(old ?? []), placeholder];
    });
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
