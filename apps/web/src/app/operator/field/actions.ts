"use server";

import { revalidatePath } from "next/cache";

import { resolveOperatorIdentity } from "@/lib/auth";
import {
  approveRouteException,
  assignTeamDuty,
  cancelTeamDuty,
  confirmApprovedSchedule,
  createCustomerScheduleProposal,
  recordTipIntentStatus,
  resolveFieldIssue,
  reviewMileageEntry,
  updateBranchFieldRules,
} from "@/lib/field-operations-data";
import type { ArrivalWindowId } from "@/lib/field-operations";
import {
  boundedDecimalValue,
  formUuid as uuid,
  formValue as value,
  uuidValue,
} from "@/lib/form-values";

async function requireOperator() {
  const identity = await resolveOperatorIdentity();
  if (identity.state !== "authed" && identity.state !== "preview") {
    throw new Error("Operator access required");
  }
  return identity;
}

function refresh() {
  revalidatePath("/operator/field");
  revalidatePath("/operator/schedule");
  revalidatePath("/dashboard");
  revalidatePath("/crew");
}

function timeValue(formData: FormData, key: string) {
  const result = value(formData, key);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result)) {
    throw new Error(`Invalid ${key}`);
  }
  return result;
}

export async function updateBranchFieldRulesAction(formData: FormData) {
  const identity = await requireOperator();
  const supportEmail = value(formData, "supportEmail").toLowerCase().slice(0, 320) || null;
  if (supportEmail && !/^\S+@\S+\.\S+$/.test(supportEmail)) {
    throw new Error("Enter a valid branch support email");
  }
  await updateBranchFieldRules({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    originLabel: value(formData, "originLabel").slice(0, 200),
    originLatitude: boundedDecimalValue(formData, "originLatitude", {
      min: -90,
      max: 90,
      decimals: 6,
    }),
    originLongitude: boundedDecimalValue(formData, "originLongitude", {
      min: -180,
      max: 180,
      decimals: 6,
    }),
    serviceRadiusMiles: boundedDecimalValue(formData, "serviceRadiusMiles", {
      min: 1,
      max: 250,
      decimals: 2,
    }),
    operatingStartTime: timeValue(formData, "operatingStartTime"),
    latestArrivalTime: timeValue(formData, "latestArrivalTime"),
    hardFinishTime: timeValue(formData, "hardFinishTime"),
    supportEmail,
    publicPhone: value(formData, "publicPhone").slice(0, 40) || null,
  });
  refresh();
}

export async function approveRouteExceptionAction(formData: FormData) {
  const identity = await requireOperator();
  const reason = value(formData, "reason").slice(0, 1000);
  if (reason.length < 4) throw new Error("Document the route exception reason");
  await approveRouteException({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    assessmentId: uuid(formData, "assessmentId"),
    reason,
  });
  refresh();
}

export async function createScheduleProposalAction(formData: FormData) {
  const identity = await requireOperator();
  const windowId = value(formData, "windowId") as ArrivalWindowId;
  await createCustomerScheduleProposal({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    allocationId: uuid(formData, "allocationId"),
    windowId,
    note: value(formData, "note").slice(0, 2000) || null,
  });
  refresh();
}

export async function confirmApprovedScheduleAction(formData: FormData) {
  const identity = await requireOperator();
  await confirmApprovedSchedule({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    scheduleId: uuid(formData, "scheduleId"),
  });
  refresh();
}

export async function reviewMileageAction(formData: FormData) {
  const identity = await requireOperator();
  const status = value(formData, "status");
  if (status !== "approved" && status !== "rejected") {
    throw new Error("Choose a mileage decision");
  }
  await reviewMileageEntry({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    mileageId: uuid(formData, "mileageId"),
    version: boundedDecimalValue(formData, "version", { min: 1, max: 1_000_000 }),
    status,
    note: value(formData, "note").slice(0, 1000) || null,
  });
  refresh();
}

export async function resolveFieldIssueAction(formData: FormData) {
  const identity = await requireOperator();
  const status = value(formData, "status");
  if (!["acknowledged", "resolved", "dismissed"].includes(status)) {
    throw new Error("Choose an issue decision");
  }
  const note = value(formData, "note").slice(0, 2000) || null;
  if (["resolved", "dismissed"].includes(status) && !note) {
    throw new Error("Document the resolution before closing an issue");
  }
  await resolveFieldIssue({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    issueId: uuid(formData, "issueId"),
    version: boundedDecimalValue(formData, "version", { min: 1, max: 1_000_000 }),
    status: status as "acknowledged" | "resolved" | "dismissed",
    note,
    customerVisible: formData.get("customerVisible") === "on",
  });
  refresh();
}

export async function assignTeamDutyAction(formData: FormData) {
  const identity = await requireOperator();
  const [membershipId, dutyKind] = value(formData, "dutyAssignment").split("|");
  if (!membershipId) throw new Error("Choose an eligible duty assignment");
  if (dutyKind !== "manager_on_duty" && dutyKind !== "shift_lead_on_duty") {
    throw new Error("Choose a duty role");
  }
  await assignTeamDuty({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    membershipId: uuidValue(membershipId, "duty assignment"),
    startsAt: value(formData, "startsAt"),
    endsAt: value(formData, "endsAt"),
    dutyKind,
    note: value(formData, "note").slice(0, 1000) || null,
  });
  refresh();
}

export async function cancelTeamDutyAction(formData: FormData) {
  const identity = await requireOperator();
  await cancelTeamDuty({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    dutyId: uuid(formData, "dutyId"),
  });
  refresh();
}

export async function recordTipIntentStatusAction(formData: FormData) {
  const identity = await requireOperator();
  const status = value(formData, "status");
  if (!["recorded", "declined", "canceled"].includes(status)) {
    throw new Error("Choose a tip intent decision");
  }
  await recordTipIntentStatus({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    teamId: uuid(formData, "teamId"),
    tipId: uuid(formData, "tipId"),
    version: boundedDecimalValue(formData, "version", { min: 1, max: 1_000_000 }),
    status: status as "recorded" | "declined" | "canceled",
    providerReference: value(formData, "providerReference").slice(0, 200) || null,
  });
  refresh();
}
