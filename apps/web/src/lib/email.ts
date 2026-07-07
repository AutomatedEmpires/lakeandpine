import "server-only";

import { Resend } from "resend";

import { APP_URL, BUSINESS_EMAIL, BUSINESS_PHONE, optionalEnv } from "./env";
import { formatLongDate } from "./scheduling";

// Resend is the cross-portfolio email standard. Without RESEND_API_KEY every
// send is a structured no-op (logged) so the booking flow never depends on it.
function getResend(): Resend | null {
  const key = optionalEnv("RESEND_API_KEY");
  return key ? new Resend(key) : null;
}

const FROM = process.env.RESEND_FROM_EMAIL || `Lake & Pine <${BUSINESS_EMAIL}>`;

export async function sendBookingConfirmation(input: {
  to: string;
  name: string;
  serviceTitle: string;
  date: string;
  window: string;
  estimateDollars: number;
  bookingId: string;
}): Promise<void> {
  const resend = getResend();
  const subject = `Booking request received — ${input.serviceTitle}, ${formatLongDate(input.date)}`;
  if (!resend) {
    console.log(`[email:skipped] RESEND_API_KEY unset — would send "${subject}" to ${input.to}`);
    return;
  }
  try {
    await resend.emails.send({
      from: FROM,
      to: input.to,
      subject,
      html: `
        <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#061f1b">
          <h1 style="letter-spacing:-.04em">Your clean is requested, ${escapeHtml(input.name)}.</h1>
          <p style="color:#607a75;font-size:16px;line-height:1.5">
            <strong>${escapeHtml(input.serviceTitle)}</strong> ·
            ${escapeHtml(formatLongDate(input.date))} · ${escapeHtml(input.window)} arrival window.
          </p>
          <p style="color:#607a75;font-size:16px;line-height:1.5">
            Starting estimate: <strong>$${input.estimateDollars}</strong>. This is a starting
            anchor — we confirm the final quote with you before the visit. We'll text when your
            cleaner is on the way.
          </p>
          <p style="margin:28px 0">
            <a href="${APP_URL}/dashboard"
               style="background:#055f4f;color:#fff;padding:14px 22px;border-radius:14px;text-decoration:none;font-weight:700">
              Open your dashboard
            </a>
          </p>
          <p style="color:#88a39d;font-size:13px">
            Lake &amp; Pine Cleaning Co. · ${escapeHtml(BUSINESS_PHONE)} · Licensed · Bonded · Insured
            <br />Reference: ${escapeHtml(input.bookingId)}
          </p>
        </div>`,
    });
  } catch (error) {
    // Email must never fail a booking.
    console.error("[email:error]", error);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
