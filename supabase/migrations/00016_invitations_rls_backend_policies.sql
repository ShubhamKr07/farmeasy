-- supabase/migrations/00016_invitations_rls_backend_policies.sql
--
-- TEN-010 final-review gap: the invitations table (Drizzle DDL
-- lib/db/drizzle/0029_invitations.sql) shipped with NO row-level security --
-- it was the only tenant-scoped table in the schema without an RLS backstop,
-- and it stores invite TOKEN HASHES. Every other tenant table gets RLS via
-- 00007; organization_members additionally gets current_user-scoped backend
-- policies in 00008/00011/00012/00014. Cross-tenant isolation on invitations
-- was therefore resting ENTIRELY on app-layer WHERE clauses (org-filtered
-- list/delete, requireRole('owner','admin') gating, and a 256-bit single-use
-- token on accept) with zero defense-in-depth at the database. Not exploitable
-- as shipped, but it breaks the project's stated invariant that correctness
-- must hold under the non-BYPASSRLS farmsmart_app role (the disposable CI DB is
-- a BYPASSRLS superuser and silently masks exactly this class of gap).
--
-- Fix: enable RLS and grant the backend's own trusted role (farmsmart_app)
-- per-verb access, the SAME current_user-scoped, policy-per-verb pattern as
-- organization_members (00011 INSERT / 00012 SELECT / 00014 UPDATE) -- NOT the
-- app.org_id GUC pattern that 00007/withTenantScope use. current_user scoping
-- is required here because the invite-accept flow (invitationsAccept.ts) is
-- ungated: the invitee has no tenant yet, so app.org_id can never be set for
-- its SELECT-by-token-hash + UPDATE (atomic single-use claim, revert-on-error)
-- to satisfy a GUC policy. The application's own WHERE clauses remain the
-- authorization boundary (who may create/list/revoke/accept); RLS here is
-- defense-in-depth against direct anon/authenticated access, already revoked
-- for these roles by RLS being enabled with no permissive policy for them.
--
-- All four verbs are needed: invitations.ts does INSERT (create, upsert),
-- SELECT (list + one-org check), UPDATE (upsert conflict path), DELETE
-- (revoke); invitationsAccept.ts does SELECT (token lookup) + UPDATE (claim,
-- expire, revert).

alter table public.invitations enable row level security;

create policy "backend service role can read invitations"
  on public.invitations
  for select
  using (current_user = 'farmsmart_app');

create policy "backend service role can insert invitations"
  on public.invitations
  for insert
  with check (current_user = 'farmsmart_app');

create policy "backend service role can update invitations"
  on public.invitations
  for update
  using (current_user = 'farmsmart_app')
  with check (current_user = 'farmsmart_app');

create policy "backend service role can delete invitations"
  on public.invitations
  for delete
  using (current_user = 'farmsmart_app');
