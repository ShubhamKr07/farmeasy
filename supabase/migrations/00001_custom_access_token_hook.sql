create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb;
  user_role public.user_role;
begin
  select role into user_role from public.users where id = (event->>'user_id')::uuid;

  claims := event->'claims';

  if user_role is not null then
    claims := jsonb_set(claims, '{user_role}', to_jsonb(user_role));
  else
    claims := jsonb_set(claims, '{user_role}', '"technician"');
  end if;

  event := jsonb_set(event, '{claims}', claims);
  return event;
end;
$$;

grant execute on function public.custom_access_token_hook to supabase_auth_admin;

revoke execute on function public.custom_access_token_hook from authenticated, anon, public;

-- The function is SECURITY DEFINER (runs as its owner, not the caller) so it
-- can read public.users regardless of RLS -- but supabase_auth_admin (the
-- role that actually invokes hook functions) still needs table-level SELECT
-- independent of that. Missing this grant was a real bug: it went
-- undetected until the hook was registered in the dashboard and activated
-- against a real sign-in, which then failed outright with a 500
-- ("Error running hook URI") for every user, not just ones without a role.
grant select on public.users to supabase_auth_admin;
