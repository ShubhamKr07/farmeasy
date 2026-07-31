# FarmSmart Technical Review Roadmap

**Review date:** 2026-07-29

**Implementation-plan revision:** 2026-07-31
**Goal:** Reduce technical debt, speed deployments, and lower scaling cost without combining security, data, frontend, infrastructure, and operations changes into one unsafe release.

This document is roadmap and decision index. Execute detailed plans below instead of treating review findings as one implementation batch.

## Execution Plans

1. [Foundation: CI And Staging](./2026-07-31-technical-review-foundation-ci-staging.md)
2. [Release 1: Security And Correctness](./2026-07-31-technical-review-release-1-security-correctness.md)
3. [Release 2: Performance And Scalability](./2026-07-31-technical-review-release-2-performance-scalability.md)
4. [Release 3: Hosting And Deployment](./2026-07-31-technical-review-release-3-hosting-deployment.md)
5. [Release 4: Operations And Observability](./2026-07-31-technical-review-release-4-operations-observability.md)

## Required Order

```text
Foundation CI/staging
  |
  +--> Release 1 security/correctness
  |      |
  |      +--> Release 2 performance/scalability
  |                    |
  +--------------------+--> Release 3 hosting/deployment
                                 |
                                 +--> Release 4 operations/observability
```

Ordering rationale:

- Foundation comes first because repository currently has no CI workflow, no staging environment, incomplete test discovery, and mixed Drizzle/Supabase migration ordering.
- Release 1 closes active privilege escalation and broken production paths before optimization.
- Release 2 relies on database test infrastructure and API route harness established earlier.
- Release 3 creates replacement Render resources because service type/runtime are immutable.
- Release 4 relies on validated TLS, dashboard service extraction, recommender cache changes, final private networking, and protected deployments.

## Verified Critical Findings

| Severity | Finding                                                                                                | Evidence                                                                                   | Plan                |
| -------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------- |
| Critical | Authenticated user can update own `users.role`; access-token hook copies it into JWT.                  | `supabase/migrations/00002_users_rls.sql:7-10`, `00001_custom_access_token_hook.sql:12-20` | Release 1 Tasks 1-3 |
| Critical | Recommender audit insert targets removed `clerk_user_id` column.                                       | `artifacts/recommender-svc/app/query_log.py:24-30`                                         | Release 1 Task 5    |
| High     | PostgreSQL TLS disables certificate verification in Node runtime.                                      | `lib/db/src/index.ts:15`                                                                   | Release 1 Task 10   |
| High     | Only `public.users` has tracked RLS; operational tables remain exposed-schema risks.                   | `supabase/migrations/00002_users_rls.sql`                                                  | Release 1 Task 3    |
| High     | Selected metric ranges do not constrain scalar/group queries.                                          | `artifacts/api-server/src/lib/metrics/templates.ts:151-158`                                | Release 2 Task 2    |
| High     | Dashboard loads historical rows and aggregates in application memory.                                  | `artifacts/api-server/src/routes/dashboard.ts:93-137`                                      | Release 2 Task 1    |
| High     | `status=done` tasks are combined with `completed_at is null`.                                          | `artifacts/api-server/src/routes/tasks.ts:24-33`                                           | Release 1 Task 6    |
| High     | Shipment filters run after database pagination.                                                        | `artifacts/api-server/src/routes/shipments.ts:42-60`                                       | Release 1 Task 7    |
| High     | Recommender cache miss performs synchronous paid search/embedding/synthesis with duplicate-work races. | `artifacts/recommender-svc/app/main.py:51-59`, `embed_upsert.py:20-42`                     | Release 2 Task 7    |
| High     | Production dependency audit reports critical/high vulnerabilities.                                     | `pnpm audit --prod`                                                                        | Foundation Task 5   |

## Major Architecture Decisions

### Identity and data boundary

- Supabase Auth owns identities.
- Database trigger creates `public.users` profile with fixed `technician` role.
- Authorization role comes from server-controlled `public.users`, never user metadata.
- Express API remains operational-data boundary.
- Trigger rollout and direct Data API lockdown are separate releases to preserve installed mobile compatibility.

### Media privacy

- Public media bucket decision in `00003_media_storage_bucket.sql` is intentionally reversed.
- API first supports object keys and signed URLs while bucket remains public.
- Migration backfills `manual_checks.photo_urls`, `bad_tray_entries.photo_urls`, and `facility_logs.data.photoUrls`.
- Bucket becomes private only after compatibility and backfill verification.

### Database and query scaling

- SQL performs date filtering and aggregation.
- History APIs use bounded cursor envelopes with timestamp-plus-ID ordering.
- Drizzle schema and migration history change together.
- Recommender ingestion uses database lease claims; transaction-pooler session locks are prohibited.

### Deployment topology

- Add separate Supabase/Render staging environment.
- Production receives exact staging-tested SHA through protected workflow.
- Dashboard moves to new Render Static Site/CDN resource.
- Recommender moves to new Render private service.
- Existing resources remain during blue-green rollback window.

### Scheduled work and observability

- API startup has no seeding or scheduled scan side effects.
- Overdue scan runs through Render cron with transaction advisory lock.
- Render native metrics/notifications cover service health.
- Better Stack covers correlated logs, heartbeat, and custom threshold alerts.
- No automatic paid recommender cache warming is included.

## Release Gates

### Foundation

- CI `required` job passes.
- Disposable Supabase replays Drizzle then Supabase histories.
- Staging services use separate Supabase project and secrets.
- Exact CI-tested SHA reaches staging.

### Release 1

- Self-role mutation fails.
- Auth/profile orphan count is zero.
- Direct operational Data API access fails.
- Recommender audit logging, task filter, shipment pagination, and inventory validation tests pass.
- Private media signed URLs work and public URLs fail.

### Release 2

- Dashboard and metric queries use bounded date predicates.
- History defaults are capped and use matching indexes.
- Inactive panels issue no requests.
- Metric cards use one browser request per tab/range.
- Concurrent duplicate sources generate one embedding call.

### Release 3

- Static dashboard deep links work through CDN.
- Private recommender has no public URL and is reachable through API.
- Build filters include all required shared dependencies.
- Old resources remain available through rollback window.

### Release 4

- API replicas run no scheduled scans.
- Concurrency test proves one completed and one lock-skipped job.
- Alert dedupe keys are cycle/action-specific.
- Structured logs contain required fields and no sensitive canaries.
- Every monitor has delivered synthetic staging notification.

## Explicit Deferrals

- Multi-facility tenancy/RLS ownership model: current product remains single-facility and API-mediated.
- Redis/shared rate limiter: process-local limiter is acceptable only while API remains one instance.
- Queue-based recommender requests: current release adds timeout, limits, leases, and private networking first.
- Automatic recommender cache warming: excluded until curated inputs and provider-call budget exist.
- Realtime sensor streaming: current sensor model remains request/query based.

## Rollback Policy

- Database migrations are forward-only; never edit applied migration files.
- Application rollback redeploys recorded last-good SHA compatible with expanded schema.
- Render type/runtime changes use replacement resources, not in-place conversion.
- Cron rollback order is disable cron, wait for active run, then restore interval-based API if required.
- Private media emergency rollback may temporarily restore bucket public flag while retaining key backfill; return to private after signed-URL correction.

## Completion Definition

Roadmap is complete only when all five linked plans satisfy their verification gates, production rollback drill succeeds, old Render resources are removed after retention window, and accepted dependency advisories have owners plus expiry dates.
