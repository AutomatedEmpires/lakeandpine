import type { Metadata } from "next";
import Link from "next/link";

import { AreaMap } from "@/components/AreaMap";
import { getServiceAreas } from "@/lib/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Area planning preview",
  description: "Planning pages for possible service areas. Public availability is not yet confirmed.",
  robots: { index: false },
};

export default async function AreasPage() {
  const areas = await getServiceAreas();

  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Area planning preview</span>
          <h1>Locations under consideration—not an availability promise.</h1>
          <p className="lead">
            These recovered location pages are retained for planning. A founder-approved
            service boundary is still required before Lake &amp; Pine claims availability.
          </p>
        </div>
      </div>
      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container map-section">
          <div className="card" style={{ padding: 28 }}>
            <h2>Location planning pages</h2>
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
              Preview a service request
            </Link>
          </div>
          <AreaMap areas={areas} />
        </div>
      </section>
    </div>
  );
}
