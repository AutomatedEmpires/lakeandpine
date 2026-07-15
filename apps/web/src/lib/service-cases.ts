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
): Promise<{
  id: string;
  reference: string;
  duplicate: boolean;
  notificationOutboxId: string | null;
}> {
  return sql.begin(async (transaction) => {
    const idempotencyHash = sha256(input.idempotencyKey);
    const normalizedReference = input.bookingReference?.trim() || null;
    const reference = publicReference();
    const rows = await transaction<Array<{
      service_case_id: string | null;
      case_reference: string | null;
      duplicate: boolean;
      outcome: string;
      notification_outbox_id: string | null;
    }>>`
      select * from private.create_public_service_case(
        ${idempotencyHash}, ${input.caseType},
        ${normalizedReference ? hashBookingReference(normalizedReference) : null},
        ${reference},
        ${transaction.json({
          name: input.name,
          email: input.email,
          phone: input.phone || null,
        })},
        ${input.details}, ${input.preferredDate || null},
        ${input.alternateDate || null},
        ${transaction.json({
          privacy: true,
          policyVersion: REQUEST_CONSENT_POLICY_VERSION,
          privacyNoticeDate: PRIVACY_NOTICE_DATE,
        })}
      )`;
    const serviceCase = rows[0];
    if (serviceCase?.outcome === "invalid_reference") {
      throw new ServiceCaseBookingReferenceError(
        "Booking-linked service case could not be verified",
      );
    }
    if (serviceCase?.outcome === "invalid_lifecycle") {
      throw new ServiceCaseBookingLifecycleError(
        "Booking is no longer eligible for a schedule mutation",
      );
    }
    if (
      !serviceCase?.service_case_id ||
      !serviceCase.case_reference ||
      (!serviceCase.duplicate && !serviceCase.notification_outbox_id)
    ) {
      throw new Error("Service-case intake did not return a durable record");
    }
    return {
      id: serviceCase.service_case_id,
      reference: serviceCase.case_reference,
      duplicate: serviceCase.duplicate,
      notificationOutboxId: serviceCase.notification_outbox_id,
    };
  });
}

export async function createCustomerRescheduleCase(customerId: string, bookingId: string) {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${customerId}, true
    )`;
    const bookings = await transaction<
      {
        id: string;
        contact: postgres.JSONValue;
        is_dev_seed: boolean;
        schedule_status: string | null;
      }[]
    >`
      select booking.id, booking.contact, booking.is_dev_seed,
        schedule.status as schedule_status
      from bookings booking
      left join job_schedules schedule on schedule.booking_id = booking.id
      where booking.id = ${bookingId} and booking.customer_id = ${customerId}
        and booking.status in ('requested', 'reviewing', 'ready', 'confirmed', 'scheduled')
      limit 1 for update of booking`;
    if (
      !bookings[0] ||
      (bookings[0].schedule_status !== null &&
        !["tentative", "held", "confirmed"].includes(
          bookings[0].schedule_status,
        ))
    ) {
      throw new Error("Booking is not eligible for reschedule review");
    }
    await transaction`
      select pg_advisory_xact_lock(
        hashtextextended(${'active-reschedule:' + bookingId}, 9403)
      )`;

    const existing = await transaction<{ id: string; public_reference: string }[]>`
      select id, public_reference from service_cases
      where customer_id = ${customerId} and booking_id = ${bookingId}
        and case_type = 'reschedule'
        and status not in ('resolved', 'closed', 'declined', 'canceled')
      order by created_at desc limit 1`;
    if (existing[0]) {
      return {
        ...existing[0],
        duplicate: true,
        notificationOutboxId: null,
      };
    }
    const rows = await transaction<{ id: string; public_reference: string }[]>`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, contact, details,
         status, consent_snapshot, consented_at)
      values (${publicReference()}, 'reschedule', ${bookingId}, ${customerId},
        ${transaction.json(bookings[0].contact)},
        'Customer requested a reschedule from the authenticated dashboard.',
        'submitted', ${transaction.json({ source: "authenticated_dashboard_action" })}, now())
      returning id, public_reference`;
    const enqueued = await transaction<
      { notification_outbox_id: string | null }[]
    >`
      select private.enqueue_service_case_ops_notification(
        ${rows[0].id}
      ) as notification_outbox_id`;
    if (!enqueued[0]?.notification_outbox_id) {
      throw new Error("Service-case notification could not be queued");
    }
    return {
      ...rows[0],
      duplicate: false,
      notificationOutboxId: enqueued[0].notification_outbox_id,
    };
  });
}

export async function createAuthenticatedServiceCase(input: {
  idempotencyKey: string;
  customerId: string;
  bookingId: string | null;
  caseType: ServiceCaseType;
  details: string;
}) {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config(
      'lakeandpine.current_customer_id', ${input.customerId}, true
    )`;
    const rows = await transaction<
      {
        service_case_id: string;
        case_reference: string;
        duplicate: boolean;
        notification_outbox_id: string | null;
      }[]
    >`
      select * from private.create_authenticated_service_case(
        ${sha256(
          `authenticated-service-case:${input.customerId}:${input.idempotencyKey}`,
        )},
        ${publicReference()}, ${input.customerId}, ${input.bookingId},
        ${input.caseType}, ${input.details}
      )`;
    if (
      !rows[0]?.service_case_id ||
      !rows[0].case_reference ||
      (!rows[0].duplicate && !rows[0].notification_outbox_id)
    ) {
      throw new Error("Authenticated service-case intake did not return a durable record");
    }
    return {
      id: rows[0].service_case_id,
      public_reference: rows[0].case_reference,
      duplicate: rows[0].duplicate,
      notificationOutboxId: rows[0].notification_outbox_id,
    };
  });
}

export async function recordServiceCaseNotificationDelivery(
  outboxId: string,
  serviceCaseId: string,
  outcome: "sent" | "suppressed" | "skipped" | "failed",
) {
  const rows = await sql<{ finished: boolean }[]>`
    select private.finish_initial_service_case_notification_delivery(
      ${outboxId}, ${serviceCaseId}, ${outcome}
    ) as finished`;
  if (!rows[0]?.finished) {
    throw new Error("Service-case notification is no longer pending delivery");
  }
}
