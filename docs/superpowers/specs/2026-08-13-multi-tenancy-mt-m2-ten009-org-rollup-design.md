# TEN-009 — Org Rollup Stubs (design)

**Scope of this document:** the **fifth and final** sub-project decomposed out of MT-M2 ("Multi-facility + front door": TEN-008, TEN-010 rev.B, TEN-012, TEN-013, **TEN-009**). TEN-008/010/012/013 have shipped. This covers **TEN-009 only** — a *minimal* org-level rollup **stub**: one owner/admin, org-scoped summary endpoint aggregating high-level counts across the org's facilities, plus a basic org-overview UI placeholder. It deliberately does **not** build real org analytics (trends/charts/per-facility breakdown) — that's a future initiative; TEN-009 is the scaffolding + the org-scoped read pattern.

## Product decisions (locked during brainstorming)
1. **Minimal stub, not a dashboard.** One summary endpoint + a placeholder org-overview surface. Real analytics deferred.
2. **Owner/admin only.** The org-level view is a management concern; technicians are facility-scoped (mobile-only per TEN-010).
3. **Org-scoped read** (no `X-Facility-Id`). Aggregates across the caller's org — a new org-scoped read path, org resolved server-side from the caller's active owner/admin membership (same pattern as `demo.ts`'s `getOwnerOrg`).
4. **App-layer loop per facility** for the aggregation — **no new RLS policies.** Reuse the existing facility-GUC RLS by iterating `withTenantScope(facility)` per facility and summing.
5. **Aggregate set:** `facilityCount`, `activeCycles`, `openAlerts`.

## Architecture / flow

**`GET /api/org/summary`** — authed, **owner/admin-gated**, org-scoped. Returns:
```json
{ "facilityCount": 3, "activeCycles": 12, "openAlerts": 2 }
```

- **Gating:** `requireSignedIn` + `requireRole("owner","admin")`. **NOT** `requireTenantContext` — there is no active facility for an org-wide read (like the demo endpoints, it resolves the org itself and needs no `X-Facility-Id`). Mount per-route/self-gated in tier 1 (org-resolved, no app.ts tenant wrap).
- **Org resolution:** resolve the caller's active `owner`/`admin` membership org server-side (never client input) — reuse/mirror `demo.ts`'s `getOwnerOrg` (extend it to admit `admin` too, or a sibling `getManagementOrg`).
- **Aggregation (org-scoped, via the per-facility loop):**
  1. Resolve the org's facilities: `SELECT id FROM facilities WHERE organization_id = <resolvedOrg>` (facilities' RLS is the `current_user='farmsmart_app'` backstop from Batch 1 — admits the backend; the app-layer `WHERE organization_id` is the scope). → `facilityCount = rows.length`.
  2. For each facility, `withTenantScope({ organizationId, facilityId }, tx =>` count **active cycles** (`cycles WHERE status <> 'completed'`) + **open alerts** (`alerts WHERE status = 'current'`)`)` — these run under the facility-GUC RLS (`00007`), so each count is correctly scoped to that facility. Sum across facilities → `activeCycles`, `openAlerts`.
  3. Empty org (no facilities) → `{ facilityCount: 0, activeCycles: 0, openAlerts: 0 }`.
- No new migration, no new RLS, no schema change — purely a read endpoint over existing tables using existing policies.

## UI (web dashboard)
- A simple **Org Overview** surface (owner/admin only) — a card/section showing the three counts (facilities / active cycles / open alerts), with copy framing it as a high-level org rollup and a clear "more org analytics coming" placeholder. Nav entry visible only to owner/admin (reuse `useOrgRole`).
- Consumes the generated `useGetOrgSummary` hook (orval). Web only.

## Contract
- Add `GET /org/summary` → `OrgSummary { facilityCount, activeCycles, openAlerts }` to `lib/api-spec/openapi.yaml`; regenerate client + zod (orval), matching the existing pattern. No `security` block (middleware-enforced, per repo convention).

## Testing
- **Aggregate correctness:** an org with N facilities, seeded with known active cycles + current alerts per facility, returns the correct sums + `facilityCount = N`. Zero-facility org → all zeros.
- **Role gate:** technician and non-owner/admin members → 403 (`ROLE_FORBIDDEN`); no active membership → 403; a member with no management role can't read it.
- **Cross-tenant isolation:** org A's summary counts ONLY A's facilities/cycles/alerts, never B's — end-state, under the real `farmsmart_app` role (the per-facility `withTenantScope` + the facilities `WHERE organization_id` both scope it; assert B's data is excluded).
- Runs under the disposable stack (real role); node:test.

## Rollback points
- Purely additive: an endpoint + UI + generated client. Rollback = remove the route + UI + revert the OpenAPI/codegen. No migration/schema/RLS to reverse.

## Out of scope (YAGNI)
- Real org analytics — yield/throughput trends, charts, time-series, per-facility breakdown table (the loop already yields per-facility numbers; exposing them is a trivial future extension, but out of the stub).
- Mobile org-overview (web only; mobile entry is TEN-014's territory).
- Org-level facility switcher / multi-org (out of the whole MT-M2 model).
- Caching / performance work — the per-facility loop is O(facilities); orgs have few facilities today, so N small counts is acceptable. Revisit only if orgs grow large (deferred, noted as a risk).

## Risks / open items for the plan
- **Loop cost:** `GET /org/summary` issues ~1 + N small COUNT queries (N = facilities). Fine for today's small orgs; if a single org ever holds many facilities, revisit (batch via an org-scoped RLS policy or a single grouped query) — explicitly deferred.
- **Management-role resolution:** confirm whether to extend `demo.ts`'s `getOwnerOrg` (owner-only) or add a sibling that admits `owner`+`admin`. The plan pins the exact helper + that `requireRole("owner","admin")` is the gate.
- **Active-cycle definition:** confirm `status <> 'completed'` is the intended "active" set (vs an explicit `IN ('germination','fertigation')`) against the `cycle_status` enum — pin in the plan.
