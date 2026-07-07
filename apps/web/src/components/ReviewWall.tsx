import type { Review } from "@/lib/data";

export function ReviewWall({ reviews }: { reviews: Review[] }) {
  return (
    <div className="review-wall">
      {reviews.map((review) => (
        <article key={review.id} className="review card">
          <div className="stars" aria-label={`${review.rating} stars`}>
            {"★".repeat(review.rating)}
          </div>
          <p className="copy">&ldquo;{review.body}&rdquo;</p>
          <div className="person">
            <div className="avatar">{review.author_initial}</div>
            <div>
              <strong>{review.author_name}</strong>
              <br />
              <span style={{ color: "var(--muted)" }}>{review.city}</span>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
