import { createHash, createHmac } from "node:crypto";

function referenceSecret() {
  const value =
    process.env.BOOKING_REFERENCE_SECRET ||
    process.env.REQUEST_FINGERPRINT_SECRET ||
    (process.env.NODE_ENV !== "production"
      ? process.env.RUNTIME_SMOKE_TOKEN
      : undefined);
  if (!value || value.length < 32) {
    throw new Error("Booking reference protection is not configured");
  }
  return value;
}

export function deriveBookingReference(
  bookingId: string,
  secret = referenceSecret(),
) {
  const digest = createHmac("sha256", secret)
    .update(`lake-and-pine-booking:${bookingId}`)
    .digest("hex")
    .slice(0, 20)
    .toUpperCase();
  return `LP-${digest.slice(0, 5)}-${digest.slice(5, 10)}-${digest.slice(10, 15)}-${digest.slice(15)}`;
}

export function hashBookingReference(reference: string) {
  return createHash("sha256")
    .update(reference.trim().toUpperCase())
    .digest("hex");
}
