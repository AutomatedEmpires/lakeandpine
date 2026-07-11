import type { Metadata } from "next";
import { Suspense } from "react";

import { BookingFlow } from "@/components/BookingFlow";
import { getAddons, getServices } from "@/lib/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Book a Clean",
  description:
    "Schedule your home cleaning online: pick a service, describe your home, choose add-ons, and lock a same-week arrival window.",
};

export default async function BookPage() {
  const [services, addons] = await Promise.all([getServices(), getAddons()]);

  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Booking</span>
          <h1>From quote to calendar in two minutes.</h1>
          <p className="lead">
            Service, home details, add-ons, date and time, contact — then we confirm your final
            quote and text you updates.
          </p>
        </div>
      </div>
      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container">
          <Suspense>
            <BookingFlow services={services} addons={addons} />
          </Suspense>
        </div>
      </section>
    </div>
  );
}
