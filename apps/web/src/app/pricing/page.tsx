import type { Metadata } from "next";
import Link from "next/link";

import { PlanCards } from "@/components/PlanCards";
import { getAddons, getPlans } from "@/lib/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Starting planning anchors for weekly, bi-weekly, monthly, and one-time cleaning requests.",
};

export default async function PricingPage() {
  const [plans, addons] = await Promise.all([getPlans(), getAddons()]);

  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Pricing</span>
          <h1>Starting prices without the mystery.</h1>
          <p className="lead">
            Starting anchors, clear assumptions, visible add-ons, and a quote path — final
            pricing is confirmed before an appointment is scheduled.
          </p>
        </div>
      </div>
      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container">
          <PlanCards plans={plans} />
          <div className="quote-lab" style={{ marginTop: 22 }}>
            <div className="quote-panel card">
              <h2>What affects price?</h2>
              <p className="copy">
                Square footage, bedrooms, bathrooms, condition, pets, frequency, add-ons, access
                complexity, and special requests.
              </p>
              <div className="tag-row" style={{ marginTop: 18 }}>
                {addons.map((addon) => (
                  <span key={addon.id} className="tag">
                    {addon.title} {addon.price_label}
                  </span>
                ))}
              </div>
            </div>
            <div className="estimate-result">
              <div>
                <span className="eyebrow">Sample</span>
                <div className="big">$139</div>
                <p>Essential Home Reset, bi-weekly, 1,200–2,000 sq ft starting point.</p>
              </div>
              <div style={{ display: "grid", gap: 10 }}>
                <Link className="btn btn-soft" href="/#quote">
                  Get your own number
                </Link>
                <Link className="btn btn-soft" href="/book">
                  Start a service request
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
