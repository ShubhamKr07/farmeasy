# MT-M2 — RLS Positive-Invariant Guard (task #4) — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`.

**Goal:** Enforce, in CI, the positive invariant **"every public base table has RLS enabled"** — replacing the curated `SCOPED_TABLES` allowlist mindset with a rule that any *new* un-RLS'd public table fails CI. Now enforceable because Batches 1–4 + the recommender migration closed the last gap (all 36 public tables have RLS).

**Relates to:** [[rls-positive-invariant-practice]] (the standing practice: enforce via linter/pgTAP, not a curated allowlist). Unblocked by task #3 (Batches 1–4) + task #5 (recommender). No migration — a test + optional CI step only.

## Global Constraints
- **The invariant is a pgTAP assertion** run in the existing disposable-stack `database-integration` CI job (`scripts/ci/test-disposable-supabase.sh` → `supabase test db`). It fails the job if any qualifying public table lacks `relrowsecurity`.
- **Qualifying tables:** `pg_class.relkind IN ('r','p')` (ordinary + partitioned) in `nspname='public'`, **excluding extension-owned tables** (`pg_depend deptype='e'` — e.g. anything the `vector` extension owns) so a third-party extension table can't fail our gate. Views (`relkind='v'`) are excluded (RLS lives on their base tables).
- **Zero curated exceptions today** — all 36 tables have RLS. If a future table is *intentionally* RLS-exempt, it must be added to an explicit, commented exception set in the test (never silently). Prefer no exceptions.
- **Interplay with TEN-011:** `signup_config` (TEN-011's new table) must have RLS or it fails this invariant — that's the point (the guard enforces it). Either merge order works; this guard makes "forgot RLS on a new table" a CI failure.
- No migration, no foundation-count change (adding a pgTAP test file doesn't alter migration counts). Branch `mt-m2-rls-invariant-guard` off `main`. PR into `main`.

---

### Task 1: pgTAP positive-invariant test
**Files:** create `supabase/tests/99000_rls_positive_invariant.test.sql`.

- [ ] **Step 1: Write the test** (named `99000_…` so it sorts/runs after every migration test, reflecting the fully-migrated schema). Inside `BEGIN; … ROLLBACK;`:
```sql
BEGIN;
SELECT plan(1);

-- Positive invariant: every public base/partitioned table (excluding
-- extension-owned) has RLS enabled. Replaces a curated allowlist -- any NEW
-- un-RLS'd public table fails CI here. See [[rls-positive-invariant-practice]].
SELECT is(
  (
    SELECT count(*)::int
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p')
      AND c.relrowsecurity = false
      -- exclude tables owned by an extension (not ours to gate)
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
  ),
  0,
  'every public base table has row level security enabled (positive invariant)'
);

SELECT * FROM finish();
ROLLBACK;
```
- [ ] **Step 2: Make the failure message useful.** Before `finish()`, add a diagnostic that lists any offenders (so a failing CI run names the table): e.g. a `SELECT diag(...)` / a second helper `SELECT` `string_agg(...)` of offending `relname`s, emitted only when the count is > 0. (Keep `plan(N)` correct for the assertions you write.)

### Task 2: Verify it passes on the current schema
- [ ] **Step 1:** `bash scripts/ci/test-disposable-supabase.sh 2>&1 | tail -40` (`--ignore-health-check`/alt-ports if 54322 held — don't touch un-owned containers). Expected: the full pgTAP suite passes INCLUDING `99000_rls_positive_invariant.test.sql` (count of un-RLS'd public tables = 0). Report pgTAP Files/Tests.
- [ ] **Step 2: Prove the guard actually bites** (don't ship an assertion that can't fail): temporarily add a throwaway `create table public.__rls_guard_probe (id int);` to a scratch migration (or `execute_sql` in a local scratch stack), re-run, confirm `99000` FAILS naming `__rls_guard_probe`, then remove the probe. Document this manual check in the PR (do not commit the probe).

### Task 3: (optional) complementary Supabase-linter note
- [ ] **Step 1:** The Supabase advisor `rls_disabled_in_public` is the same invariant at the platform layer. Add a short note to the test header (and/or `docs/`) that the pgTAP test is the CI enforcement, and the dashboard advisor / `get_advisors('security')` is the run-time cross-check on staging/prod. (No CI network dependency — the pgTAP test is self-contained; do NOT add a CI step that needs live-project credentials.)

### Task 4: PR + attest
- [ ] **Step 1:** `pnpm run typecheck` clean (no code change, confirm). Push `mt-m2-rls-invariant-guard`; PR into `main` titled `feat(ci): enforce 'every public table has RLS' positive invariant (MT-M2 task #4)`; body = the invariant, the extension-owned exclusion, the "prove it bites" evidence, and that it replaces the curated-allowlist mindset.
- [ ] **Step 2: security-compliance attests** — the invariant is correct (no false-exempt via a too-broad exclusion), it genuinely fails on a new un-RLS'd table, and there are zero silent exceptions. ATTEST to merge.

## Rollback
Delete the test file. (Purely additive; no schema/data/migration change.)

## Note
Once merged, this is the durable guard for the whole MT-M2 RLS effort: any future table lacking RLS — including if TEN-011's `signup_config` shipped without it — fails CI. It closes task #4 and gives the remediation a self-enforcing invariant instead of a hand-maintained list.
