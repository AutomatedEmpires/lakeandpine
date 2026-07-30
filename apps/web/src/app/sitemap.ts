import type { MetadataRoute } from "next";

import { getServiceAreas } from "@/lib/data";
import { APP_URL } from "@/lib/env";

// Rebuilt daily. A database outage must never publish an empty sitemap, so the
// per-city section degrades to nothing while every static route still ships.
export const revalidate = 86400;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date("2026-07-13T00:00:00.000Z");
  const staticRoutes = [
    { path: "", priority: 1 },
    { path: "/who-we-serve", priority: 0.9 },
    { path: "/services", priority: 0.9 },
    { path: "/pricing", priority: 0.8 },
    { path: "/areas", priority: 0.7 },
    { path: "/book", priority: 0.9 },
    { path: "/privacy", priority: 0.3 },
    { path: "/terms", priority: 0.3 },
  ].map(({ path, priority }) => ({
    url: `${APP_URL}${path}`,
    lastModified,
    priority,
  }));

  // Per-city planning pages are the primary local-search surface.
  const areas = await getServiceAreas().catch(() => []);
  const areaRoutes = areas.map((area) => ({
    url: `${APP_URL}/areas/${area.slug}`,
    lastModified,
    priority: 0.6,
  }));

  return [...staticRoutes, ...areaRoutes];
}
