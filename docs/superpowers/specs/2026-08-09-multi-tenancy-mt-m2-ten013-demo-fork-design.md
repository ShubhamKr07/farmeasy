# TEN-013 — Demo Fork (design)

**Scope of this document:** the fourth of five sub-projects decomposed out of MT-M2 ("Multi-facility + front door": TEN-008, TEN-010 rev. B, TEN-012, **TEN-013**, TEN-009 stubs). TEN-008 (multi-facility ops, PR #12), TEN-010 rev. B (team invites/roles, PR #13), and TEN-012 (public sign-up, PR #14) have shipped. This document covers **TEN-013 only** — the post-sign-up **"Set up your farm" vs "Explore a demo"** fork at onboarding step W2, per-tenant demo provisioning, the persistent graduate path, and reset-to-real. TEN-009 (org rollup stubs), TEN-011's public flag flip, and TEN-014 (mobile sign-in policy) are each their own future sub-project, not covered here.

**Predecessor context:** TEN-012 lands a freshly-verified user directly in the onboarding wizard at **W2** (`farm_basics`), on an empty owner org that `ensureOwnerOrg` lazily created at wizard bootstrap. TEN-013 reroutes W2 through the fork. TEN-013 also properly retires the pre-multi-tenancy `seedDataIfEmpty()` / `scripts/src/seed-demo-data.ts` pilot-bootstrap pattern by replacing it with real per-org demo provisioning (noted as TEN-013's job in the MT-M1 plan).

---

## Product decisions (locked during brainstorming)

1. **Demo = a per-user forked demo org.** "Explore a demo" gives the user a demo populated with sample data they own and can freely mutate — not a shared read-only demo.
2. **Demo IS the user's single org** (reset on graduate), not a second org. This preserves the **one-org-per-user** invariant that TEN-010 (invite-accept) and TEN-012 (`ensureOwnerOrg`) enforce, and avoids an org-level switcher (TEN-008's switcher is facility-level only). The user's one org is flagged `is_demo` and seeded; graduating clears it.
3. **Graduate = reset-in-place (same org).** Deletes all demo data in the org, flips `is_demo=false`, and drops the user into the W2 wizard to set up their real facility. Same org id + membership throughout — no dangling references, one teardown path. One-way (no return to demo after reset).
4. **Curated rich demo (all screens).** The seed lights up every surface so no screen looks empty: a demo facility + seed lots + cycles across lifecycle stages + a few sensor readings + recent facility-logs + a couple alerts/tasks + some inventory.
5. **Graduate via a persistent banner + CTA.** While `is_demo=true`, an app-wide banner ("You're exploring a demo — Set up my real farm") is always visible; clicking it confirms and runs graduate.

---

## Architecture / flow

The fork sits at W2. Because TEN-012 already created the user's **empty owner org** at wizard bootstrap, TEN-013 **seeds that existing empty org** rather than restructuring TEN-012's provisioning timing:

- **"Set up your farm"** → continue the wizard exactly as today (empty org, W2 `farm_basics` onward).
- **"Explore a demo"** → `POST /api/demo/provision` seeds the existing org → client lands in a populated dashboard (wizard skipped while in demo).

Two new authed, tenant-scoped endpoints own all demo state; the client never seeds data itself.

## Data model

- **New column `organizations.is_demo boolean not null default false`** — Drizzle migration (`lib/db/drizzle/`) + Supabase migration (`supabase/migrations/`), foundation pgTAP counts bumped. This is the single source of truth for "this org is currently a demo," driving both the banner and provision/graduate idempotency.
- **All demo content hangs off one demo facility** in the org. Every demo row is therefore facility-scoped and removable by deleting that one facility (relying on the existing `ON DELETE CASCADE` FKs from facility → its children; the plan verifies each child table's cascade and falls back to explicit ordered deletes for any table lacking one). Reference data (`growth_profiles`) is **reused, never copied**.

## Provisioning — `POST /api/demo/provision`

- Authed + tenant-scoped (`resolveTenantContext`/`withTenantScope`); runs as `farmsmart_app` under RLS, so every insert is correctly org/facility-scoped and isolated.
- **Single transaction, idempotent:** if the caller's org is already `is_demo=true`, no-op and return the existing demo facility. Otherwise: set `is_demo=true`, create the demo facility, then seed the rich dataset via a shared `seedDemoOrg(tx, { organizationId, facilityId })` module.
- **Shared seed module = one source of truth.** `seedDemoOrg` is the canonical demo dataset; `scripts/src/seed-demo-data.ts` is refactored to call the same module (adapted from its current "grab any first facility" pilot shape to an explicit `(orgId, facilityId)` signature), so the CLI and the live feature never diverge.
- **Seeded tables (rich):** the demo facility; `seed_lots`; `cycles` across lifecycle stages; a few `sensors` + recent readings; recent `facility_logs`; a couple `alerts` + `tasks`; some inventory rows. Quantities kept modest (dozens of rows, not thousands) so provisioning is a fast synchronous transaction.

## Graduate / reset — `POST /api/demo/graduate`

- Authed + tenant-scoped; requires explicit client confirmation.
- **Single transaction:** delete the demo facility (FK cascade removes all facility-scoped demo rows) + any org-level demo rows, then flip `is_demo=false`. The org row + the user's owner membership are untouched.
- Client then routes to W2 `farm_basics` for real setup. One-way.

## UI (web dashboard)

- **Fork screen at W2:** two choices — "Set up your farm" (existing wizard path) and "Explore a demo" (calls provision, then routes to the dashboard).
- **Persistent demo banner:** rendered whenever `is_demo=true`, app-wide, with a "Set up my real farm" CTA → confirm dialog → `graduate`. `is_demo` is surfaced to the client via the existing wizard/tenant-context response the dashboard already fetches (no new polling).
- OpenAPI + generated client/zod updated for the two endpoints (orval codegen), matching the TEN-012 pattern.

## Feature flag + rollout

- Gate the fork behind **`DEMO_FORK_ENABLED` (default off)** so it ships dark. When off, W2 behaves exactly as TEN-012 ships it (direct to `farm_basics`) — zero behavior change. Flip on once verified end-to-end on staging.

## Tenant / RLS safety

- Both endpoints seed/delete **only within the caller's own org** (tenant context resolved server-side, never from client input).
- Unlike the prod-guarded CLI (`CONFIRM_DEMO_SEED`, rejects `NODE_ENV=production`), this is an intentional per-tenant **user feature** and **is allowed in production** — its safety comes from tenant-scoping + the `is_demo` idempotency guard, not from a global environment block.
- All provision/graduate DB work is proven under a real non-`BYPASSRLS` `farmsmart_app` connection (the MT-M1/TEN-010/TEN-012 discipline), not only under a BYPASSRLS superuser.

## Testing

- **Provision:** asserts `is_demo=true`, exactly one demo facility, and seeded rows present across the rich table set — all scoped to the caller's org/facility; a second call is a no-op (idempotent).
- **Graduate:** asserts every demo facility + all facility-scoped demo rows are gone, `is_demo=false`, and the org row + owner membership survive; client lands on W2.
- **Cross-tenant isolation:** a second user cannot see, provision, or graduate another org's demo; RLS proof under `farmsmart_app` (target: green count matching the TEN-012 proof plus the new endpoints).
- **Flag off:** with `DEMO_FORK_ENABLED=off`, W2 is byte-for-byte the TEN-012 behavior and the endpoints are unmounted/inert.

## Rollback points

- **Migration** is reversible (drop `organizations.is_demo`); down-migration provided.
- **Feature flag off** instantly disables the fork with no code revert; TEN-012's direct-to-W2 landing is the fallback.
- Both endpoints are **additive** — with the flag off, the existing wizard is unchanged.
- **Graduate** is guarded by an explicit confirm (destructive reset), and runs in a single transaction so a mid-reset failure leaves the demo intact for retry.

## Out of scope (YAGNI)

- Org-level switcher / multi-org membership (rejected in favor of the single-org model).
- Time-based or abandoned-demo purge (a verified demo user is a normal account; no special purge — the TEN-012 unverified-purge already covers never-confirmed accounts).
- Re-entering demo after graduating (one-way).
- **Mobile** demo fork — web onboarding only for v1 (mobile entry policy is TEN-014's territory).
- The `farmsmart_recommender` role rotation follow-up parked on this task (tracked separately; not part of the demo-fork build).

## Risks / open items for the plan

- **FK-cascade completeness:** the reset relies on facility→children `ON DELETE CASCADE`. The plan must enumerate every seeded child table and verify its cascade, adding explicit ordered deletes for any that lack one, so graduate never orphans rows.
- **Seed volume vs latency:** keep seeded rows modest so provision stays a sub-second synchronous transaction; if it grows, revisit async provisioning (explicitly deferred now).
- **`seed-demo-data.ts` refactor:** adapting the CLI to the shared `(orgId, facilityId)` module must preserve its existing prod guard for the CLI entry point while the live endpoint uses its own tenant-scoped safety.
