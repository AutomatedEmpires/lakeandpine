import type { Metadata } from "next";
import { Suspense } from "react";

import { CustomerSchedulingFlow } from "@/components/CustomerSchedulingFlow";
import { PremiumRequestFlow } from "@/components/PremiumRequestFlow";
import {
  customerSchedulingEnabled,
  requestIntakeEnabled,
} from "@/lib/env";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Schedule Service or Request a Consultation",
  description:
    "See capacity-backed Lake & Pine service windows for eligible work, or continue to an operator-reviewed consultation for complex scope.",
  alternates: { canonical: "/book" },
};

export default async function BookPage() {
  if (customerSchedulingEnabled) {
    return (
      <div className="route-page">
        <div className="container page-hero">
          <div className="page-panel">
            <span className="eyebrow">Capacity-backed scheduling</span>
            <h1>Find a real service time.</h1>
            <p className="lead">
              Share the minimum property context, see genuinely holdable windows, and reserve
              eligible service without signing in. Complex work moves to a consultation with
              your answers preserved.
            </p>
            <div className="honest-proof-row"><span>Real crew capacity</span><span>Local timezone</span><span>Clear hold status</span><span>No payment collected</span></div>
            <p className="scope-note">Do not enter door codes, payment details, or unnecessary access secrets. Secure access planning happens after scheduling.</p>
          </div>
        </div>
        <section className="section" style={{ paddingTop: 20 }}>
          <div className="container">
            <Suspense>
              <CustomerSchedulingFlow consultationIntakeEnabled={requestIntakeEnabled} />
            </Suspense>
          </div>
        </section>
      </div>
    );
  }
  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Private consultation request</span>
          <h1>Tell us what the property needs to be ready for.</h1>
          <p className="lead">
            Build a practical brief with property context, priority rooms or zones, finishes,
            access notes, and a preferred service window. No payment is collected, and requested
            times are not confirmed until an operator reviews scope, route fit, and capacity.
          </p>
          <div className="honest-proof-row"><span>Private estates</span><span>Construction handoffs</span><span>Marine interiors</span><span>Select commercial</span></div>
          <p className="scope-note">Keep door codes, payment details, and other unnecessary sensitive information out of this form. Secure access planning happens only after fit is reviewed.</p>
        </div>
      </div>
      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container">
          <Suspense>
            <PremiumRequestFlow intakeEnabled={requestIntakeEnabled} />
          </Suspense>
        </div>
      </section>
    </div>
  );
}
