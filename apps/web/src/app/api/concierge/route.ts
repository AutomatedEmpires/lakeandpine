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
      `Yes — pet homes are our normal. Add pet names, room instructions, and product preferences during booking or in your dashboard, and we default to eco-conscious, pet-aware supplies (unscented on request).`,
    );
  }

  // Supplies / products
  if (has("supplies", "products", "bring", "chemical", "eco")) {
    return reply(
      `We bring everything — eco-conscious supplies are included, with unscented and pet-aware options you can save to your home notes so every visit remembers your preferences.`,
    );
  }

  // Scheduling / availability
  if (has("schedule", "when", "soon", "available", "book", "appointment", "today", "tomorrow")) {
    return reply(
      `We typically have same-week windows Monday–Saturday with 8 AM, 10 AM, 12 PM, and 2 PM arrivals. The booking flow shows live selectable dates — it takes about two minutes, and you get text updates plus a dashboard for your home.`,
    );
  }

  // Trust
  if (has("insured", "bonded", "background", "trust", "vetted", "licensed")) {
    return reply(
      `Every cleaner is background-checked, and the company is licensed, bonded, and insured. There's also a 24-hour make-right window: if anything misses the agreed scope, we come back and fix it.`,
    );
  }

  // Guarantee
  if (has("guarantee", "make-right", "satisfaction", "refund")) {
    return reply(
      `The promise is a 24-hour make-right window — if something wasn't completed to the agreed scope, tell us within a day and we return to fix it.`,
    );
  }

  // Areas
  if (has("area", "spokane", "coeur", "cda", "post falls", "hayden", "liberty", "rathdrum", "where")) {
    return reply(
      `We serve Coeur d'Alene, Spokane, Post Falls, Hayden, Liberty Lake, Spokane Valley, and Rathdrum. Each city has its own page under Areas with local details — and booking works the same everywhere.`,
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

  return reply(
    `I can help with service choice, starting prices, pets, supplies, scheduling, and service areas. For an exact starting number use the estimate studio on the home page, or start a booking — and you can always call or text ${BUSINESS_PHONE}.`,
  );
}
