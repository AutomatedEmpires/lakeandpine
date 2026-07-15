# Intelligent field operations release

## Release contents

Migrations `20260714173819_intelligent_field_operations.sql` and
`20260714223000_exact_field_actor_evidence.sql` are additive to the national
team-operations release. They add branch radius and operating-hour controls, location
assessments, customer schedule proposals, cleaner preferences, audited job messages,
mileage, issue escalation, duty coverage, tip intent, allocation-scoped checklist
execution, database-derived field actors, and narrow evidence-column grants. The
application adds customer Service control, cleaner Field execution, and operator Field
control surfaces.

This release must be deployed after the four `20260714045750`–`20260714045753` national
operations migrations. It is not compatible with the pre-national application schema.

## Preconditions

1. The national team-operations pull request is merged and its production sequence is
   complete, or both releases are deployed together in the documented migration order.
2. The protected private owner login email is known and has a production staff customer
   identity. Do not use `support@lakeandpinecleaning.com` as the owner's identity.
3. The production runtime remains the non-owner, non-superuser, non-BYPASSRLS
   `lakeandpine_app` role.
4. `REQUEST_INTAKE_ENABLED`, `CLEANER_APPLICATIONS_ENABLED`, and `PAYMENTS_ENABLED`
   remain false during database and application cutover.
5. `support@lakeandpinecleaning.com` and the business phone remain hidden from public
   surfaces until ownership, delivery/answering, and monitoring are proven.
6. Decide the location path:
   - manual review: leave `MAPBOX_PERMANENT_GEOCODING_ENABLED=false`; or
   - automatic exact-radius assessment: provide a server-only Mapbox token, confirm the
     account's permanent-geocoding entitlement, and set the flag true.
7. Record a production backup and verify the complete migration history and checksums.
8. Keep intake disabled until support routing, error monitoring, and the first branch's
   real capacity are verified.
9. Keep payments disabled until the owner/admin completes
   `docs/ops/stripe-webhook-boundary.md`, configures the private database verification
   secret and expected mode, and the Stripe readiness command passes. Application-only
   `STRIPE_WEBHOOK_SECRET` configuration is not sufficient.

Stop on a migration-history mismatch, changed checksum, unexpected conflicting object,
loss of runtime-role restrictions, or a failed post-apply isolation probe.

The migration intentionally backfills every pre-existing active allocation with a
`manual_review` location assessment. It does not invent customer consent. Future
legacy-confirmed work must be route-reviewed and sent back to the linked customer for
window reconfirmation. Work already physically under way receives only a narrow,
immutable migration continuity record; it still requires manager route review and may
only move forward through execution. Keep field traffic restricted until the readiness
command below passes.

## Verified evidence required from the release commit

- `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` pass.
- A fresh PostgreSQL 17 database applies all ten migrations from zero.
- The verifier reports RLS on every private table, no duplicate permissive policies,
  no unindexed foreign keys, and no application-owned public object.
- Customer approval is required before confirmation; an operator cannot manufacture an
  approved customer response.
- Out-of-radius work requires a documented route exception but intake itself is not
  rejected.
- Cleaner communication, mileage, and issues require a current assigned cleaner and
  same-team membership.
- A cleaner cannot approve mileage or forge a collected tip.
- A Team B manager reads zero Team A location, proposal, message, mileage, issue, and
  duty rows.
- Customer cleaner preference, completed-work review, and tip intent are allocation-
  scoped.
- `LAKEANDPINE_ALLOW_DEV_SEED=1 LAKEANDPINE_DEV_SEED_DATABASE=<exact-local-disposable-name> pnpm ops:seed-dev` is idempotent and
  the same gates on `pnpm ops:purge-dev-seed` remove every synthetic
  field-operation dependency in foreign-key-safe order.
- Desktop and mobile checks cover `/dashboard`, `/crew`, and `/operator/field` with
  realistic synthetic records.

## Production sequence

1. Drain application traffic if the national migration cutover is still pending.
2. Apply any unapplied national versions through `20260714045753` in documented order.
3. Apply `20260714173819_intelligent_field_operations.sql`, then
   `20260714223000_exact_field_actor_evidence.sql`, through the authenticated Supabase
   migration path.
4. Confirm the provider recorded versions `20260714173819` and `20260714223000`
   exactly once and in that order.
5. Run the post-apply role, grant, ownership, RLS, policy, index, and team-isolation
   checks before deploying application traffic.
6. With payments still disabled, configure and verify the owner-only Stripe database
   boundary using `docs/ops/stripe-webhook-boundary.md`. Stop if the database and
   application do not independently accept the same controlled signed event.
7. Deploy the reviewed application commit with public intake, recruiting, payment, and
   crew field traffic still restricted.
8. Verify `/api/health`, the public consultation page, `/dashboard`, `/crew`,
   `/operator/network`, `/operator/schedule`, and `/operator/field` using real protected
   identities; preview identities must be disabled in production.
9. Bootstrap the private owner identity if national ownership has not yet been
   established.
10. In Field control, resolve every migration-created manual route review. For each
   future legacy-confirmed job, send the displayed window back to the linked customer
   and obtain their real approval. Do not create retroactive customer evidence for work
   that already started.
11. Run the mandatory, read-only rollout gate using an authenticated migration/admin
   connection. It prints the database, server, and role before evaluating active work:
   `LAKEANDPINE_FIELD_ROLLOUT_CHECK=1 pnpm quality:verify-field-rollout`.
   Do not enable crew traffic while this command reports `BLOCKED`.
12. In Field control, configure the first team as:
   - origin: Downtown Coeur d'Alene, Idaho (`47.677700`, `-116.780500`);
   - standard radius: 30 miles;
   - timezone: `America/Los_Angeles`;
   - operating start: 8:00 AM;
   - latest arrival: 4:00 PM;
   - hard finish: 7:00 PM; and
   - branch support alias: `support@lakeandpinecleaning.com` after mailbox verification.
13. Assign the owner as the initial manager on duty until a manager is delegated.
14. Submit one controlled internal request, verify the location assessment, send an
    arrival proposal, approve it through the linked customer, confirm the schedule, and
    exercise cleaner messaging/mileage/checklist/issue reporting without external
    delivery.
15. Enable intake and crew traffic only after that proof, support monitoring, capacity, notification
    delivery, and the founder-owned launch checklist are complete.

## Forward-fix and live-action boundaries

Do not delete or down-migrate operating history. If the database succeeds and the
application fails, keep traffic/intake disabled and ship a forward application repair.
If team scope or actor attribution fails, stop all field writes until a reviewed forward
database repair is applied.

No step in this release authorizes a real email/SMS send, charge, tip payout, refund,
payroll transmission, product order, hiring/firing action, or automated strike. Those
remain separate provider and human-authority gates.
