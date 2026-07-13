import Link from "next/link";

import { ServiceShowcase } from "@/components/ServiceShowcase";
import { getServices } from "@/lib/data";

export const dynamic = "force-dynamic";

const WORKFLOW = [
  { number: "01", title: "Request", body: "Choose a service and describe the property without making a payment." },
  { number: "02", title: "Plan", body: "Room notes, preferences, pets, and access details shape a draft checklist." },
  { number: "03", title: "Review", body: "A human operator checks scope, estimate direction, timing, and open questions." },
  { number: "04", title: "Confirm", body: "Only then does a preferred window become a scheduled service." },
];

export default async function HomePage() {
  const services = await getServices();

  return (
    <div className="route-page">
      <section className="hero home-hero">
        <div className="container hero-grid">
          <div className="home-hero-copy">
            <span className="eyebrow">Cleaning, carefully planned</span>
            <h1>A cleaner home starts with a better handoff.</h1>
            <p className="lead">
              Lake &amp; Pine helps a homeowner describe what matters, turns those details into
              a practical service plan, and gives an operator one calm place to manage the work.
            </p>
            <div className="hero-actions">
              <Link className="btn btn-primary" href="/book">Build a service request</Link>
              <Link className="btn btn-soft" href="/services">See the service menu</Link>
            </div>
            <div className="honest-proof-row">
              <span>Room-by-room planning</span>
              <span>Human confirmation</span>
              <span>No online payment</span>
              <span>Status visibility</span>
            </div>
          </div>

          <div className="service-plan-preview card">
            <div className="plan-preview-head">
              <div><span className="eyebrow">Draft service plan</span><h2>Saturday home reset</h2></div>
              <span className="status-badge reviewing">reviewing</span>
            </div>
            <div className="plan-preview-property">
              <span>Property profile</span><strong>House · 3 bed · 2 bath · one floor</strong>
            </div>
            <div className="plan-preview-rooms">
              {["Kitchen", "Bathrooms", "Living room", "Primary bedroom"].map((room, index) => <div key={room}><span>{String(index + 1).padStart(2, "0")}</span><strong>{room}</strong><small>{index === 0 ? "Focus floors + cabinet fronts" : "Standard room scope"}</small></div>)}
            </div>
            <div className="plan-preview-bottom">
              <div><span>Preferences</span><p>Unscented · shoes off · friendly dog</p></div>
              <div className="plan-score"><span>Plan score</span><strong>38</strong><small>standard</small></div>
            </div>
          </div>
        </div>
      </section>

      <section className="section workflow-section">
        <div className="container">
          <div className="section-head">
            <div><span className="eyebrow">One service workflow</span><h2 className="section-title">The website and the operation share the same plan.</h2></div>
            <p className="copy">The customer does not disappear into a generic contact form. The operator receives structured scope and a first checklist.</p>
          </div>
          <div className="workflow-grid">{WORKFLOW.map((item) => <article key={item.number} className="card workflow-card"><span>{item.number}</span><h3>{item.title}</h3><p>{item.body}</p></article>)}</div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head"><div><span className="eyebrow">Service menu</span><h2 className="section-title">Start with the closest fit. Refine the scope together.</h2></div><p className="copy">Prices are starting planning anchors. Condition, access, rooms, add-ons, and special work can change the final quote.</p></div>
          <ServiceShowcase services={services} />
        </div>
      </section>

      <section className="section">
        <div className="container planning-story card">
          <div><span className="eyebrow">Built for real homes</span><h2 className="section-title">The details a cleaner actually needs.</h2><p className="copy">A useful plan remembers the primary shower glass, the dog by the back door, the surface that needs unscented product, and the room that can wait.</p><Link className="btn btn-primary" href="/book">Preview the planning flow</Link></div>
          <div className="planning-story-list">
            <article><span>01</span><div><strong>Property profile</strong><p>Type, size, rooms, floors, and current condition.</p></div></article>
            <article><span>02</span><div><strong>Room notes</strong><p>Scope and priorities where the work happens.</p></div></article>
            <article><span>03</span><div><strong>Pets + access</strong><p>Arrival context without asking for a door code in preview.</p></div></article>
            <article><span>04</span><div><strong>Checklist direction</strong><p>A draft the operator can review before service.</p></div></article>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container dual-experience">
          <article className="card"><span className="eyebrow">For the homeowner</span><h2>One place to see what happens next.</h2><ul className="checks"><li>Requested versus confirmed timing</li><li>Saved home and cleaning preferences</li><li>Service status and reschedule requests</li><li>A human support thread when enabled</li></ul><Link className="btn btn-soft" href="/dashboard">Preview customer dashboard</Link></article>
          <article className="card operator-teaser"><span className="eyebrow">For the operator</span><h2>A queue built around the job, not the lead.</h2><ul className="checks"><li>Scope review and planning score</li><li>Private room, pet, and access notes</li><li>Service checklist and internal notes</li><li>Manual follow-up and review request queue</li></ul><p className="copy">The operator route is private and demo-only until staff access is configured.</p></article>
        </div>
      </section>

      <section className="section">
        <div className="container final-cta card">
          <div><span className="eyebrow">Phase 1 · request + planning</span><h2 className="section-title">Build the plan before booking the visit.</h2><p className="copy">Preview the full request experience. Public data intake stays off until the founder approves it, and no payment is collected.</p></div>
          <div className="hero-actions"><Link className="btn btn-primary" href="/book">Start a plan</Link><Link className="btn btn-soft" href="/services">Compare services</Link></div>
        </div>
      </section>
    </div>
  );
}
