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
import {
  ARRIVAL_WINDOWS,
  formatLongDate,
  isBookableDate,
  toIsoDate,
} from "@/lib/scheduling";
import { showToast } from "./toast";

type Service = { id: string; title: string; icon: string; price_label: string };
type Addon = { id: string; title: string; price_label: string };

const STEPS = ["Service", "Home", "Add-ons", "Schedule", "Contact", "Confirm"] as const;
const BOOKABLE_SERVICE_IDS = ["essential", "deep", "move", "rental"];

function Calendar({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (iso: string) => void;
}) {
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
          <button
            type="button"
            onClick={() => setMonthOffset((m) => m - 1)}
            disabled={monthOffset <= 0}
            aria-label="Previous month"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => setMonthOffset((m) => m + 1)}
            disabled={monthOffset >= 2}
            aria-label="Next month"
          >
            ›
          </button>
        </span>
      </div>
      <div className="calendar-days">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="calendar-dates">
        {Array.from({ length: firstWeekday }, (_, i) => (
          <button key={`blank-${i}`} type="button" className="blank" tabIndex={-1} />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const iso = toIsoDate(new Date(view.getFullYear(), view.getMonth(), i + 1));
          const bookable = isBookableDate(iso, today);
          return (
            <button
              key={iso}
              type="button"
              className={selected === iso ? "active" : ""}
              disabled={!bookable}
              onClick={() => onSelect(iso)}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function BookingFlow({ services, addons }: { services: Service[]; addons: Addon[] }) {
  const params = useSearchParams();
  const initialService = BOOKABLE_SERVICE_IDS.includes(params.get("service") ?? "")
    ? (params.get("service") as string)
    : "essential";
  const initialFrequency = FREQUENCIES.some((f) => f.id === params.get("frequency"))
    ? (params.get("frequency") as string)
    : "biweekly";

  const [step, setStep] = useState(0);
  const [serviceId, setServiceId] = useState(initialService);
  const [frequency, setFrequency] = useState(initialFrequency);
  const [home, setHome] = useState({
    sizeBand: "1200_2000",
    bedrooms: "3",
    bathrooms: "2",
    pets: "one",
    condition: "maintained",
    notes: "",
  });
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [window_, setWindow] = useState<string>("10:00 AM");
  const [contact, setContact] = useState({ name: "", phone: "", email: "", zip: "" });
  const [accessNotes, setAccessNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ id: string; estimate: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bookableServices = services.filter((s) => BOOKABLE_SERVICE_IDS.includes(s.id));

  const estimate = useMemo(
    () =>
      calculateEstimate({
        sizeBand: home.sizeBand as never,
        serviceId: serviceId as never,
        bedrooms: home.bedrooms as never,
        bathrooms: home.bathrooms as never,
        frequency: frequency as never,
        pets: home.pets as never,
        addonIds,
      }),
    [home, serviceId, frequency, addonIds],
  );

  function canContinue(): string | null {
    if (step === 3 && !date) return "Pick a date to continue.";
    if (step === 4) {
      if (!contact.name.trim()) return "Add your name.";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.email)) return "Add a valid email.";
      if (contact.phone.replace(/\D/g, "").length < 7) return "Add a valid phone.";
      if (contact.zip.trim().length < 3) return "Add your ZIP.";
    }
    return null;
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId,
          addonIds,
          frequency,
          scheduledDate: date,
          scheduledWindow: window_,
          home,
          contact,
          accessNotes: accessNotes || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Booking failed");
      capture("booking_requested", { serviceId, frequency, estimate: data.estimate });
      setResult({ id: data.id, estimate: data.estimate });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Booking failed — try again.";
      setError(message);
      showToast(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="card" style={{ padding: 28 }}>
        <span className="eyebrow">Request received</span>
        <h2 style={{ fontFamily: "ui-serif,Georgia,serif", fontSize: 46, letterSpacing: "-.06em", lineHeight: 0.9, margin: "16px 0 10px" }}>
          Your clean is on the calendar.
        </h2>
        <div className="dash-grid" style={{ margin: "18px 0" }}>
          <div className="dash-metric card">
            <b>${result.estimate}+</b>
            <p className="copy">Starting estimate</p>
          </div>
          <div className="dash-metric card">
            <b>{date ? formatLongDate(date).split(",")[0] : ""}</b>
            <p className="copy">{date}</p>
          </div>
          <div className="dash-metric card">
            <b>{window_}</b>
            <p className="copy">Arrival window</p>
          </div>
          <div className="dash-metric card">
            <b>Email</b>
            <p className="copy">Confirmation sent</p>
          </div>
        </div>
        <ul className="checks">
          <li>We confirm the final quote with you before the visit</li>
          <li>Text updates when your cleaner is on the way</li>
          <li>Create an account with this email to manage everything in the dashboard</li>
        </ul>
        <div className="hero-actions">
          <Link className="btn btn-primary" href="/dashboard">
            Open dashboard
          </Link>
          <Link className="btn btn-soft" href="/">
            Back home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="quote-lab">
      <aside className="card" style={{ padding: 22 }}>
        <div style={{ display: "grid", gap: 10 }}>
          {STEPS.map((label, i) => (
            <button
              key={label}
              type="button"
              className={`rail-btn${i === step ? " active" : ""}`}
              onClick={() => i < step && setStep(i)}
            >
              <span className="step-num">{i + 1}</span>
              {label}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 18, padding: 16, borderTop: "1px solid var(--line)" }}>
          <span className="eyebrow">Running estimate</span>
          <div style={{ fontSize: 44, fontWeight: 950, letterSpacing: "-.08em", marginTop: 8 }}>
            from ${estimate.dollars}
          </div>
          <p className="copy" style={{ fontSize: 14 }}>
            Starting anchor — final quote confirmed before the visit.
          </p>
        </div>
      </aside>

      <div className="card" style={{ padding: 28 }}>
        {step === 0 && (
          <>
            <h2>Choose service</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10, marginTop: 16 }}>
              {bookableServices.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`rail-btn${serviceId === s.id ? " active" : ""}`}
                  onClick={() => setServiceId(s.id)}
                >
                  <span className="icon">{s.icon}</span>
                  <span>
                    {s.title}
                    <br />
                    <small>{s.price_label}</small>
                  </span>
                </button>
              ))}
            </div>
            <div className="field" style={{ marginTop: 16 }}>
              <label htmlFor="book-frequency">Frequency</label>
              <select
                id="book-frequency"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value)}
              >
                {FREQUENCIES.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h2>Home details</h2>
            <div className="form-grid" style={{ marginTop: 16 }}>
              {(
                [
                  ["Home size", "sizeBand", SIZE_BANDS],
                  ["Bedrooms", "bedrooms", BEDROOM_BANDS],
                  ["Bathrooms", "bathrooms", BATHROOM_BANDS],
                  ["Pets", "pets", PET_BANDS],
                ] as const
              ).map(([label, key, bands]) => (
                <div className="field" key={key}>
                  <label htmlFor={`home-${key}`}>{label}</label>
                  <select
                    id={`home-${key}`}
                    value={home[key]}
                    onChange={(e) => setHome((h) => ({ ...h, [key]: e.target.value }))}
                  >
                    {bands.map((band) => (
                      <option key={band.id} value={band.id}>
                        {band.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              <div className="field">
                <label htmlFor="home-condition">Condition</label>
                <select
                  id="home-condition"
                  value={home.condition}
                  onChange={(e) => setHome((h) => ({ ...h, condition: e.target.value }))}
                >
                  <option value="maintained">Maintained</option>
                  <option value="needs_detail">Needs detail</option>
                </select>
              </div>
              <div className="field full">
                <label htmlFor="home-notes">Notes</label>
                <textarea
                  id="home-notes"
                  value={home.notes}
                  onChange={(e) => setHome((h) => ({ ...h, notes: e.target.value }))}
                  placeholder="Access, pets, priorities, products..."
                />
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2>Add-ons</h2>
            <p className="copy" style={{ margin: "8px 0 16px" }}>
              Priced add-ons fold into your estimate; windows and organization are quoted with
              your final confirmation.
            </p>
            <div className="tag-row">
              {addons.map((addon) => (
                <button
                  key={addon.id}
                  type="button"
                  className={`btn btn-soft${addonIds.includes(addon.id) ? " selected" : ""}`}
                  onClick={() =>
                    setAddonIds((ids) =>
                      ids.includes(addon.id)
                        ? ids.filter((id) => id !== addon.id)
                        : [...ids, addon.id],
                    )
                  }
                >
                  {addon.title} {addon.price_label}
                </button>
              ))}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2>Pick time</h2>
            <div style={{ marginTop: 16 }}>
              <Calendar selected={date} onSelect={setDate} />
              <div className="time-grid">
                {ARRIVAL_WINDOWS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={window_ === w ? "active" : ""}
                    onClick={() => setWindow(w)}
                  >
                    {w}
                  </button>
                ))}
              </div>
              {date && (
                <p className="copy" style={{ marginTop: 14 }}>
                  <strong>{formatLongDate(date)}</strong> · {window_} arrival window. We&rsquo;ll
                  text when your cleaner is on the way.
                </p>
              )}
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h2>Contact info</h2>
            <div className="form-grid" style={{ marginTop: 16 }}>
              <div className="field">
                <label htmlFor="contact-name">Name</label>
                <input
                  id="contact-name"
                  value={contact.name}
                  onChange={(e) => setContact((c) => ({ ...c, name: e.target.value }))}
                  placeholder="Full name"
                  autoComplete="name"
                />
              </div>
              <div className="field">
                <label htmlFor="contact-phone">Phone</label>
                <input
                  id="contact-phone"
                  value={contact.phone}
                  onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))}
                  placeholder="Text-capable number"
                  autoComplete="tel"
                />
              </div>
              <div className="field">
                <label htmlFor="contact-email">Email</label>
                <input
                  id="contact-email"
                  type="email"
                  value={contact.email}
                  onChange={(e) => setContact((c) => ({ ...c, email: e.target.value }))}
                  placeholder="you@email.com"
                  autoComplete="email"
                />
              </div>
              <div className="field">
                <label htmlFor="contact-zip">ZIP</label>
                <input
                  id="contact-zip"
                  value={contact.zip}
                  onChange={(e) => setContact((c) => ({ ...c, zip: e.target.value }))}
                  placeholder="83814"
                  autoComplete="postal-code"
                />
              </div>
              <div className="field full">
                <label htmlFor="contact-access">Access notes</label>
                <textarea
                  id="contact-access"
                  value={accessNotes}
                  onChange={(e) => setAccessNotes(e.target.value)}
                  placeholder="Gate code, parking, entry instructions..."
                />
              </div>
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <h2>Review request</h2>
            <div className="dash-grid" style={{ margin: "16px 0" }}>
              <div className="dash-metric card">
                <b>${estimate.dollars}+</b>
                <p className="copy">Starting estimate</p>
              </div>
              <div className="dash-metric card">
                <b>{date ? formatLongDate(date).split(",")[0] : "—"}</b>
                <p className="copy">{date ?? "No date"}</p>
              </div>
              <div className="dash-metric card">
                <b>{window_}</b>
                <p className="copy">Arrival</p>
              </div>
              <div className="dash-metric card">
                <b>SMS</b>
                <p className="copy">Updates</p>
              </div>
            </div>
            <ul className="checks">
              <li>Price finalized after details are reviewed</li>
              <li>Eco-conscious supplies available</li>
              <li>Cleaner notes saved</li>
              <li>Dashboard access with this email</li>
            </ul>
            {error && (
              <p className="copy" style={{ color: "#c0533f", fontWeight: 800 }}>
                {error}
              </p>
            )}
          </>
        )}

        <div className="hero-actions" style={{ marginTop: 24 }}>
          <button
            type="button"
            className="btn btn-soft"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || submitting}
          >
            Back
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={submitting}
            onClick={() => {
              const blocker = canContinue();
              if (blocker) {
                showToast(blocker);
                return;
              }
              if (step === 5) {
                submit();
              } else {
                setStep((s) => s + 1);
              }
            }}
          >
            {step === 5 ? (submitting ? "Sending..." : "Confirm request") : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
