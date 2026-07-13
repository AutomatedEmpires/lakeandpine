import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AreaMap } from "@/components/AreaMap";
import { getServiceArea, getServiceAreas } from "@/lib/data";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const area = await getServiceArea(slug);
  if (!area) return {};
  return {
    title: `${area.city} area planning preview`,
    description: `A non-public planning page for possible service requests in ${area.city}. Availability is not confirmed.`,
    robots: { index: false },
  };
}

export default async function AreaPage({ params }: Props) {
  const { slug } = await params;
  const [area, allAreas] = await Promise.all([getServiceArea(slug), getServiceAreas()]);
  if (!area) notFound();

  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">
            {area.city}, {area.state}
          </span>
          <h1>{area.city} planning preview.</h1>
          <p className="lead">This recovered local page does not confirm that Lake &amp; Pine serves this area. An operator must verify coverage before accepting a request.</p>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/book">
              Preview request planning
            </Link>
            <Link className="btn btn-soft" href="/#quote">
              Get instant estimate
            </Link>
          </div>
        </div>
      </div>

      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container map-section">
          <div className="card" style={{ padding: 28 }}>
            <span className="eyebrow">Local planning context</span>
            <h2 className="section-title" style={{ fontSize: 44 }}>
              Neighborhood references from the recovered prototype.
            </h2>
            <div className="tag-row" style={{ margin: "16px 0 22px" }}>
              {area.neighborhoods.map((n) => (
                <span key={n} className="tag">
                  {n}
                </span>
              ))}
            </div>
            <p className="copy">Coverage, credentials, cleaner screening, and follow-up policy all require founder confirmation before they are published as service claims.</p>
          </div>
          <AreaMap areas={allAreas} highlight={area.city} />
        </div>
      </section>

      <section className="section">
        <div className="container final-cta card">
          <div>
            <span className="eyebrow">Planning only</span>
            <h2 className="section-title">Build the request. Confirm the area later.</h2>
            <p className="copy">Public intake is disabled by default, and this page makes no availability promise.</p>
          </div>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/book">
              Preview the planning flow
            </Link>
            <Link className="btn btn-ghost" href="/areas">
              All area previews
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
