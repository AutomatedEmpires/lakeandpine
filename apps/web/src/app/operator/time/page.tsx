import type { Metadata } from "next";

import { OperatorDenied, OwnerBootstrap } from "@/components/OperatorAccessState";
import { OperatorTeamNav } from "@/components/OperatorTeamNav";
import { resolveOperatorIdentity } from "@/lib/auth";
import { hasCapability } from "@/lib/team-operations";
import { getOperationsDashboard } from "@/lib/team-operations-data";

import { reviewTimeEntryAction } from "../team-operations-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Team time and performance", robots: { index: false, follow: false } };

function minutesLabel(minutes: number | null) {
  if (minutes === null) return "Open clock";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h ${remainder}m` : `${remainder}m`;
}
export default async function TimePage({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const identity = await resolveOperatorIdentity();
  if (identity.state !== "authed" && identity.state !== "preview") return <OperatorDenied identity={identity} />;
  const params = await searchParams;
  const dashboard = await getOperationsDashboard({ customerId: identity.operator.id, devOnly: identity.devOnly, requestedTeamId: params.team });
  if (!dashboard.access.organizationId) return <OwnerBootstrap dashboard={dashboard} />;
  const canReview = dashboard.selectedTeamId ? hasCapability(dashboard.access.memberships, "review_time", dashboard.access.organizationId, dashboard.selectedTeamId) : false;
  const submitted = dashboard.timeEntries.filter((entry) => entry.status === "submitted").length;
  const approved = dashboard.timeEntries.filter((entry) => entry.status === "approved" && entry.variance_percent !== null);
  const averageVariance = approved.length ? Math.round(approved.reduce((sum, entry) => sum + (entry.variance_percent ?? 0), 0) / approved.length) : null;

  return <div className="route-page operator-page">
    <section className="container page-hero">
      <div className="operator-hero"><div><span className="eyebrow">Estimated versus actual labor</span><h1>Time + performance</h1><p className="lead">Managers approve accountable time records and see variance against the service plan. Speed is context—not a quality score or an automatic penalty.</p></div><div className="card operator-summary"><span>Awaiting review</span><strong>{submitted}</strong><span>Average approved variance</span><strong>{averageVariance === null ? "—" : `${averageVariance}%`}</strong></div></div>
      <OperatorTeamNav dashboard={dashboard} current="time" />
    </section>
    <section className="container section team-operations-section">
      <article className="card operator-panel">
        <span className="eyebrow">Team time ledger</span><h2>{dashboard.selectedTeam?.name ?? "Select a team"}</h2>
        <div className="ops-ledger-list time-ledger">
          {dashboard.timeEntries.map((entry) => <article key={entry.id}>
            <div><span className={`status-badge ${entry.status}`}>{entry.status}</span><strong>{entry.cleaner_name}</strong><small>{new Date(entry.clock_in_at).toLocaleString()} · {minutesLabel(entry.actual_minutes)} actual / {minutesLabel(entry.estimated_minutes_snapshot)} plan</small>{entry.variance_percent !== null && <p className={entry.variance_percent > 20 ? "variance over" : entry.variance_percent < -20 ? "variance under" : "variance"}>{entry.variance_percent > 0 ? "+" : ""}{entry.variance_percent}% from individual plan</p>}</div>
            {canReview && entry.status === "submitted" && <div className="inline-action-row"><form action={reviewTimeEntryAction}><input type="hidden" name="teamId" value={dashboard.selectedTeamId!} /><input type="hidden" name="entryId" value={entry.id} /><input type="hidden" name="version" value={entry.version} /><input type="hidden" name="to" value="rejected" /><button className="btn btn-soft">Return for correction</button></form><form action={reviewTimeEntryAction}><input type="hidden" name="teamId" value={dashboard.selectedTeamId!} /><input type="hidden" name="entryId" value={entry.id} /><input type="hidden" name="version" value={entry.version} /><input type="hidden" name="to" value="approved" /><button className="btn btn-primary">Approve time</button></form></div>}
          </article>)}
          {dashboard.timeEntries.length === 0 && <p className="copy">No team time entries yet. Cleaners can start a clock only on an accepted, team-allocated assignment.</p>}
        </div>
      </article>
      <div className="card operator-panel guardrail-panel"><span className="eyebrow">Performance guardrail</span><h2>Never rank on time alone.</h2><p className="copy">Use labor variance with property complexity, crew size, inspection results, client feedback, rework, safety, and documented scope changes. A fast poor-quality clean is not high performance.</p></div>
    </section>
  </div>;
}
