import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AreaMap } from "@/components/AreaMap";
import { FaqList } from "@/components/FaqList";
import { getServiceArea, getServiceAreas } from "@/lib/data";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const area = await getServiceArea(slug);
  if (!area) return {};
  return {
    title: `${area.seo_phrase} | Premium, insured, eco-conscious`,
    description: area.intro,
  };
}

export default async function AreaPage({ params }: Props) {
  const { slug } = await params;
  const [area, allAreas] = await Promise.all([getServiceArea(slug), getServiceAreas()]);
  if (!area) notFound();

  const serviceJsonLd = {
    "@context": "https://schema.org",
    "@type": "Service",
    serviceType: area.seo_phrase,
    provider: { "@type": "LocalBusiness", name: "Lake & Pine Cleaning Co." },
    areaServed: `${area.city}, ${area.state}`,
  };

  return (
    <div className="route-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(serviceJsonLd) }}
      />
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">
            {area.city}, {area.state}
          </span>
          <h1>{area.headline}</h1>
          <p className="lead">{area.intro}</p>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/book">
              Book in {area.city}
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
            <span className="eyebrow">Where we clean</span>
            <h2 className="section-title" style={{ fontSize: 44 }}>
              Neighborhoods we know.
            </h2>
            <div className="tag-row" style={{ margin: "16px 0 22px" }}>
              {area.neighborhoods.map((n) => (
                <span key={n} className="tag">
                  {n}
                </span>
              ))}
            </div>
            <ul className="checks">
              <li>Licensed, bonded, and insured</li>
              <li>Background-checked local cleaners</li>
              <li>Text arrival updates + 24-hour make-right</li>
            </ul>
          </div>
          <AreaMap areas={allAreas} highlight={area.city} />
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="bento">
            {area.highlights.map((highlight) => (
              <article key={highlight.title} className="tile wide card">
                <div className="icon">✦</div>
                <div>
                  <h3>{highlight.title}</h3>
                  <p>{highlight.body}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <div>
              <span className="eyebrow">{area.city} FAQ</span>
              <h2 className="section-title">Local questions, straight answers.</h2>
            </div>
          </div>
          <FaqList faqs={area.faqs.map(([question, answer]) => ({ question, answer }))} />
        </div>
      </section>

      <section className="section">
        <div className="container final-cta card">
          <div>
            <span className="eyebrow">Book</span>
            <h2 className="section-title">Ready for a cleaner home in {area.city}?</h2>
            <p className="copy">
              Same-week windows, transparent starting prices, and a dashboard that remembers
              your home.
            </p>
          </div>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/book">
              Book the first clean
            </Link>
            <Link className="btn btn-ghost" href="/areas">
              All service areas
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
