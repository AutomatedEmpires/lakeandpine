# Non-production database and booking proof

Verified on 2026-07-12 against a disposable PostgreSQL 17.10 container. No production
Supabase, Vercel, DNS, email, auth, or payment state was changed.

## Reproduce

Create a throwaway database and apply the two repository migrations with fail-fast SQL:

```bash
docker run -d --name lp-runtime-proof \
  -e POSTGRES_PASSWORD=lakeandpine_proof \
  -e POSTGRES_DB=lakeandpine_proof \
  -p 55442:5432 postgres:17-alpine

docker exec -i lp-runtime-proof psql -v ON_ERROR_STOP=1 \
  -U postgres -d lakeandpine_proof < supabase/migrations/0001_core.sql
docker exec -i lp-runtime-proof psql -v ON_ERROR_STOP=1 \
  -U postgres -d lakeandpine_proof < supabase/migrations/0002_content_seed.sql

export DATABASE_URL=postgresql://postgres:lakeandpine_proof@127.0.0.1:55442/lakeandpine_proof
pnpm ops:seed-content
pnpm ops:seed-dev
pnpm dev
```

In another shell with the same `DATABASE_URL`:

```bash
export RUNTIME_SMOKE_BASE_URL=http://127.0.0.1:3010
pnpm ops:smoke-runtime
```

The smoke uses a unique `example.invalid` identity and removes its quote, lead, booking,
and booking-event rows in a `finally` block. Stop and remove the disposable container when
finished.

## Captured evidence

- Both migrations completed with `ON_ERROR_STOP=1` on a fresh Postgres 17 database.
- Every one of the 14 public tables had RLS enabled.
- Catalog/content seed produced 6 services, 5 add-ons, 4 plans, 7 service areas, 6 FAQs,
  and 10 explicitly marked placeholder reviews.
- Dev seed produced one marked customer, one home, three bookings, two billing records,
  two support messages, and two booking events.
- Re-running both seed commands kept those counts unchanged; `ops:purge-dev-seed` then
  removed every marked row.
- The optimized Next.js build completed while connected to the disposable database.
- `/`, `/services`, `/pricing`, `/areas`, `/areas/coeur-dalene`, `/reviews`, `/book`, and
  the signed-out `/dashboard` all returned HTTP 200 from the production server.
- `POST /api/quote` persisted the canonical $377 deep-clean estimate.
- `POST /api/leads` persisted a lead with `new` status.
- `POST /api/bookings` persisted the canonical $427 estimate, `requested` status, linked
  quote, and `requested` booking event. Missing Resend configuration was a deliberate
  structured no-op and did not lose the booking.
- `POST /api/concierge` returned the canonical starting-anchor qualification.
- A development server with `DEV_PREVIEW_CUSTOMER_EMAIL` rendered the seeded customer's
  upcoming service, home notes, billing history, referral credit, and support thread.
- `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed.

## Readiness classification

| Surface | Classification | Evidence / remaining gate |
| --- | --- | --- |
| Marketing, services, pricing, areas, reviews | Non-production runtime proven | Reads real database content; needs a reachable migrated `DATABASE_URL` in each deployment. |
| Estimate, lead capture, rule-based concierge | Non-production runtime proven | Database writes and canonical price language verified. |
| Guest booking request | Non-production runtime proven | Quote + booking + event were all persisted; notifications safely no-op without Resend. |
| Customer dashboard preview | Development proof only | Reads bookings, notes, billing, credit, and support; production access still requires configured Clerk and webhook proof. |
| Scheduling | Request intake only | Dates/windows are rules-based, not backed by staff capacity or a calendar. A `requested` booking is not a confirmed appointment. |
| Email notifications | Not provider-proven here | Requires authenticated Resend configuration and inbox delivery proof. |
| Checkout and billing | Unsafe for money | No Stripe request was made. Test-mode product/price/webhook proof is required before any live-money activation. |
| Production rollout | Not authorized by this proof | Requires a reviewed Supabase migration/runtime pass, provider credentials, monitoring, and an explicit production promotion decision. |

This closes the local database/runtime uncertainty. It does not convert provider-gated or
money-moving surfaces into production-ready functionality.
