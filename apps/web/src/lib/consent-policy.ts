export const REQUEST_CONSENT_POLICY_VERSION = "2026-07-13";
export const PRIVACY_NOTICE_DATE = "2026-07-13";

export type BookingAcknowledgements = {
  privacyConsent: boolean;
  termsConsent: boolean;
  siteReady: boolean;
  photoPermission: boolean;
};

export function buildBookingConsentRecord(
  acknowledgements: BookingAcknowledgements,
) {
  return {
    snapshot: {
      privacy: acknowledgements.privacyConsent,
      requestTerms: acknowledgements.termsConsent,
      siteReadiness: acknowledgements.siteReady,
      photoPermission: acknowledgements.photoPermission,
      policyVersion: REQUEST_CONSENT_POLICY_VERSION,
      privacyNoticeDate: PRIVACY_NOTICE_DATE,
    },
    version: REQUEST_CONSENT_POLICY_VERSION,
    noticeDate: PRIVACY_NOTICE_DATE,
  } as const;
}
