-- supabase/migrations/00011_organization_members_backend_insert_policy.sql
--
-- 00007's bare-USING tenant-isolation policy on organization_members applies
-- to INSERT too (no WITH CHECK given -> USING doubles as the check, per that
-- migration's own comment): a new row's organization_id must already equal
-- current_setting('app.org_id'). POST /facilities (facilities.ts) inserts the
-- owner membership row in the SAME transaction that creates the organization
-- itself -- app.org_id can't be set to an org id that doesn't exist until
-- this transaction commits, so the existing policy can never admit this
-- insert. 00008 already solved the equivalent bootstrap problem for SELECT
-- (a user's own-row read, before app.org_id is known); this is the same gap
-- for INSERT.
--
-- Additive current_user-scoped policy, same pattern as 00009/00010: the
-- backend's own trusted role may insert (application code is the actual
-- authorization boundary for who gets a membership row, not this policy --
-- RLS here is defense-in-depth against direct anon/authenticated access,
-- already revoked by 00007).
create policy "backend service role can insert organization members"
  on public.organization_members
  for insert
  with check (current_user = 'farmsmart_app');
