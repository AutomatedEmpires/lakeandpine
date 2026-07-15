import type { Metadata } from "next";
import Link from "next/link";

import { resolveCleanerIdentity } from "@/lib/auth";
import { getCleanerAvailability, getCleanerTimeOff, getCrewAssignments } from "@/lib/crew-data";
import { getCrewTeamOperations } from "@/lib/team-operations-data";

import {
  assignmentResponseAction,
  cleanerCalloutAction,
  cleanerInventoryUsageAction,
  cleanerRestockRequestAction,
  startTimeEntryAction,
  stopTimeEntryAction,
  timeOffRequestAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Crew Workspace",
  robots: { index: false, follow: false },
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDateTime(value: string, timeZone: string) {
  return new Date(value).toLocaleString("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function CrewPage() {
  const identity = await resolveCleanerIdentity();
  if (identity.state !== "authed" && identity.state !== "preview") {
    return (
      <div className="route-page">
        <section className="container page-hero">
          <div className="page-panel operator-locked">
            <span className="eyebrow">Private crew workspace</span>
            <h1>{identity.state === "denied" ? "This account is not assigned to an active cleaner record." : "Cleaner sign-in is required."}</h1>
            <p className="lead">Schedules, assignments, availability, and time-off requests are private operating information.</p>
            <Link className="btn btn-primary" href="/sign-in?redirect_url=/crew">Sign in</Link>
          </div>
        </section>
      </div>
    );
  }

  const cleaner = identity.cleaner;
  const [assignments, availability, timeOff, teamOperations] = await Promise.all([
    getCrewAssignments(cleaner.id, identity.devOnly),
    getCleanerAvailability(cleaner.id),
    getCleanerTimeOff(cleaner.id),
    getCrewTeamOperations(cleaner.id, identity.devOnly),
  ]);

  return (
    <div className="route-page operator-page">
      <section className="container page-hero">
        {identity.state === "preview" && <div className="preview-banner"><strong>Cleaner preview:</strong> only synthetic assignments are visible and write actions are restricted.</div>}
        <div className="operator-hero">
          <div>
            <span className="eyebrow">Crew workspace</span>
            <h1>{cleaner.full_name}</h1>
            <p className="lead">Review assignments, protect availability, and see the skills and territory attached to your operating profile.</p>
          </div>
          <div className="card operator-summary"><span>Status</span><strong>{cleaner.status}</strong><span>Home territory</span><strong>{cleaner.home_territory_name ?? "Not assigned"}</strong></div>
        </div>
      </section>

      <section className="container section operator-section">
        <div className="crew-dashboard-grid">
          <article className="card operator-panel">
            <span className="eyebrow">Upcoming assignments</span>
            <h2>Qualified work in your queue</h2>
            <div className="crew-assignment-list">
              {assignments.map((assignment) => (
                <article key={assignment.id}>
                  <div><strong>{assignment.service_vertical}</strong><span className={`status-badge ${assignment.assignment_status}`}>{assignment.assignment_status}</span></div>
                  <p>{formatDateTime(assignment.start_at, assignment.territory_timezone)} → {formatDateTime(assignment.end_at, assignment.territory_timezone)}</p>
                  <p>{assignment.territory_name} · {assignment.assignment_role}</p>
                  {assignment.required_skills.length > 0 && <small>Skills: {assignment.required_skills.join(", ")}</small>}
                  {assignment.planning_direction && <small>Plan: {assignment.planning_direction}</small>}
                  {assignment.assignment_status === "proposed" && (
                    <form action={assignmentResponseAction} className="assignment-actions">
                      <input type="hidden" name="assignmentId" value={assignment.id} />
                      <button className="btn btn-soft" name="response" value="declined">Decline</button>
                      <button className="btn btn-primary" name="response" value="accepted">Accept</button>
                    </form>
                  )}
                </article>
              ))}
              {assignments.length === 0 && <p className="copy">No current assignments. An empty queue is not an availability promise.</p>}
            </div>
          </article>

          <aside className="operator-detail-stack">
            <article className="card operator-panel">
              <span className="eyebrow">Profile</span>
              <h2>Capacity + experience</h2>
              <div className="job-facts">
                <div><span>Programs</span><strong>{cleaner.vertical_experience.join(", ") || "Not recorded"}</strong></div>
                <div><span>Skills</span><strong>{cleaner.skills.join(", ") || "Not recorded"}</strong></div>
                <div><span>Daily cap</span><strong>{cleaner.max_daily_minutes / 60} hours</strong></div>
                <div><span>Weekly cap</span><strong>{cleaner.max_weekly_minutes / 60} hours</strong></div>
              </div>
            </article>

            <article className="card operator-panel">
              <span className="eyebrow">Recurring availability</span>
              <h2>Working windows</h2>
              <div className="availability-list">
                {availability.map((rule) => <div key={rule.id}><strong>{DAY_NAMES[rule.day_of_week]}</strong><span>{rule.start_time.slice(0, 5)}–{rule.end_time.slice(0, 5)} · {rule.territory_name ?? "Any assigned territory"}</span></div>)}
                {availability.length === 0 && <p className="copy">No active availability rules are recorded.</p>}
              </div>
            </article>

            <article className="card operator-panel">
              <span className="eyebrow">Time away</span>
              <h2>Requests + decisions</h2>
              <div className="availability-list">
                {timeOff.map((item) => <div key={item.id}><strong>{item.status}</strong><span>{formatDateTime(item.start_at, identity.cleaner.home_territory_timezone ?? "America/Los_Angeles")} → {formatDateTime(item.end_at, identity.cleaner.home_territory_timezone ?? "America/Los_Angeles")} · {item.reason_category}</span></div>)}
              </div>
              <form action={timeOffRequestAction} className="time-off-form">
                <p className="copy">Enter local time in {identity.cleaner.home_territory_timezone ?? "your assigned territory"}. Daylight-saving gaps and repeated times are rejected.</p>
                <div className="field"><label htmlFor="time-off-team">Team</label><select id="time-off-team" name="membershipId" required disabled={identity.devOnly || teamOperations.memberships.length === 0}>{teamOperations.memberships.map((membership) => <option key={membership.id} value={membership.id}>{membership.team_name}</option>)}</select></div>
                <div className="field"><label htmlFor="time-off-start">Start</label><input id="time-off-start" name="startAt" type="datetime-local" required disabled={identity.devOnly} /></div>
                <div className="field"><label htmlFor="time-off-end">End</label><input id="time-off-end" name="endAt" type="datetime-local" required disabled={identity.devOnly} /></div>
                <div className="field"><label htmlFor="time-off-reason">Category</label><select id="time-off-reason" name="reasonCategory" disabled={identity.devOnly}><option value="unavailable">Unavailable</option><option value="personal">Personal</option><option value="medical">Medical</option><option value="training">Training</option><option value="other">Other</option></select></div>
                <button className="btn btn-primary" disabled={identity.devOnly || teamOperations.memberships.length === 0}>Request time off</button>
              </form>
            </article>
          </aside>
        </div>

        <div className="crew-operations-stack">
          {teamOperations.restocks.length > 0 && (
            <article className="card operator-panel">
              <span className="eyebrow">Restock tracking</span>
              <h2>Your supply requests</h2>
              <div className="availability-list">
                {teamOperations.restocks.map((request) => (
                  <div key={request.id}>
                    <strong>{request.product_name} · {request.status.replaceAll("_", " ")}</strong>
                    <span>{request.quantity_requested} requested for {request.location_name}</span>
                  </div>
                ))}
              </div>
            </article>
          )}
          <article className="card operator-panel">
            <span className="eyebrow">Accountable time</span>
            <h2>Clock only against assigned team work</h2>
            <div className="crew-assignment-list">
              {teamOperations.assignments.map((assignment) => <article key={assignment.allocation_id}>
                <div><strong>{assignment.service_vertical}</strong><span>{assignment.territory_name}</span></div>
                <p>{formatDateTime(assignment.start_at, assignment.territory_timezone)}</p>
                {assignment.open_time_entry_id ? <form action={stopTimeEntryAction} className="assignment-actions"><input type="hidden" name="entryId" value={assignment.open_time_entry_id} /><label>Break minutes<input name="breakMinutes" type="number" min="0" max="720" defaultValue="0" /></label><button className="btn btn-primary" disabled={identity.devOnly}>Stop + submit time</button></form> : <form action={startTimeEntryAction}><input type="hidden" name="allocationId" value={assignment.allocation_id} /><button className="btn btn-primary" disabled={identity.devOnly}>Start assigned work clock</button></form>}
              </article>)}
              {teamOperations.assignments.length === 0 && <p className="copy">No team-allocated accepted work is ready for time tracking.</p>}
            </div>
            {teamOperations.timeEntries.length > 0 && <div className="availability-list crew-time-history">{teamOperations.timeEntries.map((entry) => <div key={entry.id}><strong>{entry.status}</strong><span>{entry.actual_minutes === null ? "Open" : `${entry.actual_minutes} minutes`} · plan {entry.estimated_minutes_snapshot} minutes{entry.variance_percent === null ? "" : ` · ${entry.variance_percent > 0 ? "+" : ""}${entry.variance_percent}%`}</span></div>)}</div>}
          </article>

          {teamOperations.memberships.map((membership) => {
            const teamInventory = teamOperations.inventory.filter((item) => item.team_id === membership.team_id);
            return <article className="card operator-panel" key={membership.id}>
              <span className="eyebrow">{membership.team_name} supplies</span>
              <h2>Use + restock</h2>
              <p className="copy">Usage immediately updates this team&apos;s stock ledger. Restock requests go to this team&apos;s manager and never place an order automatically.</p>
              {teamInventory.length > 0 ? <div className="split-form-grid">
                <form action={cleanerInventoryUsageAction} className="operations-form-grid">
                  <input type="hidden" name="membershipId" value={membership.id} />
                  <label>Product<select name="inventoryKey">{teamInventory.map((item) => <option key={`${item.id}-${item.location_id}`} value={`${item.id}|${item.location_id}`}>{item.name} · {item.on_hand} {item.unit_label}</option>)}</select></label>
                  <label>Quantity used<input name="quantity" type="number" min="0.001" step="0.001" required /></label>
                  <label>Job/use note<input name="note" placeholder="Where and why it was used" /></label>
                  <button className="btn btn-primary" disabled={identity.devOnly}>Log product use</button>
                </form>
                <form action={cleanerRestockRequestAction} className="operations-form-grid">
                  <input type="hidden" name="membershipId" value={membership.id} />
                  <label>Product<select name="inventoryKey">{teamInventory.map((item) => <option key={`${item.id}-${item.location_id}`} value={`${item.id}|${item.location_id}`}>{item.name} · reorder at {item.reorder_point}</option>)}</select></label>
                  <label>Quantity requested<input name="quantity" type="number" min="0.001" step="0.001" required /></label>
                  <button className="btn btn-soft" disabled={identity.devOnly}>Request restock</button>
                </form>
              </div> : <p className="copy">This team has not published an inventory catalog yet.</p>}
              <form action={cleanerCalloutAction} className="crew-callout-form">
                <input type="hidden" name="membershipId" value={membership.id} />
                <label>Callout / urgent availability impact<textarea name="summary" required placeholder="State the affected shift or assignment and immediate impact. Do not include medical details." /></label>
                <button className="btn btn-soft" disabled={identity.devOnly}>Notify team manager</button>
              </form>
            </article>;
          })}

          <article className="card operator-panel">
            <span className="eyebrow">My recognition</span><h2>Bonus history</h2>
            <div className="availability-list">{teamOperations.bonuses.map((bonus) => <div key={bonus.id}><strong>{bonus.status}</strong><span>{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(bonus.amount_cents / 100)} · {bonus.reason}</span></div>)}{teamOperations.bonuses.length === 0 && <p className="copy">No bonus awards recorded yet.</p>}</div>
          </article>
        </div>
      </section>
    </div>
  );
}
