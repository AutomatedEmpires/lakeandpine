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
export const BUSINESS_EMAIL = process.env.NEXT_PUBLIC_BUSINESS_EMAIL || "hello@lakeandpinecleaning.com";
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3010";

export const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
