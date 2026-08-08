-- 00018_organizations_backend_delete_policy.sql
--
-- TEN-012 farmsmart_app RLS proof caught this: the unverified-account purge
-- (purgeUnverified.ts) deletes the data-less org auto-provisioned for an
-- unverified user via `db.delete(organizations)` on the ungated backend
-- connection — a scheduled sweep, not a request inside a tenant scope, so
-- app.org_id is never set and 00007's GUC-based FOR ALL policy can't admit it.
-- organizations had backend current_user policies for SELECT + INSERT (00010)
-- but NO DELETE policy, so under the real non-BYPASSRLS farmsmart_app role the
-- purge's org delete silently affected ZERO rows (RLS-denied) and the org
-- survived. The disposable CI DB is a BYPASSRLS superuser and masked this —
-- exactly the class of gap 00014 (org_members UPDATE) and 00016 (invitations
-- RLS) closed for their tables.
--
-- Additive current_user-scoped DELETE policy, same pattern as
-- 00011/00012/00014/00016/00017. The application's own logic is the
-- authorization boundary (the purge deletes only unverified, >=10-day-old
-- accounts whose owner org has zero facilities); this policy is the
-- defense-in-depth backstop that lets that one intended delete succeed under
-- the backend's own non-BYPASSRLS role.
create policy "backend service role can delete organizations"
  on public.organizations
  for delete
  using (current_user = 'farmsmart_app');
