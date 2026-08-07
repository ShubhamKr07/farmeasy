# TEN-010 rev. B — Team Invitations & Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship team invitations (tokenized, single-use, 14-day, revocable) with a Settings → Team dashboard surface, collapse the role model onto `organization_members.role` (owner/admin/technician) as the single source of truth, and enforce role access **server-side** (technician → 403 on web-only APIs).

**Architecture:** A new `invitations` table + `lib/email` mailer (Resend in prod, a recording transport in tests, Mailosaur for one real-delivery integration test) drives invite create/accept/revoke. `custom_access_token_hook` is repointed from the deprecated `public.users.role` to the active `organization_members.role`, so every client reads the correct role. A new `requireRole` middleware gates web-only routers on `req.tenant.role`; `cycles.ts`'s existing operational gates collapse from `isSupervisorOrLead` to `role !== 'technician'`.

**Tech Stack:** Express + Drizzle ORM + Postgres (Supabase) backend; `@supabase/supabase-js` service-role admin API for user creation; Resend for transactional email; React + Vite + wouter + shadcn/ui (`admin-dashboard`); Expo/React Native (`farmeasy`); orval-generated hooks from `lib/api-spec/openapi.yaml`; node:test + supertest, with `app.test.ts` exercising the real `app.ts` stack via genuine Supabase JWTs.

## Global Constraints

- pnpm only. `pnpm run typecheck` must pass before merge.
- **Server-side role enforcement is the control; UI hiding is never the control.** Every web-only API rejects a technician session with **403 and the stable error code `ROLE_FORBIDDEN`**, regardless of client.
- **Roles:** `organization_members.role` (`owner | admin | technician`) is the single source of truth. Invite roles offered are **`admin | technician` only** — never `owner`. Owner is creator-only, non-assignable, non-transferable, non-removable in v1.
- **Invite tokens:** 32 random bytes, base64url; stored **SHA-256 hashed** at rest; the raw token appears only in the invite link's URL **fragment** (`#token=...`), never in a query string, never logged. Single-use, 14-day expiry, revocable. Uniform safe failure on expired/revoked/reused (no token-state enumeration).
- **One organization per user** enforced at invite-create, at accept, and by the existing `organization_members_user_id_uniq` DB index.
- **Supabase's mailer never fires for invites** — acceptance creates the Supabase user via the admin API with `email_confirm: true` (no email sent); the Resend invite is the verification.
- **Operational-role gates collapse:** `cycles.ts` / mobile `cycles.tsx` gates that were `supervisor|facility_lead` become `role !== 'technician'` (owner/admin privileged, technician restricted).
- Migration bookkeeping: any new Drizzle migration bumps `supabase/tests/00001_foundation.sql`'s Drizzle count assertion; any new Supabase migration bumps its Supabase count assertion. Current baseline: Drizzle **29**, Supabase **13**.
- Run `scripts/ci/test-disposable-supabase.sh` locally (Docker) before opening a PR — the only path that replays the exact CI DB job (lesson from MT-M1/TEN-008). Note the no-DB `Node.js tests` CI job surfaces flakes local runs mask.

---

### Task 1: `invitations` table (schema + migration)

**Files:**
- Modify: `lib/db/src/schema/index.ts`
- Create: `lib/db/drizzle/0029_invitations.sql`
- Modify: `lib/db/drizzle/meta/_journal.json`
- Modify: `supabase/tests/00001_foundation.sql`

**Interfaces:**
- Produces: `invitationsTable`, `invitationStatusEnum` — consumed by Tasks 4-7.

- [ ] **Step 1: Add the enum + table to the schema**

In `lib/db/src/schema/index.ts`, after the `organizationMembersTable` block (near line 144), add:

```ts
export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);

// Team invitations (TEN-010). Token is 32 random bytes stored SHA-256-hashed;
// the raw token lives only in the invite link's URL fragment. One-org-per-user
// (organization_members_user_id_uniq) is the ultimate guard; invite-create and
// accept both check membership first. Invited role is admin|technician only —
// never owner (owner is creator-only, v1).
export const invitationsTable = pgTable(
  "invitations",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: orgMemberRoleEnum("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: invitationStatusEnum("status").notNull().default("pending"),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => usersTable.id),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at"),
  },
  (table) => [
    uniqueIndex("invitations_token_hash_uniq").on(table.tokenHash),
    index("invitations_organization_id_idx").on(table.organizationId),
    // At most one pending invite per (org, email) — re-inviting refreshes the
    // existing pending row rather than accumulating duplicates.
    uniqueIndex("invitations_org_email_pending_uniq")
      .on(table.organizationId, table.email)
      .where(sql`${table.status} = 'pending'`),
  ],
);
```

- [ ] **Step 2: Generate the migration**

Run: `cd lib/db && DATABASE_URL=$TEST_DATABASE_URL pnpm run db:generate --name invitations`
(Use a live `TEST_DATABASE_URL` from a running disposable instance; `drizzle-kit generate` only needs it to parse.)

- [ ] **Step 3: Verify the generated `0029_invitations.sql`**

Read `lib/db/drizzle/0029_invitations.sql`. It must create the `invitation_status` enum, the `invitations` table with the FK constraints, the unique index on `token_hash`, the org index, and the partial unique index on `(organization_id, email) WHERE status = 'pending'`. If drizzle-kit emitted any unrelated statement (snapshot drift, as happened in TEN-008 Task 1), remove it so the file contains only invitations DDL, and confirm the new `0029_snapshot.json` records the invitations table.

- [ ] **Step 4: Confirm the journal entry**

Confirm `lib/db/drizzle/meta/_journal.json` has a new `idx: 29`, `tag: "0029_invitations"` entry appended after `0028`.

- [ ] **Step 5: Bump the pgTAP Drizzle count**

In `supabase/tests/00001_foundation.sql`, change the Drizzle assertion `29` → `30` (value + message), and update the doc comment to cite `0029_invitations.sql` as the most recent addition.

- [ ] **Step 6: Apply + verify**

Run: `cd lib/db && DATABASE_URL=$TEST_DATABASE_URL pnpm run db:migrate`
Then: `psql "$TEST_DATABASE_URL" -c "\d invitations"` — confirm columns, FKs, both unique indexes.

- [ ] **Step 7: Commit**

```bash
git add lib/db/src/schema/index.ts lib/db/drizzle/0029_invitations.sql lib/db/drizzle/meta/ supabase/tests/00001_foundation.sql
git commit -m "feat(db): add invitations table (TEN-010)"
```

---

### Task 2: Invite-token utility

**Files:**
- Create: `artifacts/api-server/src/lib/inviteToken.ts`
- Test: `artifacts/api-server/src/lib/inviteToken.test.ts`

**Interfaces:**
- Produces: `generateInviteToken(): { raw: string; hash: string }`, `hashInviteToken(raw: string): string` — consumed by Tasks 5, 6.

- [ ] **Step 1: Write the failing test**

Create `artifacts/api-server/src/lib/inviteToken.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateInviteToken, hashInviteToken } from "./inviteToken.js";

describe("inviteToken", () => {
  it("generates a raw token and its matching hash", () => {
    const { raw, hash } = generateInviteToken();
    assert.match(raw, /^[A-Za-z0-9_-]{20,}$/); // base64url, no padding
    assert.strictEqual(hash, hashInviteToken(raw));
  });

  it("hashInviteToken is deterministic and 64 hex chars (sha256)", () => {
    const h1 = hashInviteToken("abc");
    const h2 = hashInviteToken("abc");
    assert.strictEqual(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });

  it("different raw tokens hash differently", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    assert.notStrictEqual(a.raw, b.raw);
    assert.notStrictEqual(a.hash, b.hash);
  });
});
```

- [ ] **Step 2: Run it, expect failure** — `cd artifacts/api-server && node --import tsx/esm --test src/lib/inviteToken.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

Create `artifacts/api-server/src/lib/inviteToken.ts`:

```ts
import { randomBytes, createHash } from "node:crypto";

/** SHA-256 hex of a raw invite token — what we store at rest. */
export function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * A fresh invite token: 32 random bytes as base64url (URL-fragment-safe, no
 * padding) plus its SHA-256 hash. The raw value is emailed (in the link
 * fragment) and never stored; only the hash is persisted.
 */
export function generateInviteToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashInviteToken(raw) };
}
```

- [ ] **Step 4: Run, expect pass** — same command → PASS.

- [ ] **Step 5: Commit** — `git add artifacts/api-server/src/lib/inviteToken.ts artifacts/api-server/src/lib/inviteToken.test.ts && git commit -m "feat(api): invite-token generate/hash util (TEN-010)"`

---

### Task 3: `lib/email` mailer (Resend prod + recording test transport)

**Files:**
- Modify: `artifacts/api-server/package.json` (add `resend`)
- Create: `artifacts/api-server/src/lib/email/index.ts`
- Create: `artifacts/api-server/src/lib/email/transport.ts`
- Test: `artifacts/api-server/src/lib/email/email.test.ts`

**Interfaces:**
- Produces: `sendInvite({ to, inviteUrl, orgName, role })`, `getRecordedEmails()` (test transport), `resetRecordedEmails()` — consumed by Tasks 5, 16.

- [ ] **Step 1: Add the Resend dependency**

Run: `pnpm add resend --filter @workspace/api-server`

- [ ] **Step 2: Write the failing test** (uses the record transport, no network)

Create `artifacts/api-server/src/lib/email/email.test.ts`:

```ts
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sendInvite } from "./index.js";
import { getRecordedEmails, resetRecordedEmails } from "./transport.js";

describe("sendInvite (record transport)", () => {
  beforeEach(() => {
    process.env.EMAIL_TRANSPORT = "record";
    resetRecordedEmails();
  });

  it("records one email with the invite link, recipient, and role", async () => {
    await sendInvite({
      to: "invitee@example.com",
      inviteUrl: "https://dash.example/accept-invite#token=RAWTOKEN",
      orgName: "Acme Farms",
      role: "technician",
    });
    const sent = getRecordedEmails();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, "invitee@example.com");
    assert.match(sent[0].html, /accept-invite#token=RAWTOKEN/);
    assert.match(sent[0].html, /Acme Farms/);
    assert.match(sent[0].subject, /invit/i);
  });
});
```

- [ ] **Step 3: Run, expect failure.**

- [ ] **Step 4: Implement the transport**

Create `artifacts/api-server/src/lib/email/transport.ts`:

```ts
import { Resend } from "resend";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
}

// In-memory sink for the "record" transport (tests). Never used in prod.
const recorded: OutgoingEmail[] = [];
export function getRecordedEmails(): readonly OutgoingEmail[] {
  return recorded;
}
export function resetRecordedEmails(): void {
  recorded.length = 0;
}

/**
 * Sends one email via the transport selected by EMAIL_TRANSPORT:
 *  - "resend" (production): the Resend HTTP API (RESEND_API_KEY, EMAIL_FROM).
 *  - "record" (unit tests): pushes to the in-memory sink, no network.
 *  - "smtp"   (Mailosaur integration): nodemailer over SMTP host/port/user/pass
 *             from MAILOSAUR_SMTP_* — only constructed when selected, so the
 *             optional nodemailer import never loads in prod/unit paths.
 */
export async function deliver(email: OutgoingEmail): Promise<void> {
  const transport = process.env.EMAIL_TRANSPORT ?? "resend";

  if (transport === "record") {
    recorded.push(email);
    return;
  }

  if (transport === "smtp") {
    const nodemailer = await import("nodemailer");
    const t = nodemailer.createTransport({
      host: process.env.MAILOSAUR_SMTP_HOST!,
      port: Number(process.env.MAILOSAUR_SMTP_PORT ?? 2525),
      auth: {
        user: process.env.MAILOSAUR_SMTP_USER!,
        pass: process.env.MAILOSAUR_SMTP_PASS!,
      },
    });
    await t.sendMail({ from: process.env.EMAIL_FROM!, ...email });
    return;
  }

  // Production: Resend.
  const resend = new Resend(process.env.RESEND_API_KEY!);
  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM!,
    to: email.to,
    subject: email.subject,
    html: email.html,
  });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
}
```

(Note: the `smtp`/Mailosaur branch dynamically imports `nodemailer`; add it as a dep only if Task 16 chooses SMTP delivery — `pnpm add nodemailer --filter @workspace/api-server`. If Task 16 uses Mailosaur's API-capture against Resend's own sandbox instead, the `smtp` branch stays dormant and nodemailer isn't needed. Decide in Task 16.)

- [ ] **Step 5: Implement `sendInvite`**

Create `artifacts/api-server/src/lib/email/index.ts`:

```ts
import { deliver } from "./transport.js";

export { getRecordedEmails, resetRecordedEmails } from "./transport.js";

/**
 * Sends a team-invite email. `inviteUrl` already carries the raw token in its
 * fragment (#token=...). Plain, dependency-free HTML — the template lives here
 * so there is exactly one place invite copy is defined.
 */
export async function sendInvite(params: {
  to: string;
  inviteUrl: string;
  orgName: string;
  role: "admin" | "technician";
}): Promise<void> {
  const { to, inviteUrl, orgName, role } = params;
  const html = `
    <p>You've been invited to join <strong>${escapeHtml(orgName)}</strong> on FarmSmart as ${role === "admin" ? "an admin" : "a technician"}.</p>
    <p><a href="${inviteUrl}">Accept your invitation</a></p>
    <p>This invitation expires in 14 days. If you weren't expecting it, ignore this email.</p>
  `.trim();
  await deliver({ to, subject: `You're invited to ${orgName} on FarmSmart`, html });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}
```

- [ ] **Step 6: Run, expect pass. Typecheck.** `pnpm --filter @workspace/api-server run typecheck`.

- [ ] **Step 7: Commit** — `git commit -am "feat(api): lib/email mailer with Resend + record transports (TEN-010)"`

---

### Task 4: `requireRole` middleware

**Files:**
- Create: `artifacts/api-server/src/middlewares/requireRole.ts`
- Test: `artifacts/api-server/src/middlewares/requireRole.test.ts`

**Interfaces:**
- Consumes: `req.tenant.role` (resolved by `resolveTenantContext`).
- Produces: `requireRole(...allowed: Array<"owner"|"admin"|"technician">)` — Express middleware; 403 `ROLE_FORBIDDEN` when `req.tenant` absent or role not allowed. Consumed by Tasks 5, 7, 10.

- [ ] **Step 1: Write the failing test**

Create `artifacts/api-server/src/middlewares/requireRole.test.ts`:

```ts
import { describe, test } from "node:test";
import { strictEqual } from "node:assert";
import { requireRole } from "./requireRole";
import type { Request, Response } from "express";

function run(tenant: unknown, allowed: Array<"owner" | "admin" | "technician">) {
  const req = { tenant } as Request;
  let statusCode: number | undefined;
  let body: unknown;
  const res = {
    status(c: number) { statusCode = c; return this; },
    json(b: unknown) { body = b; return this; },
  } as unknown as Response;
  let nextCalled = false;
  requireRole(...allowed)(req, res, () => { nextCalled = true; });
  return { statusCode, body, nextCalled };
}

describe("requireRole", () => {
  test("allows an owner when owner|admin allowed", () => {
    const r = run({ organizationId: 1, facilityId: 1, role: "owner" }, ["owner", "admin"]);
    strictEqual(r.nextCalled, true);
  });
  test("403 ROLE_FORBIDDEN for a technician on an owner|admin route", () => {
    const r = run({ organizationId: 1, facilityId: 1, role: "technician" }, ["owner", "admin"]);
    strictEqual(r.statusCode, 403);
    strictEqual(r.nextCalled, false);
    strictEqual((r.body as { code: string }).code, "ROLE_FORBIDDEN");
  });
  test("403 when req.tenant is unset", () => {
    const r = run(undefined, ["owner", "admin"]);
    strictEqual(r.statusCode, 403);
    strictEqual(r.nextCalled, false);
  });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

Create `artifacts/api-server/src/middlewares/requireRole.ts`:

```ts
import type { Request, Response, NextFunction } from "express";

type OrgRole = "owner" | "admin" | "technician";

/**
 * Role gate for web-only API surfaces (TEN-010). Reads req.tenant.role
 * (resolved server-side by resolveTenantContext) and 403s with the stable
 * code ROLE_FORBIDDEN when the caller's role is not in `allowed` (or when no
 * tenant resolved at all). This is THE control — UI hiding is not. Mount per
 * router, after requireTenantContext, respecting app.ts's mount-order tiers
 * (a short-circuiting gate mounted ahead of an unrelated router would
 * intercept it — see app.ts's tier comment).
 */
export function requireRole(...allowed: OrgRole[]) {
  return function (req: Request, res: Response, next: NextFunction) {
    const role = req.tenant?.role;
    if (!role || !allowed.includes(role)) {
      return res.status(403).json({ error: "Forbidden for this role", code: "ROLE_FORBIDDEN" });
    }
    return next();
  };
}
```

- [ ] **Step 4: Run, expect pass. Typecheck. Commit.**

```bash
git add artifacts/api-server/src/middlewares/requireRole.ts artifacts/api-server/src/middlewares/requireRole.test.ts
git commit -m "feat(api): requireRole middleware (403 ROLE_FORBIDDEN) (TEN-010)"
```

---

### Task 5: `routes/invitations.ts` — create / list / revoke

**Files:**
- Create: `artifacts/api-server/src/routes/invitations.ts`
- Test: `artifacts/api-server/src/tests/routes/invitations.test.ts`

**Interfaces:**
- Consumes: `invitationsTable`, `generateInviteToken`, `sendInvite`, `requireRole`, `withTenantScope`/`req.tenant`.
- Produces: `POST /invitations`, `GET /invitations`, `DELETE /invitations/:id` (all owner/admin). Accept endpoint is Task 6 (same router).

- [ ] **Step 1: Write the failing test** (record transport; seed an owner via `seedTenantContext`)

Create `artifacts/api-server/src/tests/routes/invitations.test.ts`. Model it on `tasks.test.ts`: `useDatabaseFixture`, `createAuthenticatedTestApp(invitations.default, DEFAULT_TEST_USER, facilityId)` with the seeded owner. Set `process.env.EMAIL_TRANSPORT = "record"` in `before`. Tests:

```ts
// (imports mirror tasks.test.ts: describe/test/before, strictEqual/ok,
//  request from supertest, createAuthenticatedTestApp + DEFAULT_TEST_USER,
//  seedTenantContext, getRecordedEmails/resetRecordedEmails from lib/email)

test("owner can create an invite; a Resend-bound email is queued and pending row exists", async () => {
  const { app, db, invitationsTable } = await setup(); // seeds owner membership
  resetRecordedEmails();
  const res = await request(app).post("/api/invitations").send({ email: "new@ex.com", role: "technician" });
  strictEqual(res.status, 201);
  strictEqual(getRecordedEmails().length, 1);
  const rows = await db.select().from(invitationsTable);
  strictEqual(rows.length, 1);
  strictEqual(rows[0].status, "pending");
  strictEqual(rows[0].email, "new@ex.com");
});

test("invite rejects role=owner", async () => {
  const { app } = await setup();
  const res = await request(app).post("/api/invitations").send({ email: "x@ex.com", role: "owner" });
  strictEqual(res.status, 400);
});

test("GET /invitations lists pending invites", async () => {
  const { app } = await setup();
  await request(app).post("/api/invitations").send({ email: "a@ex.com", role: "admin" });
  const res = await request(app).get("/api/invitations");
  strictEqual(res.status, 200);
  strictEqual(res.body.length, 1);
});

test("DELETE /invitations/:id revokes it", async () => {
  const { app, db, invitationsTable } = await setup();
  const created = await request(app).post("/api/invitations").send({ email: "r@ex.com", role: "technician" });
  const id = created.body.id;
  const res = await request(app).delete(`/api/invitations/${id}`);
  strictEqual(res.status, 200);
  const rows = await db.select().from(invitationsTable);
  strictEqual(rows[0].status, "revoked");
});

test("a technician cannot create invites (403 ROLE_FORBIDDEN)", async () => {
  const { app } = await setupTechnician(); // seedTenantContext memberRole: "technician"
  const res = await request(app).post("/api/invitations").send({ email: "n@ex.com", role: "admin" });
  strictEqual(res.status, 403);
  strictEqual(res.body.code, "ROLE_FORBIDDEN");
});
```

(In `setup`, seed the membership with `memberRole: "owner"` via `seedTenantContext`; mount the router as `createAuthenticatedTestApp(invitations.default, DEFAULT_TEST_USER, facilityId)`. Because the router self-mounts `requireTenantContext` + `requireRole` internally — see Step 2 — the test app's injected `X-Facility-Id` resolves `req.tenant` for the seeded owner.)

- [ ] **Step 2: Run, expect failure. Implement the router.**

Create `artifacts/api-server/src/routes/invitations.ts`:

```ts
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  db,
  invitationsTable,
  organizationMembersTable,
  organizationsTable,
} from "@workspace/db";
import { getAuth } from "../middlewares/supabaseAuth";
import { requireTenantContext } from "../middlewares/tenantContext";
import { requireRole } from "../middlewares/requireRole";
import { generateInviteToken } from "../lib/inviteToken";
import { sendInvite } from "../lib/email";

const router = Router();

// All routes in THIS router require a resolved tenant AND owner/admin. The
// accept endpoint (Task 6) is deliberately mounted on a SEPARATE, ungated
// router (accept has no session/tenant/role — the invitee may not be a member
// yet). Keep these split.
router.use(requireTenantContext, requireRole("owner", "admin"));

const CreateSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "technician"]), // never owner
});

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// POST /invitations — owner/admin invites by email + role.
router.post("/invitations", async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { email, role } = parsed.data;
    const { organizationId } = req.tenant!;

    // One-org-per-user: reject if this email is already an active member of any org.
    const existing = await db
      .select({ id: organizationMembersTable.id })
      .from(organizationMembersTable)
      .innerJoin(
        // join users to compare email
        (await import("@workspace/db")).usersTable,
        eq((await import("@workspace/db")).usersTable.id, organizationMembersTable.userId),
      )
      .where(
        and(
          eq((await import("@workspace/db")).usersTable.email, email),
          eq(organizationMembersTable.status, "active"),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return res.status(400).json({ error: "That email already belongs to an organization" });
    }

    const { raw, hash } = generateInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    // Re-invite refreshes the existing pending row (partial unique index on
    // (org,email) where status='pending') rather than duplicating.
    const [row] = await db
      .insert(invitationsTable)
      .values({ organizationId, email, role, tokenHash: hash, invitedBy: userId!, expiresAt })
      .onConflictDoUpdate({
        target: [invitationsTable.organizationId, invitationsTable.email],
        targetWhere: eq(invitationsTable.status, "pending"),
        set: { role, tokenHash: hash, expiresAt, invitedBy: userId!, createdAt: new Date() },
      })
      .returning();

    const [org] = await db
      .select({ name: organizationsTable.name })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId));

    const dashboardUrl = process.env.DASHBOARD_URL ?? "http://localhost:5173";
    await sendInvite({
      to: email,
      inviteUrl: `${dashboardUrl}/accept-invite#token=${raw}`,
      orgName: org?.name ?? "your organization",
      role,
    });

    return res.status(201).json({ id: row.id, email: row.email, role: row.role, status: row.status });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to create invitation" });
  }
});

// GET /invitations — pending invites for the caller's org.
router.get("/invitations", async (req: Request, res: Response) => {
  try {
    const { organizationId } = req.tenant!;
    const rows = await db
      .select({
        id: invitationsTable.id,
        email: invitationsTable.email,
        role: invitationsTable.role,
        status: invitationsTable.status,
        expiresAt: invitationsTable.expiresAt,
        createdAt: invitationsTable.createdAt,
      })
      .from(invitationsTable)
      .where(and(eq(invitationsTable.organizationId, organizationId), eq(invitationsTable.status, "pending")));
    return res.status(200).json(rows);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to list invitations" });
  }
});

// DELETE /invitations/:id — revoke a pending invite (own org only).
router.delete("/invitations/:id", async (req: Request, res: Response) => {
  try {
    const { organizationId } = req.tenant!;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    const [updated] = await db
      .update(invitationsTable)
      .set({ status: "revoked" })
      .where(
        and(
          eq(invitationsTable.id, id),
          eq(invitationsTable.organizationId, organizationId),
          eq(invitationsTable.status, "pending"),
        ),
      )
      .returning({ id: invitationsTable.id });
    if (!updated) return res.status(404).json({ error: "Invitation not found" });
    return res.status(200).json({ ok: true });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to revoke invitation" });
  }
});

export default router;
```

(Clean up the inline `await import("@workspace/db")` for `usersTable` into a top-of-file import `usersTable` — inlined here only to keep the snippet self-contained; the implementer must hoist it to the import block.)

- [ ] **Step 3: Run tests, expect pass. Typecheck. Commit.**

```bash
git add artifacts/api-server/src/routes/invitations.ts artifacts/api-server/src/tests/routes/invitations.test.ts
git commit -m "feat(api): POST/GET/DELETE /invitations, owner/admin gated (TEN-010)"
```

---

### Task 6: `POST /invitations/accept` — accept flow (new/existing user, one-org, single-use)

**Files:**
- Create: `artifacts/api-server/src/routes/invitationsAccept.ts` (the ungated accept router)
- Test: `artifacts/api-server/src/tests/routes/invitationsAccept.test.ts`

**Interfaces:**
- Consumes: `invitationsTable`, `hashInviteToken`, the Supabase service-role admin client, `organizationMembersTable`, `usersTable`.
- Produces: `POST /invitations/accept` (token-authenticated, no session/role). Consumed by Task 13 (web accept page).

- [ ] **Step 1: Write the failing test.**

Model on `invitations.test.ts` but this router is **ungated** (no `X-Facility-Id`, no session). Because accept creates a real Supabase user, gate the DB-backed cases on `SUPABASE_URL`/`SERVICE_ROLE_KEY` (mirror `app.test.ts`'s `canRun`). Tests:
- accept with a valid pending token for a NEW email → 201, creates `auth.users` + `organization_members` (role from invite, active), marks invite `accepted`.
- second accept with the same token → 409/400 (single-use).
- accept with an expired token → 400.
- accept with a revoked token → 400.
- accept where the email already belongs to another org → 400.

Use a seeded pending invitation row inserted directly (via `getAdminDb()`), with a known raw token (`generateInviteToken()` → insert `hash`, keep `raw` for the request).

- [ ] **Step 2: Implement the accept router.**

Create `artifacts/api-server/src/routes/invitationsAccept.ts`:

```ts
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { db, invitationsTable, organizationMembersTable, usersTable } from "@workspace/db";
import { hashInviteToken } from "../lib/inviteToken";

const router = Router();

const AcceptSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).optional(), // required only when the user is new
});

function admin() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// POST /invitations/accept — token-authenticated; deliberately NOT behind
// requireTenantContext/requireSignedIn (the invitee may have no account yet).
router.post("/invitations/accept", async (req: Request, res: Response) => {
  try {
    const parsed = AcceptSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Validation failed" });
    const { token, password } = parsed.data;

    // Atomically claim the pending, unexpired, unrevoked invite (single-use):
    // flip to 'accepted' only if it is currently 'pending'; the WHERE guard is
    // the race-safe single-use control.
    const now = new Date();
    const hash = hashInviteToken(token);
    const [invite] = await db
      .update(invitationsTable)
      .set({ status: "accepted", acceptedAt: now })
      .where(and(eq(invitationsTable.tokenHash, hash), eq(invitationsTable.status, "pending")))
      .returning();
    if (!invite) return res.status(400).json({ error: "This invitation is invalid, expired, or already used" });
    if (invite.expiresAt.getTime() < now.getTime()) {
      // Was pending but expired: mark expired, fail safe. (Flip back so the row
      // reflects reality; the accept did not take effect.)
      await db.update(invitationsTable).set({ status: "expired", acceptedAt: null }).where(eq(invitationsTable.id, invite.id));
      return res.status(400).json({ error: "This invitation has expired" });
    }

    // One-org-per-user: if the email already maps to an active membership, bail
    // (and revert the claim so the invite can be re-issued cleanly).
    const [existingUser] = await db.select().from(usersTable).where(eq(usersTable.email, invite.email)).limit(1);
    if (existingUser) {
      const [member] = await db
        .select({ id: organizationMembersTable.id })
        .from(organizationMembersTable)
        .where(and(eq(organizationMembersTable.userId, existingUser.id), eq(organizationMembersTable.status, "active")))
        .limit(1);
      if (member) {
        await db.update(invitationsTable).set({ status: "pending", acceptedAt: null }).where(eq(invitationsTable.id, invite.id));
        return res.status(400).json({ error: "That email already belongs to an organization" });
      }
    }

    // Create the Supabase user if new (email pre-confirmed — no email sent).
    let userId = existingUser?.id ?? null;
    if (!userId) {
      if (!password) {
        await db.update(invitationsTable).set({ status: "pending", acceptedAt: null }).where(eq(invitationsTable.id, invite.id));
        return res.status(400).json({ error: "A password is required to create your account" });
      }
      const { data, error } = await admin().auth.admin.createUser({
        email: invite.email,
        password,
        email_confirm: true,
      });
      if (error || !data.user) {
        await db.update(invitationsTable).set({ status: "pending", acceptedAt: null }).where(eq(invitationsTable.id, invite.id));
        return res.status(400).json({ error: `Could not create account: ${error?.message ?? "unknown"}` });
      }
      userId = data.user.id;
      // handle_new_user() trigger creates the public.users row; nothing to do here.
    }

    // Insert the membership with the invited role (active).
    await db.insert(organizationMembersTable).values({
      organizationId: invite.organizationId,
      userId: userId!,
      role: invite.role,
      status: "active",
    });

    return res.status(201).json({ organizationId: invite.organizationId, role: invite.role, email: invite.email });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to accept invitation" });
  }
});

export default router;
```

- [ ] **Step 3: Run tests, expect pass. Typecheck. Commit.**

```bash
git add artifacts/api-server/src/routes/invitationsAccept.ts artifacts/api-server/src/tests/routes/invitationsAccept.test.ts
git commit -m "feat(api): POST /invitations/accept (new/existing user, single-use, one-org) (TEN-010)"
```

---

### Task 7: `routes/members.ts` — change role / remove member; and `cycles.ts` operational-gate collapse

**Files:**
- Create: `artifacts/api-server/src/routes/members.ts`
- Modify: `artifacts/api-server/src/routes/cycles.ts`
- Test: `artifacts/api-server/src/tests/routes/members.test.ts`

**Interfaces:**
- Produces: `GET /members`, `PATCH /members/:userId/role`, `DELETE /members/:userId` (owner/admin). `cycles.ts` gates now read `req.tenant.role !== 'technician'`.

- [ ] **Step 1: Write `members.test.ts`** — owner lists members; changes an admin↔technician role; removing a member sets `status='removed'`; cannot change/remove the owner; technician gets 403; cross-org target → 404.

- [ ] **Step 2: Implement `members.ts`**

```ts
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { db, organizationMembersTable, usersTable } from "@workspace/db";
import { requireTenantContext } from "../middlewares/tenantContext";
import { requireRole } from "../middlewares/requireRole";

const router = Router();
router.use(requireTenantContext, requireRole("owner", "admin"));

// GET /members — active members of the caller's org.
router.get("/members", async (req: Request, res: Response) => {
  const { organizationId } = req.tenant!;
  const rows = await db
    .select({
      userId: organizationMembersTable.userId,
      email: usersTable.email,
      role: organizationMembersTable.role,
      status: organizationMembersTable.status,
    })
    .from(organizationMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, organizationMembersTable.userId))
    .where(and(eq(organizationMembersTable.organizationId, organizationId), eq(organizationMembersTable.status, "active")));
  return res.status(200).json(rows);
});

const RoleSchema = z.object({ role: z.enum(["admin", "technician"]) }); // never owner

// PATCH /members/:userId/role — admin<->technician only; never touch owner.
router.patch("/members/:userId/role", async (req: Request, res: Response) => {
  const { organizationId } = req.tenant!;
  const parsed = RoleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "role must be admin or technician" });
  const [updated] = await db
    .update(organizationMembersTable)
    .set({ role: parsed.data.role })
    .where(
      and(
        eq(organizationMembersTable.userId, req.params.userId),
        eq(organizationMembersTable.organizationId, organizationId),
        eq(organizationMembersTable.status, "active"),
        ne(organizationMembersTable.role, "owner"), // owner is immutable
      ),
    )
    .returning({ userId: organizationMembersTable.userId });
  if (!updated) return res.status(404).json({ error: "Member not found or not modifiable" });
  return res.status(200).json({ ok: true });
});

// DELETE /members/:userId — soft-remove (status='removed'); never the owner.
router.delete("/members/:userId", async (req: Request, res: Response) => {
  const { organizationId } = req.tenant!;
  const [updated] = await db
    .update(organizationMembersTable)
    .set({ status: "removed" })
    .where(
      and(
        eq(organizationMembersTable.userId, req.params.userId),
        eq(organizationMembersTable.organizationId, organizationId),
        eq(organizationMembersTable.status, "active"),
        ne(organizationMembersTable.role, "owner"),
      ),
    )
    .returning({ userId: organizationMembersTable.userId });
  if (!updated) return res.status(404).json({ error: "Member not found or not removable" });
  return res.status(200).json({ ok: true });
});

export default router;
```

- [ ] **Step 3: Collapse `cycles.ts`'s operational gates**

In `artifacts/api-server/src/routes/cycles.ts`: replace `extractRole` + `isSupervisorOrLead` so the three gate sites read the org role and gate on non-technician. Change `extractRole` to read `req.tenant!.role` (already resolved) instead of the JWT claim, and replace `isSupervisorOrLead`:

```ts
// TEN-010: the operational-role gates (history view, completed-cycle edits)
// collapse onto the org role — any non-technician member (owner/admin) is
// privileged. Reads req.tenant.role (server-resolved) rather than the JWT
// claim.
function isPrivileged(role: "owner" | "admin" | "technician"): boolean {
  return role !== "technician";
}
```

Update the three call sites: `if (status === "history" && !isSupervisorOrLead(role))` → `if (status === "history" && !isPrivileged(req.tenant!.role))`; likewise the two `rows[0].cycle.status === "completed" && !isSupervisorOrLead(role)` sites → `!isPrivileged(req.tenant!.role)`. Remove the now-unused `extractRole`/`UserRole` import if nothing else uses them.

- [ ] **Step 4: Run tests (members + the existing cycles suite), typecheck, commit.**

```bash
git add artifacts/api-server/src/routes/members.ts artifacts/api-server/src/routes/cycles.ts artifacts/api-server/src/tests/routes/members.test.ts
git commit -m "feat(api): member role/remove endpoints; collapse cycles operational gates to non-technician (TEN-010)"
```

---

### Task 8: Repoint `custom_access_token_hook` to the org role

**Files:**
- Create: `supabase/migrations/00014_access_token_hook_org_role.sql`
- Modify: `supabase/tests/00001_foundation.sql`
- Create: `supabase/tests/00014_access_token_hook.test.sql` (pgTAP)

**Interfaces:**
- Produces: JWT `user_role` claim now carries `organization_members.role` (owner/admin/technician) for the caller's active membership.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/00014_access_token_hook_org_role.sql`:

```sql
-- TEN-010: repoint the access-token hook from the deprecated public.users.role
-- (operational axis: technician|supervisor|quality_lead|facility_lead) to the
-- org membership role (owner|admin|technician) — the single source of truth
-- per ADR-005. The claim KEY stays `user_role` (so client claim-readers don't
-- change their key), only the VALUE source + domain changes. Absent active
-- membership -> the claim is omitted (client defaults to the restricted role).
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb;
  member_role public.org_member_role;
begin
  select role into member_role
    from public.organization_members
    where user_id = (event->>'user_id')::uuid
      and status = 'active'
    limit 1;

  claims := event->'claims';

  if member_role is not null then
    claims := jsonb_set(claims, '{user_role}', to_jsonb(member_role));
  else
    claims := claims - 'user_role';
  end if;

  event := jsonb_set(event, '{claims}', claims);
  return event;
end;
$$;

grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
-- supabase_auth_admin needs table SELECT independent of SECURITY DEFINER (same
-- lesson as 00001's public.users grant).
grant select on public.organization_members to supabase_auth_admin;
```

- [ ] **Step 2: pgTAP check** — Create `supabase/tests/00014_access_token_hook.test.sql`: insert an org + user + `organization_members` row (role `admin`), call `public.custom_access_token_hook('{"user_id":"...","claims":{}}'::jsonb)`, assert the returned `claims->>'user_role' = 'admin'`; then for a user with no membership assert the claim key is absent. Wrap in `BEGIN; ... ROLLBACK;` with `plan(N)`.

- [ ] **Step 3: Bump the Supabase count** in `supabase/tests/00001_foundation.sql` (`13` → `14`, value + message + doc comment citing 00014).

- [ ] **Step 4: Apply + verify** — `supabase db push --db-url "$TEST_DATABASE_URL" --include-all`, then `supabase test db --db-url "$TEST_DATABASE_URL" ./supabase/tests` → PASS.

- [ ] **Step 5: Commit** — `git add supabase/migrations/00014_access_token_hook_org_role.sql supabase/tests/ && git commit -m "feat(auth): repoint access-token hook to org role (TEN-010)"`

---

### Task 9: `app.ts` — mount the new routers (tier discipline)

**Files:**
- Modify: `artifacts/api-server/src/app.ts`
- Modify: `artifacts/api-server/src/tests/app.test.ts`

**Interfaces:**
- Consumes: `invitations.ts` (tenant+owner/admin gated, self-mounts its gates → tier 2), `invitationsAccept.ts` (ungated → tier 1), `members.ts` (self-gates → tier 2).

- [ ] **Step 1: Mount the routers**

In `app.ts`: import the three routers. `invitationsAccept` self-gates nothing and needs NO tenant/role — mount it in **tier 1** (with the ungated group). `invitations`/`members` self-mount `requireTenantContext + requireRole` internally, so they behave like **tier 2** self-gating routers — mount them in tier 2 (after tier 1, before tier 3), matching the file's existing tier rules and comment. Do **not** wrap them with `requireTenantContext` again at the app level (they do it themselves).

```ts
// tier 1 additions (ungated — accept has no session/tenant):
app.use("/api", requireSignedIn, invitationsAcceptRouter);
// tier 2 additions (self-gate via requireTenantContext + requireRole inside):
app.use("/api", requireSignedIn, invitationsRouter);
app.use("/api", requireSignedIn, membersRouter);
```

(Place the tier-1 line among the tier-1 mounts and the tier-2 lines among tier-2. Update the tier comment's enumerations to name the new routers.)

- [ ] **Step 2: Extend `app.test.ts`** — add real-`app.ts` cases: an owner JWT with `X-Facility-Id` → `POST /invitations` 201; a technician JWT → `POST /invitations` 403 `ROLE_FORBIDDEN`; `POST /invitations/accept` reachable without `X-Facility-Id` (400 for a bogus token, proving it isn't intercepted by an earlier tenant gate). Reuse `createRealTestUser` + `seedTenantContext`.

- [ ] **Step 3: Run app.test.ts + typecheck + `node scripts/ci/check-tenant-scope.mjs`, commit.**

```bash
git add artifacts/api-server/src/app.ts artifacts/api-server/src/tests/app.test.ts
git commit -m "feat(api): mount invitations/accept/members routers with tier-correct gating (TEN-010)"
```

---

### Task 10: OpenAPI spec + client codegen

**Files:**
- Modify: `lib/api-spec/openapi.yaml`
- Modify (generated): `lib/api-zod/**`, `lib/api-client-react/**`

- [ ] **Step 1:** Add paths + schemas to `openapi.yaml` for: `POST/GET /invitations`, `DELETE /invitations/{id}`, `POST /invitations/accept`, `GET /members`, `PATCH /members/{userId}/role`, `DELETE /members/{userId}`. Define `Invitation`, `CreateInvitationRequest`, `AcceptInvitationRequest`, `Member`, `ChangeRoleRequest` schemas mirroring the route bodies/responses exactly.
- [ ] **Step 2:** `pnpm --filter @workspace/api-spec run codegen` → new hooks (`useCreateInvitation`, `useListInvitations`, `useRevokeInvitation`, `useAcceptInvitation`, `useListMembers`, `useChangeMemberRole`, `useRemoveMember`).
- [ ] **Step 3:** `pnpm run typecheck` (root) clean. Commit `lib/api-spec` + regenerated `lib/api-zod`/`lib/api-client-react`.

---

### Task 11: Web — Settings → Team surface

**Files:**
- Create: `artifacts/admin-dashboard/src/pages/settings/team/TeamSection.tsx`
- Modify: `artifacts/admin-dashboard/src/pages/settings/Settings.tsx`

**Interfaces:**
- Consumes: `useListMembers`, `useListInvitations`, `useCreateInvitation`, `useRevokeInvitation`, `useChangeMemberRole`, `useRemoveMember`, `useActiveFacility`/role.

- [ ] **Step 1:** Build `TeamSection` — a shadcn `Card` matching the existing Settings cards' style. Renders: member list (email, role, change-role select for non-owner rows, remove button), pending-invites list (email, role, revoke button), and an invite form (email input + admin|technician select + "Send invite"). All mutations invalidate the relevant query keys. Surface `POST /invitations` 400 (already-in-org) and 403 as inline messages, not toasts-only.
- [ ] **Step 2:** In `Settings.tsx`, render `<TeamSection />` **only for owner/admin** (read the role from the repointed claim via a small `useOrgRole()` helper or the existing session claims). Technicians never see the card — but this is UX only; the server 403 is the control.
- [ ] **Step 3:** `pnpm run typecheck` clean. Commit.

---

### Task 12: Web — `AuthGate` technician-denied state

**Files:**
- Modify: `artifacts/admin-dashboard/src/App.tsx`
- Create: `artifacts/admin-dashboard/src/hooks/use-org-role.ts`

- [ ] **Step 1:** `use-org-role.ts` — reads the `user_role` claim (now the org role) from `supabase.auth.getClaims()`, returns `"owner"|"admin"|"technician"|null`.
- [ ] **Step 2:** In `App.tsx`'s `AuthGate`, after `session` is confirmed and before rendering `<ActiveFacilityProvider><FacilityGate/>`, read the org role; if `technician`, render the AUTH-003 denied screen ("The dashboard is for admins — open the FarmSmart mobile app") instead of the app. (Server 403s remain the real control; this is the directing UX.)
- [ ] **Step 3:** Typecheck clean. Commit.

---

### Task 13: Web — `/accept-invite` page

**Files:**
- Create: `artifacts/admin-dashboard/src/pages/accept-invite/AcceptInvite.tsx`
- Modify: `artifacts/admin-dashboard/src/App.tsx` (route, outside `AuthGate` — accept is unauthenticated)

- [ ] **Step 1:** `AcceptInvite` reads `#token=...` from `window.location.hash`, shows a set-password form (new user) → calls `useAcceptInvitation({ token, password })`. On success: sign the user in (`supabase.auth.signInWithPassword`) and, if the returned `role === "technician"`, show the "open the FarmSmart mobile app" directing state instead of routing into the dashboard; otherwise navigate to `/`. Handle 400 (invalid/expired/used/already-in-org) with clear inline copy + a "request a new invite" hint.
- [ ] **Step 2:** Wire the `/accept-invite` route ABOVE/OUTSIDE `AuthGate` (it must render for signed-out visitors). Confirm the token is read from the fragment, never sent as a query param.
- [ ] **Step 3:** Typecheck clean. Commit.

---

### Task 14: Mobile — repoint role reads + retire legacy operational role

**Files:**
- Modify: `lib/api-zod/src/roles.ts`
- Modify: `artifacts/farmeasy/hooks/useUserRole.ts`
- Modify: `artifacts/farmeasy/hooks/useUserRole.test.ts`
- Modify: `artifacts/farmeasy/app/(tabs)/cycles.tsx`

- [ ] **Step 1:** `roles.ts` — change `UserRole` to `"owner" | "admin" | "technician"`; update `USER_ROLE_LABELS`; replace `isSupervisorOrLead` with `isPrivileged(role) => role !== "technician"` (keep the old export name only if other code still imports it — otherwise rename and fix imports).
- [ ] **Step 2:** `useUserRole.ts` — the claim value is now the org role; `getUserRole` returns `"owner"|"admin"|"technician"` (default `"technician"` when the claim is absent); `isSupervisor` → `isPrivileged(role)`. Update `useUserRole.test.ts`'s expected values (the mock claims now carry org roles; "supervisor"/"quality_lead"/"facility_lead" cases become "admin"/"owner"/"technician").
- [ ] **Step 3:** `cycles.tsx` — the `isSupervisor` UI gate now means non-technician; no logic change beyond the renamed helper.
- [ ] **Step 4:** `pnpm --filter @workspace/farmeasy run typecheck` + the mobile role test pass. Commit.

---

### Task 15: Invite-lifecycle integration test with Mailosaur

**Files:**
- Create: `artifacts/api-server/src/tests/integration/invite-email.test.ts`

- [ ] **Step 1:** Gate on Mailosaur env (`MAILOSAUR_API_KEY`, `MAILOSAUR_SERVER_ID`) — skip when absent (like `app.test.ts`'s `canRun`). With `EMAIL_TRANSPORT=smtp` pointing at the Mailosaur server (or Resend's sandbox captured by Mailosaur — pick per your Mailosaur setup): create an invite to a Mailosaur inbox address, poll Mailosaur for the message, extract the `#token=` link, assert exactly one email, the link is present, and a spam/deliverability score is acceptable. Then accept once (201) → second accept fails (single-use) → revoke a fresh invite → its link fails.
- [ ] **Step 2:** Because this needs live Mailosaur creds, it runs opt-in; document the env in the test's header comment. Commit.

(Controller note: the orchestrator drives Mailosaur via the `mcp__mailosaur__*` tools to provision the test server/inbox and to assert capture during review; the committed test reads creds from env so CI can run it when configured.)

---

### Task 16: Full verification pass

**Files:** none.

- [ ] **Step 1:** `pnpm run typecheck` (root) — clean.
- [ ] **Step 2:** `node scripts/ci/check-tenant-scope.mjs` — clean (add any new legitimate `organization_members`/`invitations` direct-access baseline entries with justification, mirroring TEN-008's Task 8 pattern, only if the guard flags a genuinely-safe bootstrap query).
- [ ] **Step 3:** `scripts/ci/test-disposable-supabase.sh` (Docker) — pgTAP `Result: PASS` (Drizzle 30, Supabase 14) + full api-server suite green.
- [ ] **Step 4:** Fix and re-run until all clean. Do not open the PR until green.
