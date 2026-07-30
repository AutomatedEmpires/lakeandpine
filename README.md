# Lake & Pine

Operations platform for premium property care: consultation-first customer intake, qualified crews, capacity-backed scheduling, and accountable service recovery — enforced in PostgreSQL, not just in the UI.

[![CI](https://github.com/AutomatedEmpires/lakeandpine/actions/workflows/ci.yml/badge.svg)](https://github.com/AutomatedEmpires/lakeandpine/actions/workflows/ci.yml)

## Overview

Lake & Pine is a property-care company in software form. It runs the full journey for interior-care work that rewards precision over volume: a prospective customer describes their property and goals, an operator qualifies the request, a capacity-checked crew plan is proposed, service is delivered and closed out, and anything that goes wrong flows through a structured recovery workflow.

Three groups use it. Customers get a public site with a consultation request flow, a service dashboard, and support for reschedules, cancellations, complaints, recleans, and refund review. Cleaners get a private crew workspace for assignments, clocking, time off, callouts, and supply usage. Operators get a command center covering qualification, scheduling, workforce, inventory, time, compensation, and service recovery.

The product deliberately does not sell instant anything. Requests are not instant bookings, prices are custom proposals prepared after qualification, and preferred dates remain preferences until an operator confirms capacity. That restraint is encoded in the schema and API behavior, not only in the copy.

## Why it exists

Interior care for private estates, construction handoffs, and lake and marine vessels is scoped work: finishes, access, timing, and crew qualifications matter more than speed. Generic booking tools assume commodity jobs — a fixed price, a time slot, an interchangeable worker. Lake & Pine is built for the opposite case: disciplined scoping, evidence-backed service areas, capacity-aware crews, and an auditable record for every decision, including the ones that touch money.

## Product

Content and intake are organized around four service programs: Private Estate Care, Construction Handoff, Lake & Marine Interior Care, and Select Commercial Care.

**Public market site** (`apps/web/src/app`) — service programs, custom-proposal pricing, service-area pages (Mapbox map with a branded SVG fallback), reviews, who-we-serve, and a multi-step property consultation request (`PremiumRequestFlow`, `/book`). Structured data, sitemap, and robots are generated. Public intake is fail-closed: submissions are refused unless `REQUEST_INTAKE_ENABLED` is explicitly on, and direct-contact CTAs stay hidden until verified phone/email values are configured.

**Pine Concierge** (`/api/concierge`) — a rate-limited, rule-based Q&A dock that answers program-scope and boundary questions with vetted copy. No external AI calls; every reply is a code-reviewed string.

**Customer dashboard** (`/dashboard`) — bookings, checklists, follow-ups, and a billing history fed by signature-verified Stripe events once payments activate. Clerk-protected.

**Crew workspace** (`/crew`) — assignments, clock in/out, time-off requests, callouts, inventory usage, and restock requests for screened cleaners. Recruiting itself runs through `/join`, gated separately.

**Operations console** (`/operator`) — qualification review, capacity-aware crew suggestions, scheduling (`/operator/schedule`), workforce and roles (`/operator/workforce`), organization network view (`/operator/network`), inventory, time review, compensation and bonuses, and service recovery (`/operator/recovery`) covering complaints, recleans, refund decisions, and notification retries.

**Organization and team scoping** — a five-role hierarchy (owner, general manager, manager, shift lead, cleaner) maps to 14 named operations capabilities (`apps/web/src/lib/team-operations.ts`). Organization-wide memberships span teams; local memberships carry a team ID. The application sets the authenticated actor inside every database transaction and row-level security enforces the same boundary in PostgreSQL — a missing or mismatched actor context fails closed.

**The money boundary** — the refund ledger records decisions; it never moves money. `/api/checkout` returns 503 while `PAYMENTS_ENABLED` is false, and the Stripe webhook only records signature-verified events into billing history. Restocks, bonuses, pay rates, and workforce events remain approval-gated records until an authorized human completes the real-world action.

## Status

Lake & Pine is pre-launch: the platform is built, CI-gated, and deployable, but it is not serving customers.

| Capability | State |
| --- | --- |
| Public market site + consultation flow | Built; intake ships fail-closed behind `REQUEST_INTAKE_ENABLED=false` |
| Pine Concierge | Built (rule-based, rate-limited) |
| Customer dashboard | Built; requires Clerk keys to run |
| Crew workspace + operations console | Built, with RLS-scoped organization/team permissions |
| Cleaner recruiting (`/join`) | Built; gated behind `CLEANER_APPLICATIONS_ENABLED=false` |
| Payments | Stripe checkout and signature-verified webhook exist in code, hard-gated behind `PAYMENTS_ENABLED=false`; not operating |
| Email | Resend wired with reply-to isolation; a verified sender is a precondition for enabling intake |
| Analytics / monitoring | PostHog and Sentry integrated; inactive without keys |
| Domain | `lakeandpinecleaning.com` is the configured production canonical; DNS ownership and business phone/email remain external launch dependencies |

Flipping the three operating gates is a founder decision. Note one prerequisite the gates do not enforce for you: `PAYMENTS_ENABLED=true` with a secret key and a price configured is enough for `/api/checkout` to create a payable Stripe Checkout session, while `/api/webhooks/stripe` still returns 503 for every event unless `STRIPE_WEBHOOK_SECRET` is also set. Configure the webhook secret before enabling payments, or customers can be charged with no billing-history or payment-failure processing behind it.

## Architecture

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS 4 |
| Database | PostgreSQL (Supabase) via the `postgres` driver — no ORM |
| Auth | Clerk (customer, crew, and operator surfaces) |
| Email | Resend, reply-to isolated from the sender identity |
| Payments | Stripe (gated; see Status) |
| Analytics | PostHog |
| Monitoring | Sentry |
| Maps | Mapbox GL with a branded SVG fallback |
| Hosting | Vercel |
| Tooling | pnpm workspace, Node 24 |

```text
apps/web/                the entire application (Next.js App Router)
  src/app/               public site, dashboard, crew, operator, API routes
  src/lib/               domain logic: scheduling, team operations, service cases, env gates
  scripts/               migration verifier, seeds, runtime smoke test
supabase/migrations/     ordered SQL migrations (schema + RLS, 8 files)
docs/                    product operating model, domain contracts, ops runbooks and evidence
prototypes/recovered/    preserved historical prototype (provenance, not product)
```

The schema ships as eight ordered migrations, from `core` and `content_seed` through `service_planning_foundation` and `production_schema_hardening` to the four `national_*` migrations that add organization/team scope, workforce time-off scope, team operations, and legacy RLS scoping. Scheduling accounts for assignment conflicts, travel buffers, skill coverage, time off, and qualification gates; writes carry idempotency keys and lifecycle audit trails.

## Engineering discipline

A single CI workflow (`.github/workflows/ci.yml`) gates every pull request and merge group, in order:

1. **Whitespace gate** — `git diff --check` over changed lines; trailing whitespace fails the build.
2. **Fresh-database migration proof** — `pnpm quality:verify-migrations` applies every migration to a fresh PostgreSQL 17 service container, then proves the restricted `lakeandpine_app` role holds exactly the table privileges it needs without owning tables or bypassing row-level security. The verifier refuses remote hosts and non-disposable database names, and never reads `DATABASE_URL` or `.env.local`.
3. **Tests** — `pnpm test` (Node's built-in test runner over `src/**/*.test.ts`).
4. **Lint, typecheck, build** — `pnpm lint`, `pnpm typecheck`, `pnpm build`.

Runtime posture matches the CI posture. `/api/health` fails closed unless the live connection reports the reviewed non-owner `DATABASE_RUNTIME_ROLE`. Public intake HMACs request fingerprints instead of storing raw IP addresses. `pnpm ops:smoke-runtime` performs a disposable end-to-end write proof: one synthetic request, idempotency/event/checklist/outbox persistence checks, suppressed email, and row removal in `finally`.

## Getting started

Requires Node 24, pnpm 10, and Docker.

```bash
docker run --rm -d --name lp-postgres \
  -e POSTGRES_USER=supabase_admin -e POSTGRES_PASSWORD=lakeandpine_dev \
  -e POSTGRES_DB=lakeandpine_proof \
  -p 5442:5432 postgres:17-alpine
export MIGRATION_DATABASE_URL=postgresql://supabase_admin:lakeandpine_dev@127.0.0.1:5442/lakeandpine_proof
pnpm install --frozen-lockfile
pnpm quality:verify-migrations
export DATABASE_URL="$MIGRATION_DATABASE_URL"   # same disposable local database
pnpm dev
```

The app serves on port 3010. Copy `.env.example` to `apps/web/.env.local` and point only at local, disposable databases; recreate the `--rm` container before rerunning the migration proof.

`DATABASE_RUNTIME_ROLE` is **not** the login role in `DATABASE_URL` — the connection logs in as the owner, then `db.ts` uses `DATABASE_RUNTIME_ROLE` as PostgreSQL's startup `role` so queries run as the restricted, RLS-bound `lakeandpine_app`. Leave it set to `lakeandpine_app`; pointing it at the login superuser would silently bypass row-level security and make local behavior stop reflecting production. Standard checks:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

### Environment

Variable names (never values) are documented in `.env.example`. The core groups:

- **Database**: `DATABASE_URL`, `DATABASE_RUNTIME_ROLE`
- **Supabase project keys**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **Auth (Clerk)**: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`
- **Payments (Stripe)**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_PLAN_WEEKLY`, `STRIPE_PRICE_PLAN_BIWEEKLY`, `STRIPE_PRICE_PLAN_MONTHLY`, `STRIPE_PRICE_ONE_TIME`
- **Email (Resend)**: `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_FROM_EMAIL`, `RESEND_REPLY_TO`, `SUPPORT_EMAIL`
- **Observability**: `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`, `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`
- **Maps**: `NEXT_PUBLIC_MAPBOX_TOKEN`
- **Operating gates (keep false until dependencies are verified)**: `REQUEST_INTAKE_ENABLED`, `CLEANER_APPLICATIONS_ENABLED`, `PAYMENTS_ENABLED`
- **Intake security**: `REQUEST_FINGERPRINT_SECRET`, `BOOKING_REFERENCE_SECRET`
- **Dev-only**: `DEV_PREVIEW_CUSTOMER_EMAIL`, `DEV_PREVIEW_OPERATOR_EMAIL`, `DEV_PREVIEW_CLEANER_EMAIL`, `RUNTIME_SMOKE_TOKEN`

Deeper reading: `docs/product/premium-market-operating-model.md`, `docs/product/national-team-operations.md`, `docs/ops/database-migration-verification.md`, and `AGENTS.md` (the venture operating contract).
