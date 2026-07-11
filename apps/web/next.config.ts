import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // postgres.js ships a conditional `cloudflare:sockets` import that the
  // bundler must not try to resolve.
  serverExternalPackages: ["postgres"],
};

// The Sentry build plugin (source-map upload) only activates with an auth
// token; runtime error capture is configured in instrumentation*.ts.
export default process.env.SENTRY_AUTH_TOKEN
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      silent: true,
    })
  : nextConfig;
