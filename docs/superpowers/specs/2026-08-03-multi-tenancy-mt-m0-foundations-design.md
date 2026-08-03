# Multi-Tenancy MT-M0 — Foundations: Design

**Source documents:** `FarmSmart_MultiTenancy_PRD_v1.5.docx` (converted to `/tmp/prd_v1.5.txt` for reference), `Multi-tenancy-FarmSmart UI/FarmSmart Wireframes v1.5.dc.html`, `Multi-tenancy-FarmSmart UI/FarmSmart UI Mockups.dc.html`, `FarmSmart-Add Member-UI Design.pdf` (Settings → Team + web facility switcher).

**Scope of this document:** MT-M0 only — one of four milestones in the PRD (MT-M0 Foundations → MT-M1 Isolation core → MT-M2 Multi-facility + front door → Exit). Each milestone gets its own design + implementation plan, mirroring how the onboarding wizard was executed in phases. This document does not cover MT-M1/MT-M2/Exit content beyond noting what's explicitly deferred to them.

## Corrections to the PRD found during design

The PRD was written without checking this repo's actual state. Two categories of correction apply project-wide, not just to MT-M0:

1. **ADR numbering.** The PRD calls the tenancy decision "ADR-003 rev. C" and the auth-lineage note "ADR-004." Both numbers are already taken in this repo by unrelated, already-accepted decisions (`ADR-003` = Replace Neon with Supabase Postgres; `ADR-004` = Separate staging/production environments). This plan uses **ADR-005** (tenancy shape) and **ADR-006** (auth lineage) instead.
2. **Role model ambiguity.** TEN-001's acceptance criteria say `organization_members.role` is `owner | member`, but ADR-003 rev. C §9.1 and TEN-010 both describe `owner | admin | technician`. Resolved: **`owner | admin | technician`** is authoritative — it's the only version consistent with every other requirement (surface gating, invites, technician mobile-only enforcement).

## Already-shipped overlap (do not rebuild)

The Phase 1 onboarding wizard already built a meaningful chunk of what this PRD assumes doesn't exist yet:
- `organizations` table (id, name, created_at) — exists, matches PRD shape.
- `facilities` table with `timezone`, `units`, `currency` already columns (TEN-005's acceptance criteria are already met) — exists.
- `rooms` table already implemented almost exactly as ADR-003 rev. C wants: per-facility rows with a closed enum column (`name`: seeding/fertigation/harvesting) and `UNIQUE(facility_id, name)`. This is functionally the PRD's "stage" column under a different name. **Decision: keep the column named `name`, do not rename to `stage`** — renaming is pure churn (every existing reader uses `name`) with no functional benefit.
- Wizard shell (W2→W3→W3.5→W4), readiness checklist, facility-readiness backend, `sensor_accounts` table (already has `organization_id`) — all exist and are largely reusable, though MT-M2's fork/demo-mode work will need to rewire the entry routing.

## Direct conflicts with what's already shipped (must change)

- **`POST /facilities` currently 409s on a second facility per user** (Phase 1 Task 2's "one facility per user" rule). This PRD requires 1..n facilities per org (TEN-008) — this rule must be removed/replaced with the facility-switcher model. (MT-M2 work, noted here for continuity.)
- **`usersTable.role`** is currently `technician | supervisor | quality_lead | facility_lead` — nothing like `owner | admin | technician`, and there's no membership table at all today (a single `users.organizationId` FK, one org per user baked directly into the user row, no per-org role). MT-M0 introduces the real membership table; the old columns are deprecated in place (not dropped) until every reader is repointed.

## Schema changes (MT-M0)

### New table: `organization_members`

```
id               serial PK
organization_id  int NOT NULL FK -> organizations.id (cascade)
user_id          uuid NOT NULL FK -> users.id (cascade)
role             enum('owner','admin','technician') NOT NULL
status           enum('active','removed') NOT NULL default 'active'
created_at       timestamp NOT NULL default now()
UNIQUE(user_id)                       -- exactly one org per user in v1
UNIQUE(organization_id, user_id)      -- belt-and-suspenders; redundant given UNIQUE(user_id) but documents intent
```

This replaces `users.role` / `users.organizationId` as the source of truth for org membership and role. Old columns stay in place (expand-before-contract, matching the pattern already used for the `rooms.facility_id` NOT-NULL rollout) until MT-M1/MT-M2 repoint every reader and a later migration drops them.

### Facility/org scoping columns (expand → backfill → contract, 3-migration split per column set — same pattern as the existing `rooms.facility_id` NOT NULL rollout)

- `facility_id` added to: `cycles`, `inventory_items`, `alerts`, `tasks`, `shipments`, `facility_logs`, `sensors` (sensors currently scopes only indirectly via room/channel/rack — this adds a direct column so the scoped helper doesn't need a join to determine tenancy).
- `organization_id` added to: `growth_profiles`, `accounting_connections` (`sensor_accounts` already has it).

### Inventory identity wave (PRD migration step 4 — designed here from repo analysis, not carried from an external doc)

Current state (verified against the live schema, not assumed):
- `inventory_items.qrCode`: nullable, **no uniqueness constraint at all** today.
- `seed_lots.qrCode`: NOT NULL, **globally unique**, and looked up with no facility scoping (`GET /seed-lots?qrCode=` does a bare `WHERE qrCode = $1`).
- `cycles.seedLotQrCodes` (a `text[]` array, not the `cycle_seed_lots` FK join table) is what routes actually query against for seed-lot resolution.
- No `item_code` column exists anywhere yet. The codebase already has an established "short business-facing code" convention: `cycles.shortId` / `shipments.shortId`, both generated via the existing `generateShortId()` helper (`artifacts/api-server/src/lib/utils.ts`).

Design:
- Add `itemCode: text("item_code")` to `inventory_items`, generated via the existing `generateShortId()` pattern, with `UNIQUE(facility_id, item_code)` (not global) once `facility_id` lands on that table.
- Change `inventory_items.qrCode`'s constraint from unconstrained to `UNIQUE(facility_id, qr_code)` (partial index, `WHERE qr_code IS NOT NULL`), once `facility_id` lands.
- Add `facility_id` to `seed_lots` (physical stock, same nature as `inventory_items`) and change `qrCode` from globally unique to `UNIQUE(facility_id, qr_code)`.
- Update every qrCode-keyed lookup (`GET /seed-lots?qrCode=`, cycle's `seedLotQrCode` matching in `cycles.ts`) to resolve through the scoped helper, so a QR code from Facility A can never match a row that actually lives in Facility B.
- Backfill: existing rows get the pilot's single default facility_id; no collisions possible since only one facility has ever existed.

This lands as migration step 4, immediately after the facility_id/organization_id scoping columns (step 3), since it depends on `facility_id` existing on `inventory_items` and `seed_lots`.

## Scoped-query helper

A new `withTenantScope(ctx, fn)` helper (new module, `lib/db/src/scope.ts`):
- Takes the request's resolved `{ organizationId, facilityId?, role }` (populated by session middleware — new work replacing today's bare `req.supabaseUser` lookup with a membership-resolution step against `organization_members`).
- Wraps `fn` in `db.transaction()`, issuing `SET LOCAL app.org_id = $1` (and `app.facility_id`, `app.role` where applicable) as the transaction's first statement, then runs the caller's query inside that same transaction.
- Throws synchronously if called with no resolvable org context — never a silent unscoped fallback.

Route handlers call `withTenantScope(ctx, (tx) => tx.select().from(cyclesTable)...)` instead of touching `db` directly for any scoped table. Actually rewriting every route handler to use this is MT-M1's job (that's where TEN-002's acceptance criteria — "every read/write path filters by session org/facility" — get proven); MT-M0 ships the helper itself plus the lint rule that will keep new code honest as MT-M1 migrates handlers one by one.

## RLS (defense-in-depth) — resolves Q31

- **Verification task (first, before any policy is trusted):** confirm which Postgres role `DATABASE_URL` uses in staging today (`SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user`). Supabase's default `postgres` and `service_role` roles both have `BYPASSRLS` — if `DATABASE_URL` connects as either, every RLS policy below is a silent no-op. If so, provision a new least-privilege role without that attribute, grant it exactly the required table privileges, and rotate `DATABASE_URL` (staging first, verified, then production) to use it.
- **Policy pattern**, applied to every table gaining `facility_id`/`organization_id`: `USING (organization_id = current_setting('app.org_id', true)::int)`, with facility-scoped tables additionally checking `facility_id = current_setting('app.facility_id', true)::int`.
- This is compatible with the existing infrastructure: `render.yaml` already pins `farmsmart-api`'s `DATABASE_URL` to Supabase's **transaction pooler** (port 6543, per ADR-003). `SET LOCAL` is transaction-scoped and resets automatically at commit — exactly the correct pattern for PgBouncer transaction-mode pooling, which is precisely the "cost of per-request context on pooled connections" Q31 asked to evaluate.
- RLS is defense-in-depth, not a replacement for the helper: a bug in the helper's `WHERE` clause is still caught by RLS; a bug in RLS policy SQL is still caught by the helper. TEN-007's isolation suite (MT-M1) must prove both independently deny cross-tenant access.

## Lint rule (TEN-004)

A custom ESLint rule banning direct `db.select()/insert()/update()/delete()` calls against the scoped-tables list from anywhere in `artifacts/api-server/src/routes/**` outside `withTenantScope`. Added to the existing `Quality (codegen + typecheck)` CI job (not a new job) — CI fails on any direct scoped-table access outside the helper.

## Migration sequencing landing in MT-M0

Steps 1–4 of the PRD's 7-step series (§10). Written and rehearsed against a pilot snapshot; **not** applied to production in this milestone — MT-M1 is where TEN-007's isolation suite proves the scoping is correct in staging before it ever touches production data.

1. `organization_members` table; deprecate (don't drop) `users.role` / `users.organizationId`.
2. Confirm `rooms` needs no schema change (already compliant — verification step, not a migration).
3. `facility_id` / `organization_id` scoping columns (expand → backfill → contract) on the 9 tables listed above, plus provisioning the RLS-capable role and policies.
4. Inventory identity wave (above).

Steps 5–7 (sensor_accounts pieces are already done; the invites table and role-on-`organization_members` beyond the base table structure; `is_demo` flags and demo seeding) are MT-M2 territory — not part of this document.

## Documents this milestone produces

- `docs/adr/ADR-005.md` — tenancy shape (adapted from PRD §9, corrected numbering).
- `docs/adr/ADR-006.md` — auth lineage (Cognito → Clerk → Supabase), one paragraph.
- Migration SQL files for steps 1–4.
- `lib/db/src/scope.ts` (the helper) + the ESLint rule.
- A runbook entry (`docs/runbooks/`) documenting the new least-privilege DB role, if role rotation turns out to be necessary.

## Explicitly deferred (not this document)

- TEN-002's acceptance criteria (every read/write path actually filtering by org/facility) — MT-M1.
- TEN-007 cross-tenant isolation test suite — MT-M1.
- TEN-008 (multi-facility switcher, removing the "one facility per user" 409), TEN-010 (Settings → Team, invites), TEN-012/013/014 (sign-up, fork, demo mode, mobile sign-in-only) — MT-M2. Mockups for Settings → Team and the web facility switcher header now exist (`FarmSmart-Add Member-UI Design.pdf`) and will inform that milestone's design when we get there.
- Q32 (invite email delivery mechanism) — blocking for TEN-010, which is MT-M2; not resolved here.

## Exit criteria (unchanged from PRD)

Rehearsal against a pilot snapshot is clean; pilot labels still resolve unchanged; helper lint is enforced in CI.
