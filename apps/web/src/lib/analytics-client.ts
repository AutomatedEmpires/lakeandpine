"use client";

// Thin wrapper so components can fire conversion events without caring whether
// PostHog is configured (it no-ops when NEXT_PUBLIC_POSTHOG_KEY is absent).
import posthog from "posthog-js";

export function capture(event: string, properties?: Record<string, unknown>) {
  if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    posthog.capture(event, properties);
  }
}
