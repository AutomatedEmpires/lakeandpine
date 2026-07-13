"use server";

import { revalidatePath } from "next/cache";

import { resolveCleanerIdentity } from "@/lib/auth";
import { requestTimeOff, respondToAssignment } from "@/lib/crew-data";

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
    startLocal,
    endLocal,
    reasonCategory: reasonCategory as (typeof validReasons)[number],
    devOnly: identity.devOnly,
  });
  revalidatePath("/crew");
}
