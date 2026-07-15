import { auth, currentUser } from "@clerk/nextjs/server";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { deriveBookingReference } from "@/lib/booking-reference";
import { normalizeVerifiedClerkEmail } from "@/lib/clerk-identity";
import { buildBookingConsentRecord } from "@/lib/consent-policy";
import {
  createBooking,
  getRuntimeDatabaseName,
  recordBookingNotificationDelivery,
  updateUnallocatedBookingRouteAssessment,
  upsertCustomerFromClerk,
} from "@/lib/data";
import { sendBookingConfirmation, sendOpsNotification } from "@/lib/email";
import {
  authEnabled,
  getIntakeReadinessIssues,
  requestIntakeEnabled,
} from "@/lib/env";
import { deriveRequestPlanning, PREMIUM_PROGRAMS } from "@/lib/premium-request";
import {
  getPlanningDateBounds,
  isPlanningDateAllowed,
} from "@/lib/planning-date";
import { checkRequestRateLimit } from "@/lib/rate-limit";
import {
  assessRequestLocation,
  createManualRequestLocationAssessment,
} from "@/lib/route-qualification";
import {
  isHoneypotFilled,
  readJsonBody,
  RequestBodyError,
} from "@/lib/request-security";
import {
  getRuntimeSmokeDisposition,
  isSafeRuntimeSmokeDatabase,
  RUNTIME_SMOKE_DATABASE_HEADER,
} from "@/lib/runtime-smoke-request";
import { feasibleArrivalWindows } from "@/lib/field-operations";
import {
  MULTI_DAY_WINDOW_PREFERENCE,
  REQUEST_WINDOW_PREFERENCES,
} from "@/lib/scheduling";

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
    windowPreference: z.enum(REQUEST_WINDOW_PREFERENCES),
    deadlineCritical: z.boolean(),
    accessComplex: z.boolean(),
  }),
  contact: z.object({
    name: z.string().trim().min(2).max(200),
    email: z.string().trim().email().max(320),
    phone: z.string().trim().min(7).max(30),
    street: z.string().trim().min(3).max(200),
    unit: z.string().trim().max(120).default(""),
    city: z.string().trim().min(2).max(120),
    state: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform((value) => value.toUpperCase()),
    zip: z.string().trim().min(3).max(12),
  }),
  acknowledgements: z.object({
    siteReady: z.literal(true),
    privacyConsent: z.literal(true),
    termsConsent: z.literal(true),
    photoPermission: z.boolean(),
  }),
});

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
  const planningDateBounds = getPlanningDateBounds();
  if (![input.scheduling.preferredDate, ...input.scheduling.alternateDates].every(
    (value) => isPlanningDateAllowed(value, planningDateBounds),
  )) {
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
  const elapsedMinutes =
    Math.ceil(planning.estimatedMinutes / planning.estimatedCrewSize / 30) * 30;
  const feasibleWindows = feasibleArrivalWindows(elapsedMinutes).filter(
    (window) => window.eligible,
  );
  const requiresMultiDayReview = feasibleWindows.length === 0;
  if (
    (requiresMultiDayReview &&
      input.scheduling.windowPreference !== MULTI_DAY_WINDOW_PREFERENCE) ||
    (!requiresMultiDayReview &&
      !feasibleWindows.some(
        (window) => window.label === input.scheduling.windowPreference,
      ))
  ) {
    return NextResponse.json(
      {
        error: requiresMultiDayReview
          ? "This scope requires operator-planned multi-day review; choose that planning path."
          : "Choose an arrival window that fits the estimated single-day duration.",
      },
      { status: 422 },
    );
  }
  if (smokeDisposition === "authorized") {
    const connectedDatabase = await getRuntimeDatabaseName();
    if (!isSafeRuntimeSmokeDatabase({
      headerDatabase: request.headers.get(RUNTIME_SMOKE_DATABASE_HEADER),
      configuredDatabase: process.env.RUNTIME_SMOKE_DATABASE,
      connectedDatabase,
      databaseUrl: process.env.DATABASE_URL,
      allowRemoteDatabase:
        process.env.RUNTIME_SMOKE_ALLOW_REMOTE_DATABASE === "true",
    })) {
      return NextResponse.json(
        { error: "Runtime smoke target identity mismatch" },
        { status: 403 },
      );
    }
  }

  let customerId: string | null = null;
  if (authEnabled) {
    const { userId } = await auth();
    if (userId) {
      const user = await currentUser();
      const verifiedEmail = normalizeVerifiedClerkEmail(
        user?.primaryEmailAddress?.emailAddress,
        user?.primaryEmailAddress?.verification?.status,
      );
      const customer = await upsertCustomerFromClerk({
        clerkUserId: userId,
        verifiedEmail,
        fullName: user?.fullName ?? input.contact.name,
        phone: input.contact.phone,
      });
      const normalizedContactEmail = input.contact.email.trim().toLowerCase();
      customerId =
        verifiedEmail === normalizedContactEmail ? customer.id : null;
    }
  }
  // Guest contact email is unverified. Keep the request unowned until a later
  // Clerk sign-in proves the primary email and adopts matching null-owned rows.

  const frequency = ["weekly", "biweekly", "monthly"].includes(
    input.property.cadence,
  )
    ? input.property.cadence
    : "onetime";
  const qualificationStatus =
    planning.reviewPath === "walkthrough recommended" || requiresMultiDayReview
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
  const consent = buildBookingConsentRecord(input.acknowledgements);
  // Claim the idempotency key with a safe local assessment before any paid or
  // externally observable geocoding call. Only the request that created the
  // booking may enrich it; retries return the original booking without calling
  // the provider again.
  let routeAssessment = createManualRequestLocationAssessment(input.contact);

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
        multiDayReviewRequired: requiresMultiDayReview,
        siteReady: input.acknowledgements.siteReady,
        deadlineCritical: input.scheduling.deadlineCritical,
        accessComplex: input.scheduling.accessComplex,
        photoPermission: input.acknowledgements.photoPermission,
      },
      requestSource:
        smokeDisposition === "authorized" ? "runtime_smoke" : "web_booking",
      isDevSeed: smokeDisposition === "authorized",
      idempotencyKeyHash: sha256(input.idempotencyKey),
      consentSnapshot: consent.snapshot,
      consentVersion: consent.version,
      consentNoticeDate: consent.noticeDate,
      checklist: checklistFor(
        input.program,
        input.acknowledgements.photoPermission,
      ),
      routeAssessment,
    });
    if (!booking.duplicate) {
      const enrichedAssessment = await assessRequestLocation(input.contact);
      try {
        await updateUnallocatedBookingRouteAssessment(
          booking.id,
          enrichedAssessment,
        );
        routeAssessment = enrichedAssessment;
      } catch (error) {
        // The manual-review record created in the booking transaction is the
        // fail-safe. Never discard a valid request because enrichment raced or
        // the database became unavailable after the idempotency claim.
        console.error(
          "[booking:route-enrichment]",
          error instanceof Error ? error.message : "unknown",
        );
      }
    }
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
    if (!booking.notificationOutboxIds) {
      throw new Error("Booking notification claims are unavailable");
    }
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
        {
          suppress: smokeDisposition === "authorized",
          idempotencyKey: `booking:${booking.id}:customer_confirmation`,
        },
      ),
      sendOpsNotification(
        {
          kind: "booking",
          summary: `${PROGRAM_TITLES[input.program]} · ${input.scheduling.preferredDate} · ${qualificationStatus.replaceAll("_", " ")}`,
          detailLines: [
            `Customer: ${input.contact.name} (${input.contact.email}, ${input.contact.phone})`,
            `Service area: ${input.contact.city}, ${input.contact.state} ${input.contact.zip} · ${routeAssessment.assessmentStatus.replaceAll("_", " ")}`,
            `Context: ${input.property.context} · ${input.property.sizeBand} · ${input.property.zoneCount} zones · ${input.property.cadence}`,
            `Planning: ${planning.reviewPath} · ${planning.estimatedMinutes} labor minutes · ${planning.estimatedCrewSize} suggested crew`,
            `Reference: ${reference}`,
          ],
        },
        {
          suppress: smokeDisposition === "authorized",
          idempotencyKey: `booking:${booking.id}:ops_notification`,
        },
      ),
    ]);
    await Promise.allSettled([
      recordBookingNotificationDelivery(
        booking.notificationOutboxIds.customer,
        booking.id,
        "customer_confirmation",
        customerOutcome,
      ),
      recordBookingNotificationDelivery(
        booking.notificationOutboxIds.ops,
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
