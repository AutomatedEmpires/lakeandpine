import "server-only";

import { randomUUID } from "node:crypto";
import type postgres from "postgres";

import {
  deriveBookingReference,
  hashBookingReference,
} from "./booking-reference";
import { sql } from "./db";
import type { RouteAssessmentInput } from "./route-qualification";
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
  contact: {
    name: string;
    phone: string;
    email: string;
    street: string;
    unit: string;
    city: string;
    state: string;
    zip: string;
  };
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
  routeAssessment: RouteAssessmentInput;
}): Promise<{
  id: string;
  duplicate: boolean;
  notificationOutboxIds: {
    customer: string;
    ops: string;
  } | null;
}> {
  const bookingId = randomUUID();
  const publicReferenceHash = hashBookingReference(
    deriveBookingReference(bookingId),
  );
  return sql.begin(async (tx) => {
    const txJson = (value: unknown) => tx.json(value as postgres.JSONValue);
    await tx`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await tx`select set_config(
      'lakeandpine.current_customer_id', ${input.customerId ?? ""}, true
    )`;
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
      const existing = await tx<{ id: string | null }[]>`
        select private.current_intake_booking_by_idempotency(
          ${input.idempotencyKeyHash}::text
        ) as id`;
      if (!existing[0]?.id) throw new Error("Idempotent booking lookup failed");
      return {
        id: existing[0].id,
        duplicate: true,
        notificationOutboxIds: null,
      };
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
      insert into service_location_assessments
        (booking_id, organization_id, address_fingerprint,
         branch_origin_label, branch_origin_latitude, branch_origin_longitude,
         property_latitude, property_longitude, distance_miles,
         standard_radius_miles, calculation_method, assessment_status,
         provider, provider_resolved_address, provider_match_confidence,
         provider_coordinate_accuracy, calculated_at, is_dev_seed)
      select ${booking.id}, private.lakeandpine_intake_organization_id(),
        ${input.routeAssessment.addressFingerprint},
        ${input.routeAssessment.branchOriginLabel},
        ${input.routeAssessment.branchOriginLatitude},
        ${input.routeAssessment.branchOriginLongitude},
        ${input.routeAssessment.propertyLatitude},
        ${input.routeAssessment.propertyLongitude},
        ${input.routeAssessment.distanceMiles},
        ${input.routeAssessment.standardRadiusMiles},
        ${input.routeAssessment.calculationMethod},
        ${input.routeAssessment.assessmentStatus},
        ${input.routeAssessment.provider},
        ${input.routeAssessment.providerResolvedAddress},
        ${input.routeAssessment.providerMatchConfidence},
        ${input.routeAssessment.providerCoordinateAccuracy},
        ${input.routeAssessment.calculatedAt}, ${input.isDevSeed}`;

    const enqueued = await tx<
      {
        customer_notification_id: string | null;
        ops_notification_id: string | null;
      }[]
    >`
      select * from private.enqueue_booking_intake_notifications(${booking.id})`;
    if (
      !enqueued[0]?.customer_notification_id ||
      !enqueued[0].ops_notification_id
    ) {
      throw new Error("Booking notifications were not durably queued");
    }

    return {
      id: booking.id,
      duplicate: false,
      notificationOutboxIds: {
        customer: enqueued[0].customer_notification_id,
        ops: enqueued[0].ops_notification_id,
      },
    };
  });
}

export async function getRuntimeDatabaseName() {
  const rows = await sql<{ database_name: string }[]>`
    select current_database() as database_name`;
  if (!rows[0]) throw new Error("Runtime database identity is unavailable");
  return rows[0].database_name;
}

export async function updateUnallocatedBookingRouteAssessment(
  bookingId: string,
  assessment: RouteAssessmentInput,
) {
  const rows = await sql<{ id: string }[]>`
    select private.enrich_unallocated_service_location_assessment(
      ${bookingId}::uuid,
      ${assessment.addressFingerprint}::text,
      ${assessment.branchOriginLabel}::text,
      ${assessment.branchOriginLatitude}::double precision,
      ${assessment.branchOriginLongitude}::double precision,
      ${assessment.propertyLatitude}::double precision,
      ${assessment.propertyLongitude}::double precision,
      ${assessment.distanceMiles}::double precision,
      ${assessment.standardRadiusMiles}::double precision,
      ${assessment.calculationMethod}::text,
      ${assessment.assessmentStatus}::text,
      ${assessment.provider}::text,
      ${assessment.providerResolvedAddress}::text,
      ${assessment.providerMatchConfidence}::text,
      ${assessment.providerCoordinateAccuracy}::text,
      ${assessment.calculatedAt}::timestamptz
    ) as id`;
  if (!rows[0]) {
    throw new Error("Booking route assessment is no longer safe to update");
  }
}

export async function recordBookingNotificationDelivery(
  outboxId: string,
  bookingId: string,
  notificationType: "customer_confirmation" | "ops_notification",
  outcome: "sent" | "suppressed" | "skipped" | "failed",
) {
  const rows = await sql<{ finished: boolean }[]>`
    select private.finish_initial_booking_notification_delivery(
      ${outboxId}, ${bookingId}, ${notificationType}, ${outcome}
    ) as finished`;
  if (!rows[0]?.finished) {
    throw new Error("Booking notification is no longer pending delivery");
  }
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
  if (!clerkUserId) return null;
  const rows = await sql<Customer[]>`
    select * from private.customer_identity_by_clerk_id(${clerkUserId}::text)`;
  return rows[0] ?? null;
}

export async function getCustomerByEmail(
  email: string,
): Promise<Customer | null> {
  const verifiedEmail = email.trim().toLowerCase();
  if (!verifiedEmail) return null;
  const rows = await sql<Customer[]>`
    select * from private.customer_identity_by_verified_email(${verifiedEmail}::text)`;
  return rows[0] ?? null;
}

export async function upsertCustomerFromClerk(input: {
  clerkUserId: string;
  verifiedEmail: string | null;
  fullName: string | null;
  phone: string | null;
}): Promise<Customer> {
  const verifiedEmail = input.verifiedEmail?.trim().toLowerCase() || null;
  const rows = await sql<Customer[]>`
    select *
    from private.upsert_customer_from_verified_clerk_identity(
      ${input.clerkUserId}::text,
      ${verifiedEmail}::text,
      ${input.fullName}::text,
      ${input.phone}::text
    )`;
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
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${customerId}, true
    )`;
    return transaction<BookingRow[]>`
      select b.id, b.service_id, s.title as service_title, b.addon_ids, b.frequency,
             to_char(b.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
             b.scheduled_window, b.status, b.estimate_cents, b.access_notes, b.created_at::text
      from bookings b join services s on s.id = b.service_id
      where b.customer_id = ${customerId}
      order by b.scheduled_date desc`;
  });
}

export async function getNextBooking(
  customerId: string,
): Promise<BookingRow | null> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${customerId}, true
    )`;
    const rows = await transaction<BookingRow[]>`
      select b.id, b.service_id, s.title as service_title, b.addon_ids, b.frequency,
             to_char(b.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
             b.scheduled_window, b.status, b.estimate_cents, b.access_notes, b.created_at::text
      from bookings b join services s on s.id = b.service_id
      where b.customer_id = ${customerId}
        and b.status in ('requested', 'reviewing', 'ready', 'confirmed', 'scheduled', 'in_progress')
        and b.scheduled_date >= current_date
      order by b.scheduled_date asc
      limit 1`;
    return rows[0] ?? null;
  });
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
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${customerId}, true
    )`;
    const rows = await transaction<Home[]>`
      select id, label, city, zip, preference_tags, cleaner_notes
      from homes
      where customer_id = ${customerId}
      order by created_at asc
      limit 1`;
    return rows[0] ?? null;
  });
}

export async function saveHomeNotes(
  homeId: string,
  customerId: string,
  cleanerNotes: string,
): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${customerId}, true
    )`;
    await transaction`
      update homes
      set cleaner_notes = ${cleanerNotes}
      where id = ${homeId} and customer_id = ${customerId}`;
  });
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
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${customerId}, true
    )`;
    return transaction<BillingRecord[]>`
      select id, description, amount_cents, status, occurred_at::text
      from private.current_customer_billing_history()
      order by occurred_at desc`;
  });
}

export type SupportMessage = {
  id: number;
  sender: string;
  body: string;
  created_at: string;
};

export type CustomerServiceCase = {
  id: string;
  public_reference: string;
  case_type: string;
  status: string;
  priority: string;
  details: string;
  resolution_summary: string | null;
  created_at: string;
};

export async function getCustomerServiceCases(
  customerId: string,
): Promise<CustomerServiceCase[]> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${customerId}, true
    )`;
    return transaction<CustomerServiceCase[]>`
      select id, public_reference, case_type, status, priority, details,
             resolution_summary, created_at::text
      from service_cases
      where customer_id = ${customerId}
        or booking_id in (
          select id from bookings where customer_id = ${customerId}
        )
      order by created_at desc
      limit 30`;
  });
}

export async function getSupportThread(
  customerId: string,
): Promise<SupportMessage[]> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${customerId}, true
    )`;
    return transaction<SupportMessage[]>`
      select id, sender, body, created_at::text
      from support_messages
      where customer_id = ${customerId}
      order by created_at asc`;
  });
}

export async function addSupportMessage(
  customerId: string,
  sender: "customer" | "staff" | "concierge",
  body: string,
): Promise<void> {
  // A customer request must never be able to choose a privileged-looking
  // sender. Staff and automated acknowledgements need their own audited,
  // server-authorized write path instead of sharing this customer mutation.
  if (sender !== "customer") {
    throw new Error("Customer support messages cannot impersonate staff");
  }
  await sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${customerId}, true
    )`;
    await transaction`
      insert into support_messages (customer_id, sender, body)
      values (${customerId}, 'customer', ${body})`;
  });
}

export async function appendServiceCaseCustomerAcknowledgement(
  customerId: string,
  serviceCaseId: string,
): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${customerId}, true
    )`;
    await transaction`
      select private.append_service_case_customer_acknowledgement(
        ${serviceCaseId}::uuid
      )`;
  });
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
  service_vertical: string | null;
  territory_timezone: string;
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
  operatorCustomerId: string,
): Promise<OperatorBooking[]> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${operatorCustomerId}, true
    )`;
    return transaction<OperatorBooking[]>`
      select b.id, b.service_id, s.title as service_title, b.addon_ids, b.frequency,
             to_char(b.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
             b.scheduled_window, b.status, b.estimate_cents, b.access_notes,
             b.created_at::text, b.contact, b.home_details, b.property_profile,
             b.room_plan, b.cleaning_preferences, b.pet_notes, b.special_instructions,
              b.planning_direction, b.planning_score, b.contact_status,
              b.service_vertical,
              coalesce(territory.timezone, 'America/Los_Angeles') as territory_timezone,
              b.is_dev_seed
      from bookings b join services s on s.id = b.service_id
      left join service_territories territory on territory.id = b.territory_id
      where ${devOnly ? transaction`b.is_dev_seed` : transaction`true`}
        and b.status <> 'canceled'
      order by b.scheduled_date asc, b.created_at asc`;
  });
}

export async function getBookingChecklist(
  bookingId: string,
  devOnly: boolean,
  operatorCustomerId: string,
): Promise<ChecklistItem[]> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${operatorCustomerId}, true
    )`;
    return transaction<ChecklistItem[]>`
      select c.id, c.room_label, c.label, c.state, c.sort
      from checklist_items c join bookings b on b.id = c.booking_id
      where c.booking_id = ${bookingId}
        and ${devOnly ? transaction`b.is_dev_seed` : transaction`true`}
      order by c.sort, c.created_at`;
  });
}

export async function getBookingInternalNotes(
  bookingId: string,
  devOnly: boolean,
  operatorCustomerId: string,
): Promise<InternalNote[]> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${operatorCustomerId}, true
    )`;
    return transaction<InternalNote[]>`
      select n.id, n.author_label, n.body, n.created_at::text
      from internal_notes n join bookings b on b.id = n.booking_id
      where n.booking_id = ${bookingId}
        and ${devOnly ? transaction`b.is_dev_seed` : transaction`true`}
      order by n.created_at desc`;
  });
}

export async function getBookingFollowUps(
  bookingId: string,
  devOnly: boolean,
  operatorCustomerId: string,
): Promise<FollowUp[]> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${operatorCustomerId}, true
    )`;
    return transaction<FollowUp[]>`
      select f.id, f.kind, f.channel, f.status, f.scheduled_for::text
      from follow_ups f join bookings b on b.id = f.booking_id
      where f.booking_id = ${bookingId}
        and ${devOnly ? transaction`b.is_dev_seed` : transaction`true`}
      order by f.scheduled_for nulls last, f.created_at`;
  });
}

export async function updateBookingStatus(
  bookingId: string,
  fromStatus: JobStatus,
  toStatus: JobStatus,
  devOnly: boolean,
  operatorCustomerId: string,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await tx`select set_config(
      'lakeandpine.current_customer_id', ${operatorCustomerId}, true
    )`;
    // Premium work is schedule-authoritative. Its booking status is synchronized
    // by database trigger after crew-capacity validation, never from this legacy
    // planning workspace.
    const rows = await tx<{ id: string }[]>`
      update bookings set status = ${toStatus}
      where id = ${bookingId} and status = ${fromStatus}
        and service_vertical is null
        and ${devOnly ? tx`is_dev_seed` : tx`true`}
      returning id`;
    if (!rows[0]) return false;

    if (toStatus === "completed") {
      await tx`
        insert into follow_ups (booking_id, kind, scheduled_for)
        select ${bookingId}, task.kind, task.scheduled_for
        from bookings b
        cross join (values
          ('service_check_in'::text, now() + interval '2 hours'),
          ('review_request'::text, now() + interval '1 day')
        ) as task(kind, scheduled_for)
        where b.id = ${bookingId}
        on conflict (booking_id, kind) do nothing`;
    }
    return true;
  });
}

export async function setChecklistItemState(
  bookingId: string,
  itemId: string,
  state: ChecklistItem["state"],
  devOnly: boolean,
  operatorCustomerId: string,
): Promise<boolean> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${operatorCustomerId}, true
    )`;
    const rows = await transaction<{ id: string }[]>`
      update checklist_items c
      set state = ${state},
          completed_at = case when ${state} = 'completed' then now() else null end
      from bookings b
      where c.id = ${itemId} and c.booking_id = ${bookingId}
        and b.id = c.booking_id
        and ${devOnly ? transaction`b.is_dev_seed` : transaction`true`}
      returning c.id`;
    return Boolean(rows[0]);
  });
}

export async function addInternalNote(
  bookingId: string,
  body: string,
  devOnly: boolean,
  operatorCustomerId: string,
): Promise<boolean> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${operatorCustomerId}, true
    )`;
    const rows = await transaction<{ id: string }[]>`
      select id from bookings
      where id = ${bookingId}
        and ${devOnly ? transaction`is_dev_seed` : transaction`true`}`;
    if (!rows[0]) return false;
    await transaction`
      insert into internal_notes (booking_id, body)
      values (${bookingId}, ${body})`;
    return true;
  });
}

export async function completeFollowUp(
  bookingId: string,
  followUpId: string,
  devOnly: boolean,
  operatorCustomerId: string,
): Promise<boolean> {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${operatorCustomerId}, true
    )`;
    const rows = await transaction<{ id: string }[]>`
      update follow_ups f set status = 'completed'
      from bookings b
      where f.id = ${followUpId} and f.booking_id = ${bookingId}
        and b.id = f.booking_id
        and ${devOnly ? transaction`b.is_dev_seed` : transaction`true`}
      returning f.id`;
    return Boolean(rows[0]);
  });
}
