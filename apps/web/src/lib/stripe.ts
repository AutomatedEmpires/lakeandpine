import "server-only";

import Stripe from "stripe";

import { APP_URL, optionalEnv, requireEnv } from "./env";

// Stripe is the cross-portfolio payments standard. The requireEnv-per-price-id
// pattern (mirrors explore-and-earn/services/stripe) means a missing price id
// throws AT CHECKOUT TIME — the app never silently sells the wrong price.
//
// TODO(jackson): create the products/prices in the Stripe dashboard and set
// STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
// STRIPE_PRICE_PLAN_WEEKLY / _BIWEEKLY / _MONTHLY, STRIPE_PRICE_ONE_TIME.

export function stripeConfigured(): boolean {
  return Boolean(optionalEnv("STRIPE_SECRET_KEY"));
}

export function getStripe(): Stripe {
  return new Stripe(requireEnv("STRIPE_SECRET_KEY"));
}

const PLAN_PRICE_ENV: Record<string, string> = {
  weekly: "STRIPE_PRICE_PLAN_WEEKLY",
  biweekly: "STRIPE_PRICE_PLAN_BIWEEKLY",
  monthly: "STRIPE_PRICE_PLAN_MONTHLY",
  onetime: "STRIPE_PRICE_ONE_TIME",
};

export class ActiveStripeSubscriptionError extends Error {}

export function planPriceId(planId: string): string {
  const envName = PLAN_PRICE_ENV[planId];
  if (!envName) throw new Error(`Unknown plan: ${planId}`);
  return requireEnv(envName);
}

export async function getOrCreateStripeCustomer(input: {
  customerId: string;
  customerEmail: string;
  existingStripeCustomerId: string | null;
}) {
  if (input.existingStripeCustomerId) return input.existingStripeCustomerId;
  const customer = await getStripe().customers.create(
    {
      email: input.customerEmail,
      metadata: { lakeandpine: "v1", customerId: input.customerId },
    },
    { idempotencyKey: `lakeandpine:customer:${input.customerId}` },
  );
  return customer.id;
}

export async function createPlanCheckout(input: {
  planId: string;
  customerId: string;
  stripeCustomerId: string;
  checkoutIdempotencyKey: string;
}): Promise<{ url: string }> {
  const stripe = getStripe();
  const recurring = input.planId !== "onetime";
  const metadata = {
    lakeandpine: "v1",
    planId: input.planId,
    customerId: input.customerId,
  };
  if (recurring) {
    const subscriptions = await stripe.subscriptions.list({
      customer: input.stripeCustomerId,
      status: "all",
      limit: 100,
    });
    if (
      subscriptions.data.some(
        (subscription) =>
          subscription.status !== "canceled" &&
          subscription.status !== "incomplete_expired",
      )
    ) {
      throw new ActiveStripeSubscriptionError(
        "An active subscription already exists for this customer",
      );
    }
  }
  const openSessions = await stripe.checkout.sessions.list({
    customer: input.stripeCustomerId,
    status: "open",
    limit: 100,
  });
  const existingSession = openSessions.data.find(
    (session) =>
      session.metadata?.lakeandpine === "v1" &&
      session.metadata.customerId === input.customerId &&
      session.metadata.planId === input.planId &&
      session.url,
  );
  if (existingSession?.url) return { url: existingSession.url };
  const session = await stripe.checkout.sessions.create(
    {
      mode: recurring ? "subscription" : "payment",
      payment_method_types: ["card"],
      line_items: [{ price: planPriceId(input.planId), quantity: 1 }],
      customer: input.stripeCustomerId,
      client_reference_id: input.customerId,
      success_url: `${APP_URL}/dashboard?checkout=success`,
      cancel_url: `${APP_URL}/pricing?checkout=canceled`,
      metadata,
      ...(recurring
        ? {
            subscription_data: {
              metadata,
            },
          }
        : {}),
    },
    {
      idempotencyKey: `lakeandpine:checkout:${input.checkoutIdempotencyKey}`,
    },
  );
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { url: session.url };
}
