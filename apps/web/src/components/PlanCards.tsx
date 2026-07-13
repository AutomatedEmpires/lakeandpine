import Link from "next/link";

import type { Plan } from "@/lib/data";
import { formatDollars } from "@/lib/pricing";

export function PlanCards({ plans }: { plans: Plan[] }) {
  return (
    <div className="plans">
      {plans.map((plan) => (
        <article key={plan.id} className="plan card">
          <span className="eyebrow">Planning cadence</span>
          <h3 style={{ marginTop: 14 }}>{plan.name}</h3>
          <div className="save">starting planning anchor</div>
          <div className="price">
            <b>{formatDollars(plan.price_cents)}</b>
            <span>/ clean</span>
          </div>
          <ul className="checks">
            <li>Final cadence confirmed by operator</li>
            <li>Room preferences stay with the plan</li>
            <li>No online payment in Phase 1</li>
          </ul>
          <Link
            className="btn btn-primary"
            style={{ marginTop: "auto", width: "100%" }}
            href={`/book?frequency=${plan.id}`}
          >
            Request {plan.name.toLowerCase()}
          </Link>
        </article>
      ))}
    </div>
  );
}
