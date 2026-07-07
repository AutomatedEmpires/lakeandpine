import Link from "next/link";

import { AreaMapSvg } from "@/components/AreaMapSvg";
import { EstimateStudio } from "@/components/EstimateStudio";
import { FaqList } from "@/components/FaqList";
import { LeadForm } from "@/components/LeadForm";
import { PlanCards } from "@/components/PlanCards";
import { ReviewWall } from "@/components/ReviewWall";
import { ServiceShowcase } from "@/components/ServiceShowcase";
import { getFaqs, getPlans, getReviews, getServiceAreas, getServices } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [services, plans, reviews, faqs, areas] = await Promise.all([
    getServices(),
    getPlans(),
    getReviews(4),
    getFaqs(),
    getServiceAreas(),
  ]);

  return (
    <div className="route-page">
      {/* Hero */}
      <section className="hero">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow">✦ Premium cleaning for CDA + Spokane</span>
            <h1>Beautifully managed home cleaning for people who value their time.</h1>
            <p className="lead">
              Lake &amp; Pine turns house cleaning into a polished service experience: instant
              estimate, AI help, calendar scheduling, vetted cleaners, text updates,
              eco-conscious products, and a customer dashboard that remembers your home.
            </p>
            <div className="hero-actions">
              <Link className="btn btn-primary" href="/book">
                Book the first clean
              </Link>
              <a className="btn btn-soft" href="#quote">
                Get instant estimate
              </a>
              <Link className="btn btn-ghost" href="/services">
                Explore services
              </Link>
            </div>
            <div className="proof-row">
              <div className="proof">
                ★ 4.9 <small>300+ local clients</small>
              </div>
              <div className="proof">
                🛡️ Insured <small>bonded + vetted</small>
              </div>
              <div className="proof">
                🌿 Eco <small>pet-safe options</small>
              </div>
              <div className="proof">
                ⚡ Fast <small>same-week windows</small>
              </div>
            </div>
          </div>
          <div className="stage">
            <div className="floating float-review">
              <div className="float-title">
                <span className="float-icon">🏡</span>
                <span>
                  Lake-home ready
                  <br />
                  <small style={{ color: "var(--muted)" }}>CDA · Hayden · Post Falls</small>
                </span>
              </div>
              <div className="stars">★★★★★</div>
              <p style={{ margin: "8px 0 0", color: "var(--muted)" }}>
                &ldquo;Hotel-level clean without the cold franchise feel.&rdquo;
              </p>
            </div>
            <div className="hero-phone">
              <div className="phone-screen">
                <div className="phone-top">
                  <span style={{ fontWeight: 950, letterSpacing: "-.05em" }}>Lake &amp; Pine</span>
                  <span>10:24</span>
                </div>
                <div className="phone-hero">
                  <span className="sparkle a" />
                  <span className="sparkle b" />
                  <span className="sparkle c" />
                </div>
                <div className="phone-metrics">
                  <div className="phone-metric">
                    $139<small>estimate</small>
                  </div>
                  <div className="phone-metric">
                    Same wk<small>next slot</small>
                  </div>
                  <div className="phone-metric">
                    4.9★<small>rating</small>
                  </div>
                </div>
                <div className="app-card">
                  <div className="app-row">
                    <strong>Essential Home Reset</strong>
                    <span className="status-dot" />
                  </div>
                  <p style={{ color: "#607a75", margin: "8px 0 12px" }}>
                    Kitchen, baths, floors, dusting, trash, beds, surfaces, and calm restored.
                  </p>
                  <Link className="btn btn-primary" style={{ width: "100%" }} href="/book?service=essential">
                    Book this clean
                  </Link>
                </div>
                <div className="app-card">
                  <strong>Cleaner notes</strong>
                  <p style={{ color: "#607a75", margin: "8px 0 0" }}>
                    Use unscented products. Dog is friendly. Focus on kitchen floors and
                    lake-room glass.
                  </p>
                </div>
              </div>
            </div>
            <div className="floating float-estimate">
              <div className="float-title">
                <span className="float-icon">⚡</span>
                <span>Live quote studio</span>
              </div>
              <div className="mini-grid">
                <div className="mini-field">3 bed</div>
                <div className="mini-field">2 bath</div>
                <div className="mini-field">Bi-weekly</div>
                <div className="mini-field">1 pet</div>
              </div>
              <h3 style={{ fontSize: 46, letterSpacing: "-.08em", margin: "14px 0 0" }}>
                from $139
              </h3>
            </div>
            <div className="floating float-chat">
              <div className="float-title">
                <span className="float-icon">🤖</span>
                <span>Pine Concierge</span>
              </div>
              <p style={{ color: "var(--muted)", margin: 0 }}>
                &ldquo;I can help choose a clean, estimate price, and schedule your first
                visit.&rdquo;
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Bento */}
      <section className="section">
        <div className="container">
          <div className="section-head">
            <div>
              <span className="eyebrow">The upgrade</span>
              <h2 className="section-title">
                Not just a cleaning website. A home-service operating system.
              </h2>
            </div>
            <p className="copy">
              Every section moves the homeowner closer to choosing a service, seeing a starting
              price, scheduling a window, and trusting the team.
            </p>
          </div>
          <div className="bento">
            <article className="tile large card">
              <div>
                <div className="icon">🪄</div>
                <h3>From cluttered home to reset sanctuary.</h3>
                <p>
                  Premium visuals, emotional copy, and service clarity make the company feel
                  organized before the cleaner ever arrives.
                </p>
              </div>
              <div className="shine" />
            </article>
            <article className="tile mid card">
              <div className="icon">⚡</div>
              <div>
                <h3>Instant estimate</h3>
                <p>Starting prices without pretending every home is identical.</p>
              </div>
            </article>
            <article className="tile mid card">
              <div className="icon">📅</div>
              <div>
                <h3>Calendar flow</h3>
                <p>Date, time, home details, add-ons, notes, and confirmation.</p>
              </div>
            </article>
            <article className="tile wide card">
              <div className="icon">🤖</div>
              <div>
                <h3>Chat concierge</h3>
                <p>Guides you through service choice, pricing, FAQs, and booking.</p>
              </div>
            </article>
            <article className="tile wide card">
              <div className="icon">📍</div>
              <div>
                <h3>Local roots</h3>
                <p>CDA, Spokane, Post Falls, Hayden, Liberty Lake, Spokane Valley, and Rathdrum.</p>
              </div>
            </article>
            <article className="tile wide card">
              <div className="icon">🔐</div>
              <div>
                <h3>Customer dashboard</h3>
                <p>Upcoming cleans, notes, invoices, referrals, support, and recurring plan control.</p>
              </div>
            </article>
          </div>
        </div>
      </section>

      {/* Service showcase */}
      <section className="section">
        <div className="container">
          <ServiceShowcase services={services} />
        </div>
      </section>

      {/* Estimate studio */}
      <section className="section" id="quote">
        <div className="container">
          <div className="section-head">
            <div>
              <span className="eyebrow">Estimate studio</span>
              <h2 className="section-title">
                A pricing flow that feels transparent and premium.
              </h2>
            </div>
            <p className="copy">
              Prices are starting anchors, not final locked quotes. We make that explicit while
              still giving you a confident number.
            </p>
          </div>
          <EstimateStudio />
        </div>
      </section>

      {/* Plans */}
      <section className="section">
        <div className="container">
          <div className="section-head">
            <div>
              <span className="eyebrow">Starting price anchors</span>
              <h2 className="section-title">
                Recurring plans that make the next step obvious.
              </h2>
            </div>
            <Link className="btn btn-soft" href="/pricing">
              Open pricing
            </Link>
          </div>
          <PlanCards plans={plans} />
        </div>
      </section>

      {/* Scheduling steps */}
      <section className="section">
        <div className="container">
          <div className="section-head">
            <div>
              <span className="eyebrow">Scheduling</span>
              <h2 className="section-title">From quote to calendar in one smooth flow.</h2>
            </div>
            <p className="copy">
              Booking covers service selection, home details, add-ons, date and time, contact
              info, and confirmation.
            </p>
          </div>
          <div className="steps">
            {[
              ["Choose service", "Pick the clean that fits the home."],
              ["Describe home", "Rooms, pets, condition, access, and priorities."],
              ["Pick window", "Same-week slots and recurring preferences."],
              ["Confirm", "Get SMS updates and dashboard access."],
            ].map(([title, body], i) => (
              <article key={title} className="step card">
                <div className="step-num">{i + 1}</div>
                <h3>{title}</h3>
                <p className="copy">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Reviews */}
      <section className="section">
        <div className="container reviews-grid">
          <aside className="card" style={{ padding: 28 }}>
            <span className="eyebrow">Trust</span>
            <h2 className="section-title" style={{ fontSize: 48 }}>
              Specific, local, confidence-building proof.
            </h2>
            <div className="stars">★★★★★</div>
            <p className="copy">
              <strong>4.9 average</strong> from 300+ local clients across CDA, Spokane, Post
              Falls, Hayden, and Liberty Lake.
            </p>
            <Link className="btn btn-primary" style={{ marginTop: 16 }} href="/reviews">
              Read reviews
            </Link>
          </aside>
          <ReviewWall reviews={reviews} />
        </div>
      </section>

      {/* Service areas */}
      <section className="section">
        <div className="container map-section">
          <div className="card" style={{ padding: 28 }}>
            <span className="eyebrow">Local service</span>
            <h2 className="section-title" style={{ fontSize: 48 }}>
              Built for the Inland Northwest.
            </h2>
            <p className="copy">
              Human local pages for every city we serve — real neighborhoods, real service
              angles, direct booking.
            </p>
            <ul className="checks" style={{ margin: "18px 0 22px" }}>
              {areas.map((area) => (
                <li key={area.slug}>
                  <Link href={`/areas/${area.slug}`}>{area.city}</Link>
                </li>
              ))}
            </ul>
            <Link className="btn btn-soft" href="/areas">
              Open service areas
            </Link>
          </div>
          <AreaMapSvg />
        </div>
      </section>

      {/* FAQ */}
      <section className="section">
        <div className="container">
          <div className="section-head">
            <div>
              <span className="eyebrow">FAQ</span>
              <h2 className="section-title">
                Answer the questions that stop people from booking.
              </h2>
            </div>
          </div>
          <FaqList faqs={faqs} />
        </div>
      </section>

      {/* Final CTA */}
      <section className="section">
        <div className="container final-cta card">
          <div>
            <span className="eyebrow">Book</span>
            <h2 className="section-title">Ready for the first clean?</h2>
            <p className="copy">
              Request your clean here, or go straight to booking to lock a window. Pine
              Concierge can help you choose.
            </p>
          </div>
          <LeadForm services={services.filter((s) => s.bookable)} />
        </div>
      </section>
    </div>
  );
}
