"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type ManagedBooking = {
  reference: string;
  serviceTitle: string;
  status: "held" | "pending_scope" | "confirmed" | "canceled";
  start: string;
  end: string;
  arrivalWindow: string;
  timeZone: string;
  holdExpiresAt: string | null;
  conditionLabel: string | null;
};

function eventDate(booking: ManagedBooking) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: booking.timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(booking.start));
}

export function GuestBookingCalendar() {
  const [booking, setBooking] = useState<ManagedBooking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let canceled = false;
    async function load() {
      const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
      let response: Response | null = null;
      if (token) {
        response = await fetch("/api/scheduling/manage/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        }).catch(() => null);
        window.history.replaceState(null, "", "/manage");
      } else {
        response = await fetch("/api/scheduling/manage/booking", {
          cache: "no-store",
        }).catch(() => null);
      }
      const payload = response
        ? ((await response.json().catch(() => null)) as
            | { booking?: ManagedBooking; error?: string }
            | null)
        : null;
      if (canceled) return;
      if (!response?.ok || !payload?.booking) {
        setError(payload?.error || "This private booking link could not be opened.");
      } else {
        setBooking(payload.booking);
      }
      setLoading(false);
    }
    void load();
    return () => {
      canceled = true;
    };
  }, []);

  if (loading) {
    return <div className="card booking-result" role="status">Opening your private booking calendar…</div>;
  }
  if (!booking) {
    return (
      <div className="card booking-result" role="alert">
        <span className="eyebrow">Management access required</span>
        <h2>This booking link is unavailable.</h2>
        <p className="lead">{error}</p>
        <Link className="btn btn-primary" href="/book">Schedule service</Link>
      </div>
    );
  }

  return (
    <div className="guest-calendar-layout">
      <section className="card booking-result">
        <span className="eyebrow">Private booking calendar</span>
        <h2>{eventDate(booking)}</h2>
        <p className="lead">{booking.arrivalWindow} · {booking.timeZone}</p>
        <div className="request-summary">
          <div><span>Service</span><strong>{booking.serviceTitle}</strong></div>
          <div><span>Status</span><strong>{booking.status.replaceAll("_", " ")}</strong></div>
          <div><span>Reference</span><strong>{booking.reference}</strong></div>
          <div><span>Timezone</span><strong>{booking.timeZone}</strong></div>
        </div>
        {booking.status === "pending_scope" && booking.conditionLabel && (
          <div className="notice-card"><strong>Condition still open</strong><p>{booking.conditionLabel}</p></div>
        )}
        {booking.status === "held" && booking.holdExpiresAt && (
          <div className="notice-card">
            <strong>Capacity hold</strong>
            <p>This is a real reserved window, not yet a confirmed appointment. The hold remains subject to its displayed expiration and crew acceptance.</p>
          </div>
        )}
        <div className="hero-actions">
          <Link className="btn btn-primary" href="/book">Schedule another service</Link>
          <Link className="btn btn-soft" href="/service-support">Get service support</Link>
        </div>
      </section>
      <aside className="card calendar-agenda" aria-label="Booking agenda">
        <span className="eyebrow">Agenda</span>
        <div className="agenda-event">
          <span aria-hidden="true">{new Date(booking.start).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: booking.timeZone })}</span>
          <div><strong>{booking.serviceTitle}</strong><p>{booking.arrivalWindow}</p></div>
        </div>
        <p className="scope-note">Reschedule and cancellation actions arrive in the next self-service slice. Service support remains available now.</p>
      </aside>
    </div>
  );
}
