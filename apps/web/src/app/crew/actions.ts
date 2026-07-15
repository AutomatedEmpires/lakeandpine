"use server";

import { revalidatePath } from "next/cache";

import { resolveCleanerIdentity } from "@/lib/auth";
import { requestTimeOff, respondToAssignment } from "@/lib/crew-data";
import {
  recordCleanerMileage,
  reportCleanerIssue,
  sendCleanerJobMessage,
  updateCleanerChecklistItem,
} from "@/lib/field-operations-data";
import {
  boundedDecimalValue,
  formUuid as uuid,
  formValue as value,
} from "@/lib/form-values";
import {
  createCleanerCallout,
  recordCleanerInventoryUsage,
  requestCleanerRestock,
  startCrewTimeEntry,
  stopCrewTimeEntry,
} from "@/lib/team-operations-data";

async function requireCleaner() {
  const identity = await resolveCleanerIdentity();
  if (identity.state !== "authed" && identity.state !== "preview") {
    throw new Error("Cleaner access required");
  }
  return identity;
}

export async function assignmentResponseAction(formData: FormData) {
  const identity = await requireCleaner();
  const assignmentId = String(formData.get("assignmentId") ?? "");
  const response = String(formData.get("response") ?? "");
  if (!assignmentId || !["accepted", "declined"].includes(response)) return;
  await respondToAssignment(
    identity.cleaner.id,
    assignmentId,
    response as "accepted" | "declined",
    identity.devOnly,
  );
  revalidatePath("/crew");
}

export async function timeOffRequestAction(formData: FormData) {
  const identity = await requireCleaner();
  if (identity.devOnly) throw new Error("Time-off writes are disabled in cleaner preview mode");

  const startLocal = String(formData.get("startAt") ?? "");
  const endLocal = String(formData.get("endAt") ?? "");
  const reasonCategory = String(formData.get("reasonCategory") ?? "unavailable");
  const validReasons = ["unavailable", "personal", "medical", "training", "other"] as const;
  if (
    !startLocal ||
    !endLocal ||
    !validReasons.includes(reasonCategory as (typeof validReasons)[number])
  ) {
    throw new Error("Invalid time-off request");
  }

  await requestTimeOff({
    cleanerId: identity.cleaner.id,
    membershipId: uuid(formData, "membershipId"),
    startLocal,
    endLocal,
    reasonCategory: reasonCategory as (typeof validReasons)[number],
    devOnly: identity.devOnly,
  });
  revalidatePath("/crew");
}

function quantity(formData: FormData, key: string, max: number) {
  const result = boundedDecimalValue(formData, key, {
    min: 0,
    max,
    decimals: 3,
  });
  if (result <= 0) throw new Error(`Invalid ${key}`);
  return result;
}

export async function cleanerInventoryUsageAction(formData: FormData) {
  const identity = await requireCleaner();
  const [productId, locationId] = value(formData, "inventoryKey").split("|");
  if (!productId || !locationId) throw new Error("Choose a team inventory item");
  await recordCleanerInventoryUsage({
    cleanerId: identity.cleaner.id,
    devOnly: identity.devOnly,
    membershipId: uuid(formData, "membershipId"),
    productId,
    locationId,
    quantity: quantity(formData, "quantity", 100_000),
    note: value(formData, "note").slice(0, 1000) || null,
  });
  revalidatePath("/crew");
  revalidatePath("/operator/inventory");
}

export async function cleanerRestockRequestAction(formData: FormData) {
  const identity = await requireCleaner();
  const [productId, locationId] = value(formData, "inventoryKey").split("|");
  if (!productId || !locationId) throw new Error("Choose a team inventory item");
  await requestCleanerRestock({
    cleanerId: identity.cleaner.id,
    devOnly: identity.devOnly,
    membershipId: uuid(formData, "membershipId"),
    productId,
    locationId,
    quantity: quantity(formData, "quantity", 100_000),
  });
  revalidatePath("/crew");
  revalidatePath("/operator/inventory");
}

export async function startTimeEntryAction(formData: FormData) {
  const identity = await requireCleaner();
  await startCrewTimeEntry({
    cleanerId: identity.cleaner.id,
    devOnly: identity.devOnly,
    allocationId: uuid(formData, "allocationId"),
  });
  revalidatePath("/crew");
  revalidatePath("/operator/time");
}

export async function stopTimeEntryAction(formData: FormData) {
  const identity = await requireCleaner();
  const breakMinutes = Number(value(formData, "breakMinutes") || "0");
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 720) {
    throw new Error("Break minutes must be between 0 and 720");
  }
  await stopCrewTimeEntry({
    cleanerId: identity.cleaner.id,
    devOnly: identity.devOnly,
    entryId: uuid(formData, "entryId"),
    breakMinutes,
  });
  revalidatePath("/crew");
  revalidatePath("/operator/time");
}

export async function cleanerCalloutAction(formData: FormData) {
  const identity = await requireCleaner();
  const summary = value(formData, "summary").slice(0, 1000);
  if (summary.length < 2) throw new Error("Explain the callout and immediate scheduling impact");
  await createCleanerCallout({
    cleanerId: identity.cleaner.id,
    devOnly: identity.devOnly,
    membershipId: uuid(formData, "membershipId"),
    summary,
  });
  revalidatePath("/crew");
  revalidatePath("/operator/workforce");
}

export async function cleanerJobMessageAction(formData: FormData) {
  const identity = await requireCleaner();
  const template = value(formData, "template");
  if (!["running_15_late", "running_30_late", "custom"].includes(template)) {
    throw new Error("Choose a supported customer update");
  }
  const body = value(formData, "body").slice(0, 2000) || null;
  if (template === "custom" && (!body || body.length < 2)) {
    throw new Error("Add the customer update");
  }
  await sendCleanerJobMessage({
    cleanerId: identity.cleaner.id,
    devOnly: identity.devOnly,
    allocationId: uuid(formData, "allocationId"),
    template: template as "running_15_late" | "running_30_late" | "custom",
    body,
  });
  revalidatePath("/crew");
  revalidatePath("/dashboard");
  revalidatePath("/operator/field");
}

export async function cleanerMileageAction(formData: FormData) {
  const identity = await requireCleaner();
  const purpose = value(formData, "purpose");
  const purposes = ["to_job", "between_jobs", "supply_run", "training", "other"];
  if (!purposes.includes(purpose)) throw new Error("Choose a mileage purpose");
  const serviceDate = value(formData, "serviceDate");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) throw new Error("Choose a service date");
  const allocationId = value(formData, "allocationId");
  await recordCleanerMileage({
    cleanerId: identity.cleaner.id,
    devOnly: identity.devOnly,
    membershipId: uuid(formData, "membershipId"),
    allocationId: allocationId ? uuid(formData, "allocationId") : null,
    serviceDate,
    miles: boundedDecimalValue(formData, "miles", { min: 0.01, max: 1000, decimals: 2 }),
    purpose,
    vehicleLabel: value(formData, "vehicleLabel").slice(0, 120) || null,
    note: value(formData, "note").slice(0, 1000) || null,
  });
  revalidatePath("/crew");
  revalidatePath("/operator/field");
}

export async function cleanerIssueAction(formData: FormData) {
  const identity = await requireCleaner();
  const issueType = value(formData, "issueType");
  const severity = value(formData, "severity");
  const issueTypes = [
    "schedule_conflict", "access", "safety", "vehicle", "customer_note",
    "scope", "inventory", "quality", "other",
  ];
  if (!issueTypes.includes(issueType) || !["low", "medium", "high", "critical"].includes(severity)) {
    throw new Error("Choose a supported issue and severity");
  }
  const summary = value(formData, "summary").slice(0, 1000);
  if (summary.length < 2) throw new Error("Explain the issue and immediate impact");
  const allocationId = value(formData, "allocationId");
  await reportCleanerIssue({
    cleanerId: identity.cleaner.id,
    devOnly: identity.devOnly,
    membershipId: uuid(formData, "membershipId"),
    allocationId: allocationId ? uuid(formData, "allocationId") : null,
    issueType,
    severity,
    summary,
    privateDetails: value(formData, "privateDetails").slice(0, 4000) || null,
  });
  revalidatePath("/crew");
  revalidatePath("/dashboard");
  revalidatePath("/operator/field");
}

export async function cleanerChecklistAction(formData: FormData) {
  const identity = await requireCleaner();
  const state = value(formData, "state");
  if (!(["pending", "completed", "skipped"] as const).includes(state as "pending")) {
    throw new Error("Choose a supported checklist state");
  }
  const note = value(formData, "note").slice(0, 1000) || null;
  if (state === "skipped" && (!note || note.length < 2)) {
    throw new Error("Explain why this checklist step was skipped");
  }
  await updateCleanerChecklistItem({
    cleanerId: identity.cleaner.id,
    devOnly: identity.devOnly,
    allocationId: uuid(formData, "allocationId"),
    itemId: uuid(formData, "itemId"),
    state: state as "pending" | "completed" | "skipped",
    note,
    version: boundedDecimalValue(formData, "version", { min: 1, max: 1_000_000 }),
  });
  revalidatePath("/crew");
  revalidatePath("/operator");
}
