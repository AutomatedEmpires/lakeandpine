import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { guestManagementTokenSchema } from "@/lib/customer-scheduling-contract";
import { getGuestManagedBooking } from "@/lib/customer-scheduling-data";
import {
  customerSchedulingEnabled,
  getCustomerSchedulingReadinessIssues,
} from "@/lib/env";
import { GUEST_MANAGEMENT_COOKIE } from "@/lib/guest-management";
import { checkRequestRateLimit } from "@/lib/rate-limit";
import { readJsonBody, RequestBodyError } from "@/lib/request-security";

const exchangeSchema = z.object({ token: guestManagementTokenSchema });

export async function POST(request: Request) {
  if (!customerSchedulingEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (getCustomerSchedulingReadinessIssues().length > 0) {
    return NextResponse.json(
      { error: "Booking management is temporarily unavailable." },
      { status: 503 },
    );
  }
  try {
    const rateLimit = await checkRequestRateLimit(request, {
      scope: "guest-booking-management-exchange",
      limit: 12,
      windowMs: 15 * 60 * 1_000,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many access attempts. Please try again shortly." },
        { status: rateLimit.reason === "limit" ? 429 : 503 },
      );
    }
    const parsed = exchangeSchema.safeParse(await readJsonBody(request, 2_000));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid management link." }, { status: 400 });
    }
    const booking = await getGuestManagedBooking(parsed.data.token);
    if (!booking) {
      return NextResponse.json(
        { error: "This management link is invalid or expired." },
        { status: 403 },
      );
    }
    const cookieStore = await cookies();
    cookieStore.set(GUEST_MANAGEMENT_COOKIE, parsed.data.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return NextResponse.json({ booking });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    console.error(
      "[guest-booking-management:exchange]",
      process.env.NODE_ENV === "development" && error instanceof Error
        ? error.message
        : "exchange_failed",
    );
    return NextResponse.json(
      { error: "Booking management is temporarily unavailable." },
      { status: 503 },
    );
  }
}
