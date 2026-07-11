import * as Sentry from "@sentry/nextjs";
import posthog from "posthog-js";

// Client-side observability, both key-gated no-ops until env vars exist.

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
    replaysOnErrorSampleRate: 0.5,
  });
}

if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
    defaults: "2025-05-24",
    capture_exceptions: false,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
