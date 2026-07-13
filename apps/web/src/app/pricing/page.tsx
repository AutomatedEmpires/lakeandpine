import type { Metadata } from "next";
import Link from "next/link";

import { PRICING_FACTORS } from "@/lib/market-content";

export const metadata: Metadata = {
  title: "Pricing & Proposals",
  description:
    "Learn how Lake & Pine scopes custom residential, construction, marine-interior, and commercial cleaning proposals.",
  alternates: { canonical: "/pricing" },
};

export default function PricingPage() {
  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Pricing + proposals</span>
          <h1>Premium work deserves a scope before a number.</h1>
          <p className="lead">
            Large residences, construction handoffs, vessel interiors, and professional spaces
            vary too much for a responsible flat-price promise. Lake &amp; Pine starts with a
            planning estimate, then confirms a written scope and price before scheduling.
          </p>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/book">Request a planning estimate</Link>
            <Link className="btn btn-soft" href="/services">Compare programs</Link>
          </div>
        </div>
      </div>

      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container pricing-method-grid">
          <article className="card pricing-method-lead">
            <span className="eyebrow">What shapes the proposal</span>
            <h2 className="section-title">The labor follows the property.</h2>
            <p className="copy">A planning estimate is directional. The final quote can change after access, condition, specialty surfaces, project readiness, or requested scope is reviewed.</p>
            <div className="factor-grid">
              {PRICING_FACTORS.map((factor, index) => (
                <div key={factor}><span>{String(index + 1).padStart(2, "0")}</span><strong>{factor}</strong></div>
              ))}
            </div>
          </article>
          <aside className="estimate-result proposal-card">
            <div>
              <span className="eyebrow">Custom proposal</span>
              <h2>Scope first.</h2>
              <p>No teaser discount, invented savings percentage, or payment required to submit a request.</p>
            </div>
            <ol className="proposal-steps">
              <li><span>1</span> Share property and timing context</li>
              <li><span>2</span> Complete a call or walkthrough if needed</li>
              <li><span>3</span> Review inclusions, exclusions, and price</li>
              <li><span>4</span> Confirm the appointment in writing</li>
            </ol>
            <Link className="btn btn-soft" href="/book">Begin a scope request</Link>
          </aside>
        </div>
      </section>

      <section className="section">
        <div className="container service-explainer-grid pricing-notes">
          <article className="card"><span className="eyebrow">Estimate</span><h3>A planning range</h3><p>Useful for an initial fit conversation. It is not a final quote, invoice, or authorization to begin work.</p></article>
          <article className="card"><span className="eyebrow">Quote</span><h3>Defined scope + price</h3><p>Prepared after the operator has enough information. Any assumptions or exclusions should be visible before confirmation.</p></article>
          <article className="card"><span className="eyebrow">Change</span><h3>Approval before extra work</h3><p>If conditions or requested work materially change, the operator should explain the effect on scope, timing, and price before proceeding.</p></article>
        </div>
      </section>

      <section className="section">
        <div className="container final-cta card">
          <div><span className="eyebrow">No online payment today</span><h2 className="section-title">A request starts a review—not a charge.</h2><p className="copy">Payment, deposit, cancellation, and refund terms must be disclosed in the confirmed proposal if they apply. This website does not currently collect a card.</p></div>
          <div className="hero-actions"><Link className="btn btn-primary" href="/book">Request a consultation</Link><Link className="btn btn-soft" href="/terms">Read service-request terms</Link></div>
        </div>
      </section>
    </div>
  );
}
