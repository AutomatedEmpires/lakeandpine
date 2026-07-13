# Service planning foundation

Lake & Pine Phase 1 treats a booking as a service request until a human operator has reviewed
scope and capacity. The product never turns a preferred date into a confirmed appointment by
itself, and it does not collect payment.

## Customer workflow

`/book` captures a structured request across eight steps:

1. service and cadence;
2. property profile;
3. selected rooms and room notes;
4. cleaning preferences and special instructions;
5. pets and access planning;
6. add-ons;
7. preferred date and arrival window;
8. contact and review.

The pure planning module produces an effort direction, score, summary, and draft checklist.
When `REQUEST_INTAKE_ENABLED` is false, the flow uses demo contact values and produces a
browser-local preview without sending or storing the request.

## Operator workflow

`/operator` is staff-only when Clerk is configured. Outside production, it may be previewed
with a seeded staff customer from `DEV_PREVIEW_OPERATOR_EMAIL`; that preview query is hard-
restricted to rows marked `is_dev_seed`.

The workspace includes:

- requested → reviewing → ready → confirmed → scheduled → in progress → completed → follow-up;
- property, room, preference, pet, access, and special-instruction context;
- generated service checklist controls;
- private internal notes;
- an explicit customer communication plan;
- service check-in and review-request follow-up tasks.

No message is sent from the operator workspace automatically. Follow-up tasks are planning
records until an operator completes them through an approved communication channel.

## Data model

The existing `bookings` table remains the service-request/job spine. The Phase 1 migration adds
planning snapshots, planning score/direction, expanded job states, and contact status. New
private tables model durable home rooms, checklist items, internal notes, and follow-ups.

The premium operations extension adds qualification, territory, duration, crew capacity,
scheduling, assignments, service cases, recovery/refund records, an outbox, idempotency receipts,
and rate-limit counters. See `premium-operations-domain.md` for the full workflow and rollback
contract.

RLS is enabled on every new table. No `anon` or `authenticated` Data API policies or grants are
created. The explicit non-owner `lakeandpine_app` server role receives the grants and role-targeted
policies needed by the application; it remains non-superuser and cannot bypass RLS.
