-- AUTH-004: Auth surface telemetry (sign-in/reset/sign-up funnel)
-- Append-only event log, no PII beyond user_id (and user_id is nullable for unauthenticated events)

create type auth_event_type as enum (
  'signin_success',
  'signin_failed',
  'reset_request',
  'reset_complete',
  'signup_start',
  'signup_complete'
);

create table auth_events (
  id serial primary key,
  user_id uuid references auth.users (id),
  event_type auth_event_type not null,
  reason text,
  occurred_at timestamp not null default now()
);

comment on table auth_events is 'AUTH-004: append-only auth funnel telemetry; allows unauthenticated events (user_id nullable)';
comment on column auth_events.reason is 'Optional error reason for signin_failed or other failure events';

-- Same model as facilities 00020 / organizations 00010 / organization_members
-- 00012 / invitations 00016: admit only the backend role. The /auth-events
-- endpoint is the sole writer (fire-and-forget telemetry, rate-limited); no
-- client ever reads this table directly today, so only an INSERT policy is
-- needed for the verb actually used.
-- Rollback:
--   drop policy "backend service role can insert auth_events" on public.auth_events;
--   alter table public.auth_events disable row level security;

alter table public.auth_events enable row level security;

create policy "backend service role can insert auth_events"
  on public.auth_events for insert
  with check (current_user = 'farmsmart_app');
