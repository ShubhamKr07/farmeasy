alter table public.organizations enable row level security;
alter table public.wizard_progress enable row level security;
alter table public.sensor_accounts enable row level security;
alter table public.facility_readiness_events enable row level security;
alter table public.wizard_events enable row level security;

revoke all on public.organizations from anon, authenticated;
revoke all on public.wizard_progress from anon, authenticated;
revoke all on public.sensor_accounts from anon, authenticated;
revoke all on public.facility_readiness_events from anon, authenticated;
revoke all on public.wizard_events from anon, authenticated;
