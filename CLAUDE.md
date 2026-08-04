# CLAUDE.md

Context for AI agents working in this repo. See `README.md` for what FarmSmart is and how to run it; see `.specify/memory/constitution.md` for the binding engineering principles (code quality, testing, UX consistency, performance — v1.0.0, ratified 2026-07-26).

## Infra history (read before touching `render.yaml`, `infra/`, or deploy workflows)

- **GCP migration (abandoned 2026-07-26).** A full Render → GCP Cloud Run migration was authored on `infra/gcp-migration` (Terraform, Dockerfiles, CI/CD workflows, ADR-002, k6/e2e scripts — 10 commits). None of it was ever applied against real cloud resources (every task in `GCP_IMPLEMENTATION_PLAN.md` was marked `authored, verify pending Lane 2`). The branch was local-only (never pushed, no PRs) and was deleted outright rather than merged. `GCP_IMPLEMENTATION_PLAN.md` at the repo root is a leftover artifact of that effort — historical context only, not a live plan.
- **Supabase pivot (started 2026-07-26).** Decision: replace Neon with Supabase Postgres, replace Clerk with Supabase Auth, replace local-disk media uploads with Supabase Storage. Render stays as the compute host for all three app services (`farmsmart-api`, `farmsmart-dashboard`, `farmsmart-recommender`) — this is a backend-services swap, not a compute migration. Realtime/Edge Functions were explicitly considered and dropped — no concrete feature in this codebase needs them yet (sensors are a single overwritten row, not a stream).
- **Environments: staging + production, not single-environment.** ADR-003's original "single project, no staging/prod split" statement was superseded the next day by ADR-004 (Accepted) — there is a real, separate staging Supabase project (synthetic fixtures only, resettable, no production data copy) plus staging Render services (`farmsmart-api-staging`, `farmsmart-dashboard-staging`, `farmsmart-recommender-staging`). Promotion to production is SHA-gated (same commit that passed CI + staging). See ADR-004 and `docs/runbooks/staging-bootstrap.md`.
- Work is split into three sequenced, independently-shippable plans under `docs/superpowers/plans/`:
  1. **DB** (Neon → Supabase Postgres) — `2026-07-26-supabase-db-migration.md`, ADR-003. **Done** (cutover verified 2026-07-26).
  2. **Auth** (Clerk → Supabase Auth) — `2026-07-27-supabase-auth-migration.md`, ADR-006. **Done** — `api-server` verifies Supabase JWTs (`middlewares/supabaseAuth.ts`), no Clerk code remains.
  3. **Storage** (local-disk `multer` uploads in `media.ts` → Supabase Storage) — `2026-07-28-supabase-storage-migration.md`. **Not yet executed** — `media.ts` still uses `multer.memoryStorage()`.
- Check each plan's own status/ADR references for current progress before assuming any of this is done or stale.

## Working conventions

- pnpm only (root `preinstall` guard refuses npm/yarn). `pnpm run typecheck` must pass before merge.
- Architecture Decision Records live in `docs/adr/` (`ADR-002` superseded, `ADR-003` current for the DB layer).
- Implementation plans live in `docs/superpowers/plans/`, one file per subsystem, following the Superpowers `writing-plans` skill format (bite-sized tasks, concrete file paths, no placeholders).
