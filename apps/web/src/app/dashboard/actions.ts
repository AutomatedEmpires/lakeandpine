"use server";

import { revalidatePath } from "next/cache";

import { resolveDashboardIdentity } from "@/lib/auth";
import { addSupportMessage, requestReschedule, saveHomeNotes } from "@/lib/data";
import { requestIntakeEnabled } from "@/lib/env";

async function requireCustomer() {
  if (!requestIntakeEnabled) throw new Error("Customer-data intake is disabled");
  const identity = await resolveDashboardIdentity();
  if (identity.state === "signed_out") {
    throw new Error("Not signed in");
  }
  return identity.customer;
}

export async function saveNotesAction(formData: FormData) {
  const customer = await requireCustomer();
  const homeId = String(formData.get("homeId") ?? "");
  const notes = String(formData.get("notes") ?? "").slice(0, 4000);
  if (!homeId) return;
  await saveHomeNotes(homeId, customer.id, notes);
  revalidatePath("/dashboard");
}

export async function supportMessageAction(formData: FormData) {
  const customer = await requireCustomer();
  const body = String(formData.get("body") ?? "").trim().slice(0, 4000);
  if (!body) return;
  await addSupportMessage(customer.id, "customer", body);
  revalidatePath("/dashboard");
}

export async function rescheduleAction(formData: FormData) {
  const customer = await requireCustomer();
  const bookingId = String(formData.get("bookingId") ?? "");
  if (!bookingId) return;
  await requestReschedule(
    bookingId,
    customer.id,
    "Customer requested a reschedule from the dashboard.",
  );
  await addSupportMessage(
    customer.id,
    "concierge",
    "Got it — your reschedule request is in. We'll text you new window options shortly.",
  );
  revalidatePath("/dashboard");
}
