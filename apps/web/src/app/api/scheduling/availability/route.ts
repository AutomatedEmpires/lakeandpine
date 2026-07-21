import { NextResponse } from "next/server";

import { availabilityRequestSchema } from "@/lib/customer-scheduling-contract";
import { getCustomerSchedulingAvailability } from "@/lib/customer-scheduling-data";
import {
  customerSchedulingEnabled,
  getCustomerSchedulingReadinessIssues,
} from "@/lib/env";
import { checkRequestRateLimit } from "@/lib/rate-limit";
import { readJsonBody, RequestBodyError } from "@/lib/request-security";

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
      scope: "customer-scheduling-availability",
      limit: 30,
      windowMs: 15 * 60 * 1_000,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many availability checks. Please try again shortly." },
        {
          status: rateLimit.reason === "limit" ? 429 : 503,
          headers: { "retry-after": String(rateLimit.retryAfterSeconds) },
        },
      );
    }
    const parsed = availabilityRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Review the property details and try again." },
        { status: 400 },
      );
    }
    const result = await getCustomerSchedulingAvailability(parsed.data.scope);
    return NextResponse.json({
      classification: result.classification,
      slots: result.slots,
    });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    console.error(
      "[customer-scheduling:availability]",
      process.env.NODE_ENV === "development" && error instanceof Error
        ? error.message
        : "availability_failed",
    );
    return NextResponse.json(
      { error: "Scheduling is temporarily unavailable." },
      { status: 503 },
    );
  }
}
