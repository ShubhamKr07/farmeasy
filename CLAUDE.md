# CLAUDE.md

Context for AI agents working in this repo. See `README.md` for what FarmSmart is and how to run it; see `.specify/memory/constitution.md` for the binding engineering principles (code quality, testing, UX consistency, performance — v1.0.0, ratified 2026-07-26).

## Infra history (read before touching `render.yaml`, `infra/`, or deploy workflows)

- **GCP migration (abandoned 2026-07-26).** A full Render → GCP Cloud Run migration was authored on `infra/gcp-migration` (Terraform, Dockerfiles, CI/CD workflows, ADR-002, k6/e2e scripts — 10 commits). None of it was ever applied against real cloud resources (every task in `GCP_IMPLEMENTATION_PLAN.md` was marked `authored, verify pending Lane 2`). The branch was local-only (never pushed, no PRs) and was deleted outright rather than merged. `GCP_IMPLEMENTATION_PLAN.md` at the repo root is a leftover artifact of that effort — historical context only, not a live plan.
- **Supabase pivot (current initiative, started 2026-07-26).** Decision: replace Neon with Supabase Postgres, replace Clerk with Supabase Auth, replace local-disk media uploads with Supabase Storage. Render stays as the compute host for all three app services (`farmsmart-api`, `farmsmart-dashboard`, `farmsmart-recommender`) — this is a backend-services swap, not a compute migration. Single Supabase project (prod only), matching Render's existing single-environment setup. Realtime/Edge Functions were explicitly considered and dropped — no concrete feature in this codebase needs them yet (sensors are a single overwritten row, not a stream).
- Work is split into three sequenced, independently-shippable plans under `docs/superpowers/plans/`:
  1. **DB** (Neon → Supabase Postgres) — `2026-07-26-supabase-db-migration.md`. Covers ADR-003 (supersedes ADR-002), a real bug fix found during planning (`recommender-svc/app/ingest.py`'s Neon-hostname-substring hack for the unpooled connection string, which breaks silently against Supabase's unrelated hostnames), data migration, and Render cutover.
  2. **Auth** (Clerk → Supabase Auth) — not yet written.
  3. **Storage** (local-disk `multer` uploads in `media.ts` → Supabase Storage) — not yet written.
- Plan 1 is executed via subagent-driven development (GLM as implementer, Claude as orchestrator/reviewer) on a dedicated worktree branch. Check `docs/superpowers/plans/` and each plan's own status/ADR references for current progress before assuming any of this is done.

## Working conventions

- pnpm only (root `preinstall` guard refuses npm/yarn). `pnpm run typecheck` must pass before merge.
- Architecture Decision Records live in `docs/adr/` (`ADR-002` superseded, `ADR-003` current for the DB layer).
- Implementation plans live in `docs/superpowers/plans/`, one file per subsystem, following the Superpowers `writing-plans` skill format (bite-sized tasks, concrete file paths, no placeholders).
