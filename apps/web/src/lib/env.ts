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

const configuredBusinessPhone = optionalEnv("NEXT_PUBLIC_BUSINESS_PHONE");
const businessPhoneDigits = configuredBusinessPhone?.replace(/\D/g, "") ?? "";
const isKnownPlaceholderPhone = businessPhoneDigits.endsWith("2085550198");

export const BUSINESS_PHONE = isKnownPlaceholderPhone ? undefined : configuredBusinessPhone;
export const BUSINESS_PHONE_TEL = BUSINESS_PHONE ? `tel:1${BUSINESS_PHONE.replace(/\D/g, "")}` : undefined;
export const BUSINESS_EMAIL = process.env.NEXT_PUBLIC_BUSINESS_EMAIL || "hello@lakeandpinecleaning.com";
const publicBusinessEmail = BUSINESS_EMAIL.trim();
export const PUBLIC_BUSINESS_EMAIL = publicBusinessEmail.toLowerCase() === "hello@lakepinecleaning.com"
  ? undefined
  : publicBusinessEmail;

const configuredAppUrl = optionalEnv("NEXT_PUBLIC_APP_URL");
export const APP_URL = optionalEnv("NEXT_PUBLIC_CANONICAL_URL")
  || (configuredAppUrl?.includes("lakeandpine.vercel.app") ? undefined : configuredAppUrl)
  || "https://lakeandpinecleaning.com";

export const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
export const requestIntakeEnabled = process.env.REQUEST_INTAKE_ENABLED === "true";
