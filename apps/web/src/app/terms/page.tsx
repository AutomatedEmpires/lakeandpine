import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Service Request Terms",
  description: "General website and service-request terms for Lake & Pine Cleaning Co.",
  alternates: { canonical: "/terms" },
};

const SECTIONS = [
  {
    title: "A request is not a confirmed booking",
    body: "Submitting a preferred date, time, property description, or planning estimate does not reserve a crew or create a confirmed appointment. Scheduling occurs only after an operator reviews scope and capacity and communicates confirmation.",
  },
  {
    title: "Estimates, quotes, and scope",
    body: "Website estimates are planning guidance, not guaranteed final prices. A confirmed proposal should identify the service scope, assumptions, exclusions, timing, and price. Material changes in property condition or requested work may require approval of an updated scope or price.",
  },
  {
    title: "Access and property readiness",
    body: "The property contact is responsible for providing lawful, safe, and timely access and for disclosing material conditions that affect the work. Do not place door codes or unnecessary sensitive information in a public planning form; coordinate secure access privately after review.",
  },
  {
    title: "Scheduling and rescheduling",
    body: "Preferred and alternate windows are requests until confirmed. A reschedule or cancellation request does not change an existing appointment until acknowledged. Any deadline, fee, deposit treatment, or exception must come from the confirmed service agreement—not an assumption on this website.",
  },
  {
    title: "Payments and refunds",
    body: "This website does not currently collect online payment. If payment is enabled later, the confirmed proposal should state the method, timing, deposit or cancellation treatment, and applicable refund process. Refunds or adjustments are reviewed against the agreed scope and circumstances rather than promised automatically.",
  },
  {
    title: "Concerns and service recovery",
    body: "Raise a concern promptly and identify the affected part of the agreed scope. Photos may help but are optional unless a separate agreement reasonably requires documentation. An operator may propose a return visit, correction, account adjustment, partial refund, or another resolution after review; no particular outcome is guaranteed by this page.",
  },
  {
    title: "Work outside the assumed scope",
    body: "Biohazards, mold, pests, hazardous materials, regulated sanitation, industrial conditions, active construction hazards, mechanical systems, and exterior marine restoration are not assumed. Work may be declined or paused when a property, condition, access plan, or request is not a safe or responsible fit.",
  },
  {
    title: "Website availability",
    body: "The website, request tools, account features, email, and third-party providers may be changed, paused, or unavailable. A technical acknowledgement does not by itself confirm that a human operator received, accepted, or scheduled a service request.",
  },
];

export default function TermsPage() {
  return (
    <div className="route-page legal-page">
      <div className="container page-hero"><div className="page-panel"><span className="eyebrow">General service-request terms</span><h1>Clear expectations before a property is scheduled.</h1><p className="lead">Updated July 13, 2026. These are general operating terms for the website and request process, not a final jurisdiction-specific service contract. Confirmed work should be governed by the proposal or service agreement provided for that job.</p></div></div>
      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container legal-layout">
          <aside className="card legal-summary"><strong>The short version</strong><p>Request first. Review the scope and price. Treat timing as confirmed only when an operator says it is. Raise concerns against the agreed scope so the right recovery path can be reviewed.</p><Link className="btn btn-soft" href="/pricing">How proposals work</Link></aside>
          <div className="legal-sections">
            {SECTIONS.map((section) => <section key={section.title}><h2>{section.title}</h2><p>{section.body}</p></section>)}
            <section><h2>Changes and contact</h2><p>These terms may change as the service operation and provider stack are finalized. A verified service and legal-contact address will be published before live customer intake is enabled.</p></section>
          </div>
        </div>
      </section>
    </div>
  );
}
