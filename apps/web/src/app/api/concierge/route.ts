import { NextResponse } from "next/server";
import { z } from "zod";

import { getFaqs } from "@/lib/data";
import { BUSINESS_PHONE } from "@/lib/env";
import { calculateEstimate } from "@/lib/pricing";

// Pine Concierge is deliberately rule-based and honest: it explains real anchors
// from the canonical pricing engine and routes people to the estimate studio and
// booking flow. It NEVER invents prices or confirms bookings — those come only
// from /api/quote and /api/bookings.

const schema = z.object({ message: z.string().min(1).max(1000) });

function reply(text: string) {
  return NextResponse.json({ reply: text });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid message" }, { status: 400 });
  }
  const msg = parsed.data.message.toLowerCase();

  const has = (...words: string[]) => words.some((w) => msg.includes(w));

  // Deep clean pricing
  if (has("deep") && has("cost", "price", "much", "estimate")) {
    const anchor = calculateEstimate({
      sizeBand: "1200_2000", serviceId: "deep", bedrooms: "3", bathrooms: "2",
      frequency: "onetime", pets: "none",
    });
    return reply(
      `A Pine & Polish Deep Clean starts at $299, and a typical 3-bed/2-bath around 1,200–2,000 sq ft lands near $${anchor.dollars} as a one-time visit. That's a starting anchor, not a locked quote — the estimate studio on the home page gives you your own number in about 20 seconds.`,
    );
  }

  // General pricing
  if (has("cost", "price", "much", "estimate", "quote", "rate")) {
    return reply(
      `Prices are transparent starting anchors: Essential Home Reset from $139, Deep Clean from $299, Move In/Out from $369, Lakehouse Turnover from $125. Home size, bedrooms, bathrooms, pets, and frequency adjust it — the estimate studio on the home page computes your exact starting number, and we confirm the final quote before the visit.`,
    );
  }

  // Service recommendation
  if (has("which service", "right for me", "what service", "recommend", "choose")) {
    return reply(
      `Quick guide: staying on top of a lived-in home → Essential Home Reset (recurring). First clean, buildup, or hosting → Pine & Polish Deep Clean. Lease turn or sale → Move In/Out Detail. Short-term rental → Lakehouse Turnover. Office or studio → Small Office Refresh (custom quote). Tell me about the home or just open the booking flow — step one lets you compare all four.`,
    );
  }

  // Pets
  if (has("pet", "dog", "cat")) {
    return reply(
      `Add pet names, temperament, where they'll be during service, and any doors or gates the operator should plan around. Product preferences can also be added to the service request; the team confirms the final plan before service.`,
    );
  }

  // Supplies / products
  if (has("supplies", "products", "bring", "chemical", "eco")) {
    return reply(
      `Add unscented, homeowner-supplied, delicate-surface, or other product preferences to the plan. The operator will confirm what the team provides before the visit.`,
    );
  }

  // Scheduling / availability
  if (has("schedule", "when", "soon", "available", "book", "appointment", "today", "tomorrow")) {
    return reply(
      `The planning flow lets you request a preferred date and arrival window. It does not show live capacity or confirm an appointment; an operator reviews availability and scope before scheduling.`,
    );
  }

  // Trust
  if (has("insured", "bonded", "background", "trust", "vetted", "licensed")) {
    return reply(
      `Company credentials and cleaner-screening details are being finalized. The operator should provide current verified information before service rather than relying on an unverified website claim.`,
    );
  }

  // Guarantee
  if (has("guarantee", "make-right", "satisfaction", "refund")) {
    return reply(
      `The service and follow-up policy is being finalized. Any make-right or refund terms should be confirmed in the written service scope before the visit.`,
    );
  }

  // Areas
  if (has("area", "spokane", "coeur", "cda", "post falls", "hayden", "liberty", "rathdrum", "where")) {
    return reply(
      `Area coverage has not been confirmed for public claims yet. Add your ZIP to a service request only after intake is enabled, and an operator can confirm whether service is available.`,
    );
  }

  // FAQ sweep from the real database content
  const faqs = await getFaqs();
  const words = msg.split(/\W+/).filter((w) => w.length > 3);
  const match = faqs.find((faq) =>
    words.some((w) => faq.question.toLowerCase().includes(w)),
  );
  if (match) {
    return reply(match.answer);
  }

  const contactFallback = BUSINESS_PHONE ? `, or call or text ${BUSINESS_PHONE}` : "";
  return reply(
    `I can help with service choice, starting prices, pets, supplies, scheduling, and service areas. For an exact starting number use the estimate studio on the home page, or start a booking${contactFallback}.`,
  );
}
