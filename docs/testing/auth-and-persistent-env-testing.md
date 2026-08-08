# Testing practice: auth semantics & persistent-environment gates

**Origin:** 2026-08-09. A stale hosted-auth smoke test (`scripts/ci/test-supabase-signup.mjs`)
blocked the staging deploy — and therefore the first-ever production deploy — for days.
The auth system was correct; the test encoded pre-TEN-010/TEN-012 expectations and one
PostgREST-semantics bug. The diagnosis below became four standing rules.

## What went wrong

- The signup smoke test is the **only** test that asserts hosted-auth semantics
  (the GoTrue confirmation pipeline, the `custom_access_token_hook` claim, and
  client role-escalation blocking). It runs **only in `deploy-staging`**
  (post-merge `workflow_run` on `main`), never in PR CI.
- TEN-010 repointed the hook (`user_role` now derived from
  `organization_members.role`, **omitted** when there is no active membership).
  TEN-012 moved org provisioning to **wizard bootstrap**, so a fresh signup has
  no membership — hence no `user_role` claim. The smoke test still asserted
  `user_role == 'technician'` (the old `public.users.role` behavior). Nothing ran
  it against those PRs, so the assertions were never updated.
- Its role-escalation check asserted that an RLS-denied `UPDATE` **errors**. Under
  PostgREST an RLS-filtered `UPDATE` returns **success with 0 rows** — no error.
  The assertion therefore verified a proxy, not the mechanism, and passed/failed
  for the wrong reason.
- The behavior surfaced only post-merge, and only after unrelated blockers
  (migrations, OTP delivery) were cleared — so the staleness stayed hidden until
  it was the last red gate.

## Standing rules

### 1. Changing auth/claims/RLS semantics requires a dependent-assertion sweep
When a change touches an auth hook, an RLS policy, a grant, or provisioning
timing, grep **every** test — especially persistent-env smoke/e2e — for
assertions that encode the *old* semantics, and update them in the **same**
change/PR. A migration that alters `custom_access_token_hook`, a `*_rls_*`
policy, or when a row is created is not done until its downstream assertions are
swept. Call this out in review of any such migration.

### 2. Every post-merge-only gate needs a PR-time analog
Anything that can only fail in `deploy-staging`/`deploy-production` (post-merge)
must have a PR-time equivalent wherever the disposable stack can run it. The
disposable Supabase stack has GoTrue + the hook + RLS, so auth **semantics**
(claim omission with no membership, claim presence with a seeded membership,
client cannot escalate role) can and should be asserted in a PR-time integration
test. Reserve the hosted smoke test for what only the hosted wiring can prove:
SMTP/Mailosaur delivery, DNS/DKIM, real Render services live at the deployed SHA.

### 3. Negative-authorization tests assert the end-state, not the absence of an error
"No error" ≠ "operation blocked". Under RLS + PostgREST a denied `UPDATE`/`DELETE`
returns success with 0 rows; a denied `INSERT` may error, but a denied
`SELECT`/`UPDATE` usually does not. Any test that claims "X cannot do Y" must
observe the **end-state** (re-read the row/role/count with an authoritative
connection and assert it is unchanged), never merely that the call did not throw.

### 4. Persistent environments are a tested surface, not an assumption
Staging/production schema state is not guaranteed to match `main` just because
migrations exist in the repo. The scheduled migration-drift check
(`.github/workflows/migration-drift-check.yml`) enforces staging parity; run the
same `scripts/ci/check-migration-drift.mjs` against a persistent env before
trusting any test result gathered from it, and before promoting to production.

## See also

- `docs/runbooks/mt-m1-rls-role-rotation.md` — real RLS/grant gaps only surface
  under a non-`BYPASSRLS` role; the same "tested surface" logic applies to roles.
- `scripts/ci/check-migration-drift.mjs` — drift detector for rule 4.
- `scripts/ci/test-supabase-signup.mjs` — the hosted smoke test (rule 2's
  "hosted wiring only" target after semantics move to a PR-time test).
