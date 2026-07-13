import "server-only";

import { randomUUID } from "node:crypto";
import type postgres from "postgres";

import {
  deriveBookingReference,
  hashBookingReference,
} from "./booking-reference";
import { jsonb, sql } from "./db";
import type { JobStatus, PropertyProfile, RoomPlan } from "./service-planning";

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

export type Faq = {
  id: number;
  question: string;
  answer: string;
  sort: number;
};

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

export async function getServiceArea(
  slug: string,
): Promise<ServiceArea | null> {
  const rows = await sql<ServiceArea[]>`
    select slug, city, state, seo_phrase, headline, intro, neighborhoods,
           highlights, faqs, lat, lng, sort
    from service_areas where slug = ${slug} and active`;
  return rows[0] ?? null;
}

export async function getFaqs(): Promise<Faq[]> {
  return sql<
    Faq[]
  >`select id, question, answer, sort from faqs where active order by sort`;
}

export async function getReviews(limit?: number): Promise<Review[]> {
  return sql<Review[]>`
    select id, author_initial, author_name, city, body, rating
    from reviews where published and source <> 'placeholder'
    order by created_at desc
    ${limit ? sql`limit ${limit}` : sql``}`;
}

export async function createBooking(input: {
  serviceId: string;
  frequency: string;
  scheduledDate: string;
  scheduledWindow: string;
  customerId?: string | null;
  contact: { name: string; phone: string; email: string; zip: string };
  homeDetails: Record<string, unknown>;
  accessNotes?: string | null;
  propertyProfile: Record<string, unknown>;
  roomPlan: RoomPlan[];
  cleaningPreferences: string[];
  specialInstructions?: string | null;
  planningDirection: string;
  planningScore: number;
  estimatedDurationMinutes: number;
  requiredCrewSize: number;
  requiredSkills: string[];
  qualificationStatus: "requested" | "walkthrough_needed";
  qualificationRequirements: Record<string, unknown>;
  requestSource: "web_booking" | "runtime_smoke";
  isDevSeed: boolean;
  idempotencyKeyHash: string;
  consentSnapshot: Record<string, unknown>;
  consentVersion: string;
  consentNoticeDate: string;
  checklist: { roomLabel: string | null; label: string }[];
}): Promise<{ id: string; duplicate: boolean }> {
  const bookingId = randomUUID();
  const publicReferenceHash = hashBookingReference(
    deriveBookingReference(bookingId),
  );
  return sql.begin(async (tx) => {
    const txJson = (value: unknown) => tx.json(value as postgres.JSONValue);
    const rows = await tx<{ id: string }[]>`
      insert into bookings
        (id, service_id, service_vertical, frequency, scheduled_date, scheduled_window,
         customer_id, contact, home_details, access_notes, property_profile, room_plan,
         cleaning_preferences, special_instructions, planning_direction, planning_score,
         qualification_status, estimated_duration_minutes, required_crew_size, required_skills,
         qualification_requirements, request_source, idempotency_key,
         public_reference_token_hash, consent_snapshot, consented_at, consent_version,
         consent_notice_date, is_dev_seed)
      values
        (${bookingId}, ${input.serviceId}, ${input.serviceId}, ${input.frequency}, ${input.scheduledDate},
         ${input.scheduledWindow}, ${input.customerId ?? null}, ${txJson(input.contact)},
         ${txJson(input.homeDetails)}, ${input.accessNotes ?? null}, ${txJson(input.propertyProfile)},
         ${txJson(input.roomPlan)}, ${input.cleaningPreferences}, ${input.specialInstructions ?? null},
         ${input.planningDirection}, ${input.planningScore}, ${input.qualificationStatus},
         ${input.estimatedDurationMinutes}, ${input.requiredCrewSize}, ${input.requiredSkills},
         ${txJson(input.qualificationRequirements)}, ${input.requestSource}, ${input.idempotencyKeyHash},
         ${publicReferenceHash}, ${txJson(input.consentSnapshot)}, now(), ${input.consentVersion},
         ${input.consentNoticeDate}, ${input.isDevSeed})
      on conflict (idempotency_key) do nothing
      returning id`;
    if (!rows[0]) {
      const existing = await tx<{ id: string }[]>`
        select id from bookings where idempotency_key = ${input.idempotencyKeyHash} limit 1`;
      if (!existing[0]) throw new Error("Idempotent booking lookup failed");
      return { id: existing[0].id, duplicate: true };
    }
    const booking = rows[0];
    await tx`
      insert into booking_events (booking_id, type, data)
      values (${booking.id}, 'requested', ${txJson({
        via: "premium_request_flow",
        planningScore: input.planningScore,
        qualificationStatus: input.qualificationStatus,
      })})`;

    if (input.checklist.length) {
      const checklistRows = input.checklist.map((item, sort) => ({
        room_label: item.roomLabel,
        label: item.label,
        sort,
      }));
      await tx`
        insert into checklist_items (booking_id, room_label, label, sort)
        select ${booking.id}, item.room_label, item.label, item.sort
        from jsonb_to_recordset(${txJson(checklistRows)}::jsonb)
          as item(room_label text, label text, sort integer)`;
    }

    await tx`
      insert into notification_outbox
        (booking_id, customer_id, notification_type, channel, recipient_kind,
         recipient_address, template_key, template_data, deduplication_key, is_dev_seed)
      values
        (${booking.id}, ${input.customerId ?? null}, 'customer_confirmation', 'email',
         'customer', ${input.contact.email}, 'booking-request-received',
         ${txJson({ bookingId: booking.id })}, ${`booking:${booking.id}:customer_confirmation`}, ${input.isDevSeed}),
        (${booking.id}, ${input.customerId ?? null}, 'ops_notification', 'email',
         'ops', null, 'ops-booking-request', ${txJson({ bookingId: booking.id })},
         ${`booking:${booking.id}:ops_notification`}, ${input.isDevSeed})`;

    return { id: booking.id, duplicate: false };
  });
}

export async function recordBookingNotificationDelivery(
  bookingId: string,
  notificationType: "customer_confirmation" | "ops_notification",
  outcome: "sent" | "suppressed" | "skipped" | "failed",
) {
  const status =
    outcome === "sent"
      ? "sent"
      : outcome === "suppressed"
        ? "canceled"
        : outcome === "failed"
          ? "retry"
          : "failed";
  await sql`
    update notification_outbox
    set status = ${status},
        attempt_count = attempt_count + 1,
        sent_at = case when ${status} = 'sent' then now() else sent_at end,
        next_attempt_at = case when ${status} = 'retry' then now() + interval '15 minutes' else next_attempt_at end,
        last_error_code = case when ${status} = 'sent' then null else ${outcome} end
    where booking_id = ${bookingId} and notification_type = ${notificationType}`;
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

export async function getCustomerByClerkId(
  clerkUserId: string,
): Promise<Customer | null> {
  const rows = await sql<Customer[]>`
    select id, clerk_user_id, email, full_name, phone, role, referral_credit_cents
    from customers where clerk_user_id = ${clerkUserId}`;
  return rows[0] ?? null;
}

export async function getCustomerByEmail(
  email: string,
): Promise<Customer | null> {
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

export async function getCustomerBookings(
  customerId: string,
): Promise<BookingRow[]> {
  return sql<BookingRow[]>`
    select b.id, b.service_id, s.title as service_title, b.addon_ids, b.frequency,
           to_char(b.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
           b.scheduled_window, b.status, b.estimate_cents, b.access_notes, b.created_at::text
    from bookings b join services s on s.id = b.service_id
    where b.customer_id = ${customerId}
    order by b.scheduled_date desc`;
}

export async function getNextBooking(
  customerId: string,
): Promise<BookingRow | null> {
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

export async function getBillingRecords(
  customerId: string,
): Promise<BillingRecord[]> {
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

export async function getSupportThread(
  customerId: string,
): Promise<SupportMessage[]> {
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

// --- Operator workspace -----------------------------------------------------

export type OperatorBooking = BookingRow & {
  contact: { name?: string; phone?: string; email?: string; zip?: string };
  home_details: Record<string, unknown>;
  property_profile: PropertyProfile;
  room_plan: RoomPlan[];
  cleaning_preferences: string[];
  pet_notes: string | null;
  special_instructions: string | null;
  planning_direction: string | null;
  planning_score: number | null;
  contact_status: string;
  is_dev_seed: boolean;
};

export type ChecklistItem = {
  id: string;
  room_label: string | null;
  label: string;
  state: "pending" | "completed" | "skipped";
  sort: number;
};

export type InternalNote = {
  id: number;
  author_label: string;
  body: string;
  created_at: string;
};

export type FollowUp = {
  id: string;
  kind: "service_check_in" | "review_request";
  channel: "manual" | "email" | "sms";
  status: "planned" | "ready" | "completed" | "canceled";
  scheduled_for: string | null;
};

export async function getOperatorBookings(
  devOnly: boolean,
): Promise<OperatorBooking[]> {
  return sql<OperatorBooking[]>`
    select b.id, b.service_id, s.title as service_title, b.addon_ids, b.frequency,
           to_char(b.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
           b.scheduled_window, b.status, b.estimate_cents, b.access_notes,
           b.created_at::text, b.contact, b.home_details, b.property_profile,
           b.room_plan, b.cleaning_preferences, b.pet_notes, b.special_instructions,
           b.planning_direction, b.planning_score, b.contact_status, b.is_dev_seed
    from bookings b join services s on s.id = b.service_id
    where ${devOnly ? sql`b.is_dev_seed` : sql`true`}
      and b.status <> 'canceled'
    order by b.scheduled_date asc, b.created_at asc`;
}

export async function getBookingChecklist(
  bookingId: string,
  devOnly: boolean,
): Promise<ChecklistItem[]> {
  return sql<ChecklistItem[]>`
    select c.id, c.room_label, c.label, c.state, c.sort
    from checklist_items c join bookings b on b.id = c.booking_id
    where c.booking_id = ${bookingId}
      and ${devOnly ? sql`b.is_dev_seed` : sql`true`}
    order by c.sort, c.created_at`;
}

export async function getBookingInternalNotes(
  bookingId: string,
  devOnly: boolean,
): Promise<InternalNote[]> {
  return sql<InternalNote[]>`
    select n.id, n.author_label, n.body, n.created_at::text
    from internal_notes n join bookings b on b.id = n.booking_id
    where n.booking_id = ${bookingId}
      and ${devOnly ? sql`b.is_dev_seed` : sql`true`}
    order by n.created_at desc`;
}

export async function getBookingFollowUps(
  bookingId: string,
  devOnly: boolean,
): Promise<FollowUp[]> {
  return sql<FollowUp[]>`
    select f.id, f.kind, f.channel, f.status, f.scheduled_for::text
    from follow_ups f join bookings b on b.id = f.booking_id
    where f.booking_id = ${bookingId}
      and ${devOnly ? sql`b.is_dev_seed` : sql`true`}
    order by f.scheduled_for nulls last, f.created_at`;
}

export async function updateBookingStatus(
  bookingId: string,
  fromStatus: JobStatus,
  toStatus: JobStatus,
  devOnly: boolean,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update bookings set status = ${toStatus}
    where id = ${bookingId} and status = ${fromStatus}
      and ${devOnly ? sql`is_dev_seed` : sql`true`}
    returning id`;
  if (!rows[0]) return false;

  await sql`
    insert into booking_events (booking_id, type, data)
    values (${bookingId}, 'status_changed', ${jsonb({ fromStatus, toStatus, via: "operator" })})`;

  if (toStatus === "completed") {
    await sql`
      insert into follow_ups (booking_id, kind, scheduled_for, is_dev_seed)
      select ${bookingId}, task.kind, task.scheduled_for, b.is_dev_seed
      from bookings b
      cross join (values
        ('service_check_in'::text, now() + interval '2 hours'),
        ('review_request'::text, now() + interval '1 day')
      ) as task(kind, scheduled_for)
      where b.id = ${bookingId}
      on conflict (booking_id, kind) do nothing`;
  }
  return true;
}

export async function setChecklistItemState(
  bookingId: string,
  itemId: string,
  state: ChecklistItem["state"],
  devOnly: boolean,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update checklist_items c
    set state = ${state}, completed_at = case when ${state} = 'completed' then now() else null end
    from bookings b
    where c.id = ${itemId} and c.booking_id = ${bookingId} and b.id = c.booking_id
      and ${devOnly ? sql`b.is_dev_seed` : sql`true`}
    returning c.id`;
  return Boolean(rows[0]);
}

export async function addInternalNote(
  bookingId: string,
  body: string,
  devOnly: boolean,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    select id from bookings
    where id = ${bookingId} and ${devOnly ? sql`is_dev_seed` : sql`true`}`;
  if (!rows[0]) return false;
  await sql`
    insert into internal_notes (booking_id, body, is_dev_seed)
    values (${bookingId}, ${body}, ${devOnly})`;
  return true;
}

export async function completeFollowUp(
  bookingId: string,
  followUpId: string,
  devOnly: boolean,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update follow_ups f set status = 'completed', completed_at = now()
    from bookings b
    where f.id = ${followUpId} and f.booking_id = ${bookingId} and b.id = f.booking_id
      and ${devOnly ? sql`b.is_dev_seed` : sql`true`}
    returning f.id`;
  return Boolean(rows[0]);
}
