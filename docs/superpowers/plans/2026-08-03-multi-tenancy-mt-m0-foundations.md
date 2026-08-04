# Multi-Tenancy MT-M0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the multi-tenancy mechanism (org membership schema, facility/org scoping columns, the scoped-query helper, RLS as defense-in-depth, and a CI-enforced scoping check) and write + rehearse the migration series against a pilot snapshot — the first of four milestones (MT-M0 → MT-M1 → MT-M2 → Exit) toward `FarmSmart_MultiTenancy_PRD_v1.5.docx`.

**Architecture:** Extends the existing Drizzle schema (`lib/db/src/schema/index.ts`) with a new `organization_members` table and facility/org scoping columns on 9 operational tables, using the same expand→backfill→contract migration pattern already established in this codebase (e.g. `0014`/`0015`/`0016`). A new `withTenantScope()` helper in `lib/db` wraps scoped queries in a transaction that sets Postgres session variables (`SET LOCAL app.org_id`) for RLS policies to key on — compatible with Supabase's transaction-pooler (`render.yaml`, port 6543), since `SET LOCAL` resets automatically per transaction. A hand-written Node script (matching this repo's existing `scripts/ci/*.mjs` convention — there is no ESLint here) enforces in CI that route handlers never touch scoped tables outside that helper.

**Tech Stack:** Drizzle ORM + `pg` (Node), PostgreSQL (Supabase, transaction pooler), Express, `node:test`, pnpm workspaces.

**Design doc:** `docs/superpowers/specs/2026-08-03-multi-tenancy-mt-m0-foundations-design.md` — read this first for full rationale; this plan implements it task-by-task.

## Global Constraints

- pnpm only. `pnpm run typecheck` must pass before merge (existing `Quality` CI job).
- Every schema change to a table with existing production data uses the expand → backfill → contract split (nullable column → data backfill → `NOT NULL`/constraint), matching the precedent in `lib/db/drizzle/0014_demonic_kree.sql` / `0015_backfill_default_organization.sql` / `0016_enforce_tenancy_not_null_constraints.sql`. Never combine a backfill-requiring `ALTER ... NOT NULL` with the column's own creation in one migration.
- Migrations for this milestone are written and rehearsed against a pilot snapshot; they are **not** applied to production in this plan — that is MT-M1's job, once the cross-tenant isolation suite proves the scoping correct in staging.
- `organization_members.role` is `owner | admin | technician` (ADR-005 §9.1 / TEN-010) — not TEN-001's stale `owner | member` wording; see design doc's corrections section.
- No ESLint exists in this repo. Do not add it. New static checks are hand-written `scripts/ci/*.mjs` scripts wired into the existing `Quality (codegen + typecheck)` CI job, matching `scripts/ci/check-dependency-audit.mjs`'s pattern.
- ADR numbers for this initiative are **ADR-005** (tenancy shape) and **ADR-006** (auth lineage) — `ADR-003`/`ADR-004` are already taken by unrelated accepted decisions in this repo.
- Keep `rooms.name` as the column name — do not rename to `stage`. It already matches ADR-005's tenancy shape functionally.

---

### Task 1: `organization_members` table + deprecate old user-role columns

**Files:**
- Modify: `lib/db/src/schema/index.ts`
- Create: `lib/db/drizzle/0017_organization_members.sql` (generated, see Step 2)

**Interfaces:**
- Produces: `organizationMembersTable`, `orgMemberRoleEnum` (`"owner" | "admin" | "technician"`), `orgMemberStatusEnum` (`"active" | "removed"`) — exported from `@workspace/db`, consumed by Task 9's scoped helper (role) and every MT-M1/MT-M2 handler that resolves session membership.

- [ ] **Step 1: Add the new table to the schema**

In `lib/db/src/schema/index.ts`, add directly below the existing `usersTable` definition (around line 101, right after the closing `});` of `usersTable`):

```ts
export const orgMemberRoleEnum = pgEnum("org_member_role", [
  "owner",
  "admin",
  "technician",
]);

export const orgMemberStatusEnum = pgEnum("org_member_status", [
  "active",
  "removed",
]);

// organization_members — the real source of truth for org membership + role
// (ADR-005 §9.1: owner | admin | technician). users.role / users.organizationId
// (above) are deprecated by this table but NOT dropped yet — every reader gets
// repointed in MT-M1/MT-M2 before a later migration drops the old columns
// (expand-before-contract, same pattern as the rooms.facility_id rollout).
export const organizationMembersTable = pgTable(
  "organization_members",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: orgMemberRoleEnum("role").notNull(),
    status: orgMemberStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // Exactly one organization per user in v1 (PRD TEN-001: "a user holds
    // membership in exactly one organization ... multi-org users are out of
    // scope"). This is the constraint that enforces it at the DB layer.
    uniqueIndex("organization_members_user_id_uniq").on(table.userId),
    index("organization_members_organization_id_idx").on(table.organizationId),
  ],
);
```

Add a one-line deprecation comment directly above the existing `usersTable.role` and `usersTable.organizationId` fields (do not remove or rename the fields themselves):

```ts
  // DEPRECATED (MT-M0): superseded by organization_members.role. Not yet
  // read/written by new code; not yet dropped. See ADR-005.
  role: userRoleEnum("role").notNull().default("technician"),
  // DEPRECATED (MT-M0): superseded by organization_members.organization_id.
  // Not yet read/written by new code; not yet dropped. See ADR-005.
  organizationId: integer("organization_id").references(() => organizationsTable.id),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @workspace/db run db:generate`

This produces `lib/db/drizzle/0017_<random-name>.sql` (drizzle-kit names it) containing the two new enums, the new table, and its indexes/constraints — verify the generated SQL matches the schema above (two `CREATE TYPE`, one `CREATE TABLE organization_members`, one unique index, one plain index) and rename the file to `lib/db/drizzle/0017_organization_members.sql` for clarity (update the `tag` field in the corresponding entry in `lib/db/drizzle/meta/_journal.json` to match).

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @workspace/db run typecheck` and `pnpm --filter @workspace/api-server run typecheck` — both must pass (the deprecation comments don't change any type).

- [ ] **Step 4: Commit**

```bash
git add lib/db/src/schema/index.ts lib/db/drizzle/0017_organization_members.sql lib/db/drizzle/meta/_journal.json
git commit -m "feat(db): add organization_members table, deprecate users.role/organizationId"
```

---

### Task 2: Facility/organization scoping columns — expand (nullable)

**Files:**
- Modify: `lib/db/src/schema/index.ts`
- Create: `lib/db/drizzle/0018_tenancy_scoping_columns.sql` (generated, see Step 2)

**Interfaces:**
- Consumes: `facilitiesTable`, `organizationsTable` (existing).
- Produces: nullable `facilityId` on `cyclesTable`, `inventoryItemsTable`, `alertsTable`, `tasksTable`, `shipmentsTable`, `facilityLogsTable`, `sensorsTable`; nullable `organizationId` on `growthProfilesTable`, `accountingConnectionsTable`. Consumed by Task 3 (backfill), Task 4 (contract), Task 9 (scoped helper), Task 8 (RLS policies).

- [ ] **Step 1: Add the columns**

In `lib/db/src/schema/index.ts`, add to each of the following tables' column list (nullable — no `.notNull()` yet) and a matching index in that table's index array:

```ts
// cyclesTable — add column:
  facilityId: integer("facility_id").references(() => facilitiesTable.id, { onDelete: "cascade" }),
// cyclesTable — add index (alongside cycles_status_idx etc.):
    index("cycles_facility_id_idx").on(table.facilityId),

// inventoryItemsTable — add column:
  facilityId: integer("facility_id").references(() => facilitiesTable.id, { onDelete: "cascade" }),
// inventoryItemsTable — add index (alongside inventory_category_idx):
    index("inventory_items_facility_id_idx").on(table.facilityId),

// alertsTable — add column:
  facilityId: integer("facility_id").references(() => facilitiesTable.id, { onDelete: "cascade" }),
// alertsTable — add index (alongside alerts_status_idx):
    index("alerts_facility_id_idx").on(table.facilityId),

// tasksTable — add column:
  facilityId: integer("facility_id").references(() => facilitiesTable.id, { onDelete: "cascade" }),
// tasksTable — add index:
    index("tasks_facility_id_idx").on(table.facilityId),

// shipmentsTable — add column:
  facilityId: integer("facility_id").references(() => facilitiesTable.id, { onDelete: "cascade" }),
// shipmentsTable — add index (alongside shipments_status_idx):
    index("shipments_facility_id_idx").on(table.facilityId),

// facilityLogsTable — add column:
  facilityId: integer("facility_id").references(() => facilitiesTable.id, { onDelete: "cascade" }),
// facilityLogsTable — add index:
    index("facility_logs_facility_id_idx").on(table.facilityId),

// sensorsTable — add column:
  facilityId: integer("facility_id").references(() => facilitiesTable.id, { onDelete: "cascade" }),
// sensorsTable — add index (alongside sensors_channel_id_idx etc.):
    index("sensors_facility_id_idx").on(table.facilityId),

// growthProfilesTable — add column:
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "cascade" }),
// growthProfilesTable — add index:
    index("growth_profiles_organization_id_idx").on(table.organizationId),

// accountingConnectionsTable — add column:
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "cascade" }),
// accountingConnectionsTable — add index:
    index("accounting_connections_organization_id_idx").on(table.organizationId),
```

Read the current definitions of each table first (`grep -n "export const cyclesTable\|export const inventoryItemsTable\|export const alertsTable\|export const tasksTable\|export const shipmentsTable\|export const facilityLogsTable\|export const sensorsTable\|export const growthProfilesTable\|export const accountingConnectionsTable" lib/db/src/schema/index.ts`) to find each table's exact current column-array and index-array shape — some (e.g. `alertsTable`, `growthProfilesTable`) currently have no `(table) => [...]` index-array clause at all and need one added, not appended to.

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @workspace/db run db:generate`, verify it produces only `ALTER TABLE ... ADD COLUMN facility_id/organization_id integer` + `CREATE INDEX` statements (nine `ADD COLUMN`, nine `CREATE INDEX`, no `NOT NULL` yet), rename to `lib/db/drizzle/0018_tenancy_scoping_columns.sql`, update the journal entry's `tag`.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @workspace/db run typecheck` && `pnpm --filter @workspace/api-server run typecheck`.

- [ ] **Step 4: Commit**

```bash
git add lib/db/src/schema/index.ts lib/db/drizzle/0018_tenancy_scoping_columns.sql lib/db/drizzle/meta/_journal.json
git commit -m "feat(db): add nullable facility_id/organization_id scoping columns"
```

---

### Task 3: Facility/organization scoping columns — backfill

**Files:**
- Create: `lib/db/drizzle/0019_backfill_tenancy_scoping.sql` (hand-written, not generated — matches `0015`'s precedent)

**Interfaces:**
- Consumes: the columns from Task 2, and the existing default organization/facility rows backfilled by `0015`/`0016` for the pilot data.

- [ ] **Step 1: Write the backfill migration**

```sql
-- Backfills the nullable facility_id/organization_id columns added in 0018
-- against the single pre-existing pilot facility/organization (already
-- guaranteed to exist by 0015's backfill + 0016's default-facility fix).
-- Same "first row wins" pattern as 0015 — there has only ever been one
-- facility/organization in the pilot data, so this is unambiguous.

UPDATE cycles SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

UPDATE inventory_items SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

UPDATE alerts SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

UPDATE tasks SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

UPDATE shipments SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

UPDATE facility_logs SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

UPDATE sensors SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

UPDATE growth_profiles SET organization_id = (SELECT id FROM organizations ORDER BY id LIMIT 1)
  WHERE organization_id IS NULL;

UPDATE accounting_connections SET organization_id = (SELECT id FROM organizations ORDER BY id LIMIT 1)
  WHERE organization_id IS NULL;
```

- [ ] **Step 2: Add the journal entry**

Add a new entry to `lib/db/drizzle/meta/_journal.json`'s `entries` array, following the exact shape of the `0015`/`0016` entries (increment `idx`, bump `when` by `+1000` from the previous entry, `tag: "0019_backfill_tenancy_scoping"`).

- [ ] **Step 3: Commit**

```bash
git add lib/db/drizzle/0019_backfill_tenancy_scoping.sql lib/db/drizzle/meta/_journal.json
git commit -m "fix(db): backfill facility_id/organization_id scoping columns to pilot defaults"
```

---

### Task 4: Facility/organization scoping columns — contract (NOT NULL)

**Files:**
- Create: `lib/db/drizzle/0020_enforce_tenancy_scoping_not_null.sql` (hand-written)
- Modify: `lib/db/src/schema/index.ts` (add `.notNull()` to the 9 columns from Task 2)

**Interfaces:**
- Consumes: Task 3's completed backfill (every row now has a non-null value).

- [ ] **Step 1: Update the schema**

In `lib/db/src/schema/index.ts`, change each of the 9 columns added in Task 2 from:
```ts
  facilityId: integer("facility_id").references(() => facilitiesTable.id, { onDelete: "cascade" }),
```
to:
```ts
  facilityId: integer("facility_id").notNull().references(() => facilitiesTable.id, { onDelete: "cascade" }),
```
(and the analogous change for the two `organizationId` columns on `growthProfilesTable`/`accountingConnectionsTable`).

- [ ] **Step 2: Write the contract migration**

```sql
-- Runs after 0019's backfill populates every row. Asserting NOT NULL before
-- backfill would fail against existing data — same ordering hazard the
-- rooms.facility_id split (0014/0015/0016) exists to avoid.
ALTER TABLE "cycles" ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "facility_logs" ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sensors" ALTER COLUMN "facility_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "growth_profiles" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_connections" ALTER COLUMN "organization_id" SET NOT NULL;
```

- [ ] **Step 3: Add the journal entry** (same pattern as Task 3 Step 2, `tag: "0020_enforce_tenancy_scoping_not_null"`).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @workspace/db run typecheck` && `pnpm --filter @workspace/api-server run typecheck` — this will surface every existing insert call site across `artifacts/api-server/src/routes/*.ts` that creates a row in one of these 9 tables without a `facilityId`/`organizationId`, since the Drizzle type now requires it. **Do not fix these call sites in this task** — record the list of files TypeScript flags in the task report; rewiring every handler to actually resolve and pass a real `facilityId`/`organizationId` from session context is MT-M1's job (that's where TEN-002's acceptance criteria live). For MT-M0, it is acceptable — and expected — that typecheck fails here; report the failing file list, do not silence it with `as any` or similar, and do not proceed past this step trying to "fix" it. This step exists to produce that list, not to resolve it.

- [ ] **Step 5: Commit**

```bash
git add lib/db/src/schema/index.ts lib/db/drizzle/0020_enforce_tenancy_scoping_not_null.sql lib/db/drizzle/meta/_journal.json
git commit -m "fix(db): enforce NOT NULL on facility_id/organization_id scoping columns"
```

Note for the task reviewer: this task is expected to leave `pnpm run typecheck` red across the API server, with a known, reported list of call sites. That is the intended exit state for this specific task (not the whole plan) — confirm the reviewer treats the recorded file list as this task's actual deliverable, not as an unfixed regression to send back.

---

### Task 5: Inventory identity wave — `item_code` on `inventory_items`

**Files:**
- Modify: `lib/db/src/schema/index.ts`
- Modify: `artifacts/api-server/src/routes/inventory.ts`
- Create: `lib/db/drizzle/0021_inventory_item_code.sql` (generated) + `lib/db/drizzle/0022_inventory_item_code_not_null.sql` (hand-written contract, if needed)
- Test: `artifacts/api-server/src/routes/inventory.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: `generateShortId()` (`artifacts/api-server/src/lib/utils.ts`, existing — returns a 4-char hex string, no uniqueness guarantee on its own).
- Produces: `inventoryItemsTable.itemCode` (nullable initially, backfilled, then a `UNIQUE(facility_id, item_code)` partial-safe composite once populated).

- [ ] **Step 1: Add the column (nullable) + composite unique index**

In `lib/db/src/schema/index.ts`, add to `inventoryItemsTable`:
```ts
  itemCode: text("item_code"),
```
and to its index array:
```ts
    uniqueIndex("inventory_items_facility_id_item_code_uniq").on(table.facilityId, table.itemCode),
```

- [ ] **Step 2: Generate + backfill + contract**

Run `pnpm --filter @workspace/db run db:generate` for the column+index addition (`0021_inventory_item_code.sql`). Existing rows need a generated `item_code` before any `NOT NULL` is even considered — write a follow-up hand migration that backfills using Postgres's own random-hex generation (mirrors `generateShortId()`'s 4-hex-char shape) so existing pilot rows get non-colliding codes within their facility:

```sql
-- 0022 (hand-written): backfill item_code for pre-existing inventory rows.
-- Generates a 4-hex-char code per row (matches generateShortId()'s shape);
-- collisions within the same facility are re-rolled via the WHERE NOT EXISTS
-- retry loop (pilot data is small; this converges immediately in practice).
DO $$
DECLARE
  r RECORD;
  candidate TEXT;
BEGIN
  FOR r IN SELECT id, facility_id FROM inventory_items WHERE item_code IS NULL LOOP
    LOOP
      candidate := lpad(to_hex(floor(random() * 65536)::int), 4, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM inventory_items
        WHERE facility_id = r.facility_id AND item_code = candidate
      );
    END LOOP;
    UPDATE inventory_items SET item_code = candidate WHERE id = r.id;
  END LOOP;
END $$;
```

Leave `item_code` nullable in the schema for now (new rows always get one via the app-layer retry loop in Step 3, same as `cycles.shortId`/`shipments.shortId` — those columns are also app-enforced-non-null via the insert path, not a DB-level `NOT NULL`, and this plan follows that same established convention rather than introducing a new one).

- [ ] **Step 3: Wire `item_code` generation into `POST /inventory`**

In `artifacts/api-server/src/routes/inventory.ts`, import `generateShortId` from `../lib/utils.js` and `inventoryItemsTable`'s new column. Replace the existing single-shot insert in the `POST /inventory` handler with the retry-on-conflict pattern already established in `cycles.ts`:

```ts
let itemCode = generateShortId();
let item: typeof inventoryItemsTable.$inferSelect | undefined;
for (let attempt = 0; attempt < 5; attempt++) {
  [item] = await db
    .insert(inventoryItemsTable)
    .values({
      ...parsedBody, // existing fields already validated above
      itemCode,
      facilityId, // resolved from session context — MT-M1 wiring; use the pilot default facility id for now, matching every other pre-MT-M1 handler in this codebase
    })
    .onConflictDoNothing({ target: [inventoryItemsTable.facilityId, inventoryItemsTable.itemCode] })
    .returning();
  if (item) break;
  itemCode = generateShortId();
}
if (!item) {
  return res.status(500).json({ error: "Failed to generate a unique item code" });
}
```

(Adapt field names to the handler's actual existing variable names — read the current `POST /inventory` handler body first; do not guess field names blindly.)

- [ ] **Step 4: Tests**

In `artifacts/api-server/src/routes/inventory.test.ts`, add a test asserting `POST /inventory` response includes a 4-character hex `itemCode`, and a test asserting two items created in the same facility never receive the same `itemCode` (create 3 in a loop, assert all distinct) — DB-gated, following this file's existing `useDatabaseFixture` pattern.

- [ ] **Step 5: Typecheck + run the new tests**

Run: `pnpm --filter @workspace/api-server run typecheck`. Tests are DB-gated (skip without `TEST_DATABASE_URL` — do not attempt to run them locally without one; note in the task report that they're unverified against a real DB in this environment, consistent with how every prior DB-gated test in this codebase has been handled).

- [ ] **Step 6: Commit**

```bash
git add lib/db/src/schema/index.ts artifacts/api-server/src/routes/inventory.ts artifacts/api-server/src/routes/inventory.test.ts lib/db/drizzle/0021_inventory_item_code.sql lib/db/drizzle/0022_inventory_item_code_not_null.sql lib/db/drizzle/meta/_journal.json
git commit -m "feat(inventory): add per-facility item_code, generated via existing shortId pattern"
```

---

### Task 6: Inventory identity wave — `seed_lots` facility scoping + per-facility `qr_code`

**Files:**
- Modify: `lib/db/src/schema/index.ts`
- Modify: `artifacts/api-server/src/routes/seedLots.ts`
- Modify: `artifacts/api-server/src/routes/cycles.ts` (the `seedLotQrCode` matching logic)
- Create: `lib/db/drizzle/0023_seed_lots_facility_scoping.sql` (generated) + `lib/db/drizzle/0024_seed_lots_qr_code_backfill_and_contract.sql` (hand-written)
- Test: `artifacts/api-server/src/routes/seedLots.test.ts` (new file — none exists today)

**Interfaces:**
- Consumes: `facilitiesTable` (existing).
- Produces: `seedLotsTable.facilityId` (NOT NULL after backfill), `qrCode`'s constraint changed from global-unique to `UNIQUE(facility_id, qr_code)`.

- [ ] **Step 1: Add the column (nullable), then change the unique constraint**

In `lib/db/src/schema/index.ts`, `seedLotsTable` currently has no `(table) => [...]` clause and `qrCode: text("qr_code").notNull().unique()`. Change to:
```ts
export const seedLotsTable = pgTable(
  "seed_lots",
  {
    id: serial("id").primaryKey(),
    facilityId: integer("facility_id").references(() => facilitiesTable.id, { onDelete: "cascade" }),
    qrCode: text("qr_code").notNull(), // .unique() REMOVED — replaced by the per-facility composite below
    seedName: text("seed_name").notNull(),
    supplier: text("supplier"),
    productLink: text("product_link"),
    itemNumber: text("item_number"),
    vendorShort: text("vendor_short"),
    gpcCode: text("gpc_code"),
    type: text("type"),
    success: numeric("success"),
    growTime: numeric("grow_time"),
    usedIn: text("used_in"),
    currentlyGrown: boolean("currently_grown"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("seed_lots_facility_id_qr_code_uniq").on(table.facilityId, table.qrCode),
    index("seed_lots_facility_id_idx").on(table.facilityId),
  ],
);
```
(`facilityId` starts nullable per the expand step; Task's later step contracts it.)

- [ ] **Step 2: Generate the migration**

Run `pnpm --filter @workspace/db run db:generate` — verify it: adds `facility_id` column, drops the old global unique constraint on `qr_code`, adds the new composite unique index and the plain facility index. Rename to `0023_seed_lots_facility_scoping.sql`.

- [ ] **Step 3: Backfill + contract**

```sql
-- 0024 (hand-written): backfill seed_lots.facility_id to the single pilot
-- facility (only one has ever existed — same reasoning as 0019), then
-- enforce NOT NULL now that every row has a value.
UPDATE seed_lots SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
  WHERE facility_id IS NULL;

ALTER TABLE "seed_lots" ALTER COLUMN "facility_id" SET NOT NULL;
```
Add the corresponding journal entry.

- [ ] **Step 4: Rescope `GET /seed-lots/lookup`**

In `artifacts/api-server/src/routes/seedLots.ts`, the current handler does a bare `WHERE qrCode = $1` with no facility filter — this must never match a row from a different facility now that `qr_code` is only unique per-facility. Update the query to filter by the requester's active facility:

```ts
router.get("/seed-lots/lookup", seedLotLookupLimiter, async (req, res) => {
  try {
    const qrCode = req.query.qrCode as string;
    if (!qrCode) {
      return res.status(400).json({ error: "qrCode query parameter is required" });
    }

    // facilityId resolution from session context is MT-M1 wiring (this
    // handler doesn't yet have a scoped-session helper to call) — use the
    // pilot default facility id for now, matching every other pre-MT-M1
    // handler in this codebase (see Task 4's typecheck note).
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
```
(Import `and` from `drizzle-orm` alongside the existing `eq` import.)

- [ ] **Step 5: Check `cycles.ts`'s `seedLotQrCode` matching**

In `artifacts/api-server/src/routes/cycles.ts`, the existing logic (`const qrCodes = cycle.seedLotQrCodes ?? []; if (body.seedLotQrCode && qrCodes.length > 0 && !qrCodes.includes(body.seedLotQrCode))`) only ever compares against the cycle's own already-stored array of strings — it never independently re-queries `seed_lots` by bare `qrCode`, so it does not have the same cross-facility ambiguity `seedLots.ts` had. No code change needed here; add a one-line comment above this block noting why: `// Compares against this cycle's own stored array, not a fresh seed_lots lookup — no cross-facility ambiguity here (see seedLots.ts for the query that did need rescoping).`

- [ ] **Step 6: Tests**

Create `artifacts/api-server/src/routes/seedLots.test.ts` (DB-gated, following the `useDatabaseFixture(["seed_lots", "facilities", "organizations"])` pattern used elsewhere): a test creating two seed lots with the *same* `qrCode` in two *different* facilities (should both succeed — no longer a global conflict), and a test asserting `GET /seed-lots/lookup?qrCode=X` for Facility A's QR code never returns Facility B's row even when both exist.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @workspace/db run typecheck` && `pnpm --filter @workspace/api-server run typecheck`.

- [ ] **Step 8: Commit**

```bash
git add lib/db/src/schema/index.ts artifacts/api-server/src/routes/seedLots.ts artifacts/api-server/src/routes/seedLots.test.ts artifacts/api-server/src/routes/cycles.ts lib/db/drizzle/0023_seed_lots_facility_scoping.sql lib/db/drizzle/0024_seed_lots_qr_code_backfill_and_contract.sql lib/db/drizzle/meta/_journal.json
git commit -m "fix(inventory): scope seed_lots.qr_code uniqueness and lookup per facility, not globally"
```

---

### Task 7: Verify/provision a non-BYPASSRLS database role

**Files:**
- Create: `docs/runbooks/tenancy-db-role.md`
- Create: `scripts/ci/verify-db-role.mjs` (verification script, runnable against staging)

**Interfaces:**
- Consumes: `DATABASE_URL` (env, existing).
- Produces: a documented, verified answer to "does the API server's DB role bypass RLS" — the load-bearing precondition for Task 8. If the answer is yes, this task also produces the SQL to provision a replacement role and the runbook step to rotate `DATABASE_URL`.

- [ ] **Step 1: Write the verification script**

```js
// scripts/ci/verify-db-role.mjs
// Checks whether the Postgres role in DATABASE_URL has BYPASSRLS -- if so,
// every RLS policy in this initiative is a silent no-op regardless of what
// it says (Supabase's default `postgres` and `service_role` roles both have
// BYPASSRLS by default). Run manually against staging before trusting any
// RLS policy written in this milestone:
//   DATABASE_URL=... node scripts/ci/verify-db-role.mjs
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();
const { rows } = await client.query(
  "SELECT current_user AS role, rolbypassrls FROM pg_roles WHERE rolname = current_user",
);
await client.end();

const { role, rolbypassrls } = rows[0];
console.log(`Connected as: ${role}`);
console.log(`BYPASSRLS: ${rolbypassrls}`);
if (rolbypassrls) {
  console.log(
    "\nThis role bypasses RLS entirely -- every policy written in this milestone " +
      "is a no-op under this connection. A new least-privilege role must be " +
      "provisioned and DATABASE_URL rotated to it before RLS is trustworthy. " +
      "See docs/runbooks/tenancy-db-role.md.",
  );
  process.exit(1);
}
console.log("\nThis role does not bypass RLS -- policies will be enforced.");
```

- [ ] **Step 2: Run it against staging and record the result**

Run: `DATABASE_URL="$STAGING_DATABASE_URL_DIRECT" node scripts/ci/verify-db-role.mjs` (use whichever staging connection string is available in this environment; if none is reachable from this environment, state that explicitly in the task report rather than fabricating a result — this is a real infra check, not something to assume).

- [ ] **Step 3: Write the runbook**

```markdown
# Runbook: Tenancy-safe database role

**Why:** Supabase's default `postgres` and `service_role` roles both have
`BYPASSRLS` — if `DATABASE_URL` connects as either, every RLS policy added
in the multi-tenancy initiative is a silent no-op. Verified via
`scripts/ci/verify-db-role.mjs`.

**Result of the MT-M0 check:** <fill in from Step 2's actual output —
DO NOT leave this as a placeholder; either the real recorded output, or an
explicit statement that no staging connection was reachable from this
environment and the check must be re-run by someone with access>

**If a new role is needed**, provision it in the Supabase SQL editor (or via
a migration, if preferred — this one is intentionally NOT run through
Drizzle's migration runner, since it's a role/grant operation, not a schema
change scoped to this app's tables):

```sql
CREATE ROLE farmsmart_app LOGIN PASSWORD '<generate a strong password>';
GRANT USAGE ON SCHEMA public TO farmsmart_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO farmsmart_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO farmsmart_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO farmsmart_app;
-- farmsmart_app has no BYPASSRLS by default (unlike postgres/service_role) --
-- do not add BYPASSRLS to it.
```

Then rotate `DATABASE_URL` in Render's env vars (staging first, verified
with `verify-db-role.mjs` showing `BYPASSRLS: false`, then production) to
a connection string authenticating as `farmsmart_app` against the same
Supabase project's transaction pooler.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/ci/verify-db-role.mjs docs/runbooks/tenancy-db-role.md
git commit -m "feat(db): add BYPASSRLS verification script + role-provisioning runbook"
```

---

### Task 8: RLS policies on scoped tables

**Files:**
- Create: `supabase/migrations/00007_tenancy_rls_policies.sql`

**Interfaces:**
- Consumes: Task 7's verified/provisioned role, the `facility_id`/`organization_id` columns from Tasks 2-6.
- Produces: RLS enabled + policies on every newly-scoped table, keyed on `current_setting('app.org_id', true)` / `current_setting('app.facility_id', true)` — read by Task 9's helper.

- [ ] **Step 1: Write the policy migration**

Follow the existing `supabase/migrations/00006_onboarding_tables_rls.sql` file's own structure/style (read it first) for consistency. Pattern per table:

```sql
ALTER TABLE cycles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cycles FROM anon, authenticated;
CREATE POLICY tenant_isolation ON cycles
  USING (facility_id = current_setting('app.facility_id', true)::int);

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inventory_items FROM anon, authenticated;
CREATE POLICY tenant_isolation ON inventory_items
  USING (facility_id = current_setting('app.facility_id', true)::int);

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON alerts FROM anon, authenticated;
CREATE POLICY tenant_isolation ON alerts
  USING (facility_id = current_setting('app.facility_id', true)::int);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tasks FROM anon, authenticated;
CREATE POLICY tenant_isolation ON tasks
  USING (facility_id = current_setting('app.facility_id', true)::int);

ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON shipments FROM anon, authenticated;
CREATE POLICY tenant_isolation ON shipments
  USING (facility_id = current_setting('app.facility_id', true)::int);

ALTER TABLE facility_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON facility_logs FROM anon, authenticated;
CREATE POLICY tenant_isolation ON facility_logs
  USING (facility_id = current_setting('app.facility_id', true)::int);

ALTER TABLE sensors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sensors FROM anon, authenticated;
CREATE POLICY tenant_isolation ON sensors
  USING (facility_id = current_setting('app.facility_id', true)::int);

ALTER TABLE growth_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON growth_profiles FROM anon, authenticated;
CREATE POLICY tenant_isolation ON growth_profiles
  USING (organization_id = current_setting('app.org_id', true)::int);

ALTER TABLE accounting_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON accounting_connections FROM anon, authenticated;
CREATE POLICY tenant_isolation ON accounting_connections
  USING (organization_id = current_setting('app.org_id', true)::int);

ALTER TABLE seed_lots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON seed_lots FROM anon, authenticated;
CREATE POLICY tenant_isolation ON seed_lots
  USING (facility_id = current_setting('app.facility_id', true)::int);

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inventory_items FROM anon, authenticated;
-- (already added above; included here only if inventory_items wasn't already covered)

ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON organization_members FROM anon, authenticated;
CREATE POLICY tenant_isolation ON organization_members
  USING (organization_id = current_setting('app.org_id', true)::int);
```

(Remove the accidental duplicate `inventory_items` block above when actually writing the file — included here only to flag it as a spot to double-check, not to write twice.)

- [ ] **Step 2: Update the foundation pgTAP test's migration count**

`supabase/tests/00001_foundation.sql` asserts an exact row count for `supabase_migrations.schema_migrations` (currently 6, per the fix landed in the prior onboarding-wizard branch's CI-repair work) — bump it to 7 and update the comment listing what each migration does, following that same file's existing style.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00007_tenancy_rls_policies.sql supabase/tests/00001_foundation.sql
git commit -m "feat(db): enable RLS with tenant-isolation policies on scoped tables"
```

---

### Task 9: Scoped-query helper (`withTenantScope`)

**Files:**
- Create: `lib/db/src/scope.ts`
- Test: `lib/db/src/scope.test.ts`
- Modify: `lib/db/src/index.ts` (export the new helper)

**Interfaces:**
- Consumes: `pool`/`db` (existing, `lib/db/src/index.ts`).
- Produces: `withTenantScope<T>(ctx: TenantContext, fn: (tx: DrizzleTx) => Promise<T>): Promise<T>` — the primary mechanism every MT-M1 route-handler rewrite calls instead of touching `db` directly. `TenantContext = { organizationId: number; facilityId?: number }`.

- [ ] **Step 1: Write the helper**

```ts
// lib/db/src/scope.ts
import { sql } from "drizzle-orm";
import { db } from "./index.js";
import type { PgTransaction } from "drizzle-orm/pg-core";

export interface TenantContext {
  organizationId: number;
  facilityId?: number;
}

/**
 * Wraps a scoped query in a transaction that sets SET LOCAL session
 * variables for RLS policies to key on (app.org_id, app.facility_id). This
 * is the ONLY sanctioned way route handlers touch a tenant-scoped table --
 * scripts/ci/check-tenant-scope.mjs enforces this in CI.
 *
 * SET LOCAL resets automatically at transaction end, which is exactly
 * compatible with Supabase's transaction-pooler connection reuse (a bare
 * session-level SET would leak across pooled connections; SET LOCAL cannot).
 *
 * Throws synchronously (before opening a transaction) if ctx has no
 * organizationId -- never a silent unscoped fallback.
 */
export async function withTenantScope<T>(
  ctx: TenantContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (tx: any) => Promise<T>,
): Promise<T> {
  if (!ctx || !ctx.organizationId) {
    throw new Error("withTenantScope called without a resolvable organization context");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.org_id = ${ctx.organizationId}`);
    if (ctx.facilityId !== undefined) {
      await tx.execute(sql`SET LOCAL app.facility_id = ${ctx.facilityId}`);
    }
    return fn(tx);
  });
}
```

(The `tx` parameter type: use whatever drizzle-orm's `db.transaction()` callback type actually resolves to in this codebase's installed version — check an existing `db.transaction(async (tx) => ...)` call site, e.g. `artifacts/api-server/src/routes/facilities.ts`, for the exact type import path already established there, and match it rather than using `any`.)

- [ ] **Step 2: Write the failing test**

```ts
// lib/db/src/scope.test.ts
import { describe, test } from "node:test";
import { strictEqual, rejects } from "node:assert";
import { withTenantScope } from "./scope.js";

describe("withTenantScope", () => {
  test("throws synchronously when organizationId is missing", async () => {
    await rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => withTenantScope({} as any, async () => "unreachable"),
      /organization context/,
    );
  });

  test("throws when ctx is null/undefined", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await rejects(() => withTenantScope(null as any, async () => "unreachable"));
  });
});
```
(DB-gated tests for the actual `SET LOCAL` + RLS-enforcement behavior belong in MT-M1, alongside the first real handler rewired to use this helper against a real scoped table — this task's own test only covers the guard-clause behavior that doesn't need a live database.)

- [ ] **Step 3: Run the test**

Run: `pnpm --filter @workspace/db run test` (or the project's equivalent test command for this package — check `lib/db/package.json` for the actual script name if `test` doesn't exist yet; add one matching `artifacts/api-server`'s `node scripts/run-tests.mjs` convention if this package has no test runner wired up yet).

- [ ] **Step 4: Export from the package**

In `lib/db/src/index.ts`, add: `export * from "./scope.js";`

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @workspace/db run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add lib/db/src/scope.ts lib/db/src/scope.test.ts lib/db/src/index.ts
git commit -m "feat(db): add withTenantScope helper (SET LOCAL + transaction wrapping for RLS)"
```

---

### Task 10: CI-enforced scoping check (replaces "ESLint rule")

**Files:**
- Create: `scripts/ci/check-tenant-scope.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the route files under `artifacts/api-server/src/routes/`.
- Produces: a CI-failing check when any of those files calls `db.select/insert/update/delete` directly against a scoped table outside `withTenantScope`.

- [ ] **Step 1: Write the check script**

```js
// scripts/ci/check-tenant-scope.mjs
// Fails if any route handler touches a tenant-scoped table directly instead
// of through withTenantScope() (TEN-004). This repo has no ESLint -- this
// is a hand-written check matching check-dependency-audit.mjs's pattern.
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROUTES_DIR = path.join(ROOT, "artifacts/api-server/src/routes");

// Scoped tables added in this milestone (Tasks 1-6) -- extend this list as
// MT-M1/MT-M2 add more.
const SCOPED_TABLES = [
  "cyclesTable",
  "inventoryItemsTable",
  "alertsTable",
  "tasksTable",
  "shipmentsTable",
  "facilityLogsTable",
  "sensorsTable",
  "growthProfilesTable",
  "accountingConnectionsTable",
  "seedLotsTable",
  "organizationMembersTable",
];

const DIRECT_CALL = new RegExp(
  `\\bdb\\.(select|insert|update|delete)\\([^)]*\\)[^;]*\\.(from|into|table)\\((${SCOPED_TABLES.join("|")})\\)`,
);

let violations = [];

for await (const file of glob("**/*.ts", { cwd: ROUTES_DIR })) {
  const fullPath = path.join(ROUTES_DIR, file);
  const content = readFileSync(fullPath, "utf8");
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    if (DIRECT_CALL.test(line) && !content.includes("withTenantScope")) {
      violations.push(`${path.relative(ROOT, fullPath)}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error("Direct scoped-table access found outside withTenantScope:\n");
  for (const v of violations) console.error(`  ${v}`);
  console.error(`\n${violations.length} violation(s). Route this through withTenantScope() (lib/db/src/scope.ts).`);
  process.exit(1);
}
console.log(`check-tenant-scope: clean (${SCOPED_TABLES.length} scoped tables checked, 0 violations)`);
```

Note for the implementer: this is a deliberately simple line-based check, not a full AST parse — it is meant to catch the common case (a route handler calling `db.select().from(cyclesTable)` etc. directly), not every conceivable way to circumvent it. MT-M1 is where every existing route handler actually gets rewired to use `withTenantScope`, so this check will have zero real call sites to flag in MT-M0 itself (nothing has been rewired yet) — confirm it passes with 0 violations when run now, and that it's still a real, working check (test it by temporarily adding a violating line to a scratch file, confirming it's caught, then removing the scratch file — do not leave the scratch file in the commit).

- [ ] **Step 2: Wire it into the Quality CI job**

In `.github/workflows/ci.yml`, add a new step to the `quality` job, directly after the existing `Typecheck` step:

```yaml
      - name: Check tenant-scoping (TEN-004)
        run: node scripts/ci/check-tenant-scope.mjs
```

- [ ] **Step 3: Verify locally**

Run: `node scripts/ci/check-tenant-scope.mjs` — must print `check-tenant-scope: clean (11 scoped tables checked, 0 violations)` (or the actual current count of scoped tables).

- [ ] **Step 4: Commit**

```bash
git add scripts/ci/check-tenant-scope.mjs .github/workflows/ci.yml
git commit -m "feat(ci): add hand-written tenant-scoping check (TEN-004), no ESLint in this repo"
```

---

### Task 11: ADR-005 — Tenancy shape

**Files:**
- Create: `docs/adr/ADR-005.md`

- [ ] **Step 1: Write the ADR**

Adapt PRD §9 ("ADR-003 rev. C — Tenancy shape") verbatim into this repo's ADR format (follow `docs/adr/ADR-004.md`'s header/section structure: Status, Date, Related, Context, Decision, Consequences), renumbered to ADR-005, with a note correcting the PRD's own stale numbering:

```markdown
# ADR-005: Multi-tenancy shape — organizations, facilities, rooms-as-stage-rows

**Status:** Accepted
**Date:** August 2026
**Related:** `docs/superpowers/specs/2026-08-03-multi-tenancy-mt-m0-foundations-design.md`, `FarmSmart_MultiTenancy_PRD_v1.5.docx` §9 (source content — that document calls this "ADR-003 rev. C," a number already taken in this repo by the Neon→Supabase migration; this decision is recorded here as ADR-005 instead)

## Context

FarmSmart's live schema was single-tenant three ways: no operational table
carried a tenant scope, the room enum was globally unique (one seeding room
in the entire database), and facility configuration lived in environment
variables. The room model went through two prior revisions before this one:
rev. A (fixed, one room per stage) → rev. B (multi-room per stage,
speculative, never implemented) → rev. C (fixed again, this decision).
Rev. B's multiplicity was speculative for the current customer segment, and
its cost was concentrated in product surfaces (a wizard rooms-stepper, mobile
disambiguation, capacity badges) rather than schema — since neither revision
shipped, reversing course cost documentation only. This decision keeps rev.
B's one cheap part (rooms modeled as per-facility rows, not a bare enum) and
sheds the surface cost, so a future revisit starts from existing schema
headroom rather than from scratch.

## Decision

- Tenant boundary: 1 tenant = 1 organization; users belong to exactly one organization (v1), enforced via `organization_members.user_id` UNIQUE.
- Hierarchy: organization → facilities (1..n) → rooms (exactly 1 per stage, enum-closed) → channels → racks → levels.
- Room model: rooms as per-facility rows with a `name` column (seeding/fertigation/harvesting), `UNIQUE(facility_id, name)` — already implemented by the Phase 1 onboarding wizard; this ADR ratifies that shape as the multi-tenancy decision, not a new migration. Rows (not a bare enum) are retained deliberately: re-introducing multiplicity later is `UNIQUE(facility_id, name)` → `UNIQUE(facility_id, name, index)` plus UI — additive, not a rewrite.
- Org/membership: `organization_members` (organization_id, user_id, role, status) on Supabase auth identity. Roles: `owner | admin | technician`. Two entry paths (public sign-up creates a tenant; dashboard invite joins an existing one) — both MT-M2 scope.
- Enforcement: application-layer scoped-query helper (`withTenantScope`) as the primary control; Supabase RLS as defense-in-depth (this repo's Q31 resolution: include RLS now, not deferred).

## Consequences

**Positive:** the wizard stays at its simplest (nine numbers — channels ×
racks × levels per stage, no room-count/naming step); mobile scan-validation
copy matrix shrinks (stage validation only, no room disambiguation); the
rooms migration itself is trivial (the shape already exists); multi-facility
operation ships without a multi-room UX tax.

**Costs:** mid-size farms with genuinely multiple physical rooms per stage
cannot model them as separate rooms in v1 — they operate as one logical room
per stage until multiplicity returns.

**Risks:** a single-control scoping approach if RLS were ever skipped —
mitigated here by RLS as defense-in-depth alongside the helper, not instead
of it (this repo's Q31 resolution); a multi-room customer arriving before
multiplicity returns — mitigated by the schema headroom above bounding the
cost of responding.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/ADR-005.md
git commit -m "docs: add ADR-005 (multi-tenancy shape)"
```

---

### Task 12: ADR-006 — Auth provider lineage

**Files:**
- Create: `docs/adr/ADR-006.md`

- [ ] **Step 1: Write the ADR**

```markdown
# ADR-006: Auth provider lineage — Cognito → Clerk → Supabase

**Status:** Accepted (historical record)
**Date:** August 2026
**Related:** ADR-003 (Supabase Postgres migration), ADR-005 (multi-tenancy shape — org/membership moves app-side because Supabase has no Organizations product)

## Context

FarmSmart's auth provider changed twice before settling on Supabase Auth:
AWS Cognito (original), then Clerk (introduced Organizations for multi-tenant
identity), then Supabase Auth (current, alongside the Postgres migration in
ADR-003). The original multi-tenancy design (Onboarding & Multi-Tenancy PRD
v0.2) assumed Clerk Organizations would provide org identity, membership,
invitations, and roles natively. The Supabase migration removed that
assumption: Supabase has no Organizations product, so ADR-005 moves the
entire org/membership layer app-side (`organizations`, `organization_members`
tables) rather than depending on a provider-native construct.

## Decision

Record the lineage for future readers who encounter references to Clerk
Organizations, Cognito user pools, or similar in older planning documents:
none of that infrastructure exists in the current system. Supabase Auth
(`auth.users`) is the sole identity store; all organizational structure is
application-defined (ADR-005).

## Consequences

No currently-open question depends on Cognito or Clerk specifics. This ADR
exists purely so a reader hitting a stale reference in an older PRD (e.g.
"Clerk Organizations pricing," PRD v1.5 §8 Q14) has a pointer to what
actually shipped instead.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/ADR-006.md
git commit -m "docs: add ADR-006 (auth provider lineage)"
```

---

### Task 13: Pilot snapshot rehearsal

**Files:**
- Create: `docs/runbooks/mt-m0-rehearsal-report.md`

**Interfaces:**
- Consumes: every migration from Tasks 1-8, a pilot data snapshot (however this repo's existing rehearsal process obtains one — check `docs/runbooks/` for an existing snapshot/rehearsal procedure from the ADR-003 Supabase cutover or the rooms.facility_id fix, and reuse that same mechanism rather than inventing a new one).

- [ ] **Step 1: Identify the existing rehearsal mechanism**

Search `docs/runbooks/` for how the prior Supabase cutover (ADR-003) or the onboarding-wizard rooms/facility migration was rehearsed against real pilot data before production. Reuse that exact mechanism (likely: restore a pilot snapshot into a disposable/staging Postgres instance, then run `pnpm --filter @workspace/db run db:migrate` against it).

- [ ] **Step 2: Run the full migration series (0017-0024, 00007) against the rehearsal instance**

Run: `DATABASE_URL="<rehearsal-instance-url>" pnpm --filter @workspace/db run db:migrate`, then `pnpm exec supabase db push --db-url "<rehearsal-instance-url>" --include-all` for the new `00007` Supabase-managed migration.

- [ ] **Step 3: Verify pilot labels still resolve**

Run whatever existing verification confirms printed QR labels (levels: `F1-C2-S4` format; seed lots: `qr_code`) still resolve correctly against the migrated rehearsal instance — this is the PRD's own stated exit bar ("pilot labels resolve unchanged"). If a scripted verification already exists from the rooms/facility work, reuse it; if not, a manual spot-check against a handful of known pilot QR codes is acceptable for this milestone, documented as such.

- [ ] **Step 4: Run pgTAP + api-server test suites against the rehearsal instance**

Run: `pnpm exec supabase test db --db-url "<rehearsal-instance-url>" supabase/tests` and `CI=true REQUIRE_TEST_DATABASE=true TEST_DATABASE_URL="<rehearsal-instance-url>" DATABASE_URL="<rehearsal-instance-url>" pnpm --filter @workspace/api-server run test` — both must be clean (the same two checks `scripts/ci/test-disposable-supabase.sh` already runs, just against the rehearsal instance instead of a fresh disposable one, since this rehearsal specifically needs to prove behavior against *pilot data*, not an empty schema).

- [ ] **Step 5: Write the rehearsal report**

Document actual results (not placeholders) in `docs/runbooks/mt-m0-rehearsal-report.md`: migration list applied, label-resolution verification method + result, test suite results, and the Task 4/Task 7 items that remain open going into MT-M1 (the known typecheck-failure file list from Task 4; the DATABASE_URL role-rotation status from Task 7).

- [ ] **Step 6: Commit**

```bash
git add docs/runbooks/mt-m0-rehearsal-report.md
git commit -m "docs: record MT-M0 pilot-snapshot rehearsal results"
```

---

## Exit criteria (from the PRD, unchanged)

- Rehearsal against pilot snapshot is clean (Task 13).
- Pilot labels resolve unchanged (Task 13).
- Helper lint (the tenant-scoping check) is enforced in CI (Task 10).

## Explicitly not in this plan (MT-M1/MT-M2 territory — see design doc)

Rewiring every route handler to actually call `withTenantScope` with real session-resolved context; the TEN-007 cross-tenant isolation test suite; dropping the deprecated `users.role`/`users.organizationId` columns; anything from TEN-008/010/012/013/014 (facility switcher, invites, sign-up, fork, demo mode, mobile sign-in-only).
