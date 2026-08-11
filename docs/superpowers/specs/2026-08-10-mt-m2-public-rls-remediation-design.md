# MT-M2 Public-RLS Remediation — Design

**Status:** design (rescoped 2026-08-11). Branch `mt-m2-public-rls-remediation-design`.
**Relates to:** [[rls-public-tables-remediation]], [[rls-positive-invariant-practice]]. Follows TEN-013 (which deferred `facilities` here).

## Scope (corrected)

The authoritative source is the Supabase advisor (`rls_disabled_in_public`) + a `pg_class.relrowsecurity=false` enumeration of `public` base tables — **NOT** a schema grep (an earlier grep under-counted the schema's 36 tables as 16 and mis-scoped this to 6; corrected via [[verify-assumptions-before-acting]]).

**15 public tables lacked RLS.** Disposition:
- **`facilities` — DONE:** Batch 1, PR #35 merged 2026-08-11, security-attested (`current_user` model; see migration `00020`).
- **`recommender_cache`, `recommender_queries` — deferred to task #5** (`farmsmart_recommender` read-scoped role) — their RLS is decided alongside the recommender's DB access model, not here.
- **12 remain in THIS remediation** (below).

## Decision (2026-08-11): policy model = `current_user` backend policies (Option A)

After an impact analysis of `current_user` backend policies vs denormalizing `facility_id` (see the earlier Q&A / this session's analysis), **Option A chosen** for all backend-accessed, no-tenant-column tables. Summary of why:

- All 10 are **exclusively backend-accessed** (no PostgREST/`anon`/`authenticated` data grants) and hold **low-sensitivity structural/operational data** (layout positions, sensor readings, tray-QA rows, stock deltas, a junction, per-user UI prefs).
- `current_user='farmsmart_app'` policies close the advisor's actual threat (non-backend access + a future stray `GRANT`) with **zero runtime/rollout risk**, match the entire existing backend-RLS model (facilities/organizations/org_members/invitations/signup) + the original [[rls-public-tables-remediation]] plan, and add **no schema change**.
- Denormalizing `facility_id` (~24 expand→backfill→contract migrations + live-backfill + bootstrap-breakage risk) buys only marginal extra isolation (catching a *backend* query bug) on low-sensitivity tables — not worth it. Per-row DB isolation is reserved for the 2 tables being tenant-scoped for **product** reasons (below).

## Guiding principles (unchanged)

- Prove under the real non-BYPASSRLS `farmsmart_app` role; disposable-CI pgTAP is structural (no `farmsmart_app` role there), matching `00016`–`00020`. Live enforcement holds in staging/prod.
- No live path may regress — the full `scripts/ci/test-disposable-supabase.sh` (existing suites green under new RLS) is the gate.
- Batch by risk; separate PRs; the #4 invariant guard flips to ENFORCING only after every public table (incl. the recommender pair in #5) has RLS.

---

## Batch 1 — `facilities` — ✅ DONE (PR #35, merged)

`current_user='farmsmart_app'` backend policies (SELECT/INSERT/DELETE), no UPDATE (nothing updates facilities), structural pgTAP `00020`, foundation 19→20, `facilitiesTable` added to `check-tenant-scope` SCOPED_TABLES with bootstrap reads baselined. Security-attested (verb-completeness enumerated; no cross-tenant exposure — strictly additive). Recorded here for completeness.

## Batch 2 — the 10 `current_user` tables (ONE migration)

`rooms`, `channels`, `racks`, `trays`, `sensor_readings`, `bad_tray_entries`, `manual_checks`, `stock_movements`, `cycle_seed_lots`, `user_settings`.

- **One Supabase migration:** `enable row level security` on all 10 + `current_user='farmsmart_app'` **per-verb** backend policies, matching `00020`/`00018`'s exact convention. Audit each table's actual verbs (which of SELECT/INSERT/UPDATE/DELETE its routes use — e.g. `layout.ts` for rooms/channels/racks/trays, `sensor-readings.ts`, `badTrays.ts`, cycles/manual-checks, inventory `stock_movements`, `cycle_seed_lots` writes, `userSettings.ts`) and add a policy for exactly those verbs — a MISSING verb policy = silent 0-row denial under the real role (the class of bug that made `00012`/`00014`/`00018` necessary; enumerate, don't guess).
- `user_settings` is per-user, but the same `current_user` backend policy applies (the app already filters by `user_id`); no `auth.uid()` policy needed for the backend path.
- **No schema change, no denormalization** — this is the whole point of Option A. Bootstrap-safe (no GUC), so zero runtime risk.
- **Static-guard hardening:** add all 10 `*Table` names to `check-tenant-scope.mjs` `SCOPED_TABLES`; run the guard; baseline the existing backend reads it flags (group-(I), same permanent-bootstrap category as facilities' group-(H)), pasting the exact keys — so a *new* stray raw read of any of these fails the TEN-004 gate.
- **Proof:** structural pgTAP (RLS enabled + expected per-verb `current_user` policies on each of the 10) + foundation Supabase count bump; regression proof = the full api-server suite green under the new RLS (disposable stack). **Rollback:** drop policies + `disable row level security` on the 10 + revert the guard additions.

## Batch 3 — `crops` (org-scoped, HYBRID system + per-org) — schema change

Product decision: crops is tenant-scoped, not global reference. Keep a shared base catalog as **system crops** (`organization_id NULL`, readable by all) + per-org custom crops.
- Add `organization_id` nullable (NULL = system); drop global `unique(name)` → `unique(organization_id, name)` + partial `unique(name) where organization_id is null`; seed existing ~5 rows as system (NULL).
- RLS (`farmsmart_app`): SELECT `using (organization_id is null or organization_id = app.org_id)`; INSERT/UPDATE/DELETE `with check/using (organization_id = app.org_id)`.
- Rewire `crops.ts` GET + POST onto `withTenantScope` (so `app.org_id` is set → SELECT auto-filters system+own; POST stamps `organization_id`). `growth_profiles.cropId` FKs unaffected.
- **Proof:** pgTAP + route test (org A sees system+own, never B's; can't mutate system/B's crop). **Rollback:** drop policy + `organization_id` + restore `unique(name)`.

## Batch 4 — `sensor_status` (facility-scoped) — SECURITY, latent leak — schema + behavior change

`sensor_status` is a single un-scoped global row (`cycles.ts` upserts `SELECT…LIMIT 1`, `dashboard.ts` reads) → org A's write is visible on org B's dashboard. Fix:
- Add `facility_id not null references facilities` + `unique(facility_id)` (one row per facility); rescope the `cycles.ts` upsert (key on `req.tenant.facilityId`, under `withTenantScope`) + the `dashboard.ts` read (by active facility); reset/delete the existing global row (regenerated aggregate, not source data); RLS `facility_id = app.facility_id` policies for the verbs those two sites use.
- **Proof (explicit isolation test):** org A writes → org B's dashboard read returns B's own/empty, never A's — end-state, under the real role. Ships last with its own security-compliance attestation (changes `cycles.ts`/`dashboard.ts` runtime). **Rollback:** drop policy + `facility_id` + revert the two call sites.

## #4 — RLS positive-invariant guard (flips to ENFORCING last)

After Batches 2–4 **and task #5** (recommender pair) land — i.e. every `public` base table has RLS — ship task #4: a CI Supabase-linter step + a pgTAP "every `public` base table has `relrowsecurity=true`" assertion, **enforcing** (fails CI on any new un-RLS'd table), replacing the curated-allowlist mindset. **Dependency: #4 blocked by BOTH this remediation (#3) AND task #5** — the invariant can't pass while the recommender tables lack RLS.

## Rollout order & safety

Separate PRs, risk-ordered: Batch 2 (the 10, low-risk `current_user`, one migration) → Batch 3 (`crops`, schema change) → Batch 4 (`sensor_status`, security + behavior change) → then #4 (after #5 too). Each: pgTAP + full disposable-stack regression proof under `farmsmart_app`, security-attested (Batch 4 especially). Batch 1 already merged.

## Out of scope (YAGNI)

- Denormalizing `facility_id` onto the 10 (rejected per the impact analysis — Option A).
- Per-org crop cloning beyond the system/own split.
- Streaming sensor data (`sensor_status` stays a per-facility snapshot).
- `recommender_cache`/`recommender_queries` RLS (→ task #5).
- The other MT-M2 items (TEN-011, flag flip) — separate tasks.

## Risks / open items for the plan

- **Batch 2 verb-completeness** — the top risk: enumerate every verb each of the 10 tables' routes use and add a `current_user` policy for each; a missing-verb policy silently 0-rows under the real role (invisible to BYPASSRLS CI). The regression suite catches most, but audit explicitly.
- **Batch 3 crops** — the route rewire (`withTenantScope`) and the RLS must land together, or the SELECT won't filter correctly.
- **Batch 4 sensor_status** — runtime behavior change to `cycles.ts`/`dashboard.ts`; needs the explicit before/after isolation test + attestation.
- **#4 depends on #5** — coordinate so the invariant flips only once the recommender tables are also RLS'd.
