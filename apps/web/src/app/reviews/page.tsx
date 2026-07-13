import type { Metadata } from "next";
import Link from "next/link";

import { ReviewWall } from "@/components/ReviewWall";
import { getReviews } from "@/lib/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Customer feedback",
  description: "Verified customer feedback for Lake & Pine Cleaning Co.",
  robots: { index: false },
};

export default async function ReviewsPage() {
  const reviews = await getReviews();
  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Customer feedback</span>
          <h1>Only verified feedback belongs here.</h1>
          <p className="lead">Recovered placeholder testimonials are not published as customer proof.</p>
        </div>
      </div>
      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container">
          {reviews.length > 0 ? <ReviewWall reviews={reviews} /> : (
            <div className="card verified-empty">
              <h2>No verified reviews are published yet.</h2>
              <p className="copy">After completed services, the operator workflow can stage a review request. Nothing appears publicly until the feedback is real and approved.</p>
              <Link className="btn btn-soft" href="/services">Review the service menu</Link>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
