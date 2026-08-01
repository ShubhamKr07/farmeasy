-- Post-migration verification queries for Task 12 (private media bucket).
--
-- Run after applying 00005_private_media.sql against the target DB:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-private-media.sql
--
-- Each query is annotated with the invariant it checks and the expected
-- result. This is the read-only, run-against-live-(staging/production)-DB
-- counterpart to supabase/tests/00005_private_media.test.sql: that suite
-- (rolled back) proves the backfill CONVERSION logic; this script confirms
-- the migration's NET EFFECT on real data — the bucket is private AND zero
-- Supabase public-media URLs remain anywhere. Read-only: it only SELECTs.

\set ON_ERROR_STOP on
\echo ''
\echo '==== 1. media bucket exists and is private (public = false) ===='
select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets
where id = 'media';
\echo 'Expected: exactly one row, public = f. If public = t, the bucket flip'
\echo '         (Step 4 of 00005_private_media.sql) did NOT apply.'

\echo ''
\echo '==== 2. remaining Supabase public-media URLs across ALL three stores ===='
-- This is the SAME counting query the migration Step-3 DO block runs
-- (broader regex matching ANY *.supabase.co host, not just the two known
-- project prefixes), but split per-table for diagnosis. The migration only
-- reaches the bucket flip if this total is zero, so on a migrated DB every
-- one of these counts MUST be 0. A nonzero count here means either the
-- migration was not applied, was applied partially, or new public URLs were
-- written after the flip (which the API can no longer produce post-Task-11).
with mc_remaining as (
  select count(*) as n
  from manual_checks mc, unnest(mc.photo_urls) as u
  where u ~ '^https://[^/]+\.supabase\.co/storage/v1/object/public/media/'
),
bt_remaining as (
  select count(*) as n
  from bad_tray_entries bt, unnest(bt.photo_urls) as u
  where u ~ '^https://[^/]+\.supabase\.co/storage/v1/object/public/media/'
),
fl_remaining as (
  select count(*) as n
  from facility_logs fl, jsonb_array_elements_text(fl.data->'photoUrls') as u
  where fl.data ? 'photoUrls'
    and u ~ '^https://[^/]+\.supabase\.co/storage/v1/object/public/media/'
)
select
  mc_remaining.n as manual_checks_remaining,
  bt_remaining.n as bad_tray_entries_remaining,
  fl_remaining.n as facility_logs_remaining,
  (mc_remaining.n + bt_remaining.n + fl_remaining.n) as total_remaining
from mc_remaining, bt_remaining, fl_remaining;
\echo 'Expected: every column 0 (total_remaining = 0). The bucket flip only ran'
\echo '         because the migration Step-3 assertion of this same count passed;'
\echo '         a nonzero value here indicates the DB was mutated after the flip.'

\echo ''
\echo '==== 3. diagnostic: any still-unconverted rows (sample, not a gate) ===='
-- Up to 20 sample offending references for human triage if section 2 is nonzero.
-- No rows is the expected/healthy state.
select 'manual_checks' as store, mc.id as row_id, u as photo_url
from manual_checks mc, unnest(mc.photo_urls) as u
where u ~ '^https://[^/]+\.supabase\.co/storage/v1/object/public/media/'
union all
select 'bad_tray_entries', bt.id, u
from bad_tray_entries bt, unnest(bt.photo_urls) as u
where u ~ '^https://[^/]+\.supabase\.co/storage/v1/object/public/media/'
union all
select 'facility_logs', fl.id, u
from facility_logs fl, jsonb_array_elements_text(fl.data->'photoUrls') as u
where fl.data ? 'photoUrls'
  and u ~ '^https://[^/]+\.supabase\.co/storage/v1/object/public/media/'
limit 20;
\echo 'Expected: zero rows. (This is the row-level view of section 2.)'

\echo ''
\echo '==== 4. backfill footprint: rows now holding bucket-relative keys ===='
-- Sanity signal that the backfill did run (and/or post-Task-11 API writes are
-- landing). Not a gate — informational only.
select
  (select count(*) from manual_checks mc, unnest(mc.photo_urls) as u
   where u !~ '^https?://') as manual_checks_bucket_relative_refs,
  (select count(*) from bad_tray_entries bt, unnest(bt.photo_urls) as u
   where u !~ '^https?://') as bad_tray_entries_bucket_relative_refs,
  (select count(*) from facility_logs fl, jsonb_array_elements_text(fl.data->'photoUrls') as u
   where fl.data ? 'photoUrls' and u !~ '^https?://') as facility_logs_bucket_relative_refs;
\echo 'Expected: production shows >= 1 in facility_logs (the one real waste-log'
\echo '         row backfilled to the bare filename). Staging shows 0 everywhere'
\echo '         (ADR-004: staging never carries real user data).'

\echo ''
\echo 'Verification complete.'
