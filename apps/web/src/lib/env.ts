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

export const BUSINESS_PHONE = optionalEnv("NEXT_PUBLIC_BUSINESS_PHONE");
export const BUSINESS_PHONE_TEL = BUSINESS_PHONE ? `tel:1${BUSINESS_PHONE.replace(/\D/g, "")}` : undefined;
export const BUSINESS_EMAIL = optionalEnv("NEXT_PUBLIC_BUSINESS_EMAIL");

const PRODUCTION_APP_URL = "https://lakeandpinecleaning.com";
const configuredAppUrl = optionalEnv("NEXT_PUBLIC_APP_URL");
export const APP_URL =
  process.env.VERCEL_ENV === "production"
    ? PRODUCTION_APP_URL
    : configuredAppUrl ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3010");

export const authEnabled = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);
export const requestIntakeEnabled = process.env.REQUEST_INTAKE_ENABLED === "true";
export const paymentsEnabled = process.env.PAYMENTS_ENABLED === "true";

export function getIntakeReadinessIssues(): string[] {
  const issues: string[] = [];
  if (!requestIntakeEnabled) issues.push("intake_disabled");
  if ((optionalEnv("REQUEST_FINGERPRINT_SECRET")?.length ?? 0) < 32) {
    issues.push("request_protection_unconfigured");
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
