"use server";

import { revalidatePath } from "next/cache";

import {
  boundedDecimalValue as numberValue,
  formUuid as uuid,
  formValue as value,
} from "@/lib/form-values";
import { requireOperatorActionIdentity as requireOperator } from "@/lib/operator-action-auth";
import {
  addWorkforceMembership,
  addGeneralManagerMembership,
  allocateScheduleToTeam,
  bootstrapNationalOwner,
  createBonusAward,
  createInventoryProduct,
  createOperatingTeam,
  createQualityReview,
  createReviewBonusTier,
  createWorkforceEvent,
  proposeScopedTeamScheduleCandidate,
  recordTeamInventoryUsage,
  reviewRestockRequest,
  reviewTeamTimeOff,
  reviewTimeEntry,
  setCompensationRate,
  setTeamTerritoryCoverage,
  transitionScopedTeamSchedule,
  transitionBonusAward,
  updateWorkforceMembershipStatus,
} from "@/lib/team-operations-data";
import {
  canTransitionSchedule,
  SCHEDULE_STATUSES,
  type ScheduleStatus,
} from "@/lib/operations-workflows";
import { isValidIanaTimeZone } from "@/lib/zoned-datetime";

function optionalHttpsUrl(formData: FormData, key: string) {
  const result = value(formData, key);
  if (!result) return null;
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    throw new Error(`${key} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${key} must use HTTPS`);
  return url.toString();
}

function refreshTeamOperations() {
  revalidatePath("/operator/network");
  revalidatePath("/operator/schedule");
  revalidatePath("/operator/inventory");
  revalidatePath("/operator/workforce");
  revalidatePath("/operator/time");
  revalidatePath("/operator/compensation");
  revalidatePath("/crew");
}

export async function bootstrapOwnerAction() {
  const identity = await requireOperator();
  await bootstrapNationalOwner(identity.operator.id, identity.devOnly);
  refreshTeamOperations();
}

export async function createTeamAction(formData: FormData) {
  const identity = await requireOperator();
  const code = value(formData, "code").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 50);
  const name = value(formData, "name").slice(0, 120);
  const timezone = value(formData, "timezone").slice(0, 80);
  const regionLabel = value(formData, "regionLabel").slice(0, 120) || null;
  if (code.length < 2 || name.length < 2 || !isValidIanaTimeZone(timezone)) {
    throw new Error("Team code, name, and IANA timezone are required");
  }
  await createOperatingTeam({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    code,
    name,
    timezone,
    regionLabel,
  });
  refreshTeamOperations();
}

export async function teamTerritoryCoverageAction(formData: FormData) {
  const identity = await requireOperator();
  await setTeamTerritoryCoverage({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    territoryId: uuid(formData, "territoryId"),
    enabled: value(formData, "enabled") === "true",
  });
  refreshTeamOperations();
}

export async function addMembershipAction(formData: FormData) {
  const identity = await requireOperator();
  const role = value(formData, "role");
  if (!(["manager", "shift_lead", "cleaner"] as const).includes(role as "manager")) {
    throw new Error("Choose a supported team role");
  }
  const subjectType = value(formData, "subjectType");
  if (subjectType !== "staff" && subjectType !== "cleaner") {
    throw new Error("Choose a supported identity type");
  }
  await addWorkforceMembership({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    role: role as "manager" | "shift_lead" | "cleaner",
    subjectType,
    subjectId: uuid(formData, "subjectId"),
    title: value(formData, "title").slice(0, 120) || null,
  });
  refreshTeamOperations();
}

export async function addGeneralManagerAction(formData: FormData) {
  const identity = await requireOperator();
  await addGeneralManagerMembership({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    subjectId: uuid(formData, "subjectId"),
    title: value(formData, "title").slice(0, 120) || "General manager",
  });
  refreshTeamOperations();
}

export async function membershipStatusAction(formData: FormData) {
  const identity = await requireOperator();
  const from = value(formData, "from");
  const to = value(formData, "to");
  if (!(from === "active" || from === "paused")
    || !(to === "active" || to === "paused" || to === "ended")) {
    throw new Error("Invalid membership status");
  }
  const reason = value(formData, "reason").slice(0, 1000);
  if (reason.length < 4) throw new Error("Record a reason for this access change");
  const teamId = value(formData, "teamId");
  await updateWorkforceMembershipStatus({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    membershipId: uuid(formData, "membershipId"),
    teamId: teamId ? uuid(formData, "teamId") : null,
    from,
    to,
    reason,
  });
  refreshTeamOperations();
}

export async function allocateScheduleAction(formData: FormData) {
  const identity = await requireOperator();
  await allocateScheduleToTeam({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    scheduleId: uuid(formData, "scheduleId"),
  });
  refreshTeamOperations();
}

export async function proposeTeamScheduleCandidateAction(formData: FormData) {
  const identity = await requireOperator();
  await proposeScopedTeamScheduleCandidate({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    scheduleId: uuid(formData, "scheduleId"),
    candidateId: value(formData, "candidateId"),
  });
  refreshTeamOperations();
  revalidatePath("/operator/schedule");
  revalidatePath("/operator/operations");
}

export async function teamScheduleStatusAction(formData: FormData) {
  const identity = await requireOperator();
  const from = value(formData, "from") as ScheduleStatus;
  const to = value(formData, "to") as ScheduleStatus;
  if (
    !SCHEDULE_STATUSES.includes(from) ||
    !SCHEDULE_STATUSES.includes(to) ||
    !canTransitionSchedule(from, to)
  ) {
    throw new Error("Invalid schedule transition");
  }
  await transitionScopedTeamSchedule({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    scheduleId: uuid(formData, "scheduleId"),
    from,
    to,
  });
  refreshTeamOperations();
  revalidatePath("/operator/schedule");
  revalidatePath("/operator/operations");
}

export async function createInventoryProductAction(formData: FormData) {
  const identity = await requireOperator();
  const category = value(formData, "category");
  const allowedCategories = [
    "chemical", "paper", "tool", "ppe", "liner", "marine", "finish_care", "general",
  ];
  if (!allowedCategories.includes(category)) throw new Error("Choose a supported inventory category");
  const initialCount = numberValue(formData, "initialCount", { min: 0, max: 1_000_000, decimals: 3 });
  const reorderPoint = numberValue(formData, "reorderPoint", { min: 0, max: 1_000_000, decimals: 3 });
  const targetLevel = numberValue(formData, "targetLevel", { min: 0, max: 1_000_000, decimals: 3 });
  if (targetLevel < reorderPoint) throw new Error("Target stock must be at least the reorder point");
  const dollars = value(formData, "unitCostDollars");
  const unitCostCents = dollars
    ? Math.round(numberValue(formData, "unitCostDollars", { min: 0, max: 1_000_000, decimals: 2 }) * 100)
    : null;
  const sku = value(formData, "sku").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 50);
  const name = value(formData, "name").slice(0, 160);
  const unitLabel = value(formData, "unitLabel").slice(0, 40);
  if (sku.length < 2 || name.length < 2 || !unitLabel) throw new Error("SKU, product name, and unit are required");
  await createInventoryProduct({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    sku,
    name,
    category,
    unitLabel,
    unitCostCents,
    preferredVendor: value(formData, "preferredVendor").slice(0, 160) || null,
    purchaseUrl: optionalHttpsUrl(formData, "purchaseUrl"),
    imageUrl: optionalHttpsUrl(formData, "imageUrl"),
    initialCount,
    reorderPoint,
    targetLevel,
  });
  refreshTeamOperations();
}

export async function recordInventoryUsageAction(formData: FormData) {
  const identity = await requireOperator();
  const [productId, locationId] = value(formData, "inventoryKey").split("|");
  if (!productId || !locationId) throw new Error("Choose a team inventory item");
  await recordTeamInventoryUsage({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    productId,
    locationId,
    quantity: numberValue(formData, "quantity", { min: 0.001, max: 100_000, decimals: 3 }),
    note: value(formData, "note").slice(0, 1000) || null,
  });
  refreshTeamOperations();
}

export async function reviewRestockAction(formData: FormData) {
  const identity = await requireOperator();
  const to = value(formData, "to");
  if (!(["approved", "ordered", "received", "declined", "canceled"] as const).includes(to as "approved")) {
    throw new Error("Invalid restock transition");
  }
  await reviewRestockRequest({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    restockId: uuid(formData, "restockId"),
    from: value(formData, "from"),
    to: to as "approved" | "ordered" | "received" | "declined" | "canceled",
    version: numberValue(formData, "version", { min: 1, max: 1_000_000 }),
    decisionNote: value(formData, "decisionNote").slice(0, 1000) || null,
  });
  refreshTeamOperations();
}

export async function reviewTimeEntryAction(formData: FormData) {
  const identity = await requireOperator();
  const to = value(formData, "to");
  if (to !== "approved" && to !== "rejected") throw new Error("Invalid time decision");
  await reviewTimeEntry({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    entryId: uuid(formData, "entryId"),
    to,
    version: numberValue(formData, "version", { min: 1, max: 1_000_000 }),
    reason: value(formData, "reason").slice(0, 1000) || null,
  });
  refreshTeamOperations();
}

export async function reviewTeamTimeOffAction(formData: FormData) {
  const identity = await requireOperator();
  const to = value(formData, "to");
  if (to !== "approved" && to !== "declined") {
    throw new Error("Choose a valid time-off decision");
  }
  await reviewTeamTimeOff({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    timeOffId: uuid(formData, "timeOffId"),
    to,
  });
  refreshTeamOperations();
}

export async function setCompensationRateAction(formData: FormData) {
  const identity = await requireOperator();
  const payBasis = value(formData, "payBasis");
  if (!(["hourly", "salary", "per_job"] as const).includes(payBasis as "hourly")) {
    throw new Error("Choose a supported pay basis");
  }
  const effectiveFrom = value(formData, "effectiveFrom");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw new Error("Choose an effective date");
  const amountCents = Math.round(numberValue(formData, "amountDollars", {
    min: 0.01,
    max: 10_000_000,
    decimals: 2,
  }) * 100);
  const reason = value(formData, "reason").slice(0, 500);
  if (reason.length < 2) throw new Error("A pay-change reason is required");
  await setCompensationRate({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    membershipId: uuid(formData, "membershipId"),
    payBasis: payBasis as "hourly" | "salary" | "per_job",
    amountCents,
    effectiveFrom,
    reason,
  });
  refreshTeamOperations();
}

export async function createBonusAction(formData: FormData) {
  const identity = await requireOperator();
  const reason = value(formData, "reason").slice(0, 500);
  if (reason.length < 2) throw new Error("A bonus reason is required");
  await createBonusAward({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    membershipId: uuid(formData, "membershipId"),
    amountCents: Math.round(numberValue(formData, "amountDollars", {
      min: 0.01,
      max: 1_000_000,
      decimals: 2,
    }) * 100),
    reason,
  });
  refreshTeamOperations();
}

export async function createReviewBonusTierAction(formData: FormData) {
  const identity = await requireOperator();
  const name = value(formData, "name").slice(0, 120);
  if (name.length < 2) throw new Error("Bonus tier name is required");
  await createReviewBonusTier({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    name,
    minimumRating: numberValue(formData, "minimumRating", {
      min: 1,
      max: 5,
      decimals: 1,
    }),
    bonusCents: Math.round(numberValue(formData, "bonusDollars", {
      min: 0.01,
      max: 1_000_000,
      decimals: 2,
    }) * 100),
  });
  refreshTeamOperations();
}

export async function createQualityReviewAction(formData: FormData) {
  const identity = await requireOperator();
  const [allocationId, cleanerId] = value(formData, "candidateKey").split("|");
  if (!allocationId || !cleanerId) throw new Error("Choose completed team work");
  const source = value(formData, "source");
  if (!(["verified_customer", "quality_inspection", "manager_review"] as const)
    .includes(source as "verified_customer")) {
    throw new Error("Choose a supported review source");
  }
  const evidenceReference = value(formData, "evidenceReference").slice(0, 500) || null;
  if (source === "verified_customer" && (!evidenceReference || evidenceReference.length < 4)) {
    throw new Error("Verified customer feedback needs an evidence reference");
  }
  await createQualityReview({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    allocationId,
    cleanerId,
    source: source as "verified_customer" | "quality_inspection" | "manager_review",
    rating: numberValue(formData, "rating", { min: 1, max: 5 }),
    evidenceReference,
    privateNote: value(formData, "privateNote").slice(0, 2000) || null,
  });
  refreshTeamOperations();
}

export async function bonusStatusAction(formData: FormData) {
  const identity = await requireOperator();
  const from = value(formData, "from");
  const to = value(formData, "to");
  if (!(from === "proposed" || from === "approved" || from === "exported")
    || !(to === "approved" || to === "exported"
      || to === "recorded_paid" || to === "canceled")) {
    throw new Error("Invalid bonus status");
  }
  const externalReference = value(formData, "externalReference").slice(0, 200) || null;
  if (["exported", "recorded_paid"].includes(to)
    && (!externalReference || externalReference.length < 4)) {
    throw new Error("Record the payroll or payment reference first");
  }
  await transitionBonusAward({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    bonusId: uuid(formData, "bonusId"),
    from,
    to,
    version: numberValue(formData, "version", { min: 1, max: 1_000_000 }),
    externalReference,
  });
  refreshTeamOperations();
}

export async function createWorkforceEventAction(formData: FormData) {
  const identity = await requireOperator();
  const eventType = value(formData, "eventType");
  const severity = value(formData, "severity");
  const eventTypes = [
    "hired", "onboarding", "callout", "late", "no_show", "strike", "attendance_warning",
    "performance_coaching", "final_warning", "suspension", "termination",
    "resignation", "recognition", "safety", "other",
  ];
  if (!eventTypes.includes(eventType) || !["info", "low", "medium", "high", "critical"].includes(severity)) {
    throw new Error("Choose a supported workforce event and severity");
  }
  const summary = value(formData, "summary").slice(0, 1000);
  if (summary.length < 2) throw new Error("An evidence summary is required");
  await createWorkforceEvent({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    membershipId: uuid(formData, "membershipId"),
    eventType,
    severity,
    summary,
    privateDetails: value(formData, "privateDetails").slice(0, 4000) || null,
  });
  refreshTeamOperations();
}
