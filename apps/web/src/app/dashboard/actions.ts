"use server";

import { revalidatePath } from "next/cache";

import { resolveDashboardIdentity } from "@/lib/auth";
import { addSupportMessage, saveHomeNotes } from "@/lib/data";
import { sendOpsNotification } from "@/lib/email";
import { requestIntakeEnabled } from "@/lib/env";
import {
  createAuthenticatedServiceCase,
  createCustomerRescheduleCase,
  recordServiceCaseNotificationDelivery,
  SERVICE_CASE_TYPES,
  type ServiceCaseType,
} from "@/lib/service-cases";

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
  const caseType = String(formData.get("caseType") ?? "") as ServiceCaseType;
  const bookingId = String(formData.get("bookingId") ?? "").trim() || null;
  if (!body || !SERVICE_CASE_TYPES.includes(caseType)) {
    throw new Error("Choose a valid support request and add details");
  }
  const serviceCase = await createAuthenticatedServiceCase({
    customerId: customer.id,
    bookingId,
    caseType,
    details: body,
  });
  await addSupportMessage(customer.id, "customer", body);
  const outcome = await sendOpsNotification(
    {
      kind: "service_case",
      summary: `authenticated ${caseType} · ${serviceCase.public_reference}`,
      detailLines: [
        `Reference: ${serviceCase.public_reference}`,
        "Open operations control to review the customer request.",
      ],
    },
    { suppress: false },
  );
  await recordServiceCaseNotificationDelivery(serviceCase.id, outcome);
  await addSupportMessage(
    customer.id,
    "concierge",
    `Your ${caseType.replaceAll("_", " ")} request ${serviceCase.public_reference} is in the operator queue. No schedule or payment changes until an operator confirms them.`,
  );
  revalidatePath("/dashboard");
}

export async function rescheduleAction(formData: FormData) {
  const customer = await requireCustomer();
  const bookingId = String(formData.get("bookingId") ?? "");
  if (!bookingId) return;
  const serviceCase = await createCustomerRescheduleCase(customer.id, bookingId);
  if (!serviceCase.duplicate) {
    const outcome = await sendOpsNotification(
      {
        kind: "service_case",
        summary: `authenticated reschedule · ${serviceCase.public_reference}`,
        detailLines: [
          `Reference: ${serviceCase.public_reference}`,
          "Open operations control to review the requested schedule change.",
        ],
      },
      { suppress: false },
    );
    await recordServiceCaseNotificationDelivery(serviceCase.id, outcome);
  }
  await addSupportMessage(
    customer.id,
    "concierge",
    `Your reschedule request ${serviceCase.public_reference} is in the operator queue. The current visit remains unchanged until a new window is confirmed.`,
  );
  revalidatePath("/dashboard");
}
