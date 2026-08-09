-- TEN-013 demo fork: backend (farmsmart_app) UPDATE policy on organizations
-- for the is_demo flip -- the prior milestones never needed it and the
-- BYPASSRLS CI DB masked its absence.
--
-- POST /api/demo/provision flips is_demo=true and POST /api/demo/graduate
-- flips it back to false. Unlike 00018's organizations DELETE policy (which
-- backs a scheduled purge sweep that never runs inside a tenant scope, so
-- app.org_id is never set -- see 00013), the demo endpoints run this UPDATE
-- inside a live per-request transaction that explicitly sets app.org_id
-- before the write (Global Constraints of the TEN-013 plan). That makes a
-- GUC-scoped USING/WITH CHECK clause both available and the stronger,
-- correct defense-in-depth here -- not just current_user, but current_user
-- AND the caller's own org, same NULLIF-guarded cast idiom as 00013.
--
-- Syntax matches 00018 (lowercase keywords, quoted policy name, bare
-- `using (current_user = 'farmsmart_app')`-style clause, no `TO
-- farmsmart_app`) -- do not mix conventions.
--
-- Rollback:
--   drop policy "backend service role can update organizations" on public.organizations;
--
-- NOTE: this migration intentionally does NOT add a facilities DELETE
-- policy, despite that being part of TEN-013 Task 2's original scope
-- (POST /api/demo/graduate deleting the demo facility). public.facilities
-- has NEVER had row level security enabled -- no `alter table
-- public.facilities enable row level security`, no policies at all, in any
-- migration through 00018 (the original plan's "facilities shipped with
-- SELECT/INSERT backend policies but no DELETE" premise was wrong). It is
-- one of the 15 tables from the already-tracked RLS-public-tables
-- remediation (Supabase advisor `rls_disabled_in_public`), which is its own
-- focused migration/PR coordinated across all 15 tables with
-- security-compliance -- not folded in here. Enabling RLS on facilities
-- alone for a lone DELETE policy would deny-by-default every live
-- SELECT/INSERT that currently runs under farmsmart_app via plain grants,
-- not policies (routes/facilities.ts, growthProfiles.ts, metrics.ts,
-- wizard.ts) -- a production regression, and out of scope for a demo-fork
-- feature.
--
-- Decision (team lead, TEN-013 Cluster 1 review): POST /api/demo/graduate's
-- `DELETE FROM facilities WHERE organization_id = <org>` runs under the same
-- trust model every existing facilities SELECT/INSERT already uses --
-- farmsmart_app's plain table grant, scoped by an organizationId resolved
-- server-side from the caller's active OWNER membership, never client
-- input. No new unscoped path, no isolation weakening. The ON DELETE CASCADE
-- to RLS'd children (cycles, seed_lots, sensors, ...) runs at engine level
-- (not subject to child-table RLS) and is naturally confined to the one
-- facility being deleted.

create policy "backend service role can update organizations"
  on public.organizations
  for update
  using (
    current_user = 'farmsmart_app'
    and id = nullif(current_setting('app.org_id', true), '')::int
  )
  with check (
    current_user = 'farmsmart_app'
    and id = nullif(current_setting('app.org_id', true), '')::int
  );
