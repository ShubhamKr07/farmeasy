<!--
Sync Impact Report
Version change: none → 1.0.0 (initial ratification)
Modified principles: n/a (first fill of template placeholders)
Added sections:
  - Core Principles: I. Type-Safe, Production-Grade Code Quality; II. Test-First & Testing
    Standards; III. Cross-Platform UX Consistency; IV. Performance & Scalability Requirements
  - Technology & Architecture Constraints
  - Development Workflow & Release Gates
  - Governance
Removed sections: none (template placeholders only)
Templates requiring updates:
  - .specify/templates/plan-template.md: ✅ Constitution Check section is generic and reads
    principles from this file at plan time — no edit needed.
  - .specify/templates/spec-template.md: ✅ no constitution-specific references to update.
  - .specify/templates/tasks-template.md: ✅ no constitution-specific references to update.
  - .claude/skills/speckit-*/SKILL.md (this command and siblings): ✅ generic, no agent-specific
    naming found that needed correction.
Follow-up TODOs: none — no placeholders deferred.
-->

# FarmSmart Constitution

## Core Principles

### I. Type-Safe, Production-Grade Code Quality (NON-NEGOTIABLE)

Strict TypeScript is enforced across the monorepo; `pnpm run typecheck` (project-reference
build plus per-app typecheck) MUST pass before any merge. Implicit `any` and suppressed
type errors are prohibited unless accompanied by an inline comment justifying the specific
escape hatch. pnpm is the only sanctioned package manager — the `preinstall` guard MUST NOT
be bypassed, and no `package-lock.json` or `yarn.lock` may be committed. The OpenAPI spec at
`lib/api-spec/openapi.yaml` is the single source of truth for the API contract; any
contract-affecting change MUST regenerate and commit `lib/api-client-react` and
`lib/api-zod` (`pnpm run codegen`) in the same change — hand-written types duplicating the
contract are prohibited. CI guard checks (`ci-guard.yml`) covering deploy-target drift and
secret-shaped literals MUST pass on every PR and MUST NOT be bypassed.

**Rationale**: Farm operators depend on this software for live grow-cycle and financial
records. A type error or contract drift that reaches production corrupts data that cannot be
un-shipped tray by tray or un-posted from the ledger.

### II. Test-First & Testing Standards (NON-NEGOTIABLE)

New business logic — grow-cycle state transitions, wastage/yield calculations, metrics-registry
computations, inventory thresholds — MUST have unit tests written before implementation
(Red-Green-Refactor); a failing test is required evidence before the corresponding fix or
feature lands. Every API route change MUST carry a corresponding contract or integration test
in `artifacts/api-server` (`pnpm run test`, `pnpm run test:metrics`); a KPI and the chart that
renders it MUST be asserted against the same shared query-template in `lib/metrics`, never
against parallel, independently-derived logic. End-to-end user flows (authentication, dashboard
load, mobile capture) MUST be covered by Playwright specs in `tests/e2e`; any flow that does not
require physical hardware or human execution MUST be automated rather than left to a manual
checklist. Manual smoke checklists (e.g. `scripts/e2e-smoke.md`) are permitted only where a step
requires physical hardware or a third-party sandbox OAuth round-trip the CI runner cannot
perform, and each such item MUST name the specific configuration it proves, not just pass/fail.

**Rationale**: This system touches accounting (QuickBooks) and physical operations (sensors,
harvest). A silent regression here costs real inventory or produces bad financial reporting —
not just a support ticket.

### III. Cross-Platform UX Consistency

Mobile (Expo/React Native) and web (React/Vite) MUST present identical domain vocabulary,
status semantics, and metric values for the same underlying data. This MUST be enforced
structurally — both platforms consume the same generated `api-client-react`/`api-zod` clients
and the shared `lib/metrics` registry — never by independently re-deriving a number or label.
Any screen displaying a sensor reading, alert, or overdue-transition state MUST visually
distinguish "stale/no data" from "value is zero/normal"; silence is never an acceptable
representation of monitoring data. Authentication, error, and empty states MUST follow one
shared pattern per platform; a new screen that introduces an inconsistent pattern is a review
blocker, not a style suggestion.

**Rationale**: A technician on the floor and a manager on the dashboard must trust they are
looking at the same facility state. Divergence between mobile and web is what pushed growers
back to spreadsheets in the first place, and it is the failure mode this product exists to
eliminate.

### IV. Performance & Scalability Requirements

API endpoints MUST be validated against defined load profiles (k6 burst/soak scripts) before
carrying production traffic; a regression beyond the agreed p95 latency budget blocks release
until resolved or explicitly waived in the plan's Complexity Tracking. Database access MUST use
the connection mode (pooled vs. direct) prescribed by ADR-002 for the access pattern in
question; introducing an N+1 query pattern against `lib/db` is a review blocker, not a
follow-up ticket. Mobile data-capture flows (QR scan, facility logging) MUST remain responsive
under facility-floor network conditions — a flow that blocks the UI thread on a network
round-trip is non-compliant. Every new API route MUST explicitly document its rate-limit
classification at the point of definition (e.g. the 30 req/min/IP limit on
`GET /api/seed-lots/lookup`), matching the established threat/load model; an undocumented
limit is not an acceptable default.

**Rationale**: This is real-time operational software. A slow dashboard or a timed-out mobile
log during harvest is not a UX inconvenience — it is a missed data point that can never be
recaptured.

## Technology & Architecture Constraints

The repository is a single pnpm workspace monorepo; no package may introduce an alternate
package manager or a standalone lockfile. TypeScript project references define the build graph
in `tsconfig.base.json` and MUST be kept accurate — a package that needs another package's
types declares the reference, it does not duplicate them. Infrastructure is managed as code:
GCP resources under `infra/envs/{staging,prod}` and their shared `infra/modules/*` MUST NOT be
modified by hand in the cloud console outside of break-glass incident response, and any such
break-glass change MUST be reconciled back into Terraform in the same or an immediately
following change. Render remains infra-as-code (`render.yaml`) for the duration of the GCP
migration, per `GCP_IMPLEMENTATION_PLAN.md`. Architecture Decision Records under `docs/adr`
are REQUIRED before implementing any change to data retention policy, database connection
pooling strategy, or cross-service topology — the decision is recorded before the code, not
after.

## Development Workflow & Release Gates

A PR merges to `main` only after: the CI guard workflow passes, `pnpm run typecheck` passes,
and the test suite(s) relevant to the changed package(s) are green. Deploys to production
(`deploy-prod.yml`) MUST be preceded by a successful staging deploy (`deploy-staging.yml`) and
a passing e2e smoke pass against staging. Any exception to a Core Principle (skipping a test,
deferring a load-test gate, bypassing a CI guard category) MUST be recorded as a justified
deviation in the relevant plan's Complexity Tracking section — silent exceptions are not
permitted. Code review MUST explicitly check the four Core Principles above; a reviewer who
approves a change that violates one without a recorded justification is out of compliance with
this constitution, not just exercising judgment.

## Governance

This constitution supersedes ad hoc conventions and prior undocumented practice; where they
conflict, this document governs. Amendments are proposed via a PR that edits this file directly,
MUST include an updated Sync Impact Report as the leading HTML comment, and MUST pass the same
review and CI gates as any other change before merging to `main`. Versioning follows semantic
versioning: MAJOR for backward-incompatible principle removals or redefinitions, MINOR for a
new principle or materially expanded guidance, PATCH for clarifications and non-semantic
wording fixes. Every `/speckit-plan` run MUST pass the Constitution Check gate before Phase 0
research begins, and any complexity introduced against a principle MUST be justified in that
plan's Complexity Tracking section rather than silently absorbed.

**Version**: 1.0.0 | **Ratified**: 2026-07-26 | **Last Amended**: 2026-07-26
