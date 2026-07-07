import type { Metadata } from "next";

import { FaqList } from "@/components/FaqList";
import { ReviewWall } from "@/components/ReviewWall";
import { getFaqs, getReviews } from "@/lib/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Reviews",
  description:
    "What homeowners across Coeur d'Alene, Spokane, Post Falls, Hayden, and Liberty Lake say about Lake & Pine Cleaning Co.",
};

export default async function ReviewsPage() {
  const [reviews, faqs] = await Promise.all([getReviews(), getFaqs()]);

  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Reviews</span>
          <h1>Proof that sells reliability.</h1>
          <p className="lead">
            Real words from local homes — recurring resets, rental turnovers, and move-out
            details across the Inland Northwest.
          </p>
        </div>
      </div>
      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container">
          <ReviewWall reviews={reviews} />
        </div>
      </section>
      <section className="section">
        <div className="container">
          <FaqList faqs={faqs} />
        </div>
      </section>
    </div>
  );
}
