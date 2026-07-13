"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";

const CASE_TYPES = [
  ["reschedule", "Reschedule a planned visit"],
  ["cancel", "Cancel a planned visit"],
  ["complaint", "Report a service concern"],
  ["reclean", "Request a focused re-clean review"],
  ["refund_review", "Request a credit or refund review"],
  ["damage", "Report possible damage"],
  ["other", "Something else"],
] as const;

export function ServiceSupportForm({ intakeEnabled }: { intakeEnabled: boolean }) {
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const [caseType, setCaseType] = useState<(typeof CASE_TYPES)[number][0]>("reschedule");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [reference, setReference] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!intakeEnabled || submitting) return;
    setSubmitting(true);
    setError("");

    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/service-cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey,
        companyWebsite: form.get("companyWebsite"),
        caseType,
        bookingReference: form.get("bookingReference"),
        name: form.get("name"),
        email: form.get("email"),
        phone: form.get("phone"),
        preferredDate: form.get("preferredDate"),
        alternateDate: form.get("alternateDate"),
        details: form.get("details"),
        privacyConsent: form.get("privacyConsent") === "on",
      }),
    }).catch(() => null);

    if (!response) {
      setError("We couldn't reach the service desk. Please try again shortly.");
      setSubmitting(false);
      return;
    }

    const payload = (await response.json().catch(() => null)) as
      | { reference?: string; error?: string }
      | null;
    if (!response.ok || !payload?.reference) {
      setError(payload?.error || "We couldn't submit that request. Please review the fields and try again.");
      setSubmitting(false);
      return;
    }

    setReference(payload.reference);
    setSubmitting(false);
  }

  if (reference) {
    return (
      <div className="card" role="status">
        <span className="eyebrow">Request received</span>
        <h2>The service desk has your request.</h2>
        <p className="copy">
          Reference <strong>{reference}</strong>. This records the request; it does not
          automatically change an appointment or move money. An operator reviews the service
          record and confirms the next action.
        </p>
        <Link className="btn btn-soft" href="/">
          Return home
        </Link>
      </div>
    );
  }

  return (
    <form className="card" onSubmit={submit}>
      {!intakeEnabled && (
        <div className="preview-banner">
          <strong>Service desk preview:</strong> submissions are not open yet. The form is
          visible so the process can be reviewed, but nothing can be sent or stored.
        </div>
      )}

      <div className="field">
        <label htmlFor="case-type">What do you need?</label>
        <select
          id="case-type"
          value={caseType}
          onChange={(event) => setCaseType(event.target.value as typeof caseType)}
        >
          {CASE_TYPES.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      <div className="form-grid planning-form" style={{ marginTop: 18 }}>
        <div className="field">
          <label htmlFor="support-booking-reference">Service reference, if known</label>
          <input id="support-booking-reference" name="bookingReference" maxLength={80} />
        </div>
        <div className="field">
          <label htmlFor="support-name">Name</label>
          <input id="support-name" name="name" required maxLength={160} autoComplete="name" />
        </div>
        <div className="field">
          <label htmlFor="support-email">Email</label>
          <input id="support-email" name="email" type="email" required autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="support-phone">Phone, optional</label>
          <input id="support-phone" name="phone" type="tel" maxLength={30} autoComplete="tel" />
        </div>
        {caseType === "reschedule" && (
          <>
            <div className="field">
              <label htmlFor="support-preferred-date">Preferred new date</label>
              <input id="support-preferred-date" name="preferredDate" type="date" required />
            </div>
            <div className="field">
              <label htmlFor="support-alternate-date">Alternate date</label>
              <input id="support-alternate-date" name="alternateDate" type="date" />
            </div>
          </>
        )}
        <div className="field full">
          <label htmlFor="support-details">What happened, or what should change?</label>
          <textarea
            id="support-details"
            name="details"
            required
            minLength={10}
            maxLength={4000}
            placeholder="Share the practical details an operator needs. Do not include access codes, payment numbers, or other secrets."
          />
        </div>
      </div>

      <div className="hp-field" aria-hidden="true">
        <label htmlFor="support-company-website">Company website</label>
        <input id="support-company-website" name="companyWebsite" tabIndex={-1} autoComplete="off" />
      </div>

      <label className="consent-row">
        <input name="privacyConsent" type="checkbox" required />
        <span>
          I understand this creates a service-desk request for operator review and agree to the
          handling described in the <Link href="/privacy">privacy notice</Link>. It does not
          automatically reschedule, cancel, authorize a re-clean, or issue money.
        </span>
      </label>

      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="booking-actions">
        <span className="copy">No payment details belong in this form.</span>
        <button className="btn btn-primary" disabled={!intakeEnabled || submitting}>
          {submitting ? "Sending…" : intakeEnabled ? "Send service request" : "Submissions not open"}
        </button>
      </div>
    </form>
  );
}
