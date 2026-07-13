import assert from "node:assert/strict";
import test from "node:test";

import { deriveBookingReference, hashBookingReference } from "./booking-reference.ts";

const secret = "test-only-booking-reference-secret-32-characters";
const bookingId = "3f03c81f-d47b-45ca-b357-23b2a957fdc1";

test("booking references are stable, compact, and secret-dependent", () => {
  const reference = deriveBookingReference(bookingId, secret);
  assert.match(reference, /^LP-[A-F0-9]{5}(?:-[A-F0-9]{5}){3}$/);
  assert.equal(reference, deriveBookingReference(bookingId, secret));
  assert.notEqual(reference, deriveBookingReference(bookingId, `${secret}-different`));
});

test("reference matching is case-insensitive and whitespace-tolerant", () => {
  const reference = deriveBookingReference(bookingId, secret);
  assert.equal(hashBookingReference(reference), hashBookingReference(`  ${reference.toLowerCase()}  `));
});
