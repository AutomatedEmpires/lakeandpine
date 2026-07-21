"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";

import {
  PremiumRequestFlow,
  type PremiumRequestInitialDraft,
} from "@/components/PremiumRequestFlow";
import type {
  PublicAvailabilityResponse,
  PublicSchedulingSlot,
  SchedulingScopeInput,
} from "@/lib/customer-scheduling-contract";
import { MARKET_PROGRAMS } from "@/lib/market-content";
import { PREMIUM_PROGRAMS, type PremiumProgram } from "@/lib/premium-request";

const STEPS = ["Service", "Property", "Availability", "Review"] as const;

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

type ReservationResult = {
  reference: string;
  status: "held" | "pending_scope";
  slot: PublicSchedulingSlot;
  managementUrl: string;
};

function isProgram(value: string | null): value is PremiumProgram {
  return PREMIUM_PROGRAMS.includes(value as PremiumProgram);
}

function monthKey(date: string) {
  return date.slice(0, 7);
}

function monthLabel(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}-01T12:00:00Z`));
}

function monthDays(value: string) {
  const [year, month] = value.split("-").map(Number);
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return [
    ...Array.from({ length: firstDay }, () => null),
    ...Array.from({ length: count }, (_, index) =>
      `${value}-${String(index + 1).padStart(2, "0")}`,
    ),
  ];
}

function dateLabel(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

export function CustomerSchedulingFlow({
  consultationIntakeEnabled,
}: {
  consultationIntakeEnabled: boolean;
}) {
  const params = useSearchParams();
  const requestedProgram = params.get("program");
  const initialProgram = isProgram(requestedProgram) ? requestedProgram : "estate";
  const [step, setStep] = useState(0);
  const [scope, setScope] = useState<SchedulingScopeInput>({
    program: initialProgram,
    postalCode: "",
    context: CONTEXT_OPTIONS[initialProgram][0][0],
    sizeBand: "standard",
    condition: "maintained",
    cadence: "project",
    zoneCount: 6,
    siteReady: false,
    accessComplex: false,
    finishSensitive: false,
    finishRestrictionsAcknowledged: false,
  });
  const [availability, setAvailability] =
    useState<PublicAvailabilityResponse | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<PublicSchedulingSlot | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [activeMonth, setActiveMonth] = useState("");
  const [contact, setContact] = useState({ name: "", email: "", phone: "" });
  const [privacyConsent, setPrivacyConsent] = useState(false);
  const [termsConsent, setTermsConsent] = useState(false);
  const [companyWebsite, setCompanyWebsite] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [consultationFallback, setConsultationFallback] = useState(false);
  const [result, setResult] = useState<ReservationResult | null>(null);
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  const selectedProgram = MARKET_PROGRAMS.find(
    (program) => program.slug === scope.program,
  )!;
  const months = useMemo(
    () => [...new Set((availability?.slots ?? []).map((slot) => monthKey(slot.date)))],
    [availability],
  );
  const availableDates = useMemo(
    () => new Set((availability?.slots ?? []).map((slot) => slot.date)),
    [availability],
  );
  const slotsForDate = (availability?.slots ?? []).filter(
    (slot) => slot.date === selectedDate,
  );

  const fallbackDraft: PremiumRequestInitialDraft = {
    program: scope.program,
    postalCode: scope.postalCode,
    context: scope.context,
    sizeBand: scope.sizeBand,
    condition: scope.condition,
    cadence: scope.cadence,
    zoneCount: scope.zoneCount,
    siteReady: scope.siteReady,
    accessComplex: scope.accessComplex,
  };

  if (consultationFallback) {
    return (
      <div>
        <div className="notice-card" role="status">
          <strong>Your property answers are preserved.</strong>
          <p>
            Add the remaining timing, priorities, and contact details for an operator-reviewed
            consultation request.
          </p>
        </div>
        <PremiumRequestFlow
          intakeEnabled={consultationIntakeEnabled}
          initialDraft={fallbackDraft}
        />
      </div>
    );
  }

  if (result) {
    const held = result.status === "held";
    return (
      <div className="card booking-result scheduling-confirmation" role="status">
        <span className="eyebrow">{held ? "Time held" : "Pending scope review"}</span>
        <h2>{held ? "Your service window is reserved." : "Your window is held while one condition is reviewed."}</h2>
        <p className="lead">
          {dateLabel(result.slot.date)} · {result.slot.arrivalWindow} · {result.slot.timeZone}
        </p>
        <div className="request-summary">
          <div><span>Booking reference</span><strong>{result.reference}</strong></div>
          <div><span>Status</span><strong>{held ? "Capacity held" : "Pending scope"}</strong></div>
          <div><span>Service</span><strong>{selectedProgram.shortTitle}</strong></div>
          <div><span>Hold window</span><strong>{result.slot.holdMinutes} minutes</strong></div>
        </div>
        <div className="notice-card">
          <strong>What happens next</strong>
          <p>
            {held
              ? "Qualified capacity is reserved for this exact window. Lake & Pine will move it to confirmed after the assigned crew accepts; no payment was collected."
              : `Qualified capacity is reserved while ${result.slot.conditionLabel?.toLowerCase() ?? "the named scope condition"} is reviewed. It is not yet confirmed, and no payment was collected.`}
          </p>
        </div>
        <div className="hero-actions">
          <Link className="btn btn-primary" href={result.managementUrl}>
            Open booking calendar
          </Link>
          <Link className="btn btn-soft" href="/book">
            Schedule another service
          </Link>
        </div>
        <p className="scope-note">
          Keep the management link private. The reference identifies this booking but cannot
          authorize access to it.
        </p>
      </div>
    );
  }

  function chooseProgram(program: PremiumProgram) {
    setScope((current) => ({
      ...current,
      program,
      context: CONTEXT_OPTIONS[program][0][0],
    }));
    setAvailability(null);
    setSelectedSlot(null);
  }

  async function checkAvailability() {
    if (!scope.postalCode.trim()) {
      setError("Enter the property ZIP or postal code.");
      return;
    }
    if (!scope.siteReady) {
      setError("Confirm basic site readiness before checking direct availability.");
      return;
    }
    if (!scope.finishRestrictionsAcknowledged) {
      setError("Confirm that known finish and product restrictions have been acknowledged.");
      return;
    }
    setLoading(true);
    setError("");
    const response = await fetch("/api/scheduling/availability", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    }).catch(() => null);
    const payload = response
      ? ((await response.json().catch(() => null)) as
          | (PublicAvailabilityResponse & { error?: string })
          | null)
      : null;
    setLoading(false);
    if (!response?.ok || !payload?.classification) {
      setError(payload?.error || "Availability could not be loaded. Please try again.");
      return;
    }
    setAvailability(payload);
    const first = payload.slots[0];
    setActiveMonth(first ? monthKey(first.date) : "");
    setSelectedDate(first?.date ?? "");
    setSelectedSlot(null);
    setStep(2);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selectedSlot) {
      setError("Choose an available service window.");
      return;
    }
    if (!contact.name || !contact.email || !contact.phone) {
      setError("Complete the contact details for this booking.");
      return;
    }
    if (!privacyConsent || !termsConsent) {
      setError("Confirm the privacy and scheduling terms.");
      return;
    }
    setLoading(true);
    setError("");
    const response = await fetch("/api/scheduling/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope,
        slotId: selectedSlot.id,
        idempotencyKey,
        companyWebsite,
        contact,
        acknowledgements: {
          privacyConsent,
          termsConsent,
          siteReady: true,
        },
      }),
    }).catch(() => null);
    const payload = response
      ? ((await response.json().catch(() => null)) as
          | (ReservationResult & { error?: string; code?: string })
          | null)
      : null;
    setLoading(false);
    if (!response?.ok || !payload?.reference) {
      setError(payload?.error || "That time could not be reserved. Please try again.");
      if (payload?.code === "stale_slot") {
        setAvailability(null);
        setSelectedSlot(null);
        setStep(1);
      }
      return;
    }
    setResult(payload);
  }

  const pathNeedsFallback =
    availability &&
    !["direct", "conditional_hold"].includes(availability.classification.path);
  const activeMonthIndex = months.indexOf(activeMonth);

  return (
    <form className="booking-shell scheduling-shell" onSubmit={submit}>
      <aside className="card booking-rail">
        <div className="booking-progress">
          <span>Step {step + 1} of {STEPS.length}</span>
          <span>{Math.round(((step + 1) / STEPS.length) * 100)}%</span>
        </div>
        <div className="booking-progress-track" aria-hidden="true">
          <span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
        </div>
        <div className="booking-step-list">
          {STEPS.map((label, index) => (
            <button
              key={label}
              type="button"
              className={`rail-btn${index === step ? " active" : ""}${index < step ? " complete" : ""}`}
              onClick={() => index < step && setStep(index)}
              aria-current={index === step ? "step" : undefined}
            >
              <span className="step-num">{index < step ? "✓" : index + 1}</span>
              {label}
            </button>
          ))}
        </div>
        <div className="planning-card">
          <span className="eyebrow">Scheduling result</span>
          <strong>{availability?.classification.path.replaceAll("_", " ") ?? "Not checked"}</strong>
          <p>Only active policy and currently qualified capacity produce selectable times.</p>
        </div>
      </aside>

      <section className="card booking-workspace" aria-live="polite">
        {step === 0 && (
          <>
            <span className="eyebrow">01 · Choose service</span>
            <h2>What would you like to schedule?</h2>
            <p className="copy">
              Start with the closest property-care program. Complex work can still move to a
              consultation without losing these answers.
            </p>
            <div className="choice-grid" role="group" aria-label="Property care program">
              {MARKET_PROGRAMS.map((program) => (
                <button
                  key={program.slug}
                  type="button"
                  className={`choice-card${scope.program === program.slug ? " selected" : ""}`}
                  onClick={() => chooseProgram(program.slug)}
                  aria-pressed={scope.program === program.slug}
                >
                  <span className="eyebrow">{program.eyebrow}</span>
                  <strong>{program.title}</strong>
                  <p>{program.summary}</p>
                </button>
              ))}
            </div>
            <div className="field" style={{ marginTop: 22 }}>
              <label htmlFor="schedule-cadence">Service cadence</label>
              <select
                id="schedule-cadence"
                value={scope.cadence}
                onChange={(event) =>
                  setScope((current) => ({
                    ...current,
                    cadence: event.target.value as SchedulingScopeInput["cadence"],
                  }))
                }
              >
                <option value="project">One service / initial reset</option>
                <option value="weekly">Weekly care</option>
                <option value="biweekly">Every two weeks</option>
                <option value="monthly">Monthly care</option>
                <option value="seasonal">Seasonal</option>
                <option value="custom">Custom cadence</option>
              </select>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <span className="eyebrow">02 · Property and readiness</span>
            <h2>Share only what the scheduler needs.</h2>
            <p className="copy">
              ZIP, scope, condition, and readiness determine whether direct scheduling is safe.
              Do not include door codes or payment details.
            </p>
            <div className="form-grid planning-form">
              <div className="field">
                <label htmlFor="schedule-postal">Property ZIP / postal code</label>
                <input
                  id="schedule-postal"
                  value={scope.postalCode}
                  onChange={(event) =>
                    setScope((current) => ({ ...current, postalCode: event.target.value }))
                  }
                  autoComplete="postal-code"
                  maxLength={12}
                />
              </div>
              <div className="field">
                <label htmlFor="schedule-context">Property or project context</label>
                <select
                  id="schedule-context"
                  value={scope.context}
                  onChange={(event) =>
                    setScope((current) => ({ ...current, context: event.target.value }))
                  }
                >
                  {CONTEXT_OPTIONS[scope.program].map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="schedule-size">Interior size direction</label>
                <select
                  id="schedule-size"
                  value={scope.sizeBand}
                  onChange={(event) =>
                    setScope((current) => ({
                      ...current,
                      sizeBand: event.target.value as SchedulingScopeInput["sizeBand"],
                    }))
                  }
                >
                  <option value="compact">Compact scope</option>
                  <option value="standard">Standard property / project</option>
                  <option value="large">Large property / extended zones</option>
                  <option value="exceptional">Exceptional scale</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="schedule-condition">Current condition</label>
                <select
                  id="schedule-condition"
                  value={scope.condition}
                  onChange={(event) =>
                    setScope((current) => ({
                      ...current,
                      condition: event.target.value as SchedulingScopeInput["condition"],
                    }))
                  }
                >
                  <option value="maintained">Maintained / recurring-ready</option>
                  <option value="detailed">Detailed reset needed</option>
                  <option value="project">Project or heavy-detail condition</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="schedule-zones">Approximate rooms or interior zones</label>
                <input
                  id="schedule-zones"
                  type="number"
                  min={1}
                  max={80}
                  value={scope.zoneCount}
                  onChange={(event) =>
                    setScope((current) => ({
                      ...current,
                      zoneCount: Math.max(1, Math.min(80, Number(event.target.value) || 1)),
                    }))
                  }
                />
              </div>
            </div>
            <label className="consent-row">
              <input
                type="checkbox"
                checked={scope.siteReady}
                onChange={(event) =>
                  setScope((current) => ({ ...current, siteReady: event.target.checked }))
                }
              />
              <span>The interior is free of known biohazard, active remediation, unsafe debris, or unavailable required utilities.</span>
            </label>
            <label className="consent-row">
              <input
                type="checkbox"
                checked={scope.accessComplex}
                onChange={(event) =>
                  setScope((current) => ({ ...current, accessComplex: event.target.checked }))
                }
              />
              <span>Access, parking, marina/storage entry, alarm/keyholder coordination, or operating-hour restrictions need operator planning.</span>
            </label>
            <label className="consent-row">
              <input
                type="checkbox"
                checked={scope.finishSensitive}
                onChange={(event) =>
                  setScope((current) => ({ ...current, finishSensitive: event.target.checked }))
                }
              />
              <span>The property has specialty finishes or product restrictions.</span>
            </label>
            <label className="consent-row">
              <input
                type="checkbox"
                checked={scope.finishRestrictionsAcknowledged}
                onChange={(event) =>
                  setScope((current) => ({
                    ...current,
                    finishRestrictionsAcknowledged: event.target.checked,
                  }))
                }
              />
              <span>Known finish and product restrictions are documented and can be followed without collecting access secrets here.</span>
            </label>
          </>
        )}

        {step === 2 && availability && (
          <>
            <span className="eyebrow">03 · Real availability</span>
            <h2>
              {pathNeedsFallback
                ? availability.classification.path === "no_capacity"
                  ? "No current capacity-backed times"
                  : "An operator review is the responsible next step"
                : "Choose an available service window"}
            </h2>
            <p className="lead">{availability.classification.publicReason}</p>
            {pathNeedsFallback ? (
              <div className="consultation-fallback card">
                <strong>
                  {availability.classification.path === "no_capacity"
                    ? "Capacity result—not a scope rejection"
                    : "Consultation fallback"}
                </strong>
                <p>
                  Your service and property answers will carry forward. A consultation does not
                  claim that a service window is available.
                </p>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => setConsultationFallback(true)}
                >
                  Continue with preserved answers
                </button>
              </div>
            ) : (
              <div className="calendar-ui customer-calendar">
                <div className="card calendar-card">
                  <div className="calendar-head">
                    <button
                      type="button"
                      aria-label="Previous available month"
                      disabled={activeMonthIndex <= 0}
                      onClick={() => setActiveMonth(months[activeMonthIndex - 1])}
                    >
                      ←
                    </button>
                    <span>{monthLabel(activeMonth)}</span>
                    <button
                      type="button"
                      aria-label="Next available month"
                      disabled={activeMonthIndex < 0 || activeMonthIndex >= months.length - 1}
                      onClick={() => setActiveMonth(months[activeMonthIndex + 1])}
                    >
                      →
                    </button>
                  </div>
                  <div className="calendar-days" aria-hidden="true">
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <span key={day}>{day}</span>)}
                  </div>
                  <div className="calendar-dates" role="grid" aria-label={monthLabel(activeMonth)}>
                    {monthDays(activeMonth).map((date, index) =>
                      date ? (
                        <button
                          key={date}
                          type="button"
                          disabled={!availableDates.has(date)}
                          className={selectedDate === date ? "active" : ""}
                          aria-label={`${dateLabel(date)}${availableDates.has(date) ? ", available" : ", unavailable"}`}
                          aria-pressed={selectedDate === date}
                          onClick={() => {
                            setSelectedDate(date);
                            setSelectedSlot(null);
                          }}
                        >
                          {Number(date.slice(-2))}
                        </button>
                      ) : (
                        <span className="blank" key={`blank-${index}`} aria-hidden="true" />
                      ),
                    )}
                  </div>
                </div>
                <div className="card calendar-card slot-panel">
                  <strong>{selectedDate ? dateLabel(selectedDate) : "Choose a date"}</strong>
                  <p className="copy">Times shown in {availability.slots[0]?.timeZone}.</p>
                  <div className="time-grid" role="radiogroup" aria-label="Available service windows">
                    {slotsForDate.map((slot) => (
                      <button
                        key={slot.id}
                        type="button"
                        role="radio"
                        aria-checked={selectedSlot?.id === slot.id}
                        className={selectedSlot?.id === slot.id ? "active" : ""}
                        onClick={() => setSelectedSlot(slot)}
                      >
                        {slot.arrivalWindow}
                      </button>
                    ))}
                  </div>
                  {selectedSlot && (
                    <div className="slot-status" role="status">
                      <strong>
                        {selectedSlot.schedulingPath === "direct"
                          ? "Available to hold"
                          : "Hold pending a defined condition"}
                      </strong>
                      <p>
                        {selectedSlot.conditionLabel ??
                          `This exact window can be held for ${selectedSlot.holdMinutes} minutes while crew acceptance completes.`}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {step === 3 && selectedSlot && (
          <>
            <span className="eyebrow">04 · Review and reserve</span>
            <h2>Confirm the property, time, and contact details.</h2>
            <div className="request-summary">
              <div><span>Service</span><strong>{selectedProgram.shortTitle}</strong></div>
              <div><span>Property area</span><strong>{scope.postalCode}</strong></div>
              <div><span>Date</span><strong>{dateLabel(selectedSlot.date)}</strong></div>
              <div><span>Window</span><strong>{selectedSlot.arrivalWindow} · {selectedSlot.timeZone}</strong></div>
            </div>
            <div className="notice-card">
              <strong>
                {selectedSlot.schedulingPath === "direct"
                  ? "Capacity hold"
                  : "Conditional capacity hold"}
              </strong>
              <p>
                {selectedSlot.schedulingPath === "direct"
                  ? `Submitting reserves this exact capacity-backed window for ${selectedSlot.holdMinutes} minutes while crew acceptance completes.`
                  : `Submitting reserves this window for ${selectedSlot.holdMinutes} minutes while ${selectedSlot.conditionLabel?.toLowerCase() ?? "the named condition"} is reviewed.`}
                {" "}No payment is collected.
              </p>
            </div>
            <div className="form-grid planning-form">
              <div className="field">
                <label htmlFor="schedule-name">Name</label>
                <input id="schedule-name" value={contact.name} onChange={(event) => setContact((current) => ({ ...current, name: event.target.value }))} autoComplete="name" />
              </div>
              <div className="field">
                <label htmlFor="schedule-email">Email</label>
                <input id="schedule-email" type="email" value={contact.email} onChange={(event) => setContact((current) => ({ ...current, email: event.target.value }))} autoComplete="email" />
              </div>
              <div className="field">
                <label htmlFor="schedule-phone">Phone</label>
                <input id="schedule-phone" type="tel" value={contact.phone} onChange={(event) => setContact((current) => ({ ...current, phone: event.target.value }))} autoComplete="tel" />
              </div>
            </div>
            <label className="consent-row">
              <input type="checkbox" checked={privacyConsent} onChange={(event) => setPrivacyConsent(event.target.checked)} />
              <span>I agree to the booking-data handling described in the <Link href="/privacy">privacy notice</Link> and have left access codes and payment details out.</span>
            </label>
            <label className="consent-row">
              <input type="checkbox" checked={termsConsent} onChange={(event) => setTermsConsent(event.target.checked)} />
              <span>I understand the <Link href="/terms">scheduling terms</Link>, the displayed hold duration and status, and that no charge or custom proposal is created here.</span>
            </label>
            <div className="hp-field" aria-hidden="true">
              <label htmlFor="schedule-company">Company website</label>
              <input id="schedule-company" value={companyWebsite} onChange={(event) => setCompanyWebsite(event.target.value)} tabIndex={-1} autoComplete="off" />
            </div>
          </>
        )}

        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="booking-actions">
          <button
            type="button"
            className="btn btn-soft"
            onClick={() => {
              setError("");
              setStep((current) => Math.max(0, current - 1));
            }}
            disabled={step === 0 || loading}
          >
            Back
          </button>
          <span className="copy">
            Availability is rechecked when you reserve. Displayed times are never trusted alone.
          </span>
          {step === 0 && (
            <button className="btn btn-primary" type="button" onClick={() => setStep(1)}>
              Continue
            </button>
          )}
          {step === 1 && (
            <button className="btn btn-primary" type="button" onClick={checkAvailability} disabled={loading}>
              {loading ? "Checking…" : "See availability"}
            </button>
          )}
          {step === 2 && !pathNeedsFallback && (
            <button
              className="btn btn-primary"
              type="button"
              disabled={!selectedSlot}
              onClick={() => setStep(3)}
            >
              Review this time
            </button>
          )}
          {step === 3 && (
            <button className="btn btn-primary" disabled={loading}>
              {loading ? "Reserving…" : "Reserve this time"}
            </button>
          )}
        </div>
      </section>
    </form>
  );
}
