import type { MetadataRoute } from "next";

import { APP_URL } from "@/lib/env";

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes = [
    { path: "", priority: 1 },
    { path: "/who-we-serve", priority: 0.9 },
    { path: "/services", priority: 0.9 },
    { path: "/pricing", priority: 0.8 },
    { path: "/areas", priority: 0.7 },
    { path: "/book", priority: 0.9 },
    { path: "/privacy", priority: 0.3 },
    { path: "/terms", priority: 0.3 },
  ].map(
    ({ path, priority }) => ({
      url: `${APP_URL}${path}`,
      lastModified: new Date("2026-07-13T00:00:00.000Z"),
      priority,
    }),
  );
  return staticRoutes;
}
