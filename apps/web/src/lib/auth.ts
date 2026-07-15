import "server-only";

import { auth, currentUser } from "@clerk/nextjs/server";

import { normalizeVerifiedClerkEmail } from "./clerk-identity";
import { type Customer, getCustomerByClerkId, getCustomerByEmail, upsertCustomerFromClerk } from "./data";
import {
  type Cleaner,
  getCleanerByEmail,
  getCleanerByExternalAuthId,
  linkCleanerExternalAuthIdByVerifiedEmail,
} from "./crew-data";
import { authEnabled, crewPortalEnabled, optionalEnv } from "./env";

export type DashboardIdentity =
  | { state: "authed"; customer: Customer; devOnly: false }
  | { state: "preview"; customer: Customer; devOnly: true }
  | { state: "signed_out" };

export type OperatorIdentity =
  | { state: "authed"; operator: Customer; devOnly: false }
  | { state: "preview"; operator: Customer; devOnly: true }
  | { state: "denied" | "signed_out" };

export type CleanerIdentity =
  | { state: "authed"; cleaner: Cleaner; devOnly: false }
  | { state: "preview"; cleaner: Cleaner; devOnly: true }
  | { state: "denied" | "signed_out" };

// Resolves who the dashboard belongs to.
// - Clerk configured: the signed-in user (customer row created on first visit).
// - Clerk absent outside production: the seeded dev-preview customer, clearly
//   labeled as preview. Never active in production builds.
export async function resolveDashboardIdentity(): Promise<DashboardIdentity> {
  if (authEnabled) {
    const { userId } = await auth();
    if (!userId) return { state: "signed_out" };
    let customer = await getCustomerByClerkId(userId);
    if (!customer?.email) {
      const user = await currentUser();
      const verifiedEmail = normalizeVerifiedClerkEmail(
        user?.primaryEmailAddress?.emailAddress,
        user?.primaryEmailAddress?.verification?.status,
      );
      customer = await upsertCustomerFromClerk({
        clerkUserId: userId,
        verifiedEmail,
        fullName: user?.fullName ?? null,
        phone: user?.primaryPhoneNumber?.phoneNumber ?? null,
      });
    }
    return { state: "authed", customer, devOnly: false };
  }

  const previewEmail = optionalEnv("DEV_PREVIEW_CUSTOMER_EMAIL");
  if (previewEmail && process.env.NODE_ENV !== "production") {
    const customer = await getCustomerByEmail(previewEmail);
    if (customer) return { state: "preview", customer, devOnly: true };
  }
  return { state: "signed_out" };
}

export async function resolveOperatorIdentity(): Promise<OperatorIdentity> {
  if (authEnabled) {
    const { userId } = await auth();
    if (!userId) return { state: "signed_out" };
    const operator = await getCustomerByClerkId(userId);
    if (!operator || operator.role !== "staff") return { state: "denied" };
    return { state: "authed", operator, devOnly: false };
  }

  const previewEmail = optionalEnv("DEV_PREVIEW_OPERATOR_EMAIL");
  if (previewEmail && process.env.NODE_ENV !== "production") {
    const operator = await getCustomerByEmail(previewEmail);
    if (operator?.role === "staff") return { state: "preview", operator, devOnly: true };
  }
  return { state: "signed_out" };
}

export async function resolveCleanerIdentity(): Promise<CleanerIdentity> {
  if (!crewPortalEnabled) return { state: "signed_out" };
  if (authEnabled) {
    const { userId } = await auth();
    if (!userId) return { state: "signed_out" };
    let cleaner = await getCleanerByExternalAuthId(userId);
    if (!cleaner) {
      const user = await currentUser();
      const verifiedEmail = normalizeVerifiedClerkEmail(
        user?.primaryEmailAddress?.emailAddress,
        user?.primaryEmailAddress?.verification?.status,
      );
      if (verifiedEmail) {
        const linked = await linkCleanerExternalAuthIdByVerifiedEmail(
          userId,
          verifiedEmail,
        );
        if (linked) cleaner = await getCleanerByExternalAuthId(userId);
      }
    }
    if (!cleaner || !["onboarding", "active"].includes(cleaner.status)) {
      return { state: "denied" };
    }
    return { state: "authed", cleaner, devOnly: false };
  }

  const previewEmail = optionalEnv("DEV_PREVIEW_CLEANER_EMAIL");
  if (previewEmail && process.env.NODE_ENV !== "production") {
    const cleaner = await getCleanerByEmail(previewEmail);
    if (cleaner?.is_dev_seed) return { state: "preview", cleaner, devOnly: true };
  }
  return { state: "signed_out" };
}
