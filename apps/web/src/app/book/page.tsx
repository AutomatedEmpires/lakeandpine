import type { Metadata } from "next";
import { Suspense } from "react";

import { PremiumRequestFlow } from "@/components/PremiumRequestFlow";
import { requestIntakeEnabled } from "@/lib/env";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Request a Private Consultation",
  description:
    "Build a premium property-care request with scope, finish, access, timing, and contact details for human review.",
  alternates: { canonical: "/book" },
};

export default async function BookPage() {
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
