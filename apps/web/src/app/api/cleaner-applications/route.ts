import { NextResponse } from "next/server";
import { z } from "zod";

import { createCleanerApplication } from "@/lib/cleaner-applications";
import { sendOpsNotification } from "@/lib/email";
import { cleanerApplicationsEnabled, getIntakeReadinessIssues } from "@/lib/env";
import { checkRequestRateLimit } from "@/lib/rate-limit";
import { isHoneypotFilled, readJsonBody, RequestBodyError } from "@/lib/request-security";

const schema = z.object({
  idempotencyKey: z.string().uuid(),
  companyWebsite: z.string().max(200).optional().default(""),
  fullName: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(7).max(30),
  homeBase: z.string().trim().min(2).max(120),
  servicePrograms: z.array(z.enum(["estate", "construction", "marine", "commercial"])).min(1).max(4),
  territories: z.array(z.string().trim().min(2).max(80)).min(1).max(12),
  availabilitySummary: z.string().trim().min(10).max(1000),
  experienceSummary: z.string().trim().min(10).max(2000),
  transportationConfirmed: z.literal(true),
  privacyConsent: z.literal(true),
});

export async function POST(request: Request) {
  if (!cleanerApplicationsEnabled) {
    return NextResponse.json({ error: "Team applications are not open yet." }, { status: 503 });
  }
  const readinessIssues = getIntakeReadinessIssues().filter((issue) => issue !== "intake_disabled");
  if (readinessIssues.length > 0) {
    return NextResponse.json({ error: "Team applications are temporarily unavailable." }, { status: 503 });
  }

  try {
    const rateLimit = await checkRequestRateLimit(request, {
      scope: "cleaner_application",
      limit: 3,
      windowMs: 24 * 60 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      const status = rateLimit.reason === "limit" ? 429 : 503;
      return NextResponse.json(
        { error: status === 429 ? "Too many applications from this connection. Please try again tomorrow." : "Team applications are temporarily unavailable." },
        { status, headers: { "retry-after": String(rateLimit.retryAfterSeconds) } },
      );
    }
  } catch {
    return NextResponse.json({ error: "Team applications are temporarily unavailable." }, { status: 503 });
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
    return NextResponse.json({ accepted: true, reference: "TEAM-RECEIVED" }, { status: 202 });
  }

  try {
    const application = await createCleanerApplication(parsed.data);
    if (!application.duplicate) {
      await sendOpsNotification(
        {
          kind: "cleaner_application",
          summary: application.reference,
          detailLines: [
            `Reference: ${application.reference}`,
            `Programs: ${parsed.data.servicePrograms.join(", ")}`,
            `Territories selected: ${parsed.data.territories.length}`,
            "Open the operator workspace for applicant contact and details.",
          ],
        },
        { suppress: false },
      );
    }
    return NextResponse.json({ reference: application.reference });
  } catch {
    return NextResponse.json({ error: "We couldn't record that application. Please try again shortly." }, { status: 503 });
  }
}

