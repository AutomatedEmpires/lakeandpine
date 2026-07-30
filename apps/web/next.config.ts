import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

// Baseline security headers for every response. The site embeds no third-party
// frames, so frame ancestry is closed entirely. A Content-Security-Policy is
// deliberately NOT set here: the root layout ships two inline scripts (theme
// bootstrap and LocalBusiness JSON-LD) and Mapbox needs blob: workers, so a
// policy has to be authored and verified against those before it is enforced.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];

const nextConfig: NextConfig = {
  // postgres.js ships a conditional `cloudflare:sockets` import that the
  // bundler must not try to resolve.
  serverExternalPackages: ["postgres"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
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
