import type { Metadata } from "next";
import Link from "next/link";

import { resolveDashboardIdentity } from "@/lib/auth";
import {
  getBillingRecords,
  getCustomerBookings,
  getNextBooking,
  getPrimaryHome,
  getSupportThread,
} from "@/lib/data";
import { authEnabled } from "@/lib/env";
import { formatDollars } from "@/lib/pricing";
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
  ["notes", "⚙️ Home notes"],
  ["billing", "🧾 Billing"],
  ["support", "💬 Support"],
] as const;

type TabId = (typeof TABS)[number][0];

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge ${status}`}>{status}</span>;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
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
              Upcoming cleans, home notes, invoices, referral credit, and support — the portal
              is part of the premium experience.
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
                    Book your first clean
                  </Link>
                  <p className="copy" style={{ alignSelf: "center" }}>
                    Accounts activate at launch — book now and your dashboard will be ready
                    with this email.
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

  const [nextBooking, bookings, home, billing, support] = await Promise.all([
    getNextBooking(customer.id),
    getCustomerBookings(customer.id),
    getPrimaryHome(customer.id),
    getBillingRecords(customer.id),
    getSupportThread(customer.id),
  ]);

  const recurring = bookings.find((b) => b.frequency !== "onetime");

  return (
    <div className="route-page">
      <div className="container page-hero">
        <div className="page-panel">
          <span className="eyebrow">
            {identity.state === "preview" ? "Preview mode — dev data" : "Customer dashboard"}
          </span>
          <h1>Welcome back{customer.full_name ? `, ${customer.full_name.split(" ")[0]}` : ""}.</h1>
          <p className="lead">
            Manage upcoming cleans, home notes, invoices, support, referral credit, and your
            recurring plan.
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
                    <span className="eyebrow">Next clean</span>
                    <b>
                      {nextBooking
                        ? formatLongDate(nextBooking.scheduled_date).replace(/^[^,]+, /, "")
                        : "—"}
                    </b>
                    <p className="copy">
                      {nextBooking ? `${nextBooking.scheduled_window} arrival` : "Nothing scheduled"}
                    </p>
                  </div>
                  <div className="dash-metric card">
                    <span className="eyebrow">Plan</span>
                    <b>{recurring ? formatDollars(recurring.estimate_cents ?? 0) : "—"}</b>
                    <p className="copy">
                      {recurring ? `${recurring.frequency} reset` : "No recurring plan yet"}
                    </p>
                  </div>
                  <div className="dash-metric card">
                    <span className="eyebrow">Credit</span>
                    <b>{formatDollars(customer.referral_credit_cents)}</b>
                    <p className="copy">Referral balance</p>
                  </div>
                  <div className="dash-metric card">
                    <span className="eyebrow">Status</span>
                    <b>Active</b>
                    <p className="copy">Good standing</p>
                  </div>
                </div>
                <div className="timeline">
                  {nextBooking && (
                    <div className="timeline-row card">
                      <span className="timeline-dot" />
                      <div>
                        <h3>Upcoming {nextBooking.service_title}</h3>
                        <p className="copy">
                          {formatLongDate(nextBooking.scheduled_date)} · {nextBooking.scheduled_window}{" "}
                          arrival · <StatusBadge status={nextBooking.status} />
                        </p>
                        <form action={rescheduleAction} style={{ marginTop: 12 }}>
                          <input type="hidden" name="bookingId" value={nextBooking.id} />
                          <button className="btn btn-primary">Request reschedule</button>
                        </form>
                      </div>
                    </div>
                  )}
                  {home?.cleaner_notes && (
                    <div className="timeline-row card">
                      <span className="timeline-dot" />
                      <div>
                        <h3>Cleaner notes</h3>
                        <p className="copy">{home.cleaner_notes}</p>
                      </div>
                    </div>
                  )}
                  {!nextBooking && (
                    <div className="timeline-row card">
                      <span className="timeline-dot" />
                      <div>
                        <h3>No clean on the calendar</h3>
                        <p className="copy">Lock a same-week window in about two minutes.</p>
                        <Link className="btn btn-primary" style={{ marginTop: 12 }} href="/book">
                          Book a clean
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
                      <p className="copy">Your visits will appear here with live status.</p>
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
                        {booking.service_title} · {booking.scheduled_window} ·{" "}
                        {booking.estimate_cents ? `${formatDollars(booking.estimate_cents)} anchor` : "quoted"}
                        {booking.addon_ids.length > 0 && ` · add-ons: ${booking.addon_ids.join(", ")}`}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === "notes" && (
              <div className="card" style={{ padding: 28 }}>
                <h2>Home preferences</h2>
                <p className="copy">
                  Durable preferences so the cleaning feels personal every time.
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
                    <form action={saveNotesAction}>
                      <input type="hidden" name="homeId" value={home.id} />
                      <div className="field">
                        <label htmlFor="notes">Cleaner notes</label>
                        <textarea id="notes" name="notes" defaultValue={home.cleaner_notes ?? ""} />
                      </div>
                      <button className="btn btn-primary" style={{ marginTop: 14 }}>
                        Save preferences
                      </button>
                    </form>
                  </>
                ) : (
                  <p className="copy" style={{ marginTop: 14 }}>
                    Your home profile is created with your first booking.
                  </p>
                )}
              </div>
            )}

            {tab === "billing" && (
              <div className="timeline">
                {billing.length === 0 && (
                  <div className="timeline-row card">
                    <span className="timeline-dot" />
                    <div>
                      <h3>No invoices yet</h3>
                      <p className="copy">Receipts and invoices appear here after each visit.</p>
                    </div>
                  </div>
                )}
                {billing.map((record) => (
                  <div key={record.id} className="timeline-row card">
                    <span className="timeline-dot" />
                    <div>
                      <h3>
                        {new Date(record.occurred_at).toLocaleDateString("en-US", {
                          month: "long",
                          day: "numeric",
                        })}{" "}
                        · {formatDollars(record.amount_cents)} · <StatusBadge status={record.status} />
                      </h3>
                      <p className="copy">{record.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === "support" && (
              <div className="card" style={{ padding: 28 }}>
                <h2>Support thread</h2>
                <div style={{ display: "grid", gap: 10, margin: "18px 0" }}>
                  {support.length === 0 && (
                    <div className="msg bot">
                      Need help adding an add-on or moving your date? Send a message — a real
                      person replies.
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
                <form action={supportMessageAction} className="chat-input" style={{ padding: 0, border: 0 }}>
                  <input name="body" placeholder="Message support..." required />
                  <button className="btn btn-primary">Send</button>
                </form>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
