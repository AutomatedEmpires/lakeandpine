import type { Metadata } from "next";
import Link from "next/link";

import { OperatorDenied, OwnerBootstrap } from "@/components/OperatorAccessState";
import { OperatorTeamNav } from "@/components/OperatorTeamNav";
import { resolveOperatorIdentity } from "@/lib/auth";
import { hasCapability } from "@/lib/team-operations";
import {
  getOperationsDashboard,
  getScopedTeamScheduleSuggestions,
} from "@/lib/team-operations-data";

import {
  allocateScheduleAction,
  proposeTeamScheduleCandidateAction,
  teamScheduleStatusAction,
} from "../team-operations-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Team scheduling", robots: { index: false, follow: false } };

const NEXT: Record<string, Array<{ to: string; label: string }>> = {
  tentative: [{ to: "held", label: "Hold plan" }, { to: "canceled", label: "Cancel" }],
  held: [{ to: "confirmed", label: "Confirm capacity-backed schedule" }, { to: "tentative", label: "Return to planning" }, { to: "canceled", label: "Cancel" }],
  confirmed: [{ to: "en_route", label: "Crew en route" }, { to: "held", label: "Return to hold" }, { to: "canceled", label: "Cancel" }],
  en_route: [{ to: "in_progress", label: "Start service" }, { to: "confirmed", label: "Return to confirmed" }],
  in_progress: [{ to: "quality_review", label: "Move to quality review" }],
  quality_review: [{ to: "completed", label: "Complete after review" }, { to: "in_progress", label: "Return to service" }],
};

function formatScheduleTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(value));
}

export default async function TeamSchedulePage({ searchParams }: { searchParams: Promise<{ team?: string; schedule?: string }> }) {
  const identity = await resolveOperatorIdentity();
  if (identity.state !== "authed" && identity.state !== "preview") return <OperatorDenied identity={identity} />;
  const params = await searchParams;
  const dashboard = await getOperationsDashboard({ customerId: identity.operator.id, devOnly: identity.devOnly, requestedTeamId: params.team });
  if (!dashboard.access.organizationId) return <OwnerBootstrap dashboard={dashboard} />;
  const selected = dashboard.teamSchedules.find((schedule) => schedule.id === params.schedule)
    ?? dashboard.teamSchedules.find((schedule) => !["completed", "canceled"].includes(schedule.status))
    ?? dashboard.teamSchedules[0]
    ?? null;
  const suggestions = selected && dashboard.selectedTeamId
    ? await getScopedTeamScheduleSuggestions({ customerId: identity.operator.id, devOnly: identity.devOnly, teamId: dashboard.selectedTeamId, scheduleId: selected.id })
    : [];
  const canAllocate = dashboard.selectedTeamId !== null && hasCapability(
    dashboard.access.memberships,
    "allocate_jobs",
    dashboard.access.organizationId,
    dashboard.selectedTeamId,
  );

  return <div className="route-page operator-page">
    <section className="container page-hero">
      <div className="operator-hero"><div><span className="eyebrow">Explainable capacity planning</span><h1>Team schedule</h1><p className="lead">Recommendations account for skills, availability, time off, existing work, labor caps, travel buffers, qualifications, and the exact crew requirement.</p></div><div className="card operator-summary"><span>Allocated schedules</span><strong>{dashboard.teamSchedules.length}</strong><span>Need crew</span><strong>{dashboard.teamSchedules.filter((schedule) => schedule.assigned_cleaners.length < schedule.required_crew_size && !["completed", "canceled"].includes(schedule.status)).length}</strong></div></div>
      <OperatorTeamNav dashboard={dashboard} current="schedule" />
    </section>
    <section className="container section team-operations-section">
      {canAllocate && dashboard.selectedTeamId && (
        <article className="card operator-panel">
          <span className="eyebrow">Territory-scoped dispatch</span>
          <h2>Accept incoming work for {dashboard.selectedTeam?.name}</h2>
          {dashboard.unallocatedSchedules.length > 0 ? (
            <form action={allocateScheduleAction} className="operations-form-grid">
              <input type="hidden" name="teamId" value={dashboard.selectedTeamId} />
              <label>Unallocated schedule
                <select name="scheduleId" required>
                  {dashboard.unallocatedSchedules.map((schedule) => (
                    <option key={schedule.id} value={schedule.id}>{schedule.service_vertical} · {formatScheduleTime(schedule.start_at, schedule.territory_timezone)} · {schedule.territory_name}</option>
                  ))}
                </select>
              </label>
              <button className="btn btn-primary">Allocate to this team</button>
            </form>
          ) : <p className="copy">No unallocated work is waiting in this team&apos;s active territory coverage.</p>}
        </article>
      )}
      {!selected ? <div className="card empty-operator"><h2>No work has been allocated to this team.</h2><p className="copy">Any authorized local dispatcher can accept qualified work from this team&apos;s active territory queue. Owners and GMs retain cross-team oversight.</p></div> : <div className="schedule-console">
        <aside className="card operator-panel"><span className="eyebrow">Team queue</span><h2>{dashboard.selectedTeam?.name}</h2><div className="schedule-list">{dashboard.teamSchedules.map((schedule) => <Link className={`schedule-entry${schedule.id === selected.id ? " selected" : ""}`} href={`/operator/schedule?team=${dashboard.selectedTeamId}&schedule=${schedule.id}`} key={schedule.id}><strong>{schedule.service_vertical}</strong><span>{formatScheduleTime(schedule.start_at, schedule.territory_timezone)} · {schedule.status}</span><span>{schedule.assigned_cleaners.length}/{schedule.required_crew_size} crew assigned</span></Link>)}</div></aside>
        <div className="operator-detail-stack">
          <article className="card operator-panel"><div className="operator-panel-head"><div><span className="eyebrow">Allocated job</span><h2>{selected.service_vertical} · {selected.territory_name}</h2></div><span className={`status-badge ${selected.status}`}>{selected.status.replaceAll("_", " ")}</span></div><div className="metric-grid compact"><div><span>Start</span><strong>{formatScheduleTime(selected.start_at, selected.territory_timezone)}</strong></div><div><span>End</span><strong>{formatScheduleTime(selected.end_at, selected.territory_timezone)}</strong></div><div><span>Labor plan</span><strong>{selected.labor_minutes} minutes</strong></div><div><span>Crew</span><strong>{selected.assigned_cleaners.length}/{selected.required_crew_size}</strong></div></div>{selected.assigned_cleaners.length > 0 && <p className="copy">Proposed/accepted: {selected.assigned_cleaners.join(", ")}</p>}<div className="schedule-actions">{(NEXT[selected.status] ?? []).map((next) => <form action={teamScheduleStatusAction} key={next.to}><input type="hidden" name="teamId" value={dashboard.selectedTeamId!} /><input type="hidden" name="scheduleId" value={selected.id} /><input type="hidden" name="from" value={selected.status} /><input type="hidden" name="to" value={next.to} /><button className={next.to === "canceled" || next.to === "tentative" ? "btn btn-soft" : "btn btn-primary"}>{next.label}</button></form>)}</div></article>
          <article className="card operator-panel"><span className="eyebrow">Intelligent crew recommendations</span><h2>Eligible team combinations</h2><div className="crew-suggestion-list">{suggestions.map((suggestion) => <article className={`crew-suggestion ${suggestion.eligible ? "eligible" : "blocked"}`} key={suggestion.candidateId}><div><strong>{suggestion.cleanerNames.join(" + ")}</strong><span>{suggestion.eligible ? `score ${suggestion.score}` : "blocked"}</span></div><p>{(suggestion.eligible ? suggestion.reasons : suggestion.blockers).join(" · ")}</p>{suggestion.eligible && <form action={proposeTeamScheduleCandidateAction}><input type="hidden" name="teamId" value={dashboard.selectedTeamId!} /><input type="hidden" name="scheduleId" value={selected.id} /><input type="hidden" name="candidateId" value={suggestion.candidateId} /><button className="btn btn-primary">Propose this crew</button></form>}</article>)}{suggestions.length === 0 && <p className="copy">No eligible team recommendation is available. Confirm active screened team membership, recurring availability, required skills, territory fit, and capacity.</p>}</div></article>
        </div>
      </div>}
    </section>
  </div>;
}
