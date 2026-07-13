"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { capture } from "@/lib/analytics-client";
import {
  BATHROOM_BANDS,
  BEDROOM_BANDS,
  calculateEstimate,
  FREQUENCIES,
  PET_BANDS,
  SIZE_BANDS,
} from "@/lib/pricing";
import { ARRIVAL_WINDOWS, formatLongDate, isBookableDate, toIsoDate } from "@/lib/scheduling";
import { buildPlanningDirection, type PropertyProfile, type RoomPlan } from "@/lib/service-planning";
import { showToast } from "./toast-events";

type Service = { id: string; title: string; icon: string; price_label: string; blurb?: string };
type Addon = { id: string; title: string; price_label: string };

const STEPS = ["Service", "Property", "Rooms", "Preferences", "Pets & access", "Add-ons", "Timing", "Review"] as const;
const BOOKABLE_SERVICE_IDS = ["essential", "deep", "move", "rental"];
const PROPERTY_TYPES = [
  ["house", "House"],
  ["apartment", "Apartment / condo"],
  ["townhome", "Townhome"],
  ["rental", "Short-term rental"],
] as const;
const FLOOR_OPTIONS = [["1", "One floor"], ["2", "Two floors"], ["3_plus", "Three or more"]] as const;
const ROOM_OPTIONS: RoomPlan[] = [
  { id: "kitchen", label: "Kitchen", selected: true },
  { id: "bathroom", label: "Bathrooms", selected: true },
  { id: "living_room", label: "Living room", selected: true },
  { id: "primary_bedroom", label: "Primary bedroom", selected: true },
  { id: "bedroom", label: "Other bedrooms", selected: false },
  { id: "office", label: "Office", selected: false },
  { id: "mudroom", label: "Entry / mudroom", selected: false },
  { id: "laundry", label: "Laundry room", selected: false },
];
const PREFERENCE_OPTIONS = [
  "Unscented products",
  "Use homeowner supplies",
  "Shoes off indoors",
  "Prioritize floors",
  "Prioritize dusting",
  "Delicate surfaces",
  "Change provided linens",
];
const ACCESS_OPTIONS = [
  ["meet_at_door", "I’ll meet the team"],
  ["keypad", "Keypad / smart lock"],
  ["lockbox", "Lockbox"],
  ["coordinate_later", "Coordinate after review"],
] as const;

function Calendar({ selected, onSelect }: { selected: string | null; onSelect: (iso: string) => void }) {
  const today = useMemo(() => new Date(), []);
  const [monthOffset, setMonthOffset] = useState(0);
  const view = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const monthLabel = view.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const firstWeekday = view.getDay();

  return (
    <div className="calendar-card card" style={{ boxShadow: "none" }}>
      <div className="calendar-head">
        <span>{monthLabel}</span>
        <span>
          <button type="button" onClick={() => setMonthOffset((m) => m - 1)} disabled={monthOffset <= 0} aria-label="Previous month">‹</button>
          <button type="button" onClick={() => setMonthOffset((m) => m + 1)} disabled={monthOffset >= 2} aria-label="Next month">›</button>
        </span>
      </div>
      <div className="calendar-days">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="calendar-dates">
        {Array.from({ length: firstWeekday }, (_, index) => <button key={`blank-${index}`} type="button" className="blank" tabIndex={-1} />)}
        {Array.from({ length: daysInMonth }, (_, index) => {
          const iso = toIsoDate(new Date(view.getFullYear(), view.getMonth(), index + 1));
          return (
            <button key={iso} type="button" className={selected === iso ? "active" : ""} disabled={!isBookableDate(iso, today)} onClick={() => onSelect(iso)}>
              {index + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function BookingFlow({ services, addons, intakeEnabled }: { services: Service[]; addons: Addon[]; intakeEnabled: boolean }) {
  const params = useSearchParams();
  const initialService = BOOKABLE_SERVICE_IDS.includes(params.get("service") ?? "") ? (params.get("service") as string) : "essential";
  const initialFrequency = FREQUENCIES.some((frequency) => frequency.id === params.get("frequency")) ? (params.get("frequency") as string) : "biweekly";
  const demoContact = intakeEnabled ? { name: "", phone: "", email: "", zip: "" } : { name: "Demo Homeowner", phone: "555-0100", email: "demo@example.com", zip: "83814" };

  const [step, setStep] = useState(0);
  const [serviceId, setServiceId] = useState(initialService);
  const [frequency, setFrequency] = useState(initialFrequency);
  const [property, setProperty] = useState<PropertyProfile>({
    propertyType: "house", sizeBand: "1200_2000", bedrooms: "3", bathrooms: "2", floors: "1", condition: "maintained",
  });
  const [rooms, setRooms] = useState<RoomPlan[]>(ROOM_OPTIONS);
  const [preferences, setPreferences] = useState<string[]>(["Unscented products"]);
  const [petBand, setPetBand] = useState<"none" | "one" | "two_plus">("none");
  const [petNotes, setPetNotes] = useState("");
  const [accessMethod, setAccessMethod] = useState<"meet_at_door" | "keypad" | "lockbox" | "coordinate_later">("coordinate_later");
  const [accessNotes, setAccessNotes] = useState("");
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [window_, setWindow] = useState<string>("10:00 AM");
  const [contact, setContact] = useState(demoContact);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ id: string; estimate: number; persisted: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bookableServices = services.filter((service) => BOOKABLE_SERVICE_IDS.includes(service.id));
  const estimate = useMemo(() => calculateEstimate({
    sizeBand: property.sizeBand,
    serviceId: serviceId as "essential" | "deep" | "move" | "rental",
    bedrooms: property.bedrooms,
    bathrooms: property.bathrooms,
    frequency: frequency as "weekly" | "biweekly" | "monthly" | "onetime",
    pets: petBand,
    addonIds,
  }), [property, serviceId, frequency, petBand, addonIds]);
  const planning = useMemo(() => buildPlanningDirection({
    serviceId: serviceId as "essential" | "deep" | "move" | "rental",
    property,
    rooms,
    preferences,
    petNotes,
    accessMethod,
    accessNotes,
    specialInstructions,
    addonIds,
  }), [serviceId, property, rooms, preferences, petNotes, accessMethod, accessNotes, specialInstructions, addonIds]);

  function toggleRoom(id: string) {
    setRooms((current) => current.map((room) => room.id === id ? { ...room, selected: !room.selected } : room));
  }

  function updateRoomNote(id: string, note: string) {
    setRooms((current) => current.map((room) => room.id === id ? { ...room, note } : room));
  }

  function canContinue(): string | null {
    if (step === 2 && !rooms.some((room) => room.selected)) return "Choose at least one room.";
    if (step === 4 && petBand !== "none" && !petNotes.trim()) return "Add a short pet note so the operator can plan safely.";
    if (step === 6 && !date) return "Pick a preferred date to continue.";
    if (step === 7) {
      if (!contact.name.trim()) return "Add a name for the request.";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.email)) return "Add a valid email.";
      if (contact.phone.replace(/\D/g, "").length < 7) return "Add a valid phone.";
      if (contact.zip.trim().length < 3) return "Add a ZIP.";
    }
    return null;
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    if (!intakeEnabled) {
      capture("service_plan_previewed", { serviceId, frequency, planningScore: planning.score });
      setResult({ id: "PREVIEW-NOT-SAVED", estimate: estimate.dollars, persisted: false });
      setSubmitting(false);
      return;
    }

    try {
      const response = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId,
          addonIds,
          frequency,
          scheduledDate: date,
          scheduledWindow: window_,
          home: { ...property, pets: petBand },
          rooms,
          preferences,
          petNotes: petNotes || undefined,
          accessMethod,
          contact,
          accessNotes: accessNotes || undefined,
          specialInstructions: specialInstructions || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Request failed");
      capture("booking_requested", { serviceId, frequency, estimate: data.estimate, planningScore: planning.score });
      setResult({ id: data.id, estimate: data.estimate, persisted: true });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Request failed — try again.";
      setError(message);
      showToast(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="card booking-result">
        <span className="eyebrow">{result.persisted ? "Request received" : "Preview complete · nothing saved"}</span>
        <h2>{result.persisted ? "Your home plan is in the review queue." : "This is what the operator would receive."}</h2>
        <p className="copy">
          {result.persisted
            ? "The requested date and time are preferences, not a confirmed appointment. An operator reviews the scope and follows up before anything is scheduled."
            : "Customer-data intake is intentionally off. This plan stayed in your browser and created no booking, message, or customer record."}
        </p>
        <div className="dash-grid" style={{ margin: "22px 0" }}>
          <div className="dash-metric card"><b>${result.estimate}+</b><p className="copy">Starting estimate</p></div>
          <div className="dash-metric card"><b>{date ? formatLongDate(date).split(",")[0] : "—"}</b><p className="copy">Preferred date</p></div>
          <div className="dash-metric card"><b>{planning.effort}</b><p className="copy">Planning direction</p></div>
          <div className="dash-metric card"><b>{planning.checklist.length}</b><p className="copy">Draft checklist items</p></div>
        </div>
        <div className="hero-actions">
          {result.persisted && <Link className="btn btn-primary" href="/dashboard">Open customer dashboard</Link>}
          <Link className="btn btn-soft" href="/services">Review services</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="booking-shell">
      <aside className="card booking-rail">
        <div className="booking-progress"><span>Step {step + 1} of {STEPS.length}</span><span>{Math.round(((step + 1) / STEPS.length) * 100)}%</span></div>
        <div className="booking-progress-track"><span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
        <div className="booking-step-list">
          {STEPS.map((label, index) => (
            <button key={label} type="button" className={`rail-btn${index === step ? " active" : ""}${index < step ? " complete" : ""}`} onClick={() => index < step && setStep(index)}>
              <span className="step-num">{index < step ? "✓" : index + 1}</span>{label}
            </button>
          ))}
        </div>
        <div className="planning-card">
          <span className="eyebrow">Planning direction</span>
          <strong>{planning.effort}</strong>
          <p>{planning.summary}</p>
          <div><span>Starting estimate</span><b>${estimate.dollars}+</b></div>
        </div>
      </aside>

      <div className="card booking-workspace">
        {!intakeEnabled && <div className="preview-banner"><strong>Safe preview:</strong> demo contact values are prefilled. Nothing is sent or stored.</div>}

        {step === 0 && <>
          <span className="eyebrow">01 · Service request</span><h2>What kind of reset does the property need?</h2>
          <p className="copy">Choose the closest fit. The operator can refine scope after reviewing the full plan.</p>
          <div className="choice-grid">
            {bookableServices.map((service) => <button key={service.id} type="button" className={`choice-card${serviceId === service.id ? " selected" : ""}`} onClick={() => setServiceId(service.id)}>
              <span className="choice-icon">{service.icon}</span><strong>{service.title}</strong><small>{service.price_label}</small><p>{service.blurb}</p>
            </button>)}
          </div>
          <div className="field" style={{ marginTop: 18 }}><label htmlFor="book-frequency">Preferred cadence</label><select id="book-frequency" value={frequency} onChange={(event) => setFrequency(event.target.value)}>{FREQUENCIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
        </>}

        {step === 1 && <>
          <span className="eyebrow">02 · Property profile</span><h2>Give the operator a useful picture of the home.</h2>
          <p className="copy">No street address is requested here. Exact access details can be confirmed privately after review.</p>
          <div className="form-grid planning-form">
            <div className="field"><label htmlFor="property-type">Property type</label><select id="property-type" value={property.propertyType} onChange={(event) => setProperty((value) => ({ ...value, propertyType: event.target.value as PropertyProfile["propertyType"] }))}>{PROPERTY_TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>
            <div className="field"><label htmlFor="property-size">Approximate size</label><select id="property-size" value={property.sizeBand} onChange={(event) => setProperty((value) => ({ ...value, sizeBand: event.target.value as PropertyProfile["sizeBand"] }))}>{SIZE_BANDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
            <div className="field"><label htmlFor="property-bedrooms">Bedrooms</label><select id="property-bedrooms" value={property.bedrooms} onChange={(event) => setProperty((value) => ({ ...value, bedrooms: event.target.value as PropertyProfile["bedrooms"] }))}>{BEDROOM_BANDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
            <div className="field"><label htmlFor="property-bathrooms">Bathrooms</label><select id="property-bathrooms" value={property.bathrooms} onChange={(event) => setProperty((value) => ({ ...value, bathrooms: event.target.value as PropertyProfile["bathrooms"] }))}>{BATHROOM_BANDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
            <div className="field"><label htmlFor="property-floors">Floors</label><select id="property-floors" value={property.floors} onChange={(event) => setProperty((value) => ({ ...value, floors: event.target.value as PropertyProfile["floors"] }))}>{FLOOR_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>
            <div className="field"><label htmlFor="property-condition">Current condition</label><select id="property-condition" value={property.condition} onChange={(event) => setProperty((value) => ({ ...value, condition: event.target.value as PropertyProfile["condition"] }))}><option value="maintained">Generally maintained</option><option value="needs_detail">Needs detailed attention</option></select></div>
          </div>
        </>}

        {step === 2 && <>
          <span className="eyebrow">03 · Room plan</span><h2>Choose rooms and leave notes where they matter.</h2>
          <p className="copy">Selected rooms become the first draft of the service checklist.</p>
          <div className="room-plan-grid">
            {rooms.map((room) => <div key={room.id} className={`room-plan-row${room.selected ? " selected" : ""}`}>
              <button type="button" onClick={() => toggleRoom(room.id)} aria-pressed={room.selected}><span className="room-check">{room.selected ? "✓" : "+"}</span><strong>{room.label}</strong></button>
              {room.selected && <input aria-label={`${room.label} note`} value={room.note ?? ""} onChange={(event) => updateRoomNote(room.id, event.target.value)} placeholder="Optional room note or priority" />}
            </div>)}
          </div>
        </>}

        {step === 3 && <>
          <span className="eyebrow">04 · Cleaning preferences</span><h2>How should the service feel in this home?</h2>
          <p className="copy">These preferences travel with the request and become checklist reminders.</p>
          <div className="preference-grid">{PREFERENCE_OPTIONS.map((preference) => <button key={preference} type="button" className={preferences.includes(preference) ? "selected" : ""} onClick={() => setPreferences((current) => current.includes(preference) ? current.filter((item) => item !== preference) : [...current, preference])}><span>{preferences.includes(preference) ? "✓" : "+"}</span>{preference}</button>)}</div>
          <div className="field" style={{ marginTop: 18 }}><label htmlFor="special-instructions">Other priorities or special instructions</label><textarea id="special-instructions" value={specialInstructions} onChange={(event) => setSpecialInstructions(event.target.value)} placeholder="Surfaces to avoid, fragile items, focus areas, or anything else the operator should plan around." /></div>
        </>}

        {step === 4 && <>
          <span className="eyebrow">05 · Pets & access</span><h2>Plan a smooth, respectful arrival.</h2>
          <div className="form-grid planning-form">
            <div className="field"><label htmlFor="pet-count">Pets in the home</label><select id="pet-count" value={petBand} onChange={(event) => setPetBand(event.target.value as typeof petBand)}>{PET_BANDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
            <div className="field"><label htmlFor="access-method">Preferred access plan</label><select id="access-method" value={accessMethod} onChange={(event) => setAccessMethod(event.target.value as typeof accessMethod)}>{ACCESS_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>
            <div className="field full"><label htmlFor="pet-notes">Pet notes</label><textarea id="pet-notes" value={petNotes} onChange={(event) => setPetNotes(event.target.value)} placeholder="Names, temperament, where they’ll be, and doors or gates to watch." /></div>
            <div className="field full"><label htmlFor="access-notes">Access and parking notes</label><textarea id="access-notes" value={accessNotes} onChange={(event) => setAccessNotes(event.target.value)} placeholder="Keep codes out of this preview. Note parking, entry preference, or who to contact instead." /></div>
          </div>
        </>}

        {step === 5 && <>
          <span className="eyebrow">06 · Add-ons</span><h2>Add work that belongs in the plan.</h2>
          <p className="copy">Starting estimate adjustments are shown where defined. Custom-scope work stays subject to operator review.</p>
          <div className="choice-grid compact">{addons.map((addon) => <button key={addon.id} type="button" className={`choice-card${addonIds.includes(addon.id) ? " selected" : ""}`} onClick={() => setAddonIds((current) => current.includes(addon.id) ? current.filter((id) => id !== addon.id) : [...current, addon.id])}><strong>{addon.title}</strong><small>{addon.price_label}</small></button>)}</div>
        </>}

        {step === 6 && <>
          <span className="eyebrow">07 · Timing preference</span><h2>When would service work best?</h2>
          <div className="notice-card"><strong>This is a request, not live availability.</strong><p>The operator confirms capacity and the final appointment after reviewing the property plan.</p></div>
          <div className="calendar-ui"><Calendar selected={date} onSelect={setDate} /><div><span className="eyebrow">Preferred arrival</span><div className="time-grid">{ARRIVAL_WINDOWS.map((window) => <button key={window} type="button" className={window_ === window ? "active" : ""} onClick={() => setWindow(window)}>{window}</button>)}</div>{date && <p className="copy" style={{ marginTop: 16 }}><strong>{formatLongDate(date)}</strong><br />{window_} preferred arrival</p>}</div></div>
        </>}

        {step === 7 && <>
          <span className="eyebrow">08 · Review</span><h2>One clear request for the planning queue.</h2>
          <div className="request-summary">
            <div><span>Service</span><strong>{bookableServices.find((service) => service.id === serviceId)?.title}</strong></div>
            <div><span>Property</span><strong>{PROPERTY_TYPES.find(([id]) => id === property.propertyType)?.[1]} · {property.bedrooms} bed · {property.bathrooms} bath</strong></div>
            <div><span>Rooms</span><strong>{rooms.filter((room) => room.selected).length} selected · {planning.checklist.length} draft tasks</strong></div>
            <div><span>Timing</span><strong>{date ? formatLongDate(date) : "Not selected"} · {window_}</strong></div>
          </div>
          <div className="form-grid planning-form">
            <div className="field"><label htmlFor="contact-name">Name</label><input id="contact-name" value={contact.name} onChange={(event) => setContact((value) => ({ ...value, name: event.target.value }))} autoComplete={intakeEnabled ? "name" : "off"} /></div>
            <div className="field"><label htmlFor="contact-phone">Phone</label><input id="contact-phone" value={contact.phone} onChange={(event) => setContact((value) => ({ ...value, phone: event.target.value }))} autoComplete={intakeEnabled ? "tel" : "off"} /></div>
            <div className="field"><label htmlFor="contact-email">Email</label><input id="contact-email" type="email" value={contact.email} onChange={(event) => setContact((value) => ({ ...value, email: event.target.value }))} autoComplete={intakeEnabled ? "email" : "off"} /></div>
            <div className="field"><label htmlFor="contact-zip">ZIP / postal code</label><input id="contact-zip" value={contact.zip} onChange={(event) => setContact((value) => ({ ...value, zip: event.target.value }))} autoComplete={intakeEnabled ? "postal-code" : "off"} /></div>
          </div>
          <div className="planning-review"><span className="eyebrow">Intelligent planning direction</span><strong>{planning.summary}</strong><p>Score {planning.score}/100 · starting estimate ${estimate.dollars}+ · operator confirmation required.</p></div>
          {error && <p className="form-error">{error}</p>}
        </>}

        <div className="booking-actions">
          <button type="button" className="btn btn-soft" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0 || submitting}>Back</button>
          <span className="copy">{step < 7 ? "You can revisit completed steps." : intakeEnabled ? "Sends a service request—no payment." : "Builds a local preview only."}</span>
          <button type="button" className="btn btn-primary" disabled={submitting} onClick={() => { const blocker = canContinue(); if (blocker) { showToast(blocker); return; } if (step === 7) void submit(); else setStep((current) => current + 1); }}>
            {step === 7 ? (submitting ? "Building plan…" : intakeEnabled ? "Send service request" : "Preview operator plan") : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
