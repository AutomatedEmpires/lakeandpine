import "server-only";

import { sql } from "./db";
import { optionalEnv } from "./env";
import { buildPrivateRequestKey } from "./request-security";

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number; reason: "limit" | "configuration" };

export async function checkRequestRateLimit(
  request: Request,
  input: { scope: string; limit: number; windowMs: number },
): Promise<RateLimitResult> {
  const secret = optionalEnv("REQUEST_FINGERPRINT_SECRET");
  if (!secret || secret.length < 32) {
    return { allowed: false, retryAfterSeconds: 60, reason: "configuration" };
  }

  const requestKey = buildPrivateRequestKey(request.headers, input.scope, secret);
  const rows = await sql<
    { allowed: boolean | null; remaining: number | null; retry_after_seconds: number | null }[]
  >`
    select * from private.consume_request_rate_limit(
      ${input.scope}, ${requestKey}, ${input.limit}, ${Math.ceil(input.windowMs / 1000)}
    )`;
  const consumption = rows[0];
  if (
    typeof consumption?.allowed !== "boolean" ||
    typeof consumption.remaining !== "number" ||
    typeof consumption.retry_after_seconds !== "number" ||
    !Number.isInteger(consumption.remaining) ||
    !Number.isInteger(consumption.retry_after_seconds)
  ) {
    throw new Error("Rate-limit consumption did not return a valid decision");
  }

  if (!consumption.allowed) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, consumption.retry_after_seconds),
      reason: "limit",
    };
  }

  return { allowed: true, remaining: Math.max(0, consumption.remaining) };
}
