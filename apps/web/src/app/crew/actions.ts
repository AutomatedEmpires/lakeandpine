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

  const startAt = new Date(String(formData.get("startAt") ?? ""));
  const endAt = new Date(String(formData.get("endAt") ?? ""));
  const reasonCategory = String(formData.get("reasonCategory") ?? "unavailable");
  const validReasons = ["unavailable", "personal", "medical", "training", "other"] as const;
  if (
    Number.isNaN(startAt.getTime()) ||
    Number.isNaN(endAt.getTime()) ||
    startAt.getTime() < Date.now() - 5 * 60 * 1000 ||
    endAt <= startAt ||
    endAt.getTime() - startAt.getTime() > 14 * 24 * 60 * 60 * 1000 ||
    !validReasons.includes(reasonCategory as (typeof validReasons)[number])
  ) {
    throw new Error("Invalid time-off request");
  }

  await requestTimeOff({
    cleanerId: identity.cleaner.id,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    reasonCategory: reasonCategory as (typeof validReasons)[number],
  });
  revalidatePath("/crew");
}

