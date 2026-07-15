import type { Metadata } from "next";
import Link from "next/link";

import { resolveCleanerIdentity } from "@/lib/auth";
import { getCleanerAvailability, getCleanerTimeOff, getCrewAssignments } from "@/lib/crew-data";
import { getCrewFieldDashboard } from "@/lib/field-operations-data";
import { getCrewTeamOperations } from "@/lib/team-operations-data";

import {
  assignmentResponseAction,
  cleanerCalloutAction,
  cleanerChecklistAction,
  cleanerInventoryUsageAction,
  cleanerIssueAction,
  cleanerJobMessageAction,
  cleanerMileageAction,
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
  const [assignments, availability, timeOff, teamOperations, field] = await Promise.all([
    getCrewAssignments(cleaner.id, identity.devOnly),
    getCleanerAvailability(cleaner.id),
    getCleanerTimeOff(cleaner.id),
    getCrewTeamOperations(cleaner.id, identity.devOnly),
    getCrewFieldDashboard(cleaner.id, identity.devOnly),
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
          <article className="card operator-panel">
            <span className="eyebrow">Assigned job execution</span>
            <h2>Route, checklist, customer updates, mileage, and escalation.</h2>
            <p className="copy">Only your accepted assignments appear here. Customer messages and operational reports stay attached to the job for manager audit.</p>
            <div className="ops-ledger-list">
              {field.jobs.map((job) => {
                const checklist = field.checklist.filter((item) => item.team_job_allocation_id === job.team_job_allocation_id);
                const messages = field.communications.filter((message) => message.team_job_allocation_id === job.team_job_allocation_id);
                const executable = ["confirmed", "en_route", "in_progress"].includes(job.schedule_status);
                const checklistEditable = job.schedule_status === "in_progress";
                return <article key={job.team_job_allocation_id}>
                  <div className="operator-panel-head">
                    <div><span className={`status-badge ${job.schedule_status}`}>{job.schedule_status.replaceAll("_", " ")}</span><strong>{job.service_vertical} · {job.team_name}</strong><small>{formatDateTime(job.start_at, job.timezone)} → {formatDateTime(job.end_at, job.timezone)}</small></div>
                    <span>{job.route_status?.replaceAll("_", " ") ?? "route review pending"}</span>
                  </div>
                  <div className="notice-card"><strong>Service location</strong><p>{[job.street, job.unit, job.city, job.state, job.zip].filter(Boolean).join(", ")}</p>{job.arrival_window_start && <p>Approved arrival: {new Date(job.arrival_window_start).toLocaleTimeString("en-US", { timeZone: job.timezone, hour: "numeric", minute: "2-digit" })}–{new Date(job.arrival_window_end!).toLocaleTimeString("en-US", { timeZone: job.timezone, hour: "numeric", minute: "2-digit" })}</p>}</div>

                  <div className="operator-checklist">
                    {checklist.map((item) => checklistEditable ? <form action={cleanerChecklistAction} key={item.id} className={item.state === "completed" ? "complete" : ""}>
                      <input type="hidden" name="allocationId" value={job.team_job_allocation_id} /><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="version" value={item.version} />
                      <label><span>{item.room_label ?? "Whole scope"}</span><strong>{item.label}</strong><select name="state" defaultValue={item.state} disabled={identity.devOnly}><option value="pending">Pending</option><option value="completed">Completed</option><option value="skipped">Skipped with note</option></select><input name="note" defaultValue={item.completion_note ?? ""} maxLength={1000} placeholder="Completion or exception note" /></label>
                      <button className="btn btn-soft" disabled={identity.devOnly}>Save step</button>
                    </form> : <div key={item.id} className={item.state === "completed" ? "complete" : ""}><span>{item.room_label ?? "Whole scope"}</span><strong>{item.label}</strong><p>{item.state.replaceAll("_", " ")}{item.completion_note ? ` · ${item.completion_note}` : ""}</p></div>)}
                  </div>

                  <div className="split-form-grid">
                    {executable ? <form action={cleanerJobMessageAction} className="operations-form-grid">
                      <input type="hidden" name="allocationId" value={job.team_job_allocation_id} />
                      <label>Customer update<select name="template" defaultValue="custom"><option value="custom">Custom job update</option><option value="running_15_late">Running about 15 minutes late</option><option value="running_30_late">Running about 30 minutes late</option></select></label>
                      <label>Custom message<textarea name="body" maxLength={2000} placeholder="Used only for a custom update. Do not include private manager notes." /></label>
                      <button className="btn btn-primary" disabled={identity.devOnly}>Record + send in app</button>
                    </form> : <div className="notice-card"><strong>Customer updates closed</strong><p>This visit is in quality review; its checklist and execution messages are now read-only evidence.</p></div>}
                    <form action={cleanerMileageAction} className="operations-form-grid">
                      <input type="hidden" name="membershipId" value={job.membership_id} /><input type="hidden" name="allocationId" value={job.team_job_allocation_id} />
                      <label>Service date<input name="serviceDate" type="date" required /></label>
                      <label>Miles<input name="miles" type="number" min="0.01" max="1000" step="0.01" required /></label>
                      <label>Purpose<select name="purpose"><option value="to_job">To job</option><option value="between_jobs">Between jobs</option><option value="supply_run">Supply run</option><option value="training">Training</option><option value="other">Other</option></select></label>
                      <label>Vehicle<input name="vehicleLabel" maxLength={120} placeholder="Personal or company vehicle label" /></label>
                      <label>Note<input name="note" maxLength={1000} /></label>
                      <button className="btn btn-soft" disabled={identity.devOnly}>Submit mileage</button>
                    </form>
                  </div>

                  <form action={cleanerIssueAction} className="operations-form-grid">
                    <input type="hidden" name="membershipId" value={job.membership_id} /><input type="hidden" name="allocationId" value={job.team_job_allocation_id} />
                    <label>Escalation type<select name="issueType"><option value="schedule_conflict">Schedule conflict</option><option value="access">Access problem</option><option value="safety">Safety issue</option><option value="vehicle">Vehicle issue</option><option value="customer_note">Customer note</option><option value="scope">Scope exception</option><option value="inventory">Low stock / supply issue</option><option value="quality">Quality concern</option><option value="other">Other</option></select></label>
                    <label>Severity<select name="severity"><option value="medium">Medium</option><option value="low">Low</option><option value="high">High</option><option value="critical">Critical</option></select></label>
                    <label>Summary<textarea name="summary" required maxLength={1000} placeholder="What happened and what immediate help is needed?" /></label>
                    <label>Private manager detail<textarea name="privateDetails" maxLength={4000} /></label>
                    <p className="copy">This begins as a manager-private escalation. An authorized manager may deliberately share the summary with the customer; private detail is never shared.</p>
                    <button className="btn btn-primary" disabled={identity.devOnly}>Escalate to team</button>
                  </form>

                  {messages.length > 0 && <div className="internal-note-list">{messages.map((message) => <article key={message.id}><div><strong>{message.sender_kind}</strong><span>{new Date(message.created_at).toLocaleString()}</span></div><p>{message.body}</p></article>)}</div>}
                </article>;
              })}
              {field.jobs.length === 0 && <p className="copy">No accepted, confirmed field work is ready.</p>}
            </div>
          </article>

          {field.duty.length > 0 && <article className="card operator-panel"><span className="eyebrow">Escalation coverage</span><h2>Manager or lead on duty</h2><div className="availability-list">{field.duty.map((duty) => <div key={duty.id}><strong>{duty.display_name} · {duty.duty_kind.replaceAll("_", " ")}</strong><span>{new Date(duty.starts_at).toLocaleString()} → {new Date(duty.ends_at).toLocaleString()}</span></div>)}</div></article>}

          {(field.mileage.length > 0 || field.issues.length > 0) && <article className="card operator-panel"><span className="eyebrow">My field history</span><h2>Mileage + escalations</h2><div className="availability-list">{field.mileage.map((entry) => <div key={entry.id}><strong>{entry.miles} miles · {entry.status}</strong><span>{entry.service_date} · {entry.purpose.replaceAll("_", " ")}</span></div>)}{field.issues.map((issue) => <div key={issue.id}><strong>{issue.issue_type.replaceAll("_", " ")} · {issue.status}</strong><span>{issue.severity} · {issue.summary}</span></div>)}</div></article>}

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
                {assignment.open_time_entry_id ? <form action={stopTimeEntryAction} className="assignment-actions"><input type="hidden" name="entryId" value={assignment.open_time_entry_id} /><label>Break minutes<input name="breakMinutes" type="number" min="0" max="720" defaultValue="0" /></label><button className="btn btn-primary" disabled={identity.devOnly}>Stop + submit time</button></form> : <form action={startTimeEntryAction}><input type="hidden" name="allocationId" value={assignment.allocation_id} /><button className="btn btn-primary" disabled={identity.devOnly || !assignment.clock_in_available}>Start assigned work clock</button>{!assignment.clock_in_available && <small>Clock-in opens at the approved arrival window minus the job travel buffer. It closes 12 hours after the planned finish.</small>}</form>}
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
