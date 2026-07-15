"use server";

import { revalidatePath } from "next/cache";

import { resolveDashboardIdentity } from "@/lib/auth";
import {
  appendServiceCaseCustomerAcknowledgement,
  saveHomeNotes,
} from "@/lib/data";
import { sendOpsNotification } from "@/lib/email";
import { customerPortalWritesEnabled } from "@/lib/env";
import {
  respondToScheduleProposal,
  saveCustomerCleanerPreference,
  sendCustomerJobMessage,
  submitCustomerReview,
  submitTipIntent,
} from "@/lib/field-operations-data";
import {
  boundedCurrencyCents,
  boundedDecimalValue,
  formUuid,
  formValue,
} from "@/lib/form-values";
import {
  createAuthenticatedServiceCase,
  createCustomerRescheduleCase,
  recordServiceCaseNotificationDelivery,
  SERVICE_CASE_TYPES,
  type ServiceCaseType,
} from "@/lib/service-cases";

async function requireCustomer() {
  if (!customerPortalWritesEnabled) {
    throw new Error("Customer portal changes are temporarily disabled");
  }
  const identity = await resolveDashboardIdentity();
  if (identity.state === "signed_out") {
    throw new Error("Not signed in");
  }
  return { ...identity.customer, devOnly: identity.devOnly };
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
  const idempotencyKey = formUuid(formData, "idempotencyKey");
  if (!body || !SERVICE_CASE_TYPES.includes(caseType)) {
    throw new Error("Choose a valid support request and add details");
  }
  if (caseType === "reschedule" && !bookingId) {
    throw new Error("Choose the booking that needs a schedule change");
  }
  const serviceCase =
    caseType === "reschedule"
      ? await createCustomerRescheduleCase(customer.id, bookingId!)
      : await createAuthenticatedServiceCase({
          idempotencyKey,
          customerId: customer.id,
          bookingId,
          caseType,
          details: body,
        });
  if (!serviceCase.duplicate) {
    if (!serviceCase.notificationOutboxId) {
      throw new Error("Service-case notification claim is unavailable");
    }
    const outcome = await sendOpsNotification(
      {
        kind: "service_case",
        summary: `authenticated ${caseType} · ${serviceCase.public_reference}`,
        detailLines: [
          `Reference: ${serviceCase.public_reference}`,
          "Open operations control to review the customer request.",
        ],
      },
      {
        suppress: false,
        idempotencyKey: `service-case:${serviceCase.id}:ops_notification`,
      },
    );
    await recordServiceCaseNotificationDelivery(
      serviceCase.notificationOutboxId,
      serviceCase.id,
      outcome,
    );
  }
  await appendServiceCaseCustomerAcknowledgement(customer.id, serviceCase.id);
  revalidatePath("/dashboard");
}

export async function rescheduleAction(formData: FormData) {
  const customer = await requireCustomer();
  const bookingId = String(formData.get("bookingId") ?? "");
  if (!bookingId) return;
  const serviceCase = await createCustomerRescheduleCase(customer.id, bookingId);
  if (!serviceCase.duplicate) {
    if (!serviceCase.notificationOutboxId) {
      throw new Error("Service-case notification claim is unavailable");
    }
    const outcome = await sendOpsNotification(
      {
        kind: "service_case",
        summary: `authenticated reschedule · ${serviceCase.public_reference}`,
        detailLines: [
          `Reference: ${serviceCase.public_reference}`,
          "Open operations control to review the requested schedule change.",
        ],
      },
      {
        suppress: false,
        idempotencyKey: `service-case:${serviceCase.id}:ops_notification`,
      },
    );
    await recordServiceCaseNotificationDelivery(
      serviceCase.notificationOutboxId,
      serviceCase.id,
      outcome,
    );
  }
  await appendServiceCaseCustomerAcknowledgement(customer.id, serviceCase.id);
  revalidatePath("/dashboard");
}

export async function scheduleProposalResponseAction(formData: FormData) {
  const customer = await requireCustomer();
  const response = formValue(formData, "response");
  if (response !== "approved" && response !== "changes_requested") {
    throw new Error("Choose approve or request changes");
  }
  const note = formValue(formData, "note").slice(0, 2000) || null;
  if (response === "changes_requested" && (!note || note.length < 2)) {
    throw new Error("Describe the schedule change you need");
  }
  await respondToScheduleProposal({
    customerId: customer.id,
    devOnly: customer.devOnly,
    proposalId: formUuid(formData, "proposalId"),
    response,
    note,
  });
  revalidatePath("/dashboard");
  revalidatePath("/operator/field");
}

export async function customerCleanerPreferenceAction(formData: FormData) {
  const customer = await requireCustomer();
  const preference = formValue(formData, "preference");
  if (preference !== "preferred" && preference !== "avoid") {
    throw new Error("Choose a cleaner preference");
  }
  await saveCustomerCleanerPreference({
    customerId: customer.id,
    devOnly: customer.devOnly,
    allocationId: formUuid(formData, "allocationId"),
    cleanerId: formUuid(formData, "cleanerId"),
    preference,
    note: formValue(formData, "note").slice(0, 1000) || null,
  });
  revalidatePath("/dashboard");
  revalidatePath("/operator/field");
}

export async function customerJobMessageAction(formData: FormData) {
  const customer = await requireCustomer();
  const body = formValue(formData, "body").slice(0, 2000);
  if (body.length < 2) throw new Error("Add a job message");
  await sendCustomerJobMessage({
    customerId: customer.id,
    devOnly: customer.devOnly,
    allocationId: formUuid(formData, "allocationId"),
    body,
  });
  revalidatePath("/dashboard");
  revalidatePath("/crew");
  revalidatePath("/operator/field");
}

export async function customerReviewAction(formData: FormData) {
  const customer = await requireCustomer();
  await submitCustomerReview({
    customerId: customer.id,
    devOnly: customer.devOnly,
    allocationId: formUuid(formData, "allocationId"),
    cleanerId: formUuid(formData, "cleanerId"),
    rating: boundedDecimalValue(formData, "rating", { min: 1, max: 5 }),
    note: formValue(formData, "note").slice(0, 2000) || null,
  });
  revalidatePath("/dashboard");
  revalidatePath("/operator/field");
}

export async function customerTipIntentAction(formData: FormData) {
  const customer = await requireCustomer();
  const cleanerId = formValue(formData, "cleanerId");
  await submitTipIntent({
    customerId: customer.id,
    devOnly: customer.devOnly,
    allocationId: formUuid(formData, "allocationId"),
    cleanerId: cleanerId ? formUuid(formData, "cleanerId") : null,
    amountCents: boundedCurrencyCents(formData, "amountDollars", {
      minCents: 100,
      maxCents: 100_000,
    }),
    note: formValue(formData, "note").slice(0, 500) || null,
  });
  revalidatePath("/dashboard");
  revalidatePath("/operator/field");
}
