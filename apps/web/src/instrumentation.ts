import * as Sentry from "@sentry/nextjs";

export async function register() {
  // DSN-gated: without SENTRY_DSN this is a no-op in every runtime.
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
      enableLogs: true,
    });
  }
}

export const onRequestError = Sentry.captureRequestError;
