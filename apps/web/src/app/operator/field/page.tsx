import type { Metadata } from "next";
import Link from "next/link";

import { OperatorDenied, OwnerBootstrap } from "@/components/OperatorAccessState";
import { OperatorTeamNav } from "@/components/OperatorTeamNav";
import { resolveOperatorIdentity } from "@/lib/auth";
import {
  arrivalWindowForStartMinutes,
  STANDARD_ARRIVAL_WINDOWS,
} from "@/lib/field-operations";
import { getTeamFieldDashboard } from "@/lib/field-operations-data";
import { hasCapability } from "@/lib/team-operations";
import { getOperationsDashboard } from "@/lib/team-operations-data";

import {
  approveRouteExceptionAction,
  assignTeamDutyAction,
  cancelTeamDutyAction,
  confirmApprovedScheduleAction,
  createScheduleProposalAction,
  recordTipIntentStatusAction,
  resolveFieldIssueAction,
  reviewMileageAction,
  updateBranchFieldRulesAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Field operations control",
  robots: { index: false, follow: false },
};

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function arrivalWindowIdForInstant(value: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(new Date(value));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return arrivalWindowForStartMinutes(hour * 60 + minute)?.id ?? null;
}

export default async function FieldOperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ team?: string }>;
}) {
  const identity = await resolveOperatorIdentity();
  if (identity.state !== "authed" && identity.state !== "preview") {
    return <OperatorDenied identity={identity} />;
  }
  const params = await searchParams;
  const dashboard = await getOperationsDashboard({
    customerId: identity.operator.id,
    devOnly: identity.devOnly,
    requestedTeamId: params.team,
  });
  if (!dashboard.access.organizationId) return <OwnerBootstrap dashboard={dashboard} />;
  const teamId = dashboard.selectedTeamId;
  const field = teamId
    ? await getTeamFieldDashboard({
        customerId: identity.operator.id,
        devOnly: identity.devOnly,
        teamId,
      })
    : null;
  const canSchedule = Boolean(teamId && hasCapability(
    dashboard.access.memberships,
    "manage_schedule_approvals",
    dashboard.access.organizationId,
    teamId,
  ));
  const canRoute = Boolean(teamId && hasCapability(
    dashboard.access.memberships,
    "manage_route_exceptions",
    dashboard.access.organizationId,
    teamId,
  ));
  const canMileage = Boolean(teamId && hasCapability(
    dashboard.access.memberships,
    "approve_mileage",
    dashboard.access.organizationId,
    teamId,
  ));
  const canDuty = Boolean(teamId && hasCapability(
    dashboard.access.memberships,
    "manage_duty_roster",
    dashboard.access.organizationId,
    teamId,
  ));

  return (
    <div className="route-page operator-page">
      <section className="container page-hero">
        {identity.state === "preview" && <div className="preview-banner"><strong>Field preview:</strong> only synthetic records are visible; writes are disabled.</div>}
        <div className="operator-hero">
          <div><span className="eyebrow">Team-scoped execution</span><h1>Field operations control</h1><p className="lead">Route exceptions, customer-approved arrival windows, cleaner communication, mileage, job issues, duty coverage, and non-cash tip intent in one audited queue.</p></div>
          <div className="card operator-summary"><span>Assigned jobs</span><strong>{field?.jobs.length ?? 0}</strong><span>Open issues</span><strong>{field?.issues.filter((issue) => !["resolved", "dismissed"].includes(issue.status)).length ?? 0}</strong></div>
        </div>
        <OperatorTeamNav dashboard={dashboard} current="field" />
      </section>

      {!field ? <section className="container section"><article className="card empty-operator"><h2>Create or select a team.</h2><p className="copy">Field control is isolated by branch.</p></article></section> : <section className="container section team-operations-section">
        <div className="operations-grid">
          <article className="card operator-panel">
            <span className="eyebrow">Branch operating guardrails</span><h2>{field.team.name}</h2>
            <form action={updateBranchFieldRulesAction} className="operations-form-grid">
              <input type="hidden" name="teamId" value={field.team.id} />
              <label>Route origin<input name="originLabel" required defaultValue={field.team.origin_label ?? "Downtown Coeur d'Alene, Idaho"} /></label>
              <label>Origin latitude<input name="originLatitude" type="number" min="-90" max="90" step="0.000001" required defaultValue={field.team.origin_latitude ?? 47.6777} /></label>
              <label>Origin longitude<input name="originLongitude" type="number" min="-180" max="180" step="0.000001" required defaultValue={field.team.origin_longitude ?? -116.7805} /></label>
              <label>Standard radius miles<input name="serviceRadiusMiles" type="number" min="1" max="250" step="0.01" defaultValue={field.team.service_radius_miles} required /></label>
              <label>Operating start<input name="operatingStartTime" type="time" defaultValue={field.team.operating_start_time.slice(0, 5)} required /></label>
              <label>Latest arrival<input name="latestArrivalTime" type="time" defaultValue={field.team.latest_arrival_time.slice(0, 5)} required /></label>
              <label>Hard finish<input name="hardFinishTime" type="time" defaultValue={field.team.hard_finish_time.slice(0, 5)} required /></label>
              <label>Branch support alias<input name="supportEmail" type="email" defaultValue={field.team.support_email ?? "support@lakeandpinecleaning.com"} /></label>
              <label>Branch phone<input name="publicPhone" defaultValue={field.team.public_phone ?? ""} /></label>
              <button className="btn btn-primary" disabled={identity.devOnly}>Save branch rules</button>
            </form>
          </article>

          <article className="card operator-panel">
            <span className="eyebrow">Escalation routing</span><h2>Manager or lead on duty</h2>
            {canDuty && field.dutyCandidates.length > 0 && <form action={assignTeamDutyAction} className="operations-form-grid">
              <input type="hidden" name="teamId" value={field.team.id} />
              <label>Eligible person + duty role<select name="dutyAssignment">{field.dutyCandidates.flatMap((candidate) => [candidate.role !== "shift_lead" ? <option key={`${candidate.id}-manager`} value={`${candidate.id}|manager_on_duty`}>{candidate.display_name} · manager on duty</option> : null, <option key={`${candidate.id}-lead`} value={`${candidate.id}|shift_lead_on_duty`}>{candidate.display_name} · shift lead on duty</option>])}</select></label>
              <label>Starts local<input name="startsAt" type="datetime-local" required /></label><label>Ends local<input name="endsAt" type="datetime-local" required /></label>
              <label>Note<input name="note" maxLength={1000} /></label><button className="btn btn-primary" disabled={identity.devOnly}>Assign coverage</button>
            </form>}
            <div className="availability-list">{field.duty.map((duty) => <div key={duty.id}><strong>{duty.display_name} · {duty.duty_kind.replaceAll("_", " ")}</strong><span>{duty.status} · membership {duty.membership_status} · {new Date(duty.starts_at).toLocaleString()} → {new Date(duty.ends_at).toLocaleString()}</span>{canDuty && ["scheduled", "active"].includes(duty.status) && <form action={cancelTeamDutyAction}><input type="hidden" name="teamId" value={field.team.id} /><input type="hidden" name="dutyId" value={duty.id} /><button className="btn btn-soft" disabled={identity.devOnly}>Cancel coverage</button></form>}</div>)}</div>
          </article>
        </div>

        <article className="card operator-panel">
          <span className="eyebrow">Approval-gated schedule</span><h2>Route review → proposal → customer response → confirmation</h2>
          <div className="ops-ledger-list">
            {field.jobs.map((job) => <article key={job.allocation_id}>
              <div>
                <span className={`status-badge ${job.schedule_status}`}>{job.schedule_status.replaceAll("_", " ")}</span>
                <strong>{job.customer_name} · {job.service_vertical}</strong>
                <small>Current: {new Date(job.start_at).toLocaleString("en-US", { timeZone: field.team.timezone })} → {new Date(job.end_at).toLocaleString("en-US", { timeZone: field.team.timezone })}</small>
                {job.proposal_start_at && job.proposal_end_at && <small>Proposed replacement: {new Date(job.proposal_start_at).toLocaleString("en-US", { timeZone: field.team.timezone })} → {new Date(job.proposal_end_at).toLocaleString("en-US", { timeZone: field.team.timezone })}</small>}
                <small>Service address: {job.service_address ?? "Address missing — do not approve"}</small>
                <small>Route: {job.route_status?.replaceAll("_", " ") ?? "missing"}{job.distance_miles === null ? " · distance not calculated" : ` · ${job.distance_miles.toFixed(1)} miles`} · standard radius {job.standard_radius_miles?.toFixed(1) ?? "unknown"} miles</small>
                <small>Assessment: {job.calculation_method?.replaceAll("_", " ") ?? "missing"} via {job.route_provider ?? "unknown"}{job.calculated_at ? ` · ${new Date(job.calculated_at).toLocaleString()}` : " · no provider calculation"}</small>
                {job.provider_resolved_address && <small>Provider resolved: {job.provider_resolved_address} · confidence {job.provider_match_confidence ?? "missing"} · accuracy {job.provider_coordinate_accuracy ?? "missing"}</small>}
                <small>Origin: {job.branch_origin_label ?? "not configured"}{job.branch_origin_latitude === null || job.branch_origin_longitude === null ? " · coordinates missing" : ` · ${job.branch_origin_latitude.toFixed(6)}, ${job.branch_origin_longitude.toFixed(6)}`}</small>
                <small>Property coordinates: {job.property_latitude === null || job.property_longitude === null ? "not available — verify manually" : `${job.property_latitude.toFixed(6)}, ${job.property_longitude.toFixed(6)}`}</small>
                <small>Customer proposal: {job.proposal_status?.replaceAll("_", " ") ?? "none"}</small>
                {job.proposal_id && !job.proposal_is_current && !job.has_active_reschedule_case && !job.proposal_service_case_id && <p>The latest customer proposal has expired. Send a new reviewed window if the work has not started.</p>}
                {job.has_active_reschedule_case && <p>A customer reschedule request is active. <Link href={`/operator/recovery?team=${field.team.id}`}>Open service recovery</Link> to review or restage the linked window; the confirmed visit remains unchanged until an authorized replacement is approved.</p>}
                {job.route_override_reason && <p>Override: {job.route_override_reason}</p>}
                {job.schedule_status === "confirmed" && job.proposal_status === "approved" && job.proposal_is_current && <p>Customer window evidence is current; execution may proceed.</p>}
              </div>
              {canRoute && job.route_assessment_id && ["tentative", "held", "confirmed", "en_route", "in_progress", "quality_review"].includes(job.schedule_status) && !["inside_standard_radius", "approved_exception"].includes(job.route_status ?? "") && <form action={approveRouteExceptionAction} className="operations-form-grid"><input type="hidden" name="teamId" value={field.team.id} /><input type="hidden" name="assessmentId" value={job.route_assessment_id} /><label>Manager route exception reason<textarea name="reason" required minLength={4} maxLength={1000} /></label><button className="btn btn-soft" disabled={identity.devOnly}>Approve exception</button></form>}
              {canSchedule && job.customer_id && !job.has_active_reschedule_case && !job.proposal_service_case_id && ["inside_standard_radius", "approved_exception"].includes(job.route_status ?? "") && ["tentative", "held", "confirmed"].includes(job.schedule_status) && !(job.proposal_status === "approved" && job.proposal_is_current) && job.proposal_still_future && arrivalWindowIdForInstant(job.start_at, field.team.timezone) && <form action={createScheduleProposalAction} className="operations-form-grid"><input type="hidden" name="teamId" value={field.team.id} /><input type="hidden" name="allocationId" value={job.allocation_id} /><label>Arrival window<select name="windowId">{STANDARD_ARRIVAL_WINDOWS.filter((window) => window.id === arrivalWindowIdForInstant(job.start_at, field.team.timezone)).map((window) => <option key={window.id} value={window.id}>{window.label}</option>)}</select></label><label>Proposal note<textarea name="note" maxLength={2000} /></label><button className="btn btn-primary" disabled={identity.devOnly}>{job.schedule_status === "confirmed" ? "Reconfirm legacy customer window" : "Send for customer approval"}</button></form>}
              {canSchedule && job.proposal_status === "approved" && job.proposal_is_current && (job.schedule_status === "held" || Boolean(job.proposal_service_case_id)) && <form action={confirmApprovedScheduleAction}><input type="hidden" name="teamId" value={field.team.id} /><input type="hidden" name="scheduleId" value={job.schedule_id} /><button className="btn btn-primary" disabled={identity.devOnly}>{job.proposal_service_case_id ? "Apply approved reschedule" : "Confirm approved schedule"}</button></form>}
            </article>)}
            {field.jobs.length === 0 && <p className="copy">No work is allocated to this team.</p>}
          </div>
        </article>

        <div className="operations-grid">
          <article className="card operator-panel"><span className="eyebrow">Mileage approval</span><h2>Submitted crew mileage</h2><div className="ops-ledger-list">{field.mileage.map((entry) => <article key={entry.id}><div><span className={`status-badge ${entry.status}`}>{entry.status}</span><strong>{entry.cleaner_name} · {entry.miles} miles</strong><small>{entry.service_date} · {entry.purpose.replaceAll("_", " ")} · submitted {new Date(entry.created_at).toLocaleString()}</small><small>Vehicle: {entry.vehicle_label ?? "not provided"}</small>{entry.team_job_allocation_id ? <small>Linked job: {entry.customer_name ?? "unlinked customer"}{entry.service_vertical ? ` · ${entry.service_vertical}` : ""}{entry.job_start_at ? ` · ${new Date(entry.job_start_at).toLocaleString("en-US", { timeZone: field.team.timezone })}` : ""} · allocation {entry.team_job_allocation_id.slice(0, 8)}</small> : <small>No linked job — review the purpose and note carefully.</small>}{entry.service_location && <small>Service address: {entry.service_location}</small>}{entry.note && <p>Crew note: {entry.note}</p>}</div>{canMileage && entry.status === "submitted" && <form action={reviewMileageAction} className="operations-form-grid"><input type="hidden" name="teamId" value={field.team.id} /><input type="hidden" name="mileageId" value={entry.id} /><input type="hidden" name="version" value={entry.version} /><label>Decision note<input name="note" maxLength={1000} /></label><div className="hero-actions"><button className="btn btn-soft" name="status" value="rejected" disabled={identity.devOnly}>Reject</button><button className="btn btn-primary" name="status" value="approved" disabled={identity.devOnly}>Approve</button></div></form>}</article>)}</div></article>

          <article className="card operator-panel"><span className="eyebrow">Issue escalation</span><h2>Conflicts, safety, vehicles, stock, scope</h2><div className="ops-ledger-list">{field.issues.map((issue) => <article key={issue.id}><div><span className={`status-badge ${issue.severity}`}>{issue.severity}</span><strong>{issue.issue_type.replaceAll("_", " ")} · {issue.reporter_name}</strong><small>{issue.status}{issue.customer_visible ? " · customer-visible" : " · manager-private"}</small>{issue.customer_name && <small>{issue.customer_name}{issue.service_vertical ? ` · ${issue.service_vertical}` : ""}{issue.job_start_at ? ` · ${new Date(issue.job_start_at).toLocaleString("en-US", { timeZone: field.team.timezone })}` : ""}</small>}{issue.service_location && <small>{issue.service_location}</small>}<p>{issue.summary}</p>{issue.private_details && <p><strong>Private manager detail:</strong> {issue.private_details}</p>}</div>{!["resolved", "dismissed"].includes(issue.status) && <form action={resolveFieldIssueAction} className="operations-form-grid"><input type="hidden" name="teamId" value={field.team.id} /><input type="hidden" name="issueId" value={issue.id} /><input type="hidden" name="version" value={issue.version} /><label>Resolution note<textarea name="note" maxLength={2000} /></label><label>Status<select name="status"><option value="acknowledged">Acknowledge</option><option value="resolved">Resolve</option><option value="dismissed">Dismiss</option></select></label><label className="consent-row"><input name="customerVisible" type="checkbox" defaultChecked={issue.customer_visible} /><span>Share the summary with the customer (private manager detail is never shared)</span></label><button className="btn btn-primary" disabled={identity.devOnly}>Save decision</button></form>}</article>)}</div></article>
        </div>

        <div className="operations-grid">
          <article className="card operator-panel"><span className="eyebrow">Audited communication</span><h2>Latest job messages</h2><div className="internal-note-list">{field.communications.map((message) => <article key={message.id}><div><strong>{message.sender_kind} → {message.audience.replaceAll("_", " ")}</strong><span>{new Date(message.created_at).toLocaleString()}</span></div><small>{message.customer_name ?? "Unlinked customer"}{message.service_vertical ? ` · ${message.service_vertical}` : ""}{message.job_start_at ? ` · ${new Date(message.job_start_at).toLocaleString("en-US", { timeZone: field.team.timezone })}` : ""} · allocation {message.team_job_allocation_id.slice(0, 8)}</small>{message.service_location && <small>{message.service_location}</small>}<p>{message.body}</p><small>{message.channel} · {message.delivery_status}</small></article>)}</div></article>
          <article className="card operator-panel"><span className="eyebrow">Tip intent ledger</span><h2>No automatic charge or payout</h2><p className="copy">A customer amount is only an intent until a real external payment reference is recorded.</p><div className="ops-ledger-list">{field.tips.map((tip) => <article key={tip.id}><div><span className={`status-badge ${tip.status}`}>{tip.status}</span><strong>{money(tip.amount_cents)} · {tip.customer_name}</strong><small>{tip.cleaner_name ?? "Whole crew"} · job {tip.team_job_allocation_id.slice(0, 8)}</small>{tip.note && <p>Customer note: {tip.note}</p>}{tip.provider_reference && <small>{tip.provider} reference: {tip.provider_reference} · recorded by {tip.recorded_by ?? "authorized manager"} · {new Date(tip.updated_at).toLocaleString()}</small>}</div>{tip.status === "pending_collection" && <form action={recordTipIntentStatusAction} className="operations-form-grid"><input type="hidden" name="teamId" value={field.team.id} /><input type="hidden" name="tipId" value={tip.id} /><input type="hidden" name="version" value={tip.version} /><label>External payment reference<input name="providerReference" placeholder="Required only when recorded" /></label><label>Decision<select name="status"><option value="recorded">Recorded externally</option><option value="declined">Declined</option><option value="canceled">Canceled</option></select></label><button className="btn btn-soft" disabled={identity.devOnly}>Update intent</button></form>}</article>)}</div></article>
        </div>
      </section>}
    </div>
  );
}
