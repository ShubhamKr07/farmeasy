# Task 2 — Staging Supabase Verifier Report

## What the script does

`scripts/ci/verify-staging-supabase.mjs` is a no-build, run-with-`node` ESM
script that exercises the hosted staging Supabase project end-to-end and then
cleans up after itself. It proves that the Supabase Auth + custom-claim
pipeline landed correctly by:

1. **Signing up** a throwaway user (`verify-staging-supabase-<ts>-<rand>@…`)
   via the anon-key client — the path a real client takes.
2. **OTP step (conditional):** if `STAGING_MAILBOX_API_TOKEN` is *not* set, it
   logs a warning and proceeds with the session returned by `signUp()` (staging
   has email confirmation disabled, so that session is already usable). If the
   token *is* set, OTP retrieval is still **not implemented** — the script only
   leaves a TODO describing the poll-mailbox → `verifyOtp` flow, because no
   concrete mailbox/inbox service has been chosen yet.
3. **Inserting a `public.users` profile row** for the new user with
   `role='facility_lead'` via the service-role client. Staging has no
   profile-creation trigger yet (that's Release 1), so the script owns this
   step. `facility_lead` is deliberately a non-default `user_role` value, so a
   passing check proves the claim path actually reads the row (a default
   `technician` would pass trivially even if the hook were broken).
4. **Refreshing the session** so the `custom_access_token_hook` re-runs
   against the just-inserted row, then **decodes the JWT** (base64, no JWT
   library) and asserts the `user_role` claim equals `facility_lead`. This is
   the **core verification** — it fails loudly if the claim is absent or
   mismatched.
5. **Confirming the `media` storage bucket exists and is public**
   (`storage.listBuckets()`).
6. **Confirming ≥3 migrations** are recorded in
   `supabase_migrations.schema_migrations`.
7. **Cleaning up** in a `finally` block: deletes the `public.users` row, then
   deletes the Auth user (`auth.admin.deleteUser()`), logging each step.

It exits `0` with a success summary if every check passes, or `1` with a clear
failure summary naming which check failed and why. Only `console.log` /
`console.error` are used — no logging framework.

## Env vars

### Required (script exits `1` immediately if any is missing)

| Var | Purpose |
| --- | --- |
| `STAGING_SUPABASE_URL` | Project URL, e.g. `https://<ref>.supabase.co` |
| `STAGING_SUPABASE_ANON_KEY` | Anon/public key — used for `signUp` + `refreshSession` (the client path) |
| `STAGING_SUPABASE_SERVICE_ROLE_KEY` | Service-role key — used for profile insert, bucket/migration checks, and Auth user deletion |

All three are whitespace-stripped on read (Render pastes env vars line-wrapped,
embedding a newline that breaks the `apikey`/`Authorization` header) — mirrors
`artifacts/api-server/src/middlewares/supabaseAuth.ts`.

### Optional

| Var | Purpose |
| --- | --- |
| `STAGING_TEST_EMAIL_DOMAIN` | Domain for the generated test email (default `example.com`) |
| `STAGING_TEST_PASSWORD` | Password for the test user (default: a generated `Verify-Staging-<ts>!Aa1`) |
| `STAGING_MAILBOX_API_TOKEN` | If set, the script notes OTP retrieval *could* run — but it's still not implemented (TODO only). If unset, OTP is skipped with a warning. |
| `DEBUG` | If set, prints the JS stack on an aborting exception. |

## Exact command to run it

From the monorepo root:

```bash
STAGING_SUPABASE_URL=https://<project-ref>.supabase.co \
STAGING_SUPABASE_ANON_KEY=eyJ... \
STAGING_SUPABASE_SERVICE_ROLE_KEY=eyJ... \
node scripts/ci/verify-staging-supabase.mjs
```

With the optional vars:

```bash
STAGING_SUPABASE_URL=https://<project-ref>.supabase.co \
STAGING_SUPABASE_ANON_KEY=eyJ... \
STAGING_SUPABASE_SERVICE_ROLE_KEY=eyJ... \
STAGING_TEST_EMAIL_DOMAIN=staging.farmsmart.app \
STAGING_TEST_PASSWORD='Staging-Verify-2026!Aa1' \
node scripts/ci/verify-staging-supabase.mjs
```

**Do not run this against production** — it creates and deletes real Auth
users. The script also requires `@supabase/supabase-js` v2 to be resolvable
from the repo root (it is — `@supabase/supabase-js@2.110.8` is installed via
pnpm for the `artifacts/*` packages and hoisted to the workspace store).

## Implementation notes

- **Why `facility_lead`:** the `user_role` enum is
  `technician | supervisor | quality_lead | facility_lead`, with `technician`
  as the column default and the hook's fallback. Asserting a non-default value
  means a passing check can only happen if the hook genuinely read the
  `public.users` row — a broken/missing hook would yield `technician` and fail.
- **Why refresh after the profile insert:** the access token minted at
  `signUp()` is produced *before* the `public.users` row exists, so its
  `user_role` would be the hook default. `refreshSession()` forces a fresh
  token through the hook with the row present.
- **Custom claim key is `user_role`**, set by
  `supabase/migrations/00001_custom_access_token_hook.sql`
  (`jsonb_set(claims, '{user_role}', …)`).
- **JWT decode** uses only `Buffer.from(b64, "base64")` after base64url→base64
  translation — no `jsonwebtoken` / `jose` dependency.
- **No profile-creation trigger assumed** — the script inserts the profile row
  itself via the service-role client, matching staging's current state. When
  Release 1 adds the trigger, this insert becomes redundant but harmless.
- **Core-check failure is non-aborting:** if the `user_role` claim doesn't
  match, the script still runs the bucket + migration checks so the summary is
  maximally useful, then exits `1`.
- **Cleanup is unconditional:** the `finally` block deletes the profile row
  and the Auth user regardless of pass/fail/abort, so no test artifacts linger.
- **Verified syntax-only** via `node --check scripts/ci/verify-staging-supabase.mjs`
  (per instructions, the script was not run against any real Supabase project).
