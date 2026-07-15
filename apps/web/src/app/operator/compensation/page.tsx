import type { Metadata } from "next";

import { OperatorDenied, OwnerBootstrap } from "@/components/OperatorAccessState";
import { OperatorTeamNav } from "@/components/OperatorTeamNav";
import { resolveOperatorIdentity } from "@/lib/auth";
import { effectiveRoleForTeam, hasCapability } from "@/lib/team-operations";
import { getOperationsDashboard } from "@/lib/team-operations-data";

import {
  bonusStatusAction,
  createBonusAction,
  createQualityReviewAction,
  createReviewBonusTierAction,
  setCompensationRateAction,
} from "../team-operations-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Team compensation controls", robots: { index: false, follow: false } };

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export default async function CompensationPage({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  const identity = await resolveOperatorIdentity();
  if (identity.state !== "authed" && identity.state !== "preview") return <OperatorDenied identity={identity} />;
  const params = await searchParams;
  const dashboard = await getOperationsDashboard({ customerId: identity.operator.id, devOnly: identity.devOnly, requestedTeamId: params.team });
  if (!dashboard.access.organizationId) return <OwnerBootstrap dashboard={dashboard} />;
  const canManage = dashboard.selectedTeamId ? hasCapability(dashboard.access.memberships, "manage_compensation", dashboard.access.organizationId, dashboard.selectedTeamId) : false;
  const actorRole = dashboard.selectedTeamId
    ? effectiveRoleForTeam(dashboard.access.memberships, dashboard.access.organizationId, dashboard.selectedTeamId)
    : null;
  const financialMembers = actorRole === "manager"
    ? dashboard.members.filter((member) => ["shift_lead", "cleaner"].includes(member.role))
    : dashboard.members;

  return <div className="route-page operator-page">
    <section className="container page-hero">
      <div className="operator-hero"><div><span className="eyebrow">Restricted financial controls</span><h1>Pay + recognition</h1><p className="lead">Effective-dated rates and bonus approvals stay auditable by team. This control plane prepares payroll evidence; it never transfers payroll funds.</p></div><div className="card operator-summary"><span>Active rates</span><strong>{dashboard.compensation.filter((rate) => rate.status === "active").length}</strong><span>Proposed bonuses</span><strong>{dashboard.bonuses.filter((bonus) => bonus.status === "proposed").length}</strong></div></div>
      <OperatorTeamNav dashboard={dashboard} current="compensation" />
    </section>
    <section className="container section team-operations-section">
      {!canManage && <div className="card operator-locked"><span className="eyebrow">Restricted by role</span><h2>Compensation requires owner, GM, or assigned manager access.</h2><p className="copy">Shift leads can manage service execution but cannot see team pay.</p></div>}
      {canManage && dashboard.selectedTeam && <>
        <div className="operations-grid">
          <article className="card operator-panel"><span className="eyebrow">Effective-dated control</span><h2>Set a pay rate</h2>
            {financialMembers.length > 0 ?
            <form action={setCompensationRateAction} className="operations-form-grid">
              <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
              <label>Team member<select name="membershipId">{financialMembers.map((member) => <option key={member.id} value={member.id}>{member.display_name} · {member.role}</option>)}</select></label>
              <label>Pay basis<select name="payBasis"><option value="hourly">Hourly</option><option value="per_job">Per job</option><option value="salary">Salary</option></select></label>
              <label>Amount ($)<input name="amountDollars" type="number" min="0.01" step="0.01" required /></label>
              <label>Effective date<input name="effectiveFrom" type="date" required /></label>
              <label>Reason<input name="reason" required placeholder="Hire rate, promotion, annual review…" /></label>
              <button className="btn btn-primary">Record new effective rate</button>
            </form> : <p className="copy">No eligible team members are available for this role.</p>}
          </article>
          <article className="card operator-panel"><span className="eyebrow">Quality + reliability</span><h2>Propose a bonus</h2>
            {financialMembers.length > 0 ?
            <form action={createBonusAction} className="operations-form-grid">
              <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
              <label>Team member<select name="membershipId">{financialMembers.map((member) => <option key={member.id} value={member.id}>{member.display_name}</option>)}</select></label>
              <label>Amount ($)<input name="amountDollars" type="number" min="0.01" step="0.01" required /></label>
              <label>Reason<input name="reason" required placeholder="Verified review, quality milestone, reliability…" /></label>
              <button className="btn btn-primary">Create approval-ready bonus</button>
            </form> : <p className="copy">No eligible team members are available for this role.</p>}
            <p className="copy">Verified customer review tiers can also create proposed awards automatically. A manager still approves them before payroll export.</p>
          </article>
          <article className="card operator-panel"><span className="eyebrow">Review reward rules</span><h2>Create a team bonus tier</h2>
            <form action={createReviewBonusTierAction} className="operations-form-grid">
              <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
              <label>Tier name<input name="name" required placeholder="Five-star closeout" /></label>
              <label>Minimum rating<input name="minimumRating" type="number" min="1" max="5" step="0.1" defaultValue="5" required /></label>
              <label>Bonus amount ($)<input name="bonusDollars" type="number" min="0.01" step="0.01" required /></label>
              <button className="btn btn-primary">Create team tier</button>
            </form>
            <div className="availability-list">{dashboard.bonusTiers.map((tier) => <div key={tier.id}><strong>{tier.name}</strong><span>{tier.minimum_rating}+ rating · {money(tier.bonus_cents)} · {tier.active ? "active" : "inactive"}</span></div>)}{dashboard.bonusTiers.length === 0 && <p className="copy">No automatic review tiers are configured.</p>}</div>
          </article>
          <article className="card operator-panel"><span className="eyebrow">Verified closeout evidence</span><h2>Record a quality review</h2>
            {dashboard.qualityReviewCandidates.length > 0 ? <form action={createQualityReviewAction} className="operations-form-grid">
              <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
              <label>Completed work + cleaner<select name="candidateKey">{dashboard.qualityReviewCandidates.map((candidate) => <option key={`${candidate.allocation_id}-${candidate.cleaner_id}`} value={`${candidate.allocation_id}|${candidate.cleaner_id}`}>{candidate.cleaner_name} · {candidate.job_label}</option>)}</select></label>
              <label>Source<select name="source"><option value="verified_customer">Verified customer feedback</option><option value="quality_inspection">Quality inspection</option><option value="manager_review">Manager review</option></select></label>
              <label>Rating<input name="rating" type="number" min="1" max="5" step="1" required /></label>
              <label>Evidence reference<input name="evidenceReference" placeholder="Customer thread, survey, or inspection reference" /></label>
              <label>Restricted note<textarea name="privateNote" placeholder="Evidence summary; avoid unnecessary personal data" /></label>
              <button className="btn btn-primary">Record review evidence</button>
            </form> : <p className="copy">Quality evidence becomes available after allocated work reaches closeout or completion and the cleaner is confirmed on the job.</p>}
            <div className="availability-list">{dashboard.qualityReviews.map((review) => <div key={review.id}><strong>{review.cleaner_name} · {review.rating}/5</strong><span>{review.source.replaceAll("_", " ")}{review.evidence_reference ? ` · ${review.evidence_reference}` : ""}</span></div>)}</div>
          </article>
        </div>
        <div className="operations-grid">
          <article className="card operator-panel"><span className="eyebrow">Rate history</span><h2>Compensation ledger</h2><div className="ops-ledger-list">{dashboard.compensation.map((rate) => <article key={rate.id}><div><span className={`status-badge ${rate.status}`}>{rate.status}</span><strong>{rate.member_name}</strong><small>{money(rate.amount_cents)} · {rate.pay_basis.replaceAll("_", " ")} · effective {rate.effective_from}{rate.effective_to ? ` to ${rate.effective_to}` : ""}</small></div></article>)}{dashboard.compensation.length === 0 && <p className="copy">No rate records for this team.</p>}</div></article>
          <article className="card operator-panel"><span className="eyebrow">Recognition ledger</span><h2>Bonus awards</h2><div className="ops-ledger-list">{dashboard.bonuses.map((bonus) => <article key={bonus.id}><div><span className={`status-badge ${bonus.status}`}>{bonus.status}</span><strong>{bonus.member_name} · {money(bonus.amount_cents)}</strong><small>{bonus.reason}{bonus.external_reference ? ` · ref ${bonus.external_reference}` : ""}</small></div>{["proposed", "approved", "exported"].includes(bonus.status) && <div className="inline-action-row">{bonus.status === "proposed" && <form action={bonusStatusAction}><input type="hidden" name="teamId" value={dashboard.selectedTeamId!} /><input type="hidden" name="bonusId" value={bonus.id} /><input type="hidden" name="from" value="proposed" /><input type="hidden" name="to" value="approved" /><input type="hidden" name="version" value={bonus.version} /><button className="btn btn-primary">Approve</button></form>}{bonus.status === "approved" && <form action={bonusStatusAction}><input type="hidden" name="teamId" value={dashboard.selectedTeamId!} /><input type="hidden" name="bonusId" value={bonus.id} /><input type="hidden" name="from" value="approved" /><input type="hidden" name="to" value="exported" /><input type="hidden" name="version" value={bonus.version} /><input name="externalReference" required minLength={4} placeholder="Payroll export reference" /><button className="btn btn-primary">Record export</button></form>}{bonus.status === "exported" && <form action={bonusStatusAction}><input type="hidden" name="teamId" value={dashboard.selectedTeamId!} /><input type="hidden" name="bonusId" value={bonus.id} /><input type="hidden" name="from" value="exported" /><input type="hidden" name="to" value="recorded_paid" /><input type="hidden" name="version" value={bonus.version} /><input name="externalReference" required minLength={4} defaultValue={bonus.external_reference ?? ""} placeholder="Payment evidence reference" /><button className="btn btn-primary">Record externally paid</button></form>}<form action={bonusStatusAction}><input type="hidden" name="teamId" value={dashboard.selectedTeamId!} /><input type="hidden" name="bonusId" value={bonus.id} /><input type="hidden" name="from" value={bonus.status} /><input type="hidden" name="to" value="canceled" /><input type="hidden" name="version" value={bonus.version} /><button className="btn btn-soft">Cancel</button></form></div>}</article>)}{dashboard.bonuses.length === 0 && <p className="copy">No bonus awards for this team.</p>}</div></article>
        </div>
        <div className="card operator-panel guardrail-panel"><span className="eyebrow">Money boundary</span><h2>Approval and export only.</h2><p className="copy">Rates and awards are authoritative operating records, but this app does not issue payroll, debit a bank account, purchase supplies, or mark a bonus paid without external evidence.</p></div>
      </>}
    </section>
  </div>;
}
