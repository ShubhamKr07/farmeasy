# Supabase Storage Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `api-server`'s local-disk `multer` photo uploads (`artifacts/api-server/src/routes/media.ts`) with Supabase Storage, so uploaded photos survive redeploys and resolve to real HTTPS URLs.

**Architecture:** The upload route already authenticates via `enforceAuth` and accepts a single multipart file via `multer`. Swap `multer.diskStorage` for `multer.memoryStorage()`, then push the in-memory buffer to a public Supabase Storage bucket using the existing `supabaseAdmin` service-role client (already created in `middlewares/supabaseAuth.ts` for JWT verification, reused here — no new client, no new env vars). Return the bucket's public URL instead of a relative `/uploads/...` path. Remove the local static-file serving now that nothing writes to disk.

**Tech Stack:** Express, `multer`, `@supabase/supabase-js` (Storage API), Supabase Storage (public bucket), Drizzle-adjacent SQL migration under `supabase/migrations/`.

## Global Constraints

- pnpm only (root `preinstall` guard refuses npm/yarn).
- `pnpm run typecheck` must pass before merge.
- No new Render env vars: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already set on `farmsmart-api` (from the Auth migration, `render.yaml:35-37`).
- Consumers of the upload response never change: both call sites (`artifacts/farmeasy/app/manual-check/[id].tsx`, `artifacts/farmeasy/app/logs/[type].tsx`, via `artifacts/farmeasy/utils/uploadPhoto.ts`) only read `{ url: string }` from the JSON response and store it verbatim into `text("photo_urls").array()` columns (`lib/db/src/schema/index.ts:198,428`) — any valid HTTPS URL works, no schema or client changes needed.
- This repo has no route-level automated tests anywhere (`api-server`'s `test` script only runs `src/lib/utils.test.ts` and `src/tests/metrics/*.test.ts`) — match that convention; verify this route manually end-to-end (Task 4), don't introduce new test scaffolding for a thin Express handler.

## Rollback

**Pre-migration anchor:** `main` was at `1f38768` (`chore(admin-dashboard): remove temporary OAuth debug breadcrumb`) before this plan's first commit. If anything in this plan needs to be fully undone:

```bash
git revert --no-edit <task-4-commit>..HEAD   # undo code commits, newest first
# or, if nothing has been pushed yet:
git reset --hard 1f38768
```

Each task also carries its own scoped rollback (Task 1 for the live Supabase bucket, Task 4 for the Render deploy) — see the "Rollback" step inside those tasks. Tasks 2–3 are pure code changes already covered by the git-revert above; no separate live-system rollback needed for them.

---

### Task 1: Create the Supabase Storage bucket

**Files:**
- Create: `supabase/migrations/00003_media_storage_bucket.sql`

**Interfaces:**
- Produces: a public Supabase Storage bucket named `media`, referenced by name (not by any generated ID) from Task 2's route code.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/00003_media_storage_bucket.sql
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
```

- [ ] **Step 2: Apply the migration to the live Supabase project**

Use the Supabase MCP tool `apply_migration` (project ref `meorgbbtxlpzxyfxmnyu`, matching every prior migration in this repo) with the SQL above, name `00003_media_storage_bucket`. Do not use `supabase db push` — this repo's established pattern (see Task 2 of both prior migration plans) is to apply directly via MCP against the hosted project, since local Supabase isn't running.

- [ ] **Step 3: Verify the bucket exists**

Use the Supabase MCP tool `execute_sql` with:
```sql
select id, name, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'media';
```
Expected: one row, `public = true`, `file_size_limit = 5242880`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00003_media_storage_bucket.sql
git commit -m "feat(storage): create public Supabase Storage bucket for media uploads"
```

- [ ] **Step 5: Rollback (only if needed)**

Nothing in Tasks 2–4 depends on this bucket existing at rest (Task 2's code merely references the bucket *name*; the bucket itself has no schema/FK relationships anywhere in Postgres — `photo_urls` columns just store opaque URL strings). If this bucket needs to be removed, e.g. to re-run Task 1 with different settings, first delete any objects already uploaded into it (a non-empty bucket can't be dropped), then the bucket row itself, via the Supabase MCP `execute_sql` tool:

```sql
delete from storage.objects where bucket_id = 'media';
delete from storage.buckets where id = 'media';
```

---

### Task 2: Rewrite the upload route to use Supabase Storage

**Files:**
- Modify: `artifacts/api-server/src/routes/media.ts` (entire file)

**Interfaces:**
- Consumes: `supabaseAdmin` from `../middlewares/supabaseAuth` (existing export, service-role client — see `artifacts/api-server/src/middlewares/supabaseAuth.ts:10-13`). Consumes the `media` bucket created in Task 1.
- Produces: `router` (default export, unchanged shape — still mounted the same way in `app.ts`). The `POST /api/media/upload` response shape is unchanged: `{ url: string }`. `UPLOADS_DIR` export is removed (Task 3 removes its only consumer).

- [ ] **Step 1: Replace the file contents**

```typescript
// artifacts/api-server/src/routes/media.ts
import { Router, type Request, type Response, type NextFunction } from "express";
import { getAuth, supabaseAdmin } from "../middlewares/supabaseAuth";
import multer from "multer";
import path from "node:path";
import { randomBytes } from "node:crypto";

const MEDIA_BUCKET = "media";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed"));
      return;
    }
    cb(null, true);
  },
});

function enforceAuth(req: Request, res: Response, next: NextFunction) {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

const router = Router();

router.post("/media/upload", enforceAuth, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file provided" });
  }

  const ext = path.extname(req.file.originalname) || ".jpg";
  const filename = `${randomBytes(8).toString("hex")}${ext}`;

  const { error } = await supabaseAdmin.storage
    .from(MEDIA_BUCKET)
    .upload(filename, req.file.buffer, { contentType: req.file.mimetype });

  if (error) {
    return res.status(502).json({ error: "Upload failed" });
  }

  const { data } = supabaseAdmin.storage.from(MEDIA_BUCKET).getPublicUrl(filename);
  return res.json({ url: data.publicUrl });
});

export default router;
```

Note what's gone from the old file: `fs`, `UPLOADS_DIR`, `fs.mkdirSync`, and `multer.diskStorage` are all removed — there's no local directory to create anymore.

- [ ] **Step 2: Typecheck**

```bash
cd artifacts/api-server && pnpm exec tsc --noEmit
```

Expected: no errors referencing `media.ts`. (Task 3 must land before this is fully clean — `app.ts` still imports the now-deleted `UPLOADS_DIR` export until then. If running this step in isolation before Task 3, you will see exactly one error in `app.ts` for the missing `UPLOADS_DIR` export; that's expected and fixed by Task 3, not this task.)

- [ ] **Step 3: Commit**

```bash
git add artifacts/api-server/src/routes/media.ts
git commit -m "feat(storage): upload media to Supabase Storage instead of local disk"
```

---

### Task 3: Remove local-disk static file serving

**Files:**
- Modify: `artifacts/api-server/src/app.ts:2,25,50`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — this task only removes now-dead code (the `/uploads` static route and its now-nonexistent `UPLOADS_DIR` import).

- [ ] **Step 1: Remove the unused `path` import**

In `artifacts/api-server/src/app.ts`, delete line 2:
```typescript
import path from "node:path";
```
(Confirmed unused elsewhere in this file: `path.` appears only in the line removed in Step 3 below.)

- [ ] **Step 2: Remove the `UPLOADS_DIR` import**

Delete line 25:
```typescript
import { UPLOADS_DIR } from "./routes/media";
```

- [ ] **Step 3: Remove the static file serving middleware**

Delete this line (originally line 50, now a few lines earlier after Steps 1–2):
```typescript
app.use("/uploads", express.static(path.resolve(UPLOADS_DIR)));
```

- [ ] **Step 4: Typecheck the whole workspace**

```bash
cd /Users/shubhamkr/farmsmart && pnpm run typecheck
```

Expected: passes with zero errors (this is the point where the Task 2 `app.ts` error, if it was still showing, disappears).

- [ ] **Step 5: Commit**

```bash
git add artifacts/api-server/src/app.ts
git commit -m "chore(storage): remove local-disk /uploads static route"
```

---

### Task 4: Deploy and verify end-to-end

**Files:** none — this is a deploy + manual verification task, following the same pattern used to verify every prior migration in this repo (no route-level automated tests exist for this codebase; see Global Constraints).

**Interfaces:** none.

- [ ] **Step 1: Push to `main` and let Render auto-deploy `farmsmart-api`**

```bash
git push origin main
```

`farmsmart-api` has `autoDeploy: yes` (`render.yaml`) — no manual trigger needed. Poll `render logs --resources srv-<farmsmart-api-id> --limit 10 -o text --confirm` (or the Render MCP `list_logs` tool) until you see the "Your service is live" line, matching the deploy-verification pattern used throughout the Auth migration.

- [ ] **Step 2: Upload a real photo through the mobile app**

Using the Android emulator (or a real device) with the FarmSmart app signed in: open a cycle, trigger a manual bad-tray check (`app/manual-check/[id].tsx`) or a facility log entry with a photo field (`app/logs/[type].tsx`), attach a photo, and submit.

- [ ] **Step 3: Verify the returned URL is a real Supabase Storage URL**

Query the row that was just written (bad-tray check or facility log, whichever was used) via the Supabase MCP `execute_sql` tool, selecting the `photo_urls` column. Expected: a URL of the form `https://meorgbbtxlpzxyfxmnyu.supabase.co/storage/v1/object/public/media/<hex>.<ext>` — not `/uploads/...`.

- [ ] **Step 4: Verify the photo actually renders**

Open that URL directly (curl or browser) — expect `200` and real image bytes (`content-type: image/jpeg` or similar), and confirm it also renders inside the mobile app's photo grid/preview for the record just created (the same screen that displays `photoUrls` — `app/cycle/[id].tsx` for cycle-attached checks).

- [ ] **Step 5: Confirm old local-disk behavior is gone**

```bash
curl -sI https://farmsmart-api-j3qt.onrender.com/uploads/anything.jpg
```

Expected: `404` (no static route left) rather than any file being served — confirms Task 3's removal actually deployed.

- [ ] **Step 6: Rollback (only if Step 2–5 verification fails)**

`farmsmart-api` is a single Render web service with `autoDeploy: yes` — the fastest rollback is redeploying the last-known-good commit directly, without waiting on a revert-and-repush cycle:

```bash
render deploys create srv-<farmsmart-api-id> --commit 1f38768 --wait --confirm -o json
```

(Get the exact service ID via `render services -o json` if not already at hand — matches the id used earlier in this plan for `render logs`.) This restores the pre-migration `api-server` build immediately; the mobile app's `uploadPhoto.ts` caller is unchanged either way, so no mobile-side rollback is needed. Follow up with `git revert` of the plan's commits once the root cause is understood, rather than leaving `main` pointed at code that doesn't match what's deployed.
