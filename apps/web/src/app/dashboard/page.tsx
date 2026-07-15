import type { Metadata } from "next";
import Link from "next/link";
import { randomUUID } from "node:crypto";

import { resolveDashboardIdentity } from "@/lib/auth";
import {
  getCustomerBookings,
  getCustomerServiceCases,
  getNextBooking,
  getPrimaryHome,
  getSupportThread,
} from "@/lib/data";
import { authEnabled, customerPortalWritesEnabled } from "@/lib/env";
import { getCustomerFieldDashboard } from "@/lib/field-operations-data";
import { formatLongDate } from "@/lib/scheduling";

import {
  customerCleanerPreferenceAction,
  customerJobMessageAction,
  customerReviewAction,
  customerTipIntentAction,
  rescheduleAction,
  saveNotesAction,
  scheduleProposalResponseAction,
  supportMessageAction,
} from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
  robots: { index: false },
};

const TABS = [
  ["overview", "🏠 Overview"],
  ["bookings", "📅 Bookings"],
  ["service", "🧭 Service control"],
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

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatDateTime(value: string, timeZone: string) {
  return new Date(value).toLocaleString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

  const [nextBooking, bookings, home, support, serviceCases, field] = await Promise.all([
    getNextBooking(customer.id),
    getCustomerBookings(customer.id),
    getPrimaryHome(customer.id),
    getSupportThread(customer.id),
    getCustomerServiceCases(customer.id),
    getCustomerFieldDashboard(customer.id, identity.state === "preview"),
  ]);
  const fieldAllocations = [
    ...new Map(
      field.cleaners.filter((cleaner) => cleaner.crew_message_open).map((cleaner) => [
        cleaner.team_job_allocation_id,
        {
          id: cleaner.team_job_allocation_id,
          label: `${cleaner.service_vertical.replaceAll("_", " ")} · ${formatDateTime(cleaner.schedule_start_at, cleaner.timezone)} · ${cleaner.service_location}`,
        },
      ]),
    ).values(),
  ];

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
                        {customerPortalWritesEnabled && [
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
                        ) : !customerPortalWritesEnabled ? <p className="copy" style={{ marginTop: 12 }}>Customer portal changes are temporarily disabled.</p> : null}
                        {customerPortalWritesEnabled && (
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

            {tab === "service" && (
              <div className="operator-detail-stack">
                <section className="card operator-panel">
                  <span className="eyebrow">Schedule approval</span>
                  <h2>Approve the window or send it back.</h2>
                  <p className="copy">A request is not a confirmed appointment. Your team proposes a feasible arrival window after route, duration, crew, and operating-hour review.</p>
                  <div className="ops-ledger-list">
                    {field.proposals.map((proposal) => (
                      <article key={proposal.id}>
                        <div>
                          <span className={`status-badge ${proposal.status}`}>{proposal.status.replaceAll("_", " ")}</span>
                          <strong>{proposal.service_vertical} · {proposal.team_name}</strong>
                          <small>{new Date(proposal.arrival_window_start).toLocaleString("en-US", { timeZone: proposal.timezone, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}–{new Date(proposal.arrival_window_end).toLocaleTimeString("en-US", { timeZone: proposal.timezone, hour: "numeric", minute: "2-digit" })}</small>
                          {proposal.proposal_note && <p>{proposal.proposal_note}</p>}
                          {proposal.customer_response_note && <p>Your response: {proposal.customer_response_note}</p>}
                          {proposal.status === "pending_customer" && !proposal.response_open && <p>{proposal.proposal_expired ? "This proposal expired before a response was recorded. Your service team must send a new reviewed window." : "This proposal is no longer open. Your service team must finish the active reschedule review and send a new window if needed."}</p>}
                        </div>
                        {proposal.status === "pending_customer" && proposal.response_open && customerPortalWritesEnabled && (
                          <form action={scheduleProposalResponseAction} className="operations-form-grid">
                            <input type="hidden" name="proposalId" value={proposal.id} />
                            <label>Change request, if needed<textarea name="note" maxLength={2000} placeholder="Optional for approval; required when requesting a change" /></label>
                            <div className="hero-actions">
                              <button className="btn btn-soft" name="response" value="changes_requested">Request changes</button>
                              <button className="btn btn-primary" name="response" value="approved">Approve window</button>
                            </div>
                          </form>
                        )}
                      </article>
                    ))}
                    {field.proposals.length === 0 && <p className="copy">No arrival window is awaiting review.</p>}
                  </div>
                </section>

                <section className="card operator-panel">
                  <span className="eyebrow">Audited job communication</span>
                  <h2>Keep service updates with the job.</h2>
                  {customerPortalWritesEnabled && fieldAllocations.length > 0 && (
                    <form action={customerJobMessageAction} className="operations-form-grid">
                      <label>Service job<select name="allocationId">{fieldAllocations.map((allocation) => <option key={allocation.id} value={allocation.id}>{allocation.label}</option>)}</select></label>
                      <label>Message<textarea name="body" required maxLength={2000} placeholder="Access update, arrival question, or job-specific note. Do not send payment details or door codes." /></label>
                      <button className="btn btn-primary">Send in app</button>
                    </form>
                  )}
                  {customerPortalWritesEnabled && fieldAllocations.length === 0 && <p className="copy">Crew messaging opens after a visit is confirmed and remains available while service is active.</p>}
                  <div className="internal-note-list">
                    {field.communications.map((message) => <article key={message.id}><div><strong>{message.sender_kind.replaceAll("_", " ")}</strong><span>{new Date(message.created_at).toLocaleString()}</span></div><p>{message.body}</p><small>{message.channel} · {message.delivery_status.replaceAll("_", " ")}</small></article>)}
                    {field.communications.length === 0 && <p className="copy">No job-specific messages yet.</p>}
                  </div>
                </section>

                <section className="card operator-panel">
                  <span className="eyebrow">Cleaner continuity</span>
                  <h2>Preference, review, and tip intent.</h2>
                  <p className="copy">Preferences improve scheduling scores but never bypass availability, qualifications, travel, or workload caps. Tip submission records intent only; it does not charge a card.</p>
                  <div className="ops-ledger-list">
                    {field.cleaners.map((cleaner) => {
                      const reviewed = field.reviews.some((review) => review.team_job_allocation_id === cleaner.team_job_allocation_id && review.cleaner_id === cleaner.cleaner_id);
                      const tip = field.tips.find((item) => item.team_job_allocation_id === cleaner.team_job_allocation_id && item.cleaner_id === cleaner.cleaner_id);
                      const completed = cleaner.schedule_status === "completed";
                      return <article key={`${cleaner.team_job_allocation_id}-${cleaner.cleaner_id}`}>
                        <div><strong>{cleaner.cleaner_name}</strong><small>{cleaner.assignment_role} · {cleaner.schedule_status.replaceAll("_", " ")}{cleaner.preference ? ` · ${cleaner.preference}` : ""}</small></div>
                        {completed && customerPortalWritesEnabled && <form action={customerCleanerPreferenceAction} className="operations-form-grid">
                          <input type="hidden" name="allocationId" value={cleaner.team_job_allocation_id} />
                          <input type="hidden" name="cleanerId" value={cleaner.cleaner_id} />
                          <label>Scheduling preference<select name="preference" defaultValue={cleaner.preference ?? "preferred"}><option value="preferred">Prefer when feasible</option><option value="avoid">Do not schedule</option></select></label>
                          <label>Private scheduling note<input name="note" maxLength={1000} /></label>
                          <button className="btn btn-soft">Save preference</button>
                        </form>}
                        {!completed && <p className="copy">Scheduling preferences unlock after this service is completed, so they cannot silently change an active crew.</p>}
                        {completed && !reviewed && customerPortalWritesEnabled && <form action={customerReviewAction} className="operations-form-grid">
                          <input type="hidden" name="allocationId" value={cleaner.team_job_allocation_id} /><input type="hidden" name="cleanerId" value={cleaner.cleaner_id} />
                          <label>Rating<select name="rating" defaultValue="5"><option value="5">5 · exceptional</option><option value="4">4 · very good</option><option value="3">3 · acceptable</option><option value="2">2 · needs improvement</option><option value="1">1 · serious concern</option></select></label>
                          <label>Review note<textarea name="note" maxLength={2000} /></label>
                          <button className="btn btn-primary">Submit verified review</button>
                        </form>}
                        {tip && <div className="notice-card"><strong>Tip intent: {money(tip.amount_cents)} · {tip.status.replaceAll("_", " ")}</strong>{tip.note && <p>{tip.note}</p>}<small>Updated {new Date(tip.updated_at).toLocaleString()}. This ledger does not itself charge or pay anyone.</small></div>}
                        {completed && customerPortalWritesEnabled && (!tip || ["pending_collection", "canceled"].includes(tip.status)) && <form action={customerTipIntentAction} className="operations-form-grid">
                          <input type="hidden" name="allocationId" value={cleaner.team_job_allocation_id} /><input type="hidden" name="cleanerId" value={cleaner.cleaner_id} />
                          <label>Tip amount intent<input name="amountDollars" type="number" min="1" max="1000" step="0.01" placeholder="25.00" defaultValue={tip ? (tip.amount_cents / 100).toFixed(2) : undefined} required /></label>
                          <label>Optional note<input name="note" maxLength={500} defaultValue={tip?.note ?? ""} /></label>
                          <button className="btn btn-soft">{tip ? "Update uncollected tip intent" : "Record tip intent"}</button>
                        </form>}
                      </article>;
                    })}
                    {field.cleaners.length === 0 && <p className="copy">Assigned cleaner details appear after a crew accepts confirmed work.</p>}
                  </div>
                </section>

                {field.issues.length > 0 && <section className="card operator-panel"><span className="eyebrow">Customer-visible exceptions</span><h2>Issues your team shared.</h2><div className="ops-ledger-list">{field.issues.map((issue) => <article key={issue.id}><div><span className={`status-badge ${issue.severity}`}>{issue.severity}</span><strong>{issue.issue_type.replaceAll("_", " ")}</strong><small>{issue.status}</small></div><p>{issue.summary}</p></article>)}</div></section>}
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
                    {customerPortalWritesEnabled ? <form action={saveNotesAction}>
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
                {customerPortalWritesEnabled ? <form action={supportMessageAction} className="ops-form" style={{ padding: 0, border: 0 }}>
                  <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                  <div className="field">
                    <label htmlFor="dashboard-case-type">What do you need?</label>
                    <select id="dashboard-case-type" name="caseType" required defaultValue="">
                      <option value="" disabled>Choose request type</option>
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
