# Multi-Tenancy MT-M1 — Isolation Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every read/write path in `api-server` actually filters by the caller's real, session-resolved organization/facility — proven by a cross-tenant isolation suite green in CI and against real staging with two provisioned test orgs.

**Architecture:** A new session middleware resolves `{organizationId, facilityId}` from `organization_members` (which today has zero rows and nothing writes to it — Task 1 fixes this first). Every flagged route handler is rewired to call `withTenantScope` with that real context instead of a pilot-default placeholder, including two structurally different cases (the entire `/api/metrics` query-template system, which has zero scoping today and uses raw SQL invisible to any Drizzle-aware guard; and `overdue-scanner.ts`, a background job with no request to derive context from). RLS is made load-bearing (non-`BYPASSRLS` role, a fixed `organization_members` policy) so it's genuine defense-in-depth, not a currently-inert one. A cross-tenant isolation suite proves all of it, in CI and once against real staging.

**Tech Stack:** Express, Drizzle ORM, `@workspace/db`'s `withTenantScope` (already shipped, MT-M0 Task 9), Supabase Postgres + RLS, `node:test` + `supertest`.

## Global Constraints

- pnpm only (root `preinstall` guard refuses npm/yarn). `pnpm run typecheck` must pass before merge — this milestone is what actually fixes the MT-M0-era typecheck fallout; by the end of the route-sweep tasks it must be clean again.
- Facility resolution is "the org's one facility" — multi-facility (TEN-008) is MT-M2, not this milestone. Do not add a facility-selector header/param.
- Every handler rewired to `withTenantScope` must also add an explicit ownership check for any URL-supplied resource ID, returning 404 (not 403, not a silent empty result) for a real ID belonging to another org/facility. A bare WHERE-clause scope filter already causes this in practice; the isolation suite (Task 14) is what proves it, not an assumption.
- `check-tenant-scope.mjs` only scans `artifacts/api-server/src/routes/**/*.ts`. It intentionally does not (and after Task 4's hardening, still will not) cover `src/lib/**` — `overdue-scanner.ts` and `quickbooks.ts` are outside its scope by design; their correctness is proven by the isolation suite instead.
- `sensorStatusTable` (a singleton status row, `LIMIT 1`-queried) has no facility/organization column and was not part of MT-M0's 9-table scoping list. It is out of scope for this milestone — leave every `sensorStatusTable` call site in `cycles.ts` untouched.
- Staging environment: a real, separate Supabase project exists (ADR-004), synthetic fixtures only, resettable. `farmsmart-api-staging` is its Render service. Do not touch production in this plan.

---

### Task 1: `organization_members` backfill + atomic owner-membership insert + session middleware

**Files:**
- Create: `lib/db/drizzle/0025_backfill_organization_members.sql`
- Modify: `artifacts/api-server/src/routes/facilities.ts:1-101` (the `POST /facilities` handler)
- Create: `artifacts/api-server/src/middlewares/tenantContext.ts`
- Modify: `artifacts/api-server/src/app.ts` (mount the new middleware)

**Interfaces:**
- Consumes: `organizationMembersTable`, `orgMemberRoleEnum` (`"owner" | "admin" | "technician"`), `orgMemberStatusEnum` (`"active" | "removed"`) from `@workspace/db` (already shipped, MT-M0 Task 1). `getAuth(req)` from `middlewares/supabaseAuth.ts` (returns `{userId: string | null, userRole: string | null}`).
- Produces: `req.tenant?: { organizationId: number; facilityId: number; role: "owner" | "admin" | "technician" }` (optional — populated only when resolvable, never throws) for every later task's route handlers to consume. Also produces `requireTenantContext` (an assertion middleware, exported from the same file) that later tasks mount per-router, analogous to `app.ts`'s existing `requireSignedIn`.

#### Why this task exists before anything else

`organizationMembersTable` (`lib/db/src/schema/index.ts:123-144`) has been an empty, orphaned table since MT-M0 created it. Confirmed via repo-wide grep: zero application code references `organizationMembersTable` anywhere outside the schema file itself and `check-tenant-scope.mjs`'s scoped-table list. `POST /facilities` (`artifacts/api-server/src/routes/facilities.ts:35-101`) — the only code path that creates a new organization today — only ever writes `usersTable.organizationId` (the column the schema itself already comments as "DEPRECATED (MT-M0): superseded by organization_members.organization_id. Not yet read/written by new code"). No migration ever backfilled existing users into `organization_members` either. Building a middleware that resolves context *from* `organization_members` (as this milestone's design requires) is impossible until both gaps are closed — so this task closes them first, as one unit, since the middleware is meaningless without them.

#### Step 1: Write the backfill migration

There is exactly one pilot organization/facility in this codebase's history (per MT-M0's own rehearsal) and the users who belong to it are identified by `usersTable.organizationId` already being set. Backfill inserts one `organization_members` row per such user, as `owner` (matching every existing user today — there is no admin/technician distinction yet since invites don't exist until MT-M2's TEN-010).

```sql
-- lib/db/drizzle/0025_backfill_organization_members.sql
--
-- organization_members has been empty since MT-M0 created it (Task 1) --
-- nothing ever backfilled it or wrote to it. This backfills every existing
-- user (identified by users.organization_id, the now-deprecated column) into
-- organization_members as "owner" -- there is no admin/technician
-- distinction possible yet, since team invites (TEN-010) don't exist until
-- MT-M2. ON CONFLICT DO NOTHING makes this safe to re-run (the unique index
-- on user_id would otherwise raise on a second run).
INSERT INTO organization_members (organization_id, user_id, role, status)
SELECT organization_id, id, 'owner', 'active'
FROM users
WHERE organization_id IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;
```

#### Step 2: Run it and verify

Run: `DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/db run db:migrate`
Expected: migration `0025_backfill_organization_members.sql` applies cleanly. Verify: `SELECT count(*) FROM organization_members;` returns the same count as `SELECT count(*) FROM users WHERE organization_id IS NOT NULL;`.

#### Step 3: `POST /facilities` inserts the owner membership atomically

Current code (`artifacts/api-server/src/routes/facilities.ts:35-91`):

```ts
router.post("/facilities", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);

    const body = validate(CreateFacilitySchema, req.body, res);
    if (!body) return;

    const result = await db.transaction(async (tx) => {
      const [existingUser] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, userId!))
        .for("update");
      if (existingUser?.organizationId) {
        throw new AlreadyHasFacilityError();
      }

      const [org] = await tx
        .insert(organizationsTable)
        .values({ name: body.farmName })
        .returning();
      const [facility] = await tx
        .insert(facilitiesTable)
        .values({
          name: body.farmName,
          organizationId: org.id,
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
      await tx
        .update(usersTable)
        .set({ organizationId: org.id })
        .where(eq(usersTable.id, userId!));
      return { facilityId: facility.id, organizationId: org.id };
    });

    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof AlreadyHasFacilityError) {
      return res.status(409).json({ error: "User already belongs to a facility" });
    }
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create facility" });
  }
});
```

New code — add the `organization_members` insert in the same transaction, right after the `users` update (import `organizationMembersTable` at the top alongside the other table imports):

```ts
import { organizationsTable, facilitiesTable, roomsTable, usersTable, organizationMembersTable } from "@workspace/db";
```

```ts
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
      return { facilityId: facility.id, organizationId: org.id };
```

This is a bootstrap insert — there is no tenant context to scope *by* yet (this row is what establishes it for every future request), the same category as the org/facility/room inserts immediately above it. It does not go through `withTenantScope` for the same reason those don't, and `check-tenant-scope.mjs`'s regex only matches literal `db.` calls (not `tx.`), so it's correctly invisible to that guard — no baseline entry needed.

#### Step 4: Write the session middleware

```ts
// artifacts/api-server/src/middlewares/tenantContext.ts
import type { Request, Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { db, organizationMembersTable, facilitiesTable } from "@workspace/db";
import { getAuth } from "./supabaseAuth";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: {
        organizationId: number;
        facilityId: number;
        role: "owner" | "admin" | "technician";
      };
    }
  }
}

/**
 * Resolves { organizationId, facilityId, role } from organization_members
 * and attaches it to req.tenant. Never rejects — mirrors
 * supabaseAuthMiddleware's own "attach if present, let the route decide"
 * pattern (see that file's doc comment). Routes that are part of onboarding
 * itself (POST /facilities, GET /facilities/me, wizard progress,
 * facility-readiness) run for users who by definition have no membership
 * yet; a rejecting middleware here would break exactly those flows. Routes
 * that DO require tenant context use requireTenantContext (below),
 * mounted per-router, the same way app.ts already mounts requireSignedIn
 * selectively.
 *
 * Facility resolution is "the org's one facility" (facilities.organizationId
 * = the resolved org, take the only row) — MT-M2's TEN-008 changes this
 * lookup when multi-facility ships; it does not change this middleware's
 * shape or req.tenant's type.
 */
export async function resolveTenantContext(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const { userId } = getAuth(req);
  if (!userId) return next();

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
      ),
    )
    .limit(1);

  if (membership) {
    req.tenant = {
      organizationId: membership.organizationId,
      facilityId: membership.facilityId,
      role: membership.role,
    };
  }
  next();
}

/**
 * Assertion middleware for routes that require resolved tenant context —
 * mount per-router, same pattern as app.ts's requireSignedIn. 403, not 404:
 * the identity resolved (requireSignedIn already passed), there is simply no
 * membership — distinct from a resource-ownership 404 (Task 5+).
 */
export function requireTenantContext(req: Request, res: Response, next: NextFunction) {
  if (!req.tenant) {
    return res.status(403).json({ error: "No facility membership found" });
  }
  next();
}
```

#### Step 5: Mount `resolveTenantContext` globally, right after `supabaseAuthMiddleware`

Modify `artifacts/api-server/src/app.ts`:

```ts
import { supabaseAuthMiddleware, getAuth } from "./middlewares/supabaseAuth";
import { resolveTenantContext } from "./middlewares/tenantContext";
```

```ts
app.use(supabaseAuthMiddleware);
app.use(resolveTenantContext);
```

(directly after the existing `app.use(supabaseAuthMiddleware);` line.) Do **not** apply `requireTenantContext` to any router yet — later tasks add it to the specific routers they rewire (`alertsRouter`, `tasksRouter`, `shipmentsRouter`, `cyclesRouter`, `badTraysRouter`, `sensorsRouter`, `facilityLogsRouter`, `inventoryRouter`, the `growthProfilesRouter`/`seedLotsRouter` mounted via `routes/index.ts`). Leaving `facilitiesRouter`, `wizardRouter`, `facilityReadinessRouter`, `sensorAccountsRouter`, `wizardEventsRouter`, `metricsRouter` (Task 12/13 add their own facility-scoping without a hard reject, since `metrics.ts`'s existing behavior for an unresolvable user is out of this task's scope) unguarded is intentional — they already do their own ad-hoc checks correctly.

#### Step 6: Write the test

```ts
// artifacts/api-server/src/middlewares/tenantContext.test.ts
import { describe, test } from "node:test";
import { strictEqual } from "node:assert";
import { requireTenantContext } from "./tenantContext";
import type { Request, Response } from "express";

describe("requireTenantContext", () => {
  test("403s when req.tenant is unset", () => {
    const req = {} as Request;
    let statusCode: number | undefined;
    let body: unknown;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(b: unknown) {
        body = b;
        return this;
      },
    } as unknown as Response;
    let nextCalled = false;
    requireTenantContext(req, res, () => {
      nextCalled = true;
    });
    strictEqual(statusCode, 403);
    strictEqual(nextCalled, false);
    strictEqual((body as { error: string }).error, "No facility membership found");
  });

  test("calls next() when req.tenant is set", () => {
    const req = { tenant: { organizationId: 1, facilityId: 1, role: "owner" as const } } as Request;
    let nextCalled = false;
    requireTenantContext(req, {} as Response, () => {
      nextCalled = true;
    });
    strictEqual(nextCalled, true);
  });
});
```

Run: `pnpm --filter @workspace/api-server run test`
Expected: 2/2 new tests pass; no regression in the rest of the suite (`resolveTenantContext` itself needs a live DB to test meaningfully — covered by Task 14's isolation suite, not a unit test here, since its whole job is a real join against `organization_members`/`facilities`).

#### Step 7: Fix the test harness — `createAuthenticatedTestApp` never populates `req.tenant`

**This is required before Task 4 can even begin.** Every DB-gated route test in this repo (`inventory.test.ts`, `seedLots.test.ts`, `sensor-accounts.test.ts`, etc.) uses `createAuthenticatedTestApp` (`tests/helpers/testApp.ts`), which stubs `req.supabaseUser` directly and mounts only the router under test — it never runs `resolveTenantContext` at all. The moment Task 4 rewrites a handler to read `req.tenant!.facilityId`, every existing test hitting that handler through this helper would crash with a `TypeError` (`req.tenant` is `undefined`), since nothing in the test harness ever populates it.

Full current file (`tests/helpers/testApp.ts`):

```ts
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type Router,
} from "express";

export const DEFAULT_TEST_USER = {
  sub: "00000000-0000-4000-8000-000000000001",
  user_role: "technician",
} as const;

export function createAuthenticatedTestApp(
  router: Router,
  user: { sub: string; user_role?: string } = DEFAULT_TEST_USER,
): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.supabaseUser = user;
    next();
  });
  app.use("/api", router);
  return app;
}
```

New — insert the **real** `resolveTenantContext` middleware (imported from Task 1's own new file) between the identity stub and the mounted router. This is not a second stub: it runs the exact same production code path, resolving `req.tenant` from whatever `organization_members`/`facilities` rows the calling test's own fixture already seeded (`seedTestUser`, or a direct insert) — matching production exactly, and requiring no new parameter on `createAuthenticatedTestApp` itself:

```ts
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type Router,
} from "express";
import { resolveTenantContext } from "../../middlewares/tenantContext";

export const DEFAULT_TEST_USER = {
  sub: "00000000-0000-4000-8000-000000000001",
  user_role: "technician",
} as const;

export function createAuthenticatedTestApp(
  router: Router,
  user: { sub: string; user_role?: string } = DEFAULT_TEST_USER,
): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.supabaseUser = user;
    next();
  });
  app.use(resolveTenantContext);
  app.use("/api", router);
  return app;
}
```

A DB-gated test whose fixture never inserts an `organization_members`/`facilities` row for its test user (e.g. the deliberate "rejects a user with no facility yet" tests already present in `facility-readiness.test.ts`/`sensor-accounts.test.ts`) continues to work unchanged — `resolveTenantContext` never throws, it just leaves `req.tenant` unset, exactly as those tests already expect.

Run: `pnpm --filter @workspace/api-server run test` (without a live DB, `resolveTenantContext`'s own DB-gated describe blocks skip cleanly per this repo's convention — confirm the full suite still reports the same 62/62 pass as before this change, since `resolveTenantContext` itself is a no-op without `req.supabaseUser.sub` resolvable to anything).

#### Step 8: Commit

```bash
git add lib/db/drizzle/0025_backfill_organization_members.sql artifacts/api-server/src/routes/facilities.ts artifacts/api-server/src/middlewares/tenantContext.ts artifacts/api-server/src/middlewares/tenantContext.test.ts artifacts/api-server/src/app.ts artifacts/api-server/src/tests/helpers/testApp.ts
git commit -m "feat(auth): backfill organization_members, insert owner membership atomically, add tenant-context middleware, wire it into the test harness"
```

---

### Task 2: `organization_members` RLS policy fix (chicken-and-egg)

**Files:**
- Create: `supabase/migrations/00008_organization_members_own_row_policy.sql`
- Modify: `supabase/tests/00001_foundation.sql` (migration count)

**Interfaces:**
- Consumes: `organization_members` table, its existing `"tenant isolation by organization"` policy (`supabase/migrations/00007_tenancy_rls_policies.sql:77-79`).
- Produces: a second, additive RLS policy on the same table — Postgres unions multiple permissive policies, so this does not replace or weaken the existing one.

#### Why

Task 1's middleware queries `organization_members` to *discover* `app.org_id` — but the existing policy (`using (organization_id = current_setting('app.org_id', true)::int)`) requires `app.org_id` to already be set. Under enforced RLS (Task 15 rotates to a non-`BYPASSRLS` role), the middleware's own lookup would see zero rows for every user, permanently. This is the exact chicken-and-egg MT-M0's final review flagged.

#### Step 1: Write the migration

```sql
-- supabase/migrations/00008_organization_members_own_row_policy.sql
--
-- The existing "tenant isolation by organization" policy on
-- organization_members (00007) requires app.org_id to already be set -- but
-- resolving a user's own org membership (tenantContext.ts, Task 1 of the
-- MT-M1 plan) is the query that discovers app.org_id in the first place.
-- Under enforced RLS (non-BYPASSRLS role), that lookup would see zero rows.
--
-- This is a SECOND, additive policy scoped to auth.uid() instead of
-- app.org_id -- Postgres unions multiple permissive policies on the same
-- table, so this does not replace or weaken 00007's org-scoped policy; it
-- only ADDS visibility of a user's own single row, which is exactly what
-- the middleware's bootstrap lookup needs and nothing more (a user cannot
-- see other members' rows through this policy -- that still requires
-- app.org_id via the existing policy).
create policy "members can read own membership row"
  on public.organization_members
  for select
  using (user_id = auth.uid());
```

#### Step 2: Verify it's additive, not replacing, via a real Postgres check

Run against a local Postgres 16 container (`docker run --rm -d -p 5555:5432 -e POSTGRES_PASSWORD=postgres postgres:16`), replaying migrations 0001-0025 (Drizzle) + 00001-00008 (Supabase) as MT-M0's Task 9 review did:
1. As a non-superuser role with RLS enforced, `SET LOCAL request.jwt.claims = '{"sub": "<user-a-uuid>"}'` (simulating `auth.uid()`), then `SELECT * FROM organization_members;` with `app.org_id` unset — expect exactly 1 row (user A's own).
2. With `app.org_id` set to user A's org via `SELECT set_config('app.org_id', '<org-id>', true)`, `SELECT * FROM organization_members;` — expect every row in that org (not just user A's), proving the original policy still works unweakened.

#### Step 3: Bump the foundation pgTAP migration count

`supabase/tests/00001_foundation.sql:67-71` currently asserts 7 Supabase migrations (per MT-M0's Task 13 fix). Current text:

```sql
SELECT is(
  (SELECT count(*) FROM supabase_migrations.schema_migrations)::integer,
  7,
  'supabase_migrations.schema_migrations has exactly 7 rows (Supabase migrations 00001-00007)'
);
```

Bump to 8, same pattern as MT-M0's prior fix of this same assertion:

```sql
SELECT is(
  (SELECT count(*) FROM supabase_migrations.schema_migrations)::integer,
  8,
  'supabase_migrations.schema_migrations has exactly 8 rows (Supabase migrations 00001-00008)'
);
```

#### Step 4: Commit

```bash
git add supabase/migrations/00008_organization_members_own_row_policy.sql supabase/tests/00001_foundation.sql
git commit -m "fix(db): add auth.uid()-keyed RLS policy on organization_members, closing the middleware chicken-and-egg"
```

---

### Task 3: CI guard hardening — multi-line Drizzle chain detection

**Files:**
- Modify: `scripts/ci/check-tenant-scope.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: the same CLI contract (exit 0/1, same log format) — later tasks (5-11) rely on this guard correctly catching (or correctly baselining) every call site they touch.

#### Why

The current regex (`scripts/ci/check-tenant-scope.mjs:29-31`) requires `db.(select|insert|update|delete)(...)` and `.from(...)`/`.into(...)`/`.table(...)` on the **same line**. Confirmed empirically: `seedLots.ts`'s `GET /seed-lots/lookup` handler (multi-line, per Drizzle's standard chain style) already slips through undetected today. MT-M1's route sweep (Tasks 5-11) rewrites exactly the files this guard is supposed to gate — it needs to actually catch a regression before that sweep, not after.

#### Step 1: Rewrite the detection to be multi-line-aware

Current:

```js
const DIRECT_CALL = new RegExp(
  `\\bdb\\.(select|insert|update|delete)\\([^)]*\\)[^;]*\\.(from|into|table)\\((${SCOPED_TABLES.join("|")})\\)`,
);

const newViolations = [];
const baselineViolations = [];

for await (const file of glob("**/*.ts", { cwd: ROUTES_DIR })) {
  const fullPath = path.join(ROUTES_DIR, file);
  const relPath = path.relative(ROOT, fullPath);
  const content = readFileSync(fullPath, "utf8");
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    if (DIRECT_CALL.test(line) && !content.includes("withTenantScope")) {
      const key = `${relPath}::${line.trim()}`;
      if (BASELINE_VIOLATIONS.has(key)) {
        baselineViolations.push(`${relPath}:${i + 1}: ${line.trim()}`);
      } else {
        newViolations.push(`${relPath}:${i + 1}: ${line.trim()}`);
      }
    }
  });
}
```

New — match against the whole file content (with newlines collapsed to spaces for the regex, so a chain spanning lines still matches), then map the match's character offset back to a line number for reporting:

```js
const DIRECT_CALL = new RegExp(
  `\\bdb\\.(select|insert|update|delete)\\([^)]*\\)[\\s\\S]*?\\.(from|into|table)\\((${SCOPED_TABLES.join("|")})\\)`,
  "g",
);

const newViolations = [];
const baselineViolations = [];

for await (const file of glob("**/*.ts", { cwd: ROUTES_DIR })) {
  const fullPath = path.join(ROUTES_DIR, file);
  const relPath = path.relative(ROOT, fullPath);
  const content = readFileSync(fullPath, "utf8");

  if (content.includes("withTenantScope")) continue;

  for (const match of content.matchAll(DIRECT_CALL)) {
    const upToMatch = content.slice(0, match.index);
    const lineNumber = upToMatch.split("\n").length;
    // Report the specific line the db.<verb>( call starts on, trimmed, so
    // baseline keys stay stable and readable (not the whole multi-line match).
    const startLine = content.split("\n")[lineNumber - 1].trim();
    const key = `${relPath}::${startLine}`;
    if (BASELINE_VIOLATIONS.has(key)) {
      baselineViolations.push(`${relPath}:${lineNumber}: ${startLine}`);
    } else {
      newViolations.push(`${relPath}:${lineNumber}: ${startLine}`);
    }
  }
}
```

Note: `[\s\S]*?` (non-greedy) between the call opening and the `.from(...)` prevents the match from spanning past the first `.from(scopedTable)` it finds — bounding it is important so one match doesn't accidentally swallow an unrelated later call in the same file. This changes matching behavior (a whole-file scan vs a per-line scan), so re-verify every existing `BASELINE_VIOLATIONS` entry still matches after this change — run Step 3 below before trusting the new code.

#### Step 2: Verify against a fresh scratch violation, empirically, before trusting it on real files

```ts
// /tmp/scratch-multiline-violation.ts (delete after verifying, never commit)
const rows = await db
  .select()
  .from(cyclesTable)
  .where(eq(cyclesTable.id, 1));
```

Confirm the hardened regex flags this when placed in a temp file under `artifacts/api-server/src/routes/` (e.g. copy to `artifacts/api-server/src/routes/__scratch_multiline_test.ts`, run the script, confirm a `newViolations` entry appears, then delete the scratch file — never commit it).

#### Step 3: Re-run against the real, current baseline files and confirm identical output

Run: `node scripts/ci/check-tenant-scope.mjs`
Expected: **identical** violation count/list to before this change for every file NOT yet rewired by Tasks 5-11 (the 6 existing `BASELINE_VIOLATIONS` entries should still match — all 6 are single-line calls, so the multi-line change should not alter which lines they key on). If any baseline entry's key no longer matches (e.g. because line-splitting differs), fix the entry's stored line content to match exactly what the new code produces — do not silently drop it.

#### Step 4: Confirm `seedLots.ts`'s own lookup handler is now caught (or already fixed)

If Task 8 (inventory/seedLots sweep) hasn't run yet, this task should show `seedLots.ts`'s multi-line `GET /seed-lots/lookup` query as a **new** violation (proving the fix works) — add it to `BASELINE_VIOLATIONS` for now (Task 8 will remove it once that handler is rewired to `withTenantScope`, per that task's own baseline-shrinking rule). If Task 8 has already run, confirm zero violations from that file instead.

#### Step 5: Commit

```bash
git add scripts/ci/check-tenant-scope.mjs
git commit -m "fix(ci): make check-tenant-scope.mjs multi-line-aware, closing the seedLots.ts blind spot"
```

---

### Task 4: Route sweep — Alerts, Tasks, Shipments

**Files:**
- Modify: `artifacts/api-server/src/routes/alerts.ts` (all 4 handlers)
- Modify: `artifacts/api-server/src/routes/tasks.ts` (all 3 handlers)
- Modify: `artifacts/api-server/src/routes/shipments.ts` (all 5 handlers)
- Modify: `artifacts/api-server/src/app.ts` (add `requireTenantContext` to these 3 routers' mount lines)

**Interfaces:**
- Consumes: `req.tenant` (Task 1), `withTenantScope` (`@workspace/db`, shipped MT-M0).
- Produces: nothing new consumed by later tasks — these three files have no cross-references to each other or to files in later tasks.

These three share the same pattern: a direct `facility_id` column, no child-table joins, no state-machine complexity. Full literal diffs below.

#### `alerts.ts`

```ts
import { Router, type Request, type Response } from "express";
import { eq, and, desc } from "drizzle-orm";
import { withTenantScope, alertsTable } from "@workspace/db";

const router = Router();

function formatAlert(a: typeof alertsTable.$inferSelect) {
  return {
    id: a.id,
    title: a.title,
    description: a.description ?? null,
    location: a.location ?? null,
    severity: a.severity,
    status: a.status,
    actionType: a.actionType ?? null,
    actionNotes: a.actionNotes ?? null,
    createdAt: a.createdAt.toISOString(),
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
  };
}

router.get("/alerts", async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    const rows = await withTenantScope(req.tenant!, (tx) => {
      const facilityCond = eq(alertsTable.facilityId, req.tenant!.facilityId);
      if (status && ["current", "resolved", "dismissed"].includes(status)) {
        return tx
          .select()
          .from(alertsTable)
          .where(and(facilityCond, eq(alertsTable.status, status as "current" | "resolved" | "dismissed")))
          .orderBy(desc(alertsTable.createdAt));
      }
      return tx.select().from(alertsTable).where(facilityCond).orderBy(desc(alertsTable.createdAt));
    });

    const result = rows.map(formatAlert);
    return res.json(limit ? result.slice(0, limit) : result);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch alerts" });
  }
});

router.post("/alerts", async (req: Request, res: Response) => {
  try {
    const { title, description, location, severity } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });

    const [alert] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .insert(alertsTable)
        .values({
          title,
          description: description ?? null,
          location: location ?? null,
          severity: severity ?? "warning",
          status: "current",
          facilityId: req.tenant!.facilityId,
        })
        .returning(),
    );

    return res.status(201).json(formatAlert(alert));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create alert" });
  }
});

router.patch("/alerts/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const { status } = req.body;

    if (!["resolved", "dismissed"].includes(status)) {
      return res.status(400).json({ error: "status must be resolved or dismissed" });
    }

    const [alert] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .update(alertsTable)
        .set({ status, resolvedAt: new Date() })
        .where(and(eq(alertsTable.id, id), eq(alertsTable.facilityId, req.tenant!.facilityId)))
        .returning(),
    );

    if (!alert) return res.status(404).json({ error: "Alert not found" });
    return res.json(formatAlert(alert));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to update alert" });
  }
});

router.post("/alerts/:id/action", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const { actionType, notes } = req.body;

    if (!actionType) return res.status(400).json({ error: "actionType is required" });

    const [alert] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .update(alertsTable)
        .set({ status: "resolved", actionType, actionNotes: notes ?? null, resolvedAt: new Date() })
        .where(
          and(
            eq(alertsTable.id, id),
            eq(alertsTable.status, "current"),
            eq(alertsTable.facilityId, req.tenant!.facilityId),
          ),
        )
        .returning(),
    );

    if (!alert) return res.status(404).json({ error: "Alert not found or already resolved" });
    return res.json(formatAlert(alert));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to take action on alert" });
  }
});

export default router;
```

Note: for `PATCH /alerts/:id` and `POST /alerts/:id/action`, a wrong-org ID and an already-resolved ID are indistinguishable in the response (both 404) — this is correct and intentional (no existence leak either way), matching the existing already-resolved case's own prior behavior.

#### `tasks.ts`

```ts
import { Router, type Request, type Response } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { withTenantScope, tasksTable } from "@workspace/db";

const router = Router();

function formatTask(t: typeof tasksTable.$inferSelect) {
  return {
    id: t.id,
    cycleId: t.cycleId ?? null,
    type: t.type,
    status: t.status,
    assignee: t.assignee ?? null,
    dueAt: t.dueAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    createdBy: t.userId ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

router.get("/tasks", async (req: Request, res: Response) => {
  try {
    const status = req.query["status"] as string | undefined;
    const facilityId = req.tenant!.facilityId;
    const conds = [eq(tasksTable.facilityId, facilityId)];
    if (status === "pending" || status === "in_progress" || status === "done") {
      conds.push(eq(tasksTable.status, status));
    } else {
      conds.push(isNull(tasksTable.completedAt));
    }
    const rows = await withTenantScope(req.tenant!, (tx) =>
      tx.select().from(tasksTable).where(and(...conds)).orderBy(tasksTable.dueAt),
    );
    return res.json(rows.map(formatTask));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

router.post("/tasks", async (req: Request, res: Response) => {
  try {
    const { cycleId, type, assignee, dueAt } = req.body;
    if (!type) return res.status(400).json({ error: "type is required" });
    const [t] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .insert(tasksTable)
        .values({
          cycleId: cycleId ?? null,
          type,
          status: "pending",
          assignee: assignee ?? null,
          dueAt: dueAt ? new Date(dueAt) : null,
          facilityId: req.tenant!.facilityId,
        })
        .returning(),
    );
    return res.status(201).json(formatTask(t));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create task" });
  }
});

router.patch("/tasks/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const { status, assignee, dueAt, completedAt } = req.body;
    const update: Partial<typeof tasksTable.$inferInsert> = {};
    if (status !== undefined) {
      if (!["pending", "in_progress", "done"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      update.status = status as "pending" | "in_progress" | "done";
      if (status === "done") update.completedAt = completedAt ? new Date(completedAt) : new Date();
    }
    if (assignee !== undefined) update.assignee = assignee;
    if (dueAt !== undefined) update.dueAt = dueAt ? new Date(dueAt) : null;

    const [t] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .update(tasksTable)
        .set(update)
        .where(and(eq(tasksTable.id, id), eq(tasksTable.facilityId, req.tenant!.facilityId)))
        .returning(),
    );
    if (!t) return res.status(404).json({ error: "Task not found" });
    return res.json(formatTask(t));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to update task" });
  }
});

export default router;
```

#### `shipments.ts`

Full file, with the `db.` → `withTenantScope` wrapping and `facilityId` filtering applied to all 5 handlers; every other line (the LIKE-escaping helper, `parseShipmentListQuery`, keyset pagination, short-ID retry loop) preserved byte-identical:

```ts
import { Router, type Request, type Response } from "express";
import { eq, and, gt, desc, asc, ilike } from "drizzle-orm";
import { withTenantScope, shipmentsTable } from "@workspace/db";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const router = Router();

function generateShortId(): string {
  return "SHP-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function formatShipment(s: typeof shipmentsTable.$inferSelect) {
  return {
    id: s.id,
    shortId: s.shortId,
    client: s.client,
    productDescription: s.productDescription ?? null,
    yieldSoldKg: s.yieldSoldKg ? Number(s.yieldSoldKg) : null,
    revenueUsd: s.revenueUsd ? Number(s.revenueUsd) : null,
    shippingDate: s.shippingDate ?? null,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
  };
}

type ShipmentListQuery = {
  cursor?: number;
  limit: number;
  status?: "pending" | "in_progress" | "complete";
  client?: string;
};

function escapeClientPattern(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

function parseShipmentListQuery(req: Request): ShipmentListQuery {
  const rawStatus = req.query.status as string | undefined;
  const status =
    rawStatus && ["in_progress", "complete", "pending"].includes(rawStatus)
      ? (rawStatus as ShipmentListQuery["status"])
      : undefined;

  const rawClient = req.query.client as string | undefined;
  const client = rawClient && rawClient.length > 0 ? rawClient : undefined;

  const parsedCursor = req.query.cursor
    ? parseInt(req.query.cursor as string, 10)
    : undefined;
  const cursor = parsedCursor !== undefined && Number.isFinite(parsedCursor) ? parsedCursor : undefined;

  const limit = Math.min(
    MAX_LIMIT,
    req.query.limit
      ? parseInt(req.query.limit as string, 10) || DEFAULT_LIMIT
      : DEFAULT_LIMIT,
  );

  return { cursor, limit, status, client };
}

router.get("/shipments", async (req: Request, res: Response) => {
  try {
    const { cursor, limit, status, client } = parseShipmentListQuery(req);

    const conditions = [eq(shipmentsTable.facilityId, req.tenant!.facilityId)];
    if (cursor !== undefined) conditions.push(gt(shipmentsTable.id, cursor));
    if (status) conditions.push(eq(shipmentsTable.status, status));
    if (client) {
      conditions.push(ilike(shipmentsTable.client, `%${escapeClientPattern(client)}%`));
    }

    const rows = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(shipmentsTable)
        .where(and(...conditions))
        .orderBy(asc(shipmentsTable.id))
        .limit(limit + 1),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]!.id : null;

    if (req.query.cursor === undefined && req.query.limit === undefined) {
      return res.json(page.map(formatShipment));
    }
    return res.json({ items: page.map(formatShipment), nextCursor });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch shipments" });
  }
});

router.post("/shipments", async (req: Request, res: Response) => {
  try {
    const { client, productDescription, yieldSoldKg, revenueUsd, shippingDate, status } = req.body;
    if (!client) return res.status(400).json({ error: "client is required" });

    let shortId = generateShortId();
    let shipment: typeof shipmentsTable.$inferSelect | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      [shipment] = await withTenantScope(req.tenant!, (tx) =>
        tx
          .insert(shipmentsTable)
          .values({
            shortId,
            client,
            productDescription: productDescription ?? null,
            yieldSoldKg: yieldSoldKg ? String(yieldSoldKg) : null,
            revenueUsd: revenueUsd ? String(revenueUsd) : null,
            shippingDate: shippingDate ?? null,
            status: status ?? "pending",
            facilityId: req.tenant!.facilityId,
          })
          .onConflictDoNothing({ target: [shipmentsTable.shortId] })
          .returning(),
      );
      if (shipment) break;
      shortId = generateShortId();
    }

    if (!shipment) {
      return res.status(500).json({ error: "Failed to generate a unique shipment short ID" });
    }

    return res.status(201).json(formatShipment(shipment));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create shipment" });
  }
});

router.patch("/shipments/:id/status", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const { status } = req.body;

    if (!["in_progress", "complete", "pending"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const [shipment] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .update(shipmentsTable)
        .set({ status })
        .where(and(eq(shipmentsTable.id, id), eq(shipmentsTable.facilityId, req.tenant!.facilityId)))
        .returning(),
    );

    if (!shipment) return res.status(404).json({ error: "Shipment not found" });
    return res.json(formatShipment(shipment));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to update shipment status" });
  }
});

router.patch("/shipments/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const { client, productDescription, yieldSoldKg, revenueUsd, shippingDate, status } = req.body;

    const updateData: Partial<typeof shipmentsTable.$inferInsert> = {};
    if (client !== undefined) updateData.client = client;
    if (productDescription !== undefined) updateData.productDescription = productDescription;
    if (yieldSoldKg !== undefined) updateData.yieldSoldKg = yieldSoldKg ? String(yieldSoldKg) : null;
    if (revenueUsd !== undefined) updateData.revenueUsd = revenueUsd ? String(revenueUsd) : null;
    if (shippingDate !== undefined) updateData.shippingDate = shippingDate;
    if (status !== undefined) {
      if (!["in_progress", "complete", "pending"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      updateData.status = status;
    }

    const [shipment] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .update(shipmentsTable)
        .set(updateData)
        .where(and(eq(shipmentsTable.id, id), eq(shipmentsTable.facilityId, req.tenant!.facilityId)))
        .returning(),
    );

    if (!shipment) return res.status(404).json({ error: "Shipment not found" });
    return res.json(formatShipment(shipment));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to update shipment" });
  }
});

router.delete("/shipments/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const [shipment] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .delete(shipmentsTable)
        .where(and(eq(shipmentsTable.id, id), eq(shipmentsTable.facilityId, req.tenant!.facilityId)))
        .returning(),
    );

    if (!shipment) return res.status(404).json({ error: "Shipment not found" });
    return res.json({ ok: true, id });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to delete shipment" });
  }
});

export default router;
```

#### Wire `requireTenantContext` into `app.ts`

```ts
import { resolveTenantContext, requireTenantContext } from "./middlewares/tenantContext";
```

```ts
app.use("/api", requireSignedIn, requireTenantContext, alertsRouter);
app.use("/api", requireSignedIn, requireTenantContext, tasksRouter);
app.use("/api", requireSignedIn, requireTenantContext, shipmentsRouter);
```

(replacing the existing `app.use("/api", requireSignedIn, alertsRouter);` etc. lines — `requireTenantContext` runs after `requireSignedIn`, consistent with the existing middleware-ordering convention.)

#### Run tests, fix, run typecheck

Run: `pnpm --filter @workspace/api-server run typecheck`
Expected: `alerts.ts`, `tasks.ts`, `shipments.ts` no longer appear in the error output.

Run: `CI=true REQUIRE_TEST_DATABASE=true TEST_DATABASE_URL=... DATABASE_URL=... pnpm --filter @workspace/api-server run test`
Expected: any pre-existing test in `tasks.test.ts`/`shipments.test.ts` that seeds rows without `facilityId` will now fail (the same class of gap Task 13 of MT-M0 catalogued) — fix each seed helper to include `facilityId` matching the test's own tenant context, do not skip or delete the test.

#### Commit

```bash
git add artifacts/api-server/src/routes/alerts.ts artifacts/api-server/src/routes/tasks.ts artifacts/api-server/src/routes/shipments.ts artifacts/api-server/src/app.ts artifacts/api-server/src/tests/routes/tasks.test.ts artifacts/api-server/src/tests/routes/shipments.test.ts
git commit -m "feat(tenancy): rewire alerts/tasks/shipments to withTenantScope with real session context"
```

---

### Task 5: Route sweep — FacilityLogs, Sensors

**Files:**
- Modify: `artifacts/api-server/src/routes/facilityLogs.ts` (the one `POST /facility-logs` handler)
- Modify: `artifacts/api-server/src/routes/sensors.ts` (all 3 handlers)
- Modify: `artifacts/api-server/src/app.ts`

**Interfaces:**
- Consumes: `req.tenant`, `withTenantScope`.

#### `facilityLogs.ts`

Create-only, no list/read endpoint — no 404-ownership concern (nothing to leak by ID lookup). Only the insert needs `facilityId`. Replace:

```ts
import { db } from "@workspace/db";
import { facilityLogsTable } from "@workspace/db";
```

with:

```ts
import { withTenantScope, facilityLogsTable } from "@workspace/db";
```

and replace the insert body (`artifacts/api-server/src/routes/facilityLogs.ts:108-117`):

```ts
    const [log] = await db
      .insert(facilityLogsTable)
      .values({
        logType,
        userId: userId,
        data: parsedData.data,
        notes: notes ?? null,
      })
      .returning();
```

with:

```ts
    const [log] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .insert(facilityLogsTable)
        .values({
          logType,
          userId: userId,
          data: parsedData.data,
          notes: notes ?? null,
          facilityId: req.tenant!.facilityId,
        })
        .returning(),
    );
```

Everything else in the file (the 6 per-type Zod schemas, the media-signing block) stays byte-identical.

#### `sensors.ts`

All 3 handlers (`GET /sensors`, `POST /sensors`, `POST /sensors/bulk`) need `facilityId` — `sensorsTable.facilityId` per MT-M0's schema.

```ts
import { withTenantScope, sensorsTable } from "@workspace/db";
```

`GET /sensors`:

```ts
router.get("/sensors", async (req: Request, res: Response) => {
  try {
    const rows = await withTenantScope(req.tenant!, (tx) =>
      tx.select().from(sensorsTable).where(eq(sensorsTable.facilityId, req.tenant!.facilityId)),
    );
    return res.json(rows.map(formatSensor));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch sensors" });
  }
});
```

(add `import { eq } from "drizzle-orm";` if not already present at the top.)

`POST /sensors` — add `facilityId: req.tenant!.facilityId` to the `.values({...})` object, wrap in `withTenantScope`.

`POST /sensors/bulk` — add `facilityId: req.tenant!.facilityId` to every row in the `rows` array built by `body.types.flatMap(...)` (`artifacts/api-server/src/routes/sensors.ts:112-122`):

```ts
    const rows = body.types.flatMap((type) =>
      placements.map((placement) => ({
        channelId: placement.channelId,
        rackId: placement.rackId,
        roomId: body.roomId ?? null,
        facilityWide: body.facilityWide ?? false,
        sensorAccountId: body.sensorAccountId ?? null,
        type,
        label: body.label,
        facilityId: req.tenant!.facilityId,
      })),
    );

    const created = await withTenantScope(req.tenant!, (tx) =>
      tx.insert(sensorsTable).values(rows).returning(),
    );
```

Everything else (the Zod schema, `validate()` helper, `formatSensor`) stays byte-identical.

#### Wire into `app.ts`

```ts
app.use("/api", requireSignedIn, requireTenantContext, facilityLogsRouter);
app.use("/api", requireSignedIn, requireTenantContext, sensorsRouter);
```

#### Run, fix seed helpers, commit

Run typecheck + tests as in Task 4. Fix `sensors-bulk.test.ts` if it doesn't already supply `facilityId` matching its own tenant fixture (MT-M0's rehearsal already fixed its TRUNCATE issue — this is a separate, additive `facilityId`-on-insert fix, not a repeat of that).

```bash
git add artifacts/api-server/src/routes/facilityLogs.ts artifacts/api-server/src/routes/sensors.ts artifacts/api-server/src/app.ts
git commit -m "feat(tenancy): rewire facility-logs/sensors to withTenantScope with real session context"
```

---

### Task 6: Route sweep — Cycles (state machine)

**Files:**
- Modify: `artifacts/api-server/src/routes/cycles.ts`

**Interfaces:**
- Consumes: `req.tenant`, `withTenantScope`.
- Produces: nothing new for later tasks.

`cycles.ts` is the largest and most state-machine-heavy file in this sweep (germination → fertigation → harvest → completed). Every handler needs the same two changes: (a) filter/insert by `facilityId`, (b) for the 4 handlers keyed by `:id` (`GET /cycles/:id`, `POST /cycles/:id/fertigation`, `POST /cycles/:id/harvest`, `POST /cycles/:id/complete-harvest`, `GET`/`POST /cycles/:id/manual-checks`), add `eq(cyclesTable.facilityId, req.tenant!.facilityId)` to the existing `WHERE eq(cyclesTable.id, id)` lookup, so a wrong-facility ID 404s instead of finding another org's row.

**Deliberately unchanged in this task:** every `sensorStatusTable` call site (lines 272-277, 395-400) — that table has no facility column and is out of MT-M0/MT-M1's 9-table scope (a global singleton status row), matching this plan's Global Constraints.

#### `GET /cycles` (`cycles.ts:177-211`)

```ts
router.get("/cycles", async (req, res) => {
  try {
    const role = extractRole(req);
    const status = (req.query.status as string) || "ongoing";

    if (status === "history" && !isSupervisorOrLead(role)) {
      return res.status(403).json({ error: "History access is restricted to supervisors" });
    }

    const rows = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select({ cycle: cyclesTable, profile: growthProfilesTable })
        .from(cyclesTable)
        .leftJoin(growthProfilesTable, eq(cyclesTable.growthProfileId, growthProfilesTable.id))
        .where(
          and(
            eq(cyclesTable.facilityId, req.tenant!.facilityId),
            status === "history" ? eq(cyclesTable.status, "completed") : ne(cyclesTable.status, "completed"),
          ),
        )
        .orderBy(desc(cyclesTable.createdAt)),
    );

    return res.json(rows.filter((r) => r.profile !== null).map((r) => formatCycle(r.cycle, r.profile!)));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch cycles" });
  }
});
```

(add `and` to the existing `drizzle-orm` import if not already present.)

#### `POST /cycles` (`cycles.ts:213-285`)

```ts
router.post("/cycles", enforceAuth, async (req, res) => {
  try {
    const body = validate(CreateCycleSchema, req.body, res);
    if (!body) return;

    const [profile] = await withTenantScope(req.tenant!, (tx) =>
      tx.select().from(growthProfilesTable).where(eq(growthProfilesTable.id, body.growthProfileId)).limit(1),
    );
    if (!profile) {
      return res.status(400).json({ error: "Growth profile not found" });
    }

    const auth = getAuth(req);
    let shortId = generateShortId();
    let cycle: typeof cyclesTable.$inferSelect | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      [cycle] = await withTenantScope(req.tenant!, (tx) =>
        tx
          .insert(cyclesTable)
          .values({
            shortId,
            seedLotQrCodes: body.seedLotQrCodes,
            seedName: body.seedName,
            fullTrays: body.fullTrays,
            halfTrays: body.halfTrays,
            seedWeightTray: String(body.seedWeightTray),
            growthProfileId: body.growthProfileId,
            seedingDate: body.seedingDate,
            status: "germination",
            trayPosition: body.trayPosition,
            germinationStartedAt: new Date(),
            userId: auth?.userId ?? null,
            facilityId: req.tenant!.facilityId,
          })
          .onConflictDoNothing({ target: [cyclesTable.shortId] })
          .returning(),
      );
      if (cycle) break;
      shortId = generateShortId();
    }

    if (!cycle) {
      return res.status(500).json({ error: "Failed to generate a unique cycle short ID" });
    }

    const hasSensorData =
      body.humidity !== undefined ||
      body.temperature !== undefined ||
      body.ph !== undefined ||
      body.waterLevel !== undefined ||
      body.nutrientMix !== undefined;

    if (hasSensorData) {
      const sensorUpdate: Record<string, unknown> = { updatedAt: new Date() };
      if (body.humidity !== undefined) sensorUpdate.humidityPct = body.humidity;
      if (body.temperature !== undefined) sensorUpdate.tempCelsius = body.temperature;
      if (body.ph !== undefined) sensorUpdate.acidityPh = body.ph;
      if (body.waterLevel !== undefined) sensorUpdate.waterLevelPct = body.waterLevel;
      if (body.nutrientMix !== undefined) sensorUpdate.nutrientMix = body.nutrientMix;

      // Unchanged (sensorStatusTable is out of scope — see Global Constraints):
      const [existing] = await db.select({ id: sensorStatusTable.id }).from(sensorStatusTable).limit(1);
      if (existing) {
        await db.update(sensorStatusTable).set(sensorUpdate).where(eq(sensorStatusTable.id, existing.id));
      } else {
        await db.insert(sensorStatusTable).values(sensorUpdate as typeof sensorStatusTable.$inferInsert);
      }
    }

    return res.status(201).json(formatCycle(cycle, profile));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create cycle" });
  }
});
```

`growthProfileId` is user/client-supplied here (`body.growthProfileId`) — since `growth_profiles` is organization-scoped (not facility-scoped), and growth profiles are looked up without a tenant filter today, leave the growth-profile lookup itself unfiltered in this task (Task 7 handles `growthProfiles.ts` and decides whether cross-org growth-profile references need their own guard — out of this task's file list).

#### `GET /cycles/:id` (`cycles.ts:287-326`)

```ts
router.get("/cycles/:id", async (req, res) => {
  try {
    const id = parseParamId(req);
    const role = extractRole(req);

    const rows = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select({ cycle: cyclesTable, profile: growthProfilesTable })
        .from(cyclesTable)
        .leftJoin(growthProfilesTable, eq(cyclesTable.growthProfileId, growthProfilesTable.id))
        .where(and(eq(cyclesTable.id, id), eq(cyclesTable.facilityId, req.tenant!.facilityId)))
        .limit(1),
    );

    if (!rows.length || !rows[0].profile) {
      return res.status(404).json({ error: "Cycle not found" });
    }

    if (rows[0].cycle.status === "completed" && !isSupervisorOrLead(role)) {
      return res
        .status(403)
        .json({ error: "Access to completed cycle details is restricted to supervisors" });
    }

    const checks = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(manualChecksTable)
        .where(eq(manualChecksTable.cycleId, id))
        .orderBy(desc(manualChecksTable.createdAt)),
    );

    return res.json({
      ...formatCycle(rows[0].cycle, rows[0].profile!),
      manualChecks: await Promise.all(checks.map(formatCheck)),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch cycle" });
  }
});
```

(`manualChecksTable`'s own query needs no additional facility filter — `id` has already been proven to belong to this facility by the `cyclesTable` lookup immediately above it, and `manual_checks` has no `facility_id` column of its own to filter by anyway.)

#### `POST /cycles/:id/fertigation`, `POST /cycles/:id/harvest` (`cycles.ts:328-465`)

Both follow the identical shape: `SELECT cycle by id` → validate status → `SELECT growth profile` → (business-rule check) → `UPDATE ... WHERE and(id, status)`. For each: add `eq(cyclesTable.facilityId, req.tenant!.facilityId)` to BOTH the initial `SELECT` and the final `UPDATE`'s `WHERE and(...)`, wrap each `db.` call in `withTenantScope`. The `sensorStatusTable` block inside `/fertigation` stays unchanged (same as `POST /cycles` above). Preserve every business-rule line (`germinationStartedAt`/`fertigationStartedAt` due-date math, the 423 "not yet complete" responses, the `seedLotQrCodes` array-membership check noted as already-facility-safe by MT-M0) byte-identical.

#### `POST /cycles/:id/complete-harvest` (`cycles.ts:468-549`)

This one already uses `db.transaction` (not individual `db.` calls) since it does 3 writes atomically (update cycle, conditionally insert `manualChecksTable` + `badTrayEntriesTable`). Full handler, with the facility filter added to the pre-transaction lookups AND the transactional `UPDATE`, and `db.transaction` replaced by `withTenantScope`:

```ts
router.post("/cycles/:id/complete-harvest", enforceAuth, async (req, res) => {
  try {
    const id = parseParamId(req);
    const body = validate(CompleteHarvestSchema, req.body, res);
    if (body === null) return;

    const [cycle] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(cyclesTable)
        .where(and(eq(cyclesTable.id, id), eq(cyclesTable.facilityId, req.tenant!.facilityId)))
        .limit(1),
    );
    if (!cycle) return res.status(404).json({ error: "Cycle not found" });
    if (cycle.status !== "harvest")
      return res.status(400).json({ error: "Cycle is not in harvest status" });

    const [profile] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(growthProfilesTable)
        .where(eq(growthProfilesTable.id, cycle.growthProfileId))
        .limit(1),
    );

    const auth = getAuth(req);

    const updated = await withTenantScope(req.tenant!, async (tx) => {
      const [row] = await tx
        .update(cyclesTable)
        .set({
          status: "completed",
          fullTrays: body.fullTrays ?? cycle.fullTrays,
          halfTrays: body.halfTrays ?? cycle.halfTrays,
          harvestedQty: String(body.harvestedQty),
          closedAt: new Date(),
          trayPosition: body.trayQrCode ?? cycle.trayPosition,
        })
        .where(
          and(
            eq(cyclesTable.id, id),
            eq(cyclesTable.status, "harvest"),
            eq(cyclesTable.facilityId, req.tenant!.facilityId),
          ),
        )
        .returning();

      if (!row) return null;

      if (body.isBadTrays) {
        await tx.insert(manualChecksTable).values({
          cycleId: id,
          fullTrays: body.fullTrays ?? cycle.fullTrays,
          halfTrays: body.halfTrays ?? cycle.halfTrays,
          isBadTrays: true,
          issue: body.issue ?? null,
          notes: "Flagged at harvest",
          photoUrls: [],
          userId: auth?.userId ?? null,
        });

        const affectedTrays = (body.fullTrays ?? cycle.fullTrays) + (body.halfTrays ?? cycle.halfTrays) * 0.5;
        const expectedYieldPerTrayKg = Number(profile?.expectedYieldPerTrayKg ?? 0);
        const lossEstimate = affectedTrays * expectedYieldPerTrayKg * 1000;
        const severity = affectedTrays >= 5 ? "high" : affectedTrays >= 2 ? "medium" : "low";

        await tx.insert(badTrayEntriesTable).values({
          cycleId: id,
          issue: body.issue ?? null,
          severity,
          fullTrays: body.fullTrays ?? cycle.fullTrays,
          halfTrays: body.halfTrays ?? cycle.halfTrays,
          photoUrls: [],
          lossEstimate: String(lossEstimate),
          userId: auth?.userId ?? null,
        });
      }
      return row;
    });

    if (!updated) {
      return res
        .status(409)
        .json({ error: "Cycle is no longer in harvest status (concurrent transition)" });
    }

    return res.json(formatCycle(updated, profile));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to complete harvest" });
  }
});
```

`manualChecksTable`/`badTrayEntriesTable` inserts inside this transaction need no `facilityId` of their own (neither table has that column — they inherit scope via `cycleId`, and `id` here has already been proven to belong to this facility by the pre-transaction `SELECT`'s own `WHERE` clause above).

#### `GET /cycles/:id/manual-checks` (`cycles.ts:551-582`)

```ts
router.get("/cycles/:id/manual-checks", async (req, res) => {
  try {
    const id = parseParamId(req);
    const role = extractRole(req);

    const [cycle] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select({ status: cyclesTable.status })
        .from(cyclesTable)
        .where(and(eq(cyclesTable.id, id), eq(cyclesTable.facilityId, req.tenant!.facilityId)))
        .limit(1),
    );

    if (!cycle) {
      return res.status(404).json({ error: "Cycle not found" });
    }

    if (cycle.status === "completed" && !isSupervisorOrLead(role)) {
      return res
        .status(403)
        .json({ error: "Access to completed cycle audit log is restricted to supervisors" });
    }

    const checks = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(manualChecksTable)
        .where(eq(manualChecksTable.cycleId, id))
        .orderBy(desc(manualChecksTable.createdAt)),
    );
    return res.json(await Promise.all(checks.map(formatCheck)));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch manual checks" });
  }
});
```

#### `POST /cycles/:id/manual-checks` (`cycles.ts:584-647`)

```ts
router.post("/cycles/:id/manual-checks", enforceAuth, async (req, res) => {
  try {
    const id = parseParamId(req);
    const body = validate(ManualCheckSchema, req.body, res);
    if (body === null) return;

    const auth = getAuth(req);

    const result = await withTenantScope(req.tenant!, async (tx) => {
      const [cycleRow] = await tx
        .select({ id: cyclesTable.id, growthProfileId: cyclesTable.growthProfileId })
        .from(cyclesTable)
        .where(and(eq(cyclesTable.id, id), eq(cyclesTable.facilityId, req.tenant!.facilityId)));

      if (!cycleRow) return null;

      const [check] = await tx
        .insert(manualChecksTable)
        .values({
          cycleId: id,
          fullTrays: body.fullTrays,
          halfTrays: body.halfTrays,
          isBadTrays: body.isBadTrays,
          issue: body.issue ?? null,
          notes: body.notes ?? null,
          photoUrls: body.photoUrls ?? [],
          userId: auth?.userId ?? null,
        })
        .returning();

      if (body.isBadTrays) {
        let expectedYieldPerTrayKg = 0;
        if (cycleRow.growthProfileId) {
          const [profile] = await tx
            .select({ expectedYieldPerTrayKg: growthProfilesTable.expectedYieldPerTrayKg })
            .from(growthProfilesTable)
            .where(eq(growthProfilesTable.id, cycleRow.growthProfileId));
          expectedYieldPerTrayKg = Number(profile?.expectedYieldPerTrayKg ?? 0);
        }

        const affectedTrays = (body.fullTrays ?? 0) + (body.halfTrays ?? 0) * 0.5;
        const lossEstimate = affectedTrays * expectedYieldPerTrayKg * 1000;
        const severity = affectedTrays >= 5 ? "high" : affectedTrays >= 2 ? "medium" : "low";

        await tx.insert(badTrayEntriesTable).values({
          cycleId: id,
          issue: body.issue ?? null,
          severity,
          fullTrays: body.fullTrays,
          halfTrays: body.halfTrays,
          photoUrls: body.photoUrls ?? [],
          lossEstimate: String(lossEstimate),
          userId: auth?.userId ?? null,
        });
      }

      return check;
    });

    if (!result) return res.status(404).json({ error: "Cycle not found" });
    return res.status(201).json(await formatCheck(result));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create manual check" });
  }
});
```

(the pre-existing behavior returned a generic 500 for a nonexistent `cycleId` — via a `manual_checks_cycle_id_fkey` FK violation caught by the outer `catch`. This rewrite makes it an explicit 404 instead, which is strictly more correct — a wrong-facility `id` must 404, not 500, and reusing the same check naturally fixes the nonexistent-id case too.)

#### Top-of-file import change

```ts
import { db, ...(existing table imports)..., withTenantScope } from "@workspace/db";
```

(keep `db` imported — `sensorStatusTable` call sites still use it directly, unchanged per this task's scope.)

#### Wire into `app.ts`

```ts
app.use("/api", requireSignedIn, requireTenantContext, cyclesRouter);
```

#### Run, fix, commit

Run typecheck + tests. Fix any DB-gated test in `cycles.test.ts` (if one exists) whose fixtures don't supply `facilityId` matching its own tenant context.

```bash
git add artifacts/api-server/src/routes/cycles.ts artifacts/api-server/src/app.ts
git commit -m "feat(tenancy): rewire cycles.ts's full state machine to withTenantScope with real session context"
```

---

### Task 7: Route sweep — BadTrays, GrowthProfiles

**Files:**
- Modify: `artifacts/api-server/src/routes/badTrays.ts` (both handlers)
- Modify: `artifacts/api-server/src/routes/growthProfiles.ts` (both the seed function and the list handler)
- Modify: `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/index.ts` (if the seed guard needs it — see Step 2)

**Interfaces:**
- Consumes: `req.tenant`, `withTenantScope`.

#### `badTrays.ts` — child-table scoping via `cyclesTable`

`manual_checks` has no `facility_id` column of its own (confirmed: it was not in MT-M0's 9-table scoping list) — it scopes through its `cycleId` FK to `cyclesTable.facilityId`. `GET /bad-trays` already `innerJoin`s `cyclesTable` — add the facility filter there:

```ts
router.get("/bad-trays", async (req: Request, res: Response) => {
  try {
    const checks = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select({
          id: manualChecksTable.id,
          cycleId: manualChecksTable.cycleId,
          fullTrays: manualChecksTable.fullTrays,
          halfTrays: manualChecksTable.halfTrays,
          issue: manualChecksTable.issue,
          notes: manualChecksTable.notes,
          createdAt: manualChecksTable.createdAt,
          shortId: cyclesTable.shortId,
          seedName: cyclesTable.seedName,
          trayPosition: cyclesTable.trayPosition,
        })
        .from(manualChecksTable)
        .innerJoin(cyclesTable, eq(manualChecksTable.cycleId, cyclesTable.id))
        .where(and(eq(manualChecksTable.isBadTrays, true), eq(cyclesTable.facilityId, req.tenant!.facilityId)))
        .orderBy(desc(manualChecksTable.createdAt)),
    );
    // ... rest of the function (totalBadTrays/issueMap/manualEntries computation) unchanged
```

(add `and` to the `drizzle-orm` import.)

`POST /bad-trays/manual-checks` — the existing cycle lookup (`badTrays.ts:84-90`) already needs to exist before inserting; add the facility filter there so a wrong-facility `cycleId` 404s instead of silently creating a manual-check entry against another org's cycle:

```ts
    const [cycle] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select({ id: cyclesTable.id, shortId: cyclesTable.shortId, trayPosition: cyclesTable.trayPosition })
        .from(cyclesTable)
        .where(and(eq(cyclesTable.id, cycleId), eq(cyclesTable.facilityId, req.tenant!.facilityId)))
        .limit(1),
    );

    if (!cycle) return res.status(404).json({ error: "Cycle not found" });
```

Wrap the subsequent `manualChecksTable`/`alertsTable` inserts in the same `withTenantScope` call (combine into one callback, since they're already sequential in the same handler) — add `facilityId: req.tenant!.facilityId` to the `alertsTable` insert's `.values({...})` (`alertsTable.facilityId` is NOT NULL per MT-M0's schema); `manualChecksTable` needs no `facilityId` of its own (inherits via `cycleId`, already proven above).

#### `growthProfiles.ts` — the pilot bootstrap seed is a genuine exception, not a route to rewire

`seedDataIfEmpty()` (`growthProfiles.ts:7-60`) runs once at process startup (`index.ts:20`), with no request/session to derive tenant context from — structurally different from every other file in this sweep, the same category as `overdue-scanner.ts` (Task 9) but even more so: it's not tenant *data processing*, it's a one-time dev/pilot bootstrap that predates multi-tenancy entirely. Retiring the pilot-default pattern here (per this milestone's "retire everywhere" decision) doesn't fit — there is no per-tenant context to retire it *to*. TEN-013 (demo mode, MT-M2) is what properly replaces this with real per-org starter provisioning.

The pragmatic, narrowly-scoped fix: keep this function targeting the pilot-default org/facility specifically (the same `ORDER BY id LIMIT 1` resolution being retired everywhere else), with an explicit comment marking it as a deliberate, narrow exception:

```ts
import { db, organizationsTable, facilitiesTable } from "@workspace/db";
import { growthProfilesTable, seedLotsTable } from "@workspace/db";

export async function seedDataIfEmpty() {
  try {
    const existing = await db
      .select({ id: growthProfilesTable.id })
      .from(growthProfilesTable)
      .limit(1);
    if (existing.length > 0) return;

    // Pilot-only bootstrap seed, NOT a per-tenant operation — it runs once at
    // process startup with no request/session to derive real tenant context
    // from (same category as overdue-scanner.ts, more so). Deliberately kept
    // on the pilot-default resolution pattern MT-M1 retires everywhere else:
    // TEN-013 (demo mode, MT-M2) is what properly replaces this with real
    // per-organization starter-data provisioning at facility-creation time.
    const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable).orderBy(organizationsTable.id).limit(1);
    const [facility] = await db.select({ id: facilitiesTable.id }).from(facilitiesTable).orderBy(facilitiesTable.id).limit(1);
    if (!org || !facility) {
      console.log("Skipping pilot seed: no organization/facility exists yet");
      return;
    }

    await db.insert(growthProfilesTable).values([
      { name: "Arugula (Normal)", seedName: "Arugula", germinationDays: 7, fertigationDays: 14, organizationId: org.id },
      { name: "Allstar Gourmet Lettuce Mix", seedName: "Allstar Gourmet Lettuce Mix", germinationDays: 5, fertigationDays: 18, organizationId: org.id },
      { name: "Toscano Kale", seedName: "Toscano Kale", germinationDays: 5, fertigationDays: 21, organizationId: org.id },
      { name: "Zephyr Summer Squash (Normal)", seedName: "Zephyr Summer Squash", germinationDays: 4, fertigationDays: 10, organizationId: org.id },
      { name: "Microgreen Mix", seedName: "Microgreen Mix", germinationDays: 3, fertigationDays: 7, organizationId: org.id },
    ]);

    await db.insert(seedLotsTable).values([
      { qrCode: "LOT-3740", seedName: "Arugula", facilityId: facility.id },
      { qrCode: "LOT-3741", seedName: "Allstar Gourmet Lettuce Mix", facilityId: facility.id },
      { qrCode: "LOT-3742", seedName: "Toscano Kale", facilityId: facility.id },
      { qrCode: "LOT-3743", seedName: "Zephyr Summer Squash", facilityId: facility.id },
      { qrCode: "LOT-3744", seedName: "Microgreen Mix", facilityId: facility.id },
    ]);

    console.log("Seed data inserted");
  } catch (err) {
    console.error("Seeding failed:", err);
  }
}
```

`GET /growth-profiles` — this list handler DOES need real scoping (it's a real request, unlike the seed function above): filter by `req.tenant!.organizationId` (growth_profiles is organization-scoped, not facility-scoped — per MT-M0's schema, `growthProfilesTable.organizationId`):

```ts
router.get("/growth-profiles", async (req: Request, res: Response) => {
  try {
    const profiles = await withTenantScope(req.tenant!, (tx) =>
      tx.select().from(growthProfilesTable).where(eq(growthProfilesTable.organizationId, req.tenant!.organizationId)),
    );
    res.json(profiles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch growth profiles" });
  }
});
```

(change the handler signature from `(_req, res)` to `(req: Request, res: Response)` since `req.tenant` is now read; add the `Request`/`Response` type imports and `eq`/`withTenantScope` imports at the top.)

#### Wire into `app.ts`

`badTraysRouter` gets `requireTenantContext`:

```ts
app.use("/api", requireSignedIn, requireTenantContext, badTraysRouter);
```

`growthProfilesRouter` is mounted via `routes/index.ts`, itself wrapped by `app.use("/api", requireSignedIn, router);` (`app.ts:133`) — this line covers `growthProfilesRouter`, `seedLotsRouter` (Task 8), `mediaRouter`, `layoutRouter`, `healthRouter`, `dashboardRouter` together. Since not all of those need `requireTenantContext` (media/layout/health/dashboard are unaffected by this milestone), do NOT add it to that shared line. Instead, add `requireTenantContext` as the first middleware inside `growthProfilesRouter` itself (and `seedLotsRouter` in Task 8), scoped per-route rather than per-mount:

```ts
// artifacts/api-server/src/routes/growthProfiles.ts
import { requireTenantContext } from "../middlewares/tenantContext";
```

```ts
router.get("/growth-profiles", requireTenantContext, async (req: Request, res: Response) => {
```

#### Run, fix, commit

```bash
git add artifacts/api-server/src/routes/badTrays.ts artifacts/api-server/src/routes/growthProfiles.ts artifacts/api-server/src/app.ts
git commit -m "feat(tenancy): rewire bad-trays/growth-profiles to withTenantScope; keep pilot seed on pilot-default (documented exception)"
```

---

### Task 8: Route sweep — Inventory, SeedLots, Facilities pilot-default retirement

**Files:**
- Modify: `artifacts/api-server/src/routes/inventory.ts` (all 4 handlers)
- Modify: `artifacts/api-server/src/routes/seedLots.ts` (the one lookup handler)
- Modify: `artifacts/api-server/src/app.ts`
- Modify: `scripts/ci/check-tenant-scope.mjs` (remove the now-fixed baseline entry, if Task 3 added one for `seedLots.ts`)

**Interfaces:**
- Consumes: `req.tenant`, `withTenantScope`.

This task specifically retires the `SELECT id FROM facilities ORDER BY id LIMIT 1` pilot-default pattern (MT-M0's placeholder) everywhere it appears in these two files, per this milestone's "retire pilot-default everywhere" decision.

#### `inventory.ts`

```ts
import { Router, type Request, type Response } from "express";
import { eq, gt, and, asc } from "drizzle-orm";
import { z } from "zod";
import { withTenantScope, inventoryItemsTable } from "@workspace/db";
import { generateShortId } from "../lib/utils";
```

(`facilitiesTable` import is no longer needed — the pilot-default lookup it supported is being removed.)

`GET /inventory`:

```ts
router.get("/inventory", async (req: Request, res: Response) => {
  try {
    const cursor = req.query.cursor ? parseInt(req.query.cursor as string, 10) : undefined;
    const limit = Math.min(
      MAX_LIMIT,
      req.query.limit ? parseInt(req.query.limit as string, 10) || DEFAULT_LIMIT : DEFAULT_LIMIT,
    );

    const conditions = [eq(inventoryItemsTable.facilityId, req.tenant!.facilityId)];
    if (cursor !== undefined) conditions.push(gt(inventoryItemsTable.id, cursor));

    const rows = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(inventoryItemsTable)
        .where(and(...conditions))
        .orderBy(asc(inventoryItemsTable.id))
        .limit(limit + 1),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]!.id : null;

    if (req.query.cursor === undefined && req.query.limit === undefined) {
      return res.json(page.map(formatItem));
    }
    return res.json({ items: page.map(formatItem), nextCursor });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to fetch inventory" });
  }
});
```

`POST /inventory` — remove the pilot-default resolution block entirely, use `req.tenant!.facilityId` directly:

```ts
router.post("/inventory", async (req: Request, res: Response) => {
  try {
    const body = validate(CreateInventorySchema, req.body, res);
    if (!body) return;

    const facilityId = req.tenant!.facilityId;

    let itemCode = generateShortId();
    let item: typeof inventoryItemsTable.$inferSelect | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      [item] = await withTenantScope(req.tenant!, (tx) =>
        tx
          .insert(inventoryItemsTable)
          .values({
            name: body.name,
            brand: body.brand ?? null,
            category: body.category ?? null,
            qrCode: body.qrCode ?? null,
            currentQty: String(body.currentQty ?? 0),
            maxQty: String(body.maxQty ?? 0),
            unit: body.unit ?? "g",
            arrivalDate: body.arrivalDate ?? null,
            facilityId,
            itemCode,
          })
          .onConflictDoNothing({ target: [inventoryItemsTable.facilityId, inventoryItemsTable.itemCode] })
          .returning(),
      );
      if (item) break;
      itemCode = generateShortId();
    }
    if (!item) {
      return res.status(500).json({ error: "Failed to generate a unique item code" });
    }

    return res.status(201).json(formatItem(item));
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create inventory item" });
  }
});
```

`PATCH /inventory/:id` — add the facility filter to the existing `SELECT ... FOR UPDATE` and the final `UPDATE`, wrap the whole transaction body in `withTenantScope` (replacing `db.transaction`):

```ts
    const result = await withTenantScope(req.tenant!, async (tx) => {
      const [existing] = await tx
        .select()
        .from(inventoryItemsTable)
        .where(and(eq(inventoryItemsTable.id, id), eq(inventoryItemsTable.facilityId, req.tenant!.facilityId)))
        .for("update");

      if (!existing) return { kind: "not_found" as const };

      const mergedCurrent = body.currentQty !== undefined ? body.currentQty : Number(existing.currentQty);
      const mergedMax = body.maxQty !== undefined ? body.maxQty : Number(existing.maxQty);

      if (mergedCurrent > mergedMax) {
        return { kind: "invalid" as const, message: "currentQty must be less than or equal to maxQty" };
      }

      const [updated] = await tx
        .update(inventoryItemsTable)
        .set(updateData)
        .where(and(eq(inventoryItemsTable.id, id), eq(inventoryItemsTable.facilityId, req.tenant!.facilityId)))
        .returning();

      return { kind: "ok" as const, item: updated };
    });
```

`DELETE /inventory/:id` — add the facility filter, wrap in `withTenantScope`:

```ts
router.delete("/inventory/:id", async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    const [item] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .delete(inventoryItemsTable)
        .where(and(eq(inventoryItemsTable.id, id), eq(inventoryItemsTable.facilityId, req.tenant!.facilityId)))
        .returning(),
    );

    if (!item) return res.status(404).json({ error: "Item not found" });
    return res.json({ ok: true, id });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to delete inventory item" });
  }
});
```

#### `seedLots.ts`

Retire the pilot-default `ORDER BY id LIMIT 1` resolution in `GET /seed-lots/lookup`, using `req.tenant!.facilityId` directly. Full current file:

```ts
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { eq, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { seedLotsTable, facilitiesTable } from "@workspace/db";

const router = Router();

const seedLotLookupLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

router.get("/seed-lots/lookup", seedLotLookupLimiter, async (req, res) => {
  try {
    const qrCode = req.query.qrCode as string;
    if (!qrCode) {
      return res.status(400).json({ error: "qrCode query parameter is required" });
    }

    const [defaultFacility] = await db
      .select({ id: facilitiesTable.id })
      .from(facilitiesTable)
      .orderBy(facilitiesTable.id)
      .limit(1);
    if (!defaultFacility) {
      return res.status(500).json({ error: "No facility configured" });
    }
    const facilityId = defaultFacility.id;

    const [lot] = await db
      .select()
      .from(seedLotsTable)
      .where(and(eq(seedLotsTable.qrCode, qrCode), eq(seedLotsTable.facilityId, facilityId)))
      .limit(1);

    if (!lot) {
      return res.status(404).json({ error: "Seed lot not found" });
    }

    return res.json(lot);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to lookup seed lot" });
  }
});

export default router;
```

New — keep the rate limiter and every response shape/error message byte-identical; only the facility-resolution mechanism and the `db.`/`console.error` → `withTenantScope`/`req.log.error` calls change:

```ts
import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { eq, and } from "drizzle-orm";
import { withTenantScope, seedLotsTable } from "@workspace/db";
import { requireTenantContext } from "../middlewares/tenantContext";

const router = Router();

const seedLotLookupLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

router.get("/seed-lots/lookup", seedLotLookupLimiter, requireTenantContext, async (req: Request, res: Response) => {
  try {
    const qrCode = req.query.qrCode as string;
    if (!qrCode) {
      return res.status(400).json({ error: "qrCode query parameter is required" });
    }

    const [lot] = await withTenantScope(req.tenant!, (tx) =>
      tx
        .select()
        .from(seedLotsTable)
        .where(and(eq(seedLotsTable.qrCode, qrCode), eq(seedLotsTable.facilityId, req.tenant!.facilityId)))
        .limit(1),
    );

    if (!lot) {
      return res.status(404).json({ error: "Seed lot not found" });
    }

    return res.json(lot);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to lookup seed lot" });
  }
});

export default router;
```

Read `artifacts/api-server/src/routes/seedLots.ts` directly first to confirm the exact current handler signature/error-message text before replacing — MT-M0's Task 6 wrote this file; match its existing response shape exactly, only the facility-resolution mechanism changes.

`seedLotsRouter` is mounted via `routes/index.ts` alongside `growthProfilesRouter` — apply `requireTenantContext` the same per-route way as Task 7 (already shown above as a route-level middleware, not a router-mount change).

#### Update `check-tenant-scope.mjs`'s baseline (if Task 3 added a `seedLots.ts` entry)

If Task 3 added `seedLots.ts`'s lookup query to `BASELINE_VIOLATIONS` (because it was still unfixed at that point), remove that entry now — this task fixes it, so it's no longer a baseline debt item:

```js
const BASELINE_VIOLATIONS = new Set([
  "artifacts/api-server/src/routes/alerts.ts::rows = await db.select().from(alertsTable).orderBy(desc(alertsTable.createdAt));",
  "artifacts/api-server/src/routes/dashboard.ts::const allSensors = await db.select().from(sensorsTable);",
  "artifacts/api-server/src/routes/facility-readiness.ts::const [{ sensorCount }] = await db.select({ sensorCount: count() }).from(sensorsTable);",
  "artifacts/api-server/src/routes/facility-readiness.ts::const [{ cycleCount }] = await db.select({ cycleCount: count() }).from(cyclesTable);",
  "artifacts/api-server/src/routes/growthProfiles.ts::const profiles = await db.select().from(growthProfilesTable);",
  "artifacts/api-server/src/routes/sensors.ts::const rows = await db.select().from(sensorsTable);",
]);
```

Note: `alerts.ts`, `growthProfiles.ts`, `sensors.ts` baseline entries above are now ALSO stale (Tasks 4, 5, 7 fixed those exact lines) — remove all three, plus `seedLots.ts`'s if present. `dashboard.ts`, `facility-readiness.ts`, and `layout.ts`'s entries are genuinely still open (none of the three is in this plan's scope) — leave all three. (`layout.ts` was discovered by Task 3's own hardened multi-line detection, not anticipated when this note was originally written; it's the same category of pre-existing, out-of-scope debt as the other two, confirmed by Task 3's review.)

#### Wire `requireTenantContext` for `inventoryRouter`

```ts
app.use("/api", requireSignedIn, requireTenantContext, inventoryRouter);
```

#### Run, fix, commit

```bash
git add artifacts/api-server/src/routes/inventory.ts artifacts/api-server/src/routes/seedLots.ts artifacts/api-server/src/app.ts scripts/ci/check-tenant-scope.mjs
git commit -m "feat(tenancy): rewire inventory/seed-lots to withTenantScope, retire pilot-default facility resolution"
```

---

### Task 9: Accounting — QuickBooks organization scoping

**Files:**
- Modify: `artifacts/api-server/src/lib/accounting/quickbooks.ts`
- Modify: `artifacts/api-server/src/routes/accounting.ts` (pass `req.tenant!.organizationId` through to the lib functions)

**Interfaces:**
- Consumes: `req.tenant`.
- Produces: `saveConnectionFromCallback`, `getConnectionStatus`, `disconnect`, `getAuthenticatedClient`, `isConnected` all gain an `organizationId: number` parameter — Task 12 (metrics) calls `isConnected` too and needs to pass this through.

`accountingConnectionsTable.organizationId` is NOT NULL per MT-M0's schema, but every function here is currently keyed purely by `userId`. The minimal, correct fix for this milestone: keep the one-row-per-user lookup semantics (out of scope to redesign to per-org shared connections — that's a real behavior change, not a typecheck/scoping fix), but thread `organizationId` through as a required parameter so every insert/update satisfies the NOT NULL constraint and every read additionally confirms the row belongs to the caller's own org (closing a latent cross-org leak: today, if a `userId` were ever guessable/reused, `getConnectionRow` would return ANY user's row regardless of caller's org).

```ts
async function getConnectionRow(userId: string, organizationId: number) {
  const [row] = await db
    .select()
    .from(accountingConnectionsTable)
    .where(
      and(
        eq(accountingConnectionsTable.userId, userId),
        eq(accountingConnectionsTable.provider, "quickbooks"),
        eq(accountingConnectionsTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row;
}

export async function saveConnectionFromCallback(
  userId: string,
  organizationId: number,
  callbackUrl: string,
): Promise<{ realmId: string }> {
  const client = createOAuthClient();
  const authResponse = await client.createToken(callbackUrl);
  const token = authResponse.getToken();

  if (!token.realmId || !token.access_token || !token.refresh_token) {
    throw new Error("QuickBooks callback did not return a complete token");
  }

  const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000);

  await db
    .insert(accountingConnectionsTable)
    .values({
      userId,
      organizationId,
      provider: "quickbooks",
      realmId: token.realmId,
      accessTokenEnc: encryptToken(token.access_token),
      refreshTokenEnc: encryptToken(token.refresh_token),
      expiresAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [accountingConnectionsTable.userId, accountingConnectionsTable.provider],
      set: {
        realmId: token.realmId,
        accessTokenEnc: encryptToken(token.access_token),
        refreshTokenEnc: encryptToken(token.refresh_token),
        expiresAt,
        updatedAt: new Date(),
      },
    });

  return { realmId: token.realmId };
}

export async function getConnectionStatus(userId: string, organizationId: number) {
  const row = await getConnectionRow(userId, organizationId);
  if (!row) return { connected: false as const };
  return {
    connected: true as const,
    realmId: row.realmId,
    companyName: row.companyName,
    environment: QBO_ENV,
  };
}

export async function disconnect(userId: string, organizationId: number): Promise<boolean> {
  const row = await getConnectionRow(userId, organizationId);
  if (!row) return false;

  try {
    const client = createOAuthClient();
    client.setToken({ refresh_token: decryptToken(row.refreshTokenEnc) });
    await client.revoke();
  } catch {
    // Best-effort revoke with Intuit; proceed to delete our record regardless.
  }

  await db.delete(accountingConnectionsTable).where(eq(accountingConnectionsTable.id, row.id));
  return true;
}

export async function getAuthenticatedClient(
  userId: string,
  organizationId: number,
): Promise<{ client: OAuthClient; realmId: string }> {
  const row = await getConnectionRow(userId, organizationId);
  if (!row) throw new Error("QuickBooks is not connected for this user");

  const client = createOAuthClient();
  const accessToken = decryptToken(row.accessTokenEnc);
  const refreshToken = decryptToken(row.refreshTokenEnc);
  client.setToken({ access_token: accessToken, refresh_token: refreshToken, realmId: row.realmId });

  const needsRefresh = row.expiresAt.getTime() <= Date.now() + 60_000;
  if (needsRefresh) {
    const refreshed = await client.refresh();
    const token = refreshed.getToken();
    const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000);
    await db
      .update(accountingConnectionsTable)
      .set({
        accessTokenEnc: encryptToken(token.access_token!),
        refreshTokenEnc: encryptToken(token.refresh_token ?? refreshToken),
        expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(accountingConnectionsTable.id, row.id));
  }

  return { client, realmId: row.realmId };
}

export async function isConnected(userId: string, organizationId: number): Promise<boolean> {
  const row = await getConnectionRow(userId, organizationId);
  return !!row;
}
```

#### `accounting.ts` callers — the OAuth callback has NO `req.tenant` at all

`accounting.ts` has two routers: `accountingRouter` (authenticated, mounted after `requireSignedIn`) and `accountingPublicRouter` (mounted at `app.ts:108`, **before** `requireSignedIn`/`resolveTenantContext` even run — Intuit's browser redirect can't carry a Bearer token or session, so `/accounting/callback` has no `req.tenant`, and never will). `saveConnectionFromCallback` is called from exactly that public callback — so `req.tenant!.organizationId` is not available at its call site, unlike the other 4 functions.

The fix: `connect` (authenticated, has `req.tenant`) already stores `{userId, expiresAt}` in the in-memory `pendingStates` map, keyed by the CSRF `state` token, specifically so the unauthenticated callback can recover context. Add `organizationId` to that same stored entry at connect-time, and read it back in the callback — no new plumbing needed, just one more field on an object that already exists for exactly this purpose.

Full current file (`accounting.ts`), with the 3 changes marked:

```ts
import { Router, type Request, type Response } from "express";
import { getAuth } from "../middlewares/supabaseAuth";
import { randomBytes } from "node:crypto";
import {
  getAuthorizeUri,
  saveConnectionFromCallback,
  getConnectionStatus,
  disconnect,
} from "../lib/accounting/quickbooks";

const pendingStates = new Map<string, { userId: string; organizationId: number; expiresAt: number }>();

function cleanupExpiredStates() {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (entry.expiresAt < now) pendingStates.delete(state);
  }
}

// ── Authenticated router (mount behind requireSignedIn, requireTenantContext) ──

export const accountingRouter = Router();

accountingRouter.get("/accounting/connect", (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  cleanupExpiredStates();
  const state = randomBytes(16).toString("hex");
  // Change 1: store organizationId alongside userId -- the unauthenticated
  // callback below has no req.tenant to read it from otherwise.
  pendingStates.set(state, { userId: userId, organizationId: req.tenant!.organizationId, expiresAt: Date.now() + 10 * 60 * 1000 });

  const uri = getAuthorizeUri(state);
  return res.json({ authorizeUri: uri });
});

accountingRouter.get("/accounting/status", async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  // Change 2: organizationId comes from req.tenant here (this route IS behind requireTenantContext).
  const status = await getConnectionStatus(userId, req.tenant!.organizationId);
  return res.json(status);
});

accountingRouter.post("/accounting/disconnect", async (req: Request, res: Response) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const ok = await disconnect(userId, req.tenant!.organizationId);
  return res.json({ disconnected: ok });
});

// ── Public router (mount before requireSignedIn) ───────────────────────────

export const accountingPublicRouter = Router();

accountingPublicRouter.get("/accounting/callback", async (req: Request, res: Response) => {
  const state = req.query.state as string | undefined;
  const entry = state ? pendingStates.get(state) : undefined;

  const dashboardUrl = process.env.DASHBOARD_URL ?? "/";
  const redirectWithStatus = (status: "connected" | "error", message?: string) => {
    const url = new URL(`${dashboardUrl}/accounting`);
    url.searchParams.set("qbo", status);
    if (message) url.searchParams.set("message", message);
    return res.redirect(url.toString());
  };

  if (!entry) {
    return redirectWithStatus("error", "Invalid or expired OAuth state");
  }
  pendingStates.delete(state!);

  try {
    const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    // Change 3: organizationId comes from the pendingStates entry (stored at
    // connect-time), NOT req.tenant -- this route has no tenant context, it
    // isn't behind requireTenantContext or even requireSignedIn.
    await saveConnectionFromCallback(entry.userId, entry.organizationId, fullUrl);
    return redirectWithStatus("connected");
  } catch (err) {
    req.log.error(err);
    return redirectWithStatus("error", "Failed to complete QuickBooks connection");
  }
});
```

Wire `requireTenantContext` into `accountingRouter`'s mount (NOT `accountingPublicRouter`, which stays exactly where it is, before `requireSignedIn`):

```ts
app.use("/api", requireSignedIn, requireTenantContext, accountingRouter);
```

#### `quickbooks-reports.ts` — 15 wrapper functions, all keyed by `userId` only

`templates.ts`'s `quickbooksTemplate` calls `runQuickbooksQuery(p.key, userId)`, which dispatches to one of 15 functions in `RAW_QUERIES`, every one of which calls `fetchReport`/`queryQbo` → `getAuthenticatedClient(userId)`. Since `getAuthenticatedClient` now requires `organizationId` too, `organizationId` must thread all the way through: `runQuickbooksQuery` → each `RAW_QUERIES` function → `fetchReport`/`queryQbo`.

`fetchReport`/`queryQbo` (2 functions):

```ts
async function fetchReport(
  userId: string,
  organizationId: number,
  reportName: "ProfitAndLoss" | "BalanceSheet",
  params: Record<string, string> = {},
): Promise<QboReport> {
  const { client, realmId } = await getAuthenticatedClient(userId, organizationId);
  const url = `${baseUrl(currentEnvironment())}/v3/company/${realmId}/reports/${reportName}`;
  const res = await client.makeApiCall({
    url,
    method: "GET",
    params: { minorversion: QBO_MINOR_VERSION, ...params },
  });
  return res.json as QboReport;
}

async function queryQbo(userId: string, organizationId: number, query: string): Promise<any> {
  const { client, realmId } = await getAuthenticatedClient(userId, organizationId);
  const url = `${baseUrl(currentEnvironment())}/v3/company/${realmId}/query`;
  const res = await client.makeApiCall({
    url,
    method: "GET",
    params: { query, minorversion: QBO_MINOR_VERSION },
  });
  return res.json;
}
```

`monthlyGroupSeries` (the one shared helper the 2 `*.byMonth` functions call):

```ts
async function monthlyGroupSeries(userId: string, organizationId: number, group: string): Promise<{ label: string; value: number }[]> {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const report = await fetchReport(userId, organizationId, "ProfitAndLoss", {
    start_date: start.toISOString().slice(0, 10),
    end_date: now.toISOString().slice(0, 10),
    summarize_column_by: "Month",
  });
  const rows = report.Rows?.Row;
  const target = rows?.find((r) => r.group === group);
  if (!target?.Summary?.ColData) return [];
  const headerCols = (rows?.find((r) => r.type === "Header")?.Header?.ColData ?? []) as { value?: string }[];
  const values = target.Summary.ColData;
  const out: { label: string; value: number }[] = [];
  for (let i = 1; i < values.length - 1; i++) {
    const label = headerCols[i]?.value ?? `M${i}`;
    out.push({ label, value: Number(values[i]?.value) || 0 });
  }
  return out;
}
```

The 15 `RAW_QUERIES` functions — each gains `organizationId: number` as its second parameter, passed straight through to whichever of `fetchReport`/`queryQbo`/`monthlyGroupSeries` it already calls (no other line in any of them changes):

```ts
async function acctRevenueTotal(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "ProfitAndLoss", last30DaysParams());
  return { value: findGroupTotal(report.Rows?.Row, "Income") };
}

async function acctExpensesTotal(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "ProfitAndLoss", last30DaysParams());
  return { value: findGroupTotal(report.Rows?.Row, "Expenses") };
}

async function acctNetIncome(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "ProfitAndLoss", last30DaysParams());
  const income = findGroupTotal(report.Rows?.Row, "Income");
  const expenses = findGroupTotal(report.Rows?.Row, "Expenses");
  return { value: income - expenses };
}

async function acctGrossProfitMargin(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "ProfitAndLoss", last30DaysParams());
  const income = findGroupTotal(report.Rows?.Row, "Income");
  const cogs = findGroupTotal(report.Rows?.Row, "COGS");
  return { value: income > 0 ? (income - cogs) / income : 0 };
}

async function acctRevenueByMonth(userId: string, organizationId: number) {
  return monthlyGroupSeries(userId, organizationId, "Income");
}

async function acctExpensesByMonth(userId: string, organizationId: number) {
  return monthlyGroupSeries(userId, organizationId, "Expenses");
}

async function acctExpensesByCategory(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "ProfitAndLoss", last30DaysParams());
  return flattenLeafRows(report.Rows?.Row, "Expenses");
}

async function acctCashBalance(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "BalanceSheet");
  return { value: findGroupTotal(report.Rows?.Row, "BankAccounts") };
}

async function acctAccountsReceivable(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "BalanceSheet");
  return { value: findGroupTotal(report.Rows?.Row, "AR") };
}

async function acctAccountsPayable(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "BalanceSheet");
  return { value: findGroupTotal(report.Rows?.Row, "AP") };
}

async function acctCurrentRatio(userId: string, organizationId: number) {
  const report = await fetchReport(userId, organizationId, "BalanceSheet");
  const currentAssets = findGroupTotal(report.Rows?.Row, "TotalCurrentAssets");
  const currentLiabilities = findGroupTotal(report.Rows?.Row, "TotalCurrentLiabilities");
  return { value: currentLiabilities > 0 ? currentAssets / currentLiabilities : 0 };
}

async function acctInvoicesOverdue(userId: string, organizationId: number) {
  const today = new Date().toISOString().slice(0, 10);
  const result = await queryQbo(
    userId,
    organizationId,
    `SELECT Id, DocNumber, CustomerRef, DueDate, Balance, TotalAmt FROM Invoice WHERE Balance > '0' AND DueDate < '${today}' ORDERBY DueDate ASC MAXRESULTS 50`,
  );
  const invoices = result?.QueryResponse?.Invoice ?? [];
  return invoices.map((inv: any) => ({
    docNumber: inv.DocNumber ?? "",
    customer: inv.CustomerRef?.name ?? "",
    dueDate: inv.DueDate ?? "",
    balance: Number(inv.Balance) || 0,
    totalAmt: Number(inv.TotalAmt) || 0,
  }));
}

async function acctInvoicesByStatus(userId: string, organizationId: number) {
  const today = new Date().toISOString().slice(0, 10);
  const result = await queryQbo(userId, organizationId, "SELECT Id, Balance, DueDate FROM Invoice MAXRESULTS 1000");
  const invoices = result?.QueryResponse?.Invoice ?? [];
  let paid = 0, overdue = 0, pending = 0;
  for (const inv of invoices) {
    const balance = Number(inv.Balance) || 0;
    if (balance === 0) paid++;
    else if (inv.DueDate && inv.DueDate < today) overdue++;
    else pending++;
  }
  return [
    { label: "Paid", value: paid },
    { label: "Overdue", value: overdue },
    { label: "Pending", value: pending },
  ];
}

async function acctInvoicesAgingBuckets(userId: string, organizationId: number) {
  const result = await queryQbo(userId, organizationId, "SELECT Id, Balance, DueDate FROM Invoice WHERE Balance > '0' MAXRESULTS 1000");
  const invoices = result?.QueryResponse?.Invoice ?? [];
  const now = Date.now();
  const buckets = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  for (const inv of invoices) {
    const balance = Number(inv.Balance) || 0;
    if (!inv.DueDate) continue;
    const daysOverdue = Math.floor((now - new Date(inv.DueDate).getTime()) / 86_400_000);
    if (daysOverdue <= 30) buckets["0-30"] += balance;
    else if (daysOverdue <= 60) buckets["31-60"] += balance;
    else if (daysOverdue <= 90) buckets["61-90"] += balance;
    else buckets["90+"] += balance;
  }
  return Object.entries(buckets).map(([label, value]) => ({ label, value }));
}

async function acctExpensesTopVendors(userId: string, organizationId: number) {
  const result = await queryQbo(userId, organizationId, "SELECT Id, VendorRef, TotalAmt FROM Bill MAXRESULTS 1000");
  const bills = result?.QueryResponse?.Bill ?? [];
  const byVendor = new Map<string, number>();
  for (const bill of bills) {
    const name = bill.VendorRef?.name ?? "(unknown)";
    byVendor.set(name, (byVendor.get(name) ?? 0) + (Number(bill.TotalAmt) || 0));
  }
  return Array.from(byVendor.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
}

const RAW_QUERIES: Record<string, (userId: string, organizationId: number) => Promise<unknown>> = {
  "acct.revenue.total": acctRevenueTotal,
  "acct.expenses.total": acctExpensesTotal,
  "acct.netIncome": acctNetIncome,
  "acct.grossProfitMargin": acctGrossProfitMargin,
  "acct.revenue.byMonth": acctRevenueByMonth,
  "acct.expenses.byMonth": acctExpensesByMonth,
  "acct.expenses.byCategory": acctExpensesByCategory,
  "acct.cashBalance": acctCashBalance,
  "acct.accountsReceivable": acctAccountsReceivable,
  "acct.accountsPayable": acctAccountsPayable,
  "acct.currentRatio": acctCurrentRatio,
  "acct.invoices.overdue": acctInvoicesOverdue,
  "acct.invoices.byStatus": acctInvoicesByStatus,
  "acct.invoices.agingBuckets": acctInvoicesAgingBuckets,
  "acct.expenses.topVendors": acctExpensesTopVendors,
};
```

`runQuickbooksQuery` and its cache — the cache key must include `organizationId` too (today it's `${userId}:${key}`; a user could theoretically belong to a different org across sessions in test/dev scenarios, and the cached data must not cross that boundary either):

```ts
export async function runQuickbooksQuery(key: string, userId: string, organizationId: number): Promise<unknown> {
  const fn = RAW_QUERIES[key];
  if (!fn) throw new Error(`no QuickBooks query registered for key: ${key}`);

  const cacheKey = `${organizationId}:${userId}:${key}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const data = await fn(userId, organizationId);
  cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

export function invalidateQuickbooksCache(userId: string, organizationId: number): void {
  const prefix = `${organizationId}:${userId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
```

Confirm every caller of `invalidateQuickbooksCache` (grep for it — likely `disconnect`'s route handler or `quickbooks.ts`'s own `disconnect` function) passes the new second argument.

#### `templates.ts`'s `quickbooksTemplate` — updated in Task 11, finished here

Task 11 left `quickbooksTemplate`'s call to `runQuickbooksQuery` unchanged pending this task's signature work. Now that `runQuickbooksQuery` takes `organizationId`, update:

```ts
export async function quickbooksTemplate(
  p: QuickbooksParams,
  _facilityId: number,
  _range?: string,
  userId?: string,
  organizationId?: number,
): Promise<unknown> {
  if (!userId) throw new Error("quickbooks template requires an authenticated user");
  if (organizationId === undefined) throw new Error("quickbooks template requires an organization id");
  return runQuickbooksQuery(p.key, userId, organizationId);
}
```

(this changes `TEMPLATES`'s shared dispatch signature one more time, from Task 11's `(p, facilityId, range?, userId?)` to `(p, facilityId, range?, userId?, organizationId?)` — update the `TEMPLATES` type and `metrics.ts`'s dispatch call to pass `req.tenant!.organizationId` as the 5th argument.)

#### Run, fix, commit

```bash
git add artifacts/api-server/src/lib/accounting/quickbooks.ts artifacts/api-server/src/lib/accounting/quickbooks-reports.ts artifacts/api-server/src/routes/accounting.ts artifacts/api-server/src/lib/metrics/templates.ts artifacts/api-server/src/routes/metrics.ts artifacts/api-server/src/app.ts
git commit -m "feat(tenancy): thread organizationId through QuickBooks connection lookups and report queries"
```

---

### Task 10: Overdue scanner — per-tenant loop

**Files:**
- Modify: `artifacts/api-server/src/lib/overdue-scanner.ts`

**Interfaces:**
- Consumes: `withTenantScope`, `organizationsTable`, `facilitiesTable` from `@workspace/db`.

`scanOverdueCyclesAndAlert` (`overdue-scanner.ts:14-93`) is a scheduled background job (startup + interval, `index.ts`), not an HTTP handler — no request/session exists to derive tenant context from. Loop over every organization's one facility and call `withTenantScope` once per tenant, matching this milestone's design.

Full current function body (`overdue-scanner.ts:14-93`):

```ts
export async function scanOverdueCyclesAndAlert(log?: Logger) {
  const runningRows = await db
    .select({ cycle: cyclesTable, profile: growthProfilesTable })
    .from(cyclesTable)
    .leftJoin(growthProfilesTable, eq(cyclesTable.growthProfileId, growthProfilesTable.id))
    .where(ne(cyclesTable.status, "completed"));

  type ActionItem = {
    cycleId: number;
    cycleShortId: string;
    seedName: string;
    trayPosition: string | null;
    type: "fertigation" | "harvest";
    daysOverdue: number;
  };

  const actionRequired: ActionItem[] = [];
  const now = Date.now();

  for (const { cycle, profile } of runningRows) {
    if (!profile) continue;

    if (cycle.status === "germination" && cycle.germinationStartedAt) {
      const dueMs = cycle.germinationStartedAt.getTime() + profile.germinationDays * 864e5;
      if (now > dueMs) {
        actionRequired.push({
          cycleId: cycle.id,
          cycleShortId: cycle.shortId,
          seedName: cycle.seedName,
          trayPosition: cycle.trayPosition,
          type: "fertigation",
          daysOverdue: Math.floor((now - dueMs) / 864e5),
        });
      }
    } else if (cycle.status === "fertigation" && cycle.fertigationStartedAt) {
      const dueMs = cycle.fertigationStartedAt.getTime() + profile.fertigationDays * 864e5;
      if (now > dueMs) {
        actionRequired.push({
          cycleId: cycle.id,
          cycleShortId: cycle.shortId,
          seedName: cycle.seedName,
          trayPosition: cycle.trayPosition,
          type: "harvest",
          daysOverdue: Math.floor((now - dueMs) / 864e5),
        });
      }
    }
  }

  let created = 0;
  for (const item of actionRequired) {
    const title =
      item.type === "harvest"
        ? `Overdue Harvest: ${item.seedName}`
        : `Overdue Fertigation Transition: ${item.seedName}`;
    const location = item.trayPosition ?? `Cycle ${item.cycleShortId}`;

    const [inserted] = await db
      .insert(alertsTable)
      .values({
        title,
        description: `Cycle #${item.cycleShortId} (${item.seedName}) is ${item.daysOverdue} day(s) overdue for ${item.type === "harvest" ? "harvesting" : "fertigation transition"}.`,
        severity: item.daysOverdue >= 3 ? "critical" : "warning",
        location,
        status: "current",
        actionType: item.type,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) created += 1;
  }

  log?.info({ scanned: runningRows.length, created }, "overdue scan complete");
  return { scanned: runningRows.length, created };
}
```

New — loop over every tenant, moving the entire body above (unchanged in substance) inside a per-tenant `withTenantScope` closure, using `tx` instead of `db`, filtering the initial query by `facility_id`, and adding `facilityId` to the `alertsTable` insert:

```ts
export async function scanOverdueCyclesAndAlert(log?: Logger) {
  const tenants = await db
    .select({ organizationId: organizationsTable.id, facilityId: facilitiesTable.id })
    .from(organizationsTable)
    .innerJoin(facilitiesTable, eq(facilitiesTable.organizationId, organizationsTable.id));

  let totalScanned = 0;
  let totalCreated = 0;

  for (const tenant of tenants) {
    const { scanned, created } = await withTenantScope(tenant, async (tx) => {
      const runningRows = await tx
        .select({ cycle: cyclesTable, profile: growthProfilesTable })
        .from(cyclesTable)
        .leftJoin(growthProfilesTable, eq(cyclesTable.growthProfileId, growthProfilesTable.id))
        .where(and(eq(cyclesTable.facilityId, tenant.facilityId), ne(cyclesTable.status, "completed")));

      type ActionItem = {
        cycleId: number;
        cycleShortId: string;
        seedName: string;
        trayPosition: string | null;
        type: "fertigation" | "harvest";
        daysOverdue: number;
      };

      const actionRequired: ActionItem[] = [];
      const now = Date.now();

      for (const { cycle, profile } of runningRows) {
        if (!profile) continue;

        if (cycle.status === "germination" && cycle.germinationStartedAt) {
          const dueMs = cycle.germinationStartedAt.getTime() + profile.germinationDays * 864e5;
          if (now > dueMs) {
            actionRequired.push({
              cycleId: cycle.id,
              cycleShortId: cycle.shortId,
              seedName: cycle.seedName,
              trayPosition: cycle.trayPosition,
              type: "fertigation",
              daysOverdue: Math.floor((now - dueMs) / 864e5),
            });
          }
        } else if (cycle.status === "fertigation" && cycle.fertigationStartedAt) {
          const dueMs = cycle.fertigationStartedAt.getTime() + profile.fertigationDays * 864e5;
          if (now > dueMs) {
            actionRequired.push({
              cycleId: cycle.id,
              cycleShortId: cycle.shortId,
              seedName: cycle.seedName,
              trayPosition: cycle.trayPosition,
              type: "harvest",
              daysOverdue: Math.floor((now - dueMs) / 864e5),
            });
          }
        }
      }

      let createdCount = 0;
      for (const item of actionRequired) {
        const title =
          item.type === "harvest"
            ? `Overdue Harvest: ${item.seedName}`
            : `Overdue Fertigation Transition: ${item.seedName}`;
        const location = item.trayPosition ?? `Cycle ${item.cycleShortId}`;

        const [inserted] = await tx
          .insert(alertsTable)
          .values({
            title,
            description: `Cycle #${item.cycleShortId} (${item.seedName}) is ${item.daysOverdue} day(s) overdue for ${item.type === "harvest" ? "harvesting" : "fertigation transition"}.`,
            severity: item.daysOverdue >= 3 ? "critical" : "warning",
            location,
            status: "current",
            actionType: item.type,
            facilityId: tenant.facilityId,
          })
          .onConflictDoNothing()
          .returning();

        if (inserted) createdCount += 1;
      }

      return { scanned: runningRows.length, created: createdCount };
    });

    totalScanned += scanned;
    totalCreated += created;
  }

  log?.info({ scanned: totalScanned, created: totalCreated }, "overdue scan complete");
  return { scanned: totalScanned, created: totalCreated };
}
```

(add `and`, `organizationsTable`, `facilitiesTable`, `withTenantScope` to the top-of-file imports.)

#### Verify no behavior change for the single-pilot-tenant case

Run: `pnpm --filter @workspace/api-server run test` (the existing `overdue-scanner`-adjacent tests, if any exist under `src/tests/`, should still pass — with exactly one tenant today, N=1 loop iterations, identical output to before).

#### Commit

```bash
git add artifacts/api-server/src/lib/overdue-scanner.ts
git commit -m "feat(tenancy): loop overdue scanner per-tenant via withTenantScope, no request context available"
```

---

### Task 11: Metrics — generic template scoping (`templates.ts`, `tz.ts`)

**Files:**
- Modify: `artifacts/api-server/src/lib/metrics/tz.ts`
- Modify: `artifacts/api-server/src/lib/metrics/templates.ts`
- Modify: `artifacts/api-server/src/routes/metrics.ts`

**Interfaces:**
- Consumes: `req.tenant`.
- Produces: `facilityScope(table)` (new export from `tz.ts`) — every template function in `templates.ts` calls it; Task 12's `custom.ts` reuses it directly for its own hand-written queries that touch the same tables.

#### Why this table set, and why some need a subquery not a direct column

Confirmed via the registry (`lib/metrics/src/registry-*.ts`) which tables ever appear as `p.table`: `cycles`, `alerts`, `tasks`, `shipments`, `seed_lots` (direct `facility_id` column, per MT-M0's schema); `stock_movements`, `bad_tray_entries`, `sensor_readings`, `cycle_seed_lots` (child tables with no `facility_id` of their own — confirmed via `lib/db/src/schema/index.ts`: `stock_movements.inventory_item_id` → `inventory_items.facility_id`; `bad_tray_entries.cycle_id` → `cycles.facility_id`; `sensor_readings.sensor_id` → `sensors.facility_id`; `cycle_seed_lots.cycle_id` → `cycles.facility_id`); `crops` (genuinely global shared reference data — `name` is globally unique, no tenant column at all, confirmed via schema — needs no predicate).

#### Step 1: Add `facilityScope(table)` to `tz.ts`, alongside the existing `softDelete(table)`

```ts
// artifacts/api-server/src/lib/metrics/tz.ts additions

/**
 * Tables the metrics registry declares as `p.table` that have their OWN
 * facility_id column, scoped directly.
 */
const DIRECT_FACILITY_TABLES = new Set(["cycles", "alerts", "tasks", "shipments", "seed_lots"]);

/**
 * Tables with no facility_id of their own -- scoped via a subquery through
 * their FK to a directly-scoped parent. Confirmed against
 * lib/db/src/schema/index.ts's actual FK references (not the registry's own
 * bespoke `join` clauses, which serve a different purpose -- dimension/label
 * joins, not scoping -- and must not be relied on for this).
 */
const CHILD_FACILITY_SUBQUERIES: Record<string, string> = {
  stock_movements: "inventory_item_id IN (SELECT id FROM inventory_items WHERE facility_id = :facilityId)",
  bad_tray_entries: "cycle_id IN (SELECT id FROM cycles WHERE facility_id = :facilityId)",
  sensor_readings: "sensor_id IN (SELECT id FROM sensors WHERE facility_id = :facilityId)",
  cycle_seed_lots: "cycle_id IN (SELECT id FROM cycles WHERE facility_id = :facilityId)",
};

/**
 * Facility-scope WHERE fragment for a metrics registry table. "" for tables
 * with no tenant column at all (crops -- a genuinely global shared catalog,
 * confirmed via schema: no facility_id/organization_id, name globally
 * unique). Threaded through :facilityId the same way :cutover/:weekStart/
 * :monthStart already are (substitutePlaceholders below).
 */
export function facilityScope(table: string): string {
  if (DIRECT_FACILITY_TABLES.has(table)) return `${table}.facility_id = :facilityId`;
  if (table in CHILD_FACILITY_SUBQUERIES) return CHILD_FACILITY_SUBQUERIES[table]!;
  return "";
}
```

#### Step 2: Wire `:facilityId` into `substitutePlaceholders`

Current (`tz.ts`, the `substitutePlaceholders` function):

```ts
export function substitutePlaceholders(q: string): string {
  return q
    .replace(/:cutover/g, `'${BAD_TRAYS_CUTOVER_DATE}'`)
    .replace(/:weekStart/g, `(${facilityNow()} - interval '7 days')`)
    .replace(/:monthStart/g, `(${facilityNow()} - interval '30 days')`);
}
```

New — `:facilityId` needs the REAL caller-supplied facility id, not a fixed constant, so `substitutePlaceholders` gains a parameter (every call site in `templates.ts`/`custom.ts` is updated to pass it):

```ts
export function substitutePlaceholders(q: string, facilityId: number): string {
  return q
    .replace(/:cutover/g, `'${BAD_TRAYS_CUTOVER_DATE}'`)
    .replace(/:weekStart/g, `(${facilityNow()} - interval '7 days')`)
    .replace(/:monthStart/g, `(${facilityNow()} - interval '30 days')`)
    .replace(/:facilityId/g, String(Number(facilityId)));
}
```

`String(Number(facilityId))` — `Number(...)` first guarantees the interpolated value can only ever be a JS number rendered as digits (never a string containing SQL), since `facilityId` here always originates from `req.tenant!.facilityId` (an integer resolved server-side from `organization_members`/`facilities`, never user input) — safe to embed directly in the raw SQL string on that basis, consistent with how `BAD_TRAYS_CUTOVER_DATE`/interval constants are already embedded the same way.

#### Step 3: Thread `facilityId`/`timezone` through every template function

**Every function dispatched through `TEMPLATES` is called positionally with the exact same argument order** (`metrics.ts`'s single dispatch call site, finished in Task 12, passes `(params, facilityId, timezone, range, userId, organizationId)` to whichever function `TEMPLATES[template]` resolves to). This means every one of the 5 functions below must accept `timezone` as its 3rd parameter — even the 4 that don't use it — or `timezone` would silently land in the `range` parameter slot by position for any function that omits it. Only `timeBucket` actually uses `timezone` (via `facilityNow`); the other 4 accept and ignore it, matching the existing `void range` pattern already used elsewhere in this file for unused parameters.

```ts
export async function scalarAgg(p: ScalarAggParams, facilityId: number, timezone: string, range?: string): Promise<{ value: number }> {
  void timezone;
  const where = andWhere(softDelete(p.table), facilityScope(p.table), p.where, rangeWindowFor(p.table, p, range));
  const join = p.join ? `JOIN ${p.join}` : "";
  const q = substitutePlaceholders(
    `SELECT ${aggExpr(p.measure, p.agg)} AS value FROM ${p.table} ${join} WHERE ${where}`,
    facilityId,
  );
  const res = await db.execute(sql.raw(q));
  return { value: num((res.rows[0] as Row)?.value) };
}

export async function groupBy(p: GroupByParams, facilityId: number, timezone: string, range?: string): Promise<{ label: string; value: number }[]> {
  void timezone;
  const where = andWhere(softDelete(p.table), facilityScope(p.table), p.where, rangeWindowFor(p.table, p, range));
  const order = p.order ? `ORDER BY value ${p.order.toUpperCase()}` : "ORDER BY value DESC";
  const limit = p.limit ? `LIMIT ${p.limit}` : "";
  const join = p.join ? `JOIN ${p.join}` : "";
  const q = substitutePlaceholders(
    `SELECT COALESCE(${p.dim}::text, '(unknown)') AS label, ${aggExpr(p.measure, p.agg)} AS value
     FROM ${p.table} ${join} WHERE ${where} GROUP BY ${p.dim} ${order} ${limit}`,
    facilityId,
  );
  const res = await db.execute(sql.raw(q));
  return (res.rows as Row[]).map((r) => ({ label: String(r.label ?? ""), value: num(r.value) }));
}

export async function timeBucket(p: TimeBucketParams, facilityId: number, timezone: string, range?: string): Promise<{ label: string; value: number }[]> {
  const { unit, count } = bucketRange(p.bucket, range);
  const start = `${dateTrunc(unit, facilityNow(timezone))} - interval '${count - 1} ${unit}s'`;
  const end = dateTrunc(unit, facilityNow(timezone));
  const intervalStep = `interval '1 ${unit}'`;
  const join = p.sensorType
    ? `${p.table} t JOIN sensors s ON s.id = t.sensor_id AND s.type = '${p.sensorType}'`
    : p.table;
  const dateCol = p.sensorType ? `t.${p.dateCol}` : `${p.table}.${p.dateCol}`;
  const measureExpr = p.measure === "*" ? "*" : p.sensorType ? `t.${p.measure}` : `${p.table}.${p.measure}`;
  const where = andWhere(softDelete(p.table), facilityScope(p.table), p.where);
  const q = substitutePlaceholders(
    `SELECT to_char(gs.d, '${labelFmt(unit)}') AS label,
            COALESCE(${sumOrCount(measureExpr)}, 0) AS value
     FROM generate_series(${start}, ${end}, ${intervalStep}) AS gs(d)
     LEFT JOIN ${join} ON ${dateTrunc(unit, dateCol)} = gs.d ${p.where ? `AND ${p.where}` : ""}
     GROUP BY gs.d ORDER BY gs.d`,
    facilityId,
  );
  const res = await db.execute(sql.raw(q));
  return (res.rows as Row[]).map((r) => ({ label: String(r.label ?? ""), value: num(r.value) }));
}

export async function ratio(p: RatioParams, facilityId: number, timezone: string, range?: string): Promise<{ value: number } | { label: string; value: number }[]> {
  void timezone; void range;
  if (p.dim) {
    const where = andWhere(softDelete(p.numTable), facilityScope(p.numTable), p.numWhere);
    const q = substitutePlaceholders(
      `SELECT COALESCE(${p.dim}::text, '(unknown)') AS label,
              COALESCE(${sumOrCount(p.numMeasure)}, 0) AS num,
              COALESCE(${sumOrCount(p.denMeasure)}, 0) AS den
       FROM ${p.numTable} WHERE ${where} GROUP BY ${p.dim} ORDER BY num DESC`,
      facilityId,
    );
    const res = await db.execute(sql.raw(q));
    return (res.rows as Row[]).map((r) => ({
      label: String(r.label ?? ""),
      value: num(r.den) !== 0 ? num(r.num) / num(r.den) : 0,
    }));
  }
  const numW = andWhere(softDelete(p.numTable), facilityScope(p.numTable), p.numWhere);
  const denW = andWhere(softDelete(p.denTable), facilityScope(p.denTable), p.denWhere);
  const q = substitutePlaceholders(
    `SELECT COALESCE((SELECT ${sumOrCount(p.numMeasure)} FROM ${p.numTable} WHERE ${numW}), 0) AS num,
            COALESCE((SELECT ${sumOrCount(p.denMeasure)} FROM ${p.denTable} WHERE ${denW}), 0) AS den`,
    facilityId,
  );
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const den = num(row.den);
  return { value: den !== 0 ? num(row.num) / den : 0 };
}

export async function tableTemplate(p: TableParams, facilityId: number, timezone: string, range?: string): Promise<Row[]> {
  void timezone; void range;
  const where = andWhere(softDelete(p.table), facilityScope(p.table), p.where);
  const order = p.order ? `ORDER BY 1 ${p.order.toUpperCase()}` : "";
  const limit = p.limit ? `LIMIT ${p.limit}` : "";
  const q = substitutePlaceholders(
    `SELECT ${p.cols} FROM ${p.table} ${p.join ? `JOIN ${p.join}` : ""} WHERE ${where} ${order} ${limit}`,
    facilityId,
  );
  const res = await db.execute(sql.raw(q));
  return res.rows as Row[];
}
```

`customTemplate`/`quickbooksTemplate` are handled in Task 12/9 respectively — both accept the same `(p, facilityId, timezone, range?, userId?, organizationId?)` positional shape for the same reason. Update the shared `TEMPLATES` dispatch signature at the bottom of the file:

```ts
export const TEMPLATES: Record<
  TemplateName,
  (p: any, facilityId: number, timezone: string, range?: string, userId?: string, organizationId?: number) => Promise<unknown>
> = {
  scalarAgg,
  groupBy,
  timeBucket,
  ratio,
  table: tableTemplate,
  custom: customTemplate,
  quickbooks: quickbooksTemplate,
};
```

(`customTemplate` is finished for real use in Task 12; `quickbooksTemplate` is finished in Task 9 — both must match this exact positional shape, not just "accept extra arguments," since JS dispatch here is entirely position-based.)

#### Step 4: `andWhere` already handles an empty-string fragment correctly

`andWhere` (`tz.ts:57-61`, unchanged) already filters out falsy/empty fragments — `facilityScope("crops")` returning `""` is filtered out automatically, so `crops`-based metrics get no facility predicate at all, correctly.

#### Step 5: Update `metrics.ts`'s `GET /metrics` dispatch loop

Full current handler (`metrics.ts:18-58`):

```ts
router.get("/metrics", async (req: Request, res: Response) => {
  const tab = req.query.tab as MetricTab | undefined;
  const keysParam = (req.query.keys as string | undefined) ?? "";
  const range = (req.query.range as string | undefined) ?? "all";
  const keys = keysParam.split(",").map((k) => k.trim()).filter(Boolean);
  const { userId } = getAuth(req);

  if (keys.length === 0) {
    return res.json({});
  }

  const valid: { id: string; template: TemplateName; params: any }[] = [];
  for (const id of keys) {
    const def = METRICS_BY_ID.get(id);
    if (!def) return res.status(400).json({ error: `unknown metric: ${id}` });
    if (tab && def.tab !== tab) return res.status(400).json({ error: `metric ${id} not in tab ${tab}` });
    if (def.source !== "metrics" || !def.template || !def.templateParams) {
      return res.status(400).json({ error: `metric ${id} is not a Tier-B metrics query` });
    }
    valid.push({ id, template: def.template, params: def.templateParams });
  }

  try {
    const entries = await Promise.all(
      valid.map(async (v) => {
        try {
          const data = await TEMPLATES[v.template](v.params, range, userId ?? undefined);
          return [v.id, data] as const;
        } catch (err) {
          return [v.id, { error: (err as Error).message }] as const;
        }
      }),
    );
    return res.json(Object.fromEntries(entries));
  } catch (err) {
    return res.status(500).json({ error: "metrics query failed", detail: (err as Error).message });
  }
});
```

New — thread `req.tenant!.facilityId` in as the required 2nd positional argument (matching this task's new `TEMPLATES` signature), keep `range`/`userId` as they were:

```ts
router.get("/metrics", async (req: Request, res: Response) => {
  const tab = req.query.tab as MetricTab | undefined;
  const keysParam = (req.query.keys as string | undefined) ?? "";
  const range = (req.query.range as string | undefined) ?? "all";
  const keys = keysParam.split(",").map((k) => k.trim()).filter(Boolean);
  const { userId } = getAuth(req);
  const facilityId = req.tenant!.facilityId;

  if (keys.length === 0) {
    return res.json({});
  }

  const valid: { id: string; template: TemplateName; params: any }[] = [];
  for (const id of keys) {
    const def = METRICS_BY_ID.get(id);
    if (!def) return res.status(400).json({ error: `unknown metric: ${id}` });
    if (tab && def.tab !== tab) return res.status(400).json({ error: `metric ${id} not in tab ${tab}` });
    if (def.source !== "metrics" || !def.template || !def.templateParams) {
      return res.status(400).json({ error: `metric ${id} is not a Tier-B metrics query` });
    }
    valid.push({ id, template: def.template, params: def.templateParams });
  }

  try {
    const entries = await Promise.all(
      valid.map(async (v) => {
        try {
          // Task 12 replaces this "UTC" placeholder with the caller's real
          // per-facility timezone (a facilitiesTable lookup) and adds
          // organizationId as a 5th argument for quickbooksTemplate. Kept as
          // an explicit positional argument now, not omitted, because every
          // TEMPLATES[...] function shares one fixed parameter order
          // (facilityId, timezone, range, ...) -- omitting it here would
          // shift `range` into the timezone slot by position for every
          // dispatched function.
          const data = await TEMPLATES[v.template](v.params, facilityId, "UTC", range, userId ?? undefined);
          return [v.id, data] as const;
        } catch (err) {
          return [v.id, { error: (err as Error).message }] as const;
        }
      }),
    );
    return res.json(Object.fromEntries(entries));
  } catch (err) {
    return res.status(500).json({ error: "metrics query failed", detail: (err as Error).message });
  }
});
```

Run `pnpm --filter @workspace/api-server run typecheck` and `pnpm --filter @workspace/api-server run test` at the end of this task with this "UTC" placeholder in place — it must pass cleanly on its own before Task 12 begins (Task 12 only changes the placeholder to a real lookup and adds `organizationId`, it does not fix anything broken by this task).

Add `requireTenantContext` to `metricsRouter`'s mount:

```ts
app.use("/api", requireSignedIn, requireTenantContext, metricsRouter);
```

#### Run, fix, commit

```bash
git add artifacts/api-server/src/lib/metrics/tz.ts artifacts/api-server/src/lib/metrics/templates.ts artifacts/api-server/src/routes/metrics.ts artifacts/api-server/src/app.ts
git commit -m "feat(tenancy): thread real facility scoping through the metrics template system"
```

---

### Task 12: Metrics — `custom.ts`'s 11 bespoke queries + `FACILITY_TIMEZONE` retirement

**Files:**
- Modify: `artifacts/api-server/src/lib/metrics/custom.ts` (all 11 functions)
- Modify: `artifacts/api-server/src/lib/metrics/tz.ts` (retire `FACILITY_TIMEZONE`, take a real timezone param)
- Modify: `artifacts/api-server/src/routes/metrics.ts` (thread the real facility timezone in, alongside `facilityId` from Task 11)

**Interfaces:**
- Consumes: `req.tenant!.facilityId`, `facilityScope` (Task 11).

#### Step 1: Retire `FACILITY_TIMEZONE`, take a real timezone

Current (`tz.ts`):

```ts
export const FACILITY_TIMEZONE = process.env.FACILITY_TIMEZONE ?? "America/New_York";
```

```ts
export function facilityNow(): string {
  return `now() AT TIME ZONE '${FACILITY_TIMEZONE}'`;
}
```

New — `facilityNow` takes the real per-facility timezone (from `facilities.timezone`, already populated per-facility since the onboarding wizard's W2 step) instead of a global constant:

```ts
export function facilityNow(timezone: string): string {
  return `now() AT TIME ZONE '${timezone}'`;
}
```

Every OTHER function in `tz.ts` that calls `facilityNow()` (`rangeWindow`, `substitutePlaceholders`) now needs the timezone threaded through too:

```ts
export function rangeWindow(colExpr: string, range: string | undefined, timezone: string): string {
  const days = rangeToDays(range);
  if (days == null) return "";
  return `${colExpr} >= (${facilityNow(timezone)}) - interval '${days} days'`;
}

export function substitutePlaceholders(q: string, facilityId: number, timezone: string): string {
  return q
    .replace(/:cutover/g, `'${BAD_TRAYS_CUTOVER_DATE}'`)
    .replace(/:weekStart/g, `(${facilityNow(timezone)} - interval '7 days')`)
    .replace(/:monthStart/g, `(${facilityNow(timezone)} - interval '30 days')`)
    .replace(/:facilityId/g, String(Number(facilityId)));
}
```

`timeBucket` in `templates.ts` (Task 11) also calls `facilityNow()` directly (for its `start`/`end` bucket-range computation) — go back and thread `timezone` through that call site too as part of finishing this task (Task 11 lands before this one but both touch the same file; if Task 11 already merged without a `timezone` parameter on `timeBucket`, add it now: `timeBucket(p, facilityId, timezone, range)`).

#### Step 2: Resolve the caller's real timezone and finish `GET /metrics`'s dispatch call

The middleware (Task 1) doesn't carry `timezone` on `req.tenant` (it's not needed for scoping, only for display) — resolve it directly in `metrics.ts` via one extra `facilitiesTable` lookup keyed by `req.tenant!.facilityId`. This is also where Task 9's `organizationId` (for `quickbooksTemplate`) gets threaded in, finishing the dispatch call Task 11 started:

```ts
router.get("/metrics", async (req: Request, res: Response) => {
  const tab = req.query.tab as MetricTab | undefined;
  const keysParam = (req.query.keys as string | undefined) ?? "";
  const range = (req.query.range as string | undefined) ?? "all";
  const keys = keysParam.split(",").map((k) => k.trim()).filter(Boolean);
  const { userId } = getAuth(req);
  const facilityId = req.tenant!.facilityId;
  const organizationId = req.tenant!.organizationId;

  if (keys.length === 0) {
    return res.json({});
  }

  const [{ timezone }] = await db
    .select({ timezone: facilitiesTable.timezone })
    .from(facilitiesTable)
    .where(eq(facilitiesTable.id, facilityId));

  const valid: { id: string; template: TemplateName; params: any }[] = [];
  for (const id of keys) {
    const def = METRICS_BY_ID.get(id);
    if (!def) return res.status(400).json({ error: `unknown metric: ${id}` });
    if (tab && def.tab !== tab) return res.status(400).json({ error: `metric ${id} not in tab ${tab}` });
    if (def.source !== "metrics" || !def.template || !def.templateParams) {
      return res.status(400).json({ error: `metric ${id} is not a Tier-B metrics query` });
    }
    valid.push({ id, template: def.template, params: def.templateParams });
  }

  try {
    const entries = await Promise.all(
      valid.map(async (v) => {
        try {
          const data = await TEMPLATES[v.template](v.params, facilityId, timezone, range, userId ?? undefined, organizationId);
          return [v.id, data] as const;
        } catch (err) {
          return [v.id, { error: (err as Error).message }] as const;
        }
      }),
    );
    return res.json(Object.fromEntries(entries));
  } catch (err) {
    return res.status(500).json({ error: "metrics query failed", detail: (err as Error).message });
  }
});
```

(add `facilitiesTable`, `eq` to the top-of-file imports.) Every template function's signature (Task 11's `scalarAgg`/`groupBy`/`timeBucket`/`ratio`/`tableTemplate`, this task's `customTemplate`) accepts and ignores the trailing `organizationId` it doesn't need — only `quickbooksTemplate` (Task 9) actually uses it. Adjust `TEMPLATES`'s shared `Record` type to `(p: any, facilityId: number, timezone: string, range?: string, userId?: string, organizationId?: number) => Promise<unknown>`.

#### Step 2b: `GET /metrics/availability` — also global today, also needs facility scoping

`computeGlobalAvailability` (`metrics.ts:78-91`) checks `shipments`/`sensor_readings`/`growth_profiles` with no facility filter at all, and caches the result in one shared `globalCache` variable used by every request regardless of tenant — a real cross-tenant leak in spirit (org B's dashboard would report "revenue available: true" based on org A's data alone). Fix both the query and the cache key:

```ts
async function computeFacilityAvailability(facilityId: number): Promise<Omit<Availability, "accounting_connected">> {
  const [rev, sensor, crop] = await Promise.all([
    db.execute(sql.raw(`SELECT EXISTS (SELECT 1 FROM shipments WHERE revenue_usd IS NOT NULL AND deleted_at IS NULL AND facility_id = ${Number(facilityId)}) AS v`)),
    db.execute(sql.raw(`SELECT EXISTS (SELECT 1 FROM sensor_readings WHERE sensor_id IN (SELECT id FROM sensors WHERE facility_id = ${Number(facilityId)})) AS v`)),
    db.execute(sql.raw(`SELECT EXISTS (SELECT 1 FROM growth_profiles WHERE crop_id IS NOT NULL AND organization_id = (SELECT organization_id FROM facilities WHERE id = ${Number(facilityId)})) AS v`)),
  ]);
  const v = (r: unknown) => Boolean((r as { rows: { v: boolean }[] }).rows[0]?.v);
  return {
    revenue: v(rev),
    sensor_readings: v(sensor),
    cost: false,
    crop_id: v(crop),
  };
}

router.get("/metrics/availability", async (req: Request, res: Response) => {
  try {
    const facilityId = req.tenant!.facilityId;
    const organizationId = req.tenant!.organizationId;
    const cached = globalCache.get(facilityId);
    const data = cached && cached.expiresAt > Date.now()
      ? cached.data
      : await computeFacilityAvailability(facilityId).then((data) => {
          globalCache.set(facilityId, { data, expiresAt: Date.now() + GLOBAL_TTL_MS });
          return data;
        });

    const { userId } = getAuth(req);
    let accountingConnected = false;
    if (userId) {
      const acctCacheKey = `${organizationId}:${userId}`;
      const cachedAcct = acctCache.get(acctCacheKey);
      if (cachedAcct && cachedAcct.expiresAt > Date.now()) {
        accountingConnected = cachedAcct.connected;
      } else {
        accountingConnected = await isQuickbooksConnected(userId, organizationId);
        acctCache.set(acctCacheKey, { connected: accountingConnected, expiresAt: Date.now() + ACCT_TTL_MS });
      }
    }

    return res.json({ ...data, accounting_connected: accountingConnected });
  } catch (err) {
    return res.status(500).json({ error: "availability query failed", detail: (err as Error).message });
  }
});
```

`globalCache` changes from a single nullable value to a `Map<number, {...}>` keyed by `facilityId`:

```ts
const globalCache = new Map<number, { data: Omit<Availability, "accounting_connected">; expiresAt: number }>();
```

Update `resetAvailabilityCache()` (used by tests) to `globalCache.clear()` instead of `globalCache = null`.

#### Step 3: Rewrite each of the 11 `custom.ts` functions

Every function gains `facilityId: number, timezone: string` parameters. Apply `facilityScope(table)` (from Task 11's `tz.ts` export) as an additional `AND` condition on whichever table anchors each query's tenant boundary. Read `custom.ts` directly (already captured in full during this plan's investigation) — apply per function:

```ts
async function ovYieldExpectedVsActual(facilityId: number, timezone: string) {
  const q = substitutePlaceholders(`
    SELECT gp.crop_id::text AS label,
           COALESCE(SUM(gp.expected_yield_per_tray_kg * (cycles.full_trays + cycles.half_trays * 0.5)), 0) AS expected,
           COALESCE(SUM(cycles.harvested_qty), 0) AS actual
    FROM cycles
    JOIN growth_profiles gp ON gp.id = cycles.growth_profile_id
    WHERE ${andWhere(softDelete("cycles"), facilityScope("cycles"), "cycles.status='completed'")}
    GROUP BY gp.crop_id
    ORDER BY actual DESC
  `, facilityId, timezone);
  const res = await db.execute(sql.raw(q));
  return (res.rows as Row[]).map((r) => ({
    label: String(r.label ?? "(unknown)"),
    expected: num(r.expected),
    actual: num(r.actual),
  }));
}

async function ovCapUtilByRoom(facilityId: number) {
  const q = `
    SELECT rm.name::text AS label,
           COUNT(*) FILTER (WHERE cycles.status IS NOT NULL AND cycles.status <> 'completed') AS running,
           COUNT(*) AS total
    FROM channels ch
    JOIN rooms rm ON rm.id = ch.room_id
    LEFT JOIN racks rk ON rk.channel_id = ch.id
    LEFT JOIN trays t ON t.rack_id = rk.id
    LEFT JOIN cycles ON cycles.tray_id = t.id AND cycles.deleted_at IS NULL
    WHERE rm.facility_id = ${Number(facilityId)}
    GROUP BY rm.name
    ORDER BY rm.name
  `;
  const res = await db.execute(sql.raw(q));
  return (res.rows as Row[]).map((r) => ({
    label: String(r.label ?? ""),
    value: num(r.total) > 0 ? Math.round((num(r.running) / num(r.total)) * 1000) / 10 : 0,
  }));
}

async function ovCapTrayMix(facilityId: number) {
  const q = `
    SELECT COALESCE(SUM(full_trays), 0) AS full_trays, COALESCE(SUM(half_trays), 0) AS half_trays
    FROM cycles WHERE status <> 'completed' AND deleted_at IS NULL AND facility_id = ${Number(facilityId)}
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  return [
    { label: "Full", value: num(row.full_trays) },
    { label: "Half", value: num(row.half_trays) },
  ];
}

async function ovCyclesCompletionRate(facilityId: number) {
  const q = `
    SELECT
      COUNT(*) FILTER (WHERE cycles.status = 'completed') AS completed,
      COUNT(*) AS cohort
    FROM cycles
    JOIN growth_profiles gp ON gp.id = cycles.growth_profile_id
    WHERE cycles.deleted_at IS NULL
      AND cycles.facility_id = ${Number(facilityId)}
      AND cycles.seeding_date >= current_date - interval '90 days'
      AND (cycles.status = 'completed'
           OR cycles.seeding_date + ((gp.germination_days + gp.fertigation_days) || ' days')::interval <= now())
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const cohort = num(row.cohort);
  return { value: cohort > 0 ? num(row.completed) / cohort : 0 };
}

async function ovBadRate(facilityId: number) {
  const q = `
    SELECT
      (SELECT COUNT(*) FROM bad_tray_entries
        WHERE created_at >= now() - interval '30 days'
          AND cycle_id IN (SELECT id FROM cycles WHERE facility_id = ${Number(facilityId)})) AS bad,
      (SELECT COALESCE(SUM(full_trays + half_trays), 0) FROM cycles
        WHERE seeding_date >= current_date - interval '30 days' AND deleted_at IS NULL
          AND facility_id = ${Number(facilityId)}) AS seeded
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const seeded = num(row.seeded);
  return { value: seeded > 0 ? num(row.bad) / seeded : 0 };
}

async function shRevGrowth(facilityId: number) {
  const q = `
    SELECT
      (SELECT COALESCE(SUM(revenue_usd), 0) FROM shipments
        WHERE deleted_at IS NULL AND shipping_date >= current_date - interval '30 days'
          AND facility_id = ${Number(facilityId)}) AS current,
      (SELECT COALESCE(SUM(revenue_usd), 0) FROM shipments
        WHERE deleted_at IS NULL AND shipping_date >= current_date - interval '60 days'
          AND shipping_date < current_date - interval '30 days'
          AND facility_id = ${Number(facilityId)}) AS prior
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const prior = num(row.prior);
  return { value: prior !== 0 ? (num(row.current) - prior) / prior : 0 };
}

async function shEconWasteRate(facilityId: number) {
  const q = `
    SELECT
      COALESCE(SUM(cycles.harvested_qty), 0) AS harvested,
      COALESCE(SUM(sold.total), 0) AS sold
    FROM cycles
    LEFT JOIN (
      SELECT cycle_id, SUM(yield_sold_kg) AS total
      FROM shipments WHERE deleted_at IS NULL AND cycle_id IS NOT NULL AND facility_id = ${Number(facilityId)}
      GROUP BY cycle_id
    ) sold ON sold.cycle_id = cycles.id
    WHERE cycles.status = 'completed' AND cycles.deleted_at IS NULL AND cycles.facility_id = ${Number(facilityId)}
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const harvested = num(row.harvested);
  return { value: harvested > 0 ? (harvested - num(row.sold)) / harvested : 0 };
}

async function invMovTurnover(facilityId: number) {
  const q = `
    SELECT
      COALESCE((SELECT SUM(ABS(delta)) FROM stock_movements
                 WHERE reason='consume' AND created_at >= now() - interval '30 days'
                   AND inventory_item_id IN (SELECT id FROM inventory_items WHERE facility_id = ${Number(facilityId)})), 0) AS consumed,
      COALESCE((SELECT AVG(current_qty) FROM inventory_items WHERE deleted_at IS NULL AND facility_id = ${Number(facilityId)}), 0) AS avg_stock
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const avgStock = num(row.avg_stock);
  return { value: avgStock > 0 ? num(row.consumed) / avgStock : 0 };
}

async function ovCapRackOccupancy(facilityId: number) {
  const q = `
    SELECT rk.label::text AS label,
           COUNT(*) FILTER (WHERE cycles.id IS NOT NULL) AS occupied,
           COUNT(*) AS total
    FROM racks rk
    JOIN channels ch ON ch.id = rk.channel_id
    JOIN rooms rm ON rm.id = ch.room_id
    LEFT JOIN trays t ON t.rack_id = rk.id
    LEFT JOIN cycles ON cycles.tray_id = t.id AND cycles.deleted_at IS NULL AND cycles.status <> 'completed'
    WHERE rm.facility_id = ${Number(facilityId)}
    GROUP BY rk.id, rk.label
    ORDER BY rk.label
  `;
  const res = await db.execute(sql.raw(q));
  return (res.rows as Row[]).map((r) => ({
    label: String(r.label ?? ""),
    value: num(r.total) > 0 ? Math.round((num(r.occupied) / num(r.total)) * 1000) / 10 : 0,
  }));
}

async function ovSensorUptime(facilityId: number) {
  const q = `
    SELECT
      COUNT(*) FILTER (WHERE last_read_at >= now() - interval '2 minutes') AS fresh,
      COUNT(*) AS total
    FROM sensors WHERE facility_id = ${Number(facilityId)}
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const total = num(row.total);
  return { value: total > 0 ? Math.round((num(row.fresh) / total) * 1000) / 10 : 0 };
}

async function invMovDaysRemaining(facilityId: number) {
  const q = `
    SELECT
      COALESCE((SELECT SUM(current_qty) FROM inventory_items WHERE deleted_at IS NULL AND facility_id = ${Number(facilityId)}), 0) AS current_qty,
      COALESCE((SELECT SUM(ABS(delta)) FROM stock_movements
                 WHERE reason='consume' AND created_at >= now() - interval '30 days'
                   AND inventory_item_id IN (SELECT id FROM inventory_items WHERE facility_id = ${Number(facilityId)})), 0) / 30.0 AS daily_rate
  `;
  const res = await db.execute(sql.raw(q));
  const row = res.rows[0] as Row;
  const dailyRate = num(row.daily_rate);
  return { value: dailyRate > 0 ? num(row.current_qty) / dailyRate : 0 };
}

export const CUSTOM_QUERIES: Record<string, (facilityId: number, timezone: string) => Promise<unknown>> = {
  "ov.yield.expectedVsActual": ovYieldExpectedVsActual,
  "ov.cap.utilByRoom": ovCapUtilByRoom,
  "ov.cap.trayMix": ovCapTrayMix,
  "ov.cycles.completionRate": ovCyclesCompletionRate,
  "ov.bad.rate": ovBadRate,
  "sh.rev.growth": shRevGrowth,
  "sh.econ.wasteRate": shEconWasteRate,
  "inv.mov.turnover": invMovTurnover,
  "inv.mov.daysRemaining": invMovDaysRemaining,
  "ov.cap.rackOccupancy": ovCapRackOccupancy,
  "ov.sensor.uptime": ovSensorUptime,
};
```

Every function that only takes `facilityId` (no `:cutover`/`:weekStart` placeholders in its raw SQL) doesn't need `timezone` threaded in at all — TypeScript will flag any mismatch against the shared `Record` signature above; where a function genuinely doesn't use `timezone`, still accept it as an unused second parameter to satisfy the shared type (matching the existing `void range;` pattern already used elsewhere in this file for unused parameters).

#### Step 4: Update `templates.ts`'s `customTemplate` dispatcher (Task 11 left this as a stub)

```ts
export async function customTemplate(
  p: CustomParams,
  facilityId: number,
  timezone: string,
  range?: string,
  _userId?: string,
  _organizationId?: number,
): Promise<unknown> {
  void range;
  const fn = CUSTOM_QUERIES[p.key];
  if (!fn) throw new Error(`no custom query registered for key: ${p.key}`);
  return fn(facilityId, timezone);
}
```

(`customTemplate` doesn't need `userId`/`organizationId` itself — accepts and ignores them to satisfy the shared `TEMPLATES` dispatch signature, same as `scalarAgg`/`groupBy`/`timeBucket`/`ratio`/`tableTemplate` from Task 11 do for the trailing `organizationId` they don't use either.)

#### Run, fix, commit

Run: `pnpm --filter @workspace/api-server run typecheck` — resolve every signature mismatch across `templates.ts`/`custom.ts`/`metrics.ts` together, since these 3 files' signatures are now mutually dependent.

Run: `pnpm --filter @workspace/api-server run test` — if any metrics golden-fixture test (`src/tests/metrics/`) exists (MT-M0's rehearsal report mentioned `metrics.test.ts`'s golden fixture), its seed data and expected values need a `facilityId` matching whatever tenant context the test now supplies — fix the fixture, do not weaken the assertions.

```bash
git add artifacts/api-server/src/lib/metrics/custom.ts artifacts/api-server/src/lib/metrics/tz.ts artifacts/api-server/src/routes/metrics.ts
git commit -m "feat(tenancy): scope all 11 custom metrics queries by facility, retire FACILITY_TIMEZONE for real per-facility timezone"
```

---

### Task 13: RLS role provisioning on staging

**Files:**
- Create: `docs/runbooks/mt-m1-rls-role-rotation.md`
- Modify: `docs/runbooks/tenancy-db-role.md` (record the result — MT-M0 left this open)

**Interfaces:**
- Consumes: `scripts/ci/verify-db-role.mjs` (shipped MT-M0, unrun until now).

#### Step 1: Provision a least-privilege role on staging

Connect to the staging Supabase project's SQL editor (or via `psql` with `STAGING_DATABASE_URL_DIRECT`, per `docs/runbooks/staging-bootstrap.md`) and run:

```sql
-- Least-privilege application role, no BYPASSRLS (unlike postgres/service_role).
CREATE ROLE farmsmart_app WITH LOGIN PASSWORD '<generate a real secret, store in Render env, never commit>';
GRANT USAGE ON SCHEMA public TO farmsmart_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO farmsmart_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO farmsmart_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO farmsmart_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO farmsmart_app;
-- auth.uid() (used by Task 2's policy) requires the role to read auth.users
-- indirectly via Supabase's own auth schema grants -- Supabase's built-in
-- `authenticated`/`anon` roles already have this; grant farmsmart_app the
-- same membership so auth.uid() resolves correctly under this role too:
GRANT authenticated TO farmsmart_app;
```

(this GRANT list is a starting point — run Step 3 below and iterate if any grant is missing, per this plan's own design-doc risk #4: "the new least-privilege role might be missing a grant the app actually needs.")

#### Step 2: Run `verify-db-role.mjs` against the new role, staging

```bash
DATABASE_URL="postgresql://farmsmart_app:<password>@<staging-pooler-host>:6543/postgres" node scripts/ci/verify-db-role.mjs
```

Expected: exits 0, confirms `rolbypassrls = false` for `farmsmart_app` (unlike the default `postgres`/`service_role`).

#### Step 3: Rotate staging's `DATABASE_URL`, verify the app still works end-to-end

In Render's dashboard for `farmsmart-api-staging`, update `DATABASE_URL` to the new role's connection string (transaction pooler, port 6543, per ADR-003/004's connection policy). Redeploy. Then run the FULL api-server test suite against staging (not the disposable stack) to catch any missing grant:

```bash
CI=true REQUIRE_TEST_DATABASE=true \
TEST_DATABASE_URL="$STAGING_DATABASE_URL" \
DATABASE_URL="$STAGING_DATABASE_URL" \
SUPABASE_URL="$STAGING_SUPABASE_URL" \
SUPABASE_SERVICE_ROLE_KEY="$STAGING_SERVICE_ROLE_KEY" \
pnpm --filter @workspace/api-server run test
```

If any test fails with a permission-denied error (not a scoping/RLS-visibility error — those are expected once RLS is truly enforced and the isolation suite, Task 14, hasn't run yet to prove it), add the missing grant and re-run. Keep the previous `DATABASE_URL` (the `postgres`/`service_role` one) noted in the runbook for a fast revert if something breaks that this test pass doesn't catch.

#### Step 4: Write the runbook

```markdown
# MT-M1 RLS Role Rotation

**Date:** <fill in with the actual date this was run>
**Environment:** staging (`farmsmart-api-staging`)

## What changed

Provisioned `farmsmart_app`, a least-privilege Postgres role with no
BYPASSRLS attribute (Supabase's default `postgres`/`service_role` both have
it, which silently makes every RLS policy in `00007_tenancy_rls_policies.sql`
a no-op). Rotated staging's `DATABASE_URL` to use it.

## Verification

- `verify-db-role.mjs`: <record actual output/exit code>
- Full api-server test suite against staging with the rotated role:
  <record pass/fail count>
- Any grants added beyond the initial list, and why: <record here>

## Production

NOT done in this task — this runbook covers staging only, per this plan's
scope. Rotate production's `DATABASE_URL` the same way, after this plan's
Task 14 (isolation suite) has proven the rotated staging role behaves
correctly under real cross-tenant traffic patterns.
```

Update `docs/runbooks/tenancy-db-role.md`'s previously-open "no live staging connection was reachable" section to point at this new runbook and record that staging is now resolved (production remains open, as stated above).

#### Commit

```bash
git add docs/runbooks/mt-m1-rls-role-rotation.md docs/runbooks/tenancy-db-role.md
git commit -m "docs: record MT-M1 staging RLS role rotation (farmsmart_app, non-BYPASSRLS)"
```

---

### Task 14: TEN-007 cross-tenant isolation suite (CI)

**Files:**
- Create: `artifacts/api-server/src/tests/isolation/cross-tenant.test.ts`

**Interfaces:**
- Consumes: every route rewired in Tasks 4-12, `useDatabaseFixture`/`seedTestUser`/`closeDatabasePoolAfterTests` (`tests/helpers/testDatabase.ts`, shipped MT-M0), `createAuthenticatedTestApp` (`tests/helpers/testApp.ts`).

#### Design

Provision two full tenants (org A + org B, each via a real `POST /facilities` call — the actual production code path, not a raw insert, so this suite also exercises Task 1's owner-membership insert for real) with two distinct signed-in test users. Seed one resource of each rewired type under org A. For every endpoint: (1) org A's own session can read/write it normally: (2) org B's session gets 404 on direct access by ID, and an empty list/array on any list endpoint — never A's data.

`createAuthenticatedTestApp(router, user)` (per `tests/helpers/testApp.ts`, confirmed above in Task 1's Step 7) takes exactly ONE `Router` and ONE `{sub, user_role?}` identity, mounting it under `/api` with `resolveTenantContext` already wired in (Task 1's fix). This suite needs several different route handlers (`facilities`, `alerts`, `tasks`, `shipments`, `inventory`, `growth-profiles`, `metrics`) reachable under two different identities — importing the real `app.ts` directly would double-mount every path under `/api/api/...` (its own routers are already mounted under `/api` internally), so instead combine the specific routers this suite needs into one local `Router`, then build one `createAuthenticatedTestApp` instance per identity from that combined router:

```ts
// artifacts/api-server/src/tests/isolation/cross-tenant.test.ts
import { describe, test, before } from "node:test";
import { strictEqual, ok } from "node:assert";
import { Router } from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createAuthenticatedTestApp } from "../helpers/testApp";
import {
  requireTestDatabaseUrl,
  useDatabaseFixture,
  seedTestUser,
  closeDatabasePoolAfterTests,
} from "../helpers/testDatabase";
import facilitiesRouter from "../../routes/facilities";
import alertsRouter from "../../routes/alerts";
import tasksRouter from "../../routes/tasks";
import shipmentsRouter from "../../routes/shipments";
import inventoryRouter from "../../routes/inventory";
import growthProfilesRouter from "../../routes/growthProfiles";
import metricsRouter from "../../routes/metrics";

const dbUrl = requireTestDatabaseUrl();
closeDatabasePoolAfterTests();

const combinedRouter = Router();
combinedRouter.use(facilitiesRouter);
combinedRouter.use(alertsRouter);
combinedRouter.use(tasksRouter);
combinedRouter.use(shipmentsRouter);
combinedRouter.use(inventoryRouter);
combinedRouter.use(growthProfilesRouter);
combinedRouter.use(metricsRouter);

describe("Cross-tenant isolation (TEN-007)", { skip: !dbUrl }, () => {
  // Every table this milestone scopes, plus the bootstrap tables the two
  // orgs themselves are created into -- a full-suite truncate is safe here
  // (this is the ONLY test file in the isolation/ directory, no cross-file
  // pollution risk per MT-M0's Task 13 finding).
  const fixture = useDatabaseFixture([
    "organizations", "facilities", "rooms", "users", "organization_members",
    "cycles", "inventory_items", "alerts", "tasks", "shipments",
    "facility_logs", "sensors", "growth_profiles", "seed_lots",
    "manual_checks", "bad_tray_entries",
  ]);

  let orgA: { app: ReturnType<typeof createAuthenticatedTestApp>; facilityId: number };
  let orgB: { app: ReturnType<typeof createAuthenticatedTestApp>; facilityId: number };
  let seededAlertId: number;
  let seededTaskId: number;
  let seededShipmentId: number;
  let seededInventoryItemId: number;
  let seededGrowthProfileId: number;

  before(async () => {
    const { db, usersTable } = await import("@workspace/db");

    async function provisionOrg(email: string) {
      const userId = randomUUID();
      await seedTestUser(db, usersTable, { id: userId, email });
      const testApp = createAuthenticatedTestApp(combinedRouter, { sub: userId });
      const createRes = await request(testApp)
        .post("/api/facilities")
        .send({ farmName: `Org for ${email}`, timezone: "UTC", units: "metric", currency: "USD" });
      strictEqual(createRes.status, 201, `facility creation for ${email} must succeed`);
      return { app: testApp, facilityId: createRes.body.facilityId as number };
    }

    orgA = await provisionOrg("org-a@isolation-test.example.com");
    orgB = await provisionOrg("org-b@isolation-test.example.com");

    // Org A's own growth profile -- MT-M1's own audit (Task 7's design)
    // found no per-org auto-seed exists (growthProfiles.ts's seedDataIfEmpty
    // is a one-time pilot bootstrap, not a per-org mechanism); each test org
    // needs its own row inserted directly.
    const { growthProfilesTable, facilitiesTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const [orgAFacility] = await db.select().from(facilitiesTable).where(eq(facilitiesTable.id, orgA.facilityId));
    const [gp] = await db
      .insert(growthProfilesTable)
      .values({
        name: "Isolation Test Crop",
        seedName: "Test Seed",
        germinationDays: 1,
        fertigationDays: 1,
        organizationId: orgAFacility!.organizationId,
      })
      .returning();
    seededGrowthProfileId = gp.id;

    const alertRes = await request(orgA.app).post("/api/alerts").send({ title: "Org A alert", severity: "warning" });
    seededAlertId = alertRes.body.id;

    const taskRes = await request(orgA.app).post("/api/tasks").send({ type: "harvest" });
    seededTaskId = taskRes.body.id;

    const shipmentRes = await request(orgA.app).post("/api/shipments").send({ client: "Org A Client" });
    seededShipmentId = shipmentRes.body.id;

    const inventoryRes = await request(orgA.app).post("/api/inventory").send({ name: "Org A Item" });
    seededInventoryItemId = inventoryRes.body.id;
  });

  test("TEN-003: two facilities each independently hold a seeding room (no cross-facility conflict)", async () => {
    const { db, roomsTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const [roomA] = await db.select().from(roomsTable).where(eq(roomsTable.facilityId, orgA.facilityId));
    const [roomB] = await db.select().from(roomsTable).where(eq(roomsTable.facilityId, orgB.facilityId));
    ok(roomA, "org A must have its own rooms");
    ok(roomB, "org B must have its own rooms");
  });

  test("GET /alerts: org B never sees org A's alert", async () => {
    const res = await request(orgB.app).get("/api/alerts");
    strictEqual(res.status, 200);
    ok(!res.body.some((a: { id: number }) => a.id === seededAlertId), "org B's alert list must not contain org A's alert");
  });

  test("PATCH /alerts/:id: org B gets 404 for org A's alert id, not 403 or 200", async () => {
    const res = await request(orgB.app).patch(`/api/alerts/${seededAlertId}`).send({ status: "resolved" });
    strictEqual(res.status, 404);
  });

  test("GET /tasks: org B never sees org A's task", async () => {
    const res = await request(orgB.app).get("/api/tasks");
    strictEqual(res.status, 200);
    ok(!res.body.some((t: { id: number }) => t.id === seededTaskId));
  });

  test("PATCH /tasks/:id: org B gets 404 for org A's task id", async () => {
    const res = await request(orgB.app).patch(`/api/tasks/${seededTaskId}`).send({ status: "done" });
    strictEqual(res.status, 404);
  });

  test("GET /shipments: org B never sees org A's shipment", async () => {
    const res = await request(orgB.app).get("/api/shipments");
    strictEqual(res.status, 200);
    const items = Array.isArray(res.body) ? res.body : res.body.items;
    ok(!items.some((s: { id: number }) => s.id === seededShipmentId));
  });

  test("DELETE /shipments/:id: org B gets 404 for org A's shipment id", async () => {
    const res = await request(orgB.app).delete(`/api/shipments/${seededShipmentId}`);
    strictEqual(res.status, 404);
  });

  test("GET /inventory: org B never sees org A's item", async () => {
    const res = await request(orgB.app).get("/api/inventory");
    strictEqual(res.status, 200);
    const items = Array.isArray(res.body) ? res.body : res.body.items;
    ok(!items.some((i: { id: number }) => i.id === seededInventoryItemId));
  });

  test("PATCH /inventory/:id: org B gets 404 for org A's item id", async () => {
    const res = await request(orgB.app).patch(`/api/inventory/${seededInventoryItemId}`).send({ currentQty: 5 });
    strictEqual(res.status, 404);
  });

  test("GET /growth-profiles: org B never sees org A's growth profile", async () => {
    const res = await request(orgB.app).get("/api/growth-profiles");
    strictEqual(res.status, 200);
    ok(!res.body.some((gp: { id: number }) => gp.id === seededGrowthProfileId));
  });

  test("GET /api/metrics: org B's dashboard totals never include org A's data", async () => {
    const resA = await request(orgA.app).get("/api/metrics").query({ tab: "overview", keys: "ov.tasks.open" });
    const resB = await request(orgB.app).get("/api/metrics").query({ tab: "overview", keys: "ov.tasks.open" });
    strictEqual(resA.status, 200);
    strictEqual(resB.status, 200);
    // Org A seeded one open task; org B seeded none -- if metrics leaked
    // cross-tenant, org B's count would be >= 1 too.
    strictEqual(resB.body["ov.tasks.open"].value, 0);
    ok(resA.body["ov.tasks.open"].value >= 1);
  });
});
```

#### Run

```bash
CI=true REQUIRE_TEST_DATABASE=true TEST_DATABASE_URL=... DATABASE_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm --filter @workspace/api-server run test
```

Expected: all isolation tests pass, plus the full existing suite (unlike MT-M0's rehearsal, this milestone's route sweep is what FIXES the 13-file NOT NULL fallout from MT-M0 — the suite should now be fully green, not just improved).

#### Wire into CI (blocking merge)

Confirm `.github/workflows/ci.yml`'s existing `Node.js tests` job already runs the full `pnpm --filter @workspace/api-server run test` command (it does, per MT-M0's CI setup) — no separate workflow step needed; this new test file is picked up automatically by `run-tests.mjs`'s glob discovery.

#### Commit

```bash
git add artifacts/api-server/src/tests/isolation/cross-tenant.test.ts
git commit -m "test(tenancy): add TEN-007 cross-tenant isolation suite, covers all MT-M1 rewired endpoints + TEN-003"
```

---

### Task 15: TEN-007 isolation suite — staging run

**Files:**
- Create: `docs/runbooks/mt-m1-isolation-staging-report.md`

**Interfaces:**
- Consumes: Task 14's test file, Task 13's rotated staging role.

#### Step 1: Run the isolation suite against real staging

```bash
CI=true REQUIRE_TEST_DATABASE=true \
TEST_DATABASE_URL="$STAGING_DATABASE_URL" \
DATABASE_URL="$STAGING_DATABASE_URL" \
SUPABASE_URL="$STAGING_SUPABASE_URL" \
SUPABASE_SERVICE_ROLE_KEY="$STAGING_SERVICE_ROLE_KEY" \
node --import tsx/esm --test --test-concurrency=1 artifacts/api-server/src/tests/isolation/cross-tenant.test.ts
```

This is the literal PRD exit criterion: "two test orgs fully isolated in staging." Record the actual result — pass/fail count, and confirm the two test orgs created (`org-a@isolation-test.example.com`/`org-b@isolation-test.example.com`) are visible in staging afterward (proving they were real, not mocked).

#### Step 2: Clean up the test orgs from staging

Per this milestone's own design-doc risk #6 ("staging isolation-suite run creates real rows... should clean up its own 2 test orgs after running"): after confirming the run's results, delete the two test orgs (cascades to their facility/rooms/etc via the schema's `onDelete: "cascade"` FKs already in place):

```sql
DELETE FROM organizations WHERE name LIKE 'Org for %isolation-test.example.com%';
```

Run this against staging directly (`psql "$STAGING_DATABASE_URL_DIRECT"`), confirm 2 rows deleted, confirm cascade removed the associated facilities/rooms/organization_members/users rows too.

#### Step 3: Write the report

```markdown
# MT-M1 Isolation Suite — Staging Run

**Date:** <actual date>
**Environment:** staging (rotated to farmsmart_app role, per Task 13)

## Result

<record actual pass/fail count from Step 1>

## Test orgs

Created: org-a@isolation-test.example.com, org-b@isolation-test.example.com
Cleaned up: <confirm via Step 2's DELETE, record row counts>

## PRD exit criterion

"Two test orgs fully isolated in staging; TEN-007 suite green and wired to CI"
— <state clearly whether this is met, and if not, what's still open>
```

#### Commit

```bash
git add docs/runbooks/mt-m1-isolation-staging-report.md
git commit -m "docs: record MT-M1 TEN-007 staging isolation run, meeting the milestone's PRD exit criterion"
```

---

### Task 16: Test-suite isolation audit — shared synthetic test user

**Files:**
- Investigate: `artifacts/api-server/src/tests/routes/facilities.test.ts`, `facility-readiness.test.ts`, `inventory.test.ts`, `sensor-accounts.test.ts`, `recommend.test.ts`, `seedLots.test.ts`, `sensors-bulk.test.ts`, `wizard.test.ts`, `shipments.test.ts`, `tasks.test.ts` — every file using `DEFAULT_TEST_USER.sub`/`seedTenantContext`/`seedTestUser` (`testApp.ts`'s single hardcoded synthetic id, `00000000-0000-4000-8000-000000000001`).

**Context (found during Task 13's full-suite-against-staging verification, not fixed there per explicit decision to defer):**

Running the complete `api-server` suite against a real, non-BYPASSRLS staging role surfaced `duplicate key value violates unique constraint "organization_members_user_id_uniq"` failures in `facilities.test.ts` (6 occurrences in one run). Root cause, as far as diagnosed: `organization_members` is deliberately never truncated between test files (it's treated as a "shared reference table" per the convention documented in `seedLots.test.ts`/other files' comments), but many files legitimately give the SAME hardcoded synthetic user id a real membership row via `seedTenantContext`. `facilities.test.ts`'s own tests assume that user starts with zero `organization_members` rows (exercising the real `POST /facilities` `AlreadyHasFacilityError` chicken-and-egg check) — an assumption that only holds if no other file (or no earlier test case within the same file) has already given that exact user a membership. `--test-concurrency=1` (`scripts/run-tests.mjs`) rules out a race — this is a real ordering/shared-state dependency, not a race condition.

This was masked until now because:
1. This branch has never had a CI run (never pushed/PR'd), so the full suite has never executed against a real, correctly-migrated database in one shot.
2. Locally, these DB-gated suites just skip without `TEST_DATABASE_URL`.

**What this task should do:**

1. Audit every file in the list above for state assumptions about `DEFAULT_TEST_USER.sub` that depend on it NOT already having an `organization_members` row, a `users.organization_id`, or other cross-file-shared state — not just `facilities.test.ts`'s known failure.
2. For each file found to have this dependency, either (a) mint its own fresh synthetic user id (e.g. a per-file or per-test UUID) instead of relying on the single shared `DEFAULT_TEST_USER.sub`, or (b) make the assumption explicit and self-sufficient (e.g. delete any pre-existing membership for that exact user id in the file's own `before`/`beforeEach`, via the admin connection, before asserting a fresh-state scenario).
3. Verify the fix by running the full suite against a real database (disposable or staging) at least twice in a row without a manual reset in between, to prove file-order/repeat-run independence — the exact condition that exposed this bug.
4. Confirm `pnpm --filter @workspace/api-server run typecheck` and the full suite (against a real database) are both clean.

**Not required:** re-litigating whether `organization_members` SHOULD be a shared/non-truncated table — that convention is otherwise working correctly for every OTHER file; this task only needs to remove `facilities.test.ts`'s (and any similarly-affected file's) implicit dependency on being first.

### Task 16, part 2: RLS GUC-placeholder poisoning under connection pooling

**Found running Task 15 (isolation suite against staging), folded into Task 16 per explicit decision. FIXED — migration `00013_tenancy_policies_nullif_guc_cast.sql` applied and verified against staging (confirmed via direct psql probe: `NULLIF(current_setting(...), '')::int` no longer throws). This section is now historical record of the investigation, not an open item.**

**Files:**
- Fix: new migration (`supabase/migrations/0001{N}_...`) altering the 11 policies in `supabase/migrations/00007_tenancy_rls_policies.sql`.
- Verify: `artifacts/api-server/src/tests/isolation/cross-tenant.test.ts` (Task 14) passing cleanly against a real, non-BYPASSRLS role (staging) is the actual proof this is fixed.

**The bug, confirmed empirically (not theoretical):**

`00007_tenancy_rls_policies.sql`'s 11 tenant-isolation policies all use the same bare-cast pattern:

```sql
using (facility_id = current_setting('app.facility_id', true)::int)
-- or
using (organization_id = current_setting('app.org_id', true)::int)
```

`withTenantScope` (`lib/db/src/scope.ts`) sets these via `set_config('app.org_id'/'app.facility_id', value, true)` — `true` (is_local) means transaction-scoped, correctly reverting when the transaction ends. The bug: Postgres's custom (non-extension) GUCs work as **placeholders** — the first time any code ever calls `set_config` for a given custom name on a given physical backend connection, Postgres permanently creates that placeholder for the lifetime of the backend process. After that point, `current_setting(name, true)` (missing_ok) no longer returns NULL when nothing is currently set locally — it returns an **empty string**, because the placeholder now exists but has no active local value. Casting `''::int` **throws** `invalid input syntax for type integer: ""` rather than evaluating to NULL/false.

Confirmed directly against staging:
```sql
-- on a psql session that had never touched app.org_id, first query:
SELECT current_setting('app.org_id', true) IS NULL;  -- returned false (already poisoned from a prior session on the same pooled backend)
SELECT current_setting('app.org_id', true)::int;      -- ERROR: invalid input syntax for type integer: ""
SELECT NULLIF(current_setting('app.org_id', true), '')::int IS NULL;  -- true — this form is safe
```

**Why this is a pooling issue, not a one-off:** Supabase's transaction-mode pooler (Supavisor, port 6543 — this app's actual connection mode per ADR-003/004) multiplexes many unrelated logical requests onto a smaller set of physical backend connections. Once **any** request has ever run `withTenantScope` on a given physical backend (setting `app.org_id`/`app.facility_id` even once, even if that transaction later rolled back), that backend's placeholder for the GUC exists permanently. Every later query on that same backend that does NOT itself call `set_config` — including `resolveTenantContext`'s own bootstrap lookup, and any of the 11 RLS-policy evaluations for a request that legitimately has no tenant context yet — can throw this error instead of cleanly denying access. Under real production traffic with a connection pool cycling through many different tenants and request types, this is not rare or one-off; it is a standing, unpredictable reliability hazard (not a silent security bypass — the failure mode is a thrown error, i.e. fail-closed/noisy, not a wrongly-permitted row).

**Confirmed NOT affected:** `lib/db/src/tz.ts` (the metrics dispatch layer's `facilityScope`/`substitutePlaceholders` helpers) has zero references to `current_setting` at all — it threads `facilityId` as a plain JS parameter from `req.tenant.facilityId` (resolved by `resolveTenantContext`), interpolated directly into SQL strings, never through a Postgres GUC. Only the 11 RLS policies in `00007` use this pattern.

**The fix (confirmed working, not yet applied):**

```sql
alter policy "tenant isolation by facility" on public.cycles
  using (facility_id = nullif(current_setting('app.facility_id', true), '')::int);
-- repeat for all 11 policies (7 facility_id-scoped tables, 4 organization_id-scoped),
-- exact policy names and table list in 00007_tenancy_rls_policies.sql
```

`NULLIF(x, '')` converts the empty-string placeholder resting-state to a real NULL before the cast, so the comparison evaluates to NULL (→ false, correctly denying access) instead of throwing. Verified directly against staging (see the `SELECT NULLIF(...)::int IS NULL` probe above) — this exact pattern resolves the error cleanly.

**What this task should do:**

1. ~~Write a new migration altering all 11 policies~~ DONE — `00013_tenancy_policies_nullif_guc_cast.sql` (used `ALTER POLICY ... USING (...)`, preserving policy identity/ordering).
2. ~~Bump `supabase/tests/00001_foundation.sql`'s migration-count assertion~~ DONE.
3. ~~Apply to staging, re-run the Task 14 isolation suite against it~~ DONE — confirmed the GUC-cast error is gone (the isolation suite got past it; a separate, unrelated bug — part 3 below — is what's blocking full-green now).
4. Confirm the full isolation suite passes cleanly, twice in a row, against staging — blocked on part 3's fix below, not on this bug anymore.
5. Consider (not required, but worth deciding explicitly): whether `withTenantScope` itself should proactively guard against this (e.g. documenting the risk inline) even after the RLS-side fix, since any FUTURE tenant-scoped table added without going through the same defensive pattern would reintroduce this exact class of bug.

### Task 16, part 3: metrics dispatch never uses withTenantScope — RLS silently zeroes every dashboard query

**Found immediately after part 2's fix, same Task 15 verification pass. NOT YET FIXED — folded into Task 16 per explicit "keep investigating first" decision.**

**Files:**
- `artifacts/api-server/src/routes/metrics.ts` (the `GET /metrics` dispatch loop)
- `artifacts/api-server/src/lib/metrics/templates.ts` (5 affected functions: `scalarAgg`, `groupBy`, `timeBucket`, `ratio`, `tableTemplate` — `customTemplate`/`quickbooksTemplate` themselves don't query directly, they dispatch further)
- `artifacts/api-server/src/lib/metrics/custom.ts` (all 11 hand-written functions)
- `lib/db/src/scope.ts` (`withTenantScope` — the mechanism these need to start using)

**Confirmed NOT affected:** `lib/accounting/quickbooks-reports.ts` (`runQuickbooksQuery`) — doesn't import `@workspace/db` at all, calls the QuickBooks external API directly, no local RLS-protected table involved.

**The bug, confirmed empirically (not theoretical):**

With part 2's GUC-cast fix applied and the isolation suite's own fixture-truncation bug (see below) also fixed, 10 of 11 `cross-tenant.test.ts` tests pass cleanly. The 11th (`GET /api/metrics`) fails: org A's own `GET /api/metrics?tab=overview&keys=ov.tasks.open` returns `{"ov.tasks.open":{"value":0}}` — no error, just silently wrong (org A seeded exactly one non-done task, expected `value >= 1`).

Root cause: `templates.ts`/`custom.ts` import `db` directly from `@workspace/db` and call `db.execute(sql.raw(q))` — never through `withTenantScope`'s transaction (`tx`). Their OWN tenant scoping is entirely via an explicit `:facilityId`/`:organizationId` placeholder substituted with a literal number (`substitutePlaceholders`, `tz.ts`) — correct application-level scoping, but this never calls `set_config`, so `app.facility_id`/`app.org_id` are never set for these queries' connection. `00007`'s RLS policies are STILL active on every one of these tables regardless (defense-in-depth, applied automatically by Postgres) and require `app.facility_id`/`app.org_id` to be set to a real value to admit any row. Since metrics queries never set it, and part 2's fix now correctly evaluates the missing/placeholder GUC to NULL (not a thrown error), the RLS comparison is always `col = NULL` → NULL → **false for every row** — every metrics/dashboard query silently returns zero rows under real RLS enforcement, independent of whether its own explicit literal-substitution scoping was correct.

This is a **silent, wrong-answer** failure mode (unlike part 2, which was a thrown error) — a real production correctness bug once a non-BYPASSRLS role is live: the entire `/api/metrics` dashboard would silently show zeros for every tenant, not an error a user or monitoring would necessarily notice quickly.

**Why this wasn't caught earlier:** Tasks 11/12's own reviews verified the generic templates' and custom queries' facility/organization scoping logic (positional argument correctness, per-function SQL correctness) exhaustively — but always against a database connection with BYPASSRLS (disposable-stack default, or the pre-rotation staging connection), where RLS is a no-op regardless of whether `app.facility_id` is set. Nothing in Tasks 11/12's verification ever ran under a real, enforced-RLS role — that only happened here, in Task 15.

**Recommended fix (not yet implemented — needs care before applying):**

Thread a transaction handle through the dispatch chain so these queries run inside the same transaction that sets `app.org_id`/`app.facility_id`, instead of importing the bare `db` singleton:

1. In `routes/metrics.ts`, wrap the entire `Promise.all(valid.map(...))` dispatch in one `withTenantScope(req.tenant!, async (tx) => { ... })` call.
2. Every `TEMPLATES[...]` function (7 in `templates.ts`) and every `CUSTOM_QUERIES[...]` function (11 in `custom.ts`) needs an additional `tx` parameter (or its bare `db.execute` calls need to become `tx.execute`) so they execute against the SAME transaction-scoped connection, not the module-level `db` singleton.
3. Note: `Promise.all` over multiple queries against the SAME transaction/connection will not gain parallel speedup either way (a single Postgres connection processes one query at a time regardless of JS-level concurrency) — this is a correctness fix, not a performance regression, but worth calling out explicitly in the implementer's dispatch so nobody "fixes" the now-serialized behavior back to something unscoped.
4. Verify via the SAME `cross-tenant.test.ts` `GET /api/metrics` test — it should return `value >= 1` for org A and exactly `0` for org B once fixed, both for the right reason (real data, not an RLS-caused empty result masquerading as a legitimate zero).
5. Re-check `custom.ts`'s existing task-12-era review findings (the `ovYieldExpectedVsActual` leak fixed post-Task-12, the 10 functions reviewed in Task 12 itself) still hold once queries move from `db` to `tx` — the SQL text itself doesn't change, only which connection/transaction executes it, so this should be a mechanical threading change, not a query-logic change.

---

## Exit criteria (from the PRD, unchanged)

- Two test orgs fully isolated in staging (Task 15).
- TEN-007 suite green and wired to CI (Task 14).
- `pnpm run typecheck` passes (the cumulative effect of Tasks 4-12 — verify explicitly as the final check before declaring this milestone done).

## Explicitly not in this plan (MT-M2/Exit territory)

TEN-008 (multi-facility switcher), TEN-009 (org rollup stubs), TEN-010 rev. B (team invites/roles UI), TEN-012 (public sign-up), TEN-013 (demo mode), TEN-014 (mobile sign-in policy), the named recurring "production verification job" gating TEN-011/012, dropping the deprecated `users.role`/`users.organizationId` columns, and the residual raw-SQL structural blind spot in `check-tenant-scope.mjs` (noted in the design doc's Risks and gaps, not fixed here).
