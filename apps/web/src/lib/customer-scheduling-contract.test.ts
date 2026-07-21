import assert from "node:assert/strict";
import test from "node:test";

import {
  guestManagementTokenSchema,
  reservationRequestSchema,
} from "./customer-scheduling-contract.ts";

const scope = {
  program: "estate" as const,
  postalCode: "99997",
  context: "primary_home",
  sizeBand: "standard" as const,
  condition: "maintained" as const,
  cadence: "project" as const,
  zoneCount: 6,
  siteReady: true,
  accessComplex: false,
  finishSensitive: false,
  finishRestrictionsAcknowledged: true,
};

test("accepts the minimum server-owned direct reservation contract", () => {
  const parsed = reservationRequestSchema.safeParse({
    scope,
    slotId: "a".repeat(43),
    idempotencyKey: "fb856581-b164-44c3-8d87-64b095980ee1",
    contact: {
      name: "Synthetic Guest",
      email: "guest@example.invalid",
      phone: "+1 208 555 0100",
    },
    acknowledgements: {
      privacyConsent: true,
      termsConsent: true,
      siteReady: true,
    },
  });
  assert.equal(parsed.success, true);
});

test("rejects client attempts to weaken reservation acknowledgements", () => {
  const parsed = reservationRequestSchema.safeParse({
    scope,
    slotId: "a".repeat(43),
    idempotencyKey: "fb856581-b164-44c3-8d87-64b095980ee1",
    contact: {
      name: "Synthetic Guest",
      email: "guest@example.invalid",
      phone: "+1 208 555 0100",
    },
    acknowledgements: {
      privacyConsent: true,
      termsConsent: false,
      siteReady: true,
    },
  });
  assert.equal(parsed.success, false);
});

test("a display booking reference cannot authorize guest management", () => {
  assert.equal(
    guestManagementTokenSchema.safeParse("LP-ABCDE-FGHIJ-KLMNO-PQRST").success,
    false,
  );
  assert.equal(
    guestManagementTokenSchema.safeParse(`lp_manage_${"a".repeat(43)}`).success,
    true,
  );
});
