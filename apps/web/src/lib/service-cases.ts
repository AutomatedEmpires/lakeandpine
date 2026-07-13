import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";

import { hashBookingReference } from "./booking-reference";
import { PRIVACY_NOTICE_DATE, REQUEST_CONSENT_POLICY_VERSION } from "./consent-policy";
import { sql } from "./db";

export const SERVICE_CASE_TYPES = [
  "reschedule",
  "cancel",
  "complaint",
  "reclean",
  "refund_review",
  "damage",
  "other",
] as const;

export const BOOKING_LINKED_CASE_TYPES: readonly ServiceCaseType[] = [
  "reschedule",
  "cancel",
  "reclean",
  "refund_review",
  "damage",
];

export type ServiceCaseType = (typeof SERVICE_CASE_TYPES)[number];

export class ServiceCaseBookingReferenceError extends Error {}
export class ServiceCaseBookingLifecycleError extends Error {}

const PRE_SERVICE_BOOKING_STATUSES = [
  "requested",
  "reviewing",
  "ready",
  "confirmed",
  "scheduled",
];

export type CreateServiceCaseInput = {
  idempotencyKey: string;
  caseType: ServiceCaseType;
  bookingReference?: string;
  name: string;
  email: string;
  phone?: string;
  preferredDate?: string;
  alternateDate?: string;
  details: string;
};

function publicReference() {
  const date = new Date().toISOString().slice(2, 10).replaceAll("-", "");
  return `LP-${date}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function createServiceCase(
  input: CreateServiceCaseInput,
): Promise<{ id: string; reference: string; duplicate: boolean }> {
  return sql.begin(async (transaction) => {
    const existing = await transaction<
      { id: string; public_reference: string }[]
    >`
      select id, public_reference
      from service_cases
      where idempotency_key = ${sha256(input.idempotencyKey)}
      limit 1`;
    if (existing[0]) {
      return {
        id: existing[0].id,
        reference: existing[0].public_reference,
        duplicate: true,
      };
    }

    let bookingId: string | null = null;
    const normalizedReference = input.bookingReference?.trim() || null;
    if (normalizedReference) {
      const bookings = await transaction<
        { id: string; status: string; schedule_status: string | null }[]
      >`
        select booking.id, booking.status, schedule.status as schedule_status
        from bookings booking
        left join job_schedules schedule on schedule.booking_id = booking.id
        where public_reference_token_hash = ${hashBookingReference(normalizedReference)}
          and lower(booking.contact ->> 'email') = lower(${input.email})
        limit 1`;
      bookingId = bookings[0]?.id ?? null;
      if (
        bookings[0] &&
        ["reschedule", "cancel"].includes(input.caseType) &&
        (!PRE_SERVICE_BOOKING_STATUSES.includes(bookings[0].status) ||
          (bookings[0].schedule_status !== null &&
            !["tentative", "held", "confirmed"].includes(
              bookings[0].schedule_status,
            )))
      ) {
        throw new ServiceCaseBookingLifecycleError(
          "Booking is no longer eligible for a schedule mutation",
        );
      }
    }
    if (
      BOOKING_LINKED_CASE_TYPES.includes(input.caseType) &&
      !bookingId
    ) {
      throw new ServiceCaseBookingReferenceError(
        "Booking-linked service case could not be verified",
      );
    }

    const reference = publicReference();
    const rows = await transaction<{ id: string; public_reference: string }[]>`
      insert into service_cases
        (public_reference, idempotency_key, case_type, booking_id,
         contact, details, preferred_date, alternate_date,
         status, consent_snapshot, consented_at)
      values
        (${reference}, ${sha256(input.idempotencyKey)}, ${input.caseType}, ${bookingId},
         ${transaction.json({
           name: input.name,
           email: input.email,
           phone: input.phone || null,
         })}, ${input.details}, ${input.preferredDate || null}, ${input.alternateDate || null},
         'submitted', ${transaction.json({
           privacy: true,
           policyVersion: REQUEST_CONSENT_POLICY_VERSION,
           privacyNoticeDate: PRIVACY_NOTICE_DATE,
         })}, now())
      returning id, public_reference`;

    const serviceCase = rows[0];
    await transaction`insert into notification_outbox
      (service_case_id, notification_type, channel, recipient_kind, template_key,
       template_data, deduplication_key, is_dev_seed)
      values (${serviceCase.id}, 'ops_notification', 'email', 'ops',
        'ops-service-case', ${transaction.json({ serviceCaseId: serviceCase.id })},
        ${`service-case:${serviceCase.id}:ops_notification`}, false)`;
    return {
      id: serviceCase.id,
      reference: serviceCase.public_reference,
      duplicate: false,
    };
  });
}

export async function createCustomerRescheduleCase(customerId: string, bookingId: string) {
  return sql.begin(async (transaction) => {
    const existing = await transaction<{ id: string; public_reference: string }[]>`
      select id, public_reference from service_cases
      where customer_id = ${customerId} and booking_id = ${bookingId}
        and case_type = 'reschedule'
        and status not in ('resolved', 'closed', 'declined', 'canceled')
      order by created_at desc limit 1`;
    if (existing[0]) return { ...existing[0], duplicate: true };

    const bookings = await transaction<{ id: string; contact: postgres.JSONValue }[]>`
      select id, contact from bookings where id = ${bookingId} and customer_id = ${customerId}
        and status in ('requested', 'reviewing', 'ready', 'confirmed', 'scheduled')
        limit 1`;
    if (!bookings[0]) throw new Error("Booking is not eligible for reschedule review");
    const rows = await transaction<{ id: string; public_reference: string }[]>`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, contact, details,
         status, consent_snapshot, consented_at)
      values (${publicReference()}, 'reschedule', ${bookingId}, ${customerId},
        ${transaction.json(bookings[0].contact)},
        'Customer requested a reschedule from the authenticated dashboard.',
        'submitted', ${transaction.json({ source: "authenticated_dashboard_action" })}, now())
      returning id, public_reference`;
    await transaction`insert into notification_outbox
      (service_case_id, customer_id, notification_type, channel, recipient_kind,
       template_key, template_data, deduplication_key, is_dev_seed)
      values (${rows[0].id}, ${customerId}, 'ops_notification', 'email', 'ops',
        'ops-service-case', ${transaction.json({ serviceCaseId: rows[0].id })},
        ${`service-case:${rows[0].id}:ops_notification`}, false)`;
    return { ...rows[0], duplicate: false };
  });
}

export async function createAuthenticatedServiceCase(input: {
  customerId: string;
  bookingId: string | null;
  caseType: ServiceCaseType;
  details: string;
}) {
  return sql.begin(async (transaction) => {
    const customers = await transaction<
      { email: string | null; full_name: string | null; phone: string | null }[]
    >`
      select email, full_name, phone from customers
      where id = ${input.customerId} for update`;
    if (!customers[0]) throw new Error("Customer account was not found");

    let booking: {
      id: string;
      status: string;
      contact: postgres.JSONValue;
      is_dev_seed: boolean;
    } | null = null;
    if (input.bookingId) {
      const bookings = await transaction<
        {
          id: string;
          status: string;
          contact: postgres.JSONValue;
          is_dev_seed: boolean;
        }[]
      >`
        select id, status, contact, is_dev_seed from bookings
        where id = ${input.bookingId} and customer_id = ${input.customerId}
        for update`;
      booking = bookings[0] ?? null;
      if (!booking) throw new Error("Choose a booking from this account");
    }

    if (
      ["reschedule", "cancel", "reclean", "refund_review", "damage"].includes(
        input.caseType,
      ) &&
      !booking
    ) {
      throw new Error("This request type must be linked to a booking");
    }
    if (
      ["reschedule", "cancel"].includes(input.caseType) &&
      booking &&
      !PRE_SERVICE_BOOKING_STATUSES.includes(booking.status)
    ) {
      throw new Error("That booking is no longer eligible for a schedule change");
    }

    const contact: postgres.JSONValue =
      booking?.contact ??
      ({
        name: customers[0].full_name,
        email: customers[0].email,
        phone: customers[0].phone,
      } as postgres.JSONValue);
    const rows = await transaction<
      { id: string; public_reference: string }[]
    >`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, contact, details,
         status, consent_snapshot, consented_at, first_response_due_at, is_dev_seed)
      values (${publicReference()}, ${input.caseType}, ${booking?.id ?? null},
        ${input.customerId}, ${transaction.json(contact)}, ${input.details}, 'submitted',
        ${transaction.json({ source: "authenticated_dashboard_support" })}, now(),
        now() + interval '4 hours', ${booking?.is_dev_seed ?? false})
      returning id, public_reference`;
    await transaction`
      insert into notification_outbox
        (service_case_id, customer_id, notification_type, channel, recipient_kind,
         template_key, template_data, deduplication_key, is_dev_seed)
      values (${rows[0].id}, ${input.customerId}, 'ops_notification', 'email', 'ops',
        'ops-service-case', ${transaction.json({ serviceCaseId: rows[0].id })},
        ${`service-case:${rows[0].id}:ops_notification`}, ${booking?.is_dev_seed ?? false})`;
    return { ...rows[0], duplicate: false };
  });
}

export async function recordServiceCaseNotificationDelivery(
  serviceCaseId: string,
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
  await sql`update notification_outbox set status = ${status}, attempt_count = attempt_count + 1,
      sent_at = case when ${status} = 'sent' then now() else sent_at end,
      next_attempt_at = case when ${status} = 'retry' then now() + interval '15 minutes' else next_attempt_at end,
      last_error_code = case when ${status} = 'sent' then null else ${outcome} end
    where service_case_id = ${serviceCaseId} and notification_type = 'ops_notification'`;
}
