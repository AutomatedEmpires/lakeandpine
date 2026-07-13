import "server-only";

import { sql } from "./db";
import { optionalEnv } from "./env";
import { buildPrivateRequestKey, fixedWindowStart } from "./request-security";

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

  const now = new Date();
  const windowStartedAt = fixedWindowStart(now, input.windowMs);
  const expiresAt = new Date(windowStartedAt.getTime() + input.windowMs * 2);
  const requestKey = buildPrivateRequestKey(request.headers, input.scope, secret);

  const rows = await sql<{ request_count: number }[]>`
    insert into request_rate_limits
      (scope, key_hash, window_start, window_seconds, request_count, expires_at)
    values
      (${input.scope}, ${requestKey}, ${windowStartedAt.toISOString()},
       ${Math.ceil(input.windowMs / 1000)}, 1, ${expiresAt.toISOString()})
    on conflict (scope, key_hash, window_start)
    do update set request_count = request_rate_limits.request_count + 1
    returning request_count`;

  const count = rows[0]?.request_count ?? input.limit + 1;
  if (count > input.limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowStartedAt.getTime() + input.windowMs - now.getTime()) / 1000),
    );
    return { allowed: false, retryAfterSeconds, reason: "limit" };
  }

  return { allowed: true, remaining: Math.max(0, input.limit - count) };
}
