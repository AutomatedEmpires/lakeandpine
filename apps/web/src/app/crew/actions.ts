"use server";

import { revalidatePath } from "next/cache";

import { resolveCleanerIdentity } from "@/lib/auth";
import { requestTimeOff, respondToAssignment } from "@/lib/crew-data";
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
