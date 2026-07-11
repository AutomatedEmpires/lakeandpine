import "server-only";

import { auth, currentUser } from "@clerk/nextjs/server";

import { type Customer, getCustomerByClerkId, getCustomerByEmail, upsertCustomerFromClerk } from "./data";
import { authEnabled, optionalEnv } from "./env";

export type DashboardIdentity =
  | { state: "authed"; customer: Customer }
  | { state: "preview"; customer: Customer }
  | { state: "signed_out" };

// Resolves who the dashboard belongs to.
// - Clerk configured: the signed-in user (customer row created on first visit).
// - Clerk absent outside production: the seeded dev-preview customer, clearly
//   labeled as preview. Never active in production builds.
export async function resolveDashboardIdentity(): Promise<DashboardIdentity> {
  if (authEnabled) {
    const { userId } = await auth();
    if (!userId) return { state: "signed_out" };
    let customer = await getCustomerByClerkId(userId);
    if (!customer) {
      const user = await currentUser();
      customer = await upsertCustomerFromClerk({
        clerkUserId: userId,
        email: user?.primaryEmailAddress?.emailAddress ?? null,
        fullName: user?.fullName ?? null,
        phone: user?.primaryPhoneNumber?.phoneNumber ?? null,
      });
    }
    return { state: "authed", customer };
  }

  const previewEmail = optionalEnv("DEV_PREVIEW_CUSTOMER_EMAIL");
  if (previewEmail && process.env.NODE_ENV !== "production") {
    const customer = await getCustomerByEmail(previewEmail);
    if (customer) return { state: "preview", customer };
  }
  return { state: "signed_out" };
}
