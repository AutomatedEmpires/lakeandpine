export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

/**
 * Convert a configured public phone number to an E.164 `tel:` href.
 *
 * International numbers must include a leading `+` and country code. For the
 * North American Numbering Plan, ten digits or eleven digits beginning with 1
 * are also accepted. Ambiguous national-format international numbers are
 * rejected instead of being assigned the wrong country code.
 */
export function normalizePhoneHref(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const digits = trimmed.replace(/\D/g, "");
  const normalizedDigits = trimmed.startsWith("+")
    ? digits
    : digits.length === 10
      ? `1${digits}`
      : digits.length === 11 && digits.startsWith("1")
        ? digits
        : "";

  if (!/^[1-9]\d{7,14}$/.test(normalizedDigits)) return undefined;
  return `tel:+${normalizedDigits}`;
}

const configuredBusinessPhone = optionalEnv("NEXT_PUBLIC_BUSINESS_PHONE");
const businessPhoneDigits = configuredBusinessPhone?.replace(/\D/g, "") ?? "";
const isKnownPlaceholderPhone = businessPhoneDigits.endsWith("2085550198");
const configuredBusinessPhoneHref = normalizePhoneHref(configuredBusinessPhone);

export const BUSINESS_PHONE =
  !isKnownPlaceholderPhone && configuredBusinessPhoneHref
    ? configuredBusinessPhone?.trim()
    : undefined;
export const BUSINESS_PHONE_TEL = BUSINESS_PHONE
  ? configuredBusinessPhoneHref
  : undefined;
const configuredBusinessEmail = optionalEnv("NEXT_PUBLIC_BUSINESS_EMAIL")?.trim();
export const BUSINESS_EMAIL = configuredBusinessEmail?.toLowerCase() === "hello@lakepinecleaning.com"
  ? undefined
  : configuredBusinessEmail;
export const PUBLIC_BUSINESS_EMAIL = BUSINESS_EMAIL;

const PRODUCTION_APP_URL = "https://lakeandpinecleaning.com";
const configuredAppUrl = optionalEnv("NEXT_PUBLIC_APP_URL");
export const APP_URL =
  process.env.VERCEL_ENV === "production"
    ? PRODUCTION_APP_URL
    : optionalEnv("NEXT_PUBLIC_CANONICAL_URL") ||
      (configuredAppUrl?.includes("lakeandpine.vercel.app") ? undefined : configuredAppUrl) ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3010");

export const authEnabled = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);
export const requestIntakeEnabled = process.env.REQUEST_INTAKE_ENABLED === "true";
export const customerSchedulingEnabled =
  process.env.CUSTOMER_SCHEDULING_ENABLED === "true";
export const cleanerApplicationsEnabled = process.env.CLEANER_APPLICATIONS_ENABLED === "true";
export const paymentsEnabled = process.env.PAYMENTS_ENABLED === "true";

export function getCustomerSchedulingReadinessIssues(): string[] {
  const issues: string[] = [];
  if (!customerSchedulingEnabled) issues.push("scheduling_disabled");
  if (!optionalEnv("DATABASE_URL")) issues.push("database_unconfigured");
  if ((optionalEnv("CUSTOMER_SCHEDULING_SECRET")?.length ?? 0) < 32) {
    issues.push("scheduling_protection_unconfigured");
  }
  if ((optionalEnv("REQUEST_FINGERPRINT_SECRET")?.length ?? 0) < 32) {
    issues.push("request_protection_unconfigured");
  }
  const bookingReferenceSecret =
    optionalEnv("BOOKING_REFERENCE_SECRET") ||
    optionalEnv("REQUEST_FINGERPRINT_SECRET");
  if ((bookingReferenceSecret?.length ?? 0) < 32) {
    issues.push("booking_reference_protection_unconfigured");
  }
  return issues;
}

export function getIntakeReadinessIssues(): string[] {
  const issues: string[] = [];
  if (!requestIntakeEnabled) issues.push("intake_disabled");
  if ((optionalEnv("REQUEST_FINGERPRINT_SECRET")?.length ?? 0) < 32) {
    issues.push("request_protection_unconfigured");
  }
  const bookingReferenceSecret = optionalEnv("BOOKING_REFERENCE_SECRET") || optionalEnv("REQUEST_FINGERPRINT_SECRET");
  if ((bookingReferenceSecret?.length ?? 0) < 32) {
    issues.push("booking_reference_protection_unconfigured");
  }
  if (!optionalEnv("RESEND_API_KEY")) issues.push("email_transport_unconfigured");
  if (!optionalEnv("RESEND_FROM") && !optionalEnv("RESEND_FROM_EMAIL")) {
    issues.push("email_sender_unconfigured");
  }
  if (!optionalEnv("RESEND_REPLY_TO") && !optionalEnv("SUPPORT_EMAIL")) {
    issues.push("email_reply_to_unconfigured");
  }
  if (!BUSINESS_EMAIL) issues.push("operations_recipient_unconfigured");
  if (!optionalEnv("SENTRY_DSN")) issues.push("error_monitoring_unconfigured");
  return issues;
}
