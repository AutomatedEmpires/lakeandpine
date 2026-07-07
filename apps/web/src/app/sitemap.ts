import type { MetadataRoute } from "next";

import { getServiceAreas } from "@/lib/data";
import { APP_URL } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const areas = await getServiceAreas().catch(() => []);
  const now = new Date();
  const staticRoutes = ["", "/services", "/pricing", "/book", "/areas", "/reviews"].map(
    (path) => ({
      url: `${APP_URL}${path}`,
      lastModified: now,
      priority: path === "" ? 1 : 0.8,
    }),
  );
  const areaRoutes = areas.map((area) => ({
    url: `${APP_URL}/areas/${area.slug}`,
    lastModified: now,
    priority: 0.7,
  }));
  return [...staticRoutes, ...areaRoutes];
}
