import type { Metadata } from "next";
import { Suspense } from "react";

import { BookingFlow } from "@/components/BookingFlow";
import { getAddons, getServices } from "@/lib/data";
import { requestIntakeEnabled } from "@/lib/env";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Request a Cleaning Plan",
  description:
    "Build a cleaning request with property details, room notes, preferences, pets, access planning, and a preferred service window.",
};

export default async function BookPage() {
  const [services, addons] = await Promise.all([getServices(), getAddons()]);

  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Service planning</span>
          <h1>Tell us how the home works—not just how many bedrooms it has.</h1>
          <p className="lead">
            Build a practical service request with room priorities, cleaning preferences, pets,
            access notes, and timing preferences. No payment is collected, and requested times
            are not confirmed until an operator reviews capacity.
          </p>
        </div>
      </div>
      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container">
          <Suspense>
            <BookingFlow services={services} addons={addons} intakeEnabled={requestIntakeEnabled} />
          </Suspense>
        </div>
      </section>
    </div>
  );
}
