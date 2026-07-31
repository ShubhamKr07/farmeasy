-- pgTAP assertions for Task 1: the auth-profile trigger, role-escalation
-- prevention, and the duplicate-only legacy INSERT policy.
--
-- Run inside a transaction that is always rolled back, so assertions leave no
-- side effects. Invoked by:
--   supabase test db --db-url $TEST_DATABASE_URL $ROOT/supabase/tests
--
-- pgTAP itself runs as the postgres superuser (bypasses RLS). Where we need to
-- exercise RLS as anon/authenticated, we SET LOCAL ROLE and set the
-- request.jwt.claims config that auth.uid() reads from.
--
-- NOTE on TAP emission: pgTAP's assertion functions (is/ok/pass/fail/...)
-- return their `ok N - ...` line as a TEXT return value; psql / pg_prove only
-- surface return values that are *displayed* via a top-level SELECT. A
-- `PERFORM` inside a DO block discards the value, and `RAISE NOTICE` is sent
-- to stderr which the TAP harness does not parse. Because several of these
-- tests need procedural logic (exception handlers, SET LOCAL ROLE), they run
-- in DO blocks. To get their TAP lines onto stdout we buffer each assertion's
-- return value into a TEMP table and SELECT it at the end. The assertions
-- still call pgTAP's real is()/ok()/pass()/fail() so the internal test
-- counter increments and finish() validates the plan.
BEGIN;

SELECT plan(11);

-- Buffer for TAP lines emitted from inside DO blocks. The seq column preserves
-- insertion order so the final SELECT emits `ok N - ...` lines in sequence.
create temp table if not exists __tap_lines (seq bigserial primary key, line text not null) on commit drop;

-- ──────────────────────────────────────────────────────────────────────────
-- Helpers
-- ──────────────────────────────────────────────────────────────────────────

-- auth.uid() reads the "sub" claim from request.jwt.claims (or returns NULL
-- when not set). Set a minimal JWT-claims JSON for a given user id.
create or replace function pg_temp.jwt(uid uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', uid,
    'role', 'authenticated'
  )::text, true);
end;
$$;

-- Insert a fresh auth.users row (superuser; bypasses everything but the
-- trigger). raw_app_meta_data / raw_user_meta_data default to '{}'.
create or replace function pg_temp.create_auth_user(new_id uuid, email text, metadata jsonb default '{}')
returns void
language plpgsql
as $$
begin
  -- crypt()/gen_salt() are provided by pgcrypto in the `extensions` schema,
  -- which is NOT on the pgTAP harness's restricted search_path — qualify them
  -- or the DO block aborts the whole transaction and zero tests register.
  insert into auth.users (
    instance_id, id, aud, role, email,
    encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000',
    new_id, 'authenticated', 'authenticated', email,
    extensions.crypt('password123', extensions.gen_salt('bf')), now(),
    '{}'::jsonb, metadata,
    now(), now()
  );
end;
$$;

-- Record an assertion's TAP line so it can be echoed to stdout after the DO
-- blocks finish. The assertion function is still invoked (incrementing
-- pgTAP's internal test counter); its return value is what we buffer.
create or replace function pg_temp.tap(tap_line text)
returns void
language plpgsql
as $$
begin
  insert into __tap_lines (line) values (tap_line);
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Trigger creates exactly one technician profile for a new auth user.
-- ──────────────────────────────────────────────────────────────────────────
do $$
declare
  new_id uuid := '11111111-1111-1111-1111-111111111111';
  profile_count int;
  profile_role public.user_role;
  profile_email text;
begin
  perform pg_temp.create_auth_user(new_id, 'technician-one@example.com');

  select count(*) into profile_count from public.users where id = new_id;
  select role, email into profile_role, profile_email
  from public.users where id = new_id;

  -- exactly one row
  if profile_count = 1
  then perform pg_temp.tap(pass('new auth user gets one public.users row'));
  else perform pg_temp.tap(fail('expected one profile, got ' || coalesce(profile_count::text, 'NULL')));
  end if;

  -- with technician role
  perform pg_temp.tap(is(profile_role, 'technician'::public.user_role,
    'new auth user profile role is technician'));

  -- and the correct email
  perform pg_temp.tap(is(profile_email, 'technician-one@example.com',
    'new auth user profile email is copied from auth.users'));
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Client-supplied raw_user_meta_data.role is ignored.
-- ──────────────────────────────────────────────────────────────────────────
do $$
declare
  new_id uuid := '22222222-2222-2222-2222-222222222222';
  profile_role public.user_role;
begin
  perform pg_temp.create_auth_user(
    new_id, 'escalator@example.com',
    jsonb_build_object('role', 'facility_lead')
  );

  select role into profile_role from public.users where id = new_id;

  perform pg_temp.tap(is(profile_role, 'technician'::public.user_role,
    'client-supplied raw_user_meta_data.role = facility_lead is ignored'));
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. Authenticated self-update cannot modify role (or any column) — the old
--    "users can update their own row (not role)" policy was dropped. There is
--    no table-level UPDATE grant for the authenticated role either, so an
--    authenticated UPDATE raises insufficient_privilege. We assert both that
--    the UPDATE is rejected and the role is unchanged.
-- ──────────────────────────────────────────────────────────────────────────
do $$
declare
  new_id uuid := '33333333-3333-3333-3333-333333333333';
  rejected boolean := false;
begin
  perform pg_temp.create_auth_user(new_id, 'self-update@example.com');

  -- Become this user for the duration of the UPDATE.
  perform pg_temp.jwt(new_id);
  set local role authenticated;

  begin
    update public.users set role = 'facility_lead'::public.user_role where id = new_id;
  exception when insufficient_privilege then
    rejected := true;
  end;

  reset role;

  perform pg_temp.tap(is(rejected, true,
    'authenticated self-update is rejected (no UPDATE policy/grant)'));
end $$;

-- Sanity: confirm the role really is unchanged after the no-op update.
do $$
declare
  new_id uuid := '33333333-3333-3333-3333-333333333333';
  profile_role public.user_role;
begin
  select role into profile_role from public.users where id = new_id;
  perform pg_temp.tap(is(profile_role, 'technician'::public.user_role,
    'role is still technician after denied self-update'));
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. Existing non-technician roles are preserved by the backfill.
--
--    The backfill ran at migration time. We simulate the invariant it must
--    satisfy: a pre-existing non-technician profile (e.g. an exported
--    supervisor) must NOT be overwritten to technician by a replay of the
--    backfill statement (ON CONFLICT DO NOTHING). We let the trigger
--    provision the initial technician row, then (as the privileged test
--    role, bypassing RLS) rewrite the role to supervisor to model a
--    pre-existing exported profile, then run the exact backfill statement.
--    We cannot DISABLE the auth.users trigger here because the pgTAP runner
--    is not the owner of auth.users.
-- ──────────────────────────────────────────────────────────────────────────
do $$
declare
  new_id uuid := '44444444-4444-4444-4444-444444444444';
  profile_role public.user_role;
begin
  -- Trigger provisions the initial technician profile.
  perform pg_temp.create_auth_user(new_id, 'supervisor@example.com');

  -- Model a pre-existing exported supervisor (privileged role bypasses RLS;
  -- UPDATE does not require table ownership, only privileges).
  update public.users
  set role = 'supervisor'::public.user_role
  where id = new_id;

  -- Replay the backfill statement verbatim.
  insert into public.users (id, email, role)
  select id, email, 'technician'::public.user_role
  from auth.users
  on conflict (id) do nothing;

  select role into profile_role from public.users where id = new_id;
  perform pg_temp.tap(is(profile_role, 'supervisor'::public.user_role,
    'existing non-technician role preserved by backfill (ON CONFLICT DO NOTHING)'));
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. handle_new_user() ON CONFLICT updates email but preserves a non-default
--    role when a profile already exists. The trigger body is
--    "insert ... on conflict (id) do update set email = excluded.email" — it
--    deliberately does NOT touch role.
--
--    Because migration 00004 added FK public.users(id) -> auth.users(id), we
--    can no longer pre-seed a public.users row before its auth.users row
--    exists. So we let the trigger provision the initial technician profile,
--    mutate it to quality_lead (privileged role, bypassing RLS), then run the
--    EXACT INSERT ... ON CONFLICT (id) DO UPDATE SET email statement that the
--    SECURITY DEFINER trigger function body executes. This is the precise
--    behaviour under test: a re-fire against an existing non-technician
--    profile must update email and leave role untouched.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  new_id uuid := '55555555-5555-5555-5555-555555555555';
  profile_role public.user_role;
  profile_email text;
begin
  -- Trigger provisions the initial technician profile.
  perform pg_temp.create_auth_user(new_id, 'old-quality@example.com');

  -- Model a pre-existing quality_lead profile (privileged role bypasses RLS).
  update public.users
  set role = 'quality_lead'::public.user_role
  where id = new_id;

  -- Re-fire the trigger body's INSERT against the pre-existing profile.
  insert into public.users (id, email, role)
  values (new_id, 'new-quality@example.com', 'technician'::public.user_role)
  on conflict (id) do update set email = excluded.email;

  select role, email into profile_role, profile_email from public.users where id = new_id;
  perform pg_temp.tap(is(profile_role, 'quality_lead'::public.user_role,
    'handle_new_user() ON CONFLICT preserves existing non-technician role'));
  perform pg_temp.tap(is(profile_email, 'new-quality@example.com',
    'handle_new_user() ON CONFLICT updates email'));
end $$;

-- 6. Legacy INSERT policy: an authenticated client retrying an insert of the
--    exact trigger-created technician row cannot create a SECOND row. Either
--    the unique PK raises 23505 (the legacy policy lets it through) or RLS /
--    privilege denies it outright — either way exactly one row remains and
--    its role is technician.
-- ──────────────────────────────────────────────────────────────────────────
do $$
declare
  new_id uuid := '66666666-6666-6666-6666-666666666666';
  sqlstate_seen text;
  row_count int;
  final_role public.user_role;
begin
  perform pg_temp.create_auth_user(new_id, 'legacy-retry@example.com');

  -- Become the user; profile already exists (trigger created it).
  perform pg_temp.jwt(new_id);
  set local role authenticated;

  begin
    -- Exact retry an installed client does after sign-up.
    insert into public.users (id, email, role)
    values (new_id, 'legacy-retry@example.com', 'technician'::public.user_role);
    sqlstate_seen := '00000';  -- unexpected success
  exception when unique_violation then
    sqlstate_seen := '23505';
  when insufficient_privilege then
    sqlstate_seen := '42501';
  when others then
    sqlstate_seen := 'other:' || sqlstate;
  end;

  reset role;

  -- The retry must never create a duplicate / second profile.
  select count(*), max(role) into row_count, final_role from public.users where id = new_id;

  perform pg_temp.tap(is(row_count, 1,
    'legacy retry never creates a second public.users row'));

  -- Either outcome is acceptable and equally safe:
  --   23505 (unique_violation) — the legacy WITH CHECK policy lets the
  --       duplicate INSERT reach the PK, which rejects it.
  --   42501 (insufficient_privilege) — there is no INSERT grant for the
  --       authenticated/anon roles, so Postgres denies it before the PK is
  --       even consulted (strictly more restrictive than 23505).
  -- Both guarantee exactly one technician row remains (asserted above).
  perform pg_temp.tap(ok(
    sqlstate_seen in ('23505', '42501'),
    'legacy retry of existing technician profile is rejected (got ' || sqlstate_seen || ')'
  ));
end $$;

-- Echo the buffered TAP lines to stdout (as a query result set) so pg_prove
-- sees every `ok N - ...` line, then finalise the plan.
SELECT line FROM __tap_lines ORDER BY seq;

SELECT * FROM finish();
ROLLBACK;
