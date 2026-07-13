import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeVerifiedClerkEmail,
  selectVerifiedPrimaryClerkEmail,
} from "./clerk-identity.ts";

test("normalizes only Clerk-verified email addresses", () => {
  assert.equal(
    normalizeVerifiedClerkEmail("  Owner@Example.com ", "verified"),
    "owner@example.com",
  );
  assert.equal(
    normalizeVerifiedClerkEmail("owner@example.com", "unverified"),
    null,
  );
  assert.equal(normalizeVerifiedClerkEmail("owner@example.com", null), null);
});

test("selects only the verified primary Clerk email", () => {
  const addresses = [
    {
      id: "secondary",
      emailAddress: "verified-secondary@example.com",
      verificationStatus: "verified",
    },
    {
      id: "primary",
      emailAddress: "primary@example.com",
      verificationStatus: "unverified",
    },
  ];

  assert.equal(
    selectVerifiedPrimaryClerkEmail(addresses, "primary"),
    null,
  );
  assert.equal(
    selectVerifiedPrimaryClerkEmail(addresses, "secondary"),
    "verified-secondary@example.com",
  );
  assert.equal(selectVerifiedPrimaryClerkEmail(addresses, null), null);
});
