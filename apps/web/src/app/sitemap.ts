import type { MetadataRoute } from "next";

import { APP_URL } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const staticRoutes = ["", "/services", "/pricing", "/book"].map(
    (path) => ({
      url: `${APP_URL}${path}`,
      lastModified: now,
      priority: path === "" ? 1 : 0.8,
    }),
  );
  return staticRoutes;
}
