import type { Metadata } from "next";
import Link from "next/link";

import { resolveCleanerIdentity } from "@/lib/auth";
import { getCleanerAvailability, getCleanerTimeOff, getCrewAssignments } from "@/lib/crew-data";

import { assignmentResponseAction, timeOffRequestAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Crew Workspace",
  robots: { index: false, follow: false },
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
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
  const [assignments, availability, timeOff] = await Promise.all([
    getCrewAssignments(cleaner.id, identity.devOnly),
    getCleanerAvailability(cleaner.id),
    getCleanerTimeOff(cleaner.id),
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
                  <p>{formatDateTime(assignment.start_at)} → {formatDateTime(assignment.end_at)}</p>
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
                {timeOff.map((item) => <div key={item.id}><strong>{item.status}</strong><span>{formatDateTime(item.start_at)} → {formatDateTime(item.end_at)} · {item.reason_category}</span></div>)}
              </div>
              <form action={timeOffRequestAction} className="time-off-form">
                <div className="field"><label htmlFor="time-off-start">Start</label><input id="time-off-start" name="startAt" type="datetime-local" required disabled={identity.devOnly} /></div>
                <div className="field"><label htmlFor="time-off-end">End</label><input id="time-off-end" name="endAt" type="datetime-local" required disabled={identity.devOnly} /></div>
                <div className="field"><label htmlFor="time-off-reason">Category</label><select id="time-off-reason" name="reasonCategory" disabled={identity.devOnly}><option value="unavailable">Unavailable</option><option value="personal">Personal</option><option value="medical">Medical</option><option value="training">Training</option><option value="other">Other</option></select></div>
                <button className="btn btn-primary" disabled={identity.devOnly}>Request time off</button>
              </form>
            </article>
          </aside>
        </div>
      </section>
    </div>
  );
}
