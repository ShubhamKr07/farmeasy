-- pgTAP assertions for Task 12: the photo-reference backfill in
-- 00005_private_media.sql (conversion of legacy Supabase public-media URLs to
-- bucket-relative keys in manual_checks.photo_urls, bad_tray_entries.photo_urls,
-- and facility_logs.data->'photoUrls'), the never-dangle safety property, the
-- ORDER preservation (WITH ORDINALITY), and the Step-3 zero-remaining-URLs
-- abort check that gates the bucket-privacy flip.
--
-- ── Why this test REPLAYS the migration's SQL instead of relying on the
--    migration-apply flow ──────────────────────────────────────────────────
-- The disposable-Supabase CI stack (scripts/ci/test-disposable-supabase.sh)
-- applies every migration against a FRESH, EMPTY database, then runs pgTAP
-- tests afterward. At migration-apply time there is ZERO photo data to
-- convert, so the backfill UPDATEs are no-ops and the bucket flip runs
-- unconditionally. The conversion LOGIC itself can therefore only be proven
-- by seeding rows AFTER the migration has applied and re-running the exact
-- backfill CTE/UPDATE statements — the established pattern from Task 1's
-- 00004_auth_profiles.test.sql (which replays the auth-profile backfill INSERT
-- verbatim). We copy-paste the migration's backfill statements faithfully
-- rather than re-invoking the migration file, because the migration is already
-- applied and is not guaranteed to be safely re-runnable inside a test
-- transaction via the supabase CLI mechanics.
--
-- The whole file runs inside a transaction that is always rolled back, so the
-- seeded rows (incl. the storage.objects fixtures) leave no side effects.
-- pgTAP itself runs as the postgres superuser (bypasses RLS), which is exactly
-- the privilege level the migration's UPDATEs run at.
--
-- Assertions use top-level SELECT is()/ok() (the simpler 00001_foundation.sql
-- style); no DO-block buffering is needed here because none of these checks
-- need procedural exception handling.
BEGIN;

SELECT plan(9);

-- ──────────────────────────────────────────────────────────────────────────
-- Fixture seeding
-- ──────────────────────────────────────────────────────────────────────────
-- FK chain for manual_checks/bad_tray_entries: both require cycle_id ->
-- cycles.id (NOT NULL); cycles.growth_profile_id -> growth_profiles.id is
-- required, but growth_profiles.crop_id is NULLABLE, so we skip seeding a
-- crop entirely (minimal chain, per the brief). facility_logs needs a
-- NOT-NULL user_id -> public.users.id; public.users(id) FK -> auth.users(id)
-- (migration 00004), so we create an auth.users row and let the
-- on_auth_user_created trigger provision the public.users row, giving us a
-- valid user_id to reference.

-- Minimal 1x1 PNG used as the "real" storage.object name SUFFIX only (the
-- bucket object itself is irrelevant to the backfill — only its NAME matters
-- for the EXISTS check). We don't upload bytes; we insert the storage.objects
-- metadata row directly the way a pre-Task-11 upload would have left it.

-- Auth user (trigger provisions public.users). Reuses the exact helper shape
-- from 00004_auth_profiles.test.sql — crypt()/gen_salt() live in the
-- `extensions` schema, which is NOT on the pgTAP harness's restricted
-- search_path, so they must be schema-qualified.
insert into auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '77777777-7777-7777-7777-777777777777',
  'authenticated', 'authenticated', 'task12-probe@example.com',
  extensions.crypt('password123', extensions.gen_salt('bf')), now(),
  '{}'::jsonb, '{}'::jsonb,
  now(), now()
);

-- growth_profile (crop_id deliberately NULL — nullable, not needed).
insert into growth_profiles (name, seed_name, germination_days, fertigation_days)
values ('task12-gp', 'task12-seed', 1, 2);

-- cycle referencing the growth profile.
insert into cycles (short_id, seed_lot_qr_codes, seed_name, seed_weight_tray, growth_profile_id, seeding_date)
values (
  'task12-cycle', ARRAY['task12-qr'], 'task12-seed', 1.0,
  (select id from growth_profiles where name = 'task12-gp'),
  '2026-01-01'
);

-- storage.objects: the REAL object names the backfill verifies against.
-- path_tokens is GENERATED ALWAYS AS (string_to_array(name,'/')), so it is
-- NOT inserted. bucket_id/name are all the EXISTS check reads.
insert into storage.objects (bucket_id, name) values
  ('media', 'mc-real-aaa.jpg'),
  ('media', 'bt-real-ccc.jpg'),
  ('media', 'fl-real-eee.jpg');

-- manual_checks row A (real-match + passthroughs): the first element matches
-- the production prefix AND its extracted key exists in storage.objects, so it
-- MUST convert to the bare key. The second (already-new bucket-relative key)
-- and third (external non-Supabase CDN URL) match neither prefix and MUST pass
-- through UNCHANGED, in their original positions (ORDER preserved).
insert into manual_checks (cycle_id, photo_urls, notes) values (
  (select id from cycles where short_id = 'task12-cycle'),
  ARRAY[
    'https://meorgbbtxlpzxyfxmnyu.supabase.co/storage/v1/object/public/media/mc-real-aaa.jpg',
    'mc-already-bucket.jpg',
    'https://example-cdn.example.com/img/x.png'
  ],
  'mc-rowA-realmatch'
);

-- manual_checks row B (dangling): matches the production prefix, but the
-- extracted key does NOT exist in storage.objects. The CORE SAFETY PROPERTY:
-- leave the element COMPLETELY UNCHANGED — never convert to a dangling
-- reference. (This row also feeds the Step-3 abort-count check below.)
insert into manual_checks (cycle_id, photo_urls, notes) values (
  (select id from cycles where short_id = 'task12-cycle'),
  ARRAY['https://meorgbbtxlpzxyfxmnyu.supabase.co/storage/v1/object/public/media/mc-dangling-bbb.jpg'],
  'mc-rowB-dangling'
);

-- bad_tray_entries row C (real-match + passthroughs), this time using the
-- STAGING project prefix to prove BOTH prefixes' LIKE/regex branches work.
insert into bad_tray_entries (cycle_id, photo_urls, issue) values (
  (select id from cycles where short_id = 'task12-cycle'),
  ARRAY[
    'https://jkxlbndnatkxmhpumvhh.supabase.co/storage/v1/object/public/media/bt-real-ccc.jpg',
    'bt-already.jpg',
    'https://ext.example/bt.png'
  ],
  'bt-rowC-realmatch'
);

-- bad_tray_entries row D (dangling, staging prefix).
insert into bad_tray_entries (cycle_id, photo_urls, issue) values (
  (select id from cycles where short_id = 'task12-cycle'),
  ARRAY['https://jkxlbndnatkxmhpumvhh.supabase.co/storage/v1/object/public/media/bt-dangling-ddd.jpg'],
  'bt-rowD-dangling'
);

-- facility_logs row E (waste, photoUrls mix): real-match URL (converts) +
-- already-new bucket-relative key (unchanged) + external CDN URL (unchanged).
-- Other data fields are present to prove jsonb_set touches ONLY the photoUrls
-- path and leaves everything else intact.
insert into facility_logs (log_type, user_id, data, notes) values (
  'waste',
  '77777777-7777-7777-7777-777777777777',
  jsonb_build_object(
    'photoUrls', jsonb_build_array(
      'https://meorgbbtxlpzxyfxmnyu.supabase.co/storage/v1/object/public/media/fl-real-eee.jpg',
      'fl-already-key.jpg',
      'https://cdn.example.org/pic.gif'
    ),
    'wasteType', 'probe',
    'quantity', 1,
    'unit', 'kg',
    'disposalMethod', 'compost'
  ),
  'fl-rowE-waste-mix'
);

-- facility_logs row F (env_check): a NON-photo log type (no photoUrls key).
-- The backfill's WHERE (data ? 'photoUrls') excludes it entirely; assert the
-- whole data blob is untouched.
insert into facility_logs (log_type, user_id, data, notes) values (
  'env_check',
  '77777777-7777-7777-7777-777777777777',
  jsonb_build_object('zone', 'zone-A', 'tempC', 21.5),
  'fl-rowF-envcheck'
);

-- ──────────────────────────────────────────────────────────────────────────
-- REPLAY the migration's exact backfill CTE/UPDATE statements (verbatim from
-- 00005_private_media.sql). These run against the seeded rows above, in this
-- transaction (rolled back at the end).
-- ──────────────────────────────────────────────────────────────────────────

-- ── backfill manual_checks.photo_urls (text[]) ─────────────────────────────
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

-- ── backfill bad_tray_entries.photo_urls (text[]) ──────────────────────────
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

-- ── backfill facility_logs.data->'photoUrls' (jsonb array) ─────────────────
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

-- ──────────────────────────────────────────────────────────────────────────
-- Assertions
-- ──────────────────────────────────────────────────────────────────────────

-- 1. manual_checks row A: real-match URL converted to its bare storage key;
--    the already-new bucket-relative key and the external CDN URL passed
--    through UNCHANGED; array ORDER preserved (conversion in position 0 only).
SELECT is(
  (SELECT photo_urls FROM manual_checks WHERE notes = 'mc-rowA-realmatch'),
  ARRAY[
    'mc-real-aaa.jpg',
    'mc-already-bucket.jpg',
    'https://example-cdn.example.com/img/x.png'
  ]::text[],
  'manual_checks: real-match URL -> bare key, passthroughs unchanged, order preserved'
);

-- 2. manual_checks row B: prefix matched but key absent from storage.objects
--    -> element left COMPLETELY unchanged (never a dangling reference).
SELECT is(
  (SELECT photo_urls FROM manual_checks WHERE notes = 'mc-rowB-dangling'),
  ARRAY['https://meorgbbtxlpzxyfxmnyu.supabase.co/storage/v1/object/public/media/mc-dangling-bbb.jpg']::text[],
  'manual_checks: prefix-match with absent storage object left unchanged (no dangling ref)'
);

-- 3. bad_tray_entries row C (staging prefix): same conversion + passthrough +
--    order behavior, proving the staging-prefix branch works too.
SELECT is(
  (SELECT photo_urls FROM bad_tray_entries WHERE issue = 'bt-rowC-realmatch'),
  ARRAY[
    'bt-real-ccc.jpg',
    'bt-already.jpg',
    'https://ext.example/bt.png'
  ]::text[],
  'bad_tray_entries: staging-prefix real-match URL -> bare key, passthroughs unchanged, order preserved'
);

-- 4. bad_tray_entries row D (staging prefix, dangling): unchanged.
SELECT is(
  (SELECT photo_urls FROM bad_tray_entries WHERE issue = 'bt-rowD-dangling'),
  ARRAY['https://jkxlbndnatkxmhpumvhh.supabase.co/storage/v1/object/public/media/bt-dangling-ddd.jpg']::text[],
  'bad_tray_entries: staging-prefix match with absent storage object left unchanged (no dangling ref)'
);

-- 5. facility_logs row E photoUrls (jsonb array): real-match converted, the
--    other two elements unchanged, ORDER preserved.
SELECT is(
  (SELECT data->'photoUrls' FROM facility_logs WHERE notes = 'fl-rowE-waste-mix'),
  '["fl-real-eee.jpg","fl-already-key.jpg","https://cdn.example.org/pic.gif"]'::jsonb,
  'facility_logs waste: photoUrls converted in place, passthroughs unchanged, order preserved'
);

-- 6. facility_logs row E: EVERY OTHER data field survived jsonb_set untouched
--    (it replaced only the {photoUrls} path). Comparing data - 'photoUrls'
--    checks wasteType/quantity/unit/disposalMethod all at once.
SELECT is(
  (SELECT data - 'photoUrls' FROM facility_logs WHERE notes = 'fl-rowE-waste-mix'),
  '{"wasteType": "probe", "quantity": 1, "unit": "kg", "disposalMethod": "compost"}'::jsonb,
  'facility_logs waste: jsonb_set preserves all other data fields'
);

-- 7. facility_logs row F (env_check, non-photo type): the whole data blob is
--    untouched — the backfill WHERE (data ? 'photoUrls') excluded it.
SELECT is(
  (SELECT data FROM facility_logs WHERE notes = 'fl-rowF-envcheck'),
  '{"zone": "zone-A", "tempC": 21.5}'::jsonb,
  'facility_logs env_check (non-photo log type): data untouched by backfill'
);

-- 8. Step-3 abort check: the EXACT counting query the migration Step-3 DO block
--    runs, executed directly (NOT via RAISE EXCEPTION, which would abort this
--    test transaction). After the backfill replay the only remaining public-
--    media URLs are the two dangling rows (B in manual_checks, D in
--    bad_tray_entries) — count == 2, so a RAISE EXCEPTION WOULD fire, proving
--    the abort gate correctly detects unconverted URLs.
SELECT is(
  (
    (select count(*) from manual_checks mc, unnest(mc.photo_urls) as u
     where u ~ '^https://[^/]+\.supabase\.co/storage/v1/object/public/media/')
    +
    (select count(*) from bad_tray_entries bt, unnest(bt.photo_urls) as u
     where u ~ '^https://[^/]+\.supabase\.co/storage/v1/object/public/media/')
    +
    (select count(*) from facility_logs fl, jsonb_array_elements_text(fl.data->'photoUrls') as u
     where fl.data ? 'photoUrls'
       and u ~ '^https://[^/]+\.supabase\.co/storage/v1/object/public/media/')
  )::integer,
  2,
  'Step-3 abort check: counts 2 remaining public-media URLs (the dangling rows), so RAISE EXCEPTION would fire'
);

-- 9. The migration''s Step-4 bucket flip already committed when the migration
--    applied against the disposable DB (the assertion ran on empty data, so it
--    passed and the flip proceeded). Confirm the net effect: media bucket is
--    private. (Reads the committed value outside this transaction''s changes.)
SELECT is(
  (SELECT public FROM storage.buckets WHERE id = 'media'),
  false,
  'migration Step 4: media bucket is private (public = false) after a clean apply'
);

SELECT * FROM finish();
ROLLBACK;
