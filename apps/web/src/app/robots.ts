import type { MetadataRoute } from "next";

import { APP_URL } from "@/lib/env";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard", "/operator", "/sign-in", "/sign-up", "/api/"],
    },
    sitemap: `${APP_URL}/sitemap.xml`,
  };
}
