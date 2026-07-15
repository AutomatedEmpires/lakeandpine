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
  const rows = await sql<
    { public_reference: string | null; duplicate: boolean | null }[]
  >`
    select * from private.create_public_cleaner_application(
      ${sha256(input.idempotencyKey)}, ${publicReference()}, ${input.fullName},
      ${input.email}, ${input.phone}, ${input.homeBase}, ${input.servicePrograms},
      ${input.territories}, ${input.availabilitySummary}, ${input.experienceSummary},
      ${input.transportationConfirmed},
      ${sql.json({
        privacy: true,
        policyVersion: REQUEST_CONSENT_POLICY_VERSION,
        privacyNoticeDate: PRIVACY_NOTICE_DATE,
      })}
    )`;
  const application = rows[0];
  if (!application?.public_reference || typeof application.duplicate !== "boolean") {
    throw new Error("Cleaner application intake did not return a durable record");
  }
  return {
    reference: application.public_reference,
    duplicate: application.duplicate,
  };
}
