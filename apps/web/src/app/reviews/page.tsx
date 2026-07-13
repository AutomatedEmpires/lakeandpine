import type { Metadata } from "next";
import Link from "next/link";

import { ReviewWall } from "@/components/ReviewWall";
import { getReviews } from "@/lib/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Customer Feedback",
  description: "Verified customer feedback and Lake & Pine's approach to publishing service proof.",
  alternates: { canonical: "/reviews" },
  robots: { index: false },
};

export default async function ReviewsPage() {
  const reviews = await getReviews();
  return (
    <div className="route-page">
      <div className="container page-hero"><div className="page-panel"><span className="eyebrow">Customer feedback</span><h1>Proof without theater.</h1><p className="lead">Lake &amp; Pine does not publish recovered placeholders, sample praise, or invented customer counts. This page remains quiet until feedback comes from completed work.</p></div></div>
      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container">
          {reviews.length > 0 ? <ReviewWall reviews={reviews} /> : (
            <div className="card verified-empty honest-empty" aria-labelledby="reviews-empty-title">
              <span className="empty-mark" aria-hidden>0</span>
              <span className="eyebrow">Honest empty state</span>
              <h2 id="reviews-empty-title">No verified reviews are published yet.</h2>
              <p className="copy">The business is pre-customer. When real services are completed, feedback can be requested, associated with the completed job, reviewed for authenticity and privacy, and published only with appropriate permission.</p>
              <div className="hero-actions"><Link className="btn btn-primary" href="/book">Request a consultation</Link><Link className="btn btn-soft" href="/services">Explore services</Link></div>
            </div>
          )}
        </div>
      </section>
      <section className="section">
        <div className="container service-explainer-grid">
          <article className="card"><span className="eyebrow">Source</span><h3>Completed work only</h3><p>Public feedback should trace to a real Lake &amp; Pine service—not a prototype, employee-written example, or imported competitor review.</p></article>
          <article className="card"><span className="eyebrow">Privacy</span><h3>Publish the minimum</h3><p>Use only the customer-approved name treatment, general location, and relevant service context. Do not expose property or access details.</p></article>
          <article className="card"><span className="eyebrow">Integrity</span><h3>No editing the meaning</h3><p>Formatting or shortening should not turn mixed or critical feedback into praise. Concerns belong in the service-recovery workflow first.</p></article>
        </div>
      </section>
    </div>
  );
}
