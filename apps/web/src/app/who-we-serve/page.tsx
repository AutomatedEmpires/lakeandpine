import type { Metadata } from "next";
import Link from "next/link";

import { MARKET_PROGRAMS, REGION_CLUSTERS } from "@/lib/market-content";

export const metadata: Metadata = {
  title: "Who We Serve",
  description:
    "Lake & Pine is built for private estates, builders and owners, marine interiors, and select professional spaces across the Inland Northwest planning region.",
  alternates: { canonical: "/who-we-serve" },
};

export default function WhoWeServePage() {
  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel who-hero">
          <span className="eyebrow">Who we serve</span>
          <h1>Properties where the handoff matters as much as the clean.</h1>
          <p className="lead">
            Lake &amp; Pine is designed for owners and decision-makers who need a clear scope,
            careful access planning, and a confirmed outcome—not the fastest anonymous turnover.
          </p>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/book">Discuss your property</Link>
            <Link className="btn btn-soft" href="/services">See service programs</Link>
          </div>
        </div>
      </div>

      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container audience-detail-list">
          {MARKET_PROGRAMS.map((program, index) => (
            <article className="audience-detail" id={program.slug} key={program.slug}>
              <div className="audience-heading">
                <span className="program-number">0{index + 1}</span>
                <span className="eyebrow">{program.eyebrow}</span>
                <h2>{program.title}</h2>
                <p className="lead">{program.summary}</p>
              </div>
              <div className="audience-fit card">
                <h3>A strong fit when…</h3>
                <ul className="checks">{program.bestFor.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
              <div className="audience-plan card">
                <h3>The first plan should capture…</h3>
                <ul className="checks">{program.planIncludes.map((item) => <li key={item}>{item}</li>)}</ul>
                <aside className="scope-boundary"><strong>Important boundary</strong><p>{program.boundaries}</p></aside>
                <Link className="btn btn-soft" href={`/book?program=${program.slug}`}>Request fit review</Link>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="section pine-band">
        <div className="container not-for-grid">
          <div>
            <span className="eyebrow">Deliberate focus</span>
            <h2 className="section-title">Not every cleaning request belongs here.</h2>
          </div>
          <div className="not-for-copy">
            <p>Lake &amp; Pine is not positioning around rapid-turnover vacation rentals, anonymous marketplace dispatch, or the lowest same-day price.</p>
            <p>Work involving biohazards, active mold, pests, regulated sanitation, industrial conditions, mechanical systems, hull restoration, or undisclosed safety risks needs an appropriately qualified provider and is not assumed in a standard request.</p>
            <p>If the property or scope is not a responsible fit, the correct outcome is a clear answer before anyone treats the request as scheduled.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <div><span className="eyebrow">Regional planning</span><h2 className="section-title">Routes are built around the job—not a broad map claim.</h2></div>
            <p className="copy">These are planning corridors, not a promise that every address or date is available. Exact coverage is confirmed with the request.</p>
          </div>
          <div className="region-grid">
            {REGION_CLUSTERS.map((region) => (
              <article className="card region-card" key={region.title}><span className="eyebrow">Planning corridor</span><h3>{region.title}</h3><strong>{region.places}</strong><p>{region.body}</p></article>
            ))}
          </div>
          <div className="hero-actions region-actions"><Link className="btn btn-soft" href="/areas">How area confirmation works</Link></div>
        </div>
      </section>

      <section className="section">
        <div className="container final-cta card">
          <div><span className="eyebrow">A useful first request</span><h2 className="section-title">Tell us the property, the moment, and the non-negotiables.</h2><p className="copy">A preferred date plus an alternate makes it easier to review route fit and crew time without pretending a live slot is reserved.</p></div>
          <div className="hero-actions"><Link className="btn btn-primary" href="/book">Request a consultation</Link><Link className="btn btn-soft" href="/pricing">How proposals work</Link></div>
        </div>
      </section>
    </div>
  );
}
