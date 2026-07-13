import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBookingConsentRecord,
  PRIVACY_NOTICE_DATE,
  REQUEST_CONSENT_POLICY_VERSION,
} from "./consent-policy.ts";

test("booking consent policy metadata is owned by the server", () => {
  const record = buildBookingConsentRecord({
    privacyConsent: true,
    termsConsent: true,
    siteReady: true,
    photoPermission: false,
  });

  assert.equal(record.version, REQUEST_CONSENT_POLICY_VERSION);
  assert.equal(record.noticeDate, PRIVACY_NOTICE_DATE);
  assert.equal(record.snapshot.policyVersion, REQUEST_CONSENT_POLICY_VERSION);
  assert.equal(record.snapshot.privacy, true);
  assert.equal(record.snapshot.photoPermission, false);
});
