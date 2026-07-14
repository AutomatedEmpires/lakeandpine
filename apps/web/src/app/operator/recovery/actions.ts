"use server";

import { revalidatePath } from "next/cache";

import { formUuid as uuid, formValue as value } from "@/lib/form-values";
import { requireOperatorActionIdentity as requireOperator } from "@/lib/operator-action-auth";
import {
  cancelScopedServiceCaseBooking,
  createScopedRecoveryAction,
  createScopedRefundReview,
  rescheduleScopedServiceCase,
  transitionScopedRecoveryAction,
  transitionScopedRefund,
  transitionScopedServiceCase,
} from "@/lib/team-operations-data";
import {
  canTransitionRecovery,
  canTransitionRefund,
  canTransitionServiceCase,
  RECOVERY_STATUSES,
  REFUND_STATUSES,
  SERVICE_CASE_STATUSES,
  type RecoveryStatus,
  type RefundStatus,
  type ServiceCaseStatus,
} from "@/lib/operations-workflows";

function refreshRecovery() {
  revalidatePath("/operator/recovery");
  revalidatePath("/operator/network");
  revalidatePath("/operator/schedule");
  revalidatePath("/dashboard");
}

export async function serviceCaseStatusAction(formData: FormData) {
  const identity = await requireOperator();
  const from = value(formData, "from") as ServiceCaseStatus;
  const to = value(formData, "to") as ServiceCaseStatus;
  if (
    !SERVICE_CASE_STATUSES.includes(from) ||
    !SERVICE_CASE_STATUSES.includes(to) ||
    !canTransitionServiceCase(from, to)
  ) {
    throw new Error("Invalid service-case transition");
  }
  const resolutionSummary = value(formData, "resolutionSummary").slice(0, 2000);
  if (["resolved", "closed"].includes(to) && !resolutionSummary) {
    throw new Error("A resolution summary is required before resolving or closing a case");
  }
  await transitionScopedServiceCase({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    caseId: uuid(formData, "caseId"),
    from,
    to,
    resolutionSummary: resolutionSummary || null,
  });
  refreshRecovery();
}

export async function rescheduleServiceCaseAction(formData: FormData) {
  const identity = await requireOperator();
  const startLocal = value(formData, "startAt");
  const endLocal = value(formData, "endAt");
  if (!startLocal || !endLocal) throw new Error("Choose a new start and end time");
  await rescheduleScopedServiceCase({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    caseId: uuid(formData, "caseId"),
    startLocal,
    endLocal,
  });
  refreshRecovery();
}

export async function cancelServiceCaseBookingAction(formData: FormData) {
  const identity = await requireOperator();
  if (value(formData, "confirmation") !== "cancel") {
    throw new Error("Cancellation confirmation is required");
  }
  await cancelScopedServiceCaseBooking({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    caseId: uuid(formData, "caseId"),
  });
  refreshRecovery();
}

export async function createRecoveryAction(formData: FormData) {
  const identity = await requireOperator();
  const actionType = value(formData, "actionType");
  const allowed = [
    "reclean",
    "site_visit",
    "apology",
    "credit_review",
    "refund_review",
    "crew_coaching",
    "documentation",
    "other",
  ];
  const scheduledLocal = value(formData, "scheduledAt");
  if (!allowed.includes(actionType) || !scheduledLocal) {
    throw new Error("Recovery type and target time are required");
  }
  await createScopedRecoveryAction({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    caseId: uuid(formData, "caseId"),
    actionType,
    scheduledLocal,
    notes: value(formData, "notes").slice(0, 2000) || null,
  });
  refreshRecovery();
}

export async function recoveryStatusAction(formData: FormData) {
  const identity = await requireOperator();
  const from = value(formData, "from") as RecoveryStatus;
  const to = value(formData, "to") as RecoveryStatus;
  if (
    !RECOVERY_STATUSES.includes(from) ||
    !RECOVERY_STATUSES.includes(to) ||
    !canTransitionRecovery(from, to)
  ) {
    throw new Error("Invalid recovery transition");
  }
  await transitionScopedRecoveryAction({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    recoveryId: uuid(formData, "recoveryId"),
    from,
    to,
  });
  refreshRecovery();
}

export async function requestRefundReviewAction(formData: FormData) {
  const identity = await requireOperator();
  const amountCents = Math.round(Number(value(formData, "amountDollars")) * 100);
  const reasonCode = value(formData, "reasonCode")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 80);
  if (
    !Number.isInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > 1_000_000 ||
    !reasonCode
  ) {
    throw new Error("Refund review amount or reason is invalid");
  }
  await createScopedRefundReview({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    caseId: uuid(formData, "caseId"),
    amountCents,
    reasonCode,
  });
  refreshRecovery();
}

export async function refundStatusAction(formData: FormData) {
  const identity = await requireOperator();
  const from = value(formData, "from") as RefundStatus;
  const to = value(formData, "to") as RefundStatus;
  if (
    !REFUND_STATUSES.includes(from) ||
    !REFUND_STATUSES.includes(to) ||
    !canTransitionRefund(from, to)
  ) {
    throw new Error("Invalid refund transition");
  }
  const externalReference = value(formData, "externalReference") || null;
  if (to === "processed" && (!externalReference || externalReference.length < 4)) {
    throw new Error("Record the external refund receipt after funds are returned");
  }
  await transitionScopedRefund({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    refundId: uuid(formData, "refundId"),
    from,
    to,
    externalReference,
  });
  refreshRecovery();
}
