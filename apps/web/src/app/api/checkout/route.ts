import { NextResponse } from "next/server";
import { z } from "zod";

import { paymentsEnabled } from "@/lib/env";
import { createPlanCheckout, stripeConfigured } from "@/lib/stripe";

const schema = z.object({
  planId: z.enum(["weekly", "biweekly", "monthly", "onetime"]),
  email: z.string().email().optional(),
});

export async function POST(request: Request) {
  if (!paymentsEnabled || !stripeConfigured()) {
    return NextResponse.json(
      { error: "Online payment isn't live yet — your visit is invoiced after service." },
      { status: 503 },
    );
  }
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid checkout request" }, { status: 400 });
  }
  const { url } = await createPlanCheckout({
    planId: parsed.data.planId,
    customerEmail: parsed.data.email,
  });
  return NextResponse.json({ url });
}
