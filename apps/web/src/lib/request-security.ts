import { createHmac } from "node:crypto";

export const DEFAULT_MAX_BODY_BYTES = 32_000;

export class RequestBodyError extends Error {
  public readonly status: 400 | 413;

  constructor(
    message: string,
    status: 400 | 413,
  ) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
  }
}

function firstForwardedAddress(value: string | null): string {
  return value?.split(",")[0]?.trim().slice(0, 96) || "unknown";
}

export function buildPrivateRequestKey(
  headers: Headers,
  scope: string,
  secret: string,
): string {
  if (secret.length < 32) {
    throw new Error("REQUEST_FINGERPRINT_SECRET must contain at least 32 characters");
  }

  const address = firstForwardedAddress(
    headers.get("x-vercel-forwarded-for") ??
      headers.get("x-forwarded-for") ??
      headers.get("x-real-ip"),
  );
  const userAgent = (headers.get("user-agent") ?? "unknown").slice(0, 256);

  return createHmac("sha256", secret)
    .update(`${scope}\n${address}\n${userAgent}`)
    .digest("hex");
}

export function isHoneypotFilled(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export async function readJsonBody(
  request: Request,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyError("Request body is too large", 413);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new RequestBodyError("Request body is too large", 413);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new RequestBodyError("Request body must be valid JSON", 400);
  }
}

export function fixedWindowStart(now: Date, windowMs: number): Date {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("Rate-limit window must be a positive duration");
  }
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}
