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
    title: `${area.city} Service Area Review`,
    description: `How Lake & Pine reviews property, route, and schedule fit for requests near ${area.city}. Availability is confirmed individually.`,
    alternates: { canonical: `/areas/${slug}` },
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
          <h1>Planning a property request near {area.city}.</h1>
          <p className="lead">This page provides regional context, not a blanket availability promise. An operator reviews the property type, scope, travel, crew time, and preferred window before confirming service.</p>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/book">
              Check a property
            </Link>
            <Link className="btn btn-soft" href="/pricing">
              How proposals work
            </Link>
          </div>
        </div>
      </div>

      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container map-section">
          <div className="card" style={{ padding: 28 }}>
            <span className="eyebrow">Regional context</span>
            <h2 className="section-title" style={{ fontSize: 44 }}>
              Nearby place names help start a route review.
            </h2>
            <div className="tag-row" style={{ margin: "16px 0 22px" }}>
              {area.neighborhoods.map((n) => (
                <span key={n} className="tag">
                  {n}
                </span>
              ))}
            </div>
            <p className="copy">A listed place does not confirm coverage. Exact availability follows a property and schedule review, and secure access details should be shared only after an operator follows up.</p>
          </div>
          <AreaMap areas={allAreas} highlight={area.city} />
        </div>
      </section>

      <section className="section">
        <div className="container final-cta card">
          <div>
            <span className="eyebrow">Confirm before scheduling</span>
            <h2 className="section-title">Start with the property, scope, and two timing options.</h2>
            <p className="copy">The request can be previewed without payment. An address and preferred window are not treated as a confirmed appointment.</p>
          </div>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/book">
              Request route review
            </Link>
            <Link className="btn btn-ghost" href="/areas">
              Area planning
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
