import type { Metadata } from "next";

import { OperatorDenied, OwnerBootstrap } from "@/components/OperatorAccessState";
import { OperatorTeamNav } from "@/components/OperatorTeamNav";
import { resolveOperatorIdentity } from "@/lib/auth";
import { effectiveRoleForTeam, hasCapability } from "@/lib/team-operations";
import { getOperationsDashboard } from "@/lib/team-operations-data";

import { createWorkforceEventAction, reviewTeamTimeOffAction } from "../team-operations-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Team workforce", robots: { index: false, follow: false } };

export default async function WorkforcePage({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const identity = await resolveOperatorIdentity();
  if (identity.state !== "authed" && identity.state !== "preview") return <OperatorDenied identity={identity} />;
  const params = await searchParams;
  const dashboard = await getOperationsDashboard({ customerId: identity.operator.id, devOnly: identity.devOnly, requestedTeamId: params.team });
  if (!dashboard.access.organizationId) return <OwnerBootstrap dashboard={dashboard} />;
  const canManage = dashboard.selectedTeamId ? hasCapability(dashboard.access.memberships, "manage_workforce_events", dashboard.access.organizationId, dashboard.selectedTeamId) : false;
  const canReviewTime = dashboard.selectedTeamId ? hasCapability(dashboard.access.memberships, "review_time", dashboard.access.organizationId, dashboard.selectedTeamId) : false;
  const actorRole = dashboard.selectedTeamId
    ? effectiveRoleForTeam(dashboard.access.memberships, dashboard.access.organizationId, dashboard.selectedTeamId)
    : null;
  const eventMembers = actorRole === "manager"
    ? dashboard.members.filter((member) => ["shift_lead", "cleaner"].includes(member.role))
    : actorRole === "shift_lead"
      ? dashboard.members.filter((member) => ["shift_lead", "cleaner"].includes(member.role))
      : dashboard.members;
  const eventTypes = actorRole === "shift_lead"
    ? [["callout", "Callout"], ["late", "Late"], ["no_show", "No-show"], ["safety", "Safety"], ["recognition", "Recognition"], ["other", "Other"]]
    : [["callout", "Callout"], ["late", "Late"], ["no_show", "No-show"], ["strike", "Policy strike"], ["attendance_warning", "Attendance warning"], ["performance_coaching", "Performance coaching"], ["final_warning", "Final warning"], ["suspension", "Suspension"], ["termination", "Termination record"], ["recognition", "Recognition"], ["safety", "Safety"], ["other", "Other"]];

  return <div className="route-page operator-page">
    <section className="container page-hero">
      <div className="operator-hero"><div><span className="eyebrow">Accountable people operations</span><h1>Workforce + reliability</h1><p className="lead">Hiring, callouts, coaching, recognition, leave risk, and separation stay evidence-based and team scoped. No point counter can automatically fire someone.</p></div><div className="card operator-summary"><span>Active people</span><strong>{dashboard.members.filter((member) => member.status === "active").length}</strong><span>Open events</span><strong>{dashboard.workforceEvents.filter((event) => event.status === "open").length}</strong></div></div>
      <OperatorTeamNav dashboard={dashboard} current="workforce" />
    </section>
    <section className="container section team-operations-section">
      {!dashboard.selectedTeam && <div className="card empty-operator"><h2>Select a team.</h2></div>}
      {dashboard.selectedTeam && <div className="operations-grid">
        <article className="card operator-panel">
          <span className="eyebrow">Team roster</span><h2>{dashboard.selectedTeam.name}</h2>
          <div className="ops-ledger-list">
            {dashboard.members.map((member) => <article key={member.id}><div><span className={`status-badge ${member.status}`}>{member.status}</span><strong>{member.display_name}</strong><small>{member.role.replaceAll("_", " ")}{member.title ? ` · ${member.title}` : ""}</small></div></article>)}
            {dashboard.members.length === 0 && <p className="copy">No one has been assigned to this team. Owner/GM access remains organization-wide.</p>}
          </div>
        </article>
        <div className="operator-detail-stack">
          {canManage && eventMembers.length > 0 && <article className="card operator-panel">
            <span className="eyebrow">Evidence, not automation</span><h2>Record a workforce event</h2>
            <form action={createWorkforceEventAction} className="operations-form-grid">
              <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
              <label>Team member<select name="membershipId">{eventMembers.map((member) => <option key={member.id} value={member.id}>{member.display_name} · {member.role}</option>)}</select></label>
              <label>Event<select name="eventType">{eventTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label>Severity<select name="severity"><option value="info">Information</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
              <label>Evidence summary<textarea name="summary" required placeholder="What happened, when, and the immediate operating impact" /></label>
              <label>Restricted details<textarea name="privateDetails" placeholder="Manager-only context; do not add medical records or protected data" /></label>
              <button className="btn btn-primary">Record accountable event</button>
            </form>
          </article>}
          <article className="card operator-panel">
            <span className="eyebrow">Reliability + recognition ledger</span><h2>Recent events</h2>
            <div className="ops-ledger-list">
              {dashboard.workforceEvents.map((event) => <article key={event.id}><div><span className={`status-badge ${event.severity}`}>{event.severity}</span><strong>{event.subject_name} · {event.event_type.replaceAll("_", " ")}</strong><small>{new Date(event.occurred_at).toLocaleString()} · {event.status}</small><p>{event.summary}</p></div></article>)}
              {dashboard.workforceEvents.length === 0 && <p className="copy">No workforce events have been recorded for this team.</p>}
            </div>
          </article>
          <article className="card operator-panel">
            <span className="eyebrow">Team leave queue</span><h2>Time-off requests</h2>
            <div className="ops-ledger-list">
              {dashboard.timeOffRequests.map((request) => <article key={request.id}><div><span className={`status-badge ${request.status}`}>{request.status}</span><strong>{request.cleaner_name}</strong><small>{new Date(request.start_at).toLocaleString()} → {new Date(request.end_at).toLocaleString()} · {request.reason_category}</small></div>{canReviewTime && request.status === "requested" && <div className="inline-action-row"><form action={reviewTeamTimeOffAction}><input type="hidden" name="teamId" value={dashboard.selectedTeamId!} /><input type="hidden" name="timeOffId" value={request.id} /><button className="btn btn-soft" name="to" value="declined">Decline</button></form><form action={reviewTeamTimeOffAction}><input type="hidden" name="teamId" value={dashboard.selectedTeamId!} /><input type="hidden" name="timeOffId" value={request.id} /><button className="btn btn-primary" name="to" value="approved">Approve</button></form></div>}</article>)}
              {dashboard.timeOffRequests.length === 0 && <p className="copy">No current team time-off requests.</p>}
            </div>
          </article>
        </div>
      </div>}
    </section>
  </div>;
}
