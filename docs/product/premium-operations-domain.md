# Premium operations domain

Lake & Pine's operating model is qualification-led premium service, not instant
marketplace dispatch. The four supported planning programs are estate care,
construction final clean, marine interior care, and select commercial care.
Every request remains unconfirmed until an operator has qualified scope,
territory, access, timing, crew capacity, and a custom proposal.

## Operating lifecycle

Qualification is separate from the field schedule:

```text
requested
  -> needs information / walkthrough needed
  -> proposal sent
  -> approved
  -> tentative / held / confirmed schedule
  -> en route -> in progress -> quality review -> completed
```

This separation prevents a preferred date from becoming a capacity promise.
Construction work must record site readiness. Marine work must record dock or
vessel access. All programs must confirm safe access, required utilities, and
finish/product restrictions before assignment.

## Territory, people, and capacity

- `service_territories` and `territory_postal_codes` start in draft/review;
  rows are operating evidence, not public coverage claims.
- `cleaners` tracks skills, vertical experience, status, bounded daily/weekly
  capacity, and screening evidence status. A `verified` screening state requires
  a verification timestamp; no screening documents belong in this database.
- `cleaner_applications` is a minimal private talent-intake record. It accepts
  contact, home base, program/territory interests, transportation confirmation,
  availability, and experience summaries. It must not collect identity images,
  background reports, bank details, or tax documents.
- `cleaning_teams` and effective-dated membership preserve crew continuity while
  allowing reassignment.
- recurring availability and approved time off are recorded separately.
- `job_schedules` holds the actual dated work block; `job_assignments` holds one
  cleaner per assignment row with optional team provenance.

The database rejects accepted/confirmed assignments for inactive cleaners,
approved time off, or another accepted/confirmed assignment inside the travel
buffer. It serializes the check per cleaner with a transaction-scoped advisory
lock. The application still evaluates shift availability, skills, territory,
daily/weekly limits, and vertical-specific readiness before proposing work.

## Intelligent assignment

`operations-scheduling.ts` is deterministic and explainable. Hard blockers are:

- service qualification, territory, safe access, utilities, and finish rules;
- construction readiness or marine dock/vessel access when applicable;
- crew size and required skill coverage;
- shift containment, approved time off, job/travel overlap;
- cleaner daily and weekly minute limits.

Only feasible candidates receive a score. Scoring rewards recurring-crew
continuity, a recorded customer preference, relevant vertical experience, lower
travel, workload balance, and documented deadline fit. Scores are suggestions;
an operator remains responsible for confirmation.

Job duration is stored as crew labor minutes and elapsed schedule minutes. The
rule-based estimate uses vertical, size, units, complexity, and crew size, rounds
to 30-minute blocks, and routes construction, restoration-scale, or very large
work to a walkthrough.

## Rescheduling, complaints, recovery, and refunds

`service_cases` is the common private intake for reschedules, cancellations,
complaints, recleans, damage reports, refund review, and other service issues.
It supports a public non-secret reference, hashed idempotency key, optional
booking/customer association, minimal contact, date alternatives, priority,
ownership, consent evidence, and resolution. `service_case_events` automatically
captures creation and every status transition and is append-only.

Recovery work is explicit in `service_recovery_actions`. Refund decisions are
records in `refund_records`; they do not call Stripe or move money. The workflow
must reach `ready_for_manual_processing` before an operator or a separately
approved payment worker processes anything. Live payment/refund activation is a
founder hard stop.

## Delivery, idempotency, and abuse resistance

- Booking creation wraps the booking, request event, checklist, and both customer
  and operator notification-outbox records in one Postgres transaction.
- `notification_outbox` makes provider delivery retryable without erasing or
  orphaning a request. It records attempts and error codes, never provider
  secrets.
- Booking, service-case, and talent-intake idempotency columns store SHA-256 hex
  digests only. Guest self-service stores only a public-token digest.
- `request_rate_limits` stores fixed-window counters against SHA-256 server-side
  key digests. Raw IP addresses and raw device identifiers are forbidden. An
  operations job can safely delete rows through the indexed `expires_at` TTL.
- `stripe_event_receipts` records event IDs and payload hashes for webhook
  idempotency without persisting raw payloads. Partial unique indexes also stop
  duplicate payment-intent and invoice IDs in `billing_records`.

## Access model

Every non-content table has RLS enabled. `lakeandpine_app` is explicitly
non-superuser, non-owner, and `NOBYPASSRLS`; it receives role-targeted CRUD
grants and policies because it is the trusted server-side application role.
`anon` and `authenticated` receive no access to private operations tables.
Identity sequences have explicit app-role usage. New tables default to no
`PUBLIC` privileges.

Lifecycle trigger functions are `SECURITY INVOKER`; there are no
`SECURITY DEFINER` functions. Immutable event tables reject update/delete even
though the shared schema contract grants CRUD to the direct app role.

## Migration and rollback

The migration is additive except that legacy prototype service rows are marked
inactive/non-bookable and placeholder reviews are unpublished. It does not
delete customer data and does not activate providers.

Before production application, take a database backup and run the fresh-schema,
app-role RLS, and atomic-booking proofs. The safe rollback is a forward fix:
disable request intake, mark new service rows non-bookable, and correct code or
policies without dropping operational records. Dropping tables or columns after
real intake would be destructive and requires founder approval.
