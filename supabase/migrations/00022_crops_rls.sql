-- crops org-scoped hybrid RLS (MT-M2 batch 3). ROLE-AGNOSTIC GUC policies
-- (no current_user / no TO clause) so BOTH farmsmart_app AND the task-#5
-- farmsmart_recommender role are scoped by app.org_id once they set the GUC.
-- System crops (organization_id IS NULL) are readable by every tenant.
--
-- Unlike Batches 1/2 (facilities, and the 10 backend-bootstrap tables),
-- crops is NOT bootstrap-read -- crops.ts's GET/POST always run under
-- withTenantScope (this batch's Task 3 rewire), which sets app.org_id
-- before every query, so a GUC-scoped policy (not a current_user backstop)
-- is both available and required here: task #5's farmsmart_recommender role
-- must also read system+own crops, and a current_user = 'farmsmart_app'
-- clause would exclude it. Do NOT add current_user or a TO clause to these
-- policies -- see the design spec (Batch 3) and this migration's own commit
-- message for the #5 compatibility requirement.
--
-- Cast idiom matches 00013/00019: NULLIF(current_setting(...), '') guards
-- against the empty-string placeholder resting state a pooled backend can
-- expose (see 00013's header for the full empirical writeup) -- casting
-- ''::int throws instead of evaluating to NULL/false.
--
-- Existing ~5 rows keep organization_id = NULL (system crops); no seeding
-- or backfill needed.
--
-- Rollback:
--   drop policy "crops readable: system or own org" on public.crops;
--   drop policy "crops insert own org" on public.crops;
--   drop policy "crops update own org" on public.crops;
--   drop policy "crops delete own org" on public.crops;
--   alter table public.crops disable row level security;

alter table public.crops enable row level security;

create policy "crops readable: system or own org" on public.crops for select
  using (organization_id is null or organization_id = nullif(current_setting('app.org_id', true), '')::int);

create policy "crops insert own org" on public.crops for insert
  with check (organization_id = nullif(current_setting('app.org_id', true), '')::int);

create policy "crops update own org" on public.crops for update
  using (organization_id = nullif(current_setting('app.org_id', true), '')::int)
  with check (organization_id = nullif(current_setting('app.org_id', true), '')::int);

create policy "crops delete own org" on public.crops for delete
  using (organization_id = nullif(current_setting('app.org_id', true), '')::int);
