# Self-Serve Onboarding Wizard — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the four-step self-serve onboarding wizard (Farm basics → Layout grid → Sensor registry → Done) plus the persistent dashboard "Farm Readiness" checklist, per the design handoff at `~/Downloads/design_handoff_onboarding_phase1/` (PRD *Self-Serve Onboarding & Multi-Tenancy v0.3*, Phase 1/single-site launch), covering WIZ-001…006, CHK-001…003, SEN-001…004 (registration surface only), HND-001…002, and the UI-visible parts of TEN-002/003/005.

**Architecture:** Additive Drizzle migrations (new `organizations`, `sensor_accounts`, `wizard_progress`, `facility_readiness_events` tables; new columns on `facilities`/`users`/`rooms`/`sensors`) → new Express routes following the existing `routes/inventory.ts` zod-validated convention → spec-first OpenAPI additions → orval-generated React Query hooks → a new `pages/onboarding/` wizard reusing the existing shadcn/ui primitives, design tokens, and react-hook-form+zod pattern already in the codebase → a facility-existence guard added to the existing `AuthGate` in `App.tsx` → a standalone `FarmReadinessCard` rendered above the existing metric grid in `Overview.tsx`.

**Tech Stack:** Drizzle ORM/Kit (existing), Express + zod (existing), OpenAPI spec-first + orval codegen (existing), React 19 + Vite + wouter + TanStack Query v5 (existing), shadcn/ui (new-york, existing components only — no new shadcn CLI adds except one custom Stepper primitive), Tailwind v4 tokens (existing, already match the design spec 1:1), Supabase Auth (existing — **not Clerk**, see Audit §1).

## Global Constraints

- **Auth is Supabase Auth, not Clerk.** The design README's "organization (Clerk-mirrored, never shown to user)" language is stale — treat "organization" purely as a new first-class table this plan introduces, unrelated to any Clerk concept. Identity comes from `req.supabaseUser.sub` via `supabaseAuthMiddleware` (`artifacts/api-server/src/middlewares/supabaseAuth.ts:24-49`).
- **No multi-tenancy exists today** — single global `facilities` row, no org/tenant table, no scoped-query helper, every `db.select()` in the codebase is unscoped. This plan adds a minimal `organizations` table and org-scoping columns to unblock the wizard's literal requirements (WIZ-002, TEN-001/003), but does **not** implement full cross-table RLS/tenant-isolation enforcement (TEN-004's "org B resource from org A session → 404" is **out of scope** for this plan — flagged as a follow-up in Risks & Gaps, not silently dropped).
- **`roomsTable.name` has a global `unique()` constraint on the enum value alone** (`lib/db/src/schema/index.ts:282`) — only one row can ever have `name = 'seeding'` across the *entire database*. This is a **blocking bug** for any second organization/facility and must be fixed in Task 1 before anything else in this plan can work.
- pnpm only; every command in this plan uses `pnpm`.
- Migrations: `lib/db/drizzle/*.sql`, numbered `NNNN_slug.sql`, generated via `pnpm --filter @workspace/db run db:generate` (next number is `0014`). Never hand-write migration SQL — edit the Drizzle schema and generate.
- OpenAPI is spec-first (`lib/api-spec/openapi.yaml`) — after any edit, run `cd lib/api-spec && pnpm run codegen` then `pnpm run typecheck:libs` from repo root, per `README.md`.
- Reuse existing shadcn/ui primitives verbatim — `select.tsx`, `tabs.tsx`, `checkbox.tsx`, `toggle-group.tsx`, `progress.tsx`, `dialog.tsx`, `card.tsx`, `button.tsx`, `input.tsx`, `label.tsx`, `form.tsx`, `sonner.tsx` all already exist in `artifacts/admin-dashboard/src/components/ui/` — **do not** run `shadcn add` for any of these. The only new UI primitive needed is a numeric `Stepper` (no existing component matches the design's `− [value] +` control).
- Design tokens already match the spec exactly (verified in `artifacts/admin-dashboard/src/index.css`: `--background: 248 20% 97%`, `--primary: 142 40% 30%`, `--status-ok/warn/critical` all present) — **no new tokens**, consume via existing `hsl(var(--token))` classes only.
- Never use the words "organization" or "rooms" in user-facing copy (README explicit rule) — UI copy says "farm"/"facility"/"zones".
- The wizard has no close/escape and is not skippable except W3.5's per-substep "Set up later" link — never add a dismiss control to the wizard shell.
- No emoji in any new copy except reusing the existing single 🌿 in the empty-cycles state (already shipped) — do not introduce new emoji.
- **RLS posture (added after re-audit against the Technical Review Foundation + Release 1 plans):** Foundation/Release 1 Tasks 1, 2, 4-12 have shipped; Release 1 **Task 3 ("Deny direct Data API access" — enable RLS + revoke `anon`/`authenticated` grants on all 26 application tables) has NOT shipped yet** — confirmed by grep: only `public.users` has RLS enabled today (`supabase/migrations/00002_users_rls.sql`). Whether Task 3 lands before or after this plan, every new table this plan introduces (`organizations`, `wizard_progress`, `sensor_accounts`, `facility_readiness_events`, `wizard_events`) must ship with the same `enable row level security` + revoke-grants treatment from day one, so they are never the one gap in an otherwise-locked-down schema. This does not change how the Express API reaches them (it connects with a privileged Postgres role, not through `anon`/`authenticated` — RLS only blocks direct Supabase Data API access).
- **Test conventions (corrected after re-audit):** the real, shipped convention is `artifacts/api-server/src/tests/routes/<name>.test.ts` (not `src/routes/__tests__/`), and route tests use the harness that landed in Release 1 Task 4: `createAuthenticatedTestApp(router, user?)` + `DEFAULT_TEST_USER` (`src/tests/helpers/testApp.ts`) and `requireTestDatabaseUrl()`/`useDatabaseFixture()` (`src/tests/helpers/testDatabase.ts`) — gated with `describe(..., { skip: !requireTestDatabaseUrl() })` exactly as `inventory.test.ts`/`tasks.test.ts` already do. Every test task below uses this harness, not a hand-rolled `supertest` + fake bearer token.
- **Device model decision:** the existing `sensorsTable` (`lib/db/src/schema/index.ts:332-358`) is one row per single `type` (its `sensorTypeEnum` is a single value, not an array). The wizard's "Measures" field is a multi-select (a combo pH/EC probe reports two types). Rather than rewrite `sensorsTable` into a parent/child device model, **Phase 1 registers one `sensorsTable` row per (measure × channel) combination**, all sharing the same `label`, and groups them client-side by `label` for display (the Review screen's "pH/EC probe × 3" collapse already implies grouping — this plan extends that grouping key from "same label" to "same label, collapsed across both channel-duplicates and measure-splits"). This avoids a breaking schema rewrite of the already-shipped sensors/readings pipeline. Documented as a explicit tradeoff in Risks & Gaps.
- No analytics/telemetry system exists anywhere in the codebase (confirmed zero hits for GA/PostHog/Sentry/etc. in a prior audit this session). WIZ-006 telemetry is implemented as a minimal, purpose-built `wizard_events` append-only table + fire-and-forget endpoint — not a general analytics platform.

---

## Codebase Audit Summary (Step 1)

Condensed findings (full audit was cited file:line during planning; key facts only below).

| Area | Finding | Citation |
|---|---|---|
| Auth | Supabase Auth (JWT via `jwtVerify` against Supabase JWKS), not Clerk. Stale comments elsewhere still say "Clerk session." | `middlewares/supabaseAuth.ts:24-49`, `app.ts:89,105` |
| Multi-tenancy | None. No org/tenant table, no scoped-query helper. `usersTable` has no org FK. | `lib/db/src/schema/index.ts` (full scan) |
| Rooms bug | `roomsTable.name` (enum) has a **global** `.unique()` — blocks any 2nd facility from ever creating a "seeding" room. | `lib/db/src/schema/index.ts:282` |
| Facilities | `facilitiesTable`: `id, name, createdAt` only. `roomsTable.facilityId` nullable, `onDelete: set null`, **never used as a filter anywhere**. | `lib/db/src/schema/index.ts:268-287` |
| Rooms→Channels→Racks→Trays | Full hierarchy + CRUD exists and works: `POST /layout/channels`, `/layout/racks`, `/layout/trays`, `PATCH .../tray-count`. No zod — manual `if (!x)` checks. `ensureRoomsExist()` auto-seeds the 3 fixed rooms on first GET. **No facility-creation or room-creation endpoint exists.** | `routes/layout.ts:1-100+` |
| Sensors | Real device registry exists (`sensorsTable`: `channelId`/`rackId` nullable, `type`, `label`, `unit`, `lastValue`, `lastReadAt`; `CHECK` requires channelId OR rackId not null — **no room-level or facility-level placement possible today**). `POST /sensors`, `GET /sensors` exist. Separate `sensor_readings` table+route for ingest. | `lib/db/src/schema/index.ts:332-358`, `routes/sensors.ts:21,32` |
| QuickBooks | Full OAuth connect/callback/token-refresh/encryption flow already built and working: `accounting_connections` table (userId, provider, encrypted tokens), `GET /accounting/connect`, `GET /accounting/callback` (public), `lib/accounting/quickbooks.ts`, `lib/accounting/crypto.ts` (AES-256-GCM `encryptToken`/`decryptToken`). Client: `Accounting.tsx` `handleConnect()` redirects to `authorizeUri`. **Reusable verbatim for W4's "Connect QuickBooks" card.** | `lib/accounting/quickbooks.ts`, `routes/accounting.ts`, `pages/accounting/Accounting.tsx` |
| Per-user settings | `user_settings` table (`userId, key, value jsonb`, unique on `(userId, key)`) + `GET/PUT /users/me/settings[/​:key]` **already exist and are exactly what CHK-003's per-user collapse-state needs** — no new table required for that piece. Client pattern: `useGetUserSettings`/`usePutUserSetting` with localStorage instant-write fallback. | `lib/db/src/schema/index.ts:462-474`, `routes/userSettings.ts:15,29`, `hooks/use-metric-selection.ts` |
| Routing/guard | wouter `<Switch>` in `App.tsx:29-45`. `AuthGate` (`App.tsx:66-143`) has exactly one branch point (`return <Router/>` at line 142) where a facility-existence check slots in as a new third branch. | `App.tsx:66-143` |
| Form pattern | react-hook-form + `zodResolver` + shadcn `<Form>` fully established (`Inventory.tsx` Add Item dialog: schema, `useForm`, `<FormField>`/`<FormMessage>`). | `pages/inventory/Inventory.tsx` |
| React Query pattern | Query + mutation hooks generated by orval from `openapi.yaml`; `onSuccess` calls `queryClient.invalidateQueries({ queryKey: getXQueryKey() })`, then toast via `sonner`. | `pages/inventory/Inventory.tsx` |
| Overview / dashboard | KPI cards are **not** hand-laid-out — they come from a user-configurable `DraggableMetricGrid` driven by `lib/metrics`' registry. The **Farm Readiness card is explicitly a standalone, always-visible-until-retired card, not a user-toggleable metric** (README §8) — it must render directly in `Overview.tsx` above `<DraggableMetricGrid>`, **not** be registered in `lib/metrics`. | `pages/overview/Overview.tsx:40-66` |
| shadcn inventory | `select.tsx`, `tabs.tsx`, `checkbox.tsx`, `toggle-group.tsx`, `progress.tsx`, `dialog.tsx`, `card.tsx`, `button.tsx`, `input.tsx`, `label.tsx`, `form.tsx` all present and substantive. **No numeric stepper component exists anywhere in the codebase.** | `components/ui/*.tsx` (directory listing) |
| Crypto | `encryptToken(plaintext): string` / `decryptToken(encoded): string`, AES-256-GCM, keyed by `ACCOUNTING_ENCRYPTION_KEY` env var. Generic despite the accounting-specific file location — reusable as-is for sensor vendor credentials. | `lib/accounting/crypto.ts` |
| Design tokens | Match the design spec exactly: `--background: 248 20% 97%`, `--primary: 142 40% 30%`, `--status-ok: 142 45% 32%` / `warn: 38 85% 42%` / `critical: 0 72% 45%`. No token work needed. | `admin-dashboard/src/index.css` |

---

## Section 2.1 — Database Schema & Data Model Change Plan

### New tables

```ts
// lib/db/src/schema/index.ts — add after facilitiesTable (near line 268)

export const organizationsTable = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

```ts
// wizard_progress — resume support (WIZ-001 "resume at last incomplete step")
export const wizardStepEnum = pgEnum("wizard_step", [
  "farm_basics",
  "layout",
  "sensors_accounts",
  "sensors_devices",
  "sensors_review",
  "done",
]);

export const wizardProgressTable = pgTable(
  "wizard_progress",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => usersTable.id),
    organizationId: integer("organization_id").references(() => organizationsTable.id),
    currentStep: wizardStepEnum("current_step").notNull().default("farm_basics"),
    stepData: jsonb("step_data").notNull().default({}),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("wizard_progress_user_id_uniq").on(table.userId)],
);
```

```ts
// sensor_accounts — vendor cloud accounts (SEN-002/003), org-scoped per README
export const sensorAuthMethodEnum = pgEnum("sensor_auth_method", [
  "api_key",
  "oauth",
  "username_password",
]);
export const sensorAccountStatusEnum = pgEnum("sensor_account_status", [
  "connected",
  "failed",
  "pending_integration",
]);

export const sensorAccountsTable = pgTable(
  "sensor_accounts",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    vendor: text("vendor").notNull(),
    authMethod: sensorAuthMethodEnum("auth_method").notNull(),
    status: sensorAccountStatusEnum("status").notNull().default("pending_integration"),
    maskedFingerprint: text("masked_fingerprint"),
    credentialCiphertext: text("credential_ciphertext"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sensor_accounts_org_vendor_uniq").on(table.organizationId, table.vendor),
  ],
);
```

```ts
// facility_readiness_events — event-driven checklist state (CHK-001..003, "event-driven" per README)
export const readinessEventKeyEnum = pgEnum("readiness_event_key", [
  "labels_downloaded",
  "labels_scanned",       // completes item 1 — set ONLY by mobile on first shelf scan (CHK-001)
  "grow_profile_created",
  "seeds_added",
  "first_cycle_seeded",
  "sensors_skipped",      // W3.5 "Set up later" — item 5 skip (reversible)
  "quickbooks_skipped",   // W4 QuickBooks "Skip" — item 6 -> "Later"
  "team_invited",
]);

export const facilityReadinessEventsTable = pgTable(
  "facility_readiness_events",
  {
    id: serial("id").primaryKey(),
    facilityId: integer("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    eventKey: readinessEventKeyEnum("event_key").notNull(),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
    undoneAt: timestamp("undone_at"), // set when a skip is reversed (item 5 "undo from Sensors")
  },
  (table) => [
    index("facility_readiness_events_facility_id_idx").on(table.facilityId),
    uniqueIndex("facility_readiness_events_facility_key_uniq").on(
      table.facilityId,
      table.eventKey,
    ),
  ],
);
```

```ts
// wizard_events — minimal telemetry (WIZ-006), append-only, no PII beyond userId
export const wizardEventTypeEnum = pgEnum("wizard_event_type", [
  "view",
  "save",
  "abandon",
  "skip",
]);

export const wizardEventsTable = pgTable("wizard_events", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => usersTable.id),
  step: wizardStepEnum("step").notNull(),
  eventType: wizardEventTypeEnum("event_type").notNull(),
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
});
```

### Modified tables

```ts
// facilitiesTable — add organization scope (lib/db/src/schema/index.ts:268)
export const facilitiesTable = pgTable("facilities", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  facilityName: text("facility_name").notNull(), // W2 "Facility name" (defaults to farm name client-side)
  timezone: text("timezone").notNull(),
  units: text("units", { enum: ["metric", "imperial"] }).notNull().default("metric"),
  currency: text("currency").notNull().default("USD"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

```ts
// roomsTable — FIX the global-unique bug + make facility-scoped (lib/db/src/schema/index.ts:280)
export const roomsTable = pgTable(
  "rooms",
  {
    id: serial("id").primaryKey(),
    name: roomNameEnum("name").notNull(), // .unique() REMOVED from column
    sortOrder: integer("sort_order").notNull().default(0),
    facilityId: integer("facility_id")
      .notNull() // was nullable — now required
      .references(() => facilitiesTable.id, { onDelete: "cascade" }), // was "set null"
  },
  (table) => [
    uniqueIndex("rooms_facility_id_name_uniq").on(table.facilityId, table.name), // composite unique instead
  ],
);
```

```ts
// usersTable — add organization membership (lib/db/src/schema/index.ts:95)
// Add one column to the existing usersTable definition:
organizationId: integer("organization_id").references(() => organizationsTable.id),
```

```ts
// sensorsTable — allow room-level and facility-wide placement (lib/db/src/schema/index.ts:332)
export const sensorsTable = pgTable(
  "sensors",
  {
    id: serial("id").primaryKey(),
    channelId: integer("channel_id").references(() => channelsTable.id, { onDelete: "cascade" }),
    rackId: integer("rack_id").references(() => racksTable.id, { onDelete: "cascade" }),
    roomId: integer("room_id").references(() => roomsTable.id, { onDelete: "cascade" }), // new
    facilityWide: boolean("facility_wide").notNull().default(false), // new — "Whole facility" rung
    sensorAccountId: integer("sensor_account_id").references(() => sensorAccountsTable.id, {
      onDelete: "set null",
    }), // new — null = "Local (none)"
    type: sensorTypeEnum("type").notNull(),
    label: text("label").notNull(),
    unit: text("unit"),
    lastValue: numeric("last_value"),
    lastReadAt: timestamp("last_read_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("sensors_channel_id_idx").on(table.channelId),
    index("sensors_rack_id_idx").on(table.rackId),
    index("sensors_room_id_idx").on(table.roomId),
    index("sensors_sensor_account_id_idx").on(table.sensorAccountId),
    check(
      "sensors_placement",
      sql`${table.channelId} IS NOT NULL OR ${table.rackId} IS NOT NULL OR ${table.roomId} IS NOT NULL OR ${table.facilityWide} = true`,
    ),
  ],
);
```

### RLS on the 5 new tables

Added after re-auditing against the Technical Review Foundation/Release 1 plans (see Global Constraints) — Drizzle doesn't manage RLS, so this is a hand-written Supabase migration, applied the same way `00002_users_rls.sql` and Release 1 Task 3's (not-yet-shipped) lockdown migration do: enable RLS, grant nothing operational to `anon`/`authenticated` (the Express API reaches these tables through its own privileged Postgres connection, never through `anon`/`authenticated`, so this has zero effect on the wizard's own functionality — it only closes off direct Supabase Data API access):

```sql
-- supabase/migrations/000NN_onboarding_tables_rls.sql
-- NN = next available Supabase migration number at implementation time
-- (00006 as of this plan's writing; confirm against supabase/migrations/
-- immediately before creating the file, since Release 1 Task 3 may land first)

alter table public.organizations enable row level security;
alter table public.wizard_progress enable row level security;
alter table public.sensor_accounts enable row level security;
alter table public.facility_readiness_events enable row level security;
alter table public.wizard_events enable row level security;

revoke all on public.organizations from anon, authenticated;
revoke all on public.wizard_progress from anon, authenticated;
revoke all on public.sensor_accounts from anon, authenticated;
revoke all on public.facility_readiness_events from anon, authenticated;
revoke all on public.wizard_events from anon, authenticated;
```

If Release 1 Task 3 ships first, fold these five `alter table ... enable row level security` + `revoke` statements directly into its migration instead of a separate file — do not ship these tables with weaker treatment than the other 26.

### Migration generation & ordering

1. Make all schema edits above in `lib/db/src/schema/index.ts` in one pass (they're interdependent — `organizations` must exist before `facilities.organizationId` references it, etc.).
2. `cd lib/db && pnpm run db:generate` — produces `0014_<slug>.sql` (Drizzle auto-names; rename the generated file's leading comment if needed, never the number).
3. Because `facilitiesTable` gains two new `notNull` columns (`organizationId`, `facilityName`, `timezone` — wait, only `organizationId` and `facilityName`/`timezone` are notNull) and `roomsTable.facilityId` flips nullable→notNull, the existing seeded facility/rooms rows need a **data migration**, not just a schema migration. Add a second, hand-reviewed migration immediately after (`0015_backfill_default_organization.sql`) generated via a one-off Drizzle `sql` call in the same PR:
   ```sql
   INSERT INTO organizations (name) VALUES ('Default Organization')
     ON CONFLICT DO NOTHING;
   -- backfill existing facility/rooms rows to the first (only) org before constraints tighten
   UPDATE facilities SET organization_id = (SELECT id FROM organizations ORDER BY id LIMIT 1)
     WHERE organization_id IS NULL;
   UPDATE rooms SET facility_id = (SELECT id FROM facilities ORDER BY id LIMIT 1)
     WHERE facility_id IS NULL;
   ```
   Run this **before** the `ALTER COLUMN ... SET NOT NULL` statements in `0014` apply, or split `0014` into "add nullable columns" + `0015` "backfill" + `0016` "tighten to NOT NULL" — three small migrations are safer than one big one against a database that already has production data (per this repo's own migration-history discipline noted in `CLAUDE.md`).
4. `pnpm run typecheck` (repo root) to confirm `@workspace/db` consumers still compile.

---

## Section 2.2 — API Endpoint & Contract Design

All new endpoints follow the existing `routes/inventory.ts` convention (zod `safeParse` via a local `validate()` helper, mounted under `/api` behind `requireSignedIn` in `app.ts`) — **not** `routes/layout.ts`'s looser manual-check style, since these new endpoints handle account credentials and org creation and deserve real validation.

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `POST` | `/facilities` | W2 save: creates `organizations` + `facilities` + 3 `rooms` in one transaction | signed-in, no existing facility |
| `GET` | `/facilities/me` | Facility-existence check driving `FacilityGate` (§2.3) — `operationId: getMyFacility` → hook `useGetMyFacility`; returns `null` body + 200 if the user has no facility yet | signed-in |
| `GET` | `/wizard/progress` | Resume: current step + saved draft data | signed-in |
| `PUT` | `/wizard/progress` | Save current step's draft + advance `currentStep` | signed-in |
| `POST` | `/sensor-accounts` | W3.5a: add vendor account | signed-in |
| `GET` | `/sensor-accounts` | W3.5a: list org's accounts | signed-in |
| `POST` | `/sensor-accounts/:id/test-connection` | W3.5a: "Test connection" button | signed-in |
| `POST` | `/sensors/bulk` | W3.5b: bulk-create N sensor rows (channels × measures) | signed-in |
| `GET` | `/facility-readiness` | Dashboard checklist: computed 7-item state | signed-in |
| `POST` | `/facility-readiness/events` | Record/undo a readiness event | signed-in |
| `POST` | `/wizard-events` | WIZ-006 telemetry (view/save/abandon/skip) | signed-in |

Reused verbatim, no changes: `POST /layout/channels`, `/layout/racks`, `/layout/trays` (W3 layout save), `GET /accounting/connect` (W4 QuickBooks connect), `PUT /users/me/settings/:key` (checklist collapse state).

### `POST /facilities`

```yaml
# lib/api-spec/openapi.yaml — new path
/facilities:
  post:
    operationId: createFacility
    summary: W2 — create organization, facility, and the 3 index-1 rooms in one transaction
    security: [{ bearerAuth: [] }]
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            required: [farmName, timezone, units, currency]
            properties:
              farmName: { type: string, minLength: 1 }
              facilityName: { type: string, minLength: 1 }
              timezone: { type: string }
              units: { type: string, enum: [metric, imperial] }
              currency: { type: string, minLength: 3, maxLength: 3 }
    responses:
      "201":
        description: Facility created
        content:
          application/json:
            schema:
              type: object
              properties:
                facilityId: { type: integer }
                organizationId: { type: integer }
      "409":
        description: Signed-in user already belongs to a facility
```

Handler (`routes/facilities.ts`, new file):

```ts
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { organizationsTable, facilitiesTable, roomsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getAuth } from "../middlewares/supabaseAuth";

const router = Router();

const CreateFacilitySchema = z.object({
  farmName: z.string().min(1),
  facilityName: z.string().min(1).optional(),
  timezone: z.string().min(1),
  units: z.enum(["metric", "imperial"]),
  currency: z.string().length(3),
});

function validate<T>(schema: z.ZodSchema<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
    return null;
  }
  return result.data;
}

router.post("/facilities", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const [existingUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId!));
    if (existingUser?.organizationId) {
      return res.status(409).json({ error: "User already belongs to a facility" });
    }

    const body = validate(CreateFacilitySchema, req.body, res);
    if (!body) return;

    const result = await db.transaction(async (tx) => {
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
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create facility" });
  }
});

export default router;
```

Mount in `app.ts` next to the other routers (after line 22, before line 123's catch-all `router`):
```ts
import facilitiesRouter from "./routes/facilities";
// ...
app.use("/api", requireSignedIn, facilitiesRouter);
```

### `POST /sensor-accounts` and `/sensor-accounts/:id/test-connection`

```ts
// routes/sensor-accounts.ts — new file, same validate() helper pattern as above
const CreateSensorAccountSchema = z.object({
  vendor: z.string().min(1),
  authMethod: z.enum(["api_key", "oauth", "username_password"]),
  credential: z.string().min(1), // API key, or JSON-stringified username/password — encrypted before storage
});

router.post("/sensor-accounts", async (req, res) => {
  const { userId } = getAuth(req);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId!));
  if (!user?.organizationId) return res.status(409).json({ error: "No facility yet" });

  const body = validate(CreateSensorAccountSchema, req.body, res);
  if (!body) return;

  const masked = `····${body.credential.slice(-4)}`;
  const [account] = await db
    .insert(sensorAccountsTable)
    .values({
      organizationId: user.organizationId,
      vendor: body.vendor,
      authMethod: body.authMethod,
      status: "pending_integration",
      maskedFingerprint: masked,
      credentialCiphertext: encryptToken(body.credential), // reuse lib/accounting/crypto.ts verbatim
    })
    .returning({ id: sensorAccountsTable.id, vendor: sensorAccountsTable.vendor,
                  status: sensorAccountsTable.status, maskedFingerprint: sensorAccountsTable.maskedFingerprint });
  return res.status(201).json(account); // NEVER return credentialCiphertext or plaintext (SEN-002)
});

router.post("/sensor-accounts/:id/test-connection", async (req, res) => {
  // Supported vendors (allowlist) -> attempt real handshake, set status "connected" on success,
  // return a specific failure reason on failure. Unsupported vendor -> "pending_integration",
  // honest copy, NEVER a fake success (SEN-003). Vendor-specific handshake logic is a per-vendor
  // adapter added under lib/sensor-vendors/<vendor>.ts as each integration is built; this endpoint
  // dispatches to the adapter by `vendor` string and falls through to "pending_integration" for
  // any vendor with no adapter registered yet.
});
```

### `POST /sensors/bulk`

```yaml
/sensors/bulk:
  post:
    operationId: bulkCreateSensors
    requestBody:
      content:
        application/json:
          schema:
            type: object
            required: [label, types, channelIds]
            properties:
              label: { type: string }
              types: { type: array, items: { type: string, enum: [temp, ph, water, humidity, ec] } }
              channelIds: { type: array, items: { type: integer } }
              rackIds: { type: array, items: { type: integer } }
              roomId: { type: integer }
              facilityWide: { type: boolean }
              sensorAccountId: { type: integer, nullable: true }
    responses:
      "201":
        description: One sensor row created per (type × placement target)
```

Handler creates `types.length * max(channelIds.length, rackIds.length, 1)` rows, one per (measure, placement) pair, all sharing `label` — per the Device Model Decision in Global Constraints.

### `GET /facility-readiness` / `POST /facility-readiness/events`

```ts
// GET returns the 7-item computed state the dashboard card renders directly:
{
  items: [
    { key: "labels_downloaded", label: "Print level QR labels", state: "pending" | "interim" | "done" | "skipped", deepLink: "/layout" },
    { key: "grow_profile_created", label: "Create a grow profile", state: "...", deepLink: "/profiles" },
    { key: "seeds_added", label: "Add seeds with QR", state: "...", deepLink: "/inventory?category=Seeds" },
    { key: "first_cycle_seeded", label: "Seed your first cycle", state: "...", deepLink: null }, // "on mobile"
    { key: "sensors_registered", label: "Register sensors", state: "...", count: <live device count> },
    { key: "quickbooks_connected", label: "Connect QuickBooks", state: "...", deepLink: null }, // handled below, in card
    { key: "team_invited", label: "Invite your team", state: "...", deepLink: "/settings" },
  ],
  completedCount: number, // MUST equal count of items with state === "done" — truthfulness rule (CHK-001..003)
}
```
Item 1's `"interim"` state is computed as `labels_downloaded` event exists AND `labels_scanned` does not — **never** set to done by a page visit or PDF download, only by the `labels_scanned` event, which the *mobile app* posts on first successful shelf QR scan (cross-repo dependency: `artifacts/farmeasy` mobile scan handler must `POST /facility-readiness/events { eventKey: "labels_scanned" }` — flagged as a **cross-repo ticket**, Task 19 below). Item 6 (`quickbooks_connected`) is derived from `GET /accounting/connect` status, not a stored event, except for the explicit "Skip" action which stores `quickbooks_skipped`.

`POST /facility-readiness/events` body: `{ eventKey: ReadinessEventKey, undo?: boolean }` — `undo: true` sets `undoneAt = now()` on the existing row (item 5's reversible skip).

### `POST /wizard-events`

```ts
const WizardEventSchema = z.object({
  step: z.enum(["farm_basics", "layout", "sensors_accounts", "sensors_devices", "sensors_review", "done"]),
  eventType: z.enum(["view", "save", "abandon", "skip"]),
});
// fire-and-forget from the client: no response body needed beyond 202, client does not await/block on this
```

---

## Section 2.3 — Frontend Architecture & Component Breakdown

### Component hierarchy

```
pages/onboarding/
  Wizard.tsx                    # shell: top bar, step indicator, routes W2-W4 as internal state (not wouter routes)
  steps/
    FarmBasics.tsx               # W2
    LayoutGrid.tsx                # W3
      ZoneCard.tsx                  # per-zone stepper card (Seeding/Fertigation/Harvesting)
      LiveSchematic.tsx             # right-column grid renderer
      LabelPreviewStrip.tsx         # "S1-C2-S4" mono chip strip
    sensors/
      VendorAccounts.tsx           # W3.5a
      DeviceRegistry.tsx           # W3.5b
        PlacementLadder.tsx          # segmented control + progressive depth fields
      SensorReview.tsx             # W3.5c
    Done.tsx                      # W4
      FarmReadinessPreview.tsx      # same card component reused from dashboard (see below)
      QuickBooksCard.tsx            # thin wrapper calling existing useGetAccountingConnectUri
      MobileHandoffCard.tsx         # QR code (new: real deep-link generator)
  components/
    StepIndicator.tsx            # 24px numbered-circle indicator (W2 only) / compact context text (others)
    ResumeBanner.tsx              # "Picking up where you left off"

components/
  ui/
    stepper.tsx                  # NEW primitive — the only new shadcn-style component needed
  dashboard/
    FarmReadinessCard.tsx         # standalone dashboard card — NOT a lib/metrics entry
```

### Reusability table

| Need | Reuse | New |
|---|---|---|
| Buttons, cards, inputs, labels, dialogs, toasts | `components/ui/{button,card,input,label,dialog,sonner}.tsx` verbatim | — |
| Timezone/Currency select | `components/ui/select.tsx` | — |
| Metric/Imperial segmented control | `components/ui/toggle-group.tsx` (`ToggleGroup type="single"`) | thin `SegmentedControl` wrapper if styling needs a fixed 2-col width |
| Auth-method pill selector (W3.5a) | `components/ui/toggle-group.tsx` | — |
| Placement ladder (W3.5b) | `components/ui/toggle-group.tsx` | — |
| Channel/rack multi-select toggle chips | `components/ui/toggle-group.tsx type="multiple"` | — |
| Channels/Racks/Levels numeric stepper (W3) | — | `components/ui/stepper.tsx` (new) |
| Form validation | react-hook-form + `zodResolver`, exact pattern from `Inventory.tsx` | new zod schemas per step |
| Data fetching | orval-generated hooks off the new OpenAPI paths (§2.2) | — |
| Checklist collapse-state persistence | existing `useGetUserSettings`/`usePutUserSetting` (`use-metric-selection.ts` pattern) | `useFarmReadinessCollapsed()` hook, same shape |
| QuickBooks connect | `useGetAccountingConnectUri` + `Accounting.tsx`'s `handleConnect` redirect logic, called verbatim from `QuickBooksCard.tsx` | — |
| Mobile deep-link QR | — | QR generation lib (check `package.json` — mobile Layout tab already renders QR codes via `react-qr-code` per earlier audit; reuse that same library for the W4 mobile-handoff QR, just a new deep-link URL payload) |

### State management

| Scope | Mechanism |
|---|---|
| Wizard current step + resume | Server: `wizard_progress` row via `GET/PUT /wizard/progress`. Client: React Query, no local Zustand/Redux — matches existing "React Query for server state, useState/context for UI state" convention. |
| W3 per-zone stepper values | Local `useState` per `ZoneCard`, lifted to `LayoutGrid.tsx` parent for the live schematic to consume; persisted to server only on "Create layout →" (not per-keystroke). |
| W3.5 draft state | Local `useState` in `VendorAccounts`/`DeviceRegistry`; each "Add" action is an immediate mutation (matches existing Inventory "Add Item" immediate-save pattern), not deferred to a final wizard submit. |
| Checklist item states | Server-computed via `GET /facility-readiness` (React Query), refetched on `invalidateQueries` after any relevant mutation (e.g., after `POST /sensors/bulk`, invalidate both the sensors list query and the facility-readiness query). |
| Checklist collapse UI state | Per-user, via `user_settings` key `"farmsmart.farmReadiness.collapsed"`, exact hook pattern as `useMetricSelection`. |
| Facility-guard (wizard vs dashboard) | New `useGetMyFacility()` query hook (thin wrapper on a `GET /facilities/me` endpoint — **add this one extra read endpoint**, not listed above, needed purely for the client guard) consumed once in `AuthGate`. |

### Routing / guard integration

`App.tsx:66-143` (`AuthGate`) gets one new branch inserted between the `!session` check and `return <Router/>`:

```tsx
function AuthGate() {
  const { session, loading } = useSupabaseSession();
  // ...existing email/password state...

  if (loading) { /* unchanged */ }
  if (!session) { /* unchanged sign-in form */ }

  return <FacilityGate />;
}

function FacilityGate() {
  const { data: facility, isLoading } = useGetMyFacility();
  if (isLoading) return <LoadingScreen />;
  if (!facility) return <Wizard />;             // no facility yet -> wizard, no dashboard content
  return <Router />;                            // existing dashboard routes
}
```

`<Wizard/>` itself has no wouter `<Route>` entries — it is not URL-addressable per-step (README: "no close/escape; deep links to app routes redirect back into the wizard until W4 completes"). Any deep link into `/cycles`, `/inventory`, etc. is caught by the *same* `FacilityGate` (since it wraps `<Router/>` entirely) and redirected to `<Wizard/>` automatically — no per-route guard duplication needed.

### Responsive & micro-interaction notes

- W3's two-column layout (360px zone cards + flexible schematic) collapses to single-column stacked on `<md`, matching the existing `Sidebar`/`RightSidebar` `md`/`xl` breakpoint conventions already in `AppLayout.tsx`.
- All wizard-internal transitions: `~200ms` width/opacity only, no entrance choreography — reuse Tailwind's `transition-[width,opacity] duration-200`, no new animation library.
- Hover/press use the existing `--elevate-1`/`--elevate-2` overlay tokens already defined in `index.css` (currently under-used per `DESIGN.md` P2-2 — this feature is a good forcing function to actually wire them on the wizard's interactive rows).

---

## Section 2.4 — Step-by-Step Development Tickets

Ordered: **Phase A (foundation/data model, blocking everything)** → **Phase B (W2+W3: farm + layout)** → **Phase C (W3.5: sensors)** → **Phase D (W4 + dashboard checklist)** → **Phase E (polish/validation)**. Each phase is independently shippable and testable — this matches the repo's "one plan file per subsystem" convention; if execution spans multiple sessions, each phase below can be lifted into its own dated plan file at that time.

### Phase A — Data model & tenancy foundation

#### Task 1: Fix the `roomsTable` global-unique bug and add `organizations`

**Files:**
- Modify: `lib/db/src/schema/index.ts` (organizations table, facilities/users/rooms/sensors changes per §2.1)
- Create: `lib/db/drizzle/0014_*.sql` (generated)
- Create: `lib/db/drizzle/0015_backfill_default_organization.sql` (hand-reviewed data migration, see §2.1 step 3)
- Create: `supabase/migrations/000NN_onboarding_tables_rls.sql` (RLS on the 5 new tables, see §2.1 "RLS on the 5 new tables" — skip this file and fold into Release 1 Task 3's migration instead if that lands first)
- Test: `artifacts/api-server/src/tests/routes/facilities.test.ts`

**Interfaces:**
- Produces: `organizationsTable`, `facilitiesTable.organizationId`/`facilityName`/`timezone`/`units`/`currency`, `roomsTable.facilityId` (notNull) + composite unique `(facilityId, name)`, `usersTable.organizationId`, `sensorsTable.roomId`/`facilityWide`/`sensorAccountId`.

- [ ] **Step 1:** Apply every schema edit from §2.1 "New tables" and "Modified tables" to `lib/db/src/schema/index.ts` in one commit.
- [ ] **Step 2:** `cd lib/db && pnpm run db:generate` — verify a new `0014_*.sql` appears and its `ALTER TABLE rooms DROP CONSTRAINT` / `ADD CONSTRAINT rooms_facility_id_name_uniq UNIQUE` statements are present (grep the generated file for `rooms_facility_id_name_uniq`).
- [ ] **Step 3:** Hand-write `lib/db/drizzle/0015_backfill_default_organization.sql` with the exact SQL from §2.1 step 3, and add it to `lib/db/drizzle/meta/_journal.json` following the existing entries' format (copy the shape of the `0013` entry, bump `idx` to 15).
- [ ] **Step 4:** Check `ls supabase/migrations/` for whether Release 1 Task 3's lockdown migration has landed yet. If not, hand-write `supabase/migrations/000NN_onboarding_tables_rls.sql` with the exact SQL from §2.1's "RLS on the 5 new tables". If it has landed, add the same five `enable row level security` + `revoke` statements into that existing migration instead (do not create a second, redundant RLS migration).
- [ ] **Step 5:** `pnpm --filter @workspace/db run db:migrate` against a local/staging DB — confirm it applies cleanly on a copy of prod data with the single existing facility/rooms row.
- [ ] **Step 6:** `pnpm run typecheck` from repo root — confirm `api-server` and `admin-dashboard` still compile against the changed `@workspace/db` types (expect compile errors at every existing `roomsTable`/`facilitiesTable` insert call site that doesn't yet pass the new required fields — fix each one, e.g. `routes/layout.ts`'s `ensureRoomsExist()` will now fail to compile since it doesn't pass `facilityId`; that function is being replaced by `POST /facilities` in Task 2 anyway, so update it to no-op / remove the auto-seed once Task 2 lands).
- [ ] **Step 7:** Commit: `git add lib/db/src/schema/index.ts lib/db/drizzle/ supabase/migrations/ && git commit -m "feat(db): add organizations, fix rooms global-unique bug, extend sensors placement, RLS on new tables"`.

#### Task 2: `POST /facilities` + `GET /facilities/me` endpoints — TEN-001, TEN-003

**Files:**
- Create: `artifacts/api-server/src/routes/facilities.ts` (exact code in §2.2)
- Modify: `artifacts/api-server/src/app.ts` (mount, per §2.2)
- Modify: `artifacts/api-server/src/routes/layout.ts` — remove `ensureRoomsExist()`'s auto-seed insert (rooms are now created transactionally by `POST /facilities`; `GET /layout` should 404 or return empty if no facility exists yet, since the wizard gate prevents reaching this route pre-facility anyway)
- Modify: `lib/api-spec/openapi.yaml` — add both paths
- Test: `artifacts/api-server/src/tests/routes/facilities.test.ts`

**Interfaces:**
- Consumes: `organizationsTable`, `facilitiesTable`, `roomsTable`, `usersTable` (Task 1), `createAuthenticatedTestApp`/`DEFAULT_TEST_USER` (`src/tests/helpers/testApp.ts`), `requireTestDatabaseUrl`/`useDatabaseFixture` (`src/tests/helpers/testDatabase.ts`) — both shipped in Release 1 Task 4.
- Produces: `POST /facilities` → `{ facilityId, organizationId }`; `GET /facilities/me` → `{ id, name, facilityName, timezone, units, currency, organizationId } | null`.

- [ ] **Step 1:** Write the failing test, following `inventory.test.ts`'s exact shape (lazy default-export import inside a `setup()` helper, `useDatabaseFixture` truncating between tests):
  ```ts
  // artifacts/api-server/src/tests/routes/facilities.test.ts
  import { describe, test } from "node:test";
  import { strictEqual, ok } from "node:assert";
  import request from "supertest";
  import { createAuthenticatedTestApp } from "../helpers/testApp";
  import { requireTestDatabaseUrl, useDatabaseFixture } from "../helpers/testDatabase";

  const dbUrl = requireTestDatabaseUrl();

  describe("POST /api/facilities", { skip: !dbUrl }, () => {
    const fixture = useDatabaseFixture(["organizations", "facilities", "rooms", "users"]);

    async function setup() {
      const facilities = await import("../../routes/facilities");
      const { db, roomsTable } = await import("@workspace/db");
      return { app: createAuthenticatedTestApp(facilities.default), db, roomsTable };
    }

    test("creates an organization, facility, and 3 rooms in one transaction", async () => {
      const { app, db, roomsTable } = await setup();
      const res = await request(app)
        .post("/api/facilities")
        .send({ farmName: "Sunrise Greens", timezone: "America/New_York", units: "imperial", currency: "USD" });

      strictEqual(res.status, 201);
      ok(res.body.facilityId);
      const rooms = await db.select().from(roomsTable).where(eq(roomsTable.facilityId, res.body.facilityId));
      strictEqual(rooms.length, 3);
    });

    test("rejects a second facility for a user who already has one", async () => {
      const { app } = await setup();
      await request(app).post("/api/facilities").send({ farmName: "First Farm", timezone: "UTC", units: "metric", currency: "USD" });
      const res = await request(app)
        .post("/api/facilities")
        .send({ farmName: "Second Farm", timezone: "UTC", units: "metric", currency: "USD" });
      strictEqual(res.status, 409);
    });
  });
  ```
- [ ] **Step 2:** Run `TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/routes/facilities.test.ts` — expect FAIL (`Cannot find module '../../routes/facilities'`).
- [ ] **Step 3:** Create `routes/facilities.ts` with the exact handler code from §2.2; mount it in `app.ts`; add `GET /facilities/me` (same file, simple `db.select().from(facilitiesTable).where(eq(facilitiesTable.organizationId, user.organizationId))`, returns `null` body with 200 if none).
- [ ] **Step 4:** Add both paths + a `Facility` schema component to `openapi.yaml`; `cd lib/api-spec && pnpm run codegen`; `pnpm run typecheck:libs` from repo root.
- [ ] **Step 5:** Run `TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/routes/facilities.test.ts` again — expect PASS.
- [ ] **Step 6:** Remove `ensureRoomsExist()`'s insert branch in `routes/layout.ts:14-23` (keep the function signature if other code calls it, but make it a no-op query-only read, since room creation is now `POST /facilities`'s job).
- [ ] **Step 7:** Commit: `git add -A && git commit -m "feat(api): add POST /facilities transactional creation, remove implicit room auto-seed"`.

---

### Phase B — W2 Farm basics + W3 Layout grid

#### Task 3: `Stepper` UI primitive

**Files:**
- Create: `artifacts/admin-dashboard/src/components/ui/stepper.tsx`
- Test: manual (Storybook-less repo — verify visually per Task 5's page, no dedicated unit test framework for pure-presentational components elsewhere in this codebase)

**Interfaces:**
- Produces: `<Stepper value={number} onChange={(n:number)=>void} min={0} label="Channels" />`

- [ ] **Step 1:** Create the component:
  ```tsx
  // components/ui/stepper.tsx
  import { Button } from "@/components/ui/button";
  import { Minus, Plus } from "lucide-react";

  interface StepperProps {
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    label?: string;
  }

  export function Stepper({ value, onChange, min = 0, max, label }: StepperProps) {
    const dec = () => onChange(Math.max(min, value - 1));
    const inc = () => onChange(max !== undefined ? Math.min(max, value + 1) : value + 1);
    return (
      <div className="space-y-1">
        {label && <label className="text-[13px] font-medium">{label}</label>}
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-[26px] w-[28px] rounded-[6px]"
            onClick={dec}
            disabled={value <= min}
            aria-label={`Decrease ${label ?? "value"}`}
          >
            <Minus className="h-3 w-3" />
          </Button>
          <div className="h-9 flex-1 min-w-[48px] rounded-[6px] border border-border flex items-center justify-center text-sm tabular-nums">
            {value}
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-[26px] w-[28px] rounded-[6px]"
            onClick={inc}
            disabled={max !== undefined && value >= max}
            aria-label={`Increase ${label ?? "value"}`}
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      </div>
    );
  }
  ```
- [ ] **Step 2:** Import and render it once in a scratch spot (e.g. temporarily in `Layout.tsx`) to visually confirm sizing matches the design's `36px input / 26×28px buttons / hairline borders`, then remove the scratch usage.
- [ ] **Step 3:** Commit: `git add artifacts/admin-dashboard/src/components/ui/stepper.tsx && git commit -m "feat(ui): add Stepper primitive for onboarding wizard"`.

#### Task 4: Wizard shell + `FacilityGate` routing integration

**Files:**
- Create: `artifacts/admin-dashboard/src/pages/onboarding/Wizard.tsx`
- Create: `artifacts/admin-dashboard/src/pages/onboarding/components/StepIndicator.tsx`
- Create: `artifacts/admin-dashboard/src/pages/onboarding/components/ResumeBanner.tsx`
- Modify: `artifacts/admin-dashboard/src/App.tsx` (`AuthGate`/`FacilityGate` per §2.3)
- Modify: `lib/api-spec/openapi.yaml` (add `GET /facilities/me` if not already added in Task 2 — confirm before duplicating)
- Test: manual (sign in with a fresh Supabase user with no facility row → expect the wizard shell, not the dashboard)

**Interfaces:**
- Consumes: `useGetMyFacility()` (generated from Task 2's `GET /facilities/me`), `useGetWizardProgress()`/`usePutWizardProgress()` (Task 2.5 below — add these two paths to `openapi.yaml` in this task since they weren't in Phase A's endpoint list scope; see §2.2 table).
- Produces: `<Wizard />` component consumed by `App.tsx`'s `FacilityGate`.

- [ ] **Step 1:** Add `GET /wizard/progress` and `PUT /wizard/progress` to `openapi.yaml` per §2.2's table (`wizard_progress` row shape: `{ currentStep, stepData }`); regenerate (`pnpm run codegen` + `typecheck:libs`).
- [ ] **Step 2:** Implement `Wizard.tsx` as an internal-state stepper (not wouter routes):
  ```tsx
  // pages/onboarding/Wizard.tsx
  import { useState } from "react";
  import { useGetWizardProgress } from "@workspace/api-client-react";
  import { FarmBasics } from "./steps/FarmBasics";
  import { LayoutGrid } from "./steps/LayoutGrid";
  import { VendorAccounts } from "./steps/sensors/VendorAccounts";
  import { DeviceRegistry } from "./steps/sensors/DeviceRegistry";
  import { SensorReview } from "./steps/sensors/SensorReview";
  import { Done } from "./steps/Done";
  import { StepIndicator } from "./components/StepIndicator";
  import { ResumeBanner } from "./components/ResumeBanner";

  const STEP_ORDER = ["farm_basics", "layout", "sensors_accounts", "sensors_devices", "sensors_review", "done"] as const;
  type WizardStep = (typeof STEP_ORDER)[number];

  export function Wizard() {
    const { data: progress, isLoading } = useGetWizardProgress();
    const [step, setStep] = useState<WizardStep>("farm_basics");
    const [resumed, setResumed] = useState(false);

    if (isLoading) return null; // AuthGate's LoadingScreen already covers the outer shell
    if (progress?.currentStep && !resumed) {
      setStep(progress.currentStep as WizardStep);
      setResumed(true);
    }

    const advance = () => {
      const idx = STEP_ORDER.indexOf(step);
      if (idx < STEP_ORDER.length - 1) setStep(STEP_ORDER[idx + 1]);
    };

    return (
      <div className="min-h-[100dvh] bg-background">
        <header className="h-16 bg-white border-b border-border flex items-center px-6 justify-between">
          <img src="/logo-lockup.svg" alt="FarmSmart" className="h-[26px] w-auto" />
          {step === "farm_basics" ? (
            <StepIndicator current={step} />
          ) : (
            <span className="text-sm text-muted-foreground">
              Step {STEP_ORDER.indexOf(step) + 1} of {STEP_ORDER.length - 2}
            </span>
          )}
        </header>
        {progress?.currentStep && resumed && <ResumeBanner />}
        {step === "farm_basics" && <FarmBasics onSaved={advance} />}
        {step === "layout" && <LayoutGrid onSaved={advance} />}
        {step === "sensors_accounts" && <VendorAccounts onSaved={advance} onSkipAll={() => setStep("done")} />}
        {step === "sensors_devices" && <DeviceRegistry onSaved={advance} />}
        {step === "sensors_review" && <SensorReview onFinish={advance} />}
        {step === "done" && <Done />}
      </div>
    );
  }
  ```
  (Step components stubbed in this task with a minimal placeholder-free skeleton — a title + a "Continue" button that calls `onSaved()` with no fields yet; Tasks 5-14 fill in each step's real form.)
- [ ] **Step 3:** Implement `StepIndicator.tsx` per README's exact spec (24px numbered circles, brand-green active fill, 56px hairline connectors, labels "Farm basics · Layout · Sensors · Done").
- [ ] **Step 4:** Implement `ResumeBanner.tsx` ("Picking up where you left off", dismissable-on-advance only, no close button).
- [ ] **Step 5:** Patch `App.tsx` per §2.3's `FacilityGate` code exactly, importing `Wizard` from `pages/onboarding/Wizard`.
- [ ] **Step 6:** Manual test: create a fresh Supabase test user (no `usersTable.organizationId`), sign in, confirm the wizard shell renders (not the dashboard `Overview`); sign in as an existing user with a facility, confirm the dashboard renders unchanged.
- [ ] **Step 7:** Commit: `git add -A && git commit -m "feat(onboarding): wizard shell, step indicator, resume banner, facility gate"`.

#### Task 5: W2 — Farm basics step — WIZ-002, TEN-005

**Files:**
- Create: `artifacts/admin-dashboard/src/pages/onboarding/steps/FarmBasics.tsx`
- Modify: `artifacts/admin-dashboard/src/pages/onboarding/Wizard.tsx` (wire real props instead of Task 4's skeleton)

**Interfaces:**
- Consumes: `useCreateFacility()` (generated from Task 2's `POST /facilities`), `Stepper`? (not needed here — W2 has no numeric steppers, just fields), `components/ui/{input,label,select,toggle-group,button,form}`.
- Produces: `<FarmBasics onSaved={() => void} />`.

- [ ] **Step 1:** Write the zod schema + form, following `Inventory.tsx`'s exact pattern:
  ```tsx
  // pages/onboarding/steps/FarmBasics.tsx
  import { z } from "zod";
  import { useForm } from "react-hook-form";
  import { zodResolver } from "@hookform/resolvers/zod";
  import { useCreateFacility } from "@workspace/api-client-react";
  import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
  import { Input } from "@/components/ui/input";
  import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
  import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
  import { Button } from "@/components/ui/button";
  import { Card } from "@/components/ui/card";

  const farmBasicsSchema = z.object({
    farmName: z.string().min(1, "Farm name is required"),
    facilityName: z.string().optional(),
    timezone: z.string().min(1),
    units: z.enum(["metric", "imperial"]),
    currency: z.string().length(3),
  });
  type FarmBasicsValues = z.infer<typeof farmBasicsSchema>;

  export function FarmBasics({ onSaved }: { onSaved: () => void }) {
    const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const createFacility = useCreateFacility();

    const form = useForm<FarmBasicsValues>({
      resolver: zodResolver(farmBasicsSchema),
      defaultValues: { farmName: "", facilityName: "", timezone: detectedTz, units: "metric", currency: "USD" },
    });

    const onSubmit = (values: FarmBasicsValues) => {
      createFacility.mutate(
        { data: { ...values, facilityName: values.facilityName || values.farmName } },
        { onSuccess: onSaved },
      );
    };

    return (
      <div className="flex justify-center pt-12">
        <Card className="w-[560px] p-8">
          <h1 className="text-2xl font-bold">Tell us about your farm</h1>
          <p className="text-sm text-muted-foreground mt-1">
            This creates your facility. Everything is editable later in Settings.
          </p>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5 mt-6">
              <FormField
                control={form.control}
                name="farmName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Farm name</FormLabel>
                    <FormControl><Input {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="facilityName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Facility name</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={form.watch("farmName") || undefined} />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">Defaults to your farm name</p>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="timezone"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center gap-2">
                      <FormLabel>Timezone</FormLabel>
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[hsl(142_40%_96%)] border border-[hsl(142_30%_88%)] text-primary">
                        Auto-detected
                      </span>
                    </div>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value={detectedTz}>{detectedTz}</SelectItem>
                        {/* full IANA list sourced from an existing timezone constant if one exists in the
                            codebase already (check artifacts/farmeasy for a shared list before adding a new one) */}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="units"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>Units</FormLabel>
                      <ToggleGroup type="single" value={field.value} onValueChange={(v) => v && field.onChange(v)}>
                        <ToggleGroupItem value="metric">Metric</ToggleGroupItem>
                        <ToggleGroupItem value="imperial">Imperial</ToggleGroupItem>
                      </ToggleGroup>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>Currency</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="USD">USD</SelectItem>
                          <SelectItem value="CAD">CAD</SelectItem>
                          <SelectItem value="EUR">EUR</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={createFacility.isPending}>
                  {createFacility.isPending ? "Creating…" : "Continue →"}
                </Button>
              </div>
            </form>
          </Form>
        </Card>
      </div>
    );
  }
  ```
- [ ] **Step 2:** Wire it into `Wizard.tsx` (replace Task 4's skeleton `farm_basics` branch with `<FarmBasics onSaved={advance} />`).
- [ ] **Step 3:** Manual test: fresh user → wizard → fill form → submit → confirm `GET /facilities/me` now returns the created facility and `POST /facilities` called exactly once (check network tab / server logs for a single insert, not a double-submit).
- [ ] **Step 4:** Commit: `git add -A && git commit -m "feat(onboarding): W2 farm basics step"`.

#### Task 6: W3 — Layout grid step (zone cards + live schematic + label preview) — WIZ-003, LAY-004

**Files:**
- Create: `artifacts/admin-dashboard/src/pages/onboarding/steps/LayoutGrid.tsx`
- Create: `artifacts/admin-dashboard/src/pages/onboarding/steps/layout/ZoneCard.tsx`
- Create: `artifacts/admin-dashboard/src/pages/onboarding/steps/layout/LiveSchematic.tsx`
- Create: `artifacts/admin-dashboard/src/pages/onboarding/steps/layout/LabelPreviewStrip.tsx`

**Interfaces:**
- Consumes: `Stepper` (Task 3), `useCreateChannel`/`useCreateRack`/`useCreateTray` (existing, generated from `POST /layout/{channels,racks,trays}` — reused verbatim, no new endpoints).
- Produces: `<LayoutGrid onSaved={() => void} />`.

- [ ] **Step 1:** `ZoneCard.tsx` — one per room (`seeding`/`fertigation`/`harvesting`), holds 3 `Stepper`s (`channels`, `racksPerChannel`, `levelsPerRack`) in local state, collapsed summary line when not expanded:
  ```tsx
  // pages/onboarding/steps/layout/ZoneCard.tsx
  import { useState } from "react";
  import { Card } from "@/components/ui/card";
  import { Stepper } from "@/components/ui/stepper";

  export interface ZoneState { channels: number; racksPerChannel: number; levelsPerRack: number; }

  export function ZoneCard({
    zoneLabel, state, onChange, expanded, onToggleExpanded,
  }: {
    zoneLabel: string; state: ZoneState; onChange: (s: ZoneState) => void;
    expanded: boolean; onToggleExpanded: () => void;
  }) {
    return (
      <Card className="p-4">
        <button type="button" onClick={onToggleExpanded} className="w-full text-left font-semibold text-sm">
          {zoneLabel}
        </button>
        {expanded ? (
          <div className="mt-3 space-y-3">
            <Stepper label="Channels" value={state.channels} min={0}
              onChange={(v) => onChange({ ...state, channels: v })} />
            <Stepper label="Racks / channel" value={state.racksPerChannel} min={0}
              onChange={(v) => onChange({ ...state, racksPerChannel: v })} />
            <Stepper label="Levels / rack" value={state.levelsPerRack} min={0}
              onChange={(v) => onChange({ ...state, levelsPerRack: v })} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground mt-1">
            {state.channels} ch · {state.racksPerChannel} racks · {state.levelsPerRack} levels
          </p>
        )}
      </Card>
    );
  }
  ```
- [ ] **Step 2:** `LiveSchematic.tsx` — pure render of `{ channels, racksPerChannel, levelsPerRack }` into the grid-of-bars per README's exact spec (one column per channel, one 20px bar per level, light-green fill, one bar highlighted solid green with a caption).
- [ ] **Step 3:** `LabelPreviewStrip.tsx` — renders the recessed strip with the mono `S1-C2-S4` chip per LAY-004's scheme `{stage initial}{room index}-C{channel}-S{shelf}` (Phase 1 room index is always `1`).
- [ ] **Step 4:** `LayoutGrid.tsx` composes all three, holds `{ zoneStates: Record<RoomName, ZoneState> }`, validates `channels >= 1` per zone inline (status-critical color, primary button disabled while invalid — reuse existing `<FormMessage>`-style error text), and on "Create layout →" fires the *existing* `POST /layout/channels|racks|trays` endpoints in a loop (channels first, then racks per channel, then trays per rack) — no new backend endpoint needed here, this task is pure frontend composition over already-shipped API.
- [ ] **Step 5:** Wire into `Wizard.tsx`.
- [ ] **Step 6:** Manual test: enter 6/2/4 for Seeding, confirm the schematic shows 6 columns × 8 bars (2 racks × 4 levels = 8 per channel), confirm label preview shows `S1-C1-S1` style chip, submit, confirm `GET /layout` (existing endpoint) now reflects the created hierarchy.
- [ ] **Step 7:** Commit: `git add -A && git commit -m "feat(onboarding): W3 layout grid step with live schematic"`.

---

### Phase C — W3.5 Sensor registry

#### Task 7: `POST /sensor-accounts` + `GET /sensor-accounts` + test-connection endpoint

**Files:**
- Create: `artifacts/api-server/src/routes/sensor-accounts.ts`
- Modify: `artifacts/api-server/src/app.ts` (mount)
- Modify: `lib/api-spec/openapi.yaml`
- Test: `artifacts/api-server/src/tests/routes/sensor-accounts.test.ts`

**Interfaces:**
- Consumes: `sensorAccountsTable` (Task 1), `encryptToken`/`decryptToken` (`lib/accounting/crypto.ts`, reused verbatim), `createAuthenticatedTestApp`/`requireTestDatabaseUrl`/`useDatabaseFixture` (Release 1 Task 4 harness).
- Produces: `useCreateSensorAccount`, `useListSensorAccounts`, `useTestSensorAccountConnection`.
- Consider (per the newly-established `/recommend` rate-limit precedent, Release 1 Task 9): a light per-user rate limit on `POST /sensor-accounts/:id/test-connection`, since it will eventually call real third-party vendor APIs and an unbounded client could hammer a vendor or rack up cost once real adapters exist. Not required for Phase 1 (every vendor is `pending_integration` today — see Step 6), but wire the same `express-rate-limit` + `getAuth(req).userId` keying pattern now so it's a one-line change when a real adapter ships, not a forgotten follow-up.

- [ ] **Step 1:** Write the failing test asserting a created account's response body **never contains** `credentialCiphertext` or the plaintext credential (SEN-002 hard rule), following `inventory.test.ts`'s real harness shape:
  ```ts
  // artifacts/api-server/src/tests/routes/sensor-accounts.test.ts
  import { describe, test } from "node:test";
  import { strictEqual, ok, doesNotMatch } from "node:assert";
  import request from "supertest";
  import { createAuthenticatedTestApp } from "../helpers/testApp";
  import { requireTestDatabaseUrl, useDatabaseFixture } from "../helpers/testDatabase";

  const dbUrl = requireTestDatabaseUrl();

  describe("POST /api/sensor-accounts", { skip: !dbUrl }, () => {
    const fixture = useDatabaseFixture(["sensor_accounts"]);

    async function setup() {
      const sensorAccounts = await import("../../routes/sensor-accounts");
      return { app: createAuthenticatedTestApp(sensorAccounts.default) };
    }

    test("never returns the plaintext or ciphertext credential", async () => {
      const { app } = await setup();
      const res = await request(app)
        .post("/api/sensor-accounts")
        .send({ vendor: "Trolmaster", authMethod: "api_key", credential: "sk_live_abcdef1234" });

      strictEqual(res.status, 201);
      strictEqual(res.body.maskedFingerprint, "····1234");
      doesNotMatch(JSON.stringify(res.body), /sk_live_abcdef1234/);
      strictEqual(res.body.credentialCiphertext, undefined);
    });
  });
  ```
- [ ] **Step 2:** Run `TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/routes/sensor-accounts.test.ts` — confirm FAIL (`Cannot find module '../../routes/sensor-accounts'`).
- [ ] **Step 3:** Implement `routes/sensor-accounts.ts` per §2.2's exact code (`export default router`, matching the codebase's route-file convention).
- [ ] **Step 4:** Add OpenAPI paths + regenerate.
- [ ] **Step 5:** Run the same test command again, confirm PASS.
- [ ] **Step 6:** Implement `POST /sensor-accounts/:id/test-connection` with an explicit vendor allowlist (empty allowlist at launch is fine — every vendor falls through to `pending_integration` with honest copy until a real adapter ships; this satisfies SEN-003's "never fake success" without requiring any real vendor integration to exist yet).
- [ ] **Step 7:** Commit: `git add -A && git commit -m "feat(api): sensor-accounts CRUD + test-connection, credentials never returned"`.

#### Task 8: `POST /sensors/bulk`

**Files:**
- Modify: `artifacts/api-server/src/routes/sensors.ts` (add the bulk route alongside the existing single-create route)
- Modify: `lib/api-spec/openapi.yaml`
- Test: `artifacts/api-server/src/tests/routes/sensors-bulk.test.ts`

**Interfaces:**
- Consumes: `sensorsTable` (Task 1, with `roomId`/`facilityWide`/`sensorAccountId`), the real test harness (Release 1 Task 4).
- Produces: `useBulkCreateSensors`.

- [ ] **Step 1:** Write the failing test, seeding real `facilities`/`rooms`/`channels` rows first since `channelIds` is FK-constrained (matches how `inventory.test.ts` seeds a row before asserting against it, rather than referencing arbitrary IDs):
  ```ts
  // artifacts/api-server/src/tests/routes/sensors-bulk.test.ts
  import { describe, test } from "node:test";
  import { strictEqual, deepStrictEqual } from "node:assert";
  import request from "supertest";
  import { createAuthenticatedTestApp } from "../helpers/testApp";
  import { requireTestDatabaseUrl, useDatabaseFixture } from "../helpers/testDatabase";

  const dbUrl = requireTestDatabaseUrl();

  describe("POST /api/sensors/bulk", { skip: !dbUrl }, () => {
    const fixture = useDatabaseFixture(["sensors", "channels", "rooms", "facilities", "organizations"]);

    async function setup() {
      const sensors = await import("../../routes/sensors");
      const { db, organizationsTable, facilitiesTable, roomsTable, channelsTable } = await import("@workspace/db");
      const [org] = await db.insert(organizationsTable).values({ name: "Test Org" }).returning();
      const [facility] = await db.insert(facilitiesTable).values({
        name: "Test Farm", organizationId: org.id, facilityName: "Test Farm",
        timezone: "UTC", units: "metric", currency: "USD",
      }).returning();
      const [room] = await db.insert(roomsTable).values({ name: "seeding", facilityId: facility.id }).returning();
      const channels = await db.insert(channelsTable).values([
        { roomId: room.id, label: "C1" }, { roomId: room.id, label: "C2" }, { roomId: room.id, label: "C3" },
      ]).returning();
      return { app: createAuthenticatedTestApp(sensors.default), channelIds: channels.map((c) => c.id) };
    }

    test("creates one row per (type × channel) combination", async () => {
      const { app, channelIds } = await setup();
      const res = await request(app)
        .post("/api/sensors/bulk")
        .send({ label: "pH/EC probe", types: ["ph", "ec"], channelIds });

      strictEqual(res.status, 201);
      strictEqual(res.body.created.length, 6); // 2 types × 3 channels
      deepStrictEqual(new Set(res.body.created.map((s: { label: string }) => s.label)), new Set(["pH/EC probe"]));
    });
  });
  ```
- [ ] **Step 2:** Run `TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/routes/sensors-bulk.test.ts` — confirm FAIL.
- [ ] **Step 3:** Implement the handler per §2.2.
- [ ] **Step 4:** Add OpenAPI path + regenerate.
- [ ] **Step 5:** Run the same test command again, confirm PASS.
- [ ] **Step 6:** Commit: `git add -A && git commit -m "feat(api): bulk sensor creation for onboarding device registry"`.

#### Task 9: W3.5a — Vendor accounts step

**Files:**
- Create: `artifacts/admin-dashboard/src/pages/onboarding/steps/sensors/VendorAccounts.tsx`

**Interfaces:**
- Consumes: `useListSensorAccounts`, `useCreateSensorAccount`, `useTestSensorAccountConnection` (Task 7), `ToggleGroup` (auth-method pill selector).
- Produces: `<VendorAccounts onSaved={() => void} onSkipAll={() => void} />`.

- [ ] **Step 1:** Implement the account-list card (rows with status pill: `Connected` = `bg-[hsl(142_45%_32%)]`, `Pending integration` = `bg-[hsl(38_85%_42%)]`, both white 12px/500 text, 999px radius) + inline add-account form (vendor select, auth-method `ToggleGroup`, api-key `Input` with the exact helper copy "Stored write-only. After saving you'll see a masked fingerprint — never the key itself.", outline "Test connection" button calling `useTestSensorAccountConnection`).
- [ ] **Step 2:** Footer: text link "No vendor cloud — all my sensors are local" (calls `onSkipAll`, which the `Wizard.tsx` skeleton already routes straight to `"done"` per Task 4) + primary "Next: devices →" (calls `onSaved`).
- [ ] **Step 3:** Username/password auth-method selection shows the API-key-preference notice before accepting (WIZ-004) — a small inline `<p>` that appears when `authMethod === "username_password"` is selected, no dialog/confirm needed, just always-visible copy while that option is active.
- [ ] **Step 4:** Manual test: add a vendor account, confirm masked fingerprint renders, confirm "Test connection" against an unregistered vendor name shows "Pending integration" (never a fake green success).
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(onboarding): W3.5a vendor accounts step"`.

#### Task 10: W3.5b — Devices & placement step

**Files:**
- Create: `artifacts/admin-dashboard/src/pages/onboarding/steps/sensors/DeviceRegistry.tsx`
- Create: `artifacts/admin-dashboard/src/pages/onboarding/steps/sensors/PlacementLadder.tsx`

**Interfaces:**
- Consumes: `useBulkCreateSensors` (Task 8), `useGetLayout` (existing, to populate room/channel/rack pickers), `ToggleGroup`.
- Produces: `<DeviceRegistry onSaved={() => void} />`.

- [ ] **Step 1:** `PlacementLadder.tsx` — the 4-rung segmented control (Whole facility / Room / Channel / Rack-shelf) with type-driven default selection logic exactly as spec'd: `temp|humidity|co2|light → Room`, `ph|ec → Channel`, `water_level → Channel` (or Rack); combo probes default to the deepest rung among their selected types. Renders the green info-panel explanation copy when a non-obvious default was applied.
- [ ] **Step 2:** `DeviceRegistry.tsx` — add-device row (label input, measures multi-select `ToggleGroup type="multiple"`, account select incl. "Local (none)" using accounts from Task 9's `useListSensorAccounts`), progressive depth fields (room select always required; channel multi-select toggle chips with "Select all"; rack chip row added the same way when the rung is Rack-shelf), footer live summary ("N channels selected → N devices, named by channel") and primary button whose label includes the live count ("Add 3 devices"), calling `useBulkCreateSensors`.
- [ ] **Step 3:** Below the card: running-tally strip listing devices added so far this session (client-side accumulator of successful `useBulkCreateSensors` responses, not a new read endpoint).
- [ ] **Step 4:** Manual test: add a pH/EC combo probe on 3 channels, confirm the summary says "3 channels selected → 3 devices" (not 6 — the count is placement targets, per README's literal wording, while the actual row count created server-side is 6 per Task 8's device-model decision; this is a deliberate UI-vs-storage distinction, note it in a one-line code comment so a future reader isn't confused by the mismatch).
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(onboarding): W3.5b device registry + placement ladder"`.

#### Task 11: W3.5c — Review step — SEN-004

**Files:**
- Create: `artifacts/admin-dashboard/src/pages/onboarding/steps/sensors/SensorReview.tsx`

**Interfaces:**
- Consumes: the running-tally accumulated in Task 10 (passed down or refetched via a `GET /sensors?createdInSession=...` — simplest: pass the accumulated list as props from `Wizard.tsx` state rather than adding a new filtered read endpoint).
- Produces: `<SensorReview onFinish={() => void} />`.

- [ ] **Step 1:** Group the accumulated device list by `label`, collapsing same-label rows into "pH/EC probe × 3" with an "Edit ▾" expander to per-row detail, per placement-chip rules (types = neutral chip, account = neutral chip, placement = green-tinted chip always showing the full path e.g. "Fertigation · Ch 1, 2, 4").
- [ ] **Step 2:** Title renders the truthful literal count "4 devices, 2 accounts" (computed from the same accumulated list + Task 9's accounts list — never hard-coded).
- [ ] **Step 3:** **Hard rule enforcement:** no chart/tile/reading-placeholder anywhere on this screen — sub-copy is exactly "Registered — data collection starts when polling launches. No charts until then." (WIZ-004 AC 4) — this is a copy-correctness check, verify by reading the rendered JSX contains no `<Chart>`/`<Sparkline>`/numeric-reading component import.
- [ ] **Step 4:** "+ Add more devices" link routes back to `sensors_devices` step (not a URL route — local `Wizard.tsx` state transition); footer "← Back" / "Finish setup →" (calls `onFinish`, which fires `PUT /wizard/progress { currentStep: "done" }`).
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(onboarding): W3.5c sensor review step"`.

---

### Phase D — W4 Done + Dashboard Farm Readiness checklist

#### Task 12: `GET /facility-readiness` + `POST /facility-readiness/events`

**Files:**
- Create: `artifacts/api-server/src/routes/facility-readiness.ts`
- Modify: `artifacts/api-server/src/app.ts`
- Modify: `lib/api-spec/openapi.yaml`
- Test: `artifacts/api-server/src/tests/routes/facility-readiness.test.ts`

**Interfaces:**
- Consumes: `facilityReadinessEventsTable` (Task 1), existing `sensorsTable`/`cyclesTable`/`accountingConnectionsTable` reads (to derive items 4/5/6 truthfully rather than from stored events where a live count is more honest), the real test harness (Release 1 Task 4).
- Produces: `useGetFacilityReadiness`, `usePostFacilityReadinessEvent`.

- [ ] **Step 1:** Write the failing test asserting `completedCount` always equals the count of `state === "done"` items (the truthfulness rule, CHK-001..003) — this is the single most important invariant in this whole feature:
  ```ts
  // artifacts/api-server/src/tests/routes/facility-readiness.test.ts
  import { describe, test } from "node:test";
  import { strictEqual } from "node:assert";
  import request from "supertest";
  import { createAuthenticatedTestApp } from "../helpers/testApp";
  import { requireTestDatabaseUrl, useDatabaseFixture } from "../helpers/testDatabase";

  const dbUrl = requireTestDatabaseUrl();

  describe("GET /api/facility-readiness", { skip: !dbUrl }, () => {
    const fixture = useDatabaseFixture(["facility_readiness_events", "facilities", "organizations"]);

    async function setup() {
      const facilityReadiness = await import("../../routes/facility-readiness");
      return { app: createAuthenticatedTestApp(facilityReadiness.default) };
    }

    test("completedCount always equals the number of done items", async () => {
      const { app } = await setup();
      const res = await request(app).get("/api/facility-readiness");
      const doneCount = res.body.items.filter((i: { state: string }) => i.state === "done").length;
      strictEqual(res.body.completedCount, doneCount);
    });

    test("item 1 (labels) is never done from a page visit — only from a labels_scanned event", async () => {
      const { app } = await setup();

      const res1 = await request(app).get("/api/facility-readiness");
      strictEqual(res1.body.items.find((i: { key: string }) => i.key === "labels_downloaded").state, "pending");

      await request(app).post("/api/facility-readiness/events").send({ eventKey: "labels_downloaded" });
      const res2 = await request(app).get("/api/facility-readiness");
      strictEqual(res2.body.items.find((i: { key: string }) => i.key === "labels_downloaded").state, "interim"); // NOT done

      await request(app).post("/api/facility-readiness/events").send({ eventKey: "labels_scanned" });
      const res3 = await request(app).get("/api/facility-readiness");
      strictEqual(res3.body.items.find((i: { key: string }) => i.key === "labels_downloaded").state, "done");
    });
  });
  ```
- [ ] **Step 2:** Run `TEST_DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @workspace/api-server exec node --import tsx/esm --test src/tests/routes/facility-readiness.test.ts` — confirm FAIL.
- [ ] **Step 3:** Implement the handler: `GET` reads `facilityReadinessEventsTable` rows for the user's facility, cross-references live counts (sensors count for item 5, `accounting_connections` existence for item 6, `cyclesTable` first-row-exists for item 4) to compute each item's `state`, and asserts the `completedCount === done.length` invariant in code (throw an internal error in dev/test if they ever diverge, rather than silently shipping a wrong number).
- [ ] **Step 4:** `POST /facility-readiness/events` inserts or (if `undo: true`) sets `undoneAt` on the matching row.
- [ ] **Step 5:** Add OpenAPI paths + regenerate.
- [ ] **Step 6:** Run the same test command again, confirm PASS.
- [ ] **Step 7:** Commit: `git add -A && git commit -m "feat(api): facility-readiness computed checklist state, truthfulness-invariant enforced"`.

#### Task 13: W4 — Done screen — WIZ-005 (render order below is exact/mandatory), HND-002

**Files:**
- Create: `artifacts/admin-dashboard/src/pages/onboarding/steps/Done.tsx`
- Create: `artifacts/admin-dashboard/src/pages/onboarding/steps/done/QuickBooksCard.tsx`
- Create: `artifacts/admin-dashboard/src/pages/onboarding/steps/done/MobileHandoffCard.tsx`

**Interfaces:**
- Consumes: `useGetFacilityReadiness` (Task 12), `useGetAccountingConnectUri` (existing, reused verbatim from `Accounting.tsx`'s `handleConnect`), a QR-code component (reuse whatever library `Layout.tsx`'s existing QR rendering already uses — confirm the exact import before adding a new dependency).
- Produces: `<Done />` (terminal step, renders "Go to dashboard →" which is a full navigation, e.g. `window.location.href = "/"` or a wouter `navigate` if the wizard is ever mounted inside the router — since it currently isn't (§2.3), use a hard `window.location.assign("/")` to force `App.tsx`'s `FacilityGate` to re-evaluate and now find a facility).

- [ ] **Step 1:** Header: 36px green check disc + `"{facility.name} is set up"` + sub "Four things left before your first cycle — most happen on your phone."
- [ ] **Step 2:** Render `FarmReadinessCard` (Task 14, shared component) in its "preview" mode — same component the dashboard uses, confirming visual consistency between W4 and the post-wizard dashboard per README's explicit reuse.
- [ ] **Step 3:** `QuickBooksCard.tsx` — title/sub + "Skip" text link (calls `usePostFacilityReadinessEvent({ eventKey: "quickbooks_skipped" })`) + primary "Connect" (calls the existing `useGetAccountingConnectUri` then `window.location.href = authorizeUri`, verbatim from `Accounting.tsx`).
- [ ] **Step 4:** `MobileHandoffCard.tsx` — 88px QR encoding a real authenticated deep link (format: confirm the mobile app's existing deep-link scheme in `artifacts/farmeasy/app.json`'s `scheme` field before inventing a new URL shape; the QR payload must resolve to "authenticated user lands in the correct org" per README, which likely means encoding a short-lived magic-link/deep-link token minted by a small new endpoint — if no such token endpoint exists, add `GET /facilities/me/mobile-handoff-token` returning a signed short-TTL token, flagged here as a **possible extra ticket** discovered during implementation if `farmeasy`'s existing auth deep-link scheme doesn't already support this).
- [ ] **Step 5:** Footer "Go to dashboard →" per Interfaces above.
- [ ] **Step 6:** Commit: `git add -A && git commit -m "feat(onboarding): W4 done screen with readiness preview, QuickBooks card, mobile handoff QR"`.

#### Task 14: `FarmReadinessCard` — shared dashboard + wizard component — CHK-001/002/003

**Files:**
- Create: `artifacts/admin-dashboard/src/components/dashboard/FarmReadinessCard.tsx`
- Create: `artifacts/admin-dashboard/src/hooks/use-farm-readiness-collapsed.ts`
- Modify: `artifacts/admin-dashboard/src/pages/overview/Overview.tsx` (render above `<DraggableMetricGrid>`, **not** inside it — per Audit finding)

**Interfaces:**
- Consumes: `useGetFacilityReadiness` (Task 12), `useGetUserSettings`/`usePutUserSetting` (existing, for collapse state).
- Produces: `<FarmReadinessCard mode="dashboard" | "preview" />`.

- [ ] **Step 1:** `use-farm-readiness-collapsed.ts` — copy `use-metric-selection.ts`'s exact hydrate/localStorage-fallback/server-persist pattern, but for a single boolean under settings key `"farmsmart.farmReadiness.collapsed"`:
  ```ts
  // hooks/use-farm-readiness-collapsed.ts
  import { useEffect, useState } from "react";
  import { useSupabaseSession } from "@/hooks/use-supabase-session";
  import { useGetUserSettings, usePutUserSetting } from "@workspace/api-client-react";

  const SETTINGS_KEY = "farmsmart.farmReadiness.collapsed";

  export function useFarmReadinessCollapsed() {
    const { session, loading } = useSupabaseSession();
    const uid = session?.user.id ?? "anon";
    const storageKey = `farmsmart.farmReadiness.collapsed.${uid}`;
    const [collapsed, setCollapsed] = useState(() => localStorage.getItem(storageKey) === "true");
    const { data: remote, isSuccess } = useGetUserSettings({ query: { enabled: !loading && !!session } });
    const putSetting = usePutUserSetting();

    useEffect(() => {
      if (isSuccess && remote?.[SETTINGS_KEY] !== undefined) {
        setCollapsed(Boolean(remote[SETTINGS_KEY]));
      }
    }, [isSuccess, remote]);

    const toggle = () => {
      const next = !collapsed;
      setCollapsed(next);
      localStorage.setItem(storageKey, String(next));
      putSetting.mutate({ key: SETTINGS_KEY, data: { value: next } });
    };

    return { collapsed, toggle };
  }
  ```
- [ ] **Step 2:** `FarmReadinessCard.tsx` — header row (title, 140px `Progress` bar from `components/ui/progress.tsx`, "N of 7", "Collapse ⌄"/pill-collapsed state per CHK-003), 2-column item grid, item-specific state rendering (item 1's amber-ring interim state with inline amber text; item 5's "skipped — undo from Sensors" with an undo action calling `usePostFacilityReadinessEvent({ eventKey: "sensors_skipped", undo: true })`), deep links per item (item 3, per CHK-002, opens the existing Inventory "Add Item" modal with category pre-set — pass a query param or a shared modal-open context, whichever existing pattern `Inventory.tsx` already exposes for pre-filling the Add Item dialog; if none exists, add a `?openAddItem=Seeds` search-param check in `Inventory.tsx` as a small addition, not a new modal system), collapse behavior via Step 1's hook, retire rule (items 1-4 all `done` → render nothing / return `null`, migrate items 5-7 to a small new section in `Settings.tsx`).
- [ ] **Step 3:** In `Overview.tsx`, insert `<FarmReadinessCard mode="dashboard" />` directly after the `<h1>Overview</h1>` header row and before `<DraggableMetricGrid>` — confirmed placement per Audit finding that this is explicitly *not* a `lib/metrics` entry.
- [ ] **Step 4:** Manual test: toggle collapse, reload the page, confirm state persisted (server round-trip, not just localStorage); complete items 1-4 in test data, confirm the card disappears (`null` render) and items 5-7 appear in `Settings.tsx`.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(dashboard): Farm Readiness checklist card, shared between wizard preview and Overview"`.

---

### Phase E — Cross-cutting, telemetry, polish

#### Task 15: WIZ-006 telemetry

**Files:**
- Create: `artifacts/api-server/src/routes/wizard-events.ts`
- Modify: `lib/api-spec/openapi.yaml`
- Modify: `pages/onboarding/Wizard.tsx` (fire `view`/`save`/`abandon` events per step transition)

- [ ] **Step 1:** Implement `POST /wizard-events` per §2.2 — fire-and-forget, `202 Accepted`, no read endpoint needed yet (analysis happens via direct DB query until/unless a real analytics need emerges). Add the same per-user rate limit shape as `/recommend` (Release 1 Task 9: `express-rate-limit` keyed on `getAuth(req).userId`) at a generous ceiling (e.g. 120 requests/15min) — this endpoint is called on every step view/save, so it's a plausible accidental-loop target (a buggy `useEffect` dependency array firing on every render) even though it's not attacker-valuable.
- [ ] **Step 2:** In `Wizard.tsx`, fire a `"view"` event on every step mount (`useEffect` keyed on `step`), a `"save"` event in each step's `onSaved` callback, and an `"abandon"` event via a `visibilitychange`/`beforeunload` listener at the shell level (best-effort — don't block navigation on it).
- [ ] **Step 3:** Fire `"skip"` from W3.5a's `onSkipAll` path specifically (distinct from a normal `"save"`), so the "circuit breaker" rule (README: "if W3→W4 completion < 80%, W3.5 moves out of the wizard to checklist-only") has the data it needs, computed manually from this table until it's automated (automating the circuit breaker itself is out of scope for Phase 1 — flagged in Risks & Gaps).
- [ ] **Step 4:** Commit: `git add -A && git commit -m "feat(onboarding): WIZ-006 step telemetry"`.

#### Task 16: Settings page — migrated checklist items 5-7

**Files:**
- Modify: `artifacts/admin-dashboard/src/pages/settings/Settings.tsx`

- [ ] **Step 1:** Add a small "Setup" section rendering items 5 (Register sensors — with undo-skip action), 6 (Connect QuickBooks — reuses `QuickBooksCard` from Task 13), 7 (Invite your team) once items 1-4 are all done and the dashboard card has retired (Task 14's retire rule).
- [ ] **Step 2:** Commit: `git add -A && git commit -m "feat(settings): migrated readiness items after checklist retirement"`.

#### Task 17: Full-flow QA pass

- [ ] **Step 1:** Fresh Supabase test user end-to-end: sign up (mobile, since web has no sign-up per earlier UX audit) → sign in on web → wizard forces (no dashboard peek) → W2 → W3 (verify schematic math for at least 2 different channel/rack/level combos) → W3.5a (skip via "no vendor cloud" link) → confirm routes straight to W4 (skipping W3.5b/c) → W4 renders "1 of 7" (only sensors-related item open, since skip sets item 5 open per README) → "Go to dashboard" → dashboard shows the same card, not double-rendered.
- [ ] **Step 2:** Repeat with W3.5 fully completed (accounts + devices + review) instead of skipped — confirm device counts match between Review screen and the dashboard's sensor count.
- [ ] **Step 3:** Abandon mid-wizard (close tab after W2, before W3) → sign back in → confirm resume lands on W3 with the farm-basics data intact and the "Picking up where you left off" banner shown exactly once.
- [ ] **Step 4:** Attempt a deep link to `/inventory` while wizard-incomplete → confirm redirect back into the wizard, not a flash of dashboard content.
- [ ] **Step 5:** `pnpm run typecheck` (repo root) clean; `cd artifacts/api-server && pnpm run test` all green.

#### Task 18 (cross-repo, flag only — not implemented in this repo pass): mobile `labels_scanned` event

- Mobile app (`artifacts/farmeasy`) must `POST /facility-readiness/events { eventKey: "labels_scanned" }` on first successful shelf-level QR scan. This is the **only** trigger for checklist item 1's `done` state (CHK-001) — without this mobile-side change, item 1 will be permanently stuck at `"interim"`. File as a linked ticket in the mobile app's own tracker before this plan is considered fully shipped.

---

## Risks & Gaps (explicit, not silently deferred)

1. **TEN-004 full tenant isolation is NOT implemented by this plan.** Every route added here scopes by the signed-in user's `organizationId` at the point of insert/query, but no repo-wide scoped-query helper or RLS policy prevents a bug in some *other, unrelated* route from leaking cross-org data. Recommend a follow-up "tenant isolation hardening" plan once a second real organization exists in production and the blast radius of a leak becomes non-hypothetical.
2. **Device model is row-per-measure, not a first-class device entity** (see Global Constraints) — the wizard's UI-level "N devices" language does not match the DB's actual row count 1:1. If sensor management grows more complex (e.g. per-device firmware version, per-device alerts), revisit with a real `devices` parent table + `device_id` FK on `sensors`/`sensor_readings`.
3. **Mobile-side `labels_scanned` event (Task 18) lives in a different repo path** (`artifacts/farmeasy`) and is not implemented by this plan — checklist item 1 will not complete without it.
4. **W4's mobile-handoff QR deep-link token mechanism is unconfirmed** (Task 13, Step 4) — depends on what `artifacts/farmeasy`'s existing auth deep-link scheme already supports; may require one additional small endpoint discovered only during implementation.
5. **Circuit breaker automation (W3→W4 completion < 80% auto-demotes W3.5) is not automated** — Task 15 captures the raw telemetry needed to compute this manually; automating the threshold-triggered behavior change is future work.
6. **`sensor_accounts` "Test connection" has zero real vendor adapters at launch** (Task 7) — every vendor will show "Pending integration" until real per-vendor adapters are built under a proposed `lib/sensor-vendors/` — this is honest-by-design per SEN-003, not a bug, but worth setting expectations that "Connected" status won't appear for any real vendor on day one.
