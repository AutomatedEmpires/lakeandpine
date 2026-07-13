"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";

import { MARKET_PROGRAMS } from "@/lib/market-content";
import {
  deriveRequestPlanning,
  PREMIUM_PROGRAMS,
  type PremiumProgram,
  type RequestPlanningInput,
} from "@/lib/premium-request";

const STEPS = ["Program", "Property brief", "Timing", "Review"] as const;
const WINDOWS = ["Morning", "Midday", "Afternoon", "After-hours review"] as const;

const CONTEXT_OPTIONS: Record<PremiumProgram, [string, string][]> = {
  estate: [
    ["primary_home", "Primary residence"],
    ["seasonal_home", "Seasonal or second home"],
    ["arrival_departure", "Arrival or departure preparation"],
    ["event_reset", "Event preparation or reset"],
  ],
  construction: [
    ["rough_clean", "Rough-clean phase"],
    ["final_clean", "Detailed final clean"],
    ["walkthrough", "Pre-walkthrough touch-up"],
    ["owner_handoff", "Owner handoff / move-in readiness"],
  ],
  marine: [
    ["docked", "Docked vessel"],
    ["stored", "Stored vessel"],
    ["trailered", "Trailered vessel"],
    ["arrival_reset", "Owner arrival / departure reset"],
  ],
  commercial: [
    ["office", "Professional office"],
    ["studio", "Studio or showroom"],
    ["model_home", "Model home or sales center"],
    ["club_marina", "Private club or marina office"],
  ],
};

function isProgram(value: string | null): value is PremiumProgram {
  return PREMIUM_PROGRAMS.includes(value as PremiumProgram);
}

function minutesLabel(minutes: number) {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} planned labor-hours`;
}

export function PremiumRequestFlow({ intakeEnabled }: { intakeEnabled: boolean }) {
  const params = useSearchParams();
  const requestedProgram = params.get("program");
  const [program, setProgram] = useState<PremiumProgram>(
    isProgram(requestedProgram) ? requestedProgram : "estate",
  );
  const [step, setStep] = useState(0);
  const [sizeBand, setSizeBand] = useState<RequestPlanningInput["sizeBand"]>("standard");
  const [condition, setCondition] = useState<RequestPlanningInput["condition"]>("maintained");
  const [zoneCount, setZoneCount] = useState(6);
  const [context, setContext] = useState(CONTEXT_OPTIONS[program][0][0]);
  const [cadence, setCadence] = useState("project");
  const [priorities, setPriorities] = useState("");
  const [finishNotes, setFinishNotes] = useState("");
  const [preferredDate, setPreferredDate] = useState("");
  const [alternateDate, setAlternateDate] = useState("");
  const [secondAlternateDate, setSecondAlternateDate] = useState("");
  const [windowPreference, setWindowPreference] = useState<string>(WINDOWS[0]);
  const [deadlineCritical, setDeadlineCritical] = useState(false);
  const [accessComplex, setAccessComplex] = useState(false);
  const [siteReady, setSiteReady] = useState(false);
  const [contact, setContact] = useState({ name: "", email: "", phone: "", zip: "" });
  const [privacyConsent, setPrivacyConsent] = useState(false);
  const [termsConsent, setTermsConsent] = useState(false);
  const [photoPermission, setPhotoPermission] = useState(false);
  const [companyWebsite, setCompanyWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ reference: string; persisted: boolean } | null>(null);
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  const selectedProgram = MARKET_PROGRAMS.find((item) => item.slug === program)!;
  const planning = deriveRequestPlanning({
    program,
    sizeBand,
    condition,
    zoneCount,
    deadlineCritical,
    finishSensitive: Boolean(finishNotes.trim()),
    accessComplex,
  });

  function chooseProgram(value: PremiumProgram) {
    setProgram(value);
    setContext(CONTEXT_OPTIONS[value][0][0]);
  }

  function blockerForStep() {
    if (step === 1 && priorities.trim().length < 10) {
      return "Add a short description of the result or priorities for this property.";
    }
    if (step === 2 && !preferredDate) return "Choose a preferred date.";
    if (step === 2 && !alternateDate) return "Choose at least one alternate date.";
    if (step === 3 && (!contact.name || !contact.email || !contact.phone || !contact.zip)) {
      return "Complete the contact fields so an operator can review the request.";
    }
    if (step === 3 && (!privacyConsent || !termsConsent || !siteReady)) {
      return "Confirm the privacy, request, and site-readiness acknowledgements.";
    }
    return "";
  }

  async function advance() {
    const blocker = blockerForStep();
    if (blocker) {
      setError(blocker);
      return;
    }
    setError("");
    if (step < STEPS.length - 1) setStep((current) => current + 1);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const blocker = blockerForStep();
    if (blocker) {
      setError(blocker);
      return;
    }
    if (!intakeEnabled) {
      setResult({ reference: "PREVIEW-ONLY", persisted: false });
      return;
    }

    setSubmitting(true);
    setError("");
    const response = await fetch("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey,
        companyWebsite,
        program,
        property: { sizeBand, condition, zoneCount, context, cadence },
        scope: { priorities, finishNotes },
        scheduling: {
          preferredDate,
          alternateDates: [alternateDate, secondAlternateDate].filter(Boolean),
          windowPreference,
          deadlineCritical,
          accessComplex,
        },
        contact,
        acknowledgements: {
          siteReady,
          privacyConsent,
          termsConsent,
          photoPermission,
          version: "2026-07-13",
        },
      }),
    }).catch(() => null);
    const payload = response
      ? ((await response.json().catch(() => null)) as { reference?: string; error?: string } | null)
      : null;
    if (!response?.ok || !payload?.reference) {
      setError(payload?.error || "We couldn't submit this request. Please try again shortly.");
      setSubmitting(false);
      return;
    }
    setResult({ reference: payload.reference, persisted: true });
    setSubmitting(false);
  }

  if (result) {
    return (
      <div className="card booking-result" role="status">
        <span className="eyebrow">{result.persisted ? "Request received" : "Planning preview complete"}</span>
        <h2>{result.persisted ? "The property brief is in the review queue." : "This is how the request will be planned."}</h2>
        <p className="lead">
          {result.persisted
            ? `Reference ${result.reference}. No appointment or price is confirmed yet; an operator reviews scope, territory, crew qualification, travel, and capacity first.`
            : "Nothing was sent or stored. Intake remains disabled until the operating inbox, monitoring, database controls, and service capacity are verified."}
        </p>
        <div className="dash-grid" style={{ margin: "22px 0" }}>
          <div className="dash-metric card"><b>{selectedProgram.shortTitle}</b><p className="copy">Program</p></div>
          <div className="dash-metric card"><b>{planning.estimatedCrewSize}</b><p className="copy">Suggested crew size</p></div>
          <div className="dash-metric card"><b>{minutesLabel(planning.estimatedMinutes)}</b><p className="copy">Planning direction</p></div>
          <div className="dash-metric card"><b>{planning.reviewPath}</b><p className="copy">Next review</p></div>
        </div>
        <div className="hero-actions">
          <Link className="btn btn-primary" href="/who-we-serve">Review programs</Link>
          <Link className="btn btn-soft" href="/service-support">Service support</Link>
        </div>
      </div>
    );
  }

  return (
    <form className="booking-shell" onSubmit={submit}>
      <aside className="card booking-rail">
        <div className="booking-progress"><span>Step {step + 1} of {STEPS.length}</span><span>{Math.round(((step + 1) / STEPS.length) * 100)}%</span></div>
        <div
          className="booking-progress-track"
          role="progressbar"
          aria-label="Consultation request progress"
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          aria-valuenow={step + 1}
          aria-valuetext={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}
        ><span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
        <div className="booking-step-list">
          {STEPS.map((label, index) => (
            <button key={label} type="button" className={`rail-btn${index === step ? " active" : ""}${index < step ? " complete" : ""}`} onClick={() => index < step && setStep(index)} aria-current={index === step ? "step" : undefined}>
              <span className="step-num">{index < step ? "✓" : index + 1}</span>{label}
            </button>
          ))}
        </div>
        <div className="planning-card">
          <span className="eyebrow">Planning direction</span>
          <strong>{planning.reviewPath}</strong>
          <p>{planning.factors.join(" · ")}</p>
          <div><span>Suggested crew</span><b>{planning.estimatedCrewSize}</b></div>
        </div>
      </aside>

      <section className="card booking-workspace">
        {!intakeEnabled && <div className="preview-banner"><strong>Safe preview:</strong> nothing is sent or stored while the operating path is being verified.</div>}

        {step === 0 && <>
          <span className="eyebrow">01 · Choose the operating program</span>
          <h2>What kind of property needs to be ready?</h2>
          <p className="copy">Choose the closest fit. Each program has its own scope, safety, access, scheduling, and crew-qualification checks.</p>
          <div className="choice-grid" role="group" aria-label="Property care program">
            {MARKET_PROGRAMS.map((item) => <button key={item.slug} type="button" className={`choice-card${program === item.slug ? " selected" : ""}`} onClick={() => chooseProgram(item.slug)} aria-pressed={program === item.slug}>
              <span className="eyebrow">{item.eyebrow}</span><strong>{item.title}</strong><p>{item.summary}</p>
            </button>)}
          </div>
          <div className="notice-card" style={{ marginTop: 20 }}><strong>Scope boundary</strong><p>{selectedProgram.boundaries}</p></div>
        </>}

        {step === 1 && <>
          <span className="eyebrow">02 · Property brief</span>
          <h2>Give the operator enough context to scope responsibly.</h2>
          <div className="form-grid planning-form">
            <div className="field"><label htmlFor="request-context">Property or project context</label><select id="request-context" value={context} onChange={(event) => setContext(event.target.value)}>{CONTEXT_OPTIONS[program].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
            <div className="field"><label htmlFor="request-size">Interior size direction</label><select id="request-size" value={sizeBand} onChange={(event) => setSizeBand(event.target.value as typeof sizeBand)}><option value="compact">Compact scope</option><option value="standard">Standard property / project</option><option value="large">Large property / extended zones</option><option value="exceptional">Exceptional scale / multi-day possibility</option></select></div>
            <div className="field"><label htmlFor="request-condition">Current condition</label><select id="request-condition" value={condition} onChange={(event) => setCondition(event.target.value as typeof condition)}><option value="maintained">Maintained / recurring-ready</option><option value="detailed">Detailed reset needed</option><option value="project">Project, handoff, or heavy-detail condition</option></select></div>
            <div className="field"><label htmlFor="request-zones">Approximate rooms or interior zones</label><input id="request-zones" type="number" min={1} max={80} value={zoneCount} onChange={(event) => setZoneCount(Math.max(1, Math.min(80, Number(event.target.value) || 1)))} /></div>
            <div className="field"><label htmlFor="request-cadence">Requested cadence</label><select id="request-cadence" value={cadence} onChange={(event) => setCadence(event.target.value)}><option value="project">One project / initial reset</option><option value="weekly">Weekly care</option><option value="biweekly">Every two weeks</option><option value="monthly">Monthly care</option><option value="seasonal">Seasonal / arrival-based</option><option value="custom">Custom operating schedule</option></select></div>
            <div className="field"><label htmlFor="request-finish">Finish or product sensitivities</label><input id="request-finish" value={finishNotes} onChange={(event) => setFinishNotes(event.target.value)} maxLength={1000} placeholder="Stone, specialty wood, owner-supplied products, delicate interiors…" /></div>
            <div className="field full"><label htmlFor="request-priorities">What needs to be ready, and for what outcome?</label><textarea id="request-priorities" value={priorities} onChange={(event) => setPriorities(event.target.value)} minLength={10} maxLength={3000} placeholder="Describe the rooms or zones, priorities, current condition, handoff/arrival goal, and exclusions. Do not include door codes or payment details." /></div>
          </div>
        </>}

        {step === 2 && <>
          <span className="eyebrow">03 · Capacity-aware timing</span>
          <h2>Share preferences, not a pretend instant appointment.</h2>
          <div className="notice-card"><strong>How confirmation works</strong><p>The scheduler first checks territory, qualified crew, travel, duration, availability, access, and any handoff or arrival deadline. An operator confirms the feasible window.</p></div>
          <div className="form-grid planning-form">
            <div className="field"><label htmlFor="preferred-date">Preferred date</label><input id="preferred-date" type="date" value={preferredDate} onChange={(event) => setPreferredDate(event.target.value)} /></div>
            <div className="field"><label htmlFor="alternate-date">First alternate</label><input id="alternate-date" type="date" value={alternateDate} onChange={(event) => setAlternateDate(event.target.value)} /></div>
            <div className="field"><label htmlFor="second-alternate-date">Second alternate, optional</label><input id="second-alternate-date" type="date" value={secondAlternateDate} onChange={(event) => setSecondAlternateDate(event.target.value)} /></div>
            <div className="field"><label htmlFor="window-preference">Preferred operating window</label><select id="window-preference" value={windowPreference} onChange={(event) => setWindowPreference(event.target.value)}>{WINDOWS.map((window) => <option key={window}>{window}</option>)}</select></div>
          </div>
          <label className="consent-row"><input type="checkbox" checked={deadlineCritical} onChange={(event) => setDeadlineCritical(event.target.checked)} /><span>This request is tied to an owner arrival, walkthrough, opening, event, or other real deadline.</span></label>
          <label className="consent-row"><input type="checkbox" checked={accessComplex} onChange={(event) => setAccessComplex(event.target.checked)} /><span>Access, parking, marina/storage entry, alarm/keyholder coordination, or operating-hour restrictions need operator planning.</span></label>
        </>}

        {step === 3 && <>
          <span className="eyebrow">04 · Review and contact</span>
          <h2>One clear brief for a human planning queue.</h2>
          <div className="request-summary">
            <div><span>Program</span><strong>{selectedProgram.title}</strong></div>
            <div><span>Scope</span><strong>{sizeBand} · {zoneCount} zones · {cadence}</strong></div>
            <div><span>Timing</span><strong>{preferredDate || "No date"} · alternate {alternateDate || "none"}</strong></div>
            <div><span>Direction</span><strong>{planning.reviewPath} · crew {planning.estimatedCrewSize}</strong></div>
          </div>
          <div className="form-grid planning-form">
            <div className="field"><label htmlFor="contact-name">Name</label><input id="contact-name" value={contact.name} onChange={(event) => setContact((value) => ({ ...value, name: event.target.value }))} autoComplete="name" maxLength={160} /></div>
            <div className="field"><label htmlFor="contact-email">Email</label><input id="contact-email" type="email" value={contact.email} onChange={(event) => setContact((value) => ({ ...value, email: event.target.value }))} autoComplete="email" /></div>
            <div className="field"><label htmlFor="contact-phone">Phone</label><input id="contact-phone" type="tel" value={contact.phone} onChange={(event) => setContact((value) => ({ ...value, phone: event.target.value }))} autoComplete="tel" maxLength={30} /></div>
            <div className="field"><label htmlFor="contact-zip">Property ZIP / postal code</label><input id="contact-zip" value={contact.zip} onChange={(event) => setContact((value) => ({ ...value, zip: event.target.value }))} autoComplete="postal-code" maxLength={12} /></div>
          </div>
          <label className="consent-row"><input type="checkbox" checked={siteReady} onChange={(event) => setSiteReady(event.target.checked)} /><span>To the best of my knowledge, the requested interior does not involve biohazard, active mold/remediation, unsafe debris, unavailable utilities required for the work, or an undisclosed regulated environment.</span></label>
          <label className="consent-row"><input type="checkbox" checked={privacyConsent} onChange={(event) => setPrivacyConsent(event.target.checked)} /><span>I agree to the request-data handling described in the <Link href="/privacy">privacy notice</Link> and have left access codes and payment details out.</span></label>
          <label className="consent-row"><input type="checkbox" checked={termsConsent} onChange={(event) => setTermsConsent(event.target.checked)} /><span>I understand the <Link href="/terms">request terms</Link>: this is not an appointment, approved proposal, guarantee, charge, or promise of service coverage.</span></label>
          <label className="consent-row"><input type="checkbox" checked={photoPermission} onChange={(event) => setPhotoPermission(event.target.checked)} /><span>Optional: an operator may ask separately for property photos for private scoping. This does not authorize public or marketing use.</span></label>
          <div className="hp-field" aria-hidden="true"><label htmlFor="company-website">Company website</label><input id="company-website" value={companyWebsite} onChange={(event) => setCompanyWebsite(event.target.value)} tabIndex={-1} autoComplete="off" /></div>
        </>}

        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="booking-actions">
          <button type="button" className="btn btn-soft" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0 || submitting}>Back</button>
          <span className="copy">{step < 3 ? "Completed steps can be revisited." : intakeEnabled ? "No payment; operator confirmation required." : "Builds a local planning preview only."}</span>
          {step < 3 ? <button type="button" className="btn btn-primary" onClick={advance}>Continue</button> : <button className="btn btn-primary" disabled={submitting}>{submitting ? "Sending…" : intakeEnabled ? "Send consultation request" : "Preview planning direction"}</button>}
        </div>
      </section>
    </form>
  );
}
