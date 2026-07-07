import "server-only";

import { jsonb, sql } from "./db";

export type Service = {
  id: string;
  title: string;
  icon: string;
  blurb: string;
  price_label: string;
  starting_price_cents: number | null;
  tags: string[];
  bookable: boolean;
  sort: number;
};

export type Addon = {
  id: string;
  title: string;
  price_label: string;
  price_cents: number | null;
  sort: number;
};

export type Plan = {
  id: string;
  name: string;
  price_cents: number;
  save_label: string;
  popular: boolean;
  features: string[];
  sort: number;
};

export type ServiceArea = {
  slug: string;
  city: string;
  state: string;
  seo_phrase: string;
  headline: string;
  intro: string;
  neighborhoods: string[];
  highlights: { title: string; body: string }[];
  faqs: [string, string][];
  lat: number | null;
  lng: number | null;
  sort: number;
};

export type Faq = { id: number; question: string; answer: string; sort: number };

export type Review = {
  id: string;
  author_initial: string;
  author_name: string;
  city: string;
  body: string;
  rating: number;
};

export async function getServices(): Promise<Service[]> {
  return sql<Service[]>`
    select id, title, icon, blurb, price_label, starting_price_cents, tags, bookable, sort
    from services where active order by sort`;
}

export async function getAddons(): Promise<Addon[]> {
  return sql<Addon[]>`
    select id, title, price_label, price_cents, sort
    from addons where active order by sort`;
}

export async function getPlans(): Promise<Plan[]> {
  return sql<Plan[]>`
    select id, name, price_cents, save_label, popular, features, sort
    from plans order by sort`;
}

export async function getServiceAreas(): Promise<ServiceArea[]> {
  return sql<ServiceArea[]>`
    select slug, city, state, seo_phrase, headline, intro, neighborhoods,
           highlights, faqs, lat, lng, sort
    from service_areas where active order by sort`;
}

export async function getServiceArea(slug: string): Promise<ServiceArea | null> {
  const rows = await sql<ServiceArea[]>`
    select slug, city, state, seo_phrase, headline, intro, neighborhoods,
           highlights, faqs, lat, lng, sort
    from service_areas where slug = ${slug} and active`;
  return rows[0] ?? null;
}

export async function getFaqs(): Promise<Faq[]> {
  return sql<Faq[]>`select id, question, answer, sort from faqs where active order by sort`;
}

export async function getReviews(limit?: number): Promise<Review[]> {
  return sql<Review[]>`
    select id, author_initial, author_name, city, body, rating
    from reviews where published
    order by created_at desc
    ${limit ? sql`limit ${limit}` : sql``}`;
}

// --- Conversion writes -------------------------------------------------------

export async function createQuote(input: {
  serviceId: string;
  inputs: Record<string, unknown>;
  estimateCents: number;
  email?: string | null;
  source?: string;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    insert into quotes (service_id, inputs, estimate_cents, email, source)
    values (${input.serviceId}, ${jsonb(input.inputs)}, ${input.estimateCents},
            ${input.email ?? null}, ${input.source ?? "estimate_studio"})
    returning id`;
  return rows[0];
}

export async function createLead(input: {
  fullName: string;
  zip: string;
  serviceId?: string | null;
  preferredDate?: string | null;
  email?: string | null;
  phone?: string | null;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    insert into leads (full_name, zip, service_id, preferred_date, email, phone)
    values (${input.fullName}, ${input.zip}, ${input.serviceId ?? null},
            ${input.preferredDate ?? null}, ${input.email ?? null}, ${input.phone ?? null})
    returning id`;
  return rows[0];
}

export async function createBooking(input: {
  serviceId: string;
  addonIds: string[];
  frequency: string;
  scheduledDate: string;
  scheduledWindow: string;
  estimateCents: number;
  quoteId?: string | null;
  customerId?: string | null;
  contact: { name: string; phone: string; email: string; zip: string };
  homeDetails: Record<string, unknown>;
  accessNotes?: string | null;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    insert into bookings
      (service_id, addon_ids, frequency, scheduled_date, scheduled_window,
       estimate_cents, quote_id, customer_id, contact, home_details, access_notes)
    values
      (${input.serviceId}, ${input.addonIds}, ${input.frequency}, ${input.scheduledDate},
       ${input.scheduledWindow}, ${input.estimateCents}, ${input.quoteId ?? null},
       ${input.customerId ?? null}, ${jsonb(input.contact)},
       ${jsonb(input.homeDetails)}, ${input.accessNotes ?? null})
    returning id`;
  const booking = rows[0];
  await sql`
    insert into booking_events (booking_id, type, data)
    values (${booking.id}, 'requested', ${jsonb({ via: "web_booking_flow" })})`;
  return booking;
}

// --- Customer / dashboard ----------------------------------------------------

export type Customer = {
  id: string;
  clerk_user_id: string | null;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  role: string;
  referral_credit_cents: number;
};

export async function getCustomerByClerkId(clerkUserId: string): Promise<Customer | null> {
  const rows = await sql<Customer[]>`
    select id, clerk_user_id, email, full_name, phone, role, referral_credit_cents
    from customers where clerk_user_id = ${clerkUserId}`;
  return rows[0] ?? null;
}

export async function getCustomerByEmail(email: string): Promise<Customer | null> {
  const rows = await sql<Customer[]>`
    select id, clerk_user_id, email, full_name, phone, role, referral_credit_cents
    from customers where email = ${email}`;
  return rows[0] ?? null;
}

export async function upsertCustomerFromClerk(input: {
  clerkUserId: string;
  email: string | null;
  fullName: string | null;
  phone: string | null;
}): Promise<Customer> {
  // Adopt an existing guest-booking customer by email when one exists.
  const rows = await sql<Customer[]>`
    insert into customers (clerk_user_id, email, full_name, phone)
    values (${input.clerkUserId}, ${input.email}, ${input.fullName}, ${input.phone})
    on conflict (email) do update set
      clerk_user_id = coalesce(customers.clerk_user_id, excluded.clerk_user_id),
      full_name = coalesce(excluded.full_name, customers.full_name),
      phone = coalesce(excluded.phone, customers.phone)
    returning id, clerk_user_id, email, full_name, phone, role, referral_credit_cents`;
  return rows[0];
}

export type BookingRow = {
  id: string;
  service_id: string;
  service_title: string;
  addon_ids: string[];
  frequency: string;
  scheduled_date: string;
  scheduled_window: string;
  status: string;
  estimate_cents: number | null;
  access_notes: string | null;
  created_at: string;
};

export async function getCustomerBookings(customerId: string): Promise<BookingRow[]> {
  return sql<BookingRow[]>`
    select b.id, b.service_id, s.title as service_title, b.addon_ids, b.frequency,
           to_char(b.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
           b.scheduled_window, b.status, b.estimate_cents, b.access_notes, b.created_at::text
    from bookings b join services s on s.id = b.service_id
    where b.customer_id = ${customerId}
    order by b.scheduled_date desc`;
}

export async function getNextBooking(customerId: string): Promise<BookingRow | null> {
  const rows = await sql<BookingRow[]>`
    select b.id, b.service_id, s.title as service_title, b.addon_ids, b.frequency,
           to_char(b.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
           b.scheduled_window, b.status, b.estimate_cents, b.access_notes, b.created_at::text
    from bookings b join services s on s.id = b.service_id
    where b.customer_id = ${customerId}
      and b.status in ('requested', 'confirmed')
      and b.scheduled_date >= current_date
    order by b.scheduled_date asc
    limit 1`;
  return rows[0] ?? null;
}

export type Home = {
  id: string;
  label: string;
  city: string | null;
  zip: string | null;
  preference_tags: string[];
  cleaner_notes: string | null;
};

export async function getPrimaryHome(customerId: string): Promise<Home | null> {
  const rows = await sql<Home[]>`
    select id, label, city, zip, preference_tags, cleaner_notes
    from homes where customer_id = ${customerId}
    order by created_at asc limit 1`;
  return rows[0] ?? null;
}

export async function saveHomeNotes(
  homeId: string,
  customerId: string,
  cleanerNotes: string,
): Promise<void> {
  await sql`
    update homes set cleaner_notes = ${cleanerNotes}
    where id = ${homeId} and customer_id = ${customerId}`;
}

export type BillingRecord = {
  id: string;
  description: string;
  amount_cents: number;
  status: string;
  occurred_at: string;
};

export async function getBillingRecords(customerId: string): Promise<BillingRecord[]> {
  return sql<BillingRecord[]>`
    select id, description, amount_cents, status, occurred_at::text
    from billing_records where customer_id = ${customerId}
    order by occurred_at desc`;
}

export type SupportMessage = {
  id: number;
  sender: string;
  body: string;
  created_at: string;
};

export async function getSupportThread(customerId: string): Promise<SupportMessage[]> {
  return sql<SupportMessage[]>`
    select id, sender, body, created_at::text
    from support_messages where customer_id = ${customerId}
    order by created_at asc`;
}

export async function addSupportMessage(
  customerId: string,
  sender: "customer" | "staff" | "concierge",
  body: string,
): Promise<void> {
  await sql`
    insert into support_messages (customer_id, sender, body)
    values (${customerId}, ${sender}, ${body})`;
}

export async function requestReschedule(
  bookingId: string,
  customerId: string,
  note: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    select id from bookings
    where id = ${bookingId} and customer_id = ${customerId}
      and status in ('requested', 'confirmed')`;
  if (!rows[0]) return false;
  await sql`
    insert into booking_events (booking_id, type, data)
    values (${bookingId}, 'reschedule_requested', ${jsonb({ note })})`;
  return true;
}
