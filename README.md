# Lake & Pine Cleaning Co.

Premium home-cleaning service for Coeur d'Alene + Spokane. Production Next.js app at
`apps/web`: estimate engine, 6-step persisted booking flow, customer dashboard,
Pine Concierge, and 7 local-SEO area pages on the recovered prototype's design system.

## Run

```bash
docker start lp-postgres        # local Postgres 17 on :5442 (create: see below)
pnpm install
pnpm --dir apps/web dev         # http://localhost:3010
```

First-time database setup:

```bash
docker run -d --name lp-postgres --restart unless-stopped \
  -e POSTGRES_PASSWORD=lakeandpine_dev -e POSTGRES_DB=lakeandpine \
  -p 5442:5432 -v lp-pgdata:/var/lib/postgresql/data postgres:17-alpine
docker exec -i lp-postgres psql -U postgres -d lakeandpine < supabase/migrations/0001_core.sql
docker exec -i lp-postgres psql -U postgres -d lakeandpine < supabase/migrations/0002_content_seed.sql
pnpm ops:seed-content           # service areas + placeholder reviews
pnpm ops:seed-dev               # demo customer for dashboard preview (is_dev_seed)
```

Start the app against a disposable migrated database with a random 32+ character smoke
token. Set the same token in the smoke process; mismatches fail closed before any write or
email delivery:

```bash
RUNTIME_SMOKE_TOKEN='<same-random-32+-character-value>' pnpm dev
RUNTIME_SMOKE_TOKEN='<same-random-32+-character-value>' \
  RUNTIME_SMOKE_BASE_URL=http://127.0.0.1:3010 pnpm ops:smoke-runtime
```

See [the non-production runtime proof](docs/ops/non-production-runtime-proof.md) for the
captured evidence, cleanup behavior, and the boundary between runtime-proven surfaces and
provider- or money-gated work.

Copy `.env.example` values into `apps/web/.env.local` (dev `DATABASE_URL` above).
`pnpm ops:purge-dev-seed` removes every `is_dev_seed` row before launch.

## Stack (cross-portfolio lock)

Clerk (auth) · Supabase Postgres via `DATABASE_URL` (data) · Stripe (payments) ·
Resend (email) · PostHog (analytics) · Sentry (errors) · Mapbox (maps) · Vercel (hosting).
All integrations are wired and key-gated — see `.env.example` for exactly what go-live needs.

**Live:** https://lakeandpine.vercel.app (Vercel project `lakeandpine`, root `apps/web`).
Production DB: Supabase project `fftnqsvxxsxcsiwvtmwr` (us-west-1), connected via the
scoped `lakeandpine_app` role through the **aws-1**-us-west-1 pooler (new projects live on
the aws-1 Supavisor cluster — aws-0 returns "tenant not found"). Migrations + catalog +
area content are applied. Remaining key-gated: Clerk, Stripe, Resend, PostHog, Sentry, Mapbox.

## Preserved historical source

- Recovered standalone prototype: `prototypes/recovered/2026-06-24/lake_pine_cleaning_visionary_v3.html`
- Recovery provenance: `docs/recovered/claude-desktop-recovery.md`
- Canonical product truth: `docs/product/recovered-product-truth.md`

The recovered prototype is the design/UX source of truth; the production app lives in `apps/web`.
