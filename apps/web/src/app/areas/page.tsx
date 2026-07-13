import type { Metadata } from "next";
import Link from "next/link";

import { REGION_CLUSTERS } from "@/lib/market-content";

export const metadata: Metadata = {
  title: "Service Area Planning",
  description:
    "Learn how Lake & Pine reviews route fit across the North Idaho lake corridor and Spokane metro corridor.",
  alternates: { canonical: "/areas" },
};

export default function AreasPage() {
  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Service area planning</span>
          <h1>A route should fit the property, crew time, and promised outcome.</h1>
          <p className="lead">
            Lake &amp; Pine is planning around two Inland Northwest corridors. Listed places
            provide regional context—not a claim that every address, scope, or date is available.
          </p>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/book">Check a property</Link>
            <Link className="btn btn-soft" href="/who-we-serve">See property programs</Link>
          </div>
        </div>
      </div>

      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container region-grid">
          {REGION_CLUSTERS.map((region) => (
            <article className="card region-card" key={region.title}>
              <span className="eyebrow">Planning corridor</span>
              <h2>{region.title}</h2>
              <strong>{region.places}</strong>
              <p>{region.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="container planning-story card area-method">
          <div><span className="eyebrow">How coverage is confirmed</span><h2 className="section-title">An address is only one part of route fit.</h2><p className="copy">Large homes, construction sites, marinas, and commercial spaces need different crew time and access planning. Confirmation follows a scope review.</p></div>
          <div className="planning-story-list">
            {[
              ["01", "Property location", "City and ZIP first; exact access details later."],
              ["02", "Program + scale", "Residence, construction, marine interior, or commercial scope."],
              ["03", "Timing options", "A preferred window and alternate, not a live-slot promise."],
              ["04", "Route confirmation", "Travel, crew duration, access, and capacity reviewed together."],
            ].map(([number, title, body]) => <article key={number}><span>{number}</span><div><strong>{title}</strong><p>{body}</p></div></article>)}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container service-explainer-grid">
          <article className="card"><span className="eyebrow">Cleaner areas</span><h3>Assign by route + capability</h3><p>Crew assignment accounts for travel zone, property type, scope complexity, duration, and finish or access notes—not just the nearest ZIP.</p></article>
          <article className="card"><span className="eyebrow">Schedule quality</span><h3>Protect realistic travel time</h3><p>A confirmed window should include the work duration and travel buffer needed to arrive prepared, especially for marinas, gated properties, and job sites.</p></article>
          <article className="card"><span className="eyebrow">Fallback</span><h3>Say no before overpromising</h3><p>If a route, property, date, or requested specialty cannot be responsibly covered, the operator should decline or offer another window before confirmation.</p></article>
        </div>
      </section>

      <section className="section">
        <div className="container final-cta card">
          <div><span className="eyebrow">Property-by-property</span><h2 className="section-title">Share the general location and two timing options.</h2><p className="copy">No street address or access code is needed to preview the request. Sensitive access details can be coordinated privately after fit is reviewed.</p></div>
          <div className="hero-actions"><Link className="btn btn-primary" href="/book">Check route fit</Link><Link className="btn btn-soft" href="/services">Compare services</Link></div>
        </div>
      </section>
    </div>
  );
}
