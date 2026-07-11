import type { Metadata } from "next";
import Link from "next/link";

import { AreaMap } from "@/components/AreaMap";
import { getServiceAreas } from "@/lib/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Service Areas",
  description:
    "Premium home cleaning across Coeur d'Alene, Spokane, Post Falls, Hayden, Liberty Lake, Spokane Valley, and Rathdrum.",
};

export default async function AreasPage() {
  const areas = await getServiceAreas();

  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Service areas</span>
          <h1>Local pages that can actually compete.</h1>
          <p className="lead">
            Real neighborhoods, city-specific service angles, and direct booking for every
            market we serve in the Inland Northwest.
          </p>
        </div>
      </div>
      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container map-section">
          <div className="card" style={{ padding: 28 }}>
            <h2>Primary local pages</h2>
            <ul className="checks" style={{ margin: "18px 0 22px" }}>
              {areas.map((area) => (
                <li key={area.slug}>
                  <Link href={`/areas/${area.slug}`} style={{ fontWeight: 800 }}>
                    {area.seo_phrase}
                  </Link>
                </li>
              ))}
            </ul>
            <Link className="btn btn-primary" href="/book">
              Book locally
            </Link>
          </div>
          <AreaMap areas={areas} />
        </div>
      </section>
    </div>
  );
}
