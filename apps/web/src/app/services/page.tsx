import type { Metadata } from "next";

import { ServiceShowcase } from "@/components/ServiceShowcase";
import { getServices } from "@/lib/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Services",
  description:
    "Recurring home resets, deep cleans, move in/out details, vacation rental turnovers, small office refreshes, and add-ons across Coeur d'Alene and Spokane.",
};

export default async function ServicesPage() {
  const services = await getServices();

  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Services</span>
          <h1>Cleaning packages with premium clarity.</h1>
          <p className="lead">
            Six service modules, each with a transparent starting anchor, a defined scope, and a
            direct path to booking.
          </p>
        </div>
      </div>
      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container">
          <ServiceShowcase services={services} />
        </div>
      </section>
    </div>
  );
}
