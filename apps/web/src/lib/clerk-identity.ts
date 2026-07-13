export type ClerkEmailAddress = {
  id: string;
  emailAddress: string;
  verificationStatus: string | null | undefined;
};

export function normalizeVerifiedClerkEmail(
  emailAddress: string | null | undefined,
  verificationStatus: string | null | undefined,
) {
  const normalized = emailAddress?.trim().toLowerCase();
  return verificationStatus === "verified" && normalized ? normalized : null;
}

export function selectVerifiedPrimaryClerkEmail(
  emailAddresses: ClerkEmailAddress[],
  primaryEmailAddressId: string | null | undefined,
) {
  if (!primaryEmailAddressId) return null;
  const primary = emailAddresses.find(
    (address) => address.id === primaryEmailAddressId,
  );
  return normalizeVerifiedClerkEmail(
    primary?.emailAddress,
    primary?.verificationStatus,
  );
}
