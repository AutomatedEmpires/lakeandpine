"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";

const PROGRAMS = [
  ["estate", "Private Estate Care"],
  ["construction", "Construction Handoff"],
  ["marine", "Lake & Marine Interior Care"],
  ["commercial", "Select Commercial Care"],
] as const;

const TERRITORIES = [
  "Coeur d'Alene",
  "Hayden",
  "Post Falls",
  "Liberty Lake",
  "Spokane Valley",
  "Spokane",
  "Other Inland Northwest area",
] as const;

export function CleanerApplicationForm({ applicationsEnabled }: { applicationsEnabled: boolean }) {
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [reference, setReference] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!applicationsEnabled || submitting) return;
    setSubmitting(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/cleaner-applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey,
        companyWebsite: form.get("companyWebsite"),
        fullName: form.get("fullName"),
        email: form.get("email"),
        phone: form.get("phone"),
        homeBase: form.get("homeBase"),
        servicePrograms: form.getAll("servicePrograms"),
        territories: form.getAll("territories"),
        availabilitySummary: form.get("availabilitySummary"),
        experienceSummary: form.get("experienceSummary"),
        transportationConfirmed: form.get("transportationConfirmed") === "on",
        privacyConsent: form.get("privacyConsent") === "on",
      }),
    }).catch(() => null);
    const payload = response
      ? ((await response.json().catch(() => null)) as { reference?: string; error?: string } | null)
      : null;
    if (!response?.ok || !payload?.reference) {
      setError(payload?.error || "We couldn't submit the application. Please try again shortly.");
      setSubmitting(false);
      return;
    }
    setReference(payload.reference);
    setSubmitting(false);
  }

  if (reference) {
    return (
      <div className="card" role="status">
        <span className="eyebrow">Application received</span>
        <h2>Thank you for introducing yourself.</h2>
        <p className="copy">Reference <strong>{reference}</strong>. This is an application, not an employment offer. An operator reviews service fit and current hiring capacity before contacting applicants.</p>
      </div>
    );
  }

  return (
    <form className="card" onSubmit={submit}>
      {!applicationsEnabled && <div className="preview-banner"><strong>Team intake preview:</strong> applications are not open yet and nothing can be submitted.</div>}
      <div className="form-grid planning-form">
        <div className="field"><label htmlFor="team-name">Name</label><input id="team-name" name="fullName" required maxLength={160} autoComplete="name" /></div>
        <div className="field"><label htmlFor="team-email">Email</label><input id="team-email" name="email" type="email" required autoComplete="email" /></div>
        <div className="field"><label htmlFor="team-phone">Phone</label><input id="team-phone" name="phone" type="tel" required maxLength={30} autoComplete="tel" /></div>
        <div className="field"><label htmlFor="team-home-base">Home base</label><input id="team-home-base" name="homeBase" required maxLength={120} placeholder="City or general area—no street address" /></div>
      </div>

      <fieldset className="field" style={{ marginTop: 20 }}>
        <legend>Programs you are interested in</legend>
        <div className="preference-grid">
          {PROGRAMS.map(([value, label]) => <label key={value}><input name="servicePrograms" type="checkbox" value={value} /> {label}</label>)}
        </div>
      </fieldset>

      <fieldset className="field" style={{ marginTop: 20 }}>
        <legend>Areas you can reliably reach</legend>
        <div className="preference-grid">
          {TERRITORIES.map((area) => <label key={area}><input name="territories" type="checkbox" value={area} /> {area}</label>)}
        </div>
      </fieldset>

      <div className="field" style={{ marginTop: 20 }}>
        <label htmlFor="team-availability">General availability</label>
        <textarea id="team-availability" name="availabilitySummary" required minLength={10} maxLength={1000} placeholder="Days, typical hours, desired weekly capacity, and earliest practical start. Do not include private documents." />
      </div>
      <div className="field" style={{ marginTop: 20 }}>
        <label htmlFor="team-experience">Relevant experience and service strengths</label>
        <textarea id="team-experience" name="experienceSummary" required minLength={10} maxLength={2000} placeholder="Tell us about residential, construction, marine-interior, commercial, finish-care, or customer-service experience." />
      </div>

      <label className="consent-row"><input name="transportationConfirmed" type="checkbox" required /><span>I can reliably travel to the areas I selected. Exact assignments, mileage, employment terms, and equipment expectations would be confirmed separately.</span></label>
      <label className="consent-row"><input name="privacyConsent" type="checkbox" required /><span>I agree to the applicant-data handling described in the <Link href="/privacy">privacy notice</Link>. I am not submitting identity, banking, medical, background-check, or other sensitive documents here.</span></label>
      <div className="hp-field" aria-hidden="true"><label htmlFor="team-company-website">Company website</label><input id="team-company-website" name="companyWebsite" tabIndex={-1} autoComplete="off" /></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="booking-actions"><span className="copy">Application details are reviewed privately.</span><button className="btn btn-primary" disabled={!applicationsEnabled || submitting}>{submitting ? "Sending…" : applicationsEnabled ? "Submit application" : "Applications not open"}</button></div>
    </form>
  );
}
