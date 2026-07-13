import "server-only";

import { Resend } from "resend";

import { APP_URL, BUSINESS_EMAIL, BUSINESS_PHONE, optionalEnv } from "./env";
import { createEmailService } from "./email-service";
import { formatLongDate } from "./scheduling";

const FROM = process.env.RESEND_FROM_EMAIL || `Lake & Pine <${BUSINESS_EMAIL}>`;

// Resend remains lazy: authorized runtime smoke requests return before a
// transport is constructed, even when the server process has a real API key.
export const { sendBookingConfirmation, sendOpsNotification } = createEmailService({
  apiKey: optionalEnv("RESEND_API_KEY"),
  appUrl: APP_URL,
  businessEmail: BUSINESS_EMAIL,
  businessPhone: BUSINESS_PHONE,
  from: FROM,
  formatLongDate,
  createTransport: (apiKey) => {
    const resend = new Resend(apiKey);
    return { send: (message) => resend.emails.send(message) };
  },
});
