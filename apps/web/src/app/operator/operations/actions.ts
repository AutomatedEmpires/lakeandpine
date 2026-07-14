"use server";

import { revalidatePath } from "next/cache";

import { resolveOperatorIdentity } from "@/lib/auth";
import { boundedCurrencyCents } from "@/lib/form-values";
import { retryOutboxNotification } from "@/lib/notification-outbox";
import {
  addCleanerAvailability,
  cancelBookingFromCase,
  createJobSchedule,
  createOnboardingCleaner,
  createRecoveryAction,
  createRefundReview,
  createTerritoryDraft,
  proposeAssignmentCandidate,
  removeAssignmentFromPlanningSchedule,
  rescheduleBookingFromCase,
  reviewTimeOff,
  setRecoveryStatus,
  setCleanerApplicationStatus,
  setCleanerCapabilities,
  setCleanerStatus,
  setJobScheduleStatus,
  setPostalCodeStatus,
  setQualificationStatus,
  setRefundStatus,
  setServiceCaseStatus,
  setTerritoryStatus,
  updateUnscheduledBookingPreferenceFromCase,
  verifyCleanerScreening,
} from "@/lib/operations-console-data";
import {
  canTransitionQualification,
  canTransitionRecovery,
  canTransitionRefund,
  canTransitionSchedule,
  canTransitionServiceCase,
  QUALIFICATION_STATUSES,
  RECOVERY_STATUSES,
  REFUND_STATUSES,
  SCHEDULE_STATUSES,
  SERVICE_CASE_STATUSES,
  type QualificationStatus,
  type RecoveryStatus,
  type RefundStatus,
  type ScheduleStatus,
  type ServiceCaseStatus,
} from "@/lib/operations-workflows";
import { hasCapability } from "@/lib/team-operations";
import { getOperationsAccess } from "@/lib/team-operations-data";

async function requireOperator() {
  const identity = await resolveOperatorIdentity();
  if (identity.state !== "authed" && identity.state !== "preview")
    throw new Error("Operator access required");
  const access = await getOperationsAccess(identity.operator.id, identity.devOnly);
  if (
    !access.organizationId ||
    !hasCapability(access.memberships, "view_network", access.organizationId, null)
  ) {
    throw new Error("Owner or GM access is required for unallocated service operations");
  }
  return identity;
}

function value(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function refresh() {
  revalidatePath("/operator");
  revalidatePath("/operator/operations");
  revalidatePath("/crew");
}

export async function createTerritoryAction(formData: FormData) {
  const operator = await requireOperator();
  const code = value(formData, "code")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 50);
  const name = value(formData, "name").slice(0, 120);
  const rawPostalCodes = [
    ...new Set(
      value(formData, "postalCodes")
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, 30);
  if (
    rawPostalCodes.length === 0 ||
    rawPostalCodes.some((item) => !/^\d{5}(?:-\d{4})?$/.test(item))
  ) {
    throw new Error("Enter US ZIP codes as 12345 or 12345-6789");
  }
  const postalCodes = [
    ...new Set(rawPostalCodes.map((item) => item.slice(0, 5))),
  ];
  if (
    code.length < 2 ||
    name.length < 2
  ) {
    throw new Error("Territory name, code, or postal-code list is invalid");
  }
  await createTerritoryDraft({
    customerId: operator.operator.id,
    code,
    name,
    postalCodes,
    devOnly: operator.devOnly,
  });
  refresh();
}

export async function postalCodeStatusAction(formData: FormData) {
  const operator = await requireOperator();
  const status = value(formData, "status");
  if (!(["review", "active", "excluded"] as const).includes(status as "review"))
    return;
  await setPostalCodeStatus(
    operator.operator.id,
    value(formData, "territoryId"),
    value(formData, "postalCode"),
    status as "review" | "active" | "excluded",
    operator.devOnly,
  );
  refresh();
}

export async function territoryStatusAction(formData: FormData) {
  const operator = await requireOperator();
  const status = value(formData, "status");
  if (!(["draft", "active", "paused"] as const).includes(status as "draft"))
    return;
  await setTerritoryStatus(
    operator.operator.id,
    value(formData, "territoryId"),
    status as "draft" | "active" | "paused",
    operator.devOnly,
  );
  refresh();
}

const APPLICATION_TRANSITIONS: Record<string, string[]> = {
  submitted: ["reviewing", "declined", "withdrawn"],
  reviewing: ["interview", "declined", "withdrawn"],
  interview: ["offer", "declined", "withdrawn"],
  offer: ["onboarding", "declined", "withdrawn"],
  onboarding: ["declined", "withdrawn"],
};

export async function applicationStatusAction(formData: FormData) {
  const operator = await requireOperator();
  const from = value(formData, "from");
  const to = value(formData, "to");
  if (!APPLICATION_TRANSITIONS[from]?.includes(to))
    throw new Error("Invalid application transition");
  await setCleanerApplicationStatus(
    operator.operator.id,
    value(formData, "applicationId"),
    from,
    to,
    operator.devOnly,
  );
  refresh();
}

export async function onboardCleanerAction(formData: FormData) {
  const operator = await requireOperator();
  await createOnboardingCleaner(
    operator.operator.id,
    value(formData, "applicationId"),
    value(formData, "territoryId"),
    operator.devOnly,
  );
  refresh();
}

export async function verifyCleanerScreeningAction(formData: FormData) {
  const operator = await requireOperator();
  if (value(formData, "attestation") !== "verified")
    throw new Error("Verification attestation is required");
  await verifyCleanerScreening(
    operator.operator.id,
    value(formData, "cleanerId"),
    operator.devOnly,
  );
  refresh();
}

export async function cleanerAvailabilityAction(formData: FormData) {
  const operator = await requireOperator();
  const dayOfWeek = Number(value(formData, "dayOfWeek"));
  const startTime = value(formData, "startTime");
  const endTime = value(formData, "endTime");
  if (
    !Number.isInteger(dayOfWeek) ||
    dayOfWeek < 0 ||
    dayOfWeek > 6 ||
    !/^\d{2}:\d{2}$/.test(startTime) ||
    !/^\d{2}:\d{2}$/.test(endTime) ||
    endTime <= startTime
  ) {
    throw new Error("Availability window is invalid");
  }
  await addCleanerAvailability({
    customerId: operator.operator.id,
    cleanerId: value(formData, "cleanerId"),
    territoryId: value(formData, "territoryId"),
    dayOfWeek,
    startTime,
    endTime,
    devOnly: operator.devOnly,
  });
  refresh();
}

const ALLOWED_SKILLS = [
  "estate-care",
  "construction-care",
  "marine-care",
  "commercial-care",
  "finish-awareness",
  "specialty-finishes",
  "quality-review",
  "site-safety",
];
const ALLOWED_VERTICALS = [
  "estate",
  "construction",
  "marine",
  "commercial",
] as const;

export async function cleanerCapabilitiesAction(formData: FormData) {
  const operator = await requireOperator();
  const skills = [
    ...new Set(value(formData, "skills").split(/[\s,]+/).filter(Boolean)),
  ];
  const verticalExperience = [
    ...new Set(
      value(formData, "verticalExperience").split(/[\s,]+/).filter(Boolean),
    ),
  ];
  if (
    skills.some((skill) => !ALLOWED_SKILLS.includes(skill)) ||
    verticalExperience.some(
      (vertical) =>
        !ALLOWED_VERTICALS.includes(
          vertical as (typeof ALLOWED_VERTICALS)[number],
        ),
    )
  ) {
    throw new Error("Use only supported capability codes");
  }
  await setCleanerCapabilities({
    customerId: operator.operator.id,
    cleanerId: value(formData, "cleanerId"),
    skills,
    verticalExperience: verticalExperience as (typeof ALLOWED_VERTICALS)[number][],
    devOnly: operator.devOnly,
  });
  refresh();
}

export async function cleanerStatusAction(formData: FormData) {
  const operator = await requireOperator();
  const status = value(formData, "status");
  if (!(["active", "paused", "inactive"] as const).includes(status as "active"))
    return;
  await setCleanerStatus(
    operator.operator.id,
    value(formData, "cleanerId"),
    status as "active" | "paused" | "inactive",
    operator.devOnly,
  );
  refresh();
}

export async function qualificationStatusAction(formData: FormData) {
  const operator = await requireOperator();
  const from = value(formData, "from") as QualificationStatus;
  const to = value(formData, "to") as QualificationStatus;
  if (
    !QUALIFICATION_STATUSES.includes(from) ||
    !QUALIFICATION_STATUSES.includes(to) ||
    !canTransitionQualification(from, to)
  ) {
    throw new Error("Invalid qualification transition");
  }
  const requirements = {
    siteReady: formData.get("siteReady") === "on",
    utilitiesReady: formData.get("utilitiesReady") === "on",
    constructionReady: formData.get("constructionReady") === "on",
    dockAccessReady: formData.get("dockAccessReady") === "on",
    finishRestrictionsAcknowledged:
      formData.get("finishRestrictionsAcknowledged") === "on",
  };
  const vertical = value(formData, "vertical");
  if (
    to === "approved" &&
    (!requirements.siteReady ||
      !requirements.utilitiesReady ||
      !requirements.finishRestrictionsAcknowledged ||
      (vertical === "construction" && !requirements.constructionReady) ||
      (vertical === "marine" && !requirements.dockAccessReady))
  ) {
    throw new Error(
      "Access/site readiness, utilities, and finish restrictions must be confirmed before approval",
    );
  }
  await setQualificationStatus(
    operator.operator.id,
    value(formData, "bookingId"),
    from,
    to,
    requirements,
    operator.devOnly,
  );
  refresh();
}

export async function scheduleStatusAction(formData: FormData) {
  const operator = await requireOperator();
  const from = value(formData, "from") as ScheduleStatus;
  const to = value(formData, "to") as ScheduleStatus;
  if (
    !SCHEDULE_STATUSES.includes(from) ||
    !SCHEDULE_STATUSES.includes(to) ||
    !canTransitionSchedule(from, to)
  ) {
    throw new Error("Invalid schedule transition");
  }
  await setJobScheduleStatus(
    operator.operator.id,
    value(formData, "scheduleId"),
    from,
    to,
    operator.devOnly,
  );
  refresh();
}

export async function createScheduleAction(formData: FormData) {
  const operator = await requireOperator();
  await createJobSchedule({
    customerId: operator.operator.id,
    bookingId: value(formData, "bookingId"),
    territoryId: value(formData, "territoryId"),
    startLocal: value(formData, "startAt"),
    endLocal: value(formData, "endAt"),
    devOnly: operator.devOnly,
  });
  refresh();
}

export async function proposeCrewAction(formData: FormData) {
  const operator = await requireOperator();
  await proposeAssignmentCandidate(
    operator.operator.id,
    value(formData, "scheduleId"),
    value(formData, "candidateId"),
    operator.devOnly,
  );
  refresh();
}

export async function removePlanningAssignmentAction(formData: FormData) {
  const operator = await requireOperator();
  const changed = await removeAssignmentFromPlanningSchedule(
    operator.operator.id,
    value(formData, "assignmentId"),
    operator.devOnly,
  );
  if (!changed) throw new Error("Assignment changed; refresh and retry");
  refresh();
}

export async function serviceCaseStatusAction(formData: FormData) {
  const operator = await requireOperator();
  const from = value(formData, "from") as ServiceCaseStatus;
  const to = value(formData, "to") as ServiceCaseStatus;
  const resolutionSummary = value(formData, "resolutionSummary").slice(0, 2000);
  if (
    !SERVICE_CASE_STATUSES.includes(from) ||
    !SERVICE_CASE_STATUSES.includes(to) ||
    !canTransitionServiceCase(from, to)
  ) {
    throw new Error("Invalid service-case transition");
  }
  if (["resolved", "closed"].includes(to) && !resolutionSummary) {
    throw new Error(
      "A customer-visible outcome is required to resolve or close a case",
    );
  }
  await setServiceCaseStatus(
    operator.operator.id,
    value(formData, "caseId"),
    from,
    to,
    resolutionSummary || null,
    operator.devOnly,
  );
  refresh();
}

export async function rescheduleCaseAction(formData: FormData) {
  const operator = await requireOperator();
  await rescheduleBookingFromCase({
    customerId: operator.operator.id,
    caseId: value(formData, "caseId"),
    startLocal: value(formData, "startAt"),
    endLocal: value(formData, "endAt"),
    devOnly: operator.devOnly,
  });
  refresh();
}

export async function updateUnscheduledPreferenceAction(formData: FormData) {
  const operator = await requireOperator();
  await updateUnscheduledBookingPreferenceFromCase({
    customerId: operator.operator.id,
    caseId: value(formData, "caseId"),
    preferredDate: value(formData, "preferredDate"),
    devOnly: operator.devOnly,
  });
  refresh();
}

export async function cancelCaseBookingAction(formData: FormData) {
  const operator = await requireOperator();
  if (value(formData, "confirmation") !== "cancel")
    throw new Error("Cancellation confirmation is required");
  await cancelBookingFromCase(
    operator.operator.id,
    value(formData, "caseId"),
    operator.devOnly,
  );
  refresh();
}

export async function recoveryAction(formData: FormData) {
  const operator = await requireOperator();
  const type = value(formData, "type");
  const scheduledLocal = value(formData, "scheduledAt");
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
  if (!allowed.includes(type) || !scheduledLocal) {
    throw new Error("Recovery type and target time are required");
  }
  await createRecoveryAction({
    customerId: operator.operator.id,
    caseId: value(formData, "caseId"),
    type,
    scheduledLocal,
    notes: value(formData, "notes").slice(0, 2000),
    devOnly: operator.devOnly,
  });
  refresh();
}

export async function recoveryStatusAction(formData: FormData) {
  const operator = await requireOperator();
  const from = value(formData, "from") as RecoveryStatus;
  const to = value(formData, "to") as RecoveryStatus;
  if (
    !RECOVERY_STATUSES.includes(from) ||
    !RECOVERY_STATUSES.includes(to) ||
    !canTransitionRecovery(from, to)
  ) {
    throw new Error("Invalid recovery transition");
  }
  const changed = await setRecoveryStatus(
    operator.operator.id,
    value(formData, "recoveryId"),
    from,
    to,
    operator.devOnly,
  );
  if (!changed) throw new Error("Recovery plan changed; refresh and retry");
  refresh();
}

export async function requestRefundReviewAction(formData: FormData) {
  const operator = await requireOperator();
  const amountCents = boundedCurrencyCents(formData, "amountDollars", {
    minCents: 1,
    maxCents: 1_000_000,
  });
  const reasonCode = value(formData, "reasonCode")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 80);
  if (!reasonCode)
    throw new Error("Refund review amount or reason is invalid");
  await createRefundReview({
    customerId: operator.operator.id,
    caseId: value(formData, "caseId"),
    amountCents,
    reasonCode,
    devOnly: operator.devOnly,
  });
  refresh();
}

export async function refundStatusAction(formData: FormData) {
  const operator = await requireOperator();
  const from = value(formData, "from") as RefundStatus;
  const to = value(formData, "to") as RefundStatus;
  const providerReference = value(formData, "providerReference") || null;
  if (
    !REFUND_STATUSES.includes(from) ||
    !REFUND_STATUSES.includes(to) ||
    !canTransitionRefund(from, to)
  )
    throw new Error("Invalid refund transition");
  if (
    to === "processed" &&
    (!providerReference || providerReference.length < 4)
  ) {
    throw new Error(
      "Record the external provider reference after money has actually been returned",
    );
  }
  await setRefundStatus(
    operator.operator.id,
    value(formData, "refundId"),
    from,
    to,
    providerReference,
    operator.devOnly,
  );
  refresh();
}

export async function timeOffReviewAction(formData: FormData) {
  const operator = await requireOperator();
  const status = value(formData, "status");
  if (status !== "approved" && status !== "declined") return;
  await reviewTimeOff(
    operator.operator.id,
    value(formData, "timeOffId"),
    status,
    operator.devOnly,
  );
  refresh();
}

export async function retryNotificationAction(formData: FormData) {
  const operator = await requireOperator();
  await retryOutboxNotification(
    operator.operator.id,
    value(formData, "outboxId"),
    operator.devOnly,
  );
  refresh();
}
