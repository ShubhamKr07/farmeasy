# TEN-008 Multi-Facility Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an organization hold 1..n facilities, add new ones through the existing onboarding wizard, and switch the "active facility" from a real switcher UI on both web and mobile — every facility-scoped backend call re-validated per request against a client-sent `X-Facility-Id` header, never a cached/trusted value.

**Architecture:** `resolveTenantContext` stops assuming "the org's one facility" and instead resolves `req.tenant` from an explicit `X-Facility-Id` header, re-validated against real `organization_members`/`facilities` rows on every request. `wizard_progress` becomes per-`(user_id, facility_id)` (nullable `facility_id` until the facility itself is created) so "Add facility" reuses the existing `Wizard.tsx` component unmodified. `custom-fetch.ts` gains a `setFacilityId()` sibling to the existing auth-token attachment — the one chokepoint both `admin-dashboard` (web) and `farmeasy` (mobile) already share. Mobile gets a read-and-switch-only facility switcher (profile sheet); it never creates facilities or runs the wizard (technicians authenticate on mobile only, and by design a facility switched to on mobile must already exist).

**Tech Stack:** Express + Drizzle ORM + Postgres (Supabase) on the backend; React + Vite + wouter + TanStack Query + shadcn/ui (`admin-dashboard`); Expo Router + React Native + TanStack Query (`farmeasy`); orval-generated hooks from `lib/api-spec/openapi.yaml` shared by both frontends via `lib/api-client-react`.

## Global Constraints

- pnpm only. `pnpm run typecheck` must pass before merge (root CLAUDE.md).
- `X-Facility-Id` is a hard requirement with no fallback default on every facility-scoped route — missing or invalid → 400, never a silent default to "some" facility.
- `GET`/`PUT /wizard/progress` are the one deliberate exception: never require `X-Facility-Id` (the bootstrap/add-facility case has no facility yet). They resolve via an optional `facilityId` **query parameter** instead (not the header — keeps the header's "hard-required, org-validated" semantics from leaking onto the one route pair explicitly exempt from it).
- No role restriction on who can add a facility (TEN-010's scope, not this one).
- v1 membership visibility: all org members (owner/admin/technician) see all of the org's facilities and can switch freely — switching is a client-side selection change only, re-validated per request by `resolveTenantContext`, never a re-authentication event.
- Mobile (`farmeasy`) never creates facilities and never runs the onboarding wizard. "Add facility" is web-only (`admin-dashboard`), reusing the existing `Wizard.tsx` unmodified.
- Run `scripts/ci/test-disposable-supabase.sh` locally (Docker required) before opening a PR — the only thing that replays the exact CI path (lesson from MT-M1).
- Every migration that changes `wizard_progress`'s shape needs `supabase/tests/00001_foundation.sql`'s Drizzle migration-count assertion bumped to match.

---

### Task 1: `wizard_progress` schema — add nullable `facility_id` column (expand)

**Files:**
- Modify: `lib/db/src/schema/index.ts:390-403` (`wizardProgressTable`)
- Create: `lib/db/drizzle/0026_wizard_progress_facility_id.sql` (generated, verify against the literal content below)

**Interfaces:**
- Produces: `wizardProgressTable.facilityId` (nullable `integer`, FK → `facilities.id` `ON DELETE CASCADE`) — consumed by Tasks 2, 3, 7.

- [ ] **Step 1: Add the column to the schema**

Edit `lib/db/src/schema/index.ts`, in the `wizardProgressTable` definition (currently lines 390-403):

```ts
export const wizardProgressTable = pgTable(
  "wizard_progress",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => usersTable.id),
    organizationId: integer("organization_id").references(() => organizationsTable.id),
    facilityId: integer("facility_id").references(() => facilitiesTable.id, { onDelete: "cascade" }),
    currentStep: wizardStepEnum("current_step").notNull().default("farm_basics"),
    stepData: jsonb("step_data").notNull().default({}),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("wizard_progress_user_id_uniq").on(table.userId),
    index("wizard_progress_facility_id_idx").on(table.facilityId),
  ],
);
```

(Only the `facilityId` field and the new `index(...)` line are additions — the old `uniqueIndex("wizard_progress_user_id_uniq")` stays for now; Task 3 replaces it. Adding a plain index here, not yet the composite unique one, keeps this step purely additive.)

- [ ] **Step 2: Generate the migration**

Run: `cd lib/db && DATABASE_URL=postgresql://placeholder pnpm run db:generate -- --name wizard_progress_facility_id`

(`DATABASE_URL` only needs to parse for `drizzle-kit generate` to run — it does not connect. Use your real `TEST_DATABASE_URL`/staging connection string if you have one handy instead of the placeholder.)

- [ ] **Step 3: Verify the generated file matches**

Read `lib/db/drizzle/0026_wizard_progress_facility_id.sql` and confirm it is exactly:

```sql
ALTER TABLE "wizard_progress" ADD COLUMN "facility_id" integer;--> statement-breakpoint
ALTER TABLE "wizard_progress" ADD CONSTRAINT "wizard_progress_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wizard_progress_facility_id_idx" ON "wizard_progress" USING btree ("facility_id");
```

If `drizzle-kit` produced different constraint/index names, rename the file's identifiers to match these exactly and edit `lib/db/drizzle/meta/_journal.json`'s new entry's `tag` field to `0026_wizard_progress_facility_id` (mirrors every prior migration's naming convention — see `0018`-`0025`).

- [ ] **Step 4: Bump the pgTAP migration-count assertion**

Edit `supabase/tests/00001_foundation.sql`:

```sql
SELECT is(
  (SELECT count(*) FROM drizzle.__drizzle_migrations)::integer,
  27,
  'drizzle.__drizzle_migrations has exactly 27 rows (full migration history replayed)'
);
```

(Was 26; this migration is the 27th. Also update the file's own doc comment above this assertion — "0025_backfill_organization_members.sql, MT-M1 Task 1, is the most recent addition" — to instead cite `0026_wizard_progress_facility_id.sql`.)

- [ ] **Step 5: Run the migration against your local/test database and verify**

Run: `cd lib/db && pnpm run db:migrate`
Expected: no errors; `psql $TEST_DATABASE_URL -c "\d wizard_progress"` shows a new nullable `facility_id integer` column with an FK to `facilities(id)`.

- [ ] **Step 6: Commit**

```bash
git add lib/db/src/schema/index.ts lib/db/drizzle/0026_wizard_progress_facility_id.sql lib/db/drizzle/meta/_journal.json supabase/tests/00001_foundation.sql
git commit -m "feat(db): add nullable facility_id column to wizard_progress (TEN-008 expand step)"
```

---

### Task 2: `wizard_progress.facility_id` — backfill existing rows

**Files:**
- Create: `lib/db/drizzle/0027_wizard_progress_facility_id_backfill.sql`
- Modify: `lib/db/drizzle/meta/_journal.json`
- Modify: `supabase/tests/00001_foundation.sql`

**Interfaces:**
- Consumes: Task 1's `wizard_progress.facility_id` column.
- Produces: every pre-existing `wizard_progress` row (for a user who already has an organization) now has its real `facility_id` populated — consumed by Task 3's `NOT NULL`-adjacent contract (the partial-unique-index invariant).

- [ ] **Step 1: Write the hand-authored backfill migration**

Create `lib/db/drizzle/0027_wizard_progress_facility_id_backfill.sql`:

```sql
-- Hand-written (not generated by drizzle-kit) -- same convention as
-- 0019_backfill_tenancy_scoping.sql and 0024's backfill half.
--
-- At the moment this migration runs, POST /facilities's pre-TEN-008 409 gate
-- (facilities.ts's AlreadyHasFacilityError, removed in this same milestone's
-- Task 4) has never allowed a second facility per organization -- so this
-- JOIN matches at most exactly one facilities row per user, never more. A
-- user with no organization yet (wizard still in progress, never reached W2's
-- POST /facilities) correctly stays facility_id IS NULL: that row IS the
-- in-progress wizard run Task 3's partial unique index protects.
UPDATE wizard_progress wp
SET facility_id = f.id
FROM users u
JOIN facilities f ON f.organization_id = u.organization_id
WHERE wp.user_id = u.id
  AND wp.facility_id IS NULL
  AND u.organization_id IS NOT NULL;
```

- [ ] **Step 2: Add the journal entry**

Edit `lib/db/drizzle/meta/_journal.json`, appending after the `0026` entry (use the next sequential `idx`/an incrementing `when` timestamp, mirroring every prior entry's shape):

```json
    {
      "idx": 27,
      "version": "7",
      "when": 1785781257624,
      "tag": "0027_wizard_progress_facility_id_backfill",
      "breakpoints": true
    }
```

- [ ] **Step 3: Bump the pgTAP migration-count assertion**

Edit `supabase/tests/00001_foundation.sql`, `27` → `28` in the same assertion Task 1 touched, and its doc comment to cite `0027_wizard_progress_facility_id_backfill.sql` as the most recent addition.

- [ ] **Step 4: Run the migration and verify**

Run: `cd lib/db && pnpm run db:migrate`
Then: `psql $TEST_DATABASE_URL -c "SELECT user_id, facility_id FROM wizard_progress;"`
Expected: every row whose user has an `organizationId` shows a non-null `facility_id` matching that org's (only) facility; rows for in-progress, facility-less users still show `NULL`.

- [ ] **Step 5: Commit**

```bash
git add lib/db/drizzle/0027_wizard_progress_facility_id_backfill.sql lib/db/drizzle/meta/_journal.json supabase/tests/00001_foundation.sql
git commit -m "feat(db): backfill wizard_progress.facility_id for existing rows (TEN-008)"
```

---

### Task 3: `wizard_progress` — contract to per-`(user_id, facility_id)` uniqueness

**Files:**
- Modify: `lib/db/src/schema/index.ts` (`wizardProgressTable`'s index array)
- Create: `lib/db/drizzle/0028_wizard_progress_facility_id_uniq.sql`
- Modify: `lib/db/drizzle/meta/_journal.json`
- Modify: `supabase/tests/00001_foundation.sql`

**Interfaces:**
- Consumes: Task 2's fully-backfilled `facility_id` column.
- Produces: `UNIQUE(user_id, facility_id)` for real facilities, `UNIQUE(user_id) WHERE facility_id IS NULL` for the "at most one in-progress, not-yet-facility-created wizard run" invariant — consumed by Task 7's `PUT /wizard/progress` upsert target.

- [ ] **Step 1: Replace the old index in the schema**

Edit `lib/db/src/schema/index.ts`'s `wizardProgressTable` (from Task 1's shape), replacing the index array:

```ts
  (table) => [
    uniqueIndex("wizard_progress_user_id_facility_id_uniq").on(table.userId, table.facilityId),
    uniqueIndex("wizard_progress_user_id_no_facility_uniq")
      .on(table.userId)
      .where(sql`${table.facilityId} IS NULL`),
    index("wizard_progress_facility_id_idx").on(table.facilityId),
  ],
```

(Postgres treats every NULL as distinct within a unique index, single- or multi-column — so `wizard_progress_user_id_facility_id_uniq` alone would never actually constrain the `facility_id IS NULL` rows. The separate partial index is what enforces "at most one in-progress run per user.")

- [ ] **Step 2: Write the hand-authored contract migration**

Create `lib/db/drizzle/0028_wizard_progress_facility_id_uniq.sql`:

```sql
-- Hand-written (not generated by drizzle-kit) -- same convention as 0020's
-- contract half. Drops the old per-user-only uniqueness (wrong once a user
-- can have one wizard_progress row per facility) and replaces it with the
-- two indexes the schema now declares: a composite unique for real
-- facilities, plus a partial unique (facility_id IS NULL) so at most one
-- in-progress "which facility am I even creating" run can exist per user at
-- a time.
DROP INDEX "wizard_progress_user_id_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX "wizard_progress_user_id_facility_id_uniq" ON "wizard_progress" USING btree ("user_id","facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wizard_progress_user_id_no_facility_uniq" ON "wizard_progress" USING btree ("user_id") WHERE "wizard_progress"."facility_id" IS NULL;
```

- [ ] **Step 3: Add the journal entry**

Edit `lib/db/drizzle/meta/_journal.json`:

```json
    {
      "idx": 28,
      "version": "7",
      "when": 1785781258624,
      "tag": "0028_wizard_progress_facility_id_uniq",
      "breakpoints": true
    }
```

- [ ] **Step 4: Bump the pgTAP migration-count assertion**

Edit `supabase/tests/00001_foundation.sql`, `28` → `29`, doc comment now citing `0028_wizard_progress_facility_id_uniq.sql`.

- [ ] **Step 5: Run and verify**

Run: `cd lib/db && pnpm run db:migrate`
Then: `psql $TEST_DATABASE_URL -c "\d wizard_progress"` — confirm `wizard_progress_user_id_uniq` is gone and both new indexes are present.
Then, to prove the partial index actually works: insert two rows for a fresh synthetic `user_id` both with `facility_id = NULL` — the second insert must fail with a unique-violation on `wizard_progress_user_id_no_facility_uniq`.

- [ ] **Step 6: Commit**

```bash
git add lib/db/src/schema/index.ts lib/db/drizzle/0028_wizard_progress_facility_id_uniq.sql lib/db/drizzle/meta/_journal.json supabase/tests/00001_foundation.sql
git commit -m "feat(db): contract wizard_progress to per-(user_id, facility_id) uniqueness (TEN-008)"
```

---

### Task 4: `resolveTenantContext` — resolve facility from `X-Facility-Id`, not "the org's one facility"

**Files:**
- Modify: `artifacts/api-server/src/middlewares/tenantContext.ts`

**Interfaces:**
- Consumes: `organizationMembersTable`, `facilitiesTable` (unchanged from today).
- Produces: `req.tenant = { organizationId, facilityId, role }` — **same shape as today**, only the lookup key changes. `requireTenantContext` now 400s (was 403) when `req.tenant` is unset, matching the design's "missing/invalid header is a client-bug class" error handling.

- [ ] **Step 1: Rewrite the membership lookup to key on the header**

Edit `artifacts/api-server/src/middlewares/tenantContext.ts`. Replace the whole `resolveTenantContext` function body's `dbOperation` closure and its surrounding doc comment:

```ts
/**
 * Resolves { organizationId, facilityId, role } from organization_members +
 * facilities and attaches it to req.tenant. Never rejects — mirrors
 * supabaseAuthMiddleware's own "attach if present, let the route decide"
 * pattern (see that file's doc comment). Routes that are part of onboarding
 * itself (POST /facilities, GET /facilities/me, wizard progress) run for
 * users who by definition have no membership yet; a rejecting middleware
 * here would break exactly those flows. Routes that DO require tenant
 * context use requireTenantContext (below), mounted per-router, the same way
 * app.ts already mounts requireSignedIn selectively.
 *
 * TEN-008: facility resolution is now the client's explicit choice, not "the
 * org's one facility" — the client sends X-Facility-Id on every
 * facility-scoped request, and this resolver re-validates it against real
 * organization_members/facilities rows on every single request (never
 * trusts a cached/prior-validated value, matching withTenantScope's own
 * per-request-reverified design). Missing or unparseable header: req.tenant
 * stays unset, same as any other unresolvable case — requireTenantContext
 * surfaces this as a 400 (a client-bug class, not a 403/404 — the
 * resource-ownership question doesn't even apply if the client hasn't named
 * a real facility yet).
 *
 * db/drizzle imports are deferred to dynamic imports inside this function so
 * that merely importing the module (e.g. in unit tests for
 * requireTenantContext) does not trigger @workspace/db initialization,
 * which requires DATABASE_URL to be set.
 */
export async function resolveTenantContext(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  // Public liveness/readiness probes must stay DB-free (see health.ts) —
  // never resolve tenant context for them, even if an identity is attached.
  if (PUBLIC_PROBE_PATHS.has(req.path)) return next();

  const userId = req.supabaseUser?.sub ?? null;
  if (!userId) return next();

  const facilityIdHeader = req.header("x-facility-id");
  if (!facilityIdHeader) return next();
  const facilityId = Number(facilityIdHeader);
  if (!Number.isInteger(facilityId) || facilityId <= 0) return next();

  // Never reject: a DB error (unreachable, wrong DB, transient, or timeout)
  // must not break the request — this mirrors supabaseAuthMiddleware's own
  // attach-if-present-then-let-the-route-decide contract (see the doc comment
  // above). Routes that genuinely need tenant context mount
  // requireTenantContext, which 400s on a missing req.tenant — the route,
  // not the resolver, decides.
  try {
    // Defer db import to avoid initialization errors when DATABASE_URL is
    // unset (e.g. unit tests that only exercise requireTenantContext).
    const dbOperation = async () => {
      const { eq, and } = await import("drizzle-orm");
      const { db, organizationMembersTable, facilitiesTable } = await import("@workspace/db");

      // organization_members' backend-role SELECT policy (00012) is
      // unqualified (current_user = 'farmsmart_app', not scoped by userId) --
      // safe here only because this WHERE clause itself filters by userId
      // before any RLS-admitted row reaches the app. If a future endpoint
      // ever lists OTHER users' memberships, it must carry its own explicit
      // org/facility filter -- RLS will not scope that query for you.
      //
      // The facilitiesTable.id equality (the client's requested facility)
      // is what makes this a real per-request re-validation rather than a
      // trust-the-header lookup: a facility id that exists but belongs to an
      // org this user isn't an active member of matches nothing here, same
      // as an outright bogus id.
      const [membership] = await db
        .select({
          organizationId: organizationMembersTable.organizationId,
          role: organizationMembersTable.role,
          facilityId: facilitiesTable.id,
        })
        .from(organizationMembersTable)
        .innerJoin(
          facilitiesTable,
          eq(facilitiesTable.organizationId, organizationMembersTable.organizationId),
        )
        .where(
          and(
            eq(organizationMembersTable.userId, userId),
            eq(organizationMembersTable.status, "active"),
            eq(facilitiesTable.id, facilityId),
          ),
        )
        .limit(1);

      return membership ?? null;
    };

    // Race the lookup against a hard timeout so a hung query or a
    // pool-connect stall can never pin the request (or hang the process, as
    // it did before this bound existed). On timeout the resolver resolves
    // null → req.tenant stays unset → requireTenantContext (where mounted)
    // surfaces the missing membership.
    const membership = await withTimeout(dbOperation(), TENANT_LOOKUP_TIMEOUT_MS);

    if (membership) {
      req.tenant = {
        organizationId: membership.organizationId,
        facilityId: membership.facilityId,
        role: membership.role,
      };
    }
  } catch (error) {
    // DB unavailable or query failed (import error, connection refused, auth
    // failure, etc.): leave req.tenant unset and proceed. requireTenantContext
    // (where mounted) is what surfaces a missing membership to the client;
    // this resolver never turns a DB blip into a request failure. Logged at
    // warn (not error) because an unreachable DB in dev/test is expected, and
    // the message is reduced to the error message (no stack) so it can't spam
    // stderr on every request when the DB is down.
    console.warn(
      "[tenantContext] membership lookup failed; req.tenant unset:",
      error instanceof Error ? error.message : error,
    );
  }
  return next();
}
```

- [ ] **Step 2: Update `requireTenantContext` to 400, not 403**

In the same file, replace:

```ts
export function requireTenantContext(req: Request, res: Response, next: NextFunction) {
  if (!req.tenant) {
    return res.status(403).json({ error: "No facility membership found" });
  }
  return next();
}
```

with:

```ts
/**
 * Assertion middleware for routes that require resolved tenant context —
 * mount per-router, same pattern as app.ts's requireSignedIn. 400, not
 * 403/404: a missing or invalid X-Facility-Id (including a real facility id
 * that belongs to an org this user isn't an active member of) is a
 * client-bug class distinct from a resource-ownership 404 (Task 5+ style) or
 * an identity/authorization 403 — the client simply hasn't named a real,
 * accessible facility for this request yet (TEN-008 error-handling design).
 */
export function requireTenantContext(req: Request, res: Response, next: NextFunction) {
  if (!req.tenant) {
    return res.status(400).json({ error: "Missing or invalid X-Facility-Id" });
  }
  return next();
}
```

- [ ] **Step 3: Update the module-level doc comment's stale facility-resolution note**

Still in this file, the earlier module-level comment block (around what's now line 60) says: "Facility resolution is 'the org's one facility' ... MT-M2's TEN-008 changes this lookup when multi-facility ships." Delete that paragraph entirely — it's now stale (this task IS that change).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @workspace/api-server run typecheck` (or `pnpm run typecheck` from repo root)
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add artifacts/api-server/src/middlewares/tenantContext.ts
git commit -m "feat(api): resolve tenant context from X-Facility-Id header, not org's one facility (TEN-008)"
```

---

### Task 5: Test helpers — `createAuthenticatedTestApp` auto-attaches `X-Facility-Id`

**Why this task exists, before any other test file changes:** Task 4 makes every existing facility-scoped route test start failing (no test currently sends `X-Facility-Id`, and `resolveTenantContext` no longer resolves a facility without one). Retrofitting every individual `request(app).get(...)` call across ~9 test files would be a huge, error-prone diff. Instead, the test double that already injects `req.supabaseUser` gains one more injected header, so most call sites only need a one-line change at their `createAuthenticatedTestApp(...)` call, not at every request.

**Files:**
- Modify: `artifacts/api-server/src/tests/helpers/testApp.ts`

**Interfaces:**
- Produces: `createAuthenticatedTestApp(router, user?, facilityId?)` — new optional third parameter. When provided, every request through the returned app carries `X-Facility-Id: <facilityId>` automatically, before `resolveTenantContext` runs. Consumed by Task 6's test-file updates.

- [ ] **Step 1: Add the optional `facilityId` parameter**

Edit `artifacts/api-server/src/tests/helpers/testApp.ts`:

```ts
/**
 * Build a standalone Express app for supertest that mirrors the production
 * wiring in app.ts — JSON body parsing, request identity, and `router`
 * mounted under `/api` — but with a test double in place of real auth.
 *
 * Instead of running `supabaseAuthMiddleware` (which verifies a live JWT
 * against Supabase's remote JWKS), a tiny middleware sets `req.supabaseUser`
 * directly from `user`. That mirrors the real `supabaseUser` shape
 * (src/middlewares/supabaseAuth.ts:21-28) so route handlers and `getAuth`
 * behave exactly as in production. This is a test double for auth, not a
 * bypass of the production app: app.ts and its real middleware chain are
 * never touched.
 *
 * `facilityId`, when provided, is injected as an `X-Facility-Id` request
 * header the same way — a test double standing in for the real client
 * header TEN-008's resolveTenantContext now requires on every
 * facility-scoped request, not a bypass of that resolver (it still runs for
 * real and still re-validates the value against real
 * organization_members/facilities rows). Omit it for routes that are
 * genuinely org-scoped or pre-facility-existence (sensor-accounts,
 * facilities, wizard progress) and don't need it.
 *
 *   const app = createAuthenticatedTestApp(shipmentsRouter, DEFAULT_TEST_USER, facilityId);
 *   const res = await request(app).get("/api/shipments");
 */
export function createAuthenticatedTestApp(
  router: Router,
  user: { sub: string; user_role?: string } = DEFAULT_TEST_USER,
  facilityId?: number,
): Express {
  const app = express();
  // Mirror app.ts: parse JSON bodies before route handlers consume them.
  app.use(express.json());
  // Test double for supabaseAuthMiddleware: attach identity verbatim.
  // Mounted before the router so every handler sees req.supabaseUser, just as
  // requireSignedIn (app.ts) sees it after the real middleware populates it
  // from a verified token.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.supabaseUser = user;
    req.log = testLogger;
    if (facilityId !== undefined) {
      req.headers["x-facility-id"] = String(facilityId);
    }
    next();
  });
  app.use(resolveTenantContext);
  app.use("/api", router);
  return app;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @workspace/api-server run typecheck`
Expected: no errors (the new parameter is optional — every existing call site with 1 or 2 args still compiles).

- [ ] **Step 3: Commit**

```bash
git add artifacts/api-server/src/tests/helpers/testApp.ts
git commit -m "test(api): createAuthenticatedTestApp injects X-Facility-Id for facility-scoped test apps (TEN-008)"
```

---

### Task 6: Update existing test call sites to pass `facilityId`

**Files:**
- Modify: `artifacts/api-server/src/tests/routes/tasks.test.ts`
- Modify: `artifacts/api-server/src/tests/routes/shipments.test.ts`
- Modify: `artifacts/api-server/src/tests/routes/inventory.test.ts`
- Modify: `artifacts/api-server/src/tests/routes/seedLots.test.ts`
- Modify: `artifacts/api-server/src/tests/routes/sensors-bulk.test.ts`
- Modify: `artifacts/api-server/src/tests/isolation/cross-tenant.test.ts`

**Interfaces:**
- Consumes: Task 5's `createAuthenticatedTestApp(router, user, facilityId)`.

This task is mechanical: every file below already calls `seedTenantContext(...)` and destructures its returned `facilityId` in the same `setup()`/`before()` function that also calls `createAuthenticatedTestApp`. Pass that same `facilityId` as the third argument.

- [ ] **Step 1: `tasks.test.ts`**

In its `setup()` function (around line 56-65), change:

```ts
      const { facilityId } = await seedTenantContext(
```

...(context unchanged)... to capture `facilityId` before `createAuthenticatedTestApp` is called, then change:

```ts
        app: createAuthenticatedTestApp(tasks.default),
```

to:

```ts
        app: createAuthenticatedTestApp(tasks.default, DEFAULT_TEST_USER, facilityId),
```

(`DEFAULT_TEST_USER` is already imported in this file per the existing `import { createAuthenticatedTestApp, DEFAULT_TEST_USER } from "../helpers/testApp";` line — if `setup()`'s original call passed no second argument, keep passing `DEFAULT_TEST_USER` explicitly now that a third argument is needed.)

- [ ] **Step 2: `shipments.test.ts`**

Same change: `createAuthenticatedTestApp(shipments.default)` → `createAuthenticatedTestApp(shipments.default, DEFAULT_TEST_USER, facilityId)`, using the `facilityId` already destructured from that file's own `seedTenantContext(...)` call.

- [ ] **Step 3: `inventory.test.ts`**

Same change: `createAuthenticatedTestApp(inventory.default)` → `createAuthenticatedTestApp(inventory.default, DEFAULT_TEST_USER, facilityId)`. (This file imports `createAuthenticatedTestApp` without also importing `DEFAULT_TEST_USER` — add it to the existing import: `import { createAuthenticatedTestApp, DEFAULT_TEST_USER } from "../helpers/testApp";`.)

- [ ] **Step 4: `seedLots.test.ts`**

This file seeds two facilities (`facilityAId`/`facilityA`/`facilityB`) for its cross-facility lookup test. Its one `createAuthenticatedTestApp(seedLots.default)` call (around line 94) is scoped to facility A — change it to:

```ts
      app: createAuthenticatedTestApp(seedLots.default, DEFAULT_TEST_USER, facilityAId),
```

- [ ] **Step 5: `sensors-bulk.test.ts`**

Same change: `createAuthenticatedTestApp(sensors.default)` → `createAuthenticatedTestApp(sensors.default, DEFAULT_TEST_USER, facilityId)`, using the `facilityId` its own `seedTenantContext(...)` call already returns.

- [ ] **Step 6: `cross-tenant.test.ts`**

This file's `provisionOrg` helper (around line 93-102) creates the test app **before** the facility exists yet (`POST /facilities` is the very next call, run through that same app — `facilities.ts` itself never requires the header). Change `provisionOrg` to build the app once for the pre-facility bootstrap call, then rebuild it with the header once the facility id is known:

```ts
    async function provisionOrg(email: string) {
      const userId = randomUUID();
      await seedTestUser(db, usersTable, { id: userId, email });
      const bootstrapApp = createAuthenticatedTestApp(combinedRouter, { sub: userId });
      const createRes = await request(bootstrapApp)
        .post("/api/facilities")
        .send({ farmName: `Org for ${email}`, timezone: "UTC", units: "metric", currency: "USD" });
      strictEqual(createRes.status, 201, `facility creation for ${email} must succeed`);
      const facilityId = createRes.body.facilityId as number;
      const app = createAuthenticatedTestApp(combinedRouter, { sub: userId }, facilityId);
      return { app, facilityId, userId };
    }
```

**Do not** change any of the individual `request(orgA.app)...`/`request(orgB.app)...` calls later in this file — they all go through the rebuilt `app` (with the header baked in) returned above.

- [ ] **Step 7: Files that need NO change (verify, don't edit)**

Confirm (read each file, don't modify) that these stay untouched — they're genuinely exempt:
- `sensor-accounts.test.ts` — org-scoped route, no `req.tenant`/facility header involved.
- `facility-readiness.test.ts` — Task 8 changes this route to become facility-scoped; its test file is updated there, not here.
- `wizard.test.ts` — Task 7 changes `wizard.ts` to use a query param, not the header; its test file is updated there.
- `facilities.test.ts` — exercises `POST /facilities` (pre-facility-existence) and `GET /facilities/me`; no header needed for either.
- `smoke.test.ts`, `health.test.ts` — no tenant-scoped routes involved.

- [ ] **Step 8: Run the full API server test suite**

Run: `TEST_DATABASE_URL=<your test db url> pnpm --filter @workspace/api-server test`
Expected: all tests pass (the six files touched above, plus every file confirmed exempt in Step 7).

- [ ] **Step 9: Commit**

```bash
git add artifacts/api-server/src/tests/routes/tasks.test.ts artifacts/api-server/src/tests/routes/shipments.test.ts artifacts/api-server/src/tests/routes/inventory.test.ts artifacts/api-server/src/tests/routes/seedLots.test.ts artifacts/api-server/src/tests/routes/sensors-bulk.test.ts artifacts/api-server/src/tests/isolation/cross-tenant.test.ts
git commit -m "test(api): pass facilityId to createAuthenticatedTestApp for TEN-008's required X-Facility-Id header"
```

---

### Task 7: `facilities.ts` and `wizard.ts` — remove the one-facility gate, thread `facilityId`

**Files:**
- Modify: `artifacts/api-server/src/routes/facilities.ts`
- Modify: `artifacts/api-server/src/routes/wizard.ts`
- Modify: `artifacts/api-server/src/tests/routes/facilities.test.ts`
- Modify: `artifacts/api-server/src/tests/routes/wizard.test.ts`

**Interfaces:**
- Produces: `GET /facilities` (new, list endpoint) — `Facility[]` with an added `onboarded: boolean` per facility (derived from that facility's own `wizard_progress` row, not the checklist's `completedCount` — see Step 2's reasoning). `GET /wizard/progress?facilityId=<id>` and `PUT /wizard/progress` body gains optional `facilityId`.

- [ ] **Step 1: Remove the `AlreadyHasFacilityError` 409 gate from `POST /facilities`**

Edit `artifacts/api-server/src/routes/facilities.ts`. Delete the `AlreadyHasFacilityError` class, its throw site, and its catch branch; delete the now-unnecessary `SELECT ... FOR UPDATE` locking read (it existed purely to serialize the 409 check — TEN-008 allows any number of facilities per org, so there is no "already has one" race left to close). Replace the whole `POST /facilities` handler:

```ts
// POST /facilities — W2 farm-basics submit (WIZ-001/TEN-001/TEN-003), and
// TEN-008's "Add facility" re-entry into the same wizard for an org that
// already has one or more facilities. Creates an organization (first-time
// only — see below), a facility, and its 3 index-1 rooms
// (seeding/fertigation/harvesting) in a single transaction.
//
// First-time (no existing organization_members row for this user): creates
// a brand-new organization too, and assigns the user as its owner.
// TEN-008 "Add facility" (user already has an active organization_members
// row): reuses that same organization — creates only the new facility + its
// 3 rooms, no new organization, no new membership row (they're already a
// member). This is what "Add facility loops the wizard for an org that
// already exists" means at the data layer — one org, many facilities, no
// per-user gate left (TEN-001's "exactly one organization per user" is
// unchanged and still enforced by organization_members' own unique index on
// user_id; TEN-008 only removes the one-*facility*-per-org assumption).
router.post("/facilities", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);

    const body = validate(CreateFacilitySchema, req.body, res);
    if (!body) return;

    const result = await db.transaction(async (tx) => {
      const [existingMembership] = await tx
        .select({ organizationId: organizationMembersTable.organizationId })
        .from(organizationMembersTable)
        .where(
          and(eq(organizationMembersTable.userId, userId!), eq(organizationMembersTable.status, "active")),
        )
        .limit(1);

      let organizationId: number;
      if (existingMembership) {
        organizationId = existingMembership.organizationId;
      } else {
        const [org] = await tx
          .insert(organizationsTable)
          .values({ name: body.farmName })
          .returning();
        organizationId = org.id;
        await tx
          .update(usersTable)
          .set({ organizationId: org.id })
          .where(eq(usersTable.id, userId!));
        await tx.insert(organizationMembersTable).values({
          organizationId: org.id,
          userId: userId!,
          role: "owner",
          status: "active",
        });
      }

      const [facility] = await tx
        .insert(facilitiesTable)
        .values({
          name: body.farmName,
          organizationId,
          facilityName: body.facilityName || body.farmName,
          timezone: body.timezone,
          units: body.units,
          currency: body.currency,
        })
        .returning();
      await tx.insert(roomsTable).values([
        { name: "seeding", sortOrder: 0, facilityId: facility.id },
        { name: "fertigation", sortOrder: 1, facilityId: facility.id },
        { name: "harvesting", sortOrder: 2, facilityId: facility.id },
      ]);
      return { facilityId: facility.id, organizationId };
    });

    return res.status(201).json(result);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create facility" });
  }
});
```

Update the file's imports accordingly (add `and` from `"drizzle-orm"` if not already imported — check the existing `import { eq } from "drizzle-orm";` line and change it to `import { eq, and } from "drizzle-orm";`).

- [ ] **Step 2: Fix `GET /facilities/me` to resolve the facility being onboarded, not "the org's arbitrary one"**

`GET /facilities/me` is only ever consumed by `Done.tsx` (the wizard's own completion screen) to show the just-created facility's name — verified by grep, its only other caller is this route's own test file. Once an org can have 2+ facilities, `WHERE facilitiesTable.organizationId = user.organizationId` picks an arbitrary one, not necessarily the one just finished — a real latent bug TEN-008's own route audit exists to catch. Fix: resolve via the user's own most-recent `wizard_progress` row (exactly the facility whose wizard the user is currently completing), not the org's facility list at all.

Replace the handler:

```ts
// GET /facilities/me — used by the wizard's own Done screen (Done.tsx) to
// show the name of the facility the signed-in user just finished onboarding.
// Resolves via wizard_progress's own facilityId (the row for whichever
// wizard run is currently active/most-recently-updated for this user), NOT
// "the org's facility" — once an org can hold 2+ facilities (TEN-008), the
// latter would non-deterministically return the wrong one for every "Add
// facility" run after the first.
router.get("/facilities/me", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const [progress] = await db
      .select({ facilityId: wizardProgressTable.facilityId })
      .from(wizardProgressTable)
      .where(eq(wizardProgressTable.userId, userId!))
      .orderBy(desc(wizardProgressTable.updatedAt))
      .limit(1);
    if (!progress?.facilityId) return res.status(200).json(null);
    const [facility] = await db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, progress.facilityId));
    return res.status(200).json(facility ?? null);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch facility" });
  }
});
```

Add `wizardProgressTable` to this file's `@workspace/db` import, and `desc` to its `drizzle-orm` import (`import { eq, and, desc } from "drizzle-orm";`).

- [ ] **Step 3: Add `GET /facilities` (list, for the switcher)**

Add this new route (after `GET /facilities/me`, before `export default router;`):

```ts
// GET /facilities — the org's full facility list, for the web/mobile
// switcher (TEN-008). Org-scoped, not facility-scoped: resolves the
// signed-in user's organization directly via organization_members (the same
// bootstrap-safe pattern resolveTenantContext itself uses), deliberately NOT
// gated by requireTenantContext/X-Facility-Id — the switcher needs this list
// BEFORE any facility has been chosen, so requiring the header here would be
// circular.
//
// `onboarded` is derived from wizard_progress's own per-(user, facility)
// row, not facility-readiness's 7-item checklist `completedCount` — the
// switcher only needs "is this facility's onboarding wizard done," which
// wizard_progress already answers directly; recomputing the full readiness
// checklist for every facility in the list would duplicate real business
// logic (sensors/cycles/QBO counts) with no proven need for this list view.
router.get("/facilities", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const [membership] = await db
      .select({ organizationId: organizationMembersTable.organizationId })
      .from(organizationMembersTable)
      .where(
        and(eq(organizationMembersTable.userId, userId!), eq(organizationMembersTable.status, "active")),
      )
      .limit(1);
    if (!membership) return res.status(200).json([]);

    const facilities = await db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.organizationId, membership.organizationId))
      .orderBy(facilitiesTable.createdAt);

    const progressRows = await db
      .select({ facilityId: wizardProgressTable.facilityId, currentStep: wizardProgressTable.currentStep })
      .from(wizardProgressTable)
      .where(eq(wizardProgressTable.userId, userId!));
    const doneFacilityIds = new Set(
      progressRows.filter((r) => r.currentStep === "done").map((r) => r.facilityId),
    );

    return res.status(200).json(
      facilities.map((f) => ({ ...f, onboarded: doneFacilityIds.has(f.id) })),
    );
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch facilities" });
  }
});
```

- [ ] **Step 4: Thread `facilityId` through `wizard.ts`**

Replace the whole file `artifacts/api-server/src/routes/wizard.ts`:

```ts
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { wizardProgressTable, usersTable, organizationMembersTable, facilitiesTable } from "@workspace/db";
import { eq, and, isNull, sql } from "drizzle-orm";
import { getAuth } from "../middlewares/supabaseAuth";

const router = Router();

const WIZARD_STEPS = [
  "farm_basics",
  "layout",
  "sensors_accounts",
  "sensors_devices",
  "sensors_review",
  "done",
] as const;

const PutWizardProgressSchema = z.object({
  currentStep: z.enum(WIZARD_STEPS),
  stepData: z.record(z.string(), z.unknown()).optional(),
  facilityId: z.number().int().positive().optional(),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
    return null;
  }
  return result.data;
}

/**
 * Resolves which organization the signed-in user belongs to (or null for a
 * brand-new user who hasn't reached W2 yet). Deliberately NOT req.tenant —
 * this route pair is the one deliberate exception to X-Facility-Id being
 * hard-required (TEN-008 design doc, §Architecture): there is no facility to
 * name yet for a brand-new wizard run, and re-entering the wizard for an
 * existing facility identifies it via the `facilityId` query
 * param/request-body field below, not the header.
 */
async function getOrganizationId(userId: string): Promise<number | null> {
  const [membership] = await db
    .select({ organizationId: organizationMembersTable.organizationId })
    .from(organizationMembersTable)
    .where(and(eq(organizationMembersTable.userId, userId), eq(organizationMembersTable.status, "active")))
    .limit(1);
  return membership?.organizationId ?? null;
}

// GET /wizard/progress — resume support (WIZ-001), now per-facility
// (TEN-008). `?facilityId=<id>` resumes an EXISTING facility's wizard run
// (re-entering "Add facility" for a facility whose W2 already succeeded but
// a later step didn't finish) — validated against the user's own
// organization before use, same re-validation discipline as
// resolveTenantContext. Omitted: resumes the user's current in-progress,
// not-yet-facility-created run (facility_id IS NULL) — the common case for
// both first-time onboarding and the very start of "Add facility," before
// W2's POST /facilities has run yet. Returns null if no matching row exists,
// so the client's Wizard.tsx defaults to the first step instead of treating
// this as an error.
router.get("/wizard/progress", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const facilityIdParam = req.query.facilityId;

    let facilityCondition;
    if (typeof facilityIdParam === "string" && facilityIdParam.trim() !== "") {
      const facilityId = Number(facilityIdParam);
      if (!Number.isInteger(facilityId) || facilityId <= 0) {
        return res.status(400).json({ error: "Invalid facilityId" });
      }
      const organizationId = await getOrganizationId(userId!);
      const [facility] = await db
        .select({ id: facilitiesTable.id })
        .from(facilitiesTable)
        .where(and(eq(facilitiesTable.id, facilityId), eq(facilitiesTable.organizationId, organizationId ?? -1)));
      if (!facility) return res.status(400).json({ error: "Facility not found in your organization" });
      facilityCondition = eq(wizardProgressTable.facilityId, facilityId);
    } else {
      facilityCondition = isNull(wizardProgressTable.facilityId);
    }

    const [row] = await db
      .select({
        facilityId: wizardProgressTable.facilityId,
        currentStep: wizardProgressTable.currentStep,
        stepData: wizardProgressTable.stepData,
      })
      .from(wizardProgressTable)
      .where(and(eq(wizardProgressTable.userId, userId!), facilityCondition));
    return res.status(200).json(row ?? null);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch wizard progress" });
  }
});

// PUT /wizard/progress — save the current step's draft data and/or advance
// currentStep. TEN-008: body.facilityId, once known (set right after W2's
// POST /facilities succeeds), both identifies which row to update (a real
// facility's row, not the null-facility "which facility am I even creating"
// row) AND, on the one PUT call that first supplies it, transitions that
// exact null-facility row into a real-facility row via an UPDATE keyed on
// (userId, facilityId IS NULL) — never a second INSERT, so the same
// partial-unique-index invariant (Task 3) that limits a user to one
// in-progress unassigned run is never raced.
//
// This must be a single atomic statement, not a read-then-write (even a
// transaction with `SELECT ... FOR UPDATE` isn't enough — see below). Two
// concurrent PUTs for the same (user, facility) — one saving a draft, one an
// advance-only call with no stepData — must never let the advance-only
// call's write clobber the draft-save's write, regardless of which one
// Postgres actually commits first.
//
// Fixed by removing the separate read entirely: when this PUT sent no
// stepData, the SET clause references the target table's own stepData
// column directly (`sql`${wizardProgressTable.stepData}``) instead of a
// JS-computed value. Postgres evaluates that expression against whichever
// row actually wins the conflict, as part of conflict resolution in the same
// statement — there is no window between "read what's there" and "write"
// because there is no separate read, at any point, for any row state.
router.put("/wizard/progress", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);

    const body = validate(PutWizardProgressSchema, req.body, res);
    if (!body) return;

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId!));

    if (body.facilityId !== undefined) {
      // Validate the facility actually belongs to the user's own
      // organization before ever writing it onto their wizard_progress row —
      // same re-validation discipline as resolveTenantContext/getAuth
      // elsewhere in this milestone, never trust a client-supplied id
      // outright.
      const organizationId = await getOrganizationId(userId!);
      const [facility] = await db
        .select({ id: facilitiesTable.id })
        .from(facilitiesTable)
        .where(and(eq(facilitiesTable.id, body.facilityId), eq(facilitiesTable.organizationId, organizationId ?? -1)));
      if (!facility) {
        return res.status(400).json({ error: "facilityId not found in your organization" });
      }

      const [row] = await db
        .update(wizardProgressTable)
        .set({
          facilityId: body.facilityId,
          currentStep: body.currentStep,
          stepData:
            body.stepData !== undefined
              ? sql`${JSON.stringify(body.stepData)}::jsonb`
              : sql`${wizardProgressTable.stepData}`,
          updatedAt: new Date(),
        })
        .where(and(eq(wizardProgressTable.userId, userId!), isNull(wizardProgressTable.facilityId)))
        .returning({
          facilityId: wizardProgressTable.facilityId,
          currentStep: wizardProgressTable.currentStep,
          stepData: wizardProgressTable.stepData,
        });

      if (row) return res.status(200).json(row);

      // No null-facility row existed to transition (e.g. re-entering an
      // already-facility-stamped run after a client-side reload) — fall
      // through to the ordinary per-facility upsert below instead of
      // erroring.
    }

    const [row] = await db
      .insert(wizardProgressTable)
      .values({
        userId: userId!,
        organizationId: user?.organizationId ?? null,
        facilityId: body.facilityId ?? null,
        currentStep: body.currentStep,
        stepData: body.stepData ?? {},
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: body.facilityId !== undefined
          ? [wizardProgressTable.userId, wizardProgressTable.facilityId]
          : wizardProgressTable.userId,
        set: {
          currentStep: body.currentStep,
          stepData:
            body.stepData !== undefined
              ? sql`${JSON.stringify(body.stepData)}::jsonb`
              : sql`${wizardProgressTable.stepData}`,
          updatedAt: new Date(),
        },
      })
      .returning({
        facilityId: wizardProgressTable.facilityId,
        currentStep: wizardProgressTable.currentStep,
        stepData: wizardProgressTable.stepData,
      });

    return res.status(200).json(row);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to save wizard progress" });
  }
});

export default router;
```

Note on the `onConflictDoUpdate` target: Drizzle requires the conflict target to name an actual unique constraint/index. `wizardProgressTable.userId` alone no longer has a plain unique index after Task 3 (it's now the *partial* `wizard_progress_user_id_no_facility_uniq`) — Drizzle's `.onConflictDoUpdate({ target: wizardProgressTable.userId, ... })` form generates `ON CONFLICT ("user_id")`, which **only matches a unique index whose columns are exactly `(user_id)`** — a partial index still qualifies for this as long as Postgres can pick it unambiguously, which it can here since it's the only unique index on the bare `user_id` column. Verify this in Step 6 below; if Postgres reports "there is no unique or exclusion constraint matching the ON CONFLICT specification," switch that branch's target to `sql`("user_id") WHERE facility_id IS NULL`` (Drizzle's raw-SQL conflict-target escape hatch) instead.

- [ ] **Step 5: Update the OpenAPI spec**

Edit `lib/api-spec/openapi.yaml`. Replace the `Facility` schema (around line 2040) to add `onboarded`:

```yaml
    Facility:
      type: object
      properties:
        id:
          type: integer
        name:
          type: string
        organizationId:
          type: integer
        facilityName:
          type: string
        timezone:
          type: string
        units:
          type: string
          enum: [metric, imperial]
        currency:
          type: string
        onboarded:
          type: boolean
      required: [id, name, organizationId, facilityName, timezone, units, currency, onboarded]
```

(`GET /facilities/me`'s response still reuses this same `Facility` schema — its handler in Step 2 doesn't set `onboarded`, so add it there too: in `facilities.ts`'s `GET /facilities/me` handler, change the final `return res.status(200).json(facility ?? null);` to `return res.status(200).json(facility ? { ...facility, onboarded: true } : null);` — a row only reaches this point via a `wizard_progress` lookup for the CURRENT user, and `Done.tsx` (its only real caller) is by definition only ever rendered once that facility's wizard reached the `done` step, so `onboarded: true` is always correct here, not a guess.)

Add the new `GET /facilities` path (right after the existing `/facilities:` block's `post:`, before `/facilities/me:`):

```yaml
    get:
      operationId: listFacilities
      tags: [facilities]
      summary: The signed-in user's organization's full facility list (TEN-008 switcher)
      responses:
        "200":
          description: The organization's facilities (empty array if the user has no organization yet)
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Facility"
```

Update `/wizard/progress`'s `get:` to add the `facilityId` query parameter:

```yaml
  /wizard/progress:
    get:
      operationId: getWizardProgress
      tags: [wizard]
      summary: >
        Resume support — the signed-in user's current wizard step + saved
        draft data. Without facilityId, resumes the in-progress,
        not-yet-facility-created run; with it, resumes that specific
        facility's wizard run (TEN-008 "Add facility" re-entry).
      parameters:
        - name: facilityId
          in: query
          required: false
          schema:
            type: integer
      responses:
        "200":
          description: The signed-in user's wizard progress, or null if the wizard hasn't been started yet
          content:
            application/json:
              schema:
                oneOf:
                  - $ref: "#/components/schemas/WizardProgress"
                  - type: "null"
        "400":
          description: Invalid facilityId, or a facilityId not in the user's own organization
```

Update the `WizardProgress` and `PutWizardProgressRequest` schemas to add `facilityId`:

```yaml
    WizardProgress:
      type: object
      properties:
        facilityId:
          type: ["integer", "null"]
        currentStep:
          type: string
          enum: [farm_basics, layout, sensors_accounts, sensors_devices, sensors_review, done]
        stepData:
          type: object
          additionalProperties: true
      required: [facilityId, currentStep, stepData]

    PutWizardProgressRequest:
      type: object
      properties:
        currentStep:
          type: string
          enum: [farm_basics, layout, sensors_accounts, sensors_devices, sensors_review, done]
        stepData:
          type: object
          additionalProperties: true
        facilityId:
          type: integer
      required: [currentStep]
```

- [ ] **Step 6: Regenerate the API client and typecheck**

Run: `pnpm --filter @workspace/api-spec run codegen`
Expected: `lib/api-zod/src/generated/` and `lib/api-client-react/src/generated/` regenerate with no errors, including a new `useListFacilities` hook (mirroring `useGetMyFacility`'s existing shape) and `useGetWizardProgress` gaining an optional `facilityId` params argument.

Then run: `pnpm run typecheck` from the repo root.
Expected: no errors (this will surface any caller of `useGetWizardProgress()` that needs updating for the new params shape — none exist yet outside `Wizard.tsx`, handled in Task 10).

- [ ] **Step 7: Update `facilities.test.ts`**

Add a new test to `artifacts/api-server/src/tests/routes/facilities.test.ts` (in its existing `describe` block, alongside the existing `POST /facilities` tests):

```ts
  test("POST /facilities: a second facility for an existing org succeeds (TEN-008, no more 409)", async () => {
    const { app, db, roomsTable } = await setup();
    const firstRes = await request(app)
      .post("/api/facilities")
      .send({ farmName: "First Farm", timezone: "UTC", units: "metric", currency: "USD" });
    strictEqual(firstRes.status, 201);

    const secondRes = await request(app)
      .post("/api/facilities")
      .send({ farmName: "Second Farm", timezone: "UTC", units: "metric", currency: "USD" });
    strictEqual(secondRes.status, 201, "a second facility for the same org must now succeed");
    strictEqual(
      secondRes.body.organizationId,
      firstRes.body.organizationId,
      "the second facility must belong to the SAME organization, not a new one",
    );

    const rooms = await db.select().from(roomsTable).where(eq(roomsTable.facilityId, secondRes.body.facilityId));
    strictEqual(rooms.length, 3, "the second facility gets its own 3 default rooms too");
  });

  test("GET /facilities: lists every facility for the signed-in user's organization", async () => {
    const { app } = await setup();
    await request(app)
      .post("/api/facilities")
      .send({ farmName: "Farm One", timezone: "UTC", units: "metric", currency: "USD" });
    await request(app)
      .post("/api/facilities")
      .send({ farmName: "Farm Two", timezone: "UTC", units: "metric", currency: "USD" });

    const res = await request(app).get("/api/facilities");
    strictEqual(res.status, 200);
    strictEqual(res.body.length, 2);
    ok(res.body.every((f: { onboarded: boolean }) => f.onboarded === false), "neither facility has completed its wizard yet");
  });
```

Add `ok` to this file's existing `node:assert` import if not already present (check the top-of-file `import { strictEqual, ... } from "node:assert";` line).

- [ ] **Step 8: Update `wizard.test.ts`**

Read `artifacts/api-server/src/tests/routes/wizard.test.ts` in full first (its exact current test bodies aren't reproduced here — this step adds to, not replaces, the existing file). Add these two tests to its existing `describe` block:

```ts
  test("PUT /wizard/progress: stamping facilityId on first supply transitions the null-facility row, not a new insert", async () => {
    const { app, db, wizardProgressTable } = await setup();
    await request(app).put("/api/wizard/progress").send({ currentStep: "farm_basics" });

    const facilityRes = await request(app)
      .post("/api/facilities")
      .send({ farmName: "Stamp Test Farm", timezone: "UTC", units: "metric", currency: "USD" });
    strictEqual(facilityRes.status, 201);
    const facilityId = facilityRes.body.facilityId as number;

    const putRes = await request(app)
      .put("/api/wizard/progress")
      .send({ currentStep: "layout", facilityId });
    strictEqual(putRes.status, 200);
    strictEqual(putRes.body.facilityId, facilityId);
    strictEqual(putRes.body.currentStep, "layout");

    const rows = await db.select().from(wizardProgressTable);
    strictEqual(rows.length, 1, "the null-facility row must be transitioned in place, never a second row inserted");
  });

  test("GET /wizard/progress: with facilityId resumes that facility's own row, distinct from the in-progress (facility_id IS NULL) run", async () => {
    const { app } = await setup();
    await request(app).put("/api/wizard/progress").send({ currentStep: "farm_basics" });
    const facilityRes = await request(app)
      .post("/api/facilities")
      .send({ farmName: "Resume Test Farm", timezone: "UTC", units: "metric", currency: "USD" });
    const facilityId = facilityRes.body.facilityId as number;
    await request(app).put("/api/wizard/progress").send({ currentStep: "done", facilityId });

    // A brand-new "Add facility" run starts a second, unassigned row.
    const newRunRes = await request(app).get("/api/wizard/progress");
    strictEqual(newRunRes.status, 200);
    strictEqual(newRunRes.body, null, "no in-progress unassigned run exists yet after the first one was stamped");

    const resumeRes = await request(app).get("/api/wizard/progress").query({ facilityId });
    strictEqual(resumeRes.status, 200);
    strictEqual(resumeRes.body.currentStep, "done");
  });

  test("GET /wizard/progress: facilityId belonging to a different organization is a 400, not a leak", async () => {
    const { app } = await setup();
    const otherOrgUserId = randomUUID();
    const { seedTenantContext } = await import("../helpers/testDatabase");
    const otherOrgApp = createAuthenticatedTestApp(wizard.default, { sub: otherOrgUserId });
    const { db, usersTable, organizationsTable, facilitiesTable, organizationMembersTable } = await import("@workspace/db");
    await seedTenantContext(
      db,
      { usersTable, organizationsTable, facilitiesTable, organizationMembersTable },
      { id: otherOrgUserId, email: "other-org@wizard-test.example.com" },
    );
    const { facilitiesTable: facTable } = await import("@workspace/db");
    const [otherFacility] = await db.select().from(facTable).limit(1);

    const res = await request(app).get("/api/wizard/progress").query({ facilityId: otherFacility!.id });
    strictEqual(res.status, 400);
  });
```

Add `randomUUID` from `"node:crypto"` and `createAuthenticatedTestApp` to this file's existing imports if not already present.

- [ ] **Step 9: Run the full test suite**

Run: `TEST_DATABASE_URL=<your test db url> pnpm --filter @workspace/api-server test`
Expected: all tests pass, including every new test added in Steps 7-8.

- [ ] **Step 10: Commit**

```bash
git add artifacts/api-server/src/routes/facilities.ts artifacts/api-server/src/routes/wizard.ts artifacts/api-server/src/tests/routes/facilities.test.ts artifacts/api-server/src/tests/routes/wizard.test.ts lib/api-spec/openapi.yaml lib/api-zod lib/api-client-react
git commit -m "feat(api): remove one-facility gate, add GET /facilities, thread facilityId through wizard progress (TEN-008)"
```

---

### Task 8: `facility-readiness.ts` — make it genuinely facility-scoped

**Files:**
- Modify: `artifacts/api-server/src/routes/facility-readiness.ts`
- Modify: `artifacts/api-server/src/tests/routes/facility-readiness.test.ts`

**Why:** `getFacilityForUser` (this file's own helper) still resolves "the org's one facility" via `usersTable.organizationId` + an unfiltered `facilitiesTable.organizationId` match — exactly the pre-TEN-008 assumption the PRD's own text flags as wrong ("each facility runs its own readiness checklist"). This is the concrete finding from this task's route-handler audit — every other MT-M1-rewired handler (`alerts.ts`, `tasks.ts`, `shipments.ts`, `cycles.ts`, `sensors.ts`, `inventory.ts`, `growthProfiles.ts`, `badTrays.ts`, `dashboard.ts`, `layout.ts`, `metrics.ts`, `lib/accounting/quickbooks.ts`) already reads `req.tenant.facilityId`/`req.tenant.organizationId` via `withTenantScope`, and `resolveTenantContext`'s output shape is unchanged by Task 4 — those files need no code change for TEN-008. `scripts/src/seed-demo-data.ts`'s `overdue-scanner.ts` job also needs no change: it already iterates every `(organizationId, facilityId)` pair independently via its own join, never assuming one facility per org.

**Interfaces:**
- Consumes: `req.tenant.facilityId`/`req.tenant.organizationId` (Task 4), `requireTenantContext` (mounted on this router for the first time).

- [ ] **Step 1: Mount `requireTenantContext` and remove `getFacilityForUser`**

Replace the whole file `artifacts/api-server/src/routes/facility-readiness.ts`:

```ts
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db, withTenantScope } from "@workspace/db";
import {
  facilityReadinessEventsTable,
  sensorsTable,
  cyclesTable,
  accountingConnectionsTable,
} from "@workspace/db";
import { eq, and, isNull, count } from "drizzle-orm";
import { getAuth } from "../middlewares/supabaseAuth";
import { requireTenantContext } from "../middlewares/tenantContext";

const router = Router();
router.use(requireTenantContext);

const ReadinessEventSchema = z.object({
  eventKey: z.enum([
    "labels_downloaded",
    "labels_scanned",
    "grow_profile_created",
    "seeds_added",
    "first_cycle_seeded",
    "sensors_skipped",
    "quickbooks_skipped",
    "team_invited",
  ]),
  undo: z.boolean().optional(),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
    return null;
  }
  return result.data;
}

// GET /facility-readiness — computed 7-item onboarding checklist (CHK-001..003),
// scoped to req.tenant.facilityId (TEN-008: each facility runs its own
// checklist, per the PRD's literal text — this used to resolve "the org's
// one facility" via getFacilityForUser, which silently picked an arbitrary
// facility once an org could hold more than one).
//
// completedCount is derived BY CONSTRUCTION from filtering the exact `items`
// array returned in the response body, not computed independently and then
// compared — that is the only way the two numbers can never diverge. Do not
// "optimize" this into two separate tallies.
router.get("/facility-readiness", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const { organizationId, facilityId } = req.tenant!;

    const events = await db
      .select()
      .from(facilityReadinessEventsTable)
      .where(eq(facilityReadinessEventsTable.facilityId, facilityId));

    const activeEvent = (key: string) => events.find((e) => e.eventKey === key && !e.undoneAt);

    const { sensorCount, cycleCount, qboConnection } = await withTenantScope(
      { organizationId, facilityId },
      async (tx) => {
        const [{ sensorCount }] = await tx
          .select({ sensorCount: count() })
          .from(sensorsTable)
          .where(eq(sensorsTable.facilityId, facilityId));
        const [{ cycleCount }] = await tx
          .select({ cycleCount: count() })
          .from(cyclesTable)
          .where(eq(cyclesTable.facilityId, facilityId));
        const [qboConnection] = await tx
          .select()
          .from(accountingConnectionsTable)
          .where(
            and(eq(accountingConnectionsTable.userId, userId!), eq(accountingConnectionsTable.provider, "quickbooks")),
          );
        return { sensorCount, cycleCount, qboConnection };
      },
    );

    const labelsDownloaded = activeEvent("labels_downloaded");
    const labelsScanned = activeEvent("labels_scanned");
    const labelsState = labelsScanned ? "done" : labelsDownloaded ? "interim" : "pending";

    const sensorsSkipped = activeEvent("sensors_skipped");
    const sensorsState = sensorsSkipped ? "skipped" : sensorCount > 0 ? "done" : "pending";

    const qboSkipped = activeEvent("quickbooks_skipped");
    const qboState = qboConnection ? "done" : qboSkipped ? "skipped" : "pending";

    const items = [
      { key: "labels_downloaded", label: "Print level QR labels", state: labelsState, deepLink: "/layout" },
      {
        key: "grow_profile_created",
        label: "Create a grow profile",
        state: activeEvent("grow_profile_created") ? "done" : "pending",
        deepLink: "/profiles",
      },
      {
        key: "seeds_added",
        label: "Add seeds with QR",
        state: activeEvent("seeds_added") ? "done" : "pending",
        deepLink: "/inventory?category=Seeds",
      },
      {
        key: "first_cycle_seeded",
        label: "Seed your first cycle",
        state: cycleCount > 0 ? "done" : "pending",
        deepLink: null,
      },
      { key: "sensors_registered", label: "Register sensors", state: sensorsState, count: sensorCount },
      { key: "quickbooks_connected", label: "Connect QuickBooks", state: qboState, deepLink: null },
      {
        key: "team_invited",
        label: "Invite your team",
        state: activeEvent("team_invited") ? "done" : "pending",
        deepLink: "/settings",
      },
    ];

    const completedCount = items.filter((i) => i.state === "done").length;

    return res.status(200).json({ items, completedCount });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch facility readiness" });
  }
});

// POST /facility-readiness/events — record (or undo) a checklist-relevant
// event, scoped to req.tenant.facilityId (TEN-008 — same reasoning as GET
// above).
router.post("/facility-readiness/events", async (req: Request, res: Response) => {
  try {
    const { facilityId } = req.tenant!;

    const body = validate(ReadinessEventSchema, req.body, res);
    if (!body) return;

    if (body.undo) {
      await db
        .update(facilityReadinessEventsTable)
        .set({ undoneAt: new Date() })
        .where(
          and(
            eq(facilityReadinessEventsTable.facilityId, facilityId),
            eq(facilityReadinessEventsTable.eventKey, body.eventKey),
            isNull(facilityReadinessEventsTable.undoneAt),
          ),
        );
      return res.status(200).json({ ok: true });
    }

    await db
      .insert(facilityReadinessEventsTable)
      .values({ facilityId, eventKey: body.eventKey })
      .onConflictDoUpdate({
        target: [facilityReadinessEventsTable.facilityId, facilityReadinessEventsTable.eventKey],
        set: { occurredAt: new Date(), undoneAt: null },
      });
    return res.status(201).json({ ok: true });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to record readiness event" });
  }
});

export default router;
```

Note: both handlers' old `409 "No facility yet"` response is gone — `requireTenantContext` (mounted at the top of this router) now returns `400 "Missing or invalid X-Facility-Id"` before either handler body ever runs, for exactly the same underlying condition (no resolvable facility for this request).

- [ ] **Step 2: Update the test file**

Read `artifacts/api-server/src/tests/routes/facility-readiness.test.ts` in full first. Every `createAuthenticatedTestApp(facilityReadiness.default)` call site (there are 4, per the earlier grep) needs its known `facility.id` (already destructured from each `setup()`'s own `seedTenantContext`/direct facility creation) passed as the third argument, mirroring Task 6's pattern:

```ts
createAuthenticatedTestApp(facilityReadiness.default, DEFAULT_TEST_USER, facility.id)
```

Also update any test asserting the old `409` status for "no facility yet" to expect `400` instead (the route no longer returns 409 for this — `requireTenantContext` returns 400 before the handler runs).

- [ ] **Step 3: Run the test suite**

Run: `TEST_DATABASE_URL=<your test db url> pnpm --filter @workspace/api-server test`
Expected: all tests pass.

- [ ] **Step 4: Verify `check-tenant-scope.mjs` still passes**

Run: `node scripts/ci/check-tenant-scope.mjs`
Expected: clean (this file already routes its scoped-table access through `withTenantScope`/direct `eq(...facilityId, facilityId)` filters matching its existing baseline entries — no new violations introduced).

- [ ] **Step 5: Commit**

```bash
git add artifacts/api-server/src/routes/facility-readiness.ts artifacts/api-server/src/tests/routes/facility-readiness.test.ts
git commit -m "fix(api): facility-readiness scoped to req.tenant.facilityId, not org's arbitrary facility (TEN-008)"
```

---

### Task 9: `custom-fetch.ts` — `setFacilityId()`, the shared header chokepoint

**Files:**
- Modify: `lib/api-client-react/src/custom-fetch.ts`

**Interfaces:**
- Produces: `setFacilityId(facilityId: number | null): void` — exported alongside `setBaseUrl`/`setAuthTokenGetter`/`setClientVersion`. Consumed by Tasks 10 (web) and 11 (mobile).

- [ ] **Step 1: Add the module-level state and setter**

Edit `lib/api-client-react/src/custom-fetch.ts`. Add alongside the existing module-level state (near `_baseUrl`/`_authTokenGetter`/`_clientVersion`):

```ts
let _facilityId: number | null = null;

/**
 * Set the active facility id to advertise on outgoing API requests as the
 * `X-Facility-Id` header (TEN-008). The API server's resolveTenantContext
 * re-validates this against real organization_members/facilities rows on
 * every request — this is purely the client's current selection, not a
 * trusted value. Call this whenever the user switches facilities, and once
 * at boot after restoring the persisted selection.
 *
 * Pass `null` to clear it (no header is attached on subsequent requests) —
 * e.g. while no facility has been chosen yet (0 facilities, or an ambiguous
 * 2+-facility first load with no persisted selection).
 */
export function setFacilityId(facilityId: number | null): void {
  _facilityId = facilityId;
}
```

- [ ] **Step 2: Attach the header in `customFetch`**

In the same file, inside `customFetch`, right after the existing client-version block:

```ts
  // Advertise the mobile client version when configured and no explicit
  // header has been provided. Lets the API server log per-version adoption.
  if (_clientVersion && !headers.has("x-farmsmart-client-version")) {
    headers.set("x-farmsmart-client-version", _clientVersion);
  }

  // Advertise the active facility (TEN-008) when one is set and no explicit
  // header has been provided — the server re-validates this on every
  // request (see setFacilityId's doc comment above); this is not a trust
  // boundary, just the current client selection.
  if (_facilityId !== null && !headers.has("x-facility-id")) {
    headers.set("x-facility-id", String(_facilityId));
  }
```

- [ ] **Step 3: Re-export it from the package root**

`lib/api-client-react/src/index.ts` re-exports `custom-fetch.ts`'s functions via an explicit named list, not a wildcard — `setFacilityId` needs adding to it. Edit `lib/api-client-react/src/index.ts`:

```ts
export * from "./generated/api";
export * from "./generated/api.schemas";
export { setBaseUrl, setAuthTokenGetter, setClientVersion, setFacilityId, customFetch } from "./custom-fetch";
export type { AuthTokenGetter } from "./custom-fetch";
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @workspace/api-client-react run typecheck` (or `pnpm run typecheck` from repo root)
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/api-client-react/src/custom-fetch.ts lib/api-client-react/src/index.ts
git commit -m "feat(api-client): add setFacilityId, attach X-Facility-Id header (TEN-008)"
```

---

### Task 10: `admin-dashboard` — facility switcher, "Add facility", `FacilityGate` rework

**Files:**
- Create: `artifacts/admin-dashboard/src/hooks/use-active-facility.ts`
- Create: `artifacts/admin-dashboard/src/components/layout/FacilitySwitcher.tsx`
- Modify: `artifacts/admin-dashboard/src/components/layout/TopBar.tsx`
- Modify: `artifacts/admin-dashboard/src/App.tsx`
- Modify: `artifacts/admin-dashboard/src/pages/onboarding/Wizard.tsx`

**Interfaces:**
- Consumes: `useListFacilities`, `useGetWizardProgress`, `usePutWizardProgress` (Task 7's generated hooks), `setFacilityId` (Task 9).
- Produces: `useActiveFacility()` hook — `{ facilities, activeFacilityId, needsPicker, selectFacility(id), startAddFacility(), isAddingFacility }`. Consumed only within this task's own files.

- [ ] **Step 1: Write `useActiveFacility`**

Create `artifacts/admin-dashboard/src/hooks/use-active-facility.ts`:

```ts
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
```

- [ ] **Step 2: Write the switcher component**

Create `artifacts/admin-dashboard/src/components/layout/FacilitySwitcher.tsx`:

```tsx
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Building2, Check, Plus } from "lucide-react";
import { useActiveFacility } from "@/hooks/use-active-facility";

/**
 * Header facility switcher (TEN-008). Renders nothing for a single-facility
 * org (per the design's "hidden entirely when the org has exactly one
 * facility") — there is nothing meaningful to switch between yet.
 */
export function FacilitySwitcher() {
  const { facilities, activeFacilityId, selectFacility, startAddFacility } = useActiveFacility();

  if (facilities.length <= 1) return null;

  const active = facilities.find((f) => f.id === activeFacilityId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2" data-testid="button-facility-switcher">
          <Building2 className="h-4 w-4" />
          <span className="max-w-[140px] truncate">{active?.facilityName ?? "Select facility"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Facilities</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {facilities.map((f) => (
          <DropdownMenuItem key={f.id} onClick={() => selectFacility(f.id)} data-testid={`facility-option-${f.id}`}>
            {f.id === activeFacilityId ? <Check className="mr-2 h-4 w-4" /> : <span className="mr-2 h-4 w-4" />}
            {f.facilityName}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={startAddFacility} data-testid="button-add-facility">
          <Plus className="mr-2 h-4 w-4" />
          Add facility
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 3: Mount it in `TopBar.tsx`**

Edit `artifacts/admin-dashboard/src/components/layout/TopBar.tsx`. Add the import:

```ts
import { FacilitySwitcher } from "./FacilitySwitcher";
```

Add `<FacilitySwitcher />` right after the `<AskMe />` line (inside the `<header>`, before the mobile/tablet-only icon group `<div>`):

```tsx
        <AskMe />

        <FacilitySwitcher />

        {/* Mobile/tablet only — RightSidebar (xl+) carries these on desktop. */}
```

- [ ] **Step 4: Rework `FacilityGate` in `App.tsx`**

Edit `artifacts/admin-dashboard/src/App.tsx`. Add the import:

```ts
import { useActiveFacility } from "@/hooks/use-active-facility";
```

Replace the `FacilityGate` function:

```tsx
/**
 * Facility-picker screen — shown only when an org has 2+ facilities and no
 * valid persisted selection exists yet (fresh browser, or the persisted id
 * no longer belongs to this org). Never shown for single-facility orgs
 * (useActiveFacility auto-selects those silently).
 */
function FacilityPicker({
  facilities,
  onSelect,
}: {
  facilities: { id: number; facilityName: string }[];
  onSelect: (id: number) => void;
}) {
  return (
    <div className="h-[100dvh] flex flex-col items-center justify-center gap-6 bg-background">
      <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[43px] w-auto" />
      <p className="text-muted-foreground">Choose a facility to continue</p>
      <div className="flex flex-col gap-2 w-full max-w-sm">
        {facilities.map((f) => (
          <Button key={f.id} variant="outline" onClick={() => onSelect(f.id)} data-testid={`picker-facility-${f.id}`}>
            {f.facilityName}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * Wizard-completion guard (WIZ-001), now per-facility (TEN-008): a facility
 * whose wizard_progress row isn't "done" yet routes into the wizard for
 * THAT facility, instead of any dashboard content. "Add facility" starts a
 * brand-new wizard run (facilityId not yet known) via isAddingFacility,
 * distinct from re-entering an existing facility's unfinished wizard.
 *
 * needsPicker (2+ facilities, no valid persisted selection) blocks on an
 * explicit choice rather than guessing — see useActiveFacility's own doc
 * comment for the full 0/1/2+-facility resolution rule.
 */
function FacilityGate() {
  const {
    activeFacilityId,
    needsPicker,
    facilities,
    selectFacility,
    isAddingFacility,
    finishAddFacility,
  } = useActiveFacility();

  if (needsPicker) {
    return <FacilityPicker facilities={facilities} onSelect={selectFacility} />;
  }

  if (isAddingFacility) {
    return <Wizard facilityId={null} onFacilityCreated={finishAddFacility} />;
  }

  const activeFacility = facilities.find((f) => f.id === activeFacilityId);
  if (activeFacility && !activeFacility.onboarded) {
    return <Wizard facilityId={activeFacility.id} onFacilityCreated={() => undefined} />;
  }
  if (!activeFacility && facilities.length === 0) {
    // Brand-new user, no facility at all yet — first-time onboarding.
    return <Wizard facilityId={null} onFacilityCreated={finishAddFacility} />;
  }

  return <Router />; // existing dashboard routes
}
```

- [ ] **Step 5: Thread `facilityId`/`onFacilityCreated` into `Wizard.tsx`**

Edit `artifacts/admin-dashboard/src/pages/onboarding/Wizard.tsx`. Change the component signature and its two data hooks to pass `facilityId` through:

```tsx
export function Wizard({
  facilityId,
  onFacilityCreated,
}: {
  facilityId: number | null;
  onFacilityCreated: (newFacilityId: number) => void;
}) {
  const { data: progress, isLoading } = useGetWizardProgress(
    facilityId !== null ? { facilityId } : undefined,
  );
  const [step, setStep] = useState<WizardStep>("farm_basics");
  const [resumed, setResumed] = useState(false);
  const [addedDevices, setAddedDevices] = useState<AddedDevice[]>([]);
  const [createdFacilityId, setCreatedFacilityId] = useState<number | null>(facilityId);
  const postEvent = usePostWizardEvent();
  const putProgress = usePutWizardProgress();
  const postReadinessEvent = usePostFacilityReadinessEvent();
```

Change the `putProgress.mutate` calls (both the resume-persisting `useEffect` and `advance`) to include `facilityId: createdFacilityId ?? undefined`:

```ts
  useEffect(() => {
    if (isLoading) return;
    putProgress.mutate({ data: { currentStep: step, facilityId: createdFacilityId ?? undefined } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, isLoading]);
```

Change `FarmBasics`'s `onSaved` prop (the `advance` call passed to the `farm_basics` step) to capture the created facility id and notify the parent:

```tsx
      {step === "farm_basics" && (
        <FarmBasics
          onSaved={(data) => {
            setCreatedFacilityId(data.facilityId);
            onFacilityCreated(data.facilityId);
            advance();
          }}
        />
      )}
```

This requires `FarmBasics`'s own `onSaved` prop type to accept the created facility's response — edit `artifacts/admin-dashboard/src/pages/onboarding/steps/FarmBasics.tsx`'s signature and its mutation's `onSuccess`:

```tsx
export function FarmBasics({ onSaved }: { onSaved: (data: { facilityId: number; organizationId: number }) => void }) {
```

```ts
    createFacility.mutate(
      { data: { ...values, facilityName: values.facilityName || values.farmName } },
      {
        onSuccess: (data) => onSaved(data),
        onError: (err) => {
```

(All other steps' `onSaved={advance}` wiring in `Wizard.tsx` stays unchanged — only `farm_basics` needs the created facility id.)

- [ ] **Step 6: Fix `Done.tsx`'s stale facility lookup**

`Done.tsx` currently calls `useGetMyFacility()`. That endpoint (Task 7, Step 2) is already fixed to resolve via the user's own most-recent `wizard_progress` row rather than an arbitrary org facility, so **no code change is needed here** — verify only: read `artifacts/admin-dashboard/src/pages/onboarding/steps/Done.tsx` and confirm its `useGetMyFacility()` call and `facility?.facilityName` usage are unchanged; the fix already landed server-side in Task 7.

- [ ] **Step 7: Typecheck**

Run: `pnpm run typecheck` from the repo root.
Expected: no errors.

- [ ] **Step 8: Manual verification in the browser**

Run: `pnpm --filter @workspace/admin-dashboard run dev`, sign in as a test user with 2+ facilities already seeded (use the API directly or `POST /facilities` twice). Confirm:
- The facility switcher appears in `TopBar` once 2+ facilities exist, hidden for exactly 1.
- Switching facilities changes the dashboard's data (cycles/inventory/etc. scoped to the new facility).
- "Add facility" from the switcher launches the wizard, and completing it returns to the dashboard scoped to the new facility.

- [ ] **Step 9: Commit**

```bash
git add artifacts/admin-dashboard/src/hooks/use-active-facility.ts artifacts/admin-dashboard/src/components/layout/FacilitySwitcher.tsx artifacts/admin-dashboard/src/components/layout/TopBar.tsx artifacts/admin-dashboard/src/App.tsx artifacts/admin-dashboard/src/pages/onboarding/Wizard.tsx artifacts/admin-dashboard/src/pages/onboarding/steps/FarmBasics.tsx
git commit -m "feat(admin-dashboard): facility switcher, add-facility flow, per-facility FacilityGate (TEN-008)"
```

---

### Task 11: `farmeasy` — facility switcher in the profile sheet (read-and-switch only)

**Files:**
- Create: `artifacts/farmeasy/hooks/useActiveFacility.ts`
- Create: `artifacts/farmeasy/components/FacilitySwitcherSheet.tsx`
- Modify: `artifacts/farmeasy/components/HamburgerMenu.tsx`
- Modify: `artifacts/farmeasy/app/(tabs)/_layout.tsx`

**Interfaces:**
- Consumes: `useListFacilities` (Task 7), `setFacilityId` (Task 9).
- Produces: `useActiveFacility()` — same shape/resolution rule as Task 10's web version, minus `isAddingFacility`/`startAddFacility`/`finishAddFacility` (mobile never adds a facility — Global Constraints).

- [ ] **Step 1: Write `useActiveFacility` for mobile**

Create `artifacts/farmeasy/hooks/useActiveFacility.ts`:

```ts
import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useListFacilities, setFacilityId } from "@workspace/api-client-react";

const STORAGE_KEY = "farmsmart:activeFacilityId";

/**
 * Mobile's facility resolution — same 0/1/2+ rule as admin-dashboard's
 * useActiveFacility (web), persisted via AsyncStorage instead of
 * localStorage. Deliberately has NO add-facility affordance: technicians
 * authenticate on mobile only and, by design, never create facilities or
 * run the onboarding wizard here (TEN-008 design doc §3a) — a facility
 * switched to on mobile must already exist. Switching is a pure client-side
 * selection change, re-validated per request by the API server's
 * resolveTenantContext; there is no separate "check access" step to build.
 */
export function useActiveFacility() {
  const { data: facilities, isLoading } = useListFacilities();
  const [activeFacilityId, setActiveFacilityId] = useState<number | null>(null);
  const [needsPicker, setNeedsPicker] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      const parsed = raw ? Number(raw) : NaN;
      setActiveFacilityId(Number.isInteger(parsed) && parsed > 0 ? parsed : null);
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!hydrated || !facilities) return;
    if (facilities.length === 0) {
      setActiveFacilityId(null);
      setNeedsPicker(false);
      return;
    }
    if (facilities.length === 1) {
      setActiveFacilityId(facilities[0]!.id);
      setNeedsPicker(false);
      return;
    }
    const stillValid = activeFacilityId !== null && facilities.some((f) => f.id === activeFacilityId);
    setNeedsPicker(!stillValid);
  }, [facilities, hydrated]);

  useEffect(() => {
    setFacilityId(activeFacilityId);
  }, [activeFacilityId]);

  const selectFacility = (id: number) => {
    AsyncStorage.setItem(STORAGE_KEY, String(id));
    setActiveFacilityId(id);
    setNeedsPicker(false);
  };

  return { facilities: facilities ?? [], isLoading: isLoading || !hydrated, activeFacilityId, needsPicker, selectFacility };
}
```

- [ ] **Step 2: Write the switcher sheet component**

Create `artifacts/farmeasy/components/FacilitySwitcherSheet.tsx`:

```tsx
import { Feather } from "@expo/vector-icons";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useActiveFacility } from "@/hooks/useActiveFacility";

/**
 * Facility switcher row group for the profile sheet (HamburgerMenu). Renders
 * nothing for a single-facility org — matches admin-dashboard's own
 * "hidden entirely when the org has exactly one facility" rule. Read-and-
 * switch only: no "Add facility" row exists here (TEN-008 §3a — mobile never
 * creates facilities).
 */
export function FacilitySwitcherSheet({ onSelected }: { onSelected?: () => void }) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const { facilities, activeFacilityId, selectFacility } = useActiveFacility();

  if (facilities.length <= 1) return null;

  return (
    <View>
      <Text style={s.sectionLabel}>Facilities</Text>
      {facilities.map((f) => (
        <Pressable
          key={f.id}
          style={s.menuRow}
          onPress={() => {
            selectFacility(f.id);
            onSelected?.();
          }}
          testID={`facility-option-${f.id}`}
        >
          <Feather
            name={f.id === activeFacilityId ? "check-circle" : "circle"}
            size={18}
            color={f.id === activeFacilityId ? colors.primary : colors.mutedForeground}
          />
          <Text style={s.menuRowText}>{f.facilityName}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const createStyles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  sectionLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 4,
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
  },
  menuRowText: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.foreground,
  },
});
```

- [ ] **Step 3: Mount it in `HamburgerMenu.tsx`**

Edit `artifacts/farmeasy/components/HamburgerMenu.tsx`. Add the import:

```tsx
import { FacilitySwitcherSheet } from "@/components/FacilitySwitcherSheet";
```

Add `<FacilitySwitcherSheet onSelected={onClose} />` right after the account block's divider (between the existing `<View style={s.divider} />` and the "Search" `Pressable`):

```tsx
          <View style={s.divider} />

          <FacilitySwitcherSheet onSelected={onClose} />

          <Pressable
            style={s.menuRow}
            onPress={() => {
              onClose();
              router.push("/search" as any);
            }}
          >
```

- [ ] **Step 4: Wire `setFacilityId` restoration at app boot**

`useActiveFacility` already calls `setFacilityId` reactively whenever `activeFacilityId` changes (Step 1) — no separate boot-time wiring is needed in `_layout.tsx` beyond mounting a component that calls the hook at least once during the authenticated session. Verify `(tabs)/_layout.tsx`'s existing `TabShell` (which already renders unconditionally once signed in) picks this up: edit `artifacts/farmeasy/app/(tabs)/_layout.tsx`'s `AppShellHamburger` function to call the hook once, so its effect runs regardless of whether the hamburger panel itself is currently open:

```tsx
function AppShellHamburger() {
  const [session, setSession] = useState<Session | null>(null);
  useActiveFacility(); // TEN-008: restores the persisted facility selection and wires setFacilityId at boot, regardless of whether the panel is open.

  useEffect(() => {
```

Add the import: `import { useActiveFacility } from "@/hooks/useActiveFacility";`

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter farmeasy run typecheck` (check the actual package name in `artifacts/farmeasy/package.json` if this differs)
Expected: no errors.

- [ ] **Step 6: Manual verification in Expo**

Run: `pnpm --filter farmeasy run start`, sign in as a technician belonging to an org with 2+ facilities. Confirm:
- The hamburger menu shows a "Facilities" section listing all of them once 2+ exist, hidden for exactly 1.
- Tapping a facility switches it (verify by checking a facility-scoped screen's data changes, e.g. Cycles).
- No "Add facility" affordance exists anywhere on mobile.
- Force-quit and relaunch the app — the previously selected facility is restored automatically (AsyncStorage persistence).

- [ ] **Step 7: Commit**

```bash
git add artifacts/farmeasy/hooks/useActiveFacility.ts artifacts/farmeasy/components/FacilitySwitcherSheet.tsx artifacts/farmeasy/components/HamburgerMenu.tsx artifacts/farmeasy/app/\(tabs\)/_layout.tsx
git commit -m "feat(farmeasy): read-and-switch facility switcher in profile sheet (TEN-008)"
```

---

### Task 12: Extend cross-tenant isolation tests for same-org, two-facility scenarios

**Files:**
- Modify: `artifacts/api-server/src/tests/isolation/cross-tenant.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4-8 (the full backend change set).

- [ ] **Step 1: Add a second facility to org A, seed facility-scoped data into each**

In the existing `before()` hook (after org A's other fixture setup, e.g. right after the sensor/seed-lot/accounting seeding), add:

```ts
    // TEN-008: a second facility for org A itself — proves facility-level
    // isolation WITHIN the same organization/user, one level deeper than
    // this suite's existing cross-*organization* pattern.
    const secondFacilityRes = await request(orgA.app)
      .post("/api/facilities")
      .send({ farmName: "Org A Second Facility", timezone: "UTC", units: "metric", currency: "USD" });
    strictEqual(secondFacilityRes.status, 201, "org A's second facility must be created");
    const facilityATwoId = secondFacilityRes.body.facilityId as number;
    const facilityATwoApp = createAuthenticatedTestApp(combinedRouter, { sub: orgA.userId }, facilityATwoId);

    const facilityTwoCycleRes = await request(facilityATwoApp).post("/api/cycles").send({
      seedLotQrCodes: ["ISO-QR-FACILITY-2"],
      seedName: "Isolation Test Crop",
      fullTrays: 3,
      halfTrays: 0,
      seedWeightTray: 8,
      growthProfileId: seededGrowthProfileId,
      seedingDate: new Date().toISOString().slice(0, 10),
    });
    strictEqual(facilityTwoCycleRes.status, 201, "cycle creation for org A's second facility must succeed");
    const facilityTwoCycleId = facilityTwoCycleRes.body.id;
```

Add module-scope `let` declarations for `facilityATwoId`, `facilityATwoApp`, `facilityTwoCycleId` alongside this file's existing `let orgA`/`orgB`/etc. declarations.

- [ ] **Step 2: Add the same-org, two-facility isolation tests**

Add these tests to the existing `describe` block (after the last existing test):

```ts
  test("TEN-008: GET /cycles never leaks facility A's original facility's cycle into facility A's second facility", async () => {
    const res = await request(facilityATwoApp).get("/api/cycles");
    strictEqual(res.status, 200);
    ok(
      !res.body.some((c: { id: number }) => c.id === seededCycleId),
      "facility A's SECOND facility's cycle list must not contain the ORIGINAL facility's cycle, even though both are the same org and same user",
    );
    ok(
      res.body.some((c: { id: number }) => c.id === facilityTwoCycleId),
      "facility A's second facility's cycle list must contain its own cycle",
    );
  });

  test("TEN-008: switching X-Facility-Id back to the original facility restores its own view, unaffected by the second facility's data", async () => {
    const res = await request(orgA.app).get("/api/cycles");
    strictEqual(res.status, 200);
    ok(res.body.some((c: { id: number }) => c.id === seededCycleId));
    ok(
      !res.body.some((c: { id: number }) => c.id === facilityTwoCycleId),
      "the original facility's view must not include the second facility's cycle",
    );
  });

  test("TEN-008: org-scoped resources (growth profiles, accounting) are identical regardless of active facility", async () => {
    const originalFacilityRes = await request(orgA.app).get("/api/growth-profiles");
    const secondFacilityRes = await request(facilityATwoApp).get("/api/growth-profiles");
    strictEqual(originalFacilityRes.status, 200);
    strictEqual(secondFacilityRes.status, 200);
    ok(originalFacilityRes.body.some((gp: { id: number }) => gp.id === seededGrowthProfileId));
    ok(secondFacilityRes.body.some((gp: { id: number }) => gp.id === seededGrowthProfileId));

    const originalAccountingRes = await request(orgA.app).get("/api/accounting/status");
    const secondAccountingRes = await request(facilityATwoApp).get("/api/accounting/status");
    strictEqual(originalAccountingRes.body.connected, secondAccountingRes.body.connected);
  });

  test("TEN-008: missing X-Facility-Id on a facility-scoped route is a 400, never a silent default", async () => {
    const appWithNoFacility = createAuthenticatedTestApp(combinedRouter, { sub: orgA.userId });
    const res = await request(appWithNoFacility).get("/api/cycles");
    strictEqual(res.status, 400);
  });

  test("TEN-008: X-Facility-Id for a real facility belonging to a DIFFERENT organization is a 400, not a 404 or a leak", async () => {
    const crossOrgApp = createAuthenticatedTestApp(combinedRouter, { sub: orgB.userId }, orgA.facilityId);
    const res = await request(crossOrgApp).get("/api/cycles");
    strictEqual(res.status, 400, "org B's user requesting org A's facility id must 400, never resolve org A's data");
  });

  test("TEN-008: GET /facilities lists both of org A's facilities, each with its own onboarded status", async () => {
    const res = await request(orgA.app).get("/api/facilities");
    strictEqual(res.status, 200);
    strictEqual(res.body.length, 2);
    const originalEntry = res.body.find((f: { id: number }) => f.id === orgA.facilityId);
    const secondEntry = res.body.find((f: { id: number }) => f.id === facilityATwoId);
    ok(originalEntry && secondEntry, "both of org A's facilities must be listed");
  });

  test("TEN-008: GET /facility-readiness is scoped to the active facility, not the org's arbitrary one", async () => {
    const originalRes = await request(orgA.app).get("/api/facility-readiness");
    const secondRes = await request(facilityATwoApp).get("/api/facility-readiness");
    strictEqual(originalRes.status, 200);
    strictEqual(secondRes.status, 200);
    // Org A's ORIGINAL facility seeded a cycle (seededCycleId) -> "Seed your
    // first cycle" is done there. The SECOND facility also seeded its own
    // cycle (facilityTwoCycleId) in this same test's before() hook -> also
    // done there, independently -- proving each facility's checklist is
    // computed from ITS OWN data, not shared/arbitrary org-wide state.
    const firstCycleItem = (facility: typeof originalRes.body) =>
      facility.items.find((i: { key: string }) => i.key === "first_cycle_seeded");
    strictEqual(firstCycleItem(originalRes.body).state, "done");
    strictEqual(firstCycleItem(secondRes.body).state, "done");
  });
```

- [ ] **Step 3: Run the suite**

Run: `TEST_DATABASE_URL=<your test db url> pnpm --filter @workspace/api-server test`
Expected: all tests pass, including every new test in Step 2.

- [ ] **Step 4: Commit**

```bash
git add artifacts/api-server/src/tests/isolation/cross-tenant.test.ts
git commit -m "test(isolation): extend cross-tenant suite with same-org two-facility scenarios (TEN-008)"
```

---

### Task 13: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Root typecheck**

Run: `pnpm run typecheck`
Expected: no errors across every package.

- [ ] **Step 2: Full API server test suite**

Run: `TEST_DATABASE_URL=<your test db url> pnpm --filter @workspace/api-server test`
Expected: all tests pass.

- [ ] **Step 3: Disposable-Supabase CI replay (Docker required)**

Run: `scripts/ci/test-disposable-supabase.sh`
Expected: `Result: PASS` — this is the lesson carried over from MT-M1 (the only thing that actually replays the exact CI path; every earlier verification in this plan ran against a local/staging connection, never the real disposable-stack job).

- [ ] **Step 4: `check-tenant-scope.mjs`**

Run: `node scripts/ci/check-tenant-scope.mjs`
Expected: clean, 0 new violations.

- [ ] **Step 5: If any step fails, fix and re-run from Step 1**

Do not proceed to `finishing-a-development-branch` until all four steps pass cleanly in the same run.
