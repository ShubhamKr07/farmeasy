-- pgTAP assertions for Task 8 (TEN-010): custom_access_token_hook repointed
-- from the deprecated public.users.role to organization_members.role for the
-- caller's ACTIVE membership. The claim KEY stays `user_role`; the VALUE
-- domain changes from user_role (technician|supervisor|quality_lead|
-- facility_lead) to org_member_role (owner|admin|technician). Absent active
-- membership -> the claim key is omitted entirely (not defaulted), so a
-- client reading a missing `user_role` falls back to its own restricted
-- default rather than trusting a stale/synthetic value.
--
-- NOTE on TAP emission: pgTAP's assertion functions (is/ok/...) return their
-- `ok N - ...` line as a TEXT value that only surfaces via a top-level
-- SELECT (see 00004_auth_profiles.test.sql's note on this) -- so unlike that
-- file, this test avoids PERFORM-inside-DO-block for the assertions
-- themselves; setup (org/user/membership seeding) uses plain top-level
-- INSERT/SELECT statements instead of DO blocks, and each assertion is its
-- own top-level `SELECT is(...)`.
--
-- Run inside a transaction that is always rolled back, so these assertions
-- leave no side effects on the database. Invoked by:
--   supabase test db --db-url $TEST_DATABASE_URL $ROOT/supabase/tests
BEGIN;

SELECT plan(3);

-- Insert a fresh auth.users row (superuser; bypasses everything but the
-- handle_new_user() trigger, which provisions the matching public.users row
-- -- see 00004_create_auth_profiles.sql / 00004_auth_profiles.test.sql).
-- crypt()/gen_salt() are provided by pgcrypto in the `extensions` schema,
-- which is NOT on the pgTAP harness's restricted search_path -- qualify it.
create or replace function pg_temp.create_auth_user(new_id uuid, email text)
returns void
language plpgsql
as $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email,
    encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000',
    new_id, 'authenticated', 'authenticated', email,
    extensions.crypt('password123', extensions.gen_salt('bf')), now(),
    '{}'::jsonb, '{}'::jsonb,
    now(), now()
  );
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- Seed: two orgs, three auth users (which fan out to public.users profiles
-- via the trigger), and two organization_members rows -- one active admin,
-- one removed owner. The third user gets no membership row at all.
-- ──────────────────────────────────────────────────────────────────────────
insert into public.organizations (name) values ('Task 8 Test Org (active)');
insert into public.organizations (name) values ('Task 8 Test Org (removed)');

select pg_temp.create_auth_user('77777777-7777-7777-7777-777777777771', 'active-admin@example.com');
select pg_temp.create_auth_user('77777777-7777-7777-7777-777777777772', 'no-membership@example.com');
select pg_temp.create_auth_user('77777777-7777-7777-7777-777777777773', 'removed-member@example.com');

insert into public.organization_members (organization_id, user_id, role, status)
select id, '77777777-7777-7777-7777-777777777771'::uuid, 'admin', 'active'
from public.organizations where name = 'Task 8 Test Org (active)';

insert into public.organization_members (organization_id, user_id, role, status)
select id, '77777777-7777-7777-7777-777777777773'::uuid, 'owner', 'removed'
from public.organizations where name = 'Task 8 Test Org (removed)';

-- ──────────────────────────────────────────────────────────────────────────
-- 1. A user with an active organization_members row gets the ORG role
--    ('admin') as the `user_role` claim value -- not their (irrelevant, and
--    default-technician) public.users.role.
-- ──────────────────────────────────────────────────────────────────────────
SELECT is(
  (public.custom_access_token_hook(
    jsonb_build_object('user_id', '77777777-7777-7777-7777-777777777771', 'claims', '{}'::jsonb)
  ))->'claims'->>'user_role',
  'admin',
  'active org member gets organization_members.role as the user_role claim'
);

-- ──────────────────────────────────────────────────────────────────────────
-- 2. A user with NO organization_members row at all gets no `user_role`
--    claim key (omitted, not defaulted to a stale value).
-- ──────────────────────────────────────────────────────────────────────────
SELECT is(
  (public.custom_access_token_hook(
    jsonb_build_object('user_id', '77777777-7777-7777-7777-777777777772', 'claims', '{}'::jsonb)
  ))->'claims' ? 'user_role',
  false,
  'user with no organization membership gets no user_role claim key'
);

-- ──────────────────────────────────────────────────────────────────────────
-- 3. A user whose only organization_members row is 'removed' (not active)
--    is treated the same as no membership -- the claim key is omitted.
-- ──────────────────────────────────────────────────────────────────────────
SELECT is(
  (public.custom_access_token_hook(
    jsonb_build_object('user_id', '77777777-7777-7777-7777-777777777773', 'claims', '{}'::jsonb)
  ))->'claims' ? 'user_role',
  false,
  'user whose only membership is removed (not active) gets no user_role claim key'
);

SELECT * FROM finish();
ROLLBACK;
