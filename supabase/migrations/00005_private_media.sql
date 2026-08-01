-- Task 12: backfill legacy public-URL photo references to bucket-relative
-- keys, then make the `media` storage bucket private.
--
-- Renumbered from the plan's stated 00006 to 00005: this migration was
-- authored and applied before Release 1 Task 3's 00005_lock_down_public_data
-- migration (deliberately deferred a week per a later scheduling decision),
-- so 00005 was the next real available slot, not 00006. Task 3's migration
-- will be 00006 when it lands.
--
-- Background: before Task 11, the upload API stored a bare filename (e.g.
-- "1f78d96042ec4dc0.jpg") and returned a full public Supabase Storage URL
-- (e.g. "https://<project-ref>.supabase.co/storage/v1/object/public/media/
-- 1f78d96042ec4dc0.jpg"), which clients then persisted verbatim as the
-- "photo reference" in manual_checks.photo_urls, bad_tray_entries.photo_urls,
-- and facility_logs.data->'photoUrls'. Task 11 (already deployed and
-- verified on every staging and production API replica) switched new
-- uploads to store a bucket-relative key and sign it into a short-lived URL
-- only at the API response boundary, but the bucket stayed PUBLIC throughout
-- Task 11 so already-stored public URLs kept working unconverted.
--
-- This migration is the "contract" half: convert every still-public-URL
-- reference in all three stores to the bucket-relative key the object is
-- ACTUALLY stored under (never assume a naming convention — verify each
-- candidate key exists in storage.objects before converting; an unconverted
-- row is safer than a converted-to-nonexistent-object row), assert zero
-- Supabase-storage public-media URLs remain anywhere, and only then flip the
-- bucket to private. If anything in the assertion fails, the whole
-- transaction aborts and the bucket is never flipped.
--
-- Project prefixes (ADR-004: one staging Supabase project, one production
-- Supabase project; committed migration files carry the literal values, no
-- angle-bracket placeholder):
--   production: https://meorgbbtxlpzxyfxmnyu.supabase.co/storage/v1/object/public/media/
--   staging:    https://jkxlbndnatkxmhpumvhh.supabase.co/storage/v1/object/public/media/
-- This same migration file runs against both projects; only the prefix that
-- matches the CURRENT project's own historical URLs will ever match a row in
-- that project's data (a staging database can never contain a real
-- production URL and vice versa), so checking both prefixes unconditionally
-- is safe and is what makes one committed file correct in both places.

begin;

-- ── Step 1-2: backfill manual_checks.photo_urls (text[]) ───────────────────
--
-- For each element (WITH ORDINALITY preserves array order in the rebuild):
--   - If it matches either project's public-media URL prefix AND the
--     extracted remainder exists as a real object name in storage.objects
--     for the `media` bucket, replace it with that remainder (the object's
--     actual stored key/path — never reconstructed, always the exact
--     candidate key that already exists in storage).
--   - Otherwise (no prefix match, or the derived key doesn't exist in
--     storage) leave the element completely unchanged. A row is only ever
--     converted element-by-element; nothing is dropped or nulled.
with elements as (
  select
    mc.id as row_id,
    e.ord,
    e.url,
    case
      when e.url like 'https://meorgbbtxlpzxyfxmnyu.supabase.co/storage/v1/object/public/media/%'
        then substring(e.url from 'https://meorgbbtxlpzxyfxmnyu\.supabase\.co/storage/v1/object/public/media/(.*)$')
      when e.url like 'https://jkxlbndnatkxmhpumvhh.supabase.co/storage/v1/object/public/media/%'
        then substring(e.url from 'https://jkxlbndnatkxmhpumvhh\.supabase\.co/storage/v1/object/public/media/(.*)$')
      else null
    end as candidate_key
  from manual_checks mc
  cross join lateral unnest(mc.photo_urls) with ordinality as e(url, ord)
),
resolved as (
  select
    row_id,
    ord,
    case
      when candidate_key is not null
        and exists (
          select 1 from storage.objects
          where bucket_id = 'media' and name = candidate_key
        )
      then candidate_key
      else url
    end as final_value
  from elements
),
rebuilt as (
  select row_id, array_agg(final_value order by ord) as new_photo_urls
  from resolved
  group by row_id
)
update manual_checks mc
set photo_urls = rebuilt.new_photo_urls
from rebuilt
where mc.id = rebuilt.row_id
  and mc.photo_urls is distinct from rebuilt.new_photo_urls;

-- ── Step 1-2: backfill bad_tray_entries.photo_urls (text[]) ────────────────
-- Identical logic, different table.
with elements as (
  select
    bt.id as row_id,
    e.ord,
    e.url,
    case
      when e.url like 'https://meorgbbtxlpzxyfxmnyu.supabase.co/storage/v1/object/public/media/%'
        then substring(e.url from 'https://meorgbbtxlpzxyfxmnyu\.supabase\.co/storage/v1/object/public/media/(.*)$')
      when e.url like 'https://jkxlbndnatkxmhpumvhh.supabase.co/storage/v1/object/public/media/%'
        then substring(e.url from 'https://jkxlbndnatkxmhpumvhh\.supabase\.co/storage/v1/object/public/media/(.*)$')
      else null
    end as candidate_key
  from bad_tray_entries bt
  cross join lateral unnest(bt.photo_urls) with ordinality as e(url, ord)
),
resolved as (
  select
    row_id,
    ord,
    case
      when candidate_key is not null
        and exists (
          select 1 from storage.objects
          where bucket_id = 'media' and name = candidate_key
        )
      then candidate_key
      else url
    end as final_value
  from elements
),
rebuilt as (
  select row_id, array_agg(final_value order by ord) as new_photo_urls
  from resolved
  group by row_id
)
update bad_tray_entries bt
set photo_urls = rebuilt.new_photo_urls
from rebuilt
where bt.id = rebuilt.row_id
  and bt.photo_urls is distinct from rebuilt.new_photo_urls;

-- ── Step 1-2: backfill facility_logs.data->'photoUrls' (jsonb array) ───────
--
-- Only 3 of 6 log types (waste, cleaning, receiving) ever carry a
-- `photoUrls` key inside the jsonb `data` blob; the where clause below
-- (`data ? 'photoUrls'`) naturally excludes the other 3 types (and any row
-- where photoUrls happens to be absent). Every other key in `data` is
-- preserved untouched via jsonb_set, which replaces only the 'photoUrls'
-- path.
with elements as (
  select
    fl.id as row_id,
    e.ord,
    e.url,
    case
      when e.url like 'https://meorgbbtxlpzxyfxmnyu.supabase.co/storage/v1/object/public/media/%'
        then substring(e.url from 'https://meorgbbtxlpzxyfxmnyu\.supabase\.co/storage/v1/object/public/media/(.*)$')
      when e.url like 'https://jkxlbndnatkxmhpumvhh.supabase.co/storage/v1/object/public/media/%'
        then substring(e.url from 'https://jkxlbndnatkxmhpumvhh\.supabase\.co/storage/v1/object/public/media/(.*)$')
      else null
    end as candidate_key
  from facility_logs fl
  cross join lateral jsonb_array_elements_text(fl.data->'photoUrls') with ordinality as e(url, ord)
  where fl.data ? 'photoUrls'
),
resolved as (
  select
    row_id,
    ord,
    case
      when candidate_key is not null
        and exists (
          select 1 from storage.objects
          where bucket_id = 'media' and name = candidate_key
        )
      then candidate_key
      else url
    end as final_value
  from elements
),
rebuilt as (
  select row_id, jsonb_agg(final_value order by ord) as new_photo_urls
  from resolved
  group by row_id
)
update facility_logs fl
set data = jsonb_set(fl.data, '{photoUrls}', rebuilt.new_photo_urls, false)
from rebuilt
where fl.id = rebuilt.row_id
  and fl.data->'photoUrls' is distinct from rebuilt.new_photo_urls;

-- ── Step 3: assert zero Supabase public-media URLs remain, ANY host ────────
--
-- Broader than just the two known project prefixes: matches
-- "https://<anything>.supabase.co/storage/v1/object/public/media/..."
-- generically, so a stray/misconfigured URL from an unexpected host still
-- trips the abort rather than silently surviving the backfill. Aborts the
-- whole transaction (migration never reaches the bucket-privacy flip) if
-- any remain in any of the three stores.
do $$
declare
  remaining_count integer;
begin
  select
    (select count(*) from manual_checks mc, unnest(mc.photo_urls) as u
     where u ~ '^https://[^/]+\.supabase\.co/storage/v1/object/public/media/')
    +
    (select count(*) from bad_tray_entries bt, unnest(bt.photo_urls) as u
     where u ~ '^https://[^/]+\.supabase\.co/storage/v1/object/public/media/')
    +
    (select count(*) from facility_logs fl, jsonb_array_elements_text(fl.data->'photoUrls') as u
     where fl.data ? 'photoUrls'
       and u ~ '^https://[^/]+\.supabase\.co/storage/v1/object/public/media/')
    into remaining_count;

  if remaining_count > 0 then
    raise exception
      'Task 12 migration aborted: % Supabase public-media URL(s) remain unconverted across manual_checks/bad_tray_entries/facility_logs. The media bucket was NOT made private. Investigate the unconverted row(s) (likely a candidate key that does not exist in storage.objects) before retrying.',
      remaining_count;
  end if;
end $$;

-- ── Step 4: make the media bucket private ───────────────────────────────────
-- Only reached if Step 3's assertion passed (raise exception above rolls
-- back the whole transaction, including this statement, on failure).
update storage.buckets set public = false where id = 'media';

commit;
