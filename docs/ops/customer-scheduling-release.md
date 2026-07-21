# Customer scheduling release

## Release contents

Migration `20260719203303_customer_scheduling_authority.sql` defines the territory,
service-policy, recurring-availability, capacity-hold, and reservation constraints.
Migration `20260721180338_guest_booking_management_grants.sql` adds revocable,
digest-only guest access to a booking calendar. Migration
`20260721183422_fix_customer_hold_timezone_capacity.sql` is a forward fix that keeps
territory-day capacity checks independent of the database session timezone.

The application release adds a capacity-backed public availability API, transactional
reservation API, gated four-step booking journey, and private guest calendar. It queues
customer and operations messages in the existing outbox; it does not send email inline,
collect payment, or create a customer account.

## Activation gates

Keep `CUSTOMER_SCHEDULING_ENABLED=false` until all of these are complete:

1. The stacked scheduling pull requests have independent review and all hosted checks
   are green.
2. The three scheduling migrations are reviewed and applied in order through the
   authenticated Supabase migration path during a separately approved change window.
3. The runtime role remains `lakeandpine_app`, non-superuser, non-BYPASSRLS, and owns
   no operational table.
4. At least one active service territory, service policy, qualified cleaner, and reviewed
   recurring availability record exist. Synthetic preview ZIP `99997` must never be
   present in production.
5. `CUSTOMER_SCHEDULING_SECRET`, `REQUEST_FINGERPRINT_SECRET`, and preferably an
   independent `BOOKING_REFERENCE_SECRET` are random values of at least 32 characters.
6. A monitored operations owner and the separate outbox-delivery release are ready.
   Enabling scheduling does not itself authorize sending queued email.
7. Production browser proof covers a supported direct path, consultation fallback,
   stale-slot recovery, private guest link, mobile layout, and keyboard navigation.

If the gate is true but database or protection configuration is missing, the public page
falls back to the consultation experience and the APIs fail closed.

## Required validation

Before activation, run against a fresh disposable PostgreSQL 17 database:

```text
pnpm quality:verify-migrations
pnpm quality:verify-scheduling
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Use `pnpm --dir apps/web ops:seed-scheduling-preview` only with a local or test database.
The seed script refuses provider-looking or non-local database targets. API and browser
proof must use synthetic contact data and must confirm that no worker identity, score,
skill, or crew identifier appears in a public response.

## Reservation semantics

- `available_to_hold` means the slot was backed by current, eligible crew capacity when
  availability was calculated; it is not a reservation.
- `held` means the reservation transaction inserted the booking, schedule, capacity hold,
  reserved assignments, audit events, guest grant, and two pending outbox messages.
- `pending_scope` is a conditional hold whose displayed condition still requires review.
- `expired` means the hold no longer reserves capacity.
- `confirmed` is the only confirmed appointment state.
- Consultation fallback is not a hold and preserves the customer's scope answers.

Idempotency replays return the original booking only when the request digest matches.
The database exclusion and capacity constraints remain authoritative under concurrency;
a stale public slot returns a conflict and the customer must refresh availability.

## Live-action boundaries

This release does not apply production migrations, enable public scheduling, activate
outbox delivery, send email, create provider identities, charge a payment method, or move
money. Merging `main` deploys production, so merge and activation remain separate,
explicitly approved actions.
