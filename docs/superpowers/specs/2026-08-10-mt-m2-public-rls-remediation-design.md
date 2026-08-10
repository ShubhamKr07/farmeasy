# MT-M2 Public-RLS Remediation — Design

**Status:** design, awaiting review. Branch `mt-m2-public-rls-remediation-design`.
**Relates to:** [[rls-public-tables-remediation]], [[rls-positive-invariant-practice]]. Follows TEN-013 (which deliberately left `facilities` RLS-off, pointing here).

## Scope correction

The tracked memory says "15 public tables lack RLS (Supabase advisor)." That count **predates TEN-012's `00017`/`00018`** (which gave the signup tables + organizations-DELETE their RLS). Enumerating the current schema against the migrations, **only 6 public tables still lack RLS**:

`facilities` · `channels` · `racks` · `trays` · `crops` · `sensor_status`

Two of these (`crops`, `sensor_status`) were originally modeled un-scoped; the product decision (2026-08-10) is to **tenant-scope both**, not rubber-stamp them as global reference. So this is not a mechanical "enable RLS" pass — it is a tenant-scoping project for 4 logical units, delivered in **4 risk-ordered batches**, each its own PR, each proven under the real non-BYPASSRLS `farmsmart_app` role (a BYPASSRLS connection makes every policy a silent no-op).

## Guiding principles

- **Prove under `farmsmart_app`, not a superuser.** Each batch ships pgTAP structural assertions + a route/cross-tenant test that runs under the real role via the disposable stack. Assert **end-state** (rows crossed / not), never error strings.
- **Never deny-by-default a live path.** Enabling RLS on a table with no matching policy denies every existing SELECT/INSERT/UPDATE/DELETE. Every batch audits the exact verbs each table's routes use and adds a policy for each before enabling RLS.
- **Bootstrap reads can't use the `app.org_id`/`app.facility_id` GUC.** Several tables are read before any tenant context exists (wizard bootstrap, demo `getOwnerOrg`, purge sweep). For those, the backend backstop is `current_user = 'farmsmart_app'` (the established `organization_members` `00012` / `organizations` `00010` model), NOT a GUC-scoped policy — the app already self-scopes those reads with an explicit `WHERE`.
- **Batched by risk; #4 invariant guard flips to ENFORCING only after all 4 batches land.**

---

## Batch 1 — `facilities` (org-scoped, backend-backstop policies) — HIGHEST RISK

**Why first + risky:** `facilities` has the heaviest, most bootstrap-entangled live traffic. Verb audit (verified):
- **SELECT:** `facilities.ts` (GET /facilities, membership bootstrap), `wizard.ts` (getOrganizationId, facility validation), `demo.ts` (getOwnerOrg / status), `growthProfiles.ts` (pilot first-facility), `metrics.ts` (timezone lookup), `lib/purgeUnverified.ts` (sweep). **Most run before `app.org_id` is set.**
- **INSERT:** `facilities.ts` (POST /facilities), `demo.ts` (provision).
- **DELETE:** `demo.ts` (graduate).
- **UPDATE:** none today.

**Policy model:** `current_user = 'farmsmart_app'` backend policies for **SELECT / INSERT / DELETE** (no UPDATE policy — nothing updates facilities; add later if a route does). NOT GUC-scoped — the bootstrap SELECTs have no `app.org_id`, and the app already scopes every facilities read/write by `organization_id` in its own `WHERE` (server-resolved from owner membership, per TEN-013's attested trust model). This backstop blocks only non-`farmsmart_app` roles (defense-in-depth) without breaking any bootstrap path. Same shape as `00012`/`00010`.

**Migration:** new `supabase/migrations/000NN_facilities_rls.sql` — `alter table public.facilities enable row level security;` + the 3 `create policy … to farmsmart_app using (current_user = 'farmsmart_app')` statements (match the exact convention of `00018`).

**Proof:** pgTAP structural (RLS enabled + 3 policies present, correct cmd + role) — mirrors `00016-00019` (the disposable DB has no `farmsmart_app` role, so no live SET ROLE). Regression proof = the **existing** facilities/wizard/demo/metrics route suites must stay green under the disposable stack (they exercise every live path). **Rollback:** drop the 3 policies + `disable row level security`.

---

## Batch 2 — `channels` / `racks` / `trays` (facility-scoped-via-parent)

**Problem:** these carry only a parent FK (`channels.room_id` → `racks.channel_id` → `trays.rack_id`); the chain roots at `rooms` (which already has `facility_id` + RLS). Chosen approach (design-approved): **denormalize a `facility_id`** onto each, MT-M0's expand→backfill→contract pattern.

**Per table, 3 Drizzle migrations:**
1. **Expand:** add nullable `facility_id integer references facilities(id) on delete cascade`.
2. **Backfill:** `channels.facility_id` ← `rooms.facility_id` via `room_id`; `racks.facility_id` ← `channels.facility_id` via `channel_id`; `trays.facility_id` ← `racks.facility_id` via `rack_id` (run in that order).
3. **Contract:** `set not null` + add `facility_id` index.

**Policy model:** first audit how channels/racks/trays are accessed (the onboarding wizard's layout step creates them; `layout.ts` reads). If the write path runs under `withTenantScope` → `facility_id = app.facility_id` GUC policies. If any creation path is bootstrap (no GUC) → add the `current_user = 'farmsmart_app'` backstop instead (the plan pins this from the exact call sites). Enable RLS only after policies exist.

**Proof:** pgTAP structural + a cross-tenant test (org A's layout rows invisible/immutable to org B) under the disposable stack. **Rollback:** drop policies + `facility_id` columns (reverse contract→expand).

---

## Batch 3 — `crops` (org-scoped, HYBRID system + per-org)

**Model (design-approved):** keep a shared base catalog as **system crops** (`organization_id NULL`, readable by everyone) + let orgs add their own (`organization_id` set, private to them).

**Migration:**
- Add `organization_id integer references organizations(id) on delete cascade` **nullable** (NULL = system crop).
- Drop the global `unique(name)`; add `unique(organization_id, name)` **plus** a partial `unique(name) where organization_id is null` (system names stay globally unique; org names unique within the org).
- Seed: leave the existing ~5 rows as system crops (`organization_id` stays NULL) — no duplication.

**RLS policies (`farmsmart_app`):**
- SELECT: `using (organization_id is null or organization_id = app.org_id GUC)` — everyone reads system + their own.
- INSERT/UPDATE/DELETE: `using/with check (organization_id = app.org_id)` — orgs manage only their own; nobody mutates system crops via the app (seeded/managed by migration/backend).

**Route rescoping (`crops.ts`):** GET /crops + POST /crops currently run raw `db` unscoped. Rewire both onto `withTenantScope` so `app.org_id` is set → the SELECT policy auto-filters to system+own, and POST stamps `organization_id = app.org_id`. `growth_profiles.cropId` FKs are unaffected (a profile references either a system or its own crop).

**Proof:** pgTAP + route test: org A sees system + A's crops, never B's; A can't mutate a system crop or B's crop. **Rollback:** drop policies + `organization_id` + restore `unique(name)`.

---

## Batch 4 — `sensor_status` (facility-scoped) — SECURITY PRIORITY (latent cross-tenant leak)

**The finding:** `sensor_status` is a **single, un-scoped, overwritten global row** (`id, sensorsOnline/Total, acidityPh, waterLevelPct, tempCelsius, humidityPct, nutrientMix` — no facility/org column). `cycles.ts` writes it (`SELECT … LIMIT 1` → update-else-insert, lines ~294–299 / ~433–437); `dashboard.ts` reads it. One deployment-wide row → **org A's cycle action overwrites it, org B's dashboard reads A's environment values.** A structural cross-tenant leak (matches CLAUDE.md's "sensors are a single overwritten row"; `cycles.ts` marks it "out of scope"). This is the highest-value item here even though it's last (it needs batches' groundwork + the most care).

**Fix — make it per-facility:**
- Add `facility_id integer not null references facilities(id) on delete cascade`; make it **one row per facility** (`unique(facility_id)`), upserted per facility.
- Rescope `cycles.ts`: the update-else-insert keys on `facility_id = req.tenant.facilityId`, under `withTenantScope`.
- Rescope `dashboard.ts`: read `sensor_status where facility_id = <active facility>`, under `withTenantScope`.
- Existing single global row: **reset/delete** it (it's a regenerated aggregate snapshot, not source data) — backfilling one global row to a specific facility would be wrong.
- RLS: enable + `facility_id = app.facility_id` policies (all verbs the two sites use).

**Proof (explicit isolation test):** org A writes a `sensor_status` (via a cycle op), assert org B's dashboard read returns **B's own/empty**, never A's values — end-state, under the real role. **Rollback:** drop policies + `facility_id` + revert the two call sites (restore the singleton read/write). Because this changes `cycles.ts`/`dashboard.ts` behavior, it ships last and gets its own security-compliance attestation.

---

## #4 — RLS positive-invariant guard (flips to ENFORCING after Batch 4)

Once all 4 batches land (every public table has RLS), ship task #4: a CI step running the Supabase linter (`rls_disabled_in_public`) + a pgTAP assertion "every `public` base table has `relrowsecurity = true`" — **enforcing** (fails CI on any new un-RLS'd table). No report-only phase needed since the gap is closed. This replaces the curated `SCOPED_TABLES` allowlist mindset with a positive invariant.

## Rollout order & tenancy safety

Batches ship as **4 separate PRs in order 1→4** (facilities → layout → crops → sensor_status), each independently revertible, each with pgTAP + a farmsmart_app-proven route/cross-tenant test, each security-attested (Batch 1 and Batch 4 especially). #4 guard is a 5th PR. Every batch re-runs the full disposable stack (`test-disposable-supabase.sh`) — the definitive CI-equivalent — before merge.

## Out of scope (YAGNI)

- Per-org customization of crops beyond the system/own split (e.g. cloning system crops into an org).
- Streaming/real-time sensor data (`sensor_status` stays a per-facility snapshot; the real time-series lives in `sensors`/`sensor_readings`, already facility-scoped).
- The other MT-M2 items (TEN-011, recommender role, flag flip) — separate tasks.

## Risks / open items for the plan

- **Batch 1 bootstrap breakage** is the top risk — the plan must run the full facilities/wizard/demo/metrics/purge suites under the disposable stack and confirm zero regression before merge.
- **Batch 2 access-pattern audit** — pin whether channels/racks/trays writes are `withTenantScope` or bootstrap, to choose GUC vs `current_user` policy per table.
- **Batch 3 crops read** only filters correctly once `crops.ts` runs under `withTenantScope`; the route rewire and the RLS must land together.
- **Batch 4** changes runtime behavior of `cycles.ts`/`dashboard.ts` — needs the explicit before/after isolation test + attestation, not just a policy.
