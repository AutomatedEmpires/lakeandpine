import { NextResponse } from "next/server";
import { z } from "zod";

import { sendOpsNotification } from "@/lib/email";
import { getIntakeReadinessIssues, requestIntakeEnabled } from "@/lib/env";
import { checkRequestRateLimit } from "@/lib/rate-limit";
import { isHoneypotFilled, readJsonBody, RequestBodyError } from "@/lib/request-security";
import { createServiceCase, recordServiceCaseNotificationDelivery, SERVICE_CASE_TYPES } from "@/lib/service-cases";

const optionalDate = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
);

const schema = z.object({
  idempotencyKey: z.string().uuid(),
  companyWebsite: z.string().max(200).optional().default(""),
  caseType: z.enum(SERVICE_CASE_TYPES),
  bookingReference: z.string().trim().max(80).optional().default(""),
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().max(30).optional().default(""),
  preferredDate: optionalDate,
  alternateDate: optionalDate,
  details: z.string().trim().min(10).max(4000),
  privacyConsent: z.literal(true),
}).superRefine((value, context) => {
  if (value.caseType === "reschedule" && !value.preferredDate) {
    context.addIssue({
      code: "custom",
      path: ["preferredDate"],
      message: "A preferred new date is required for reschedule requests",
    });
  }
});

export async function POST(request: Request) {
  if (!requestIntakeEnabled) {
    return NextResponse.json(
      { error: "The service desk is in preview mode and is not storing requests yet." },
      { status: 503 },
    );
  }

  const readinessIssues = getIntakeReadinessIssues().filter((issue) => issue !== "intake_disabled");
  if (readinessIssues.length > 0) {
    return NextResponse.json(
      { error: "The service desk is temporarily unavailable while operations are being configured." },
      { status: 503 },
    );
  }

  try {
    const rateLimit = await checkRequestRateLimit(request, {
      scope: "service_case",
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      const status = rateLimit.reason === "limit" ? 429 : 503;
      return NextResponse.json(
        { error: status === 429 ? "Too many requests. Please try again later." : "The service desk is temporarily unavailable." },
        { status, headers: { "retry-after": String(rateLimit.retryAfterSeconds) } },
      );
    }
  } catch {
    return NextResponse.json({ error: "The service desk is temporarily unavailable." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Please review the required fields." }, { status: 400 });
  }
  if (isHoneypotFilled(parsed.data.companyWebsite)) {
    return NextResponse.json({ accepted: true, reference: "LP-RECEIVED" }, { status: 202 });
  }

  try {
    const serviceCase = await createServiceCase(parsed.data);
    if (!serviceCase.duplicate) {
      const outcome = await sendOpsNotification(
        {
          kind: "service_case",
          summary: `${parsed.data.caseType} · ${serviceCase.reference}`,
          detailLines: [
            `Reference: ${serviceCase.reference}`,
            `Type: ${parsed.data.caseType}`,
            `Booking reference supplied: ${parsed.data.bookingReference ? "yes" : "no"}`,
            "Open the operator workspace for customer contact and case details.",
          ],
        },
        { suppress: false },
      );
      await recordServiceCaseNotificationDelivery(serviceCase.id, outcome);
    }
    return NextResponse.json({ reference: serviceCase.reference });
  } catch {
    return NextResponse.json(
      { error: "We couldn't record that request. Please try again shortly." },
      { status: 503 },
    );
  }
}
