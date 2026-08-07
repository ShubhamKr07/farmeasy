-- Backend UPDATE policy on organization_members for the farmsmart_app role
-- (TEN-010). 00011 added INSERT and 00012 added SELECT for this role; the
-- membership UPSERT in the invite-accept flow (invitationsAccept.ts, ungated
-- -- the invitee is not a member yet, so app.org_id can't be set via
-- withTenantScope) needs UPDATE for its re-join-after-removal conflict path.
-- The app's own WHERE clauses scope the write; same current_user-scoped
-- pattern as 00011/00012.
create policy "backend service role can update organization members"
  on public.organization_members
  for update
  using (current_user = 'farmsmart_app')
  with check (current_user = 'farmsmart_app');
