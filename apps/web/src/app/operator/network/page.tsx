import type { Metadata } from "next";
import Link from "next/link";

import { OperatorDenied, OwnerBootstrap } from "@/components/OperatorAccessState";
import { OperatorTeamNav } from "@/components/OperatorTeamNav";
import { resolveOperatorIdentity } from "@/lib/auth";
import { hasCapability } from "@/lib/team-operations";
import { getOperationsDashboard } from "@/lib/team-operations-data";

import {
  addGeneralManagerAction,
  addMembershipAction,
  allocateScheduleAction,
  createTeamAction,
  membershipStatusAction,
  teamTerritoryCoverageAction,
} from "../team-operations-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "National operations network",
  robots: { index: false, follow: false },
};

export default async function NetworkPage({
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

  const organizationId = dashboard.access.organizationId;
  const canManageTeams = hasCapability(
    dashboard.access.memberships,
    "manage_teams",
    organizationId,
    null,
  );
  const canManageMembers = dashboard.selectedTeamId !== null && hasCapability(
    dashboard.access.memberships,
    "manage_members",
    organizationId,
    dashboard.selectedTeamId,
  );
  const canManageOrganizationRoles = hasCapability(
    dashboard.access.memberships,
    "manage_organization_roles",
    organizationId,
    null,
  );

  return (
    <div className="route-page operator-page">
      <section className="container page-hero">
        {identity.state === "preview" && <div className="preview-banner"><strong>Operations preview:</strong> writes remain limited to seeded records.</div>}
        <div className="operator-hero national-hero">
          <div>
            <span className="eyebrow">{dashboard.access.organizationName} · owner control plane</span>
            <h1>National operations network</h1>
            <p className="lead">One accountable view across teams, with every team&apos;s people, stock, time, and issues isolated behind its own scope.</p>
          </div>
          <div className="card operator-summary">
            <span>Active teams</span><strong>{dashboard.teams.filter((team) => team.status === "active").length}</strong>
            <span>Need attention</span><strong>{dashboard.teams.filter((team) => team.attention !== "healthy").length}</strong>
          </div>
        </div>
        <OperatorTeamNav dashboard={dashboard} current="network" />
      </section>

      <section className="container section team-operations-section">
        <div className="national-scorecard-grid">
          {dashboard.teams.map((team) => (
            <article className={`card team-scorecard ${team.attention}`} key={team.id}>
              <div className="operator-panel-head">
                <div><span className="eyebrow">{team.region_label || team.code}</span><h2>{team.name}</h2></div>
                <span className={`status-badge ${team.attention}`}>{team.attention}</span>
              </div>
              <div className="metric-grid compact">
                <div><span>People</span><strong>{team.active_members}</strong></div>
                <div><span>Low stock</span><strong>{team.low_stock_items}</strong></div>
                <div><span>Restocks</span><strong>{team.open_restock}</strong></div>
                <div><span>Callouts</span><strong>{team.open_callouts}</strong></div>
                <div><span>Cases</span><strong>{team.open_service_cases}</strong></div>
                <div><span>Labor variance</span><strong>{team.average_labor_variance_percent === null ? "—" : `${team.average_labor_variance_percent}%`}</strong></div>
              </div>
              <Link className="btn btn-soft" href={`/operator/inventory?team=${team.id}`}>Open team</Link>
            </article>
          ))}
          {dashboard.teams.length === 0 && (
            <article className="card empty-operator">
              <h2>No operating teams yet.</h2>
              <p className="copy">Create the first team below. It will receive a clean workforce scope and an empty supply room.</p>
            </article>
          )}
        </div>

        {canManageTeams && (
          <div className="operations-grid team-admin-grid">
            <article className="card operator-panel">
              <span className="eyebrow">Network expansion</span>
              <h2>Create a clean-slate team</h2>
              <form action={createTeamAction} className="operations-form-grid">
                <label>Team name<input name="name" required placeholder="Coeur d’Alene Estate Team" /></label>
                <label>Internal code<input name="code" required placeholder="cda-estate" /></label>
                <label>Region label<input name="regionLabel" placeholder="Inland Northwest" /></label>
                <label>IANA timezone<input name="timezone" required defaultValue="America/Los_Angeles" /></label>
                <button className="btn btn-primary">Create isolated team</button>
              </form>
            </article>

            <article className="card operator-panel">
              <span className="eyebrow">Operating areas</span>
              <h2>Team territory coverage</h2>
              <p className="copy">Coverage controls which local schedules this team can see and accept. Pausing an area removes new work from its dispatch queue without changing existing jobs.</p>
              {dashboard.selectedTeamId ? (
                <div className="ops-ledger-list">
                  {dashboard.territoryCoverage.map((territory) => (
                    <article key={territory.id}>
                      <div>
                        <span className={`status-badge ${territory.covered ? "active" : "paused"}`}>{territory.covered ? "covered" : "not covered"}</span>
                        <strong>{territory.name}</strong>
                        <small>{territory.code} · territory {territory.status}</small>
                      </div>
                      <form action={teamTerritoryCoverageAction}>
                        <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
                        <input type="hidden" name="territoryId" value={territory.id} />
                        <button className="btn btn-soft" name="enabled" value={territory.covered ? "false" : "true"}>
                          {territory.covered ? "Pause coverage" : "Enable coverage"}
                        </button>
                      </form>
                    </article>
                  ))}
                </div>
              ) : <p className="copy">Create a team before assigning operating areas.</p>}
            </article>

            <article className="card operator-panel">
              <span className="eyebrow">Dispatch ownership</span>
              <h2>Allocate planned work</h2>
              {dashboard.selectedTeamId && dashboard.unallocatedSchedules.length > 0 ? (
                <form action={allocateScheduleAction} className="operations-form-grid">
                  <input type="hidden" name="teamId" value={dashboard.selectedTeamId} />
                  <label>Qualified schedule<select name="scheduleId" required>{dashboard.unallocatedSchedules.map((schedule) => <option key={schedule.id} value={schedule.id}>{schedule.service_vertical} · {new Date(schedule.start_at).toLocaleDateString()} · {schedule.territory_name}</option>)}</select></label>
                  <button className="btn btn-primary">Allocate to {dashboard.selectedTeam?.name}</button>
                </form>
              ) : <p className="copy">{dashboard.selectedTeamId ? "No unallocated qualified schedules are waiting." : "Create a team before allocating work."}</p>}
            </article>
          </div>
        )}

        {canManageOrganizationRoles && (
          <article className="card operator-panel team-membership-panel">
            <span className="eyebrow">National authority</span>
            <h2>Owner + general manager access</h2>
            <p className="copy">Only the owner can grant or end organization-wide general-manager access. Every change remains in membership history.</p>
            {dashboard.generalManagerCandidates.length > 0 && <form action={addGeneralManagerAction} className="operations-form-grid">
              <label>Staff account<select name="subjectId">{dashboard.generalManagerCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></label>
              <label>Title<input name="title" defaultValue="General manager" /></label>
              <button className="btn btn-primary">Grant general-manager access</button>
            </form>}
            <div className="ops-ledger-list">
              {dashboard.organizationMembers.map((member) => <article key={member.id}><div><span className={`status-badge ${member.status}`}>{member.status}</span><strong>{member.display_name}</strong><small>{member.role.replaceAll("_", " ")} · {member.title || "No title"}</small></div>{member.role !== "owner" && ["active", "paused"].includes(member.status) && <form action={membershipStatusAction} className="inline-action-row"><input type="hidden" name="membershipId" value={member.id} /><input type="hidden" name="from" value={member.status} /><input name="reason" required minLength={4} placeholder="Reason for access change" />{member.status === "active" ? <button className="btn btn-soft" name="to" value="paused">Pause</button> : <button className="btn btn-soft" name="to" value="active">Reactivate</button>}<button className="btn btn-soft" name="to" value="ended">End access</button></form>}</article>)}
            </div>
          </article>
        )}

        {canManageMembers && dashboard.selectedTeamId && (
          <article className="card operator-panel team-membership-panel">
            <span className="eyebrow">Role assignment</span>
            <h2>Give people explicit team access</h2>
            <p className="copy">Managers use staff identities. Shift leads may use a staff account or an active cleaner profile. Every posted team and subject is re-checked against your active scope.</p>
            <div className="split-form-grid">
              {dashboard.staffCandidates.length > 0 && <form action={addMembershipAction} className="operations-form-grid">
                <input type="hidden" name="teamId" value={dashboard.selectedTeamId} />
                <input type="hidden" name="subjectType" value="staff" />
                <label>Staff account<select name="subjectId">{dashboard.staffCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></label>
                <label>Role<select name="role">{canManageTeams && <option value="manager">Manager</option>}<option value="shift_lead">Shift lead</option></select></label>
                <label>Title<input name="title" placeholder="Regional manager" /></label>
                <button className="btn btn-primary">Assign staff role</button>
              </form>}
              {dashboard.cleanerCandidates.length > 0 && <form action={addMembershipAction} className="operations-form-grid">
                <input type="hidden" name="teamId" value={dashboard.selectedTeamId} />
                <input type="hidden" name="subjectType" value="cleaner" />
                <label>Cleaner profile<select name="subjectId">{dashboard.cleanerCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></label>
                <label>Role<select name="role"><option value="cleaner">Cleaner</option><option value="shift_lead">Shift lead</option></select></label>
                <label>Title<input name="title" defaultValue="Cleaner" /></label>
                <button className="btn btn-primary">Add cleaner to team</button>
              </form>}
            </div>
            <div className="ops-ledger-list membership-ledger">
              {dashboard.members.map((member) => <article key={member.id}><div><span className={`status-badge ${member.status}`}>{member.status}</span><strong>{member.display_name}</strong><small>{member.role.replaceAll("_", " ")} · {member.title || "No title"}</small></div>{["active", "paused"].includes(member.status) && (member.role !== "manager" || canManageTeams) && <form action={membershipStatusAction} className="inline-action-row"><input type="hidden" name="membershipId" value={member.id} /><input type="hidden" name="teamId" value={dashboard.selectedTeamId ?? ""} /><input type="hidden" name="from" value={member.status} /><input name="reason" required minLength={4} placeholder="Reason for access change" aria-label={`Reason for changing ${member.display_name}'s access`} />{member.status === "active" ? <button className="btn btn-soft" name="to" value="paused">Pause</button> : <button className="btn btn-soft" name="to" value="active">Reactivate</button>}<button className="btn btn-soft" name="to" value="ended">End access</button></form>}</article>)}
            </div>
          </article>
        )}
      </section>
    </div>
  );
}
