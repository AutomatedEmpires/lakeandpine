import Link from "next/link";

import type { Plan } from "@/lib/data";
import { formatDollars } from "@/lib/pricing";

export function PlanCards({ plans }: { plans: Plan[] }) {
  return (
    <div className="plans">
      {plans.map((plan) => (
        <article key={plan.id} className={`plan card${plan.popular ? " popular" : ""}`}>
          <span className="eyebrow">{plan.popular ? "Most popular" : "Plan"}</span>
          <h3 style={{ marginTop: 14 }}>{plan.name}</h3>
          <div className="save">{plan.save_label}</div>
          <div className="price">
            <b>{formatDollars(plan.price_cents)}</b>
            <span>/ clean</span>
          </div>
          <ul className="checks">
            {plan.features.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
          <Link
            className="btn btn-primary"
            style={{ marginTop: "auto", width: "100%" }}
            href={`/book?frequency=${plan.id}`}
          >
            Choose {plan.name}
          </Link>
        </article>
      ))}
    </div>
  );
}
