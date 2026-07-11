"use client";

import { useState } from "react";

import { capture } from "@/lib/analytics-client";
import { showToast } from "./toast-events";

export function LeadForm({ services }: { services: { id: string; title: string }[] }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: data.get("name"),
          zip: data.get("zip"),
          serviceId: data.get("service"),
          preferredDate: data.get("date") || undefined,
        }),
      });
      if (!res.ok) throw new Error("lead_failed");
      capture("lead_submitted", { serviceId: data.get("service") });
      showToast("Request received — we'll reach out shortly.");
      setDone(true);
      form.reset();
    } catch {
      showToast("Something went wrong — call or text us instead.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card" style={{ padding: 28 }}>
        <span className="eyebrow">Received</span>
        <h3 style={{ fontSize: 34, letterSpacing: "-.06em", margin: "14px 0 8px" }}>
          Your clean is requested.
        </h3>
        <p className="copy">
          We&rsquo;ll confirm your window by text. Want it locked in now? Finish in the booking
          flow — it takes about two minutes.
        </p>
        <a className="btn btn-primary" style={{ marginTop: 16 }} href="/book">
          Complete full booking
        </a>
      </div>
    );
  }

  return (
    <form className="lead-form" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="lead-name">Name</label>
        <input id="lead-name" name="name" required placeholder="Full name" />
      </div>
      <div className="field">
        <label htmlFor="lead-zip">Zip</label>
        <input id="lead-zip" name="zip" required placeholder="83814" />
      </div>
      <div className="field">
        <label htmlFor="lead-service">Service</label>
        <select id="lead-service" name="service" defaultValue={services[0]?.id}>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="lead-date">Date</label>
        <input id="lead-date" name="date" type="date" />
      </div>
      <button className="btn btn-primary" disabled={busy}>
        {busy ? "Sending..." : "Request my clean"}
      </button>
    </form>
  );
}
