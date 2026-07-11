import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { getCustomerByEmail } from "@/lib/data";
import { sql } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { getStripe, stripeConfigured } from "@/lib/stripe";

// Signature-verified Stripe events -> billing_records. Payment state lives in
// Stripe; this table is the customer-facing billing history.
export async function POST(request: Request) {
  const webhookSecret = optionalEnv("STRIPE_WEBHOOK_SECRET");
  if (!stripeConfigured() || !webhookSecret) {
    return NextResponse.json({ error: "Stripe webhook not configured" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const payload = await request.text();
    event = getStripe().webhooks.constructEvent(payload, signature, webhookSecret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

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
      console.log(`[stripe] unhandled event: ${event.type}`);
  }

  return NextResponse.json({ received: true });
}
