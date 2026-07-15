"use server";

import { revalidatePath } from "next/cache";

import { resolveOperatorIdentity } from "@/lib/auth";
import {
  addInternalNote,
  completeFollowUp,
  setChecklistItemState,
  updateBookingStatus,
} from "@/lib/data";
import {
  canTransitionJob,
  JOB_STATUSES,
  type JobStatus,
} from "@/lib/service-planning";
import { hasCapability } from "@/lib/team-operations";
import { getOperationsAccess } from "@/lib/team-operations-data";

async function requireOperator() {
  const identity = await resolveOperatorIdentity();
  if (identity.state !== "authed" && identity.state !== "preview") {
    throw new Error("Operator access required");
  }
  const access = await getOperationsAccess(identity.operator.id, identity.devOnly);
  if (
    !access.organizationId ||
    !hasCapability(access.memberships, "view_network", access.organizationId, null)
  ) {
    throw new Error("Owner or GM access is required for the national service desk");
  }
  return identity;
}

export async function updateJobStatusAction(formData: FormData) {
  const operator = await requireOperator();
  const bookingId = String(formData.get("bookingId") ?? "");
  const from = String(formData.get("from") ?? "") as JobStatus;
  const to = String(formData.get("to") ?? "") as JobStatus;
  if (!bookingId || !JOB_STATUSES.includes(from) || !JOB_STATUSES.includes(to)) return;
  if (!canTransitionJob(from, to)) throw new Error(`Invalid job transition: ${from} → ${to}`);
  await updateBookingStatus(
    bookingId,
    from,
    to,
    operator.devOnly,
    operator.operator.id,
  );
  revalidatePath("/operator");
}

export async function checklistItemAction(formData: FormData) {
  const operator = await requireOperator();
  const bookingId = String(formData.get("bookingId") ?? "");
  const itemId = String(formData.get("itemId") ?? "");
  const state = String(formData.get("state") ?? "");
  if (!bookingId || !itemId || !["pending", "completed", "skipped"].includes(state)) return;
  await setChecklistItemState(
    bookingId,
    itemId,
    state as "pending" | "completed" | "skipped",
    operator.devOnly,
    operator.operator.id,
  );
  revalidatePath("/operator");
}

export async function addInternalNoteAction(formData: FormData) {
  const operator = await requireOperator();
  const bookingId = String(formData.get("bookingId") ?? "");
  const body = String(formData.get("body") ?? "").trim().slice(0, 4000);
  if (!bookingId || !body) return;
  await addInternalNote(
    bookingId,
    body,
    operator.devOnly,
    operator.operator.id,
  );
  revalidatePath("/operator");
}

export async function completeFollowUpAction(formData: FormData) {
  const operator = await requireOperator();
  const bookingId = String(formData.get("bookingId") ?? "");
  const followUpId = String(formData.get("followUpId") ?? "");
  if (!bookingId || !followUpId) return;
  await completeFollowUp(
    bookingId,
    followUpId,
    operator.devOnly,
    operator.operator.id,
  );
  revalidatePath("/operator");
}
