import type { Metadata } from "next";
import Link from "next/link";

import { resolveOperatorIdentity } from "@/lib/auth";
import {
  getBookingChecklist,
  getBookingFollowUps,
  getBookingInternalNotes,
  getOperatorBookings,
  type OperatorBooking,
} from "@/lib/data";
import { formatDollars } from "@/lib/pricing";
import { formatLongDate } from "@/lib/scheduling";
import { COMMUNICATION_PLAN, type JobStatus } from "@/lib/service-planning";

import {
  addInternalNoteAction,
  checklistItemAction,
  completeFollowUpAction,
  updateJobStatusAction,
} from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Operator workspace",
  robots: { index: false, follow: false },
};

const PIPELINE = [
  { id: "intake", label: "Intake", statuses: ["requested", "reviewing"] },
  { id: "ready", label: "Plan ready", statuses: ["ready", "confirmed"] },
  { id: "scheduled", label: "Scheduled", statuses: ["scheduled"] },
  { id: "active", label: "In service", statuses: ["in_progress"] },
  { id: "followup", label: "Complete + follow-up", statuses: ["completed", "follow_up"] },
] as const;

const NEXT_ACTIONS: Partial<Record<JobStatus, { status: JobStatus; label: string }[]>> = {
  requested: [{ status: "reviewing", label: "Start scope review" }],
  reviewing: [{ status: "ready", label: "Mark plan ready" }, { status: "requested", label: "Return to intake" }],
  ready: [{ status: "confirmed", label: "Confirm with customer" }, { status: "reviewing", label: "Revise plan" }],
  confirmed: [{ status: "scheduled", label: "Place on schedule" }],
  scheduled: [{ status: "in_progress", label: "Start service" }],
  in_progress: [{ status: "completed", label: "Complete service" }],
  completed: [{ status: "follow_up", label: "Move to follow-up" }],
};

function privateLabel(booking: OperatorBooking) {
  const name = booking.contact.name?.trim();
  if (!name) return "Unnamed request";
  const parts = name.split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)?.[0]}.` : parts[0];
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

export default async function OperatorPage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const identity = await resolveOperatorIdentity();
  if (identity.state !== "authed" && identity.state !== "preview") {
    return (
      <div className="route-page">
        <div className="container page-hero">
          <div className="page-panel operator-locked">
            <span className="eyebrow">Private operator workspace</span>
            <h1>{identity.state === "denied" ? "This account is not an operator." : "Operator sign-in required."}</h1>
            <p className="lead">Customer requests and home notes stay behind staff authorization. Preview access is available only in non-production with seeded demo data.</p>
            <Link className="btn btn-soft" href="/">Return home</Link>
          </div>
        </div>
      </div>
    );
  }

  const bookings = await getOperatorBookings(identity.devOnly);
  const params = await searchParams;
  const selected =
    bookings.find((booking) => booking.id === params.job) ??
    bookings.find((booking) => ["requested", "reviewing"].includes(booking.status)) ??
    bookings[0] ??
    null;
  const [checklist, notes, followUps] = selected
    ? await Promise.all([
        getBookingChecklist(selected.id, identity.devOnly),
        getBookingInternalNotes(selected.id, identity.devOnly),
        getBookingFollowUps(selected.id, identity.devOnly),
      ])
    : [[], [], []];
  const completedChecklist = checklist.filter((item) => item.state === "completed").length;

  return (
    <div className="route-page operator-page">
      <div className="container page-hero">
        <div className="operator-hero">
          <div>
            <span className="eyebrow">{identity.state === "preview" ? "Demo operations · seeded records only" : "Private operations"}</span>
            <h1>Service desk</h1>
            <p className="lead">Review scope, move work through the pipeline, run the checklist, and stage human follow-up without sending messages automatically.</p>
          </div>
          <div className="operator-summary card">
            <span>Open work</span><strong>{bookings.length}</strong>
            <span>Needs review</span><strong>{bookings.filter((booking) => ["requested", "reviewing"].includes(booking.status)).length}</strong>
          </div>
        </div>
      </div>

      <section className="section operator-section">
        <div className="container">
          <div className="pipeline-board">
            {PIPELINE.map((column) => {
              const jobs = bookings.filter((booking) => (column.statuses as readonly string[]).includes(booking.status));
              return <div className="pipeline-column" key={column.id}>
                <div className="pipeline-column-head"><strong>{column.label}</strong><span>{jobs.length}</span></div>
                <div className="pipeline-stack">
                  {jobs.map((booking) => <Link key={booking.id} href={`/operator?job=${booking.id}`} className={`pipeline-card card${selected?.id === booking.id ? " selected" : ""}`}>
                    <div><span className={`status-badge ${booking.status}`}>{statusLabel(booking.status)}</span><small>{booking.scheduled_date}</small></div>
                    <strong>{privateLabel(booking)}</strong>
                    <p>{booking.service_title} · {booking.property_profile?.propertyType ?? "property"}</p>
                    <div className="pipeline-score"><span>Plan score</span><b>{booking.planning_score ?? "—"}</b></div>
                  </Link>)}
                  {jobs.length === 0 && <div className="pipeline-empty">No work here</div>}
                </div>
              </div>;
            })}
          </div>

          {!selected ? <div className="card empty-operator"><h2>No demo requests yet.</h2><p className="copy">Run the dev seed after applying the Phase 1 migration to preview the pipeline.</p></div> : (
            <div className="operator-workbench">
              <aside className="card job-brief">
                <span className="eyebrow">Selected job</span>
                <h2>{privateLabel(selected)}</h2>
                <p className="job-reference">#{selected.id.slice(0, 8)} · {selected.contact.zip ?? "ZIP not set"}</p>
                <div className="job-facts">
                  <div><span>Service</span><strong>{selected.service_title}</strong></div>
                  <div><span>Preference</span><strong>{formatLongDate(selected.scheduled_date)} · {selected.scheduled_window}</strong></div>
                  <div><span>Estimate</span><strong>{selected.estimate_cents ? `${formatDollars(selected.estimate_cents)}+` : "Review needed"}</strong></div>
                  <div><span>Planning</span><strong>{selected.planning_direction ?? "Not scored"}</strong></div>
                </div>
                <div className="operator-contact">
                  <span className="eyebrow">Private contact</span>
                  <p>{selected.contact.email ?? "No email"}<br />{selected.contact.phone ?? "No phone"}</p>
                </div>
                <div className="job-actions">
                  {(NEXT_ACTIONS[selected.status as JobStatus] ?? []).map((action) => <form key={action.status} action={updateJobStatusAction}>
                    <input type="hidden" name="bookingId" value={selected.id} />
                    <input type="hidden" name="from" value={selected.status} />
                    <input type="hidden" name="to" value={action.status} />
                    <button className={action.status === "requested" || action.status === "reviewing" ? "btn btn-soft" : "btn btn-primary"}>{action.label}</button>
                  </form>)}
                </div>
              </aside>

              <div className="operator-detail-stack">
                <section className="card operator-panel">
                  <div className="operator-panel-head"><div><span className="eyebrow">Property + scope</span><h2>Plan brief</h2></div><span className="status-badge">score {selected.planning_score ?? "—"}</span></div>
                  <div className="property-facts">
                    {Object.entries(selected.property_profile ?? {}).map(([key, value]) => <div key={key}><span>{statusLabel(key)}</span><strong>{String(value).replaceAll("_", " ")}</strong></div>)}
                  </div>
                  <div className="room-briefs">{selected.room_plan.filter((room) => room.selected).map((room) => <article key={room.id}><strong>{room.label}</strong><p>{room.note || "Standard room scope"}</p></article>)}</div>
                  {(selected.cleaning_preferences.length > 0 || selected.pet_notes || selected.access_notes || selected.special_instructions) && <div className="operator-notice-grid">
                    <div><span>Preferences</span><p>{selected.cleaning_preferences.join(" · ") || "None noted"}</p></div>
                    <div><span>Pets</span><p>{selected.pet_notes || "No pet note"}</p></div>
                    <div><span>Access</span><p>{selected.access_notes || "Coordinate after review"}</p></div>
                    <div><span>Special instructions</span><p>{selected.special_instructions || "None noted"}</p></div>
                  </div>}
                </section>

                <section className="card operator-panel">
                  <div className="operator-panel-head"><div><span className="eyebrow">Service checklist</span><h2>{completedChecklist} of {checklist.length} complete</h2></div><span>{checklist.length ? Math.round((completedChecklist / checklist.length) * 100) : 0}%</span></div>
                  <div className="checklist-progress"><span style={{ width: `${checklist.length ? (completedChecklist / checklist.length) * 100 : 0}%` }} /></div>
                  <div className="operator-checklist">{checklist.map((item) => <form action={checklistItemAction} key={item.id} className={item.state === "completed" ? "complete" : ""}>
                    <input type="hidden" name="bookingId" value={selected.id} /><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="state" value={item.state === "completed" ? "pending" : "completed"} />
                    <button aria-label={item.state === "completed" ? "Mark pending" : "Mark complete"}>{item.state === "completed" ? "✓" : ""}</button>
                    <div><span>{item.room_label ?? "Whole home"}</span><strong>{item.label}</strong></div>
                  </form>)}</div>
                </section>

                <section className="card operator-panel">
                  <span className="eyebrow">Private operator notes</span><h2>Keep context with the job.</h2>
                  <form action={addInternalNoteAction} className="operator-note-form"><input type="hidden" name="bookingId" value={selected.id} /><textarea name="body" required placeholder="Scope question, customer preference, handoff, or service observation…" /><button className="btn btn-primary">Add internal note</button></form>
                  <div className="internal-note-list">{notes.map((note) => <article key={note.id}><div><strong>{note.author_label}</strong><span>{new Date(note.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></div><p>{note.body}</p></article>)}{notes.length === 0 && <p className="copy">No internal notes yet.</p>}</div>
                </section>

                <section className="card operator-panel">
                  <span className="eyebrow">Customer communication</span><h2>Planned, human, and status-aware.</h2>
                  <div className="communication-plan">{COMMUNICATION_PLAN.map((item) => <article key={item.stage}><span>{item.timing}</span><strong>{item.stage}</strong><p>{item.owner} · {item.channel}</p></article>)}</div>
                  {followUps.length > 0 && <div className="follow-up-queue"><h3>Follow-up queue</h3>{followUps.map((followUp) => <div key={followUp.id}><div><span className={`status-badge ${followUp.status}`}>{followUp.status}</span><strong>{statusLabel(followUp.kind)}</strong><small>{followUp.scheduled_for ? new Date(followUp.scheduled_for).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric" }) : "Not scheduled"}</small></div>{followUp.status !== "completed" && <form action={completeFollowUpAction}><input type="hidden" name="bookingId" value={selected.id} /><input type="hidden" name="followUpId" value={followUp.id} /><button className="btn btn-soft">Mark manually complete</button></form>}</div>)}</div>}
                </section>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
