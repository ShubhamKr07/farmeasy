-- TEN-010: repoint the access-token hook from the deprecated public.users.role
-- (operational axis: technician|supervisor|quality_lead|facility_lead) to the
-- org membership role (owner|admin|technician) — the single source of truth
-- per ADR-005. The claim KEY stays `user_role` (so client claim-readers don't
-- change their key), only the VALUE source + domain changes. Absent active
-- membership -> the claim is omitted (client defaults to the restricted role).
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb;
  member_role public.org_member_role;
begin
  select role into member_role
    from public.organization_members
    where user_id = (event->>'user_id')::uuid
      and status = 'active'
    limit 1;

  claims := event->'claims';

  if member_role is not null then
    claims := jsonb_set(claims, '{user_role}', to_jsonb(member_role));
  else
    claims := claims - 'user_role';
  end if;

  event := jsonb_set(event, '{claims}', claims);
  return event;
end;
$$;

grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
-- supabase_auth_admin needs table SELECT independent of SECURITY DEFINER (same
-- lesson as 00001's public.users grant -- omitting this 500s every sign-in).
grant select on public.organization_members to supabase_auth_admin;
