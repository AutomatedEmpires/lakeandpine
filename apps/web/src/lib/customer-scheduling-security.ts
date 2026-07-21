import "server-only";

import { createHash, createHmac } from "node:crypto";

import type {
  ReservationRequestInput,
  SchedulingScopeInput,
} from "./customer-scheduling-contract";
import { requireEnv } from "./env";

function schedulingSecret() {
  const secret = requireEnv("CUSTOMER_SCHEDULING_SECRET");
  if (secret.length < 32) {
    throw new Error("CUSTOMER_SCHEDULING_SECRET must contain at least 32 characters");
  }
  return secret;
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function schedulingScopeDigest(scope: SchedulingScopeInput) {
  return sha256(
    JSON.stringify([
      scope.program,
      scope.postalCode.trim().toUpperCase().replace(/\s+/g, ""),
      scope.context,
      scope.sizeBand,
      scope.condition,
      scope.cadence,
      scope.zoneCount,
      scope.siteReady,
      scope.accessComplex,
      scope.finishSensitive,
      scope.finishRestrictionsAcknowledged,
    ]),
  );
}

export function derivePublicSlotId(input: {
  policyId: string;
  policyVersion: number;
  start: string;
  end: string;
  scope: SchedulingScopeInput;
}) {
  return createHmac("sha256", schedulingSecret())
    .update(
      [
        "lake-and-pine-slot-v1",
        input.policyId,
        input.policyVersion,
        input.start,
        input.end,
        schedulingScopeDigest(input.scope),
      ].join("\n"),
    )
    .digest("base64url");
}

export function reservationRequestDigest(input: ReservationRequestInput) {
  return sha256(
    JSON.stringify([
      schedulingScopeDigest(input.scope),
      input.slotId,
      input.contact.name.trim(),
      input.contact.email.trim().toLowerCase(),
      input.contact.phone.trim(),
      input.acknowledgements.privacyConsent,
      input.acknowledgements.termsConsent,
      input.acknowledgements.siteReady,
    ]),
  );
}

export function deriveGuestManagementToken(
  bookingId: string,
  idempotencyKeyHash: string,
) {
  const digest = createHmac("sha256", schedulingSecret())
    .update(`lake-and-pine-guest-management-v1\n${bookingId}\n${idempotencyKeyHash}`)
    .digest("base64url");
  return `lp_manage_${digest}`;
}

export function guestManagementTokenDigest(token: string) {
  return sha256(token);
}
