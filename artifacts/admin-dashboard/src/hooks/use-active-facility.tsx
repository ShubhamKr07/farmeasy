import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
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

interface ActiveFacilityContextValue {
  facilities: Facility[];
  isLoading: boolean;
  activeFacilityId: number | null;
  needsPicker: boolean;
  selectFacility: (id: number) => void;
  isAddingFacility: boolean;
  startAddFacility: () => void;
  finishAddFacility: (newFacilityId: number, organizationId: number) => void;
}

const ActiveFacilityContext = createContext<ActiveFacilityContextValue | null>(null);

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
 *
 * This state is provider-hosted (`ActiveFacilityProvider`, mounted once,
 * high in the tree, inside `QueryClientProvider`) rather than owned by each
 * calling component. Previously `FacilityGate` (App.tsx) and
 * `FacilitySwitcher` (TopBar.tsx) each called a standalone hook, giving them
 * two independent `activeFacilityId` React states that could diverge: a
 * selection made in one instance (e.g. the header switcher) had no way to
 * notify the other (e.g. FacilityGate), so FacilityGate could keep routing
 * based on stale state after a switch — most visibly, failing to route into
 * the wizard when the newly-selected facility was un-onboarded. A single
 * shared context fixes that by construction (exactly one source of truth),
 * and gives `selectFacility`/`finishAddFacility` one place to also
 * invalidate the query cache, so switching facilities doesn't leave
 * previously-cached, non-facility-namespaced query data (cycles, inventory,
 * alerts, tasks, readiness, ...) on screen after the switch.
 */
function useActiveFacilityState(): ActiveFacilityContextValue {
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

  // A full invalidateQueries() on every explicit, user-initiated facility
  // switch (not a hot path) is the simple, safe option: no query key in this
  // codebase is facility-namespaced (they're bare paths like `/api/cycles`,
  // `/api/inventory`), so there is no narrower key to target. Without this,
  // a user switching facilities kept seeing the PREVIOUS facility's cached
  // cycles/inventory/alerts/tasks/readiness until some unrelated refetch
  // trigger (window refocus, navigation) happened to fire.
  const selectFacility = (id: number) => {
    localStorage.setItem(STORAGE_KEY, String(id));
    setActiveFacilityId(id);
    setIsAddingFacility(false);
    void queryClient.invalidateQueries();
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

/**
 * Mounts the single, shared active-facility state for the whole app. Must be
 * mounted inside `QueryClientProvider` (it calls `useQueryClient()`
 * internally) and high enough in the tree that every consumer (`FacilityGate`,
 * `FacilitySwitcher`) sits underneath it.
 */
export function ActiveFacilityProvider({ children }: { children: ReactNode }) {
  const value = useActiveFacilityState();
  return <ActiveFacilityContext.Provider value={value}>{children}</ActiveFacilityContext.Provider>;
}

/** Consumes the shared active-facility context. Must be rendered under `ActiveFacilityProvider`. */
export function useActiveFacility(): ActiveFacilityContextValue {
  const ctx = useContext(ActiveFacilityContext);
  if (!ctx) {
    throw new Error("useActiveFacility must be used within ActiveFacilityProvider");
  }
  return ctx;
}
