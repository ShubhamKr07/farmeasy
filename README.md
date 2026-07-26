# 🌱 FarmSmart

**Operations software for indoor vertical farms — plan grow cycles, track facilities, manage inventory and accounting, and run day-to-day operations from a phone or a desktop dashboard.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Expo](https://img.shields.io/badge/Expo-React%20Native-000020?logo=expo&logoColor=white)](https://expo.dev/)
[![React](https://img.shields.io/badge/React-Vite-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![Express](https://img.shields.io/badge/Express-API-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## Why FarmSmart

Indoor vertical farms pack dozens of grow cycles into a small footprint, and the operational complexity scales fast: which tray was seeded when, which channel is due for harvest, what's running low in inventory, what a sensor is reading right now, and who's responsible for today's tasks. Most small and mid-sized growers run this on spreadsheets and memory — which breaks down the moment a shift changes or a second facility gets added.

**FarmSmart replaces the spreadsheet.** A technician logs cycles, facility checks, and waste from a phone on the floor; that data lands directly in a real-time web dashboard the rest of the team already uses — no re-entry, no lag between what happened and what's visible.

> 📸 _<!-- TODO: add 2–3 screenshots or a short GIF of the app here. Visuals are the single biggest driver of a README getting taken seriously. -->_

---

## Key Features

- 🌿 **Grow cycle tracking** — seeding → germination → fertigation → harvest, with per-cycle status, overdue-transition alerts, and wastage-aware yield loss estimates on bad trays.
- 🏭 **Facility layout modeling** — rooms → channels → racks → trays, mirroring the physical layout of the farm; channel utilization and availability at a glance.
- 📋 **Mobile data capture** — QR-scan trays and seed lots; log equipment maintenance, waste & compost, manual environmental checks, cleaning/sanitation, receiving, and visitor/access — all from the floor.
- 🌡️ **Sensor monitoring** — pH, temperature, humidity, and water-level readings per channel, with staleness/error detection so a missing or dead sensor shows up as an alert, not silence.
- 📦 **Inventory & shipments** — seeds, nutrients, and supplies, with visibility into what's running low.
- 💵 **Accounting** — QuickBooks Online integration (P&L, balance sheet, invoices, expenses) alongside the operational data, in one dashboard.
- 📊 **Selectable metrics dashboard** — per-tab metric picker across Overview/Shipments/Inventory/Accounting, backed by a shared query-template registry so a KPI and its chart always come from the same computed number.
- 🤖 **AI recommender** — a chat assistant grounded in the farm's own live data (yield, cycles, alerts) plus general agronomy knowledge, not a generic chatbot.
- 🔐 **Clerk authentication** — email/password, Google OAuth, sign-up, and forgot-password, on both the web dashboard and the mobile app.
- 📱 **Mobile-first, OTA-updatable** — Expo/React Native for iOS and Android from one codebase, with EAS Update so JS changes ship to installed apps without a new build.

---

## Architecture

FarmSmart is a **TypeScript monorepo** (plus one Python service) managed with **pnpm workspaces**, with a strict, typecheck-gated build — a type error anywhere fails the build before anything ships.

```
farmeasy/
├── artifacts/
│   ├── farmeasy/          # Mobile app (Expo/React Native) — product name "FarmSmart"
│   ├── admin-dashboard/   # Web dashboard (React + Vite)
│   ├── api-server/        # Backend API (Express)
│   ├── recommender-svc/   # AI recommender (Python/FastAPI, Gemini + Tavily)
│   └── mockup-sandbox/    # Design/prototype sandbox
├── lib/
│   ├── api-spec/          # OpenAPI spec — single source of truth for the API contract
│   ├── api-client-react/  # Generated React Query client (orval, from api-spec)
│   ├── api-zod/           # Generated Zod schemas (orval, from api-spec)
│   ├── db/                # Drizzle ORM schema + migrations (shared by api-server)
│   └── metrics/           # Shared metrics registry (used by api-server + admin-dashboard)
├── docs/                  # Living plan/status docs (mobile alpha plan, metrics design)
├── scripts/                # Seed data, migration runner, operational tooling
├── render.yaml             # Render infra-as-code — 3 services, deploy order documented inline
├── pnpm-workspace.yaml
└── tsconfig.base.json       # Shared strict TypeScript config inherited across packages
```

The API contract lives in `lib/api-spec/openapi.yaml`; both the mobile app and the web dashboard consume typed clients generated from it (`pnpm run codegen` in `lib/api-spec`), so the three apps can't silently drift out of sync with the backend.

**Stack at a glance**

| Layer        | Technology                                             |
| ------------ | ------------------------------------------------------- |
| Mobile       | Expo, React Native, TypeScript, Clerk (`@clerk/expo`)   |
| Web dashboard| React, Vite, TypeScript, Clerk (`@clerk/clerk-react`)   |
| Backend API  | Express (Node.js), TypeScript, Drizzle ORM              |
| Recommender  | Python, FastAPI, Gemini (embeddings + synthesis), Tavily|
| Database     | PostgreSQL (Supabase)                                   |
| Tooling      | pnpm workspaces, TypeScript project references, orval codegen |
| Mobile builds| EAS Build (cloud) + EAS Update (OTA)                    |
| Deployment   | Render — see `render.yaml` for the 3-service topology   |

---

## Getting Started

### Prerequisites

- **Node.js** (LTS recommended) and **Python 3** (for the recommender service)
- **pnpm** — this repo enforces pnpm and will refuse `npm install` / `yarn` by design
- **PostgreSQL** — a Supabase instance (or any Postgres) for `DATABASE_URL`
- An **Expo/EAS account** if building the mobile app, and a **Clerk** application (dev instance is fine)

### Installation

```bash
git clone https://github.com/ShubhamKr07/farmeasy.git
cd farmeasy
pnpm install
```

### Environment

Each service reads its own env vars (see `render.yaml` for the authoritative list with comments). At minimum:

```bash
# api-server (artifacts/api-server)
DATABASE_URL=postgresql://user:password@host/db?sslmode=require
CLERK_SECRET_KEY=sk_test_...
CLERK_PUBLISHABLE_KEY=pk_test_...
CORS_ORIGIN=http://localhost:5173
FACILITY_TIMEZONE=America/New_York

# admin-dashboard (artifacts/admin-dashboard)
VITE_API_BASE_URL=http://localhost:3000
VITE_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...

# farmeasy mobile app (artifacts/farmeasy)
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
EXPO_PUBLIC_DOMAIN=localhost:3000   # api-server host, no protocol
```

QuickBooks (accounting) and the recommender service (Gemini/Tavily) have their own optional env vars — see `render.yaml` for the full set; the app degrades gracefully without them.

### Running the app

```bash
# Type-check the whole workspace (run this first — most other scripts assume it's clean)
pnpm run typecheck

# Build all packages
pnpm run build

# Start the backend API
cd artifacts/api-server && pnpm run dev

# Start the web dashboard
cd artifacts/admin-dashboard && pnpm run dev

# Start the mobile app (Android emulator)
cd artifacts/farmeasy && pnpm run android
# or for JS-only iteration against an existing dev-client build:
npx expo start
```

Regenerate typed API clients after touching `lib/api-spec/openapi.yaml`:

```bash
cd lib/api-spec && pnpm run codegen
pnpm run typecheck:libs   # from repo root — rebuilds lib/* project references
```

---

## Testing

```bash
cd artifacts/api-server && pnpm run test          # full test suite
cd artifacts/api-server && pnpm run test:metrics  # metrics-specific tests
```

---

## 🛠️ Engineering Highlights

- **Full-stack TypeScript**, one OpenAPI contract — `lib/api-spec` generates the typed clients both the mobile app and web dashboard consume, so client/server drift fails at typecheck, not at runtime.
- **Monorepo architecture** — pnpm workspaces with TypeScript project references; a `preinstall` guard enforces a consistent toolchain across every contributor.
- **One compute path per number** — dashboard KPIs and their charts are computed from the same query/template, never duplicated between client JS and server SQL.
- **Type-safety as a quality gate** — `pnpm run typecheck` runs before builds; CI-equivalent checks are part of the standard workflow, not an afterthought.
- **Mobile-first, OTA-capable** — Expo/React Native across iOS and Android from one codebase, with EAS Update wired in so a JS-only change reaches installed apps without a store release.
- **Domain modeling for operations** — the physical reality of a vertical farm (rooms → channels → racks → trays, growth profiles, sensors) translated into a clean, queryable schema.
- **AI grounded in real data** — the recommender combines the farm's own live operational snapshot with general agronomy knowledge, rather than answering from a generic model alone.
- **Deploy-ready** — `render.yaml` defines all three backend/web services as infrastructure-as-code, with the first-deploy order documented inline.

---

## Roadmap

- [ ] Poller/ingestion job for real per-channel sensor hardware (the data model supports it; nothing is wired to live sensors yet)
- [ ] Production mobile build + app store distribution (currently internal/preview only)
- [ ] Offline-first support for low-connectivity grow rooms
- [ ] Role-based access for multi-person farm teams beyond the current single-role badge

---

## License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

## Author

**Shubham Kumar**
[LinkedIn](https://www.linkedin.com/in/shubhamkumarcse) · [GitHub](https://github.com/ShubhamKr07)

> Built to bring operational rigor to indoor agriculture — combining full-stack engineering with a strategy-and-operations background in turning real-world workflows into reliable software.
