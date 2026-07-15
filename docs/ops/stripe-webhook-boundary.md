# Stripe webhook database boundary

`PAYMENTS_ENABLED` must remain `false` until every item in this runbook passes.
The application verifies Stripe's signature with the Stripe SDK, and the database
independently verifies the exact raw payload with its own admin-configured copy of
the endpoint signing secret. These are two separate gates. Configuring only the
application environment is intentionally insufficient.

The database derives the event ID, event type, `livemode`, payload SHA-256, customer
identity, provider object IDs, and amounts from the authenticated payload. It then
issues an expiring, single-use processing capability. The application role can use
that capability to complete, ignore, or fail the event, but it cannot insert provider
receipts directly and cannot pass caller-asserted billing facts to a completion API.

## Owner/admin-only configuration

Configure `private.stripe_webhook_config` only through an authenticated database-admin
connection. Do not run this as `lakeandpine_app`. Do not paste the signing secret into
a repository file, migration, shell command, ticket, chat, CI log, or readiness output.
Use an interactive `psql` session so the secret is neither echoed nor placed in shell
history:

```text
psql "<authenticated-admin-database-url>"
\set ON_ERROR_STOP on
\prompt -s 'Stripe endpoint signing secret: ' stripe_webhook_secret
begin;
insert into private.stripe_webhook_config
  (singleton, webhook_secret, expected_livemode,
   signature_tolerance_seconds, capability_ttl_seconds,
   configured_by, configured_at)
values
  (true, :'stripe_webhook_secret', false, 300, 300,
   current_user, clock_timestamp())
on conflict (singleton) do update
set webhook_secret = excluded.webhook_secret,
    expected_livemode = excluded.expected_livemode,
    signature_tolerance_seconds = excluded.signature_tolerance_seconds,
    capability_ttl_seconds = excluded.capability_ttl_seconds,
    configured_by = current_user,
    configured_at = clock_timestamp();
commit;
\unset stripe_webhook_secret
```

The example deliberately configures Stripe **test mode** (`expected_livemode=false`).
Set it to `true` only when the deployed endpoint uses Stripe live-mode credentials and
the owner is deliberately authorizing live provider events. The secret must be the
signing secret for this exact webhook endpoint, and the server-only
`STRIPE_WEBHOOK_SECRET` must contain the same value. Rotation is an atomic cutover:
keep payments disabled, update both secret stores, run the readiness check, deliver a
controlled signed test event, and only then restore the payment gate.

The private table has RLS enabled and grants no access to the runtime role. No public
or runtime function can read or change the configuration. A database owner/admin is
therefore required for initial setup, rotation, expected-mode changes, and inspection.

## Readiness gate

Run this with the same authenticated admin database connection. The command does not
read the secret into JavaScript or print it; validity is reduced to a boolean inside
Postgres. Choose the expected mode explicitly:

```text
LAKEANDPINE_STRIPE_READINESS_CHECK=1 \
LAKEANDPINE_EXPECTED_STRIPE_LIVEMODE=false \
DATABASE_URL=<authenticated-admin-database-url> \
pnpm quality:verify-stripe-webhook
```

For the live endpoint, use
`LAKEANDPINE_EXPECTED_STRIPE_LIVEMODE=true`. The gate fails when configuration is
missing, the expected mode differs, the caller is not a table owner/admin, either
private table lacks RLS, the runtime role has table access, a retired caller-asserted
function is executable, or a verified wrapper is unavailable.

Before enabling payments, also prove all of the following against the selected Stripe
endpoint while `PAYMENTS_ENABLED=false`:

1. A current correctly signed event in the configured mode is claimed once.
2. Reusing its processing capability is rejected.
3. Replaying a processed or ignored event is acknowledged as a duplicate and creates
   no second billing/support record.
4. A missing configuration, invalid signature, stale timestamp, oversized
   payload/header, malformed JSON event, or test/live mismatch creates no receipt and
   returns a non-success response.
5. The same raw event passes Stripe SDK verification and database verification; any
   derived ID, type, mode, or SHA mismatch is rejected by the route.
6. Supported owned checkout/invoice events derive their customer, amount, invoice,
   and payment-intent facts from the authenticated payload. Unsupported or non-owned
   events can only be ignored.
7. `lakeandpine_app` cannot execute the retired
   `claim_stripe_event_receipt`, `complete_stripe_*`, or
   `finish_stripe_event_receipt` functions and cannot read either private table.

Keep `PAYMENTS_ENABLED=false` after these database proofs until the owner separately
authorizes actual charges, refunds, tips, and related customer communication.
