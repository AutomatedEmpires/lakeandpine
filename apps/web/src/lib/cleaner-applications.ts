import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { PRIVACY_NOTICE_DATE, REQUEST_CONSENT_POLICY_VERSION } from "./consent-policy";
import { sql } from "./db";

export type CleanerApplicationInput = {
  idempotencyKey: string;
  fullName: string;
  email: string;
  phone: string;
  homeBase: string;
  servicePrograms: string[];
  territories: string[];
  availabilitySummary: string;
  experienceSummary: string;
  transportationConfirmed: boolean;
};

function publicReference() {
  return `TEAM-${randomBytes(5).toString("hex").toUpperCase()}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function createCleanerApplication(
  input: CleanerApplicationInput,
): Promise<{ reference: string; duplicate: boolean }> {
  const existing = await sql<{ public_reference: string }[]>`
    select public_reference
    from cleaner_applications
    where idempotency_key = ${sha256(input.idempotencyKey)}
    limit 1`;
  if (existing[0]) return { reference: existing[0].public_reference, duplicate: true };

  const rows = await sql<{ public_reference: string }[]>`
    insert into cleaner_applications
      (public_reference, idempotency_key, status, full_name, email, phone, home_base,
       service_interests, territory_interests, availability_summary, experience_summary,
       transportation_confirmed, consent_snapshot, consented_at)
    values
      (${publicReference()}, ${sha256(input.idempotencyKey)}, 'submitted', ${input.fullName},
       ${input.email}, ${input.phone}, ${input.homeBase}, ${input.servicePrograms},
       ${input.territories}, ${input.availabilitySummary}, ${input.experienceSummary},
       ${input.transportationConfirmed},
       ${sql.json({
         privacy: true,
         policyVersion: REQUEST_CONSENT_POLICY_VERSION,
         privacyNoticeDate: PRIVACY_NOTICE_DATE,
       })}, now())
    returning public_reference`;
  return { reference: rows[0].public_reference, duplicate: false };
}
