export type EmailMessage = {
  from: string;
  replyTo: string;
  to: string;
  subject: string;
  html: string;
};

export type EmailTransport = {
  send(message: EmailMessage): Promise<unknown>;
};

export type EmailDeliveryContext = {
  suppress: boolean;
};

export type BookingConfirmationInput = {
  to: string;
  name: string;
  serviceTitle: string;
  date: string;
  window: string;
  estimateDollars: number;
  bookingId: string;
};

export type OpsNotificationInput = {
  kind: "booking" | "lead";
  summary: string;
  detailLines: string[];
};

export function createEmailService(config: {
  apiKey?: string;
  appUrl: string;
  businessEmail?: string;
  businessPhone?: string;
  from?: string;
  replyTo?: string;
  formatLongDate(isoDate: string): string;
  createTransport(apiKey: string): EmailTransport;
  log?(message: string): void;
  logError?(message: string, error: unknown): void;
}) {
  const log = config.log ?? console.log;
  const logError = config.logError ?? console.error;
  const emailFooterParts = [
    "Lake & Pine Cleaning Co.",
    config.businessPhone,
  ].filter(Boolean);
  let transport: EmailTransport | undefined;

  function getTransport(): EmailTransport | null {
    if (!config.apiKey) return null;
    transport ??= config.createTransport(config.apiKey);
    return transport;
  }

  async function deliver(
    message: Omit<EmailMessage, "from" | "replyTo">,
    delivery: EmailDeliveryContext,
    skippedDescription: string,
  ): Promise<void> {
    if (delivery.suppress) {
      log(`[email:suppressed] authorized runtime smoke — ${skippedDescription}`);
      return;
    }

    const client = getTransport();
    if (!client || !config.from || !config.replyTo || !message.to) {
      log(`[email:skipped] transactional email is not fully configured — ${skippedDescription}`);
      return;
    }

    try {
      await client.send({ ...message, from: config.from, replyTo: config.replyTo });
    } catch (error) {
      // Email must never fail a booking or lead write.
      logError("[email:error]", error);
    }
  }

  async function sendBookingConfirmation(
    input: BookingConfirmationInput,
    delivery: EmailDeliveryContext,
  ): Promise<void> {
    const longDate = config.formatLongDate(input.date);
    const subject = `Booking request received — ${input.serviceTitle}, ${longDate}`;
    await deliver(
      {
        to: input.to,
        subject,
        html: `
          <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#061f1b">
            <h1 style="letter-spacing:-.04em">Your clean is requested, ${escapeHtml(input.name)}.</h1>
            <p style="color:#607a75;font-size:16px;line-height:1.5">
              <strong>${escapeHtml(input.serviceTitle)}</strong> ·
              ${escapeHtml(longDate)} · ${escapeHtml(input.window)} arrival window.
            </p>
            <p style="color:#607a75;font-size:16px;line-height:1.5">
              Starting estimate: <strong>$${input.estimateDollars}</strong>. This is a starting
              planning anchor. Your requested window is not an appointment; an operator reviews
              scope and capacity before confirming service.
            </p>
            <p style="margin:28px 0">
              <a href="${config.appUrl}/dashboard"
                 style="background:#055f4f;color:#fff;padding:14px 22px;border-radius:14px;text-decoration:none;font-weight:700">
                Open your dashboard
              </a>
            </p>
            <p style="color:#88a39d;font-size:13px">
              ${emailFooterParts.map((part) => escapeHtml(String(part))).join(" · ")}
              <br />Reference: ${escapeHtml(input.bookingId)}
            </p>
          </div>`,
      },
      delivery,
      `would send "${subject}" to ${input.to}`,
    );
  }

  async function sendOpsNotification(
    input: OpsNotificationInput,
    delivery: EmailDeliveryContext,
  ): Promise<void> {
    const subject = `New ${input.kind}: ${input.summary}`;
    await deliver(
      {
        to: config.businessEmail ?? "",
        subject,
        html: `<div style="font-family:ui-monospace,monospace;color:#061f1b"><h2>${escapeHtml(subject)}</h2><ul>${input.detailLines
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join("")}</ul></div>`,
      },
      delivery,
      `would notify ops: "${subject}"`,
    );
  }

  return { sendBookingConfirmation, sendOpsNotification };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
