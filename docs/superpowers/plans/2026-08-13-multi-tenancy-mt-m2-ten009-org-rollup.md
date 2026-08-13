# TEN-009 — Org Rollup Stubs — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** A minimal, owner/admin, org-scoped `GET /api/org/summary` returning `{ facilityCount, activeCycles, openAlerts }` aggregated across the org's facilities (via a per-facility `withTenantScope` loop — no new RLS), plus a stub Org-Overview UI card.

**Spec:** `docs/superpowers/specs/2026-08-13-multi-tenancy-mt-m2-ten009-org-rollup-design.md`.

## Global Constraints
- **No migration, no schema, no new RLS.** Purely an additive read endpoint + UI over existing tables/policies.
- **Org-scoped read, no `X-Facility-Id`** — org resolved server-side from the caller's active membership (never client input). Gate = `requireSignedIn` + an owner/admin check folded into the org-resolution query (`getManagementOrg`). **NOTE (corrected at build):** the original draft used `requireRole("owner","admin")` as a per-route arg, but `middlewares/requireRole.ts` reads `req.tenant?.role`, which `resolveTenantContext` only populates when `X-Facility-Id` is present — and this route deliberately has none, so it would 403 every caller. Gate via `getManagementOrg` (resolves org + enforces owner/admin in one `organization_members` query) instead.
- **Aggregate via the per-facility loop:** resolve the org's facilities, then `withTenantScope({organizationId, facilityId})` per facility to count under the existing facility-GUC RLS, and sum. Empty org → zeros.
- Prove under the real `farmsmart_app` role (disposable stack). Branch `ten009-org-rollup` off `origin/main`. PR into `main`.

---

### Task 1: `GET /org/summary` endpoint + guard baseline
**Files:** Create `artifacts/api-server/src/routes/org.ts`; Create `artifacts/api-server/src/tests/routes/org.test.ts`; Modify `artifacts/api-server/src/app.ts` (mount) + `scripts/ci/check-tenant-scope.mjs` (baseline the org-membership read).

**Interfaces:**
- Produces: `GET /api/org/summary` → `200 { facilityCount: number; activeCycles: number; openAlerts: number }`; `403` for non-owner/admin (role gate) or no active membership.

- [ ] **Step 1: Write failing tests** (`src/tests/routes/org.test.ts`, `node:test`, DB-backed, disposable stack — follow `demo.test.ts`/`cross-tenant.test.ts` patterns). Seed org A (owner) with 2 facilities, distinct known active cycles (`status <> 'completed'`) + current alerts (`status='current'`) per facility; seed org B separately. Cases:
  - owner of A → 200, `facilityCount=2`, `activeCycles`/`openAlerts` = the correct A-only sums (never counting B);
  - a technician / non-owner-admin member → 403;
  - no active membership → 403;
  - a zero-facility org → `{0,0,0}`.

- [ ] **Step 2: Run to confirm fail** — `pnpm --filter @workspace/api-server run test 2>&1 | grep -A3 "org/summary"` → FAIL (route not mounted).

- [ ] **Step 3: Implement `routes/org.ts`:**
```ts
import { Router, type Request, type Response } from "express";
import { and, eq, ne, inArray, count } from "drizzle-orm";
import { db, withTenantScope, organizationMembersTable, facilitiesTable, cyclesTable, alertsTable } from "@workspace/db";
import { getAuth } from "../middlewares/supabaseAuth";

const router = Router();

// Resolve the caller's active org AND enforce the owner/admin gate in one
// organization_members query — do NOT use middlewares/requireRole (it reads
// req.tenant?.role, only set when X-Facility-Id is present; this route has
// none, so requireRole would 403 everyone). Org-scoped, server-side, never
// client input. Mirrors demo.ts's getOwnerOrg, extended to admit "admin".
async function getManagementOrg(userId: string): Promise<number | null> {
  const [m] = await db
    .select({ organizationId: organizationMembersTable.organizationId })
    .from(organizationMembersTable)
    .where(and(
      eq(organizationMembersTable.userId, userId),
      eq(organizationMembersTable.status, "active"),
      inArray(organizationMembersTable.role, ["owner", "admin"]),
    ))
    .limit(1);
  return m?.organizationId ?? null;
}

// GET /org/summary — owner/admin org rollup stub. Gate is getManagementOrg
// above (org-resolution + role in one query). Self-contained (no router.use),
// so tier-1-safe. Aggregates across the org's facilities via a per-facility
// withTenantScope loop under the facility-GUC RLS (00007).
router.get("/org/summary", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const organizationId = await getManagementOrg(userId);
    // Both "no membership" and "non-owner/admin member" collapse to 403.
    if (!organizationId) return res.status(403).json({ error: "Forbidden for this role", code: "ROLE_FORBIDDEN" });

    const facilities = await db
      .select({ id: facilitiesTable.id })
      .from(facilitiesTable)
      .where(eq(facilitiesTable.organizationId, organizationId));

    let activeCycles = 0;
    let openAlerts = 0;
    for (const f of facilities) {
      const [c, a] = await withTenantScope({ organizationId, facilityId: f.id }, async (tx) => {
        // Explicit facilityId filter ALONGSIDE the RLS scope — never rely on
        // RLS alone (the disposable test stack connects as postgres/BYPASSRLS,
        // so RLS-only counts leak into a whole-DB count). Matches alerts.ts.
        const [{ n: cyc }] = await tx.select({ n: count() }).from(cyclesTable)
          .where(and(eq(cyclesTable.facilityId, f.id), ne(cyclesTable.status, "completed")));
        const [{ n: alr }] = await tx.select({ n: count() }).from(alertsTable)
          .where(and(eq(alertsTable.facilityId, f.id), eq(alertsTable.status, "current")));
        return [Number(cyc), Number(alr)] as const;
      });
      activeCycles += c;
      openAlerts += a;
    }

    return res.status(200).json({ facilityCount: facilities.length, activeCycles, openAlerts });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to compute org summary" });
  }
});

export default router;
```
(Confirm the `cycle_status` enum: `status <> 'completed'` = active. If the enum has other terminal states, adjust to `notInArray(status, [<terminal>])` — pin against `lib/db/src/schema/index.ts`.)

- [ ] **Step 4: Mount in `app.ts`** — import `orgRouter` and add to the **tier-1** block (per-route gated, no `requireTenantContext`; the `requireRole` is a per-route arg inside the router, so it can't intercept other routers): `app.use("/api", requireSignedIn, orgRouter);`

- [ ] **Step 5: Guard.** Run `node scripts/ci/check-tenant-scope.mjs`. (At build the guard came back clean with no new baseline entry needed for `getManagementOrg`'s `organization_members` read — verify the same; only add a baselined bootstrap exception if the guard actually flags it.)

- [ ] **Step 6: Run tests** via the disposable stack — `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -60` (`--ignore-health-check`/alt-ports if 54322 held — don't touch un-owned containers). All org tests pass (aggregate correctness, role gate, cross-tenant, zero-facility). `pnpm run typecheck` clean. Commit `feat(api): GET /org/summary org rollup stub (TEN-009)`.

### Task 2: OpenAPI + orval codegen
**Files:** modify `lib/api-spec/openapi.yaml`; regenerated `lib/api-client-react`/`lib/api-zod`.

- [ ] **Step 1:** Add `GET /org/summary` → `OrgSummary { facilityCount: integer, activeCycles: integer, openAlerts: integer }`, matching the existing entry style (tags, operationId `getOrgSummary`, no `security` block — middleware-enforced).
- [ ] **Step 2:** Run the codegen script (`pnpm --filter @workspace/api-spec run codegen` — confirm name). Never hand-edit `generated/`. Report the emitted hook name (expected `useGetOrgSummary`/`getOrgSummary`).
- [ ] **Step 3:** `pnpm run typecheck` clean. Commit `feat(api-spec): org/summary endpoint + codegen (TEN-009)`.

### Task 3: Org Overview UI stub (web, owner/admin)
**Files:** Create `artifacts/admin-dashboard/src/pages/org-overview/OrgOverview.tsx`; modify `App.tsx` (route) + the nav/layout to add an owner/admin-only entry.

- [ ] **Step 1:** `OrgOverview.tsx` — a simple page: three stat cards (Facilities / Active Cycles / Open Alerts) from `useGetOrgSummary()`, a heading framing it as the org rollup, and a muted "More org analytics coming soon" placeholder. Handle loading/empty. Match the dashboard's existing card/stat styling.
- [ ] **Step 2:** Add a route (e.g. `/org`) in `App.tsx`'s `Router` and a nav entry in `AppLayout` gated on `useOrgRole()` role ∈ {owner, admin} (mirror how other role-gated UI hides). Web only; do NOT touch mobile.
- [ ] **Step 3:** `pnpm --filter <admin-dashboard pkg> run typecheck` + build clean. Consider delegating the component scaffold to GLM (frontend-engineer pattern) but review the role-gating + hook wiring. Commit `feat(dashboard): org overview stub (TEN-009)`.

### Task 4: whole-feature verification + PR
- [ ] **Step 1:** `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -60` — api-server suite green incl. the org tests; pgTAP green (unchanged). `pnpm run typecheck` clean (whole workspace).
- [ ] **Step 2:** Push `ten009-org-rollup`; PR into `main` titled `feat: org rollup stubs — GET /org/summary + org overview (TEN-009, MT-M2 5/5)`; body = the stub scope, the org-scoped per-facility-loop tenancy, owner/admin gate, cross-tenant proof, and that this closes MT-M2's 5th/final sub-project. CI `database-integration` gate.
- [ ] **Step 3: security-compliance attests** — cross-tenant isolation (A's summary excludes B; the per-facility loop + org `WHERE` scope it), the role gate holds (owner/admin only), the org-membership read is a legitimate baselined bootstrap. ATTEST to merge.

## Rollback
Remove `routes/org.ts` + its mount + the guard baseline; remove the OrgOverview UI + route/nav; revert the OpenAPI/codegen. No migration/schema/RLS to reverse.

## Self-review
- Spec coverage: endpoint + org-scoped loop (T1), contract (T2), UI stub (T3), tests incl. cross-tenant + role gate (T1/T4) — mapped.
- No new RLS/migration (design's core constraint).
- Active-cycle/alert defs pinned against the enums at build.
