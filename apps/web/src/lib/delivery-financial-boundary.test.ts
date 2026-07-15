import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

test("notification delivery state is mutated only through bounded private functions", () => {
  const retrySource = source("./notification-outbox.ts");
  const serviceCaseSource = source("./service-cases.ts");

  assert.match(retrySource, /private\.claim_notification_outbox_delivery/);
  assert.match(retrySource, /private\.finish_notification_outbox_delivery/);
  assert.match(retrySource, /idempotencyKey: item\.delivery_idempotency_key/);
  assert.doesNotMatch(retrySource, /update\s+(?:public\.)?notification_outbox\b/i);

  assert.match(
    serviceCaseSource,
    /private\.finish_initial_service_case_notification_delivery/,
  );
  assert.match(serviceCaseSource, /private\.enqueue_service_case_ops_notification/);
  assert.doesNotMatch(
    serviceCaseSource,
    /(insert\s+into|update|delete\s+from)\s+(?:public\.)?notification_outbox\b/i,
  );
});

test("Stripe webhook uses a database-verified one-use capability", () => {
  const webhookSource = source("../app/api/webhooks/stripe/route.ts");
  const protectedTables =
    /(insert\s+into|update|delete\s+from)\s+(?:public\.)?(stripe_event_receipts|billing_records|customers|support_messages)\b/i;

  assert.doesNotMatch(webhookSource, protectedTables);
  assert.doesNotMatch(webhookSource, /from\s+["']@\/lib\/data["']/);
  assert.match(webhookSource, /webhooks\.constructEvent\(payload, signature, webhookSecret\)/);
  assert.match(webhookSource, /MAX_STRIPE_PAYLOAD_BYTES = 1024 \* 1024/);
  assert.match(webhookSource, /request\.body\.getReader\(\)/);
  assert.match(webhookSource, /private\.verify_and_claim_stripe_event/);
  assert.match(webhookSource, /\$\{payload\}, \$\{signature\}/);
  for (const functionName of [
    "complete_verified_stripe_event",
    "ignore_verified_stripe_event",
    "fail_verified_stripe_event",
  ]) {
    assert.match(webhookSource, new RegExp(`private\\.${functionName}`));
  }
  for (const retiredFunctionName of [
    "claim_stripe_event_receipt",
    "complete_stripe_checkout_session",
    "complete_stripe_invoice_paid",
    "complete_stripe_payment_failed",
    "finish_stripe_event_receipt",
  ]) {
    assert.doesNotMatch(
      webhookSource,
      new RegExp(`private\\.${retiredFunctionName}`),
    );
  }
  assert.doesNotMatch(
    webhookSource,
    /complete_verified_stripe_event\([\s\S]{0,300}(event\.id|customerId|amount_paid|amount_total|payment_intent)/,
  );
});

test("Stripe database boundary authenticates raw payloads and retires asserted receipts", () => {
  const migrationSource = source(
    "../../../../supabase/migrations/20260714173819_intelligent_field_operations.sql",
  );

  assert.match(migrationSource, /create table private\.stripe_webhook_config/);
  assert.match(
    migrationSource,
    /create table private\.stripe_event_processing_capabilities/,
  );
  assert.match(migrationSource, /extensions\.hmac\(/);
  assert.match(migrationSource, /requested_raw_payload::jsonb/);
  assert.match(migrationSource, /derived_livemode <> webhook_config\.expected_livemode/);
  assert.match(migrationSource, /capability_ttl_seconds between 30 and 600/);
  assert.match(
    migrationSource,
    /create function private\.consume_verified_stripe_capability/,
  );
  for (const retiredFunctionSignature of [
    "private.claim_stripe_event_receipt",
    "private.complete_stripe_checkout_session",
    "private.complete_stripe_invoice_paid",
    "private.complete_stripe_payment_failed",
    "private.finish_stripe_event_receipt",
  ]) {
    assert.match(
      migrationSource,
      new RegExp(
        `revoke all on function ${retiredFunctionSignature.replace(".", "\\.")}\\(`,
      ),
    );
  }
});

test("checkout binds Stripe metadata to the authenticated customer", () => {
  const routeSource = source("../app/api/checkout/route.ts");
  const paymentDataSource = source("./payment-data.ts");
  const stripeSource = source("./stripe.ts");

  assert.match(routeSource, /resolveDashboardIdentity/);
  assert.match(routeSource, /identity\.state !== "authed"/);
  assert.match(routeSource, /idempotencyKey: z\.string\(\)\.uuid\(\)/);
  assert.match(routeSource, /getCustomerPaymentIdentity/);
  assert.match(routeSource, /bindCustomerStripeCustomerId/);
  assert.match(paymentDataSource, /private\.current_customer_payment_identity/);
  assert.match(
    paymentDataSource,
    /private\.bind_current_customer_stripe_customer_id/,
  );
  assert.doesNotMatch(paymentDataSource, /update\s+(?:public\.)?customers\b/i);
  assert.match(stripeSource, /client_reference_id: input\.customerId/);
  assert.match(stripeSource, /customerId: input\.customerId/);
  assert.match(stripeSource, /customer: input\.stripeCustomerId/);
  assert.doesNotMatch(stripeSource, /customer_email:/);
  assert.match(stripeSource, /lakeandpine: "v1"/);
  assert.match(stripeSource, /lakeandpine:checkout:/);
  assert.match(stripeSource, /payment_method_types: \["card"\]/);
  assert.match(stripeSource, /stripe\.subscriptions\.list/);
  assert.match(stripeSource, /stripe\.checkout\.sessions\.list/);
});
