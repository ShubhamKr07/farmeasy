-- supabase/migrations/00009_users_backend_role_policy.sql
--
-- public.users's RLS (00002) is auth.uid()-only -- designed for the mobile
-- client talking to Supabase directly with the end user's own JWT (auth.uid()
-- populated by Supabase's connection-level JWT claims). The api-server
-- backend is a different consumer: it verifies the caller's JWT itself and
-- queries usersTable over its own pooled connection (farmsmart_app, MT-M1
-- Task 13), which never sets auth.uid() -- that GUC is only ever populated by
-- Supabase's own PostgREST/Auth stack, not by this Express server. Under the
-- previous postgres/service_role connection (BYPASSRLS) this never mattered;
-- under farmsmart_app (no BYPASSRLS, by design) every real read/update of
-- usersTable in facilities.ts, facility-readiness.ts, sensor-accounts.ts, and
-- wizard.ts would otherwise be rejected.
--
-- Two SECOND, additive policies (Postgres unions multiple permissive
-- policies on the same table/command) scoped to current_user instead of
-- auth.uid() -- same pattern as 00008's organization_members fix. Does not
-- replace or weaken 00002's own-row policies; only adds visibility/update for
-- the backend's own trusted role. No INSERT policy: the backend never
-- inserts into usersTable directly (handle_new_user(), 00004, owns that
-- path) -- only SELECT and UPDATE are exercised by real routes.
create policy "backend service role can read any row"
  on public.users
  for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can update any row"
  on public.users
  for update
  using (current_user = 'farmsmart_app')
  with check (current_user = 'farmsmart_app');
