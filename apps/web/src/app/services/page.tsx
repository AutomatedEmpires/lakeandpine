import type { Metadata } from "next";

import { ServiceShowcase } from "@/components/ServiceShowcase";
import { getServices } from "@/lib/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Services",
  description:
    "Compare recurring resets, deep cleans, move in/out details, turnovers, office refreshes, and add-on planning scopes.",
};

export default async function ServicesPage() {
  const services = await getServices();

  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Service menu</span>
          <h1>A practical starting scope for each kind of clean.</h1>
          <p className="lead">
            Choose the closest service shape, then use the request flow to add rooms,
            preferences, access context, and timing. Final scope and availability require an
            operator review.
          </p>
        </div>
      </div>
      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container">
          <ServiceShowcase services={services} />
          <div className="service-explainer-grid">
            <article className="card"><span className="eyebrow">Included in every request</span><h3>Property + room plan</h3><p>Home size, condition, selected rooms, notes, preferences, pets, and access context.</p></article>
            <article className="card"><span className="eyebrow">Before confirmation</span><h3>Human scope review</h3><p>An operator checks checklist direction, pricing assumptions, timing, and anything that needs a conversation.</p></article>
            <article className="card"><span className="eyebrow">Not in Phase 1</span><h3>No online payment</h3><p>The workflow creates a request and planning record only. It does not charge a card or promise a time slot.</p></article>
          </div>
        </div>
      </section>
    </div>
  );
}
