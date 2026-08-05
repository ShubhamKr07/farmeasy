-- supabase/migrations/00008_organization_members_own_row_policy.sql
--
-- The existing "tenant isolation by organization" policy on
-- organization_members (00007) requires app.org_id to already be set -- but
-- resolving a user's own org membership (tenantContext.ts, Task 1 of the
-- MT-M1 plan) is the query that discovers app.org_id in the first place.
-- Under enforced RLS (non-BYPASSRLS role), that lookup would see zero rows.
--
-- This is a SECOND, additive policy scoped to auth.uid() instead of
-- app.org_id -- Postgres unions multiple permissive policies on the same
-- table, so this does not replace or weaken 00007's org-scoped policy; it
-- only ADDS visibility of a user's own single row, which is exactly what
-- the middleware's bootstrap lookup needs and nothing more (a user cannot
-- see other members' rows through this policy -- that still requires
-- app.org_id via the existing policy).
create policy "members can read own membership row"
  on public.organization_members
  for select
  using (user_id = auth.uid());
