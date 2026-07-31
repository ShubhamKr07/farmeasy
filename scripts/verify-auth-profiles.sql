-- Verification queries for the auth-profile trigger (Task 1, Step 7).
--
-- Run after applying 00004_create_auth_profiles.sql against the target DB:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-auth-profiles.sql
--
-- Each query is annotated with the invariant it checks and the expected
-- result. Unlike the pgTAP suite (which rolls back), this is meant to be run
-- against a live (staging/production) DB and is read-only: it only SELECTs.

\set ON_ERROR_STOP on
\echo ''
\echo '==== 1. on_auth_user_created trigger is installed on auth.users ===='
select
  t.tgname as trigger_name,
  pg_get_triggerdef(t.oid) as trigger_definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'auth' and c.relname = 'users'
  and not t.tgisinternal
order by t.tgname;
\echo 'Expected: a single "on_auth_user_created" AFTER INSERT row.'

\echo ''
\echo '==== 2. private functions are SECURITY DEFINER with search_path = "" ===='
-- proconfig is a text[] of "GUC=value"; look for 'search_path=' entries.
select
  p.proname as function_name,
  case when p.prosecdef then 'YES' else 'NO' end as security_definer,
  coalesce(array_to_string(p.proconfig, ', '), '(none)') as function_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'private'
  and p.proname in ('handle_new_user', 'profile_already_exists')
order by p.proname;
\echo 'Expected: both security_definer = YES, function_settings contains search_path="".'

\echo ''
\echo '==== 3. private.handle_new_user() / profile_already_exists() grants ===='
-- No public/anon/authenticated execute on handle_new_user (trigger-only).
-- anon/authenticated CAN execute profile_already_exists.
select
  n.nspname as schema,
  p.proname as function_name,
  r.rolname as grantee,
  pg_get_userprivoptions(p.proacl, r.oid) as options,
  case when has_function_privilege(r.oid, p.oid, 'execute') then 'YES' else 'NO' end as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('anon'::name), ('authenticated'::name), ('public'::name)) as r(rolname)
join pg_roles on pg_roles.rolname = r.rolname
where n.nspname = 'private'
  and p.proname in ('handle_new_user', 'profile_already_exists')
order by p.proname, r.rolname;
\echo 'Expected: handle_new_user -> all NO. profile_already_exists -> anon/authenticated YES, public NO.'

\echo ''
\echo '==== 4. Every auth.users row has exactly one public.users row ===='
select
  (select count(*) from auth.users) as auth_users,
  (select count(*) from public.users) as public_users,
  (
    select count(*)
    from auth.users au
    left join public.users pu on pu.id = au.id
    where pu.id is null
  ) as auth_without_profile,
  (
    select count(*)
    from public.users pu
    left join auth.users au on au.id = pu.id
    where au.id is null
  ) as profile_without_auth;
\echo 'Expected: auth_without_profile = 0 and profile_without_auth = 0.'

\echo ''
\echo '==== 5. Role distribution (backfill must preserve existing roles) ===='
select role, count(*) from public.users group by role order by role;
\echo 'Expected: known roles only (technician/supervisor/quality_lead/facility_lead); no NULLs.'

\echo ''
\echo '==== 6. Old UPDATE policy removed; legacy INSERT policy in place ===='
select
  polname as policy_name,
  cmd as policy_cmd,
  array_to_string(roles, ', ') as to_roles,
  qual as using_expr,
  with_check as with_check_expr
from pg_policies
where schemaname = 'public' and tablename = 'users'
order by polname;
\echo 'Expected: NO "users can update their own row (not role)" policy.'
\echo '         "temporary legacy signup duplicate" INSERT policy present.'

\echo ''
\echo '==== 7. FK public.users(id) -> auth.users(id) ON DELETE CASCADE ===='
select
  con.conname as constraint_name,
  cl_from.relname as child_table,
  cl_to.relname as parent_table,
  con.confdeltype as on_delete  -- 'c' = cascade
from pg_constraint con
join pg_class cl_from on cl_from.oid = con.conrelid
join pg_class cl_to on cl_to.oid = con.confrelid
where con.contype = 'f'
  and cl_from.relname = 'users'
  and cl_to.relname = 'users';
\echo 'Expected: "users_id_auth_users_id_fk", on_delete = c (cascade).'

\echo ''
\echo '==== 8. FK integrity: no public.users row dangles ===='
select pu.id, pu.email
from public.users pu
left join auth.users au on au.id = pu.id
where au.id is null;
\echo 'Expected: zero rows (the FK would otherwise reject the migration).'

\echo ''
\echo 'Verification complete.'
