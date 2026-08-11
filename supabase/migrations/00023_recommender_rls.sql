-- MT-M2 task #5: RLS on the two remaining no-RLS public tables the
-- recommender touches (recommender_cache, recommender_queries), plus a
-- recommender-read SELECT policy on bad_tray_entries (Batch 2, 00021,
-- shipped it with only a farmsmart_app policy, which does NOT admit the
-- new farmsmart_recommender role). This closes task #4's last no-RLS gap.
--
-- Context: the recommender moves off postgres/BYPASSRLS onto a dedicated,
-- least-privilege, non-BYPASSRLS farmsmart_recommender role (runbook:
-- docs/runbooks/recommender-rls-role-rotation.md). It grounds ONLY on the
-- querying user's own tenant + global/system reference data (never
-- cross-tenant) by setting app.org_id/app.facility_id per request (like
-- withTenantScope) before its reads -- 00007's tenant-isolation policies and
-- 00022's crops policy are already ROLE-AGNOSTIC (no current_user, no TO
-- clause), so farmsmart_recommender is scoped by them for free once it sets
-- the GUC. It needs no new policy on growth_profiles/cycles/crops -- only
-- SELECT grants (see the role-rotation runbook's read-table audit).
--
-- recommender_cache -- a GLOBAL cache of external web-search content (not
-- tenant data, no organization_id/facility_id column at all): policy admits
-- BOTH farmsmart_recommender (search_cache/upsert_cache_docs, cache_repo.py/
-- embed_upsert.py) and farmsmart_app (in case the api-server ever reads it
-- directly) for SELECT + INSERT. Not tenant-scoped -- there is no tenant
-- column to scope by, and the content itself is not customer data.
--
-- recommender_queries -- a PER-USER query audit log (user_id, question,
-- answer, sources, farm_context_used). The recommender's write path
-- (query_log.py) has no auth.uid() (it authenticates to Postgres as its own
-- backend role, not as the end user via Supabase Auth), so the scoping model
-- here mirrors every other backend-role policy in this codebase
-- (current_user = 'farmsmart_recommender'), NOT a user_id = auth.uid() policy
-- -- the app layer (query_log.py's explicit user_id column/parameter) is what
-- scopes reads by user, same division of labor as withTenantScope's
-- app.org_id GUC vs the app's own WHERE clauses elsewhere in this codebase.
--
-- bad_tray_entries -- add a current_user = 'farmsmart_recommender' SELECT
-- policy (decision: option (a) from the design spec, not (b) drop). Left
-- UNSCOPED at the row level (no facility_id predicate) -- this is
-- acceptable because farm_context.py only ever reads bad_tray_entries via
-- `JOIN cycles`, and cycles carries 00007's `facility_id = app.facility_id`
-- policy, which DOES scope the join to the querying tenant's own cycles (and
-- therefore, transitively, only that tenant's bad-tray rows reachable
-- through the join). A bare, unjoined `SELECT * FROM bad_tray_entries` under
-- this role would see every tenant's rows -- farm_context.py's query shape is
-- the only thing that keeps this scoped in practice; any FUTURE recommender
-- code path reading bad_tray_entries without the cycles join would need its
-- own explicit facility filter. This is the accepted behavior-change from
-- the previous fleet-wide bad-tray grounding to own-farm-only.
--
-- STRUCTURAL note (same convention as 00016-00022): the pgTAP proof
-- (00023_recommender_rls.test.sql) asserts RLS-enabled + policy
-- presence/predicate only -- farmsmart_recommender does not exist in the
-- disposable-CI database. The functional proof (own-tenant grounding, no
-- cross-tenant leakage) is carried by the recommender's own pytest suite +
-- the api-server integration path + staging, run under the real role once
-- provisioned (see the role-rotation runbook).
--
-- Rollback:
--   drop policy "recommender cache readable by backend roles" on public.recommender_cache;
--   drop policy "recommender cache insertable by backend roles" on public.recommender_cache;
--   alter table public.recommender_cache disable row level security;
--   drop policy "recommender queries readable by recommender" on public.recommender_queries;
--   drop policy "recommender queries insertable by recommender" on public.recommender_queries;
--   alter table public.recommender_queries disable row level security;
--   drop policy "backend service role (recommender) can select bad_tray_entries" on public.bad_tray_entries;

-- recommender_cache: SELECT, INSERT. Global (non-tenant) cache; admits both
-- farmsmart_recommender and farmsmart_app.
alter table public.recommender_cache enable row level security;

create policy "recommender cache readable by backend roles"
  on public.recommender_cache for select
  using (current_user in ('farmsmart_recommender', 'farmsmart_app'));

create policy "recommender cache insertable by backend roles"
  on public.recommender_cache for insert
  with check (current_user in ('farmsmart_recommender', 'farmsmart_app'));

-- recommender_queries: SELECT, INSERT. Per-user audit log; the recommender's
-- own backend role writes/reads, app-layer scopes by user_id (no auth.uid()
-- on this write path -- see the header comment above).
alter table public.recommender_queries enable row level security;

create policy "recommender queries readable by recommender"
  on public.recommender_queries for select
  using (current_user = 'farmsmart_recommender');

create policy "recommender queries insertable by recommender"
  on public.recommender_queries for insert
  with check (current_user = 'farmsmart_recommender');

-- bad_tray_entries: ADD a farmsmart_recommender SELECT policy (00021 shipped
-- only a farmsmart_app one). Unscoped at the row level -- see header comment
-- for why that's acceptable (the cycles-join scoping path).
create policy "backend service role (recommender) can select bad_tray_entries"
  on public.bad_tray_entries for select
  using (current_user = 'farmsmart_recommender');
