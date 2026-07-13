import type { Metadata } from "next";
import Link from "next/link";

import { MARKET_PROGRAMS, OPERATING_POLICIES, SERVICE_STAGES } from "@/lib/market-content";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function HomePage() {
  return (
    <div className="route-page">
      <section className="hero home-hero">
        <div className="container hero-grid premium-hero-grid">
          <div className="home-hero-copy">
            <span className="eyebrow">Private homes · projects · vessels · workplaces</span>
            <h1>Interior care for exceptional properties.</h1>
            <p className="lead">
              From final walkthrough to ready-for-arrival, Lake &amp; Pine builds a defined
              cleaning plan around the property, its finishes, its access, and the people who
              use it.
            </p>
            <div className="hero-actions">
              <Link className="btn btn-primary" href="/book">
                Request a private consultation
              </Link>
              <Link className="btn btn-soft" href="/who-we-serve">
                See who we serve
              </Link>
            </div>
            <div className="honest-proof-row" aria-label="Service principles">
              <span>Scope reviewed first</span>
              <span>Preferred + alternate timing</span>
              <span>Human confirmation</span>
              <span>No online payment</span>
            </div>
          </div>

          <div className="service-plan-preview card premium-brief" aria-label="Example project brief">
            <div className="plan-preview-head">
              <div>
                <span className="eyebrow">Illustrative scope brief</span>
                <h2>Residence arrival plan</h2>
              </div>
              <span className="status-badge reviewing">scope review</span>
            </div>
            <div className="plan-preview-property">
              <span>Program</span>
              <strong>Private estate care · seasonal arrival</strong>
            </div>
            <div className="plan-preview-rooms">
              {[
                ["Arrival spaces", "Entry, kitchen, primary suite"],
                ["Finish notes", "Stone, wood, glass, owner products"],
                ["Access", "Gate, parking, property contact"],
                ["Timing", "Preferred window + alternate"],
              ].map(([label, detail], index) => (
                <div key={label}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </div>
              ))}
            </div>
            <div className="plan-preview-bottom">
              <div>
                <span>Next decision</span>
                <p>Confirm scope, route fit, crew time, and arrival window.</p>
              </div>
              <div className="plan-score premium-mark">
                <span>Lake</span>
                <strong>&amp;</strong>
                <small>Pine</small>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section audience-section">
        <div className="container">
          <div className="section-head">
            <div>
              <span className="eyebrow">Four focused programs</span>
              <h2 className="section-title">One standard: understand the property before promising the work.</h2>
            </div>
            <p className="copy">
              Lake &amp; Pine is built for premium residential care, construction handoffs,
              marine interiors, and select professional spaces where planning, finish knowledge,
              and accountable closeout materially improve the outcome.
            </p>
          </div>
          <div className="program-grid">
            {MARKET_PROGRAMS.map((program, index) => (
              <article className="card program-card" key={program.slug}>
                <span className="program-number">0{index + 1}</span>
                <span className="eyebrow">{program.eyebrow}</span>
                <h3>{program.title}</h3>
                <p>{program.summary}</p>
                <Link href={`/who-we-serve#${program.slug}`}>Explore this program <span aria-hidden>→</span></Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section pine-band">
        <div className="container premium-promise">
          <div>
            <span className="eyebrow">Premium means specific</span>
            <h2 className="section-title">Care is a plan, not a slogan.</h2>
          </div>
          <div className="premium-principles">
            <article>
              <strong>Property-specific</strong>
              <p>Rooms, zones, finishes, access, occupancy, and priorities stay attached to the request.</p>
            </article>
            <article>
              <strong>Confirmation before commitment</strong>
              <p>A preferred time is not presented as an appointment until scope and capacity are reviewed.</p>
            </article>
            <article>
              <strong>Boundaries in writing</strong>
              <p>Included work, exclusions, open questions, and the closeout path should be understood before service.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="section workflow-section">
        <div className="container">
          <div className="section-head">
            <div>
              <span className="eyebrow">The service journey</span>
              <h2 className="section-title">Request, scope, confirm, close out.</h2>
            </div>
            <p className="copy">
              The public experience and the operating handoff share the same facts—so a
              consultation can become a usable service plan instead of a vague inbox message.
            </p>
          </div>
          <div className="workflow-grid">
            {SERVICE_STAGES.map((item) => (
              <article key={item.number} className="card workflow-card">
                <span>{item.number}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container planning-story card">
          <div>
            <span className="eyebrow">A more useful first conversation</span>
            <h2 className="section-title">The details a premium crew actually needs.</h2>
            <p className="copy">
              A great handoff records the fragile finish, the occupied wing, the marina gate,
              the active trade, the presentation deadline, and the room that matters most.
            </p>
            <Link className="btn btn-primary" href="/book">
              Build a consultation request
            </Link>
          </div>
          <div className="planning-story-list">
            {[
              ["01", "Property profile", "Type, scale, condition, zones, and current project phase."],
              ["02", "Finish + room notes", "Material sensitivity, owner products, and priority spaces."],
              ["03", "Access + timing", "Arrival, parking, dock, gate, occupancy, and preferred windows."],
              ["04", "Closeout direction", "Walkthrough target, open questions, and concern-resolution path."],
            ].map(([number, title, body]) => (
              <article key={number}>
                <span>{number}</span>
                <div><strong>{title}</strong><p>{body}</p></div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section service-policy-section">
        <div className="container">
          <div className="section-head">
            <div>
              <span className="eyebrow">After the request</span>
              <h2 className="section-title">Clear next steps when plans change.</h2>
            </div>
            <p className="copy">These are operating expectations, not automatic guarantees or a substitute for a confirmed service agreement.</p>
          </div>
          <div className="policy-grid">
            {OPERATING_POLICIES.map((policy) => (
              <article className="card policy-card" key={policy.title}>
                <h3>{policy.title}</h3>
                <p>{policy.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container final-cta card">
          <div>
            <span className="eyebrow">Begin with fit</span>
            <h2 className="section-title">Tell us what the property needs to be ready for.</h2>
            <p className="copy">
              Share a preferred window and an alternate. No card is charged and no appointment
              is promised until an operator confirms the scope and schedule.
            </p>
          </div>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/book">Request a consultation</Link>
            <Link className="btn btn-soft" href="/pricing">How pricing works</Link>
          </div>
        </div>
      </section>
    </div>
  );
}
