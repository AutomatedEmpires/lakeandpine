import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { createBooking, createQuote, getCustomerByEmail, upsertCustomerFromClerk } from "@/lib/data";
import { sendBookingConfirmation } from "@/lib/email";
import { authEnabled } from "@/lib/env";
import { calculateEstimate, ESTIMATE_SERVICES } from "@/lib/pricing";
import { isBookableDate, isBookableWindow } from "@/lib/scheduling";

const bookingSchema = z.object({
  serviceId: z.enum(["essential", "deep", "move", "rental"]),
  addonIds: z.array(z.enum(["fridge", "oven", "laundry", "windows", "organization"])).default([]),
  frequency: z.enum(["weekly", "biweekly", "monthly", "onetime"]),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scheduledWindow: z.string(),
  home: z.object({
    sizeBand: z.enum(["under_1200", "1200_2000", "2000_3000", "3000_plus"]),
    bedrooms: z.enum(["1_2", "3", "4", "5_plus"]),
    bathrooms: z.enum(["1", "2", "3", "4_plus"]),
    pets: z.enum(["none", "one", "two_plus"]),
    condition: z.enum(["maintained", "needs_detail"]),
    notes: z.string().max(2000).optional(),
  }),
  contact: z.object({
    name: z.string().min(1).max(200),
    phone: z.string().min(7).max(30),
    email: z.string().email(),
    zip: z.string().min(3).max(12),
  }),
  accessNotes: z.string().max(2000).optional(),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = bookingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid booking", issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const input = parsed.data;

  if (!isBookableDate(input.scheduledDate)) {
    return NextResponse.json(
      { error: "That date isn't bookable — choose a day within the next five weeks (Mon–Sat)." },
      { status: 422 },
    );
  }
  if (!isBookableWindow(input.scheduledWindow)) {
    return NextResponse.json({ error: "That arrival window isn't available." }, { status: 422 });
  }

  // Canonical server-side estimate.
  const estimate = calculateEstimate({
    sizeBand: input.home.sizeBand,
    serviceId: input.serviceId,
    bedrooms: input.home.bedrooms,
    bathrooms: input.home.bathrooms,
    frequency: input.frequency,
    pets: input.home.pets,
    addonIds: input.addonIds,
  });

  // Attach the signed-in customer when Clerk is live; otherwise link by
  // existing guest-customer email if one exists.
  let customerId: string | null = null;
  if (authEnabled) {
    const { userId } = await auth();
    if (userId) {
      const user = await currentUser();
      const customer = await upsertCustomerFromClerk({
        clerkUserId: userId,
        email: user?.primaryEmailAddress?.emailAddress ?? input.contact.email,
        fullName: user?.fullName ?? input.contact.name,
        phone: input.contact.phone,
      });
      customerId = customer.id;
    }
  }
  if (!customerId) {
    const existing = await getCustomerByEmail(input.contact.email);
    customerId = existing?.id ?? null;
  }

  const quote = await createQuote({
    serviceId: input.serviceId,
    inputs: { ...input.home, frequency: input.frequency, addonIds: input.addonIds },
    estimateCents: estimate.cents,
    email: input.contact.email,
    source: "booking",
  });

  const booking = await createBooking({
    serviceId: input.serviceId,
    addonIds: input.addonIds,
    frequency: input.frequency,
    scheduledDate: input.scheduledDate,
    scheduledWindow: input.scheduledWindow,
    estimateCents: estimate.cents,
    quoteId: quote.id,
    customerId,
    contact: input.contact,
    homeDetails: input.home,
    accessNotes: input.accessNotes ?? null,
  });

  const serviceTitle =
    ESTIMATE_SERVICES.find((s) => s.id === input.serviceId)?.label ?? input.serviceId;
  await sendBookingConfirmation({
    to: input.contact.email,
    name: input.contact.name,
    serviceTitle,
    date: input.scheduledDate,
    window: input.scheduledWindow,
    estimateDollars: estimate.dollars,
    bookingId: booking.id,
  });

  return NextResponse.json({ id: booking.id, estimate: estimate.dollars });
}
