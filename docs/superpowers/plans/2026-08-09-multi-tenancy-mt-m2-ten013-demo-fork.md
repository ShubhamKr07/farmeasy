# TEN-013 — Demo Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a post-sign-up "Set up your farm" vs "Explore a demo" fork at onboarding step W2, seeding the user's existing empty org with a rich demo dataset and letting them graduate (reset-in-place) into a real farm.

**Architecture:** Two authed endpoints (`POST /api/demo/provision`, `POST /api/demo/graduate`) plus a read `GET /api/demo/status` own all demo state. Demo IS the user's single org, flagged `organizations.is_demo`; provision seeds the existing empty org (created lazily by TEN-012's `ensureOwnerOrg` at wizard bootstrap) via a shared `seedDemoOrg(tx, { organizationId, facilityId })` module; graduate deletes the demo facility (FK cascade removes all facility-scoped demo rows) and flips `is_demo=false`. The whole fork is gated behind `DEMO_FORK_ENABLED` (default off) so it ships dark.

**Tech Stack:** Express + Drizzle (api-server), Supabase Postgres + RLS under the non-BYPASSRLS `farmsmart_app` role, drizzle-kit + Supabase SQL migrations, pgTAP foundation tests, orval codegen (react-query client + zod), React + wouter + TanStack Query (admin-dashboard).

## Global Constraints

- **pnpm only** (root `preinstall` guard refuses npm/yarn). `pnpm run typecheck` must pass before every commit.
- **`DEMO_FORK_ENABLED` defaults OFF.** Unrecognized/missing env value ⇒ off (fail-closed, same pattern as `SIGNUP_MODE`). With it off, W2 behaves byte-for-byte as TEN-012 ships it (`Wizard` opens directly on `farm_basics`) and `POST /api/demo/provision` is inert.
- **All demo DB work runs under the real non-`BYPASSRLS` `farmsmart_app` role** (MT-M1/TEN-010/TEN-012 discipline). A BYPASSRLS superuser connection masks missing policies — never trust it as proof.
- **One-org-per-user invariant is preserved.** Demo is the user's single existing org (never a second org); the fork does NOT change TEN-012's `ensureOwnerOrg` provisioning.
- **Seed stays inside the cascade-clean subgraph.** Deleting the demo facility must fully teardown via `ON DELETE CASCADE`. `manual_checks` and `bad_tray_entries` reference `cycles` with `onDelete: "restrict"` — the demo seed MUST NOT create any row in those two tables (nor any other `restrict`/`no action` child of a seeded row). See Task 4's cascade audit.
- **Both write endpoints are single-transaction and idempotent.** A mid-operation failure leaves the prior state intact for retry.
- **Provision/graduate resolve the caller's org from their active OWNER membership server-side** — never from client input, and never from `req.tenant`/`X-Facility-Id` (there is no facility yet at the fork). `set_config('app.org_id', …, true)` / `set_config('app.facility_id', …, true)` are set inside the transaction (mirroring `withTenantScope`, but with `app.facility_id` set AFTER the demo facility row is inserted).
- **Migrations are reversible.** Every Drizzle/Supabase migration in this plan ships a working down/rollback path.
- **Foundation pgTAP counts move together with migrations:** `supabase/tests/00001_foundation.sql` asserts Drizzle `__drizzle_migrations` = 31 and `supabase_migrations.schema_migrations` = 18 today. Adding one Drizzle migration ⇒ 32; adding one Supabase migration ⇒ 19. Bump both in the same task that adds each migration.

---

## File Structure

**Create:**
- `lib/db/drizzle/0031_organizations_is_demo.sql` — adds `organizations.is_demo`.
- `supabase/migrations/00019_demo_fork_rls.sql` — `organizations` backend UPDATE policy + `facilities` backend DELETE policy.
- `supabase/tests/00019_demo_fork_rls.test.sql` — pgTAP proof of the two new policies under `farmsmart_app`.
- `lib/db/src/seed/seedDemoOrg.ts` — canonical demo dataset (shared by the endpoint and the CLI).
- `artifacts/api-server/src/lib/demoFork.ts` — `DEMO_FORK_ENABLED` flag reader.
- `artifacts/api-server/src/routes/demo.ts` — `GET /demo/status`, `POST /demo/provision`, `POST /demo/graduate`.
- `artifacts/api-server/src/tests/routes/demo.test.ts` — route integration tests (node:test, DB-backed).
- `artifacts/api-server/src/tests/lib/demoFork.test.ts` — flag-reader unit test (node:test).
- `artifacts/api-server/src/tests/db/seedDemoOrg.test.ts` — seed + cascade-teardown integration test (node:test, DB-backed).
- `artifacts/admin-dashboard/src/hooks/use-demo-status.ts` — client hook wrapping `GET /demo/status`.
- `artifacts/admin-dashboard/src/pages/onboarding/steps/ForkChoice.tsx` — the W2 fork screen.
- `artifacts/admin-dashboard/src/components/layout/DemoBanner.tsx` — persistent demo banner + graduate CTA.

**Modify:**
- `lib/db/src/schema/index.ts` — add `isDemo` to `organizationsTable`.
- `lib/db/src/index.ts` (barrel) — export `seedDemoOrg` (verify existing export style first).
- `supabase/tests/00001_foundation.sql` — bump both migration counts.
- `scripts/src/seed-demo-data.ts` — refactor onto `seedDemoOrg` + add a prod guard.
- `lib/api-spec/openapi.yaml` — add the three demo paths + schemas.
- `artifacts/api-server/src/app.ts` — mount `demoRouter` in tier 1.
- `artifacts/admin-dashboard/src/pages/onboarding/Wizard.tsx` — insert the fork pre-step.
- `artifacts/admin-dashboard/src/components/layout/AppLayout.tsx` — render `<DemoBanner/>`.

---

## Test Harness Conventions (READ FIRST — the whole plan depends on these)

This repo does **NOT use vitest** for api-server. Match the existing conventions exactly:

- **Runner:** `node:test` + `node:assert`, discovered by `artifacts/api-server/scripts/run-tests.mjs` (globs `**/*.test.ts`). Run the whole suite with `pnpm --filter @workspace/api-server run test`. There is no per-file vitest command.
- **Test location:** all api-server tests live under `artifacts/api-server/src/tests/` — `tests/lib/`, `tests/routes/`, `tests/isolation/`. **Never** co-locate a `*.test.ts` next to the source file.
- **`lib/db` has no test runner.** Any DB-backed test for `seedDemoOrg` MUST live in the api-server suite (which owns the DB harness), not in `lib/db`.
- **DB-backed suites** follow the pattern in `src/tests/routes/wizard.test.ts`: `import { describe, test } from "node:test"; import { strictEqual, ok } from "node:assert";`, then
  ```ts
  const dbUrl = requireTestDatabaseUrl();
  closeDatabasePoolAfterTests();
  describe("…", { skip: !dbUrl }, () => {
    const fixture = useDatabaseFixture(["<tables to truncate>"]);
    // seedTestUser / seedTenantContext / getAdminDb from helpers/testDatabase
    // createAuthenticatedTestApp, DEFAULT_TEST_USER from helpers/testApp
    // supertest(app) for HTTP
  });
  ```
  Skipping on missing `TEST_DATABASE_URL` keeps the local `run test` job green DB-free.
- **Pure-unit tests** (no DB, e.g. the flag reader) also use `node:test`/`node:assert` and live under `src/tests/lib/`.
- **The one end-to-end proof command** for migrations + RLS (pgTAP) + routes is:
  ```bash
  bash scripts/ci/test-disposable-supabase.sh
  ```
  It spins a disposable local Supabase stack (docker + supabase CLI, both present in this env), replays the full Drizzle + Supabase migration history, runs the pgTAP suite (`supabase/tests/`), then the api-server `node:test` suite with `REQUIRE_TEST_DATABASE=true`, and stops its own stack on exit. This is how Task 2's pgTAP, Task 4/6/7's DB tests, and Task 11's isolation proof are all validated. It owns the containers it starts — do not touch unrelated containers.

---

### Task 1: `organizations.is_demo` column (Drizzle)

**Files:**
- Modify: `lib/db/src/schema/index.ts` (`organizationsTable`, ~line 381)
- Create: `lib/db/drizzle/0031_organizations_is_demo.sql`
- Modify: `lib/db/drizzle/meta/_journal.json` (generated by drizzle-kit)
- Modify: `supabase/tests/00001_foundation.sql:22` (Drizzle count 31 → 32)

**Interfaces:**
- Produces: `organizationsTable.isDemo` (boolean column `is_demo`, `NOT NULL DEFAULT false`). Every later task reads/writes it via Drizzle as `organizationsTable.isDemo`.

- [ ] **Step 1: Add the column to the schema.** In `lib/db/src/schema/index.ts`, inside `organizationsTable`:

```ts
export const organizationsTable = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

(Confirm `boolean` is already imported at the top of the file — it is used by other tables, e.g. `sensors.facilityWide`.)

- [ ] **Step 2: Generate the migration.**

Run: `pnpm --filter @workspace/db exec drizzle-kit generate --name organizations_is_demo`
Expected: creates `lib/db/drizzle/0031_organizations_is_demo.sql` containing `ALTER TABLE "organizations" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;` and appends an entry to `meta/_journal.json`.

- [ ] **Step 3: Verify the generated SQL is reversible in principle.** Confirm the migration is a pure additive `ADD COLUMN` (down = `ALTER TABLE "organizations" DROP COLUMN "is_demo";`). Record the down statement as a comment at the top of the generated file:

```sql
-- Rollback: ALTER TABLE "organizations" DROP COLUMN "is_demo";
```

- [ ] **Step 4: Bump the foundation Drizzle count.** In `supabase/tests/00001_foundation.sql`, change the `is(...)` assertion for `drizzle.__drizzle_migrations` from `31` to `32` and update its comment (`All 31 Drizzle migrations` → `All 32 Drizzle migrations` and note `0031, TEN-013, adds organizations.is_demo`).

- [ ] **Step 5: Typecheck + build the db package.**

Run: `pnpm --filter @workspace/db run build && pnpm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add lib/db/src/schema/index.ts lib/db/drizzle/0031_organizations_is_demo.sql lib/db/drizzle/meta/_journal.json supabase/tests/00001_foundation.sql
git commit -m "feat(db): add organizations.is_demo column (TEN-013)"
```

---

### Task 2: Backend RLS policies for the `is_demo` flip + facility delete

**Files:**
- Create: `supabase/migrations/00019_demo_fork_rls.sql`
- Create: `supabase/tests/00019_demo_fork_rls.test.sql`
- Modify: `supabase/tests/00001_foundation.sql:115` (Supabase count 18 → 19)

**Interfaces:**
- Produces: under the `farmsmart_app` role, `UPDATE organizations SET is_demo = …` is permitted when `app.org_id` = that org, and `DELETE FROM facilities` is permitted when `app.org_id` = the facility's org. Task 6/7's transactions depend on these.

**Background:** `00010` added `current_user='farmsmart_app'` backend policies to `organizations` for only the verbs its routes used (SELECT/INSERT); `00018` added DELETE. There is **no UPDATE policy** on `organizations`, and **no DELETE policy** on `facilities`. The BYPASSRLS CI DB masks both — they only surface under the real `farmsmart_app` proof. Follow the exact shape of the existing backend policies (see `00013`/`00018` for the `NULLIF(current_setting('app.org_id', true), '')::int` idiom).

- [ ] **Step 1: Write the migration.** Create `supabase/migrations/00019_demo_fork_rls.sql`:

```sql
-- TEN-013 demo fork: two backend (current_user = 'farmsmart_app') policies the
-- prior milestones never needed and the BYPASSRLS CI DB masked.
--
-- 1. organizations UPDATE — POST /api/demo/provision flips is_demo=true and
--    POST /api/demo/graduate flips it back to false, both under app.org_id.
-- 2. facilities DELETE — POST /api/demo/graduate deletes the demo facility
--    (its ON DELETE CASCADE children are removed by the engine, not subject to
--    RLS). facilities shipped with SELECT/INSERT backend policies but no DELETE.
--
-- Both key on the transaction-local app.org_id GUC (set via withTenantScope /
-- the demo endpoints' own set_config), same NULLIF-guarded cast as 00013.
-- Rollback:
--   DROP POLICY organizations_backend_update ON public.organizations;
--   DROP POLICY facilities_backend_delete ON public.facilities;

CREATE POLICY organizations_backend_update
  ON public.organizations
  FOR UPDATE
  TO farmsmart_app
  USING (id = NULLIF(current_setting('app.org_id', true), '')::int)
  WITH CHECK (id = NULLIF(current_setting('app.org_id', true), '')::int);

CREATE POLICY facilities_backend_delete
  ON public.facilities
  FOR DELETE
  TO farmsmart_app
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::int);
```

(Verify the exact role name and the `TO farmsmart_app` vs `USING current_user = 'farmsmart_app'` convention against `00018_organizations_backend_delete_policy.sql` and match it verbatim — do not mix conventions.)

- [ ] **Step 2: Write the pgTAP proof.** Create `supabase/tests/00019_demo_fork_rls.test.sql` following the structure of `supabase/tests/00018_organizations_backend_delete_policy.test.sql`. Assert, running `SET ROLE farmsmart_app` with `set_config('app.org_id', …, true)`:
  - a member org's `is_demo` CAN be UPDATEd to true then false when `app.org_id` matches;
  - the UPDATE affects 0 rows when `app.org_id` is a different org (cross-tenant denied — assert end-state via a service-role re-read, NOT an error, per the RLS UPDATE-returns-0-rows rule);
  - a facility in the app.org_id org CAN be DELETEd; a facility in another org is NOT (0 rows).

Use `SELECT plan(N)` with the exact count you write, and `SELECT * FROM finish();` inside `BEGIN; … ROLLBACK;`.

- [ ] **Step 3: Bump the foundation Supabase count.** In `supabase/tests/00001_foundation.sql`, change the `supabase_migrations.schema_migrations` assertion from `18` to `19`, its message (`00001-00018` → `00001-00019`), and append a comment line describing `00019` (demo-fork backend UPDATE on organizations + DELETE on facilities).

- [ ] **Step 4: Run the pgTAP suite via the disposable stack.** The disposable script replays all migrations (Drizzle + Supabase, including this `00019`) then runs `supabase test db` over `supabase/tests/`:

Run: `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -60`
Expected: all pgTAP files pass, including `00001_foundation.sql` (now 32/19) and `00019_demo_fork_rls.test.sql`. (docker + supabase CLI are present in this env; the script starts and stops its own stack.)

(Do NOT weaken assertions to make them pass. If the disposable stack fails to start, report BLOCKED with the tail output.)

- [ ] **Step 5: Commit.**

```bash
git add supabase/migrations/00019_demo_fork_rls.sql supabase/tests/00019_demo_fork_rls.test.sql supabase/tests/00001_foundation.sql
git commit -m "feat(db): backend RLS for demo is_demo flip + facility delete (TEN-013)"
```

---

### Task 3: `DEMO_FORK_ENABLED` flag reader

**Files:**
- Create: `artifacts/api-server/src/lib/demoFork.ts`
- Create: `artifacts/api-server/src/tests/lib/demoFork.test.ts` (node:test, no DB)

**Interfaces:**
- Produces: `isDemoForkEnabled(): boolean`. Task 6/9 gate on it.

- [ ] **Step 1: Write the failing test.** Create `artifacts/api-server/src/tests/lib/demoFork.test.ts` (pure unit, `node:test` — no DB gate needed). Note the import path reaches up out of `src/tests/lib/` into `src/lib/`:

```ts
import { describe, test, afterEach } from "node:test";
import { strictEqual } from "node:assert";
import { isDemoForkEnabled } from "../../lib/demoFork";

describe("isDemoForkEnabled", () => {
  const orig = process.env.DEMO_FORK_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.DEMO_FORK_ENABLED;
    else process.env.DEMO_FORK_ENABLED = orig;
  });

  test("defaults to false when unset", () => {
    delete process.env.DEMO_FORK_ENABLED;
    strictEqual(isDemoForkEnabled(), false);
  });
  test("is false for any non-'true' value", () => {
    process.env.DEMO_FORK_ENABLED = "1";
    strictEqual(isDemoForkEnabled(), false);
    process.env.DEMO_FORK_ENABLED = "yes";
    strictEqual(isDemoForkEnabled(), false);
  });
  test("is true only for 'true' (case-insensitive)", () => {
    process.env.DEMO_FORK_ENABLED = "TRUE";
    strictEqual(isDemoForkEnabled(), true);
    process.env.DEMO_FORK_ENABLED = "true";
    strictEqual(isDemoForkEnabled(), true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `pnpm --filter @workspace/api-server run test 2>&1 | grep -A3 demoFork`
Expected: FAIL (module `../../lib/demoFork` not found). (The runner globs all `*.test.ts`; grep isolates this file's result.)

- [ ] **Step 3: Implement.** Create `artifacts/api-server/src/lib/demoFork.ts`:

```ts
/**
 * Feature flag for the TEN-013 demo fork ("Set up your farm" vs "Explore a
 * demo" at onboarding W2). Read from `process.env.DEMO_FORK_ENABLED`,
 * case-insensitive. Any value other than "true" — including unset — disables
 * the fork (fail-closed, same discipline as SIGNUP_MODE). While off, W2 opens
 * directly on farm_basics and POST /api/demo/provision is inert.
 *
 * NOTE: only the provision path and the fork UI are gated by this flag. Demo
 * graduation (POST /api/demo/graduate) and GET /api/demo/status are always
 * available so a user already in a demo org can never be trapped if the flag
 * is later switched off.
 */
export function isDemoForkEnabled(): boolean {
  return (process.env.DEMO_FORK_ENABLED ?? "").toLowerCase() === "true";
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `pnpm --filter @workspace/api-server run test 2>&1 | grep -A3 demoFork`
Expected: PASS (3 subtests under `isDemoForkEnabled`).

- [ ] **Step 5: Commit.**

```bash
git add artifacts/api-server/src/lib/demoFork.ts artifacts/api-server/src/tests/lib/demoFork.test.ts
git commit -m "feat(api): DEMO_FORK_ENABLED flag reader (TEN-013)"
```

---

### Task 4: Shared `seedDemoOrg` module + FK-cascade audit

**Files:**
- Create: `lib/db/src/seed/seedDemoOrg.ts`
- Modify: `lib/db/src/index.ts` (barrel — export `seedDemoOrg`; match the existing export style)
- Create: `artifacts/api-server/src/tests/db/seedDemoOrg.test.ts` (`node:test`, DB-backed — `lib/db` has no runner, so the integration test lives in the api-server suite that owns the DB harness; there is already a `src/tests/db/` dir, e.g. `signupTables.test.ts`)

**Interfaces:**
- Consumes: a Drizzle transaction `tx` on which the caller has ALREADY set `app.org_id` and `app.facility_id` (so RLS admits the inserts), and `{ organizationId, facilityId, userId }`.
- Produces: `export async function seedDemoOrg(tx, ctx: { organizationId: number; facilityId: number; userId: string }): Promise<void>`. `userId` is required because `facility_logs.userId` is `NOT NULL`. `tx` type is the same `Parameters<Parameters<typeof db.transaction>[0]>[0]` used by `withTenantScope` (`lib/db/src/scope.ts`) — import/reuse that type alias, do not re-widen to `any`.

**Cascade audit (do this first, record findings in a top-of-file comment):** every table `seedDemoOrg` writes MUST be removable by deleting the parent facility via `ON DELETE CASCADE`. Confirmed cascade-safe children of `facilities`: `seed_lots`, `cycles`, `sensors` (→ `sensor_readings` cascade), `alerts`, `tasks`, `inventory_items`, `facility_logs`, `rooms`, `growth_profiles` (org-scoped, cascades from `organizations`). **Forbidden (restrict child of `cycles`):** `manual_checks`, `bad_tray_entries` — do NOT seed either. `stock_movements` (inventory child, cascade) and `cycle_seed_lots` (cascade) are safe but out of scope for v1's seed. Reference data (`growth_profiles`) is created fresh for the demo org here (it is org-scoped and `NOT NULL organization_id`), never copied from another org.

- [ ] **Step 1: Write the failing integration test.** Create `artifacts/api-server/src/tests/db/seedDemoOrg.test.ts` following the `node:test` DB-backed pattern (see Test Harness Conventions above and `src/tests/db/signupTables.test.ts`):
  - `const dbUrl = requireTestDatabaseUrl(); closeDatabasePoolAfterTests();`
  - `describe("seedDemoOrg", { skip: !dbUrl }, () => { … })`.
  - Use `useDatabaseFixture([...])` and `seedTenantContext(handle.db, {...}, { id, email }, { memberRole: "owner" })` (returns `{ organizationId, facilityId }`) to create the org+facility+owner. Grab the owner `userId` from the seeded user id.
  - Open a `handle.db.transaction`, `SELECT set_config('app.org_id', …, true)` and `set_config('app.facility_id', …, true)` inside it, call `seedDemoOrg(tx, { organizationId, facilityId, userId })`.
  - Assert — scoped to that facility — that `seed_lots`, `cycles`, `sensors`, `sensor_readings`, `alerts`, `tasks`, `inventory_items`, `facility_logs`, and 2 `growth_profiles` rows have counts > 0, AND `manual_checks` / `bad_tray_entries` counts are 0 for that org (cascade-safety guard).
  - Then run `DELETE FROM facilities WHERE id = facilityId` (via `getAdminDb() ?? handle.db`, since a bare farmsmart_app delete needs Task 2's policy + `app.org_id` set) and assert it succeeds without an FK error and leaves every seeded facility-child table at 0 rows (proves the cascade teardown).

Note the import for the module under test is `import { seedDemoOrg } from "@workspace/db";` (barrel export from Step 4).

- [ ] **Step 2: Run it to confirm it fails.**

Run: `pnpm --filter @workspace/api-server run test 2>&1 | grep -A3 seedDemoOrg`
Expected: FAIL (`seedDemoOrg` is not exported yet). (Without `TEST_DATABASE_URL` the describe is skipped — run the real assertion via the disposable script in Step 5.)

- [ ] **Step 3: Implement the seed module.** Create `lib/db/src/seed/seedDemoOrg.ts`. Reuse the concrete cycle/seed-lot literals already in `scripts/src/seed-demo-data.ts` (the `d001`–`d010` cycle set and the QR seed-lot set) rather than reinventing them. Structure:

```ts
import { and, eq } from "drizzle-orm";
import type { db } from "../index.js";
import {
  growthProfilesTable, seedLotsTable, cyclesTable, sensorsTable,
  sensorReadingsTable, alertsTable, tasksTable, inventoryItemsTable,
  facilityLogsTable,
} from "../index.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Canonical TEN-013 demo dataset — the single source of truth for what an
 * "Explore a demo" org looks like. Called by POST /api/demo/provision (live,
 * under farmsmart_app RLS) and by scripts/src/seed-demo-data.ts (dev CLI).
 *
 * Caller contract: `tx` already has app.org_id AND app.facility_id set (the
 * live endpoint sets both inside its transaction; the CLI runs as a BYPASSRLS
 * dev role where the GUCs are harmless no-ops). Every row written here is
 * facility-scoped (or org-scoped growth_profiles) and therefore removed by
 * deleting the parent facility — see the cascade audit above. NEVER write
 * manual_checks or bad_tray_entries (restrict children of cycles).
 *
 * Row counts kept modest (dozens) so provision stays a sub-second sync tx.
 */
export async function seedDemoOrg(
  tx: Tx,
  { organizationId, facilityId, userId }: { organizationId: number; facilityId: number; userId: string },
): Promise<void> {
  // 1. Two org-scoped growth profiles the demo cycles reference (predictable
  //    overdue behaviour, same as the CLI's p1/p5). Columns per
  //    growthProfilesTable — set organizationId = organizationId.
  const [p1] = await tx.insert(growthProfilesTable).values({
    name: "Arugula (demo)", germinationDays: 7, fertigationDays: 14,
    organizationId, /* + any other NOT NULL columns per schema */
  }).returning();
  const [p5] = await tx.insert(growthProfilesTable).values({
    name: "Microgreen Mix (demo)", germinationDays: 3, fertigationDays: 7,
    organizationId, /* + any other NOT NULL columns per schema */
  }).returning();

  // 2. seed_lots (facilityId) — reuse the QR list from seed-demo-data.ts.
  // 3. cycles (facilityId, growthProfileId: p1.id/p5.id) — reuse d001–d010.
  // 4. sensors (facilityId, facilityWide:true to satisfy the placement CHECK)
  //    + a handful of recent sensor_readings per sensor.
  // 5. alerts (facilityId) — 2 rows (one 'current', one 'resolved').
  // 6. tasks (facilityId) — 2 rows.
  // 7. inventory_items (facilityId) — 3 rows; respect the
  //    `currentQty <= maxQty` CHECK.
  // 8. facility_logs (facilityId, userId, data jsonb, logType) — 3 recent rows,
  //    using the required `userId` from the ctx (facility_logs.userId NOT NULL).
}
```

**Important schema constraints to honor (read the exact columns in `lib/db/src/schema/index.ts`):**
- `sensors` has a CHECK requiring one of `channelId`/`rackId`/`roomId`/`facilityWide=true` — use `facilityWide: true` so no room/rack/channel is required.
- `inventory_items` has CHECK `current_qty <= max_qty`.
- `facility_logs.userId` is `NOT NULL` — extend the ctx to `{ organizationId, facilityId, userId }` and pass the demo owner's user id.
- `alerts` has a partial unique index on `(title, location) WHERE status='current'` — give current alerts distinct titles.

(The `userId` param is already reflected in this task's Interfaces block above; thread `userId` from Task 6's resolved membership when the endpoint calls this.)

- [ ] **Step 4: Export from the barrel.** In `lib/db/src/index.ts`, add `export { seedDemoOrg } from "./seed/seedDemoOrg.js";` (match the file's existing export punctuation/extension convention).

- [ ] **Step 5: Run the test to confirm it passes (against the disposable stack).** Task 2's migration must already be present. Run the full disposable proof, which provides `TEST_DATABASE_URL` so the skipped describe now executes:

Run: `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -40`
Expected: the api-server suite passes, including `seedDemoOrg` (seeded counts > 0; facility delete cascades cleanly). pgTAP from Task 2 also runs here.

(A fast inner-loop alternative once a disposable stack is already up: export its `TEST_DATABASE_URL`/`REQUIRE_TEST_DATABASE=true`/`SUPABASE_*` and run `pnpm --filter @workspace/api-server run test` directly — but the committed proof is the script above.)

- [ ] **Step 6: Typecheck + commit.**

```bash
pnpm run typecheck
git add lib/db/src/seed/seedDemoOrg.ts artifacts/api-server/src/tests/db/seedDemoOrg.test.ts lib/db/src/index.ts
git commit -m "feat(db): shared seedDemoOrg demo dataset module (TEN-013)"
```

---

### Task 5: Refactor `seed-demo-data.ts` onto `seedDemoOrg` + add prod guard

**Files:**
- Modify: `scripts/src/seed-demo-data.ts`

**Interfaces:**
- Consumes: `seedDemoOrg` (Task 4), `withTenantScope`/`db` from `@workspace/db`.

**Note:** the current CLI has NO prod guard despite the spec assuming one. Add one (this is the CLI's own safety; the live endpoint's safety is tenant-scoping, not an env block).

- [ ] **Step 1: Add the prod guard at the top of `main()`.**

```ts
if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run demo seed under NODE_ENV=production.");
  process.exit(1);
}
if (process.env.CONFIRM_DEMO_SEED !== "true") {
  console.error("Set CONFIRM_DEMO_SEED=true to run the demo seed.");
  process.exit(1);
}
```

- [ ] **Step 2: Resolve an org + facility, then delegate to `seedDemoOrg`.** Replace the bespoke `seedLots()`/inline cycle-insert body with: resolve the first facility (existing `getFacilityId` logic) AND its `organizationId` (join `facilities.organization_id`), resolve that facility's owner userId (first active owner membership), then:

```ts
import { withTenantScope, seedDemoOrg } from "@workspace/db";
// …
await withTenantScope({ organizationId, facilityId }, (tx) =>
  seedDemoOrg(tx, { organizationId, facilityId, userId }),
);
```

Keep the existing "no facility exists yet" error message. Remove the now-duplicated seed literals from the script (they live in `seedDemoOrg` now — DRY).

- [ ] **Step 3: Typecheck.**

Run: `pnpm run typecheck`
Expected: PASS.

- [ ] **Step 4: Smoke the guard (no DB needed).**

Run: `NODE_ENV=production pnpm --filter @workspace/scripts run seed-demo`
Expected: exits 1 with "Refusing to run demo seed under NODE_ENV=production."

- [ ] **Step 5: Commit.**

```bash
git add scripts/src/seed-demo-data.ts
git commit -m "refactor(scripts): seed-demo-data delegates to seedDemoOrg + prod guard (TEN-013)"
```

---

### Task 6: `GET /demo/status` + `POST /demo/provision`

**Files:**
- Create: `artifacts/api-server/src/routes/demo.ts`
- Create: `artifacts/api-server/src/tests/routes/demo.test.ts` (`node:test`, DB-backed)
- Modify: `artifacts/api-server/src/app.ts` (import + mount `demoRouter` in tier 1, alongside `wizardRouter`)

**Interfaces:**
- Consumes: `isDemoForkEnabled` (Task 3), `seedDemoOrg` (Task 4), `getAuth` (`middlewares/supabaseAuth`), `db` + tables + `sql`/`set_config` from `@workspace/db`, `organizations.isDemo` (Task 1).
- Produces:
  - `GET /api/demo/status` → `200 { enabled: boolean; isDemo: boolean; demoFacilityId: number | null }`.
  - `POST /api/demo/provision` → `200 { facilityId: number }` (idempotent: returns the existing demo facility if already demo); `403` if flag off; `403` if caller is not an active owner; `409`/`400` on no resolvable org.

**Design (mirror `ensureOwnerOrg`/`wizard.ts`, NOT `req.tenant`):** at the fork there is no facility, so resolve the org from the caller's active OWNER membership directly. Provision runs one `db.transaction`, setting GUCs inside it (like `withTenantScope`, but `app.facility_id` is set AFTER the facility row is created):

- [ ] **Step 1: Write failing route tests.** Create `artifacts/api-server/src/tests/routes/demo.test.ts` following the `node:test` DB-backed pattern of `src/tests/routes/wizard.test.ts`: `requireTestDatabaseUrl()`, `closeDatabasePoolAfterTests()`, `describe(..., { skip: !dbUrl })`, `useDatabaseFixture([...])`, `createAuthenticatedTestApp(...)` + `DEFAULT_TEST_USER`, `supertest(app)`. Seed the owner via `seedTenantContext(handle.db, {...}, user, { memberRole: "owner" })` — but note provision creates its OWN facility, so for the fresh-provision case seed only the org+owner membership WITHOUT a pre-existing facility (adapt `seedTenantContext`, or insert org + owner membership directly via `getAdminDb()`), matching the real fork state (empty owner org, no facility). Toggle `process.env.DEMO_FORK_ENABLED` per case and restore it in `afterEach`. Cases:
  - flag off ⇒ `POST /demo/provision` returns 403 and writes nothing;
  - flag on, fresh owner org ⇒ 200, org `is_demo=true`, exactly one facility, seeded rows present (spot-check `cycles`/`seed_lots` counts), `GET /demo/status` ⇒ `{ enabled:true, isDemo:true, demoFacilityId:<id> }`;
  - second `POST /demo/provision` ⇒ 200, same `facilityId`, no duplicate facility (idempotent);
  - non-owner / no active membership ⇒ 403.

- [ ] **Step 2: Run to confirm failure.**

Run: `pnpm --filter @workspace/api-server run test 2>&1 | grep -A3 "demo"`
Expected: FAIL (route not mounted / not found). (Real DB assertions run via the disposable script in Step 5; without `TEST_DATABASE_URL` the describe skips.)

- [ ] **Step 3: Implement `routes/demo.ts`.**

```ts
import { Router, type Request, type Response } from "express";
import { sql, and, eq } from "drizzle-orm";
import { db, organizationsTable, organizationMembersTable, facilitiesTable, seedDemoOrg } from "@workspace/db";
import { getAuth } from "../middlewares/supabaseAuth";
import { isDemoForkEnabled } from "../lib/demoFork";

const router = Router();

// Resolve the caller's active OWNER membership org (facility-agnostic — the
// fork runs before any facility exists, so req.tenant/X-Facility-Id can't be
// used here). Returns null when the user has no active owner membership.
async function getOwnerOrg(userId: string): Promise<number | null> {
  const [m] = await db
    .select({ organizationId: organizationMembersTable.organizationId })
    .from(organizationMembersTable)
    .where(and(
      eq(organizationMembersTable.userId, userId),
      eq(organizationMembersTable.status, "active"),
      eq(organizationMembersTable.role, "owner"),
    ))
    .limit(1);
  return m?.organizationId ?? null;
}

router.get("/demo/status", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const organizationId = await getOwnerOrg(userId);
    if (!organizationId) return res.status(200).json({ enabled: isDemoForkEnabled(), isDemo: false, demoFacilityId: null });
    const [org] = await db.select({ isDemo: organizationsTable.isDemo }).from(organizationsTable).where(eq(organizationsTable.id, organizationId));
    let demoFacilityId: number | null = null;
    if (org?.isDemo) {
      const [f] = await db.select({ id: facilitiesTable.id }).from(facilitiesTable).where(eq(facilitiesTable.organizationId, organizationId)).limit(1);
      demoFacilityId = f?.id ?? null;
    }
    return res.status(200).json({ enabled: isDemoForkEnabled(), isDemo: Boolean(org?.isDemo), demoFacilityId });
  } catch (err) { req.log.error(err); return res.status(500).json({ error: "Failed to fetch demo status" }); }
});

router.post("/demo/provision", async (req: Request, res: Response) => {
  if (!isDemoForkEnabled()) return res.status(403).json({ error: "Demo fork disabled" });
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const organizationId = await getOwnerOrg(userId);
    if (!organizationId) return res.status(403).json({ error: "No owner organization" });

    const facilityId = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.org_id', ${organizationId.toString()}, true)`);
      // Idempotent: already a demo org → return its existing facility, no re-seed.
      const [org] = await tx.select({ isDemo: organizationsTable.isDemo }).from(organizationsTable).where(eq(organizationsTable.id, organizationId)).for("update");
      if (org?.isDemo) {
        const [f] = await tx.select({ id: facilitiesTable.id }).from(facilitiesTable).where(eq(facilitiesTable.organizationId, organizationId)).limit(1);
        if (f) return f.id;
      }
      await tx.update(organizationsTable).set({ isDemo: true }).where(eq(organizationsTable.id, organizationId));
      const [facility] = await tx.insert(facilitiesTable).values({
        organizationId, name: "Demo Farm", facilityName: "Demo Farm",
        timezone: "America/Los_Angeles", units: "metric", currency: "USD",
      }).returning({ id: facilitiesTable.id });
      await tx.execute(sql`SELECT set_config('app.facility_id', ${facility.id.toString()}, true)`);
      await seedDemoOrg(tx, { organizationId, facilityId: facility.id, userId });
      return facility.id;
    });

    return res.status(200).json({ facilityId });
  } catch (err) { req.log.error(err); return res.status(500).json({ error: "Failed to provision demo" }); }
});

export default router;
```

(Adjust facility default columns to whatever `POST /facilities` uses as sensible defaults — read `routes/facilities.ts`. If the demo facility should also land the caller directly on the dashboard rather than back in the wizard, additionally insert a `wizard_progress` row at `currentStep: "done"` for `(userId, facilityId)` inside the same transaction — verify against how `useActiveFacility`/`GET /facilities` derives the `onboarded` flag before relying on this.)

- [ ] **Step 4: Mount in `app.ts` (tier 1).** Add `import demoRouter from "./routes/demo";` with the other route imports, and mount it in the tier-1 block next to `wizardRouter`:

```ts
app.use("/api", requireSignedIn, demoRouter);
```

Tier 1 is correct: `/demo/*` carries no `requireTenantContext` (it must run for a user with no facility yet), and its handlers self-resolve the org. Place it among the tier-1 mounts (lines ~211–220), NOT in tiers 2–4.

- [ ] **Step 5: Run the tests (disposable stack).**

Run: `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -60`
Expected: api-server suite passes, including the `demo` provision/status cases. (Flag-off case runs DB-free too, but the seeded assertions need the stack.)

- [ ] **Step 6: Typecheck + commit.**

```bash
pnpm run typecheck
git add artifacts/api-server/src/routes/demo.ts artifacts/api-server/src/tests/routes/demo.test.ts artifacts/api-server/src/app.ts
git commit -m "feat(api): GET /demo/status + POST /demo/provision (TEN-013)"
```

---

### Task 7: `POST /demo/graduate`

**Files:**
- Modify: `artifacts/api-server/src/routes/demo.ts`
- Modify: `artifacts/api-server/src/tests/routes/demo.test.ts`

**Interfaces:**
- Produces: `POST /api/demo/graduate` → body `{ confirm: true }` required; `200 {}` on success; `400` if `confirm !== true`; `409`/`200-noop` if the org isn't currently a demo. **Not** flag-gated (a demo user must always be able to escape — see the demoFork.ts note).

- [ ] **Step 1: Add failing tests.** In `src/tests/routes/demo.test.ts` (same file, new `describe` block): after provisioning a demo org, `POST /demo/graduate {confirm:true}` ⇒ 200, org `is_demo=false`, the demo facility and ALL its facility-scoped rows are gone (assert `cycles`/`seed_lots`/`sensors`/`facility_logs` counts = 0 for that org), and the org row + owner membership survive; a second graduate is a safe no-op; `{confirm:false}` ⇒ 400 and no state change.

- [ ] **Step 2: Run to confirm failure.**

Run: `bash scripts/ci/test-disposable-supabase.sh 2>&1 | grep -A3 graduate`
Expected: FAIL (handler not implemented). (Graduate's assertions are all DB-backed, so they only execute under the disposable stack.)

- [ ] **Step 3: Implement the handler in `routes/demo.ts`.**

```ts
router.post("/demo/graduate", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (req.body?.confirm !== true) return res.status(400).json({ error: "Confirmation required" });
    const organizationId = await getOwnerOrg(userId);
    if (!organizationId) return res.status(403).json({ error: "No owner organization" });

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.org_id', ${organizationId.toString()}, true)`);
      const [org] = await tx.select({ isDemo: organizationsTable.isDemo }).from(organizationsTable).where(eq(organizationsTable.id, organizationId)).for("update");
      if (!org?.isDemo) return; // no-op: not a demo org (idempotent)
      // Delete every facility in the demo org (a demo org has exactly the one
      // demo facility). FK ON DELETE CASCADE tears down all facility-scoped
      // demo rows; the cascade runs at engine level, not under child-table RLS.
      await tx.delete(facilitiesTable).where(eq(facilitiesTable.organizationId, organizationId));
      await tx.update(organizationsTable).set({ isDemo: false }).where(eq(organizationsTable.id, organizationId));
    });

    return res.status(200).json({});
  } catch (err) { req.log.error(err); return res.status(500).json({ error: "Failed to graduate demo" }); }
});
```

(Also delete any org-level demo rows if the seed ever adds them — v1's seed is entirely facility-scoped + org-scoped `growth_profiles`. `growth_profiles` cascades from `organizations`, so it survives graduate since the org survives; if the demo profiles should be removed on graduate, delete `growth_profiles WHERE organization_id = org AND name LIKE '%(demo)'` in the same tx. Decide and note explicitly — recommended: delete the two `(demo)` profiles so a graduated real farm starts clean.)

- [ ] **Step 4: Run the tests (disposable stack).**

Run: `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -60`
Expected: api-server suite passes — all provision + graduate cases green, and the pgTAP `00019` proof (Task 2) still passes in the same run.

- [ ] **Step 5: Typecheck + commit.**

```bash
pnpm run typecheck
git add artifacts/api-server/src/routes/demo.ts artifacts/api-server/src/tests/routes/demo.test.ts
git commit -m "feat(api): POST /demo/graduate reset-in-place (TEN-013)"
```

---

### Task 8: OpenAPI spec + orval codegen

**Files:**
- Modify: `lib/api-spec/openapi.yaml`
- Regenerated (do not hand-edit): `lib/api-client-react/src/generated/**`, `lib/api-zod/src/generated/**`

**Interfaces:**
- Produces: generated hooks/fetchers `useGetDemoStatus`/`getDemoStatus`, `usePostDemoProvision`, `usePostDemoGraduate` (exact names follow orval's convention from the spec `operationId`s). Tasks 9/10 import these from `@workspace/api-client-react`.

- [ ] **Step 1: Add the three paths to `openapi.yaml`.** Follow the existing `/wizard/progress` and `/auth/signup-availability` entries for style (tags, `operationId`, security, response schema components). Define:
  - `GET /demo/status` → 200 `DemoStatus { enabled: boolean, isDemo: boolean, demoFacilityId: integer nullable }`.
  - `POST /demo/provision` → 200 `DemoProvisionResult { facilityId: integer }`.
  - `POST /demo/graduate` → requestBody `DemoGraduateRequest { confirm: boolean }`, 200 empty object.

- [ ] **Step 2: Regenerate the client + zod.**

Run: `pnpm --filter @workspace/api-spec run generate` (verify the exact script name in `lib/api-spec/package.json`; it invokes orval with `orval.config.ts`).
Expected: new files under both `generated/` trees; no unrelated diff churn.

- [ ] **Step 3: Typecheck the whole workspace.**

Run: `pnpm run typecheck`
Expected: PASS (generated hooks compile; dashboard still builds).

- [ ] **Step 4: Commit.**

```bash
git add lib/api-spec/openapi.yaml lib/api-client-react/src/generated lib/api-zod/src/generated
git commit -m "feat(api-spec): demo status/provision/graduate endpoints + codegen (TEN-013)"
```

---

### Task 9: W2 fork UI + `useDemoStatus`

**Files:**
- Create: `artifacts/admin-dashboard/src/hooks/use-demo-status.ts`
- Create: `artifacts/admin-dashboard/src/pages/onboarding/steps/ForkChoice.tsx`
- Modify: `artifacts/admin-dashboard/src/pages/onboarding/Wizard.tsx`

**Interfaces:**
- Consumes: `useGetDemoStatus`, `usePostDemoProvision` (Task 8); `finishAddFacility` (already passed into `Wizard` as `onFacilityCreated`).
- Produces: a new `"fork"` pseudo-step shown BEFORE `farm_basics` when `demoStatus.enabled && facilityId === null && !demoStatus.isDemo`.

- [ ] **Step 1: Implement `use-demo-status.ts`.** Thin wrapper over `useGetDemoStatus()` returning `{ enabled, isDemo, demoFacilityId, isLoading }`. Match the hook style already used elsewhere (e.g. `use-org-role.ts`).

- [ ] **Step 2: Implement `ForkChoice.tsx`.** Two large buttons on the wizard shell: "Set up your farm" (`onChoose("real")`) and "Explore a demo" (`onChoose("demo")`). Props: `{ onChoose: (c: "real" | "demo") => void; provisioning: boolean }`. Disable both while `provisioning`.

- [ ] **Step 3: Wire into `Wizard.tsx`.** Add a local `showFork` state initialized from `useDemoStatus()`:
  - Only first-run onboarding forks: gate on `facilityId === null && demoStatus.enabled && !demoStatus.isDemo && !hasResumeRow`.
  - Render `<ForkChoice/>` INSTEAD of the `farm_basics` step while `showFork` is true.
  - "Set up your farm" ⇒ `setShowFork(false)` (falls through to the existing `farm_basics` step — zero behavior change vs TEN-012).
  - "Explore a demo" ⇒ call `usePostDemoProvision().mutateAsync()`; on success, `finishAddFacility(facilityId, organizationId)` (same callback `FarmBasics` uses) so `FacilityGate` re-evaluates and lands the user on the populated dashboard. Invalidate the `useActiveFacility`/facilities query so the new demo facility appears.
  - **Flag-off / already-onboarded path is untouched:** when `demoStatus.enabled` is false the fork never renders and `Wizard` opens on `farm_basics` exactly as today.

- [ ] **Step 4: Typecheck + build the dashboard.**

Run: `pnpm --filter <dashboard-package> run build` (find the package name in `artifacts/admin-dashboard/package.json`) `&& pnpm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add artifacts/admin-dashboard/src/hooks/use-demo-status.ts artifacts/admin-dashboard/src/pages/onboarding/steps/ForkChoice.tsx artifacts/admin-dashboard/src/pages/onboarding/Wizard.tsx
git commit -m "feat(dashboard): W2 demo fork screen + useDemoStatus (TEN-013)"
```

---

### Task 10: Persistent demo banner + graduate CTA

**Files:**
- Create: `artifacts/admin-dashboard/src/components/layout/DemoBanner.tsx`
- Modify: `artifacts/admin-dashboard/src/components/layout/AppLayout.tsx`

**Interfaces:**
- Consumes: `useDemoStatus` (Task 9), `usePostDemoGraduate` (Task 8), `useActiveFacility` (to refresh after graduate).

- [ ] **Step 1: Implement `DemoBanner.tsx`.** Renders `null` unless `useDemoStatus().isDemo`. When demo: an app-wide banner "You're exploring a demo — Set up my real farm" with a CTA button that opens a confirm dialog (reuse the project's existing dialog/`AlertDialog` component). On confirm ⇒ `usePostDemoGraduate().mutateAsync({ data: { confirm: true } })`; on success ⇒ invalidate the demo-status query AND the facilities query so `FacilityGate` re-evaluates (org now `is_demo=false`, demo facility gone ⇒ `facilities.length === 0` ⇒ `Wizard` opens on `farm_basics` for real setup). Show a spinner/disabled state while graduating.

- [ ] **Step 2: Render it in `AppLayout.tsx`.** Mount `<DemoBanner/>` at the top of the layout chrome (above the routed content) so it's visible on every dashboard screen. It self-hides when not a demo, so it is inert for normal users.

- [ ] **Step 3: Typecheck + build.**

Run: `pnpm --filter <dashboard-package> run build && pnpm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add artifacts/admin-dashboard/src/components/layout/DemoBanner.tsx artifacts/admin-dashboard/src/components/layout/AppLayout.tsx
git commit -m "feat(dashboard): persistent demo banner + graduate CTA (TEN-013)"
```

---

### Task 11: Cross-tenant isolation proof + flag-off regression

**Files:**
- Modify: `artifacts/api-server/src/tests/routes/demo.test.ts` (add isolation cases)
- Optionally add: `artifacts/api-server/src/tests/isolation/demo-cross-tenant.test.ts` if the isolation cases fit the existing `src/tests/isolation/cross-tenant.test.ts` harness better than the route test file (check that file first and follow whichever pattern is cleaner).

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add cross-tenant tests.** In `src/tests/routes/demo.test.ts` (or `src/tests/isolation/demo-cross-tenant.test.ts`), `node:test` DB-backed: user B (a different org's owner, seeded via a second `seedTenantContext`/admin insert) calling `GET /demo/status` sees only THEIR own org's `isDemo` (never A's), and `POST /demo/graduate` as B never deletes A's demo facility. Provision by A then, as B, assert A's demo rows are untouched. Assert end-state (row presence/absence), not error codes, for the RLS-scoped paths (per the RLS-denied-writes rule).

- [ ] **Step 2: Add the flag-off regression.** With `DEMO_FORK_ENABLED` unset (restore in `afterEach`): `POST /demo/provision` ⇒ 403 and no rows written; `GET /demo/status` ⇒ `enabled:false`. The 403 assertion is DB-free (the guard returns before any query); the "no rows written" check needs the stack. Add a code comment that the dashboard flag-off UI path (fork never renders, `Wizard` opens on `farm_basics`) is verified manually / by the Task 9 build, not here.

- [ ] **Step 3: Run the full api-server suite via the disposable stack.**

Run: `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -80`
Expected: PASS — the whole api-server `node:test` suite (no regressions in wizard/facilities/tenantContext) plus the new demo isolation + flag-off cases, and every pgTAP file. Report the total test count from the tail output.

- [ ] **Step 4: Commit.**

```bash
git add artifacts/api-server/src/tests/routes/demo.test.ts artifacts/api-server/src/tests/isolation/demo-cross-tenant.test.ts
git commit -m "test(api): demo cross-tenant isolation + flag-off regression (TEN-013)"
```

(Drop the `isolation/…` path from the `git add` if you kept everything in the route test file.)

---

## Rollback Points

- **Task 1 (column):** down = `ALTER TABLE organizations DROP COLUMN is_demo;` (additive, no data dependency until Task 6 ships).
- **Task 2 (RLS):** down = `DROP POLICY organizations_backend_update ON organizations; DROP POLICY facilities_backend_delete ON facilities;` (additive policies; dropping them only removes the demo write paths).
- **Flag (Task 3):** `DEMO_FORK_ENABLED` unset/false instantly disables the fork + provision with no code revert — TEN-012's direct-to-`farm_basics` landing is the fallback. Graduate stays available so no demo user is trapped.
- **Endpoints (Tasks 6–7):** additive routes; with the flag off, provision is inert and the wizard is unchanged. Graduate is confirm-guarded and single-transaction, so a mid-reset failure leaves the demo intact for retry.
- **UI (Tasks 9–10):** the fork screen and banner both self-hide when `enabled`/`isDemo` are false, so reverting is a flag flip; the components add no behavior for non-demo users.

## Out of Scope (YAGNI)

Org-level switcher / multi-org membership; time-based or abandoned-demo purge; re-entering demo after graduating (one-way); mobile demo fork (TEN-014); the `farmsmart_recommender` read-scoped role rotation follow-up (parked separately on the TEN-013 task, not part of this build).

## Self-Review Notes (author)

- **Spec coverage:** is_demo column (T1), provisioning endpoint + shared seed + idempotency (T4/T6), graduate reset-in-place via cascade (T7), rich seed across all screens (T4), fork UI + persistent banner (T9/T10), `DEMO_FORK_ENABLED` default off (T3, gated in T6/T9), tenant/RLS safety under `farmsmart_app` (T2/T11), testing incl. cross-tenant + flag-off (T6/T7/T11), reversible migrations + rollback points (T1/T2/above), CLI refactor preserving a guard (T5) — all mapped.
- **Cascade risk (spec's headline open item) is resolved in T4's audit** by forbidding `manual_checks`/`bad_tray_entries` in the seed and proving the facility-delete cascade in T4's test.
- **RLS gap discovered during planning** (no `organizations` UPDATE, no `facilities` DELETE policy for `farmsmart_app`) is closed in T2 — this is the exact class of gap the BYPASSRLS CI DB masks; without it, provision/graduate would silently update/delete 0 rows in production.
- **No-facility-at-fork constraint:** provision/graduate deliberately resolve org from owner membership (not `req.tenant`), and set `app.facility_id` mid-transaction after the facility insert — noted in Global Constraints and T6.
