import "server-only";

import { deriveBookingReference } from "./booking-reference";
import { sql } from "./db";
import { sendBookingConfirmation, sendOpsNotification } from "./email";

type ClaimedNotification = {
  id: string;
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
  case_contact: { name?: string; email?: string; phone?: string } | null;
};

export async function retryOutboxNotification(outboxId: string, devOnly: boolean) {
  const rows = await sql<ClaimedNotification[]>`
    with claimed as (
      update notification_outbox o set status = 'processing', locked_at = now()
      where o.id = ${outboxId}
        and o.notification_type in ('customer_confirmation', 'ops_notification')
        and o.status in ('pending', 'retry', 'failed')
        and (${devOnly} = false
          or exists(select 1 from bookings b where b.id = o.booking_id and b.is_dev_seed)
          or exists(select 1 from service_cases c where c.id = o.service_case_id and c.is_dev_seed))
      returning *
    )
    select o.id, o.booking_id, o.service_case_id, o.notification_type,
      b.contact as booking_contact, s.title as service_title,
      to_char(b.scheduled_date, 'YYYY-MM-DD') as scheduled_date,
      b.scheduled_window, b.qualification_status, b.planning_direction,
      c.public_reference as case_reference, c.case_type, c.contact as case_contact
    from claimed o
    left join bookings b on b.id = o.booking_id
    left join services s on s.id = b.service_id
    left join service_cases c on c.id = o.service_case_id`;
  const item = rows[0];
  if (!item) throw new Error("Notification is no longer eligible for retry");

  let outcome: "sent" | "suppressed" | "skipped" | "failed";
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
      { suppress: devOnly },
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
      { suppress: devOnly },
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
      { suppress: devOnly },
    );
  } else {
    outcome = "failed";
  }

  const status = outcome === "sent" ? "sent" : outcome === "suppressed" ? "canceled" : outcome === "failed" ? "retry" : "failed";
  await sql`update notification_outbox set status = ${status}, attempt_count = attempt_count + 1,
      sent_at = case when ${status} = 'sent' then now() else sent_at end,
      next_attempt_at = case when ${status} = 'retry' then now() + interval '15 minutes' else next_attempt_at end,
      last_error_code = case when ${status} = 'sent' then null else ${outcome} end,
      locked_at = null where id = ${item.id}`;
  return outcome;
}
