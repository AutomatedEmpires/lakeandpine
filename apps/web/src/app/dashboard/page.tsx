import type { Metadata } from "next";
import Link from "next/link";

import { resolveDashboardIdentity } from "@/lib/auth";
import {
  getCustomerBookings,
  getCustomerServiceCases,
  getNextBooking,
  getPrimaryHome,
  getSupportThread,
} from "@/lib/data";
import { authEnabled, requestIntakeEnabled } from "@/lib/env";
import { formatLongDate } from "@/lib/scheduling";

import { rescheduleAction, saveNotesAction, supportMessageAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
  robots: { index: false },
};

const TABS = [
  ["overview", "🏠 Overview"],
  ["bookings", "📅 Bookings"],
  ["notes", "⚙️ Property notes"],
  ["support", "💬 Support"],
] as const;

type TabId = (typeof TABS)[number][0];

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge ${status}`}>{status}</span>;
}

function windowLabel(booking: { status: string; scheduled_window: string }) {
  if (["confirmed", "scheduled", "in_progress", "completed", "follow_up"].includes(booking.status)) {
    return `${booking.scheduled_window} · confirmed window`;
  }
  if (booking.status === "ready") {
    return `${booking.scheduled_window} · proposed, not confirmed`;
  }
  return `${booking.scheduled_window} · requested preference`;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; booking?: string }>;
}) {
  const identity = await resolveDashboardIdentity();

  if (identity.state === "signed_out") {
    return (
      <div className="route-page">
        <div className="container page-hero">
          <div className="page-panel">
            <span className="eyebrow">Customer dashboard</span>
            <h1>Your home, remembered.</h1>
            <p className="lead">
              Service requests, home notes, status, and support in one calm place.
            </p>
            <div className="hero-actions">
              {authEnabled ? (
                <>
                  <Link className="btn btn-primary" href="/sign-in">
                    Sign in
                  </Link>
                  <Link className="btn btn-soft" href="/sign-up">
                    Create account
                  </Link>
                </>
              ) : (
                <>
                  <Link className="btn btn-primary" href="/book">
                    Request a consultation
                  </Link>
                  <p className="copy" style={{ alignSelf: "center" }}>
                    A private workspace becomes useful after an operator has reviewed your first
                    property request.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const customer = identity.customer;
  const params = await searchParams;
  const tab: TabId = (TABS.some(([id]) => id === params.tab) ? params.tab : "overview") as TabId;

  const [nextBooking, bookings, home, support, serviceCases] = await Promise.all([
    getNextBooking(customer.id),
    getCustomerBookings(customer.id),
    getPrimaryHome(customer.id),
    getSupportThread(customer.id),
    getCustomerServiceCases(customer.id),
  ]);

  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">
            {identity.state === "preview" ? "Preview mode — dev data" : "Customer dashboard"}
          </span>
          <h1>Welcome back{customer.full_name ? `, ${customer.full_name.split(" ")[0]}` : ""}.</h1>
          <p className="lead">
            See requested and confirmed work, keep property care notes organized, and understand
            what happens next.
          </p>
        </div>
      </div>

      <section className="section" style={{ paddingTop: 20 }}>
        <div className="container dash-split">
          <aside className="dash-rail card">
            {TABS.map(([id, label]) => (
              <Link
                key={id}
                href={`/dashboard?tab=${id}`}
                className={tab === id ? "active" : ""}
              >
                {label}
              </Link>
            ))}
          </aside>

          <div>
            {tab === "overview" && (
              <>
                <div className="dash-grid">
                  <div className="dash-metric card">
                    <span className="eyebrow">Requested window</span>
                    <b>
                      {nextBooking
                        ? formatLongDate(nextBooking.scheduled_date).replace(/^[^,]+, /, "")
                        : "—"}
                    </b>
                    <p className="copy">
                      {nextBooking ? windowLabel(nextBooking) : "No active request"}
                    </p>
                  </div>
                  <div className="dash-metric card">
                    <span className="eyebrow">Program</span>
                    <b>{nextBooking?.service_title ?? "—"}</b>
                    <p className="copy">
                      {nextBooking ? "Scope reviewed before confirmation" : "No program selected"}
                    </p>
                  </div>
                  <div className="dash-metric card">
                    <span className="eyebrow">Confirmation</span>
                    <b>{nextBooking ? nextBooking.status : "—"}</b>
                    <p className="copy">No time or price is implied by a request</p>
                  </div>
                  <div className="dash-metric card">
                    <span className="eyebrow">Requests</span>
                    <b>{bookings.length}</b>
                    <p className="copy">Visible in this account</p>
                  </div>
                </div>
                <div className="timeline">
                  {nextBooking && (
                    <div className="timeline-row card">
                      <span className="timeline-dot" />
                      <div>
                        <h3>{nextBooking.service_title} request</h3>
                        <p className="copy">
                          {formatLongDate(nextBooking.scheduled_date)} · {windowLabel(nextBooking)} ·{" "}
                          <StatusBadge status={nextBooking.status} />
                        </p>
                        {requestIntakeEnabled && [
                          "requested",
                          "reviewing",
                          "ready",
                          "confirmed",
                          "scheduled",
                        ].includes(nextBooking.status) ? (
                          <form action={rescheduleAction} style={{ marginTop: 12 }}>
                            <input type="hidden" name="bookingId" value={nextBooking.id} />
                            <button className="btn btn-primary">Request reschedule</button>
                          </form>
                        ) : !requestIntakeEnabled ? <p className="copy" style={{ marginTop: 12 }}>Request changes are disabled while customer-data intake is in preview.</p> : null}
                        {requestIntakeEnabled && (
                          <Link
                            className="btn btn-soft"
                            style={{ marginTop: 8 }}
                            href={`/dashboard?tab=support&booking=${nextBooking.id}`}
                          >
                            Cancellation, concern, reclean, or refund help
                          </Link>
                        )}
                      </div>
                    </div>
                  )}
                  {home?.cleaner_notes && (
                    <div className="timeline-row card">
                      <span className="timeline-dot" />
                      <div>
                        <h3>Property care notes</h3>
                        <p className="copy">{home.cleaner_notes}</p>
                      </div>
                    </div>
                  )}
                  {!nextBooking && (
                    <div className="timeline-row card">
                      <span className="timeline-dot" />
                      <div>
                        <h3>No active property request</h3>
                        <p className="copy">Build a scoped property brief for operator review.</p>
                        <Link className="btn btn-primary" style={{ marginTop: 12 }} href="/book">
                          Request consultation
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {tab === "bookings" && (
              <div className="timeline">
                {bookings.length === 0 && (
                  <div className="timeline-row card">
                    <span className="timeline-dot" />
                    <div>
                      <h3>No bookings yet</h3>
                      <p className="copy">Your reviewed requests and confirmed service will appear here.</p>
                    </div>
                  </div>
                )}
                {bookings.map((booking) => (
                  <div key={booking.id} className="timeline-row card">
                    <span className="timeline-dot" />
                    <div>
                      <h3>
                        {formatLongDate(booking.scheduled_date)} · <StatusBadge status={booking.status} />
                      </h3>
                      <p className="copy">
                        {booking.service_title} · {windowLabel(booking)} · {booking.frequency}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === "notes" && (
              <div className="card" style={{ padding: 28 }}>
                <h2>Property preferences</h2>
                <p className="copy">
                  Durable finish, access, and care notes for consistent service planning.
                </p>
                {home ? (
                  <>
                    {home.preference_tags.length > 0 && (
                      <div className="tag-row" style={{ margin: "18px 0" }}>
                        {home.preference_tags.map((tag) => (
                          <span key={tag} className="tag">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    {requestIntakeEnabled ? <form action={saveNotesAction}>
                      <input type="hidden" name="homeId" value={home.id} />
                      <div className="field">
                        <label htmlFor="notes">Property care notes</label>
                        <textarea id="notes" name="notes" defaultValue={home.cleaner_notes ?? ""} />
                      </div>
                      <button className="btn btn-primary" style={{ marginTop: 14 }}>
                        Save preferences
                      </button>
                    </form> : <div className="notice-card"><strong>Home-note editing is in preview.</strong><p>Changes are not accepted until customer-data collection is approved.</p></div>}
                  </>
                ) : (
                  <p className="copy" style={{ marginTop: 14 }}>
                    Your property profile is created after an operator reviews your first request.
                  </p>
                )}
              </div>
            )}

            {tab === "support" && (
              <div className="card" style={{ padding: 28 }}>
                <h2>Support requests</h2>
                {serviceCases.length > 0 && (
                  <div className="ops-list" style={{ marginTop: 18 }}>
                    {serviceCases.map((serviceCase) => (
                      <article className="notice-card" key={serviceCase.id}>
                        <div className="ops-row-head">
                          <strong>{serviceCase.public_reference} · {serviceCase.case_type.replaceAll("_", " ")}</strong>
                          <span className={`status-badge ${serviceCase.status}`}>{serviceCase.status.replaceAll("_", " ")}</span>
                        </div>
                        <p>{serviceCase.resolution_summary ?? serviceCase.details}</p>
                      </article>
                    ))}
                  </div>
                )}
                <div style={{ display: "grid", gap: 10, margin: "18px 0" }}>
                  {support.length === 0 && (
                    <div className="msg bot">
                      Need to adjust a requested window, report a concern, or clarify scope? Send
                      a message and an operator will review it.
                    </div>
                  )}
                  {support.map((message) => (
                    <div
                      key={message.id}
                      className={`msg ${message.sender === "customer" ? "user" : "bot"}`}
                    >
                      {message.body}
                    </div>
                  ))}
                </div>
                {requestIntakeEnabled ? <form action={supportMessageAction} className="ops-form" style={{ padding: 0, border: 0 }}>
                  <div className="field">
                    <label htmlFor="dashboard-case-type">What do you need?</label>
                    <select id="dashboard-case-type" name="caseType" required defaultValue="">
                      <option value="" disabled>Choose request type</option>
                      <option value="reschedule">Reschedule</option>
                      <option value="cancel">Cancellation</option>
                      <option value="complaint">Complaint or missed scope</option>
                      <option value="reclean">Reclean review</option>
                      <option value="refund_review">Refund review</option>
                      <option value="damage">Property damage concern</option>
                      <option value="other">Other support</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="dashboard-case-booking">Related booking</label>
                    <select id="dashboard-case-booking" name="bookingId" defaultValue={params.booking ?? ""}>
                      <option value="">No booking / general concern</option>
                      {bookings.map((booking) => (
                        <option value={booking.id} key={booking.id}>
                          {formatLongDate(booking.scheduled_date)} · {booking.service_title} · {booking.status}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field full">
                    <label htmlFor="dashboard-case-details">Details</label>
                    <textarea id="dashboard-case-details" name="body" maxLength={4000} placeholder="What happened, what outcome are you requesting, and how should we follow up?" required />
                  </div>
                  <p className="copy">Schedule changes, refunds, and recleans remain pending until an operator confirms them. Booking-linked request types require a related booking.</p>
                  <button className="btn btn-primary">Send to operations</button>
                </form> : <div className="notice-card"><strong>Messaging is not live.</strong><p>Support intake is a preview until customer-data collection and communications are approved.</p></div>}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
