import { timingSafeEqual } from "node:crypto";

export const RUNTIME_SMOKE_HEADER = "x-lake-pine-runtime-smoke-token";
export const MIN_RUNTIME_SMOKE_TOKEN_LENGTH = 32;

export type RuntimeSmokeDisposition = "ordinary" | "authorized" | "rejected";

// A smoke marker is never trusted on its own. If a caller presents the header,
// the server must also have a sufficiently strong token and the values must
// match. Rejected smoke requests stop before database writes or email delivery.
export function getRuntimeSmokeDisposition(
  headers: Pick<Headers, "get">,
  configuredToken = process.env.RUNTIME_SMOKE_TOKEN,
): RuntimeSmokeDisposition {
  const providedToken = headers.get(RUNTIME_SMOKE_HEADER);
  if (providedToken === null) return "ordinary";

  if (
    !configuredToken ||
    configuredToken.length < MIN_RUNTIME_SMOKE_TOKEN_LENGTH ||
    providedToken.length < MIN_RUNTIME_SMOKE_TOKEN_LENGTH
  ) {
    return "rejected";
  }

  const expected = Buffer.from(configuredToken);
  const provided = Buffer.from(providedToken);
  if (expected.length !== provided.length) return "rejected";

  return timingSafeEqual(expected, provided) ? "authorized" : "rejected";
}
