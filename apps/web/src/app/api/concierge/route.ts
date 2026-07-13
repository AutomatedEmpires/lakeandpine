import { NextResponse } from "next/server";
import { z } from "zod";

import { checkRequestRateLimit } from "@/lib/rate-limit";
import { readJsonBody, RequestBodyError } from "@/lib/request-security";

const schema = z.object({ message: z.string().trim().min(1).max(1000) });

function reply(text: string) {
  return NextResponse.json({ reply: text });
}
export async function POST(request: Request) {
  try {
    const rateLimit = await checkRequestRateLimit(request, {
      scope: "concierge",
      limit: 30,
      windowMs: 10 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      const status = rateLimit.reason === "limit" ? 429 : 503;
      return NextResponse.json(
        { error: status === 429 ? "Please pause before sending more questions." : "Concierge is temporarily unavailable." },
        { status, headers: { "retry-after": String(rateLimit.retryAfterSeconds) } },
      );
    }
  } catch {
    return NextResponse.json({ error: "Concierge is temporarily unavailable." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, 4_000);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Invalid message" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid message" }, { status: 400 });
  }

  const msg = parsed.data.message.toLowerCase();
  const has = (...words: string[]) => words.some((word) => msg.includes(word));

  if (has("price", "cost", "quote", "estimate", "rate")) {
    return reply(
      "Exceptional properties are quoted to the scope rather than forced into a commodity price. Size, condition, rooms or zones, finish sensitivity, access, crew needs, frequency, travel, and deadlines shape the proposal. The consultation request collects those inputs; no appointment or price is confirmed online.",
    );
  }
  if (has("estate", "home", "residential", "house", "seasonal")) {
    return reply(
      "Private Estate Care is for large primary and seasonal residences, arrival or departure preparation, detailed resets, and recurring care that benefits from a durable room-and-finish plan. Rapid-turnover vacation-rental cleaning is not Lake & Pine's focus.",
    );
  }
  if (has("construction", "builder", "renovation", "dust", "handoff", "walkthrough")) {
    return reply(
      "Construction Handoff can cover reviewed rough-clean, detailed final-clean, walkthrough touch-up, and owner-arrival scopes. Active hazardous debris, mold or remediation, missing required utilities, specialty restoration, and high-access exterior work are outside the assumed scope.",
    );
  }
  if (has("marine", "boat", "yacht", "cabin", "dock", "marina")) {
    return reply(
      "Lake & Marine Interior Care focuses on cabins, lounges, galleys, heads, linens, and owner arrival or departure resets. Hulls, gelcoat, oxidation, engines, bilges, coatings, and mechanical or remediation work are not included.",
    );
  }
  if (has("commercial", "office", "studio", "showroom", "business")) {
    return reply(
      "Select Commercial Care is designed for ordinary professional offices, studios, showrooms, model homes, marina offices, and similar presentation-led spaces. Medical, laboratory, food-production, industrial, hazardous, or regulated sanitation work requires separate qualifications and is not assumed.",
    );
  }
  if (has("schedule", "available", "book", "appointment", "when", "reschedule")) {
    return reply(
      "Choose a preferred date and alternatives in the consultation request. The scheduler checks territory, qualified crew, travel, duration, access, and current capacity; an operator then confirms a feasible window. For an existing service, use the Service Support page to request a change.",
    );
  }
  if (has("complaint", "missed", "reclean", "refund", "damage", "cancel")) {
    return reply(
      "Use Service Support to create an auditable reschedule, cancellation, concern, re-clean, damage, or refund-review request. Submission does not automatically change a visit or move money; an operator reviews the agreed scope and service record before confirming an outcome.",
    );
  }
  if (has("insured", "bonded", "licensed", "background", "screened", "guarantee")) {
    return reply(
      "Lake & Pine does not publish a credential, screening, or guarantee claim until it has current evidence and an approved operating policy. Ask the operator for the verified details relevant to your scope before approving service.",
    );
  }
  if (has("area", "spokane", "coeur", "cda", "post falls", "hayden", "liberty", "where")) {
    return reply(
      "Requests in the Coeur d'Alene–Spokane corridor are reviewed property by property. A named city is not a capacity promise: territory, travel, project scale, access, and the qualified team needed must all be confirmed.",
    );
  }

  return reply(
    "I can explain Private Estate Care, Construction Handoff, Lake & Marine Interior Care, Select Commercial Care, custom proposals, capacity-aware scheduling, and service recovery. Start a private consultation request when you are ready to build a property brief.",
  );
}
