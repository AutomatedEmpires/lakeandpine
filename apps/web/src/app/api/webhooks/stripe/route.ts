import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import type Stripe from "stripe";

import { getCustomerByEmail } from "@/lib/data";
import { sql } from "@/lib/db";
import { optionalEnv, paymentsEnabled } from "@/lib/env";
import { getStripe, stripeConfigured } from "@/lib/stripe";

// Signature-verified Stripe events -> billing_records. Payment state lives in
// Stripe; this table is the customer-facing billing history.
export async function POST(request: Request) {
  const webhookSecret = optionalEnv("STRIPE_WEBHOOK_SECRET");
  if (!paymentsEnabled || !stripeConfigured() || !webhookSecret) {
    return NextResponse.json({ error: "Stripe webhook not configured" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  let payload: string;
  try {
    payload = await request.text();
    event = getStripe().webhooks.constructEvent(payload, signature, webhookSecret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const payloadSha256 = createHash("sha256").update(payload).digest("hex");
  const receipts = await sql<{ event_id: string }[]>`
    insert into stripe_event_receipts
      (event_id, event_type, livemode, payload_sha256, status, attempt_count, last_attempt_at)
    values
      (${event.id}, ${event.type}, ${event.livemode}, ${payloadSha256}, 'processing', 1, now())
    on conflict (event_id) do update set
      status = 'processing',
      attempt_count = stripe_event_receipts.attempt_count + 1,
      last_attempt_at = now(),
      last_error_code = null
    where stripe_event_receipts.status = 'failed'
      and stripe_event_receipts.payload_sha256 = excluded.payload_sha256
    returning event_id`;
  if (!receipts[0]) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  let receiptStatus: "processed" | "ignored" = "processed";
  try {
    switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const email = session.customer_details?.email ?? session.customer_email;
      const customer = email ? await getCustomerByEmail(email) : null;
      if (customer && session.customer && typeof session.customer === "string") {
        await sql`
          update customers set stripe_customer_id = ${session.customer}
          where id = ${customer.id} and stripe_customer_id is null`;
      }
      await sql`
        insert into billing_records (customer_id, description, amount_cents, status, stripe_payment_intent_id)
        values (${customer?.id ?? null},
                ${`Checkout — ${session.metadata?.planId ?? "plan"}`},
                ${session.amount_total ?? 0}, 'paid',
                ${typeof session.payment_intent === "string" ? session.payment_intent : null})`;
        break;
    }
    case "invoice.paid": {
      const invoice = event.data.object;
      const email = invoice.customer_email;
      const customer = email ? await getCustomerByEmail(email) : null;
      await sql`
        insert into billing_records (customer_id, description, amount_cents, status, stripe_invoice_id)
        values (${customer?.id ?? null},
                ${invoice.lines?.data?.[0]?.description ?? "Recurring cleaning invoice"},
                ${invoice.amount_paid ?? 0}, 'paid', ${invoice.id ?? null})
        on conflict do nothing`;
        break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const email = invoice.customer_email;
      const customer = email ? await getCustomerByEmail(email) : null;
      if (customer) {
        await sql`
          insert into support_messages (customer_id, sender, body)
          values (${customer.id}, 'concierge',
                  'A recent payment did not go through. Please update your payment method — your service is unaffected for now.')`;
      }
        break;
    }
    default:
      // Log unhandled types for observability without failing the webhook.
        receiptStatus = "ignored";
    }
    await sql`
      update stripe_event_receipts
      set status = ${receiptStatus}, processed_at = now(), last_error_code = null
      where event_id = ${event.id}`;
  } catch (error) {
    const errorCode = error instanceof Error ? error.name.slice(0, 120) : "WebhookProcessingError";
    await sql`
      update stripe_event_receipts
      set status = 'failed', last_error_code = ${errorCode}
      where event_id = ${event.id}`;
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
