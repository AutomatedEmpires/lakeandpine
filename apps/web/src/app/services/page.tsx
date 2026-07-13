import type { Metadata } from "next";
import Link from "next/link";

import { MARKET_PROGRAMS } from "@/lib/market-content";

export const metadata: Metadata = {
  title: "Premium Cleaning Services",
  description:
    "Explore private estate care, construction handoff cleaning, lake and marine interior care, and select commercial cleaning programs.",
  alternates: { canonical: "/services" },
};

export default function ServicesPage() {
  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Premium cleaning programs</span>
          <h1>Defined around the property—not pulled from a generic checklist.</h1>
          <p className="lead">
            Start with the closest program. An operator then reviews the property, surfaces,
            access, condition, preferred timing, and exclusions before confirming service.
          </p>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/book">Request a scope review</Link>
            <Link className="btn btn-soft" href="/pricing">Understand pricing</Link>
          </div>
        </div>
      </div>

      <section className="section service-programs" style={{ paddingTop: 20 }}>
        <div className="container service-program-list">
          {MARKET_PROGRAMS.map((program, index) => (
            <article className="card service-program" id={program.slug} key={program.slug}>
              <div className="service-program-intro">
                <span className="program-number">0{index + 1}</span>
                <span className="eyebrow">{program.eyebrow}</span>
                <h2>{program.title}</h2>
                <p className="lead">{program.summary}</p>
                <Link className="btn btn-primary" href={`/book?program=${program.slug}`}>
                  Discuss this property
                </Link>
              </div>
              <div className="service-program-detail">
                <div>
                  <h3>Best aligned with</h3>
                  <ul className="checks">
                    {program.bestFor.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
                <div>
                  <h3>The planning brief covers</h3>
                  <ul className="checks">
                    {program.planIncludes.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
                <aside className="scope-boundary">
                  <strong>Scope boundary</strong>
                  <p>{program.boundaries}</p>
                </aside>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="container final-cta card">
          <div>
            <span className="eyebrow">Not sure which program fits?</span>
            <h2 className="section-title">Describe the outcome, not the service label.</h2>
            <p className="copy">Tell us whether the property needs to be ready for an owner arrival, final walkthrough, opening day, departure, or a reliable recurring rhythm.</p>
          </div>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/book">Start the conversation</Link>
            <Link className="btn btn-soft" href="/who-we-serve">Compare property types</Link>
          </div>
        </div>
      </section>
    </div>
  );
}
