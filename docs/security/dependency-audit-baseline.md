# Production Vulnerability Baseline (Task 6 remediation)

**Date:** 2026-07-31
**Owner:** security-team
**Related:** `docs/security/dependency-audit-allowlist.json`, `scripts/ci/check-dependency-audit.mjs`, `pnpm-workspace.yaml#auditConfig`

---

## Purpose

This document records the production vulnerability baseline established by Task 6:
the set of high/critical advisories found across the npm and Python dependency
trees of FarmSmart's production artifacts, how each was resolved, and the
allowlist entries that remain accepted (with explicit, time-bounded expiry).

The CI gate (`.github/workflows/ci.yml` → `dependency-audit` job →
`check-dependency-audit.mjs`) enforces this baseline on every push and pull
request. Any high/critical advisory without a remediation (override / version
bump) or an **unexpired** allowlist entry fails the build.

---

## Original findings (pre-remediation)

| Ecosystem | Critical | High | Moderate | Low | **Total** |
|-----------|---------|------|----------|-----|-----------|
| npm       | 1       | 14   | 9        | 4   | **28**    |
| Python    | —       | —    | —        | —   | **13**    |

* npm: 28 advisories spanning 1 critical, 14 high, 9 moderate, 4 low.
* Python: 13 advisories across the `recommender-svc` production lockfile.

Only **high** and **critical** severities gate the build; moderate/low are
reported for visibility but never fail CI.

---

## Resolution summary

All actionable high/critical findings were resolved by one of two mechanisms:

1. **Override / version bump** — the transitive dependency is forced to a
   minimum patched version via `pnpm-workspace.yaml#overrides` (npm) or a
   direct dependency bump in `artifacts/recommender-svc/pyproject.toml`
   (Python).
2. **Accepted false positive** — documented in
   `dependency-audit-allowlist.json` with owner, rationale, acceptance date,
   and an expiry date no more than 30 days out. The entry is mirrored under
   `pnpm-workspace.yaml#auditConfig.ignoreGhsas` so native `pnpm audit` output
   stays clean; the JSON record remains the source of truth and its expiry is
   enforced by `check-dependency-audit.mjs`.

### npm — resolved via overrides

| Dependency        | Override / version bump                         |
|-------------------|-------------------------------------------------|
| `tar`             | override → `7.5.21`                             |
| `http-proxy-middleware` | override → `4.1.1`                       |
| `undici`          | override → `6.27.0`                             |
| `brace-expansion` (1.x / 2.x / 5.x) | overrides → `^1.1.16`, `^2.1.2`, `^5.0.8` |
| `js-yaml` (3.x / 4.x) | overrides → `^3.15.0`, `^4.3.0`            |
| `shell-quote`     | override → `1.9.0`                              |
| `fast-uri`        | override → `3.1.4`                              |
| `postcss`         | override → `8.5.18`                             |
| `uuid`            | override → `11.1.1`                             |
| `qs`              | override → `6.15.2`                             |
| `@babel/core`     | override → `7.29.7`                             |
| `body-parser`     | override → `2.3.0`                              |

**12 npm dependencies remediated via overrides/version bumps.**

### npm — accepted false positive (allowlist)

| GHSA                  | Dependency        | Status                                                                 |
|-----------------------|-------------------|------------------------------------------------------------------------|
| `GHSA-mh99-v99m-4gvg` | `brace-expansion` | False positive — see allowlist JSON for full justification. Time-bounded, expires **2026-08-30**. |

**1 npm advisory accepted as a documented false positive.**

### Python — resolved via version bumps

| Dependency   | Resolution                                   |
|--------------|----------------------------------------------|
| `gitpython`  | bumped → `3.1.57` in `recommender-svc/pyproject.toml` |
| `pyasn1`     | bumped → `0.6.4`                             |
| `setuptools` | bumped → `83.0.0`                            |

**3 Python dependencies remediated via version bumps.**

---

## Current baseline status

| Severity | npm | Python | Gate behavior |
|----------|-----|--------|---------------|
| Critical | 0 unresolved (1 remediated) | 0 unresolved | **fails CI** |
| High     | 0 unresolved (14 remediated) + 1 accepted false positive | 0 unresolved (3 remediated) | **fails CI** |
| Moderate | reported only | reported only | informational |
| Low      | reported only | reported only | informational |

**Net result:** 0 unresolved high/critical advisories in either ecosystem. The
single remaining entry (`brace-expansion` / `GHSA-mh99-v99m-4gvg`) is a
documented false positive with an unexpired, owner-attributed allowlist record;
its suppression is mirrored under `auditConfig.ignoreGhsas` and will expire on
**2026-08-30**, after which it must be re-evaluated or removed.
