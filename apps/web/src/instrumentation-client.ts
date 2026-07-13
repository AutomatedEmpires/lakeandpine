import * as Sentry from "@sentry/nextjs";
import posthog from "posthog-js";

// Client-side observability, both key-gated no-ops until env vars exist.

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
    replaysOnErrorSampleRate: 0.5,
    sendDefaultPii: false,
    beforeSend(event) {
      delete event.user;
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.headers;
      }
      return event;
    },
  });
}

function analyticsConsentGranted() {
  try {
    return window.localStorage.getItem("lakepine_privacy_choice") === "analytics";
  } catch {
    return false;
  }
}

let analyticsStarted = false;

function startAnalytics() {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY || analyticsStarted || !analyticsConsentGranted()) {
    return;
  }
  analyticsStarted = true;
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
    defaults: "2025-05-24",
    capture_exceptions: false,
    person_profiles: "identified_only",
    autocapture: false,
    disable_session_recording: true,
  });
}

startAnalytics();
window.addEventListener("lakepine:analytics-consent", startAnalytics);

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
