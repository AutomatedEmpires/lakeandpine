import "server-only";

import { deriveBookingReference } from "./booking-reference";
import { sendBookingConfirmation, sendOpsNotification } from "./email";
import { withStaffActor } from "./operations-console-data";

type ClaimedNotification = {
  id: string;
  claim_locked_at: string;
  delivery_idempotency_key: string;
  booking_id: string | null;
  service_case_id: string | null;
  notification_type: "customer_confirmation" | "ops_notification";
  booking_contact: { name?: string; email?: string; phone?: string; zip?: string } | null;
  service_title: string | null;
  scheduled_date: string | null;
  scheduled_window: string | null;
  qualification_status: string | null;
  planning_direction: string | null;
  case_reference: string | null;
  case_type: string | null;
};

export async function retryOutboxNotification(
  customerId: string,
  outboxId: string,
  devOnly: boolean,
) {
  const item = await withStaffActor(customerId, async (tx) => {
    const rows = await tx<ClaimedNotification[]>`
      select *
      from private.claim_notification_outbox_delivery(${outboxId}, ${devOnly})`;
    return rows[0];
  });
  if (!item) throw new Error("Notification is no longer eligible for retry");

  let outcome: "sent" | "suppressed" | "skipped" | "failed";
  try {
    if (item.notification_type === "customer_confirmation" && item.booking_id && item.booking_contact) {
      outcome = await sendBookingConfirmation(
        {
          to: item.booking_contact.email ?? "",
          name: item.booking_contact.name ?? "there",
          serviceTitle: item.service_title ?? "Property care request",
          date: item.scheduled_date ?? new Date().toISOString().slice(0, 10),
          window: item.scheduled_window ?? "Preferred window",
          bookingId: item.booking_id,
          publicReference: deriveBookingReference(item.booking_id),
        },
        {
          suppress: devOnly,
          idempotencyKey: item.delivery_idempotency_key,
        },
      );
    } else if (item.service_case_id) {
      outcome = await sendOpsNotification(
        {
          kind: "service_case",
          summary: `${item.case_type?.replaceAll("_", " ") ?? "service case"} · ${item.case_reference ?? item.service_case_id}`,
          detailLines: [
            `Reference: ${item.case_reference ?? item.service_case_id}`,
            `Type: ${item.case_type ?? "not recorded"}`,
            "Open operations control for private customer contact and case details.",
          ],
        },
        {
          suppress: devOnly,
          idempotencyKey: item.delivery_idempotency_key,
        },
      );
    } else if (item.booking_id && item.booking_contact) {
      outcome = await sendOpsNotification(
        {
          kind: "booking",
          summary: `${item.service_title ?? "Property care request"} · ${item.scheduled_date ?? "date review"} · ${item.qualification_status?.replaceAll("_", " ") ?? "review"}`,
          detailLines: [
            `Customer: ${item.booking_contact.name ?? "Unnamed"} (${item.booking_contact.email ?? "no email"}, ${item.booking_contact.phone ?? "no phone"}, ${item.booking_contact.zip ?? "no ZIP"})`,
            `Planning: ${item.planning_direction ?? "operator review required"}`,
            `Reference: ${deriveBookingReference(item.booking_id)}`,
          ],
        },
        {
          suppress: devOnly,
          idempotencyKey: item.delivery_idempotency_key,
        },
      );
    } else {
      outcome = "failed";
    }
  } catch {
    outcome = "failed";
  }

  await withStaffActor(customerId, async (tx) => {
    const rows = await tx<{ finished: boolean }[]>`
      select private.finish_notification_outbox_delivery(
        ${item.id}, ${item.claim_locked_at}::timestamptz, ${outcome}
      ) as finished`;
    if (!rows[0]?.finished) {
      throw new Error("Notification retry claim is no longer active");
    }
  });
  return outcome;
}
