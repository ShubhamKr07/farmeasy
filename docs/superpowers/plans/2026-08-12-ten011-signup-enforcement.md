# TEN-011 — Server-side signup enforcement — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** Enforce `off`/`allowlist`/`public` signup **server-side** via a GoTrue `before_user_created` Postgres hook + a DB `signup_config` single source of truth, so the public `SIGNUP_MODE` flag can be flipped on safely (UI availability and real enforcement can't drift; invited users are unaffected).

**Spec:** `docs/superpowers/specs/2026-08-12-ten011-signup-enforcement-design.md`.

## Global Constraints
- **Option A: DB `signup_config` is the single source of truth.** Both `getSignupMode()` (app) and the hook read it. GoTrue `enable_signup` stays `true`.
- **Hook contract (confirmed from Supabase docs, `before-user-created-hook`):** the pg-function returns `{}` (allow) or `{"error": {"http_code": 400, "message": "…"}}` (reject). The incoming email is in the event's user object — **confirm the exact pg-function event jsonb path at build** (docs show `user.email` for the HTTP form; for the `pg-functions://` form inspect the passed `event` — likely `event->'user'->>'email'`; log the raw event once in a scratch test to pin it, then remove).
- **Register like `custom_access_token_hook`** (`00015`): SECURITY DEFINER, `grant execute to supabase_auth_admin`, `revoke from anon/authenticated/public`, + explicit `grant select` on the tables the hook reads (SECURITY DEFINER still needs them — the 00001/00015 lesson).
- **Fail-closed awareness:** if the hook errors, GoTrue rejects the signup. A hook bug = no public signups. Since `SIGNUP_MODE` default is `off` (no public signup live yet), rollout risk is low — but test the hook exhaustively and make the rollback a one-line `config.toml` disable.
- **Invited users bypass the hook** (created via `admin.createUser`) — do NOT add an invitation check; verify the bypass in a test.
- Migrations: Drizzle `0034` (table) + Supabase `00025` (RLS + hook). Confirm latest is `0033`/`00024` (post-#45). Bump foundation counts. Branch `mt-m2-ten011-signup-enforcement` off `main` (carry the spec+plan). PR into `main`.

---

### Task 1: `signup_config` table (Drizzle) + seed
**Files:** modify `lib/db/src/schema/index.ts`; create `lib/db/drizzle/0034_signup_config.sql` (+meta); modify `supabase/tests/00001_foundation.sql` (Drizzle count +1).

- [ ] **Step 1:** Add `signupConfigTable = pgTable("signup_config", { id: integer("id").primaryKey().default(1), mode: text("mode", { enum: ["off","allowlist","public"] }).notNull().default("off"), updatedAt: timestamp("updated_at").notNull().defaultNow() }, t => [ check("signup_config_singleton", sql`${t.id} = 1`) ])` — a single-row table (`id=1` CHECK). (Match the schema file's import/style.)
- [ ] **Step 2:** `drizzle-kit generate --name signup_config`. **Append `INSERT INTO public.signup_config (id, mode) VALUES (1, 'off') ON CONFLICT (id) DO NOTHING;`** to seed the singleton (default off — the current effective mode). Add rollback comment.
- [ ] **Step 3:** Foundation Drizzle count +1. `pnpm --filter @workspace/db run build && pnpm run typecheck` clean. Commit `feat(db): signup_config singleton table (TEN-011)`.

### Task 2: `before_user_created` hook + `signup_config`/hook RLS + config (Supabase)
**Files:** create `supabase/migrations/00025_signup_enforcement.sql`, `supabase/tests/00025_signup_enforcement.test.sql`; modify `supabase/config.toml`; modify `00001_foundation.sql` (Supabase count +1).

- [ ] **Step 1: the hook function.** In `00025_signup_enforcement.sql`:
  ```sql
  create or replace function public.before_user_created_hook(event jsonb)
  returns jsonb language plpgsql security definer set search_path = public as $$
  declare
    v_mode text;
    v_email text := lower(trim(coalesce(event->'user'->>'email', event->>'email', '')));  -- CONFIRM path at build
  begin
    select mode into v_mode from public.signup_config where id = 1;
    if v_mode = 'public' then
      return '{}'::jsonb;
    elsif v_mode = 'allowlist' then
      if exists (select 1 from public.signup_allowlist where lower(email) = v_email) then
        return '{}'::jsonb;
      end if;
      return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Sign-ups are limited; your email is not on the allowlist.'));
    else -- 'off' or NULL (fail-closed)
      return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Sign-ups are currently closed.'));
    end if;
  end; $$;
  grant execute on function public.before_user_created_hook(jsonb) to supabase_auth_admin;
  revoke execute on function public.before_user_created_hook(jsonb) from authenticated, anon, public;
  grant select on public.signup_config, public.signup_allowlist to supabase_auth_admin;
  ```
- [ ] **Step 2: `signup_config` RLS** (new public table → must have RLS for the #4 invariant): `enable row level security` + a `current_user = 'farmsmart_app'` backend policy for the verbs the app uses (SELECT; UPDATE if a route flips the mode — audit). (supabase_auth_admin's SELECT comes from the grant above, independent of RLS via SECURITY DEFINER... actually the hook runs as its definer/owner — confirm it can read signup_config regardless of RLS; if the owner isn't exempt, add a supabase_auth_admin SELECT policy.)
- [ ] **Step 3: `config.toml`** — uncomment/enable `[auth.hook.before_user_created]`: `enabled = true`, `uri = "pg-functions://postgres/public/before_user_created_hook"`.
- [ ] **Step 4: pgTAP** `00025_signup_enforcement.test.sql` — structural: the function exists (`has_function`), is SECURITY DEFINER, execute granted to supabase_auth_admin + revoked from anon/authenticated; `signup_config` has RLS + the singleton row. Plus **behavioral**: call `public.before_user_created_hook(<synthetic event>)` with `signup_config.mode` set to each of off/allowlist/public × (allowlisted email present / absent) and assert `{}` vs the `{"error":…}` shape. Bump foundation Supabase count.
- [ ] **Step 5: verify** `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -60` (--ignore-health-check/alt-ports; don't touch un-owned containers) — pgTAP green incl. `00025` + foundation counts; api-server suite green. Commit `feat(db): before_user_created signup-enforcement hook + signup_config RLS (TEN-011)`.

### Task 3: app reads mode from DB
**Files:** modify `artifacts/api-server/src/lib/signupMode.ts` + callers (`routes/auth.ts` GET /auth/signup-availability); tests.

- [ ] **Step 1:** Refactor `getSignupMode()` to read `signup_config.mode` from the DB (async; cache per-request or short TTL if hot). Keep `SIGNUP_MODE` env only as the migration seed / documented fallback if the row is missing — DB authoritative. Update `GET /auth/signup-availability` (and any other consumer) to the async DB read so the availability UI matches the hook's enforcement.
- [ ] **Step 2:** Update `auth-availability.test.ts` + add a test that availability reflects `signup_config` (not the env). `pnpm run typecheck` clean. Commit `refactor(api): getSignupMode reads signup_config (single source of truth) (TEN-011)`.

### Task 4: enforcement + bypass tests
**Files:** `artifacts/api-server/src/tests/...` (node:test, disposable stack).

- [ ] **Step 1:** Integration/behavioral proof (where the disposable stack can drive it): with `signup_config.mode='off'` a public signup path is rejected; `allowlist` → non-allowlisted rejected, allowlisted allowed; `public` → allowed. Since real GoTrue `auth.signUp` may not be exercisable in the stack, prove via the hook function directly (as Task 2 Step 4) + assert the app availability read agrees. **Invited-user bypass:** assert `POST /invitations/accept` (admin.createUser path) succeeds regardless of `signup_config.mode` (it never invokes the hook) — the key regression guard.
- [ ] **Step 2:** `pnpm run typecheck` + full disposable-stack green. Commit.

### Task 5: PR + attest + rollout
- [ ] **Step 1:** Push `mt-m2-ten011-signup-enforcement`; PR into `main`; body = Option A design, the hook contract, invited-bypass, the fail-closed/rollback note, and that this unblocks flipping `SIGNUP_MODE`. CI `database-integration` gate.
- [ ] **Step 2: security-compliance attests** — the hook can't be bypassed for public signup, the SECURITY DEFINER grants are least-privilege (execute only to supabase_auth_admin, revoked from anon/authenticated), invited users still work, `signup_config` has RLS, and off/allowlist actually reject. ATTEST to merge.
- [ ] **Step 3: rollout (post-merge, deploy-gated):** the hook activates when `00025` + `config.toml` deploy (staging → prod). Verify on staging: set `signup_config.mode` to each mode, attempt a signup, confirm enforcement + availability agree, confirm an invite still works. **Rollback:** set `[auth.hook.before_user_created] enabled = false` in config.toml (or drop the hook). Only after this is verified is it safe to flip `SIGNUP_MODE`/`signup_config.mode` to `allowlist`/`public`.

## Rollback
Supabase: disable the hook (`config.toml`) + drop the function + drop `signup_config` RLS. Drizzle: drop `signup_config`. App: revert `getSignupMode()` to the env read. No user-data change.

## Open items (pin at build)
- Exact `event` jsonb path for the email in the `pg-functions://` hook form (log once, confirm, remove).
- Whether the hook's owner reads `signup_config`/`signup_allowlist` under RLS or needs an explicit supabase_auth_admin SELECT policy (test it).
- Coexistence with `custom_access_token_hook` (both registered; independent — confirm no config conflict).
