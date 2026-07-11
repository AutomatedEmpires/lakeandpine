"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
      Sentry.captureException(error);
    } else {
      console.error(error);
    }
  }, [error]);

  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Something slipped</span>
          <h1>We missed a spot.</h1>
          <p className="lead">An unexpected error occurred. Try again — it usually clears right up.</p>
          <div className="hero-actions">
            <button className="btn btn-primary" onClick={reset}>
              Try again
            </button>
            <Link className="btn btn-soft" href="/">
              Back home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
