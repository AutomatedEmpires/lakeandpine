import { auth, currentUser } from "@clerk/nextjs/server";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { deriveBookingReference } from "@/lib/booking-reference";
import {
  createBooking,
  getCustomerByEmail,
  recordBookingNotificationDelivery,
  upsertCustomerFromClerk,
} from "@/lib/data";
import { sendBookingConfirmation, sendOpsNotification } from "@/lib/email";
import {
  authEnabled,
  getIntakeReadinessIssues,
  requestIntakeEnabled,
} from "@/lib/env";
import { deriveRequestPlanning, PREMIUM_PROGRAMS } from "@/lib/premium-request";
import { checkRequestRateLimit } from "@/lib/rate-limit";
import {
  isHoneypotFilled,
  readJsonBody,
  RequestBodyError,
} from "@/lib/request-security";
import { getRuntimeSmokeDisposition } from "@/lib/runtime-smoke-request";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PROGRAM_TITLES = {
  estate: "Private Estate Care",
  construction: "Construction Handoff",
  marine: "Lake & Marine Interior Care",
  commercial: "Select Commercial Care",
} as const;

const bookingSchema = z.object({
  idempotencyKey: z.string().uuid(),
  companyWebsite: z.string().max(200).optional().default(""),
  program: z.enum(PREMIUM_PROGRAMS),
  property: z.object({
    sizeBand: z.enum(["compact", "standard", "large", "exceptional"]),
    condition: z.enum(["maintained", "detailed", "project"]),
    zoneCount: z.number().int().min(1).max(80),
    context: z.string().min(1).max(80),
    cadence: z.enum([
      "project",
      "weekly",
      "biweekly",
      "monthly",
      "seasonal",
      "custom",
    ]),
  }),
  scope: z.object({
    priorities: z.string().trim().min(10).max(3000),
    finishNotes: z.string().trim().max(1000).default(""),
  }),
  scheduling: z.object({
    preferredDate: z.string().regex(DATE_PATTERN),
    alternateDates: z.array(z.string().regex(DATE_PATTERN)).min(1).max(2),
    windowPreference: z.enum([
      "Morning",
      "Midday",
      "Afternoon",
      "After-hours review",
    ]),
    deadlineCritical: z.boolean(),
    accessComplex: z.boolean(),
  }),
  contact: z.object({
    name: z.string().trim().min(2).max(200),
    email: z.string().trim().email().max(320),
    phone: z.string().trim().min(7).max(30),
    zip: z.string().trim().min(3).max(12),
  }),
  acknowledgements: z.object({
    siteReady: z.literal(true),
    privacyConsent: z.literal(true),
    termsConsent: z.literal(true),
    photoPermission: z.boolean(),
    version: z.string().regex(DATE_PATTERN),
  }),
});

function todayInOperatingTimezone() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function validPlanningDate(value: string) {
  const today = todayInOperatingTimezone();
  const lastDate = new Date(`${today}T12:00:00Z`);
  lastDate.setUTCMonth(lastDate.getUTCMonth() + 18);
  return value >= today && value <= lastDate.toISOString().slice(0, 10);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function checklistFor(
  program: keyof typeof PROGRAM_TITLES,
  photoPermission: boolean,
) {
  const verticalTask = {
    estate: "Follow the approved room, finish, and product care plan",
    construction:
      "Confirm trade completion and final-clean site readiness before mobilization",
    marine: "Confirm vessel access and interior-only material restrictions",
    commercial: "Confirm security, occupant, and operating-window requirements",
  }[program];
  return [
    {
      roomLabel: null,
      label: "Confirm written scope, exclusions, access, and safety conditions",
    },
    { roomLabel: null, label: verticalTask },
    {
      roomLabel: null,
      label: "Complete agreed cleaning scope with finish-safe methods",
    },
    ...(photoPermission
      ? [
          {
            roomLabel: null,
            label:
              "Capture approved closeout photos without people or sensitive information",
          },
        ]
      : []),
    {
      roomLabel: null,
      label:
        "Run operator quality review and document exceptions before closeout",
    },
  ];
}

export async function POST(request: Request) {
  const smokeDisposition = getRuntimeSmokeDisposition(request.headers);
  if (smokeDisposition === "rejected") {
    return NextResponse.json(
      { error: "Invalid runtime smoke authorization" },
      { status: 403 },
    );
  }
  if (!requestIntakeEnabled && smokeDisposition !== "authorized") {
    return NextResponse.json(
      {
        error:
          "Request intake is in preview mode and is not storing customer data yet.",
      },
      { status: 503 },
    );
  }

  const readinessIssues = getIntakeReadinessIssues().filter(
    (issue) => issue !== "intake_disabled",
  );
  if (smokeDisposition !== "authorized" && readinessIssues.length > 0) {
    return NextResponse.json(
      {
        error:
          "Request intake is temporarily unavailable while operations are being configured.",
      },
      { status: 503 },
    );
  }

  if (smokeDisposition !== "authorized") {
    try {
      const rateLimit = await checkRequestRateLimit(request, {
        scope: "booking",
        limit: 5,
        windowMs: 60 * 60 * 1000,
      });
      if (!rateLimit.allowed) {
        const status = rateLimit.reason === "limit" ? 429 : 503;
        return NextResponse.json(
          {
            error:
              status === 429
                ? "Too many requests. Please try again later."
                : "Request intake is temporarily unavailable.",
          },
          {
            status,
            headers: { "retry-after": String(rateLimit.retryAfterSeconds) },
          },
        );
      }
    } catch {
      return NextResponse.json(
        { error: "Request intake is temporarily unavailable." },
        { status: 503 },
      );
    }
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const parsed = bookingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Review the property brief and try again." },
      { status: 400 },
    );
  }
  const input = parsed.data;
  if (isHoneypotFilled(input.companyWebsite)) {
    return NextResponse.json({ accepted: true }, { status: 202 });
  }
  if (
    ![input.scheduling.preferredDate, ...input.scheduling.alternateDates].every(
      validPlanningDate,
    )
  ) {
    return NextResponse.json(
      { error: "Choose planning dates from today through the next 18 months." },
      { status: 422 },
    );
  }

  const planning = deriveRequestPlanning({
    program: input.program,
    sizeBand: input.property.sizeBand,
    condition: input.property.condition,
    zoneCount: input.property.zoneCount,
    deadlineCritical: input.scheduling.deadlineCritical,
    finishSensitive: Boolean(input.scope.finishNotes),
    accessComplex: input.scheduling.accessComplex,
  });

  let customerId: string | null = null;
  if (authEnabled) {
    const { userId } = await auth();
    if (userId) {
      const user = await currentUser();
      const customer = await upsertCustomerFromClerk({
        clerkUserId: userId,
        email: user?.primaryEmailAddress?.emailAddress ?? input.contact.email,
        fullName: user?.fullName ?? input.contact.name,
        phone: input.contact.phone,
      });
      customerId = customer.id;
    }
  }
  if (!customerId) {
    customerId = (await getCustomerByEmail(input.contact.email))?.id ?? null;
  }

  const frequency = ["weekly", "biweekly", "monthly"].includes(
    input.property.cadence,
  )
    ? input.property.cadence
    : "onetime";
  const qualificationStatus =
    planning.reviewPath === "walkthrough recommended"
      ? "walkthrough_needed"
      : "requested";
  const requiredSkills = [
    `${input.program}-care`,
    "finish-awareness",
    ...(input.scope.finishNotes ? ["specialty-finishes"] : []),
  ];
  const planningScore = Math.min(
    100,
    25 +
      planning.estimatedCrewSize * 10 +
      Math.ceil(planning.estimatedMinutes / 60) * 3,
  );

  let booking;
  try {
    booking = await createBooking({
      serviceId: input.program,
      frequency,
      scheduledDate: input.scheduling.preferredDate,
      scheduledWindow: input.scheduling.windowPreference,
      customerId,
      contact: input.contact,
      homeDetails: {
        propertyContext: input.property.context,
        requestedCadence: input.property.cadence,
        alternateDates: input.scheduling.alternateDates,
        deadlineCritical: input.scheduling.deadlineCritical,
      },
      accessNotes: input.scheduling.accessComplex
        ? "Access coordination requested; collect details securely after review."
        : null,
      propertyProfile: {
        program: input.program,
        context: input.property.context,
        sizeBand: input.property.sizeBand,
        condition: input.property.condition,
        zoneCount: input.property.zoneCount,
      },
      roomPlan: [
        {
          id: "property_scope",
          label: "Approved property scope",
          selected: true,
          note: input.scope.priorities,
        },
      ],
      cleaningPreferences: planning.factors,
      specialInstructions: input.scope.finishNotes || null,
      planningDirection: `${planning.reviewPath} · ${planning.estimatedMinutes} labor minutes · ${planning.estimatedCrewSize} suggested crew`,
      planningScore,
      estimatedDurationMinutes: planning.estimatedMinutes,
      requiredCrewSize: planning.estimatedCrewSize,
      requiredSkills,
      qualificationStatus,
      qualificationRequirements: {
        reviewPath: planning.reviewPath,
        siteReady: input.acknowledgements.siteReady,
        deadlineCritical: input.scheduling.deadlineCritical,
        accessComplex: input.scheduling.accessComplex,
        photoPermission: input.acknowledgements.photoPermission,
      },
      requestSource:
        smokeDisposition === "authorized" ? "runtime_smoke" : "web_booking",
      isDevSeed: smokeDisposition === "authorized",
      idempotencyKeyHash: sha256(input.idempotencyKey),
      consentSnapshot: {
        privacy: input.acknowledgements.privacyConsent,
        requestTerms: input.acknowledgements.termsConsent,
        siteReadiness: input.acknowledgements.siteReady,
        photoPermission: input.acknowledgements.photoPermission,
      },
      consentVersion: input.acknowledgements.version,
      consentNoticeDate: input.acknowledgements.version,
      checklist: checklistFor(
        input.program,
        input.acknowledgements.photoPermission,
      ),
    });
  } catch (error) {
    console.error(
      "[booking:error]",
      error instanceof Error ? error.message : "unknown",
    );
    return NextResponse.json(
      { error: "We couldn't store this request. Please try again shortly." },
      { status: 503 },
    );
  }

  const reference = deriveBookingReference(booking.id);
  if (!booking.duplicate) {
    const [customerOutcome, opsOutcome] = await Promise.all([
      sendBookingConfirmation(
        {
          to: input.contact.email,
          name: input.contact.name,
          serviceTitle: PROGRAM_TITLES[input.program],
          date: input.scheduling.preferredDate,
          window: input.scheduling.windowPreference,
          bookingId: booking.id,
          publicReference: reference,
        },
        { suppress: smokeDisposition === "authorized" },
      ),
      sendOpsNotification(
        {
          kind: "booking",
          summary: `${PROGRAM_TITLES[input.program]} · ${input.scheduling.preferredDate} · ${qualificationStatus.replaceAll("_", " ")}`,
          detailLines: [
            `Customer: ${input.contact.name} (${input.contact.email}, ${input.contact.phone}, ${input.contact.zip})`,
            `Context: ${input.property.context} · ${input.property.sizeBand} · ${input.property.zoneCount} zones · ${input.property.cadence}`,
            `Planning: ${planning.reviewPath} · ${planning.estimatedMinutes} labor minutes · ${planning.estimatedCrewSize} suggested crew`,
            `Reference: ${reference}`,
          ],
        },
        { suppress: smokeDisposition === "authorized" },
      ),
    ]);
    await Promise.allSettled([
      recordBookingNotificationDelivery(
        booking.id,
        "customer_confirmation",
        customerOutcome,
      ),
      recordBookingNotificationDelivery(
        booking.id,
        "ops_notification",
        opsOutcome,
      ),
    ]);
  }

  return NextResponse.json({
    id: booking.id,
    reference,
    duplicate: booking.duplicate,
    planning: {
      reviewPath: planning.reviewPath,
      estimatedCrewSize: planning.estimatedCrewSize,
      estimatedMinutes: planning.estimatedMinutes,
    },
  });
}
