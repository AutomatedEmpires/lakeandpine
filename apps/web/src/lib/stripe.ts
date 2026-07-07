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

export function planPriceId(planId: string): string {
  const envName = PLAN_PRICE_ENV[planId];
  if (!envName) throw new Error(`Unknown plan: ${planId}`);
  return requireEnv(envName);
}

export async function createPlanCheckout(input: {
  planId: string;
  customerEmail?: string;
}): Promise<{ url: string }> {
  const stripe = getStripe();
  const recurring = input.planId !== "onetime";
  const session = await stripe.checkout.sessions.create({
    mode: recurring ? "subscription" : "payment",
    line_items: [{ price: planPriceId(input.planId), quantity: 1 }],
    customer_email: input.customerEmail,
    success_url: `${APP_URL}/dashboard?checkout=success`,
    cancel_url: `${APP_URL}/pricing?checkout=canceled`,
    metadata: { planId: input.planId },
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { url: session.url };
}
