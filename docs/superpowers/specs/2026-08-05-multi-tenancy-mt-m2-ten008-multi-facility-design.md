# TEN-008 — Multi-Facility Operations Design

**Scope of this document:** the first of five sub-projects decomposed out of MT-M2 ("Multi-facility + front door", per the PRD's own milestone table: TEN-008, TEN-010 rev. B, TEN-012, TEN-013, TEN-009 stubs). This document covers **TEN-008 only** — organizations holding 1..n facilities, the active-facility switcher, and the "Add facility" flow. TEN-009 (org rollup stubs), TEN-010 rev. B (team invites/roles), TEN-012 (public sign-up), and TEN-013 (demo mode) are each their own future sub-project, not covered here.

**PRD requirement:** TEN-008 · Multi-facility operations [P0]. "Organizations hold 1..n facilities. 'Add facility' loops wizard W2 → W3 → W3.5 from the facility switcher (web header, mobile profile sheet). All facility-scoped surfaces bind to the active facility; each facility runs its own readiness checklist. v1 membership visibility: all org members see all facilities (Q24 default adopted)."

## 1. Current-state audit

- **Facilities/rooms are already multi-facility-shaped at the data-model level.** MT-M0/MT-M1 built `facilities` as per-org rows and `rooms` as per-facility rows (`UNIQUE(facility_id, name)`). Nothing in the schema itself assumes one facility per org — the constraint lives entirely in application code.
- **`POST /facilities` hard-blocks a second facility.** `artifacts/api-server/src/routes/facilities.ts` throws `AlreadyHasFacilityError` (409) if `usersTable.organizationId` is already set — a per-*user*, not per-org, check. This is the one artificial gate standing between today's schema and TEN-008.
- **`resolveTenantContext` resolves facility as "the org's one facility."** `artifacts/api-server/src/middlewares/tenantContext.ts` explicitly flags this as provisional in its own doc comment: "MT-M2's TEN-008 changes this lookup, not the middleware's shape, when multi-facility ships." No client input is read today; the join just takes the org's only facility row.
- **`wizard_progress` is a per-user singleton, not per-facility.** One row per user (`UNIQUE(user_id)`), no facility or run dimension. `FacilityGate` (`artifacts/admin-dashboard/src/App.tsx`) wraps the entire router on a single per-user "is the wizard done?" boolean — it doesn't know about individual facilities at all.
- **Both frontends share one API-call chokepoint.** `lib/api-client-react/src/custom-fetch.ts` (`customFetch`) is the single function every generated hook in both `admin-dashboard` (web) and `farmeasy` (mobile, Expo) calls through — already the place the Supabase JWT gets attached. A new header goes in exactly this one file, not fanned out across ~50+ call sites.
- **Org-scoped resources are already correctly org-scoped.** Growth profiles, sensor accounts, and the QuickBooks connection (`accounting_connections`) all key on `organization_id`, not `facility_id`, post-MT-M1 — TEN-008's "org-scoped objects visible from every facility" acceptance criterion is satisfied by existing MT-M0/MT-M1 work, not new code.

## 2. Design decisions

**Active-facility signal: explicit client header, not server-side session state.** The client sends `X-Facility-Id` on every facility-scoped request; `resolveTenantContext` validates it against real `organization_members`/`facilities` rows on every request (no trust in a cached/stale value). Matches how `withTenantScope` already treats every request as independently re-verified — no new session store to keep in sync or invalidate.

**Hard requirement, no fallback default.** A facility-scoped request with a missing or invalid `X-Facility-Id` is a 400. Both frontends must be updated to always send it as part of this same sub-project — deliberately not shipping a "falls back to the org's first facility" compatibility path, which would let a missed call site silently keep working for single-facility orgs today and only break once a real org adds facility #2, at the worst possible time to discover it.

**Both platforms (web + mobile) get the real switcher UI now**, not a web-only ship with a mobile stopgap — matches the PRD's literal "web header, mobile profile sheet" text, and a stopgap on mobile (e.g. "just auto-pick facility #1, no switcher") would reintroduce exactly the kind of hidden single-facility assumption this whole milestone exists to remove.

**`wizard_progress` becomes per-`(user_id, facility_id)`**, reusing the existing wizard component/steps for every "Add facility" run rather than building a second, parallel flow — matches the PRD's literal "loops wizard W2 → W3 → W3.5." `facility_id` is nullable: a wizard run in progress has no facility yet until W2's own `POST /facilities` call succeeds and stamps the row with the real id.

**Who can add a facility: no role restriction in this sub-project.** TEN-008's acceptance criteria don't mention role-gating "add facility," and role-based permissions (owner/admin/technician) are TEN-010 rev. B's scope, not built yet. Any authenticated org member can add a facility for now; TEN-010 can layer a restriction on top later without this sub-project needing to anticipate it.

## 3. Architecture

`resolveTenantContext` (rewritten): reads `X-Facility-Id` from the request, joins `organization_members` (user's real org memberships) to `facilities` (facility must belong to one of those orgs), populates `req.tenant = { organizationId, facilityId, role }` exactly as today — only the *lookup key* changes, not the shape consumers see. Every existing `withTenantScope`-wrapped route handler is unaffected by this change; they already just read `req.tenant.facilityId`.

Routes needing a facility (anything currently gated by `requireTenantContext`) 400 if the header is absent/invalid. Routes that are genuinely org-scoped, not facility-scoped (accounting connect/status, growth-profiles list, the wizard's own W2 `POST /facilities` call before any facility exists) don't require the header at all.

`wizard_progress` migration: add `facility_id integer NULL REFERENCES facilities(id)`, drop the existing `UNIQUE(user_id)`, add `UNIQUE(user_id, facility_id)`. A partial unique index may be needed for the `facility_id IS NULL` case (at most one in-progress, not-yet-facility-created wizard run per user at a time) — confirmed during planning, not finalized here.

`FacilityGate` (frontend): instead of "does this user have any `wizard_progress` row with `currentStep = done`," it becomes "does the row for `(user, activeFacilityId)` say done" — gating per-facility, not per-user. A brand-new "Add facility" action starts a wizard run with `facilityId: null` (mirrors first-time onboarding exactly), which on completion becomes a normal `(user, newFacilityId)` row.

## 4. Components

**Backend:**
- `middlewares/tenantContext.ts` — facility-lookup rewrite (above).
- `routes/facilities.ts` — remove the `AlreadyHasFacilityError` 409; add `GET /facilities` (list, for the switcher's dropdown/sheet, including each facility's readiness-checklist completion count).
- `routes/wizard.ts` + a new Drizzle migration — thread `facilityId` through `GET`/`PUT /wizard/progress`, per the schema change above.
- Route-handler audit — sweep every MT-M1-rewired handler (the plan doc's own flagged risk: "every one of these handlers needs re-auditing to confirm none of them cache, hardcode, or otherwise assume single-facility behavior beyond just reading the field") for anything beyond a plain `req.tenant.facilityId` read.

**Frontend:**
- `lib/api-client-react/src/custom-fetch.ts` + a new `setFacilityId()` export — the one place the header gets attached, alongside the existing auth-token attachment. Shared by both apps.
- Facility-switcher component, both apps: web header dropdown (`admin-dashboard`), mobile profile-sheet equivalent (`farmeasy`, `HamburgerMenu.tsx`) — both persisted (localStorage / AsyncStorage) and restored at boot, both hidden entirely when the org has exactly one facility. Both read-and-switch only — see §3a.
- "Add facility" entry point — **web only** (`admin-dashboard`), launching the existing wizard component with `facilityId: null`. Not built on mobile (§3a).

## 5. Data flow

User switches facility (or app boots and restores the persisted selection) → `setFacilityId(id)` → every subsequent API call carries `X-Facility-Id: id` → `resolveTenantContext` re-validates real membership on every single request (never trusts the client's prior validation) → `req.tenant` reflects the switch → existing `withTenantScope`-wrapped routes behave exactly as they do today, just scoped to a different facility. Identical on mobile — switching there is a pure client-side selection change, no separate auth step (§3a).

"Add facility" (web only): user taps the entry point → wizard opens with no `facilityId` yet → W2's `POST /facilities` succeeds → the in-progress `wizard_progress` row (previously keyed on `facilityId: null`) gets stamped with the real new facility id → W3/W3.5 proceed exactly like first-time onboarding, just for this new facility → on completion, the switcher's facility list (both platforms) includes it and the checklist shows its own independent progress.

## 6. Error handling

Missing or invalid `X-Facility-Id` on a facility-scoped route → 400 (a client-bug class, distinct from 404/403 — the resource-ownership question doesn't even apply yet if the client hasn't named a real facility). A facility id that's real but belongs to a different org (or an org the user isn't a member of) → 400 as well, not 404 — same class of error as "missing," since `resolveTenantContext` treats both identically (no real, resolvable facility for this request).

## 7. Testing

Extends `cross-tenant.test.ts`'s existing cross-*organization* pattern one level deeper: same org, two facilities. New assertions: facility A's cycles/inventory/alerts never render while facility B is active for the *same user, same org*; adding facility #2 leaves facility #1's data completely untouched; org-scoped objects (growth profiles, sensor accounts, QBO connection) are identical regardless of which facility is active; a missing or wrong-org `X-Facility-Id` 400s rather than silently resolving to some facility.

## 8. Explicitly not in this document

TEN-009 (org rollup stubs), TEN-010 rev. B (team invites, roles, the technician mobile-only enforcement), TEN-012 (public sign-up), TEN-013 (demo mode) — each its own future sub-project. Role-based restriction on who can add a facility (TEN-010's territory). Per-facility membership assignment (Q24 explicitly defaults this to "all org members see all facilities" for v1 — a future RBAC initiative's scope, not this one).

## 3a. Mobile scope correction: switcher only, no wizard, no add-facility

**Corrected during planning — supersedes the "both platforms get an add-facility entry point" line in §4 below.** Technicians authenticate on mobile only (`farmeasy` has its own independent Supabase Auth session; there is no separate web login for a technician). By design, `farmeasy` never creates facilities and never runs the onboarding wizard — the wizard (`Wizard.tsx`, W2→W4) stays exactly what it is today: a web-only, `admin-dashboard`-only flow. A facility a technician can switch to on mobile must already exist (created by an owner/admin on web).

**"Switching facility" on mobile is not a re-authentication event** — it's the same per-request re-validation the architecture already does for every facility-scoped call (§3: `resolveTenantContext` re-validates `X-Facility-Id` against real `organization_members`/`facilities` rows on every request, never trusting a cached value). Mobile's job is: fetch `GET /facilities` (the org's real, existing facility list — same endpoint the web switcher uses), let the technician pick one, persist the selection, and send `X-Facility-Id` on every subsequent call. If a technician is later removed from a facility's org (or the org itself), the very next request 400s — there is no separate "check access" step to build.

**Mobile scope for TEN-008 is therefore: the facility switcher UI only** (profile sheet — `HamburgerMenu.tsx`), reading and switching among facilities that already exist. No "Add facility" entry point on mobile, no wizard hand-off, no in-app browser, no session bridge.

## 9. Risks and gaps

- **The `wizard_progress` schema change is the highest-risk single piece.** Every existing row (one per user, all currently representing "facility #1's" onboarding) needs a backfill to the real `facility_id` it actually belongs to before the unique constraint changes — an expand→backfill→contract migration, matching the pattern MT-M0 already established for `rooms.facility_id`. Getting the backfill's facility-resolution logic wrong (which facility does an EXISTING wizard_progress row belong to?) would misattribute a user's onboarding history.
- **`FacilityGate`'s rework touches the single most load-bearing frontend gate in the app** — it currently wraps the entire admin-dashboard router. A bug here doesn't fail one feature, it can block or wrongly unblock the whole app for a user. Warrants the same empirical, not-just-typechecked verification discipline MT-M1 used throughout.
- **The route-handler audit (MT-M1's own flagged risk) is qualitative, not mechanical** — `check-tenant-scope.mjs` can catch "doesn't use `withTenantScope`" but can't catch "uses it correctly but with a cached/hardcoded facility id from an earlier request." This needs actual reading of each handler, not just a passing CI check.
- **Hard-requiring the header everywhere is a real, immediate breaking change** to both frontends the moment the backend ships it — this sub-project's backend and frontend halves need to land together (or behind a short-lived feature flag), not as independently-mergeable PRs, or there's a window where every facility-scoped request from a not-yet-updated frontend 400s.
- **No production traffic exists yet at real multi-facility scale** — this design is unverified against anything beyond the pilot's single facility until a real second facility gets created (staging test orgs, same discipline as MT-M1's `cross-tenant.test.ts`, not just typechecking).
