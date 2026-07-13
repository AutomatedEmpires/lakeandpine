import type { Metadata } from "next";

import { ServiceSupportForm } from "@/components/ServiceSupportForm";
import { requestIntakeEnabled } from "@/lib/env";

export const metadata: Metadata = {
  title: "Service Support | Lake & Pine",
  description:
    "Request a reschedule, cancellation, quality review, re-clean review, or refund review for a Lake & Pine service record.",
  robots: { index: false, follow: false },
};

export default function ServiceSupportPage() {
  return (
    <div className="route-page">
      <section className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">Service desk</span>
          <h1>One accountable path when plans change or work needs attention.</h1>
          <p className="lead">
            Submit a reschedule, cancellation, complaint, re-clean, damage, or refund-review
            request. Every request is tied to an auditable operator workflow; public submission
            never changes a confirmed visit or moves money by itself.
          </p>
        </div>
      </section>
      <section className="container section" style={{ paddingTop: 0 }}>
        <ServiceSupportForm intakeEnabled={requestIntakeEnabled} />
      </section>
    </div>
  );
}
