import { NextResponse } from "next/server";
import { z } from "zod";

import { paymentsEnabled } from "@/lib/env";
import {
  ActiveStripeSubscriptionError,
  createPlanCheckout,
  getOrCreateStripeCustomer,
  stripeConfigured,
} from "@/lib/stripe";

const schema = z.object({
  idempotencyKey: z.string().uuid(),
  planId: z.enum(["weekly", "biweekly", "monthly", "onetime"]),
});

export async function POST(request: Request) {
  if (!paymentsEnabled || !stripeConfigured()) {
    return NextResponse.json(
      { error: "Online payment isn't live yet — your visit is invoiced after service." },
      { status: 503 },
    );
  }
  const [{ resolveDashboardIdentity }, paymentData] = await Promise.all([
    import("@/lib/auth"),
    import("@/lib/payment-data"),
  ]);
  const identity = await resolveDashboardIdentity();
  if (identity.state !== "authed") {
    return NextResponse.json(
      { error: "Sign in to start a secure checkout." },
      { status: identity.state === "signed_out" ? 401 : 403 },
    );
  }
  const paymentIdentity = await paymentData.getCustomerPaymentIdentity(
    identity.customer.id,
  );
  if (!paymentIdentity.email) {
    return NextResponse.json(
      { error: "A verified account email is required for checkout." },
      { status: 409 },
    );
  }
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid checkout request" }, { status: 400 });
  }
  const stripeCustomerId = await getOrCreateStripeCustomer({
    customerId: paymentIdentity.customer_id,
    customerEmail: paymentIdentity.email,
    existingStripeCustomerId: paymentIdentity.stripe_customer_id,
  });
  await paymentData.bindCustomerStripeCustomerId(
    paymentIdentity.customer_id,
    stripeCustomerId,
  );
  try {
    const { url } = await createPlanCheckout({
      planId: parsed.data.planId,
      customerId: paymentIdentity.customer_id,
      stripeCustomerId,
      checkoutIdempotencyKey: parsed.data.idempotencyKey,
    });
    return NextResponse.json({ url });
  } catch (error) {
    if (error instanceof ActiveStripeSubscriptionError) {
      return NextResponse.json(
        { error: "This account already has an active recurring plan." },
        { status: 409 },
      );
    }
    throw error;
  }
}
