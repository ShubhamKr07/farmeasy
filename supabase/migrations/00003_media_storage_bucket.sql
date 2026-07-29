-- Public bucket for user-uploaded photos (bad-tray manual checks, facility
-- logs). Replaces the old local-disk `multer` uploads, which were wiped on
-- every Render redeploy (ephemeral filesystem, no persistent disk configured).
--
-- No RLS policies on storage.objects: all writes go through api-server using
-- the service-role client (supabaseAdmin), which bypasses RLS entirely: an
-- INSERT policy would be dead code. Reads go through Supabase's
-- `/storage/v1/object/public/...` endpoint, which serves public-bucket
-- objects without evaluating RLS at all — a SELECT policy would also be dead
-- code. If a future feature needs direct client-to-storage uploads, add a
-- scoped INSERT policy then.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media',
  'media',
  true,
  5242880, -- 5 MiB, matches the existing multer limit in routes/media.ts
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do nothing;
