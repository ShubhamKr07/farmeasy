-- Task 1: Stop role escalation and install the profile-provisioning trigger.
--
-- Before this migration, new public.users rows were self-inserted by the
-- (anon-key) client immediately after supabase.auth.signUp(), with the role
-- taken straight from raw_user_meta_data.role. That let any caller mint a
-- facility_lead / supervisor / quality_lead row by supplying metadata at
-- sign-up — a direct privilege-escalation path.
--
-- This migration flips provisioning to a SECURITY DEFINER trigger that runs
-- AFTER INSERT on auth.users and always writes role = 'technician'. Client
-- metadata is ignored entirely. The old self-UPDATE policy (which allowed
-- changing every column except role was the intent, but the policy actually
-- only constrained the row to still belong to the caller — it did NOT pin
-- role) is dropped, so authenticated users can no longer modify role (or any
-- other column) on their own row directly through PostgREST.
--
-- A narrow, temporary legacy INSERT policy is retained so already-installed
-- mobile builds (which retry public.users.insert after sign-up and accept
-- SQLSTATE 23505) keep working: the retry only succeeds if the trigger has
-- ALREADY created the exact technician row, i.e. it can never create or
-- repair a missing profile. Task 3 removes this helper + policy once the
-- adoption gate clears.

-- ── Step 3: race-safe provisioning ────────────────────────────────────────

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email, role)
  values (new.id, new.email, 'technician'::public.user_role)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

revoke execute on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_user();

insert into public.users (id, email, role)
select id, email, 'technician'::public.user_role
from auth.users
on conflict (id) do nothing;

drop policy if exists "users can update their own row (not role)" on public.users;

alter table public.users
  add constraint users_id_auth_users_id_fk
  foreign key (id) references auth.users(id) on delete cascade;

-- ── Step 4: duplicate-only legacy compatibility policy ────────────────────
--
-- Installed clients retry public.users.insert after Auth signup and accept
-- SQLSTATE 23505. Permit the retry only when the trigger-created profile
-- already exists; anonymous callers must never repair or create a missing
-- profile.

create or replace function private.profile_already_exists(candidate_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.users
    where id = candidate_id
  );
$$;

revoke all on function private.profile_already_exists(uuid) from public;
grant usage on schema private to anon, authenticated;
grant execute on function private.profile_already_exists(uuid) to anon, authenticated;

drop policy if exists "users can insert their own row" on public.users;
create policy "temporary legacy signup duplicate"
on public.users for insert
to anon, authenticated
with check (
  role = 'technician'::public.user_role
  and private.profile_already_exists(id)
);
