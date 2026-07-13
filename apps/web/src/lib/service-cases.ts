import "server-only";

import { createHash, randomBytes } from "node:crypto";

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

export type ServiceCaseType = (typeof SERVICE_CASE_TYPES)[number];

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
    const existing = await transaction<{ id: string; public_reference: string }[]>`
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
      const bookings = await transaction<{ id: string }[]>`
        select id
        from bookings
        where public_reference_token_hash = ${sha256(normalizedReference)}
          and lower(contact ->> 'email') = lower(${input.email})
        limit 1`;
      bookingId = bookings[0]?.id ?? null;
    }

    const reference = publicReference();
    const rows = await transaction<{ id: string; public_reference: string }[]>`
      insert into service_cases
        (public_reference, idempotency_key, case_type, booking_id,
         booking_reference_input, contact, details, preferred_date, alternate_date,
         status, consent_snapshot, consented_at)
      values
        (${reference}, ${sha256(input.idempotencyKey)}, ${input.caseType}, ${bookingId},
         ${normalizedReference}, ${transaction.json({
           name: input.name,
           email: input.email,
           phone: input.phone || null,
         })}, ${input.details}, ${input.preferredDate || null}, ${input.alternateDate || null},
         'submitted', ${transaction.json({ privacy: true, version: "2026-07-13" })}, now())
      returning id, public_reference`;

    const serviceCase = rows[0];
    await transaction`
      insert into service_case_events (service_case_id, event_type, event_data)
      values (
        ${serviceCase.id},
        'submitted',
        ${transaction.json({ source: "public_service_desk", linkedBooking: Boolean(bookingId) })}
      )`;

    return { id: serviceCase.id, reference: serviceCase.public_reference, duplicate: false };
  });
}
