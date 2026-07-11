import { NextResponse } from "next/server";
import { z } from "zod";

import { createQuote } from "@/lib/data";
import { calculateEstimate } from "@/lib/pricing";

const quoteSchema = z.object({
  sizeBand: z.enum(["under_1200", "1200_2000", "2000_3000", "3000_plus"]),
  serviceId: z.enum(["essential", "deep", "move", "rental"]),
  bedrooms: z.enum(["1_2", "3", "4", "5_plus"]),
  bathrooms: z.enum(["1", "2", "3", "4_plus"]),
  frequency: z.enum(["weekly", "biweekly", "monthly", "onetime"]),
  pets: z.enum(["none", "one", "two_plus"]),
  priorities: z.string().max(2000).optional(),
  email: z.string().email().optional(),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = quoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid quote inputs" }, { status: 400 });
  }
  const { priorities, email, ...inputs } = parsed.data;
  // The estimate is always computed server-side from the canonical engine.
  const estimate = calculateEstimate(inputs);
  const quote = await createQuote({
    serviceId: inputs.serviceId,
    inputs: { ...inputs, priorities: priorities ?? null },
    estimateCents: estimate.cents,
    email: email ?? null,
  });
  return NextResponse.json({ id: quote.id, estimate: estimate.dollars });
}
