-- supabase/migrations/00017_ten012_signup_rls_backend_policies.sql
--
-- TEN-012 Task 1 added three sign-up-flow tables (signup_allowlist,
-- access_requests, account_purge_audit) with NO row-level security -- the
-- same class of gap TEN-010's final review caught on invitations (00016):
-- the disposable CI DB is a BYPASSRLS superuser and silently masks a missing
-- RLS backstop. These tables hold PII (waitlist emails, farm names, and
-- purge-audit emails/actions), so shipping them without RLS is exactly the
-- gap this migration closes.
--
-- Fix: enable RLS and grant the backend's own trusted role (farmsmart_app)
-- per-verb access, the SAME current_user-scoped, policy-per-verb pattern as
-- organization_members (00011/00012/00014) and invitations (00016) -- NOT
-- the app.org_id GUC pattern (these tables are not tenant-scoped; signup and
-- purge happen before/outside any org context). The application's own
-- WHERE clauses and route-level checks remain the authorization boundary;
-- RLS here is defense-in-depth against direct anon/authenticated access,
-- already revoked for those roles by RLS being enabled with no permissive
-- policy for them.
--
-- Verb coverage per table matches what each flow actually needs:
--   signup_allowlist: SELECT (availability check) + INSERT (admin add) +
--     DELETE (admin remove) -- no UPDATE path exists for allowlist rows.
--   access_requests: SELECT (list/dedupe) + INSERT (capture request) +
--     UPDATE (mark notified) -- no DELETE path.
--   account_purge_audit: SELECT (read audit trail) + INSERT (record warn/
--     purge actions) -- append-only, no UPDATE or DELETE.

alter table public.signup_allowlist enable row level security;
alter table public.access_requests enable row level security;
alter table public.account_purge_audit enable row level security;

-- signup_allowlist: backend reads (availability) + admin insert/delete.
create policy "backend reads signup_allowlist" on public.signup_allowlist
  for select using (current_user = 'farmsmart_app');
create policy "backend writes signup_allowlist" on public.signup_allowlist
  for insert with check (current_user = 'farmsmart_app');
create policy "backend deletes signup_allowlist" on public.signup_allowlist
  for delete using (current_user = 'farmsmart_app');

-- access_requests: backend upsert (capture) + read/update (notify).
create policy "backend reads access_requests" on public.access_requests
  for select using (current_user = 'farmsmart_app');
create policy "backend inserts access_requests" on public.access_requests
  for insert with check (current_user = 'farmsmart_app');
create policy "backend updates access_requests" on public.access_requests
  for update using (current_user = 'farmsmart_app') with check (current_user = 'farmsmart_app');

-- account_purge_audit: backend inserts (warn/purge) + reads.
create policy "backend reads account_purge_audit" on public.account_purge_audit
  for select using (current_user = 'farmsmart_app');
create policy "backend inserts account_purge_audit" on public.account_purge_audit
  for insert with check (current_user = 'farmsmart_app');
