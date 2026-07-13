import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Notice",
  description: "General website and service-request privacy information for Lake & Pine Cleaning Co.",
  alternates: { canonical: "/privacy" },
};

const SECTIONS = [
  {
    title: "Information a request may include",
    body: "Name, email, phone, ZIP or service location, property type and size, preferred timing, room or zone priorities, pet and access context, cleaning preferences, and messages you choose to send. Do not submit door codes, payment-card details, government identifiers, medical records, or other unnecessary sensitive information through a planning form.",
  },
  {
    title: "How request information is used",
    body: "To review service fit, prepare or refine a scope, communicate about timing and access, operate the requested service, respond to concerns, maintain a job record, prevent abuse, and improve the service journey. Information should not be used for unrelated marketing without an appropriate choice and notice.",
  },
  {
    title: "Service providers",
    body: "The website may rely on hosting, database, email, authentication, analytics, error-monitoring, mapping, and payment providers when those features are enabled. They should receive only the information needed for their role and operate under their own terms and privacy practices.",
  },
  {
    title: "Sharing and sale",
    body: "Lake & Pine does not intend to sell request information. Information may be shared with service providers supporting the request, people assigned to operate the service, or authorities when disclosure is reasonably required by law, safety, fraud prevention, or the protection of rights.",
  },
  {
    title: "Retention and security",
    body: "Request and service records should be kept only as long as reasonably needed for the service, follow-up, accounting, dispute handling, security, and applicable obligations. No website or storage system can promise absolute security; access should be limited to people and systems that need it.",
  },
  {
    title: "Choices and requests",
    body: "You may ask about access, correction, or deletion of information associated with a request, subject to verification and any records that must reasonably be retained. A verified privacy-contact address will be published before live personal-data intake is enabled.",
  },
];

export default function PrivacyPage() {
  return (
    <div className="route-page legal-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">General operational privacy notice</span>
          <h1>Privacy should begin with collecting less.</h1>
          <p className="lead">Updated July 13, 2026. This page describes the intended handling of website and service-request information. It is general operational language and should receive jurisdiction-specific legal review before live intake.</p>
        </div>
      </div>
      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container legal-layout">
          <aside className="card legal-summary"><strong>Current website posture</strong><p>The planning experience can operate in preview mode without storing a request. When live intake is enabled, the form should clearly say what is submitted and why.</p><Link className="btn btn-soft" href="/book">View the request flow</Link></aside>
          <div className="legal-sections">
            {SECTIONS.map((section) => <section key={section.title}><h2>{section.title}</h2><p>{section.body}</p></section>)}
            <section><h2>Changes to this notice</h2><p>This notice may change as the business, providers, and service process are confirmed. The updated date should change when material revisions are published.</p></section>
          </div>
        </div>
      </section>
    </div>
  );
}
