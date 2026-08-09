import { useGetDemoStatus } from "@workspace/api-client-react";

/**
 * Thin wrapper over the generated `useGetDemoStatus()` query (TEN-013 Task 9)
 * that flattens the raw query result into the small shape every demo-fork
 * caller (the W2 fork screen, the app-wide demo banner) actually needs, and
 * collapses the "still resolving" case into a single `isLoading` flag the
 * same way `use-org-role.ts` does for the org-role claim.
 *
 * The underlying endpoint is `GET /api/demo/status`, returning
 * `DemoStatus { enabled; isDemo; demoFacilityId }`:
 *  - `enabled` — the server-side `DEMO_FORK_ENABLED` feature flag. When false,
 *    the fork is suppressed entirely: `Wizard` skips the fork step and the
 *    banner never renders, regardless of the other fields.
 *  - `isDemo` — whether the caller's OWN org is currently in demo mode
 *    (orgs.is_demo = true). Drives the persistent "explore a demo" banner.
 *  - `demoFacilityId` — null unless `isDemo` is true; the seeded demo facility.
 *
 * `isLoading` is the TanStack Query `isLoading` (true only on the very first
 * fetch before any data is cached, never flipped back on by a later
 * background refetch), so callers can gate a one-time decision like "show
 * the fork pre-step" without flapping on every refocus. All four fields are
 * safe to read while loading: they fall back to `false`/`null`, which the
 * fork gate treats as "don't show the fork" and the banner treats as
 * "self-hide" — never a privileged default.
 */
export function useDemoStatus(): {
  enabled: boolean;
  isDemo: boolean;
  demoFacilityId: number | null;
  isLoading: boolean;
} {
  const { data, isLoading } = useGetDemoStatus();
  return {
    enabled: data?.enabled ?? false,
    isDemo: data?.isDemo ?? false,
    demoFacilityId: data?.demoFacilityId ?? null,
    isLoading,
  };
}
