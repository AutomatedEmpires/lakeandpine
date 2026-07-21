import { NextResponse } from "next/server";

import { reservationRequestSchema } from "@/lib/customer-scheduling-contract";
import {
  createCustomerSchedulingReservation,
  SchedulingReservationError,
} from "@/lib/customer-scheduling-data";
import {
  customerSchedulingEnabled,
  getCustomerSchedulingReadinessIssues,
} from "@/lib/env";
import { checkRequestRateLimit } from "@/lib/rate-limit";
import {
  isHoneypotFilled,
  readJsonBody,
  RequestBodyError,
} from "@/lib/request-security";

export async function POST(request: Request) {
  if (!customerSchedulingEnabled) {
    return NextResponse.json(
      { error: "Customer scheduling is not enabled." },
      { status: 404 },
    );
  }
  const readinessIssues = getCustomerSchedulingReadinessIssues().filter(
    (issue) => issue !== "scheduling_disabled",
  );
  if (readinessIssues.length > 0) {
    return NextResponse.json(
      { error: "Scheduling is temporarily unavailable." },
      { status: 503 },
    );
  }
  try {
    const rateLimit = await checkRequestRateLimit(request, {
      scope: "customer-scheduling-reservation",
      limit: 8,
      windowMs: 60 * 60 * 1_000,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many reservation attempts. Please try again later." },
        {
          status: rateLimit.reason === "limit" ? 429 : 503,
          headers: { "retry-after": String(rateLimit.retryAfterSeconds) },
        },
      );
    }
    const parsed = reservationRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Review the reservation details and try again." },
        { status: 400 },
      );
    }
    if (isHoneypotFilled(parsed.data.companyWebsite)) {
      return NextResponse.json({ accepted: true }, { status: 202 });
    }
    const result = await createCustomerSchedulingReservation(parsed.data);
    return NextResponse.json({
      reference: result.reference,
      status: result.status,
      duplicate: result.duplicate,
      slot: result.slot,
      managementToken: result.managementToken,
      managementUrl: `/manage#token=${encodeURIComponent(result.managementToken)}`,
    });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof SchedulingReservationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.code === "idempotency_mismatch" ? 409 : 409 },
      );
    }
    console.error(
      "[customer-scheduling:reservation]",
      process.env.NODE_ENV === "development" && error instanceof Error
        ? error.message
        : "reservation_failed",
    );
    return NextResponse.json(
      { error: "We couldn't reserve that time. Please try again shortly." },
      { status: 503 },
    );
  }
}
