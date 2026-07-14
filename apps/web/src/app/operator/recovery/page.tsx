import type { Metadata } from "next";

import { OperatorDenied, OwnerBootstrap } from "@/components/OperatorAccessState";
import { OperatorTeamNav } from "@/components/OperatorTeamNav";
import { resolveOperatorIdentity } from "@/lib/auth";
import { hasCapability } from "@/lib/team-operations";
import {
  getOperationsDashboard,
  getTeamRecoveryDashboard,
  type TeamRecoveryDashboard,
} from "@/lib/team-operations-data";

import {
  cancelServiceCaseBookingAction,
  createRecoveryAction,
  recoveryStatusAction,
  refundStatusAction,
  requestRefundReviewAction,
  rescheduleServiceCaseAction,
  serviceCaseStatusAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Team service recovery",
  robots: { index: false, follow: false },
};

const CASE_NEXT: Record<string, string[]> = {
  submitted: ["triaged", "canceled"],
  triaged: ["awaiting_customer", "investigating", "action_planned", "declined"],
  awaiting_customer: ["triaged", "investigating", "canceled"],
  investigating: ["awaiting_customer", "action_planned", "declined"],
  action_planned: ["reclean_scheduled", "refund_pending", "resolved"],
  reclean_scheduled: ["resolved", "action_planned"],
  refund_pending: ["resolved", "action_planned"],
  resolved: ["closed", "investigating"],
  declined: ["closed", "investigating"],
};

const RECOVERY_NEXT: Record<string, string[]> = {
  planned: ["approved", "canceled"],
  approved: ["scheduled", "completed", "canceled"],
  scheduled: ["completed", "approved", "canceled"],
};

const REFUND_NEXT: Record<string, string[]> = {
  requested: ["approved", "declined", "canceled"],
  approved: ["ready_for_manual_processing", "canceled"],
  ready_for_manual_processing: ["processed", "failed", "canceled"],
  failed: ["ready_for_manual_processing", "canceled"],
};

const EMPTY_RECOVERY: TeamRecoveryDashboard = {
  serviceCases: [],
  recoveries: [],
  refunds: [],
};

function label(value: string) {
  return value.replaceAll("_", " ");
}

function formatDateTime(value: string, timeZone: string) {
  return new Date(value).toLocaleString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export default async function TeamRecoveryPage({
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

  const canManageRecovery = dashboard.selectedTeamId
    ? hasCapability(
        dashboard.access.memberships,
        "manage_service_recovery",
        dashboard.access.organizationId,
        dashboard.selectedTeamId,
      )
    : false;
  const canManageRefunds = dashboard.selectedTeamId
    ? hasCapability(
        dashboard.access.memberships,
        "manage_refunds",
        dashboard.access.organizationId,
        dashboard.selectedTeamId,
      )
    : false;
  const recovery =
    canManageRecovery && canManageRefunds && dashboard.selectedTeamId
      ? await getTeamRecoveryDashboard({
          customerId: identity.operator.id,
          devOnly: identity.devOnly,
          teamId: dashboard.selectedTeamId,
        })
      : EMPTY_RECOVERY;

  return (
    <div className="route-page operator-page">
      <section className="container page-hero">
        <div className="operator-hero">
          <div>
            <span className="eyebrow">Team-scoped service recovery</span>
            <h1>Complaints, recleans + refunds</h1>
            <p className="lead">
              Keep customer outcomes, schedule corrections, recovery work, and
              externally processed refunds accountable to the team that served the job.
            </p>
          </div>
          <div className="card operator-summary">
            <span>Open cases</span>
            <strong>{recovery.serviceCases.length}</strong>
            <span>Recovery queue</span>
            <strong>{recovery.recoveries.length}</strong>
            <span>Refund records</span>
            <strong>{recovery.refunds.length}</strong>
          </div>
        </div>
        <OperatorTeamNav dashboard={dashboard} current="recovery" />
      </section>

      <section className="container section team-operations-section">
        {!dashboard.selectedTeam && (
          <div className="card empty-operator">
            <h2>Select a team.</h2>
            <p className="copy">Recovery records always follow the team allocated to the job.</p>
          </div>
        )}
        {dashboard.selectedTeam && (!canManageRecovery || !canManageRefunds) && (
          <div className="card operator-locked">
            <span className="eyebrow">Restricted by role</span>
            <h2>Recovery and refunds require owner, GM, or assigned manager access.</h2>
            <p className="copy">
              Shift leads and cleaners can report field issues, but cannot decide
              customer recovery or financial outcomes.
            </p>
          </div>
        )}

        {dashboard.selectedTeam && canManageRecovery && canManageRefunds && (
          <>
            <div className="section-head">
              <div>
                <span className="eyebrow">01 · Customer outcomes</span>
                <h2 className="section-title">Service-case queue</h2>
              </div>
              <p className="copy">
                Only cases linked through this team&apos;s job allocation appear here.
                Resolving a case requires a customer-visible outcome.
              </p>
            </div>
            <div className="ops-list">
              {recovery.serviceCases.map((serviceCase) => {
                const nextStates = (CASE_NEXT[serviceCase.status] ?? []).filter(
                  (next) =>
                    !serviceCase.has_open_refund &&
                    (next !== "reclean_scheduled" || serviceCase.has_scheduled_reclean),
                );
                const caseIsOpen = !["resolved", "closed", "declined", "canceled"].includes(
                  serviceCase.status,
                );
                return (
                  <article className="card operator-panel ops-row" key={serviceCase.id}>
                    <div className="ops-row-head">
                      <div>
                        <strong>
                          {serviceCase.public_reference} · {serviceCase.contact_name}
                        </strong>
                        <small>
                          {label(serviceCase.case_type)} · {formatDateTime(
                            serviceCase.created_at,
                            serviceCase.territory_timezone,
                          )}
                        </small>
                      </div>
                      <span className={`status-badge ${serviceCase.priority}`}>
                        {serviceCase.priority}
                      </span>
                    </div>
                    <p>{serviceCase.details}</p>
                    <p className="copy">
                      Private contact: {serviceCase.contact_email ?? "email not supplied"}
                      {" · "}
                      {serviceCase.contact_phone ?? "phone not supplied"}
                    </p>

                    {nextStates.length > 0 && (
                      <form action={serviceCaseStatusAction} className="inline-ops-form">
                        <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
                        <input type="hidden" name="caseId" value={serviceCase.id} />
                        <input type="hidden" name="from" value={serviceCase.status} />
                        <select name="to" required defaultValue="" aria-label={`Next state for ${serviceCase.public_reference}`}>
                          <option value="" disabled>Next case state</option>
                          {nextStates.map((next) => <option value={next} key={next}>{label(next)}</option>)}
                        </select>
                        <input
                          name="resolutionSummary"
                          maxLength={2000}
                          placeholder="Customer-visible outcome when resolving or closing"
                          aria-label={`Resolution summary for ${serviceCase.public_reference}`}
                        />
                        <button className="btn btn-soft">Update case</button>
                      </form>
                    )}
                    {serviceCase.has_open_refund && (
                      <p className="copy">
                        Finish, decline, or cancel the open refund before changing this case state.
                      </p>
                    )}

                    {serviceCase.case_type === "reschedule" &&
                      serviceCase.status === "action_planned" &&
                      serviceCase.booking_mutation_eligible && (
                        <form action={rescheduleServiceCaseAction} className="ops-form compact">
                          <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
                          <input type="hidden" name="caseId" value={serviceCase.id} />
                          <p className="copy full">
                            Enter local wall-clock time in {serviceCase.territory_timezone}.
                            Capacity, accepted crew, and DST validity are rechecked.
                          </p>
                          <input name="startAt" type="datetime-local" required aria-label={`New start for ${serviceCase.public_reference}`} />
                          <input name="endAt" type="datetime-local" required aria-label={`New end for ${serviceCase.public_reference}`} />
                          <button className="btn btn-primary">Apply capacity-checked reschedule</button>
                        </form>
                      )}

                    {serviceCase.case_type === "cancel" &&
                      serviceCase.status === "action_planned" &&
                      serviceCase.booking_mutation_eligible && (
                        <form action={cancelServiceCaseBookingAction}>
                          <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
                          <input type="hidden" name="caseId" value={serviceCase.id} />
                          <input type="hidden" name="confirmation" value="cancel" />
                          <button className="btn btn-soft">Cancel booking + active schedule</button>
                        </form>
                      )}

                    {caseIsOpen && (
                      <form action={createRecoveryAction} className="ops-form compact">
                        <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
                        <input type="hidden" name="caseId" value={serviceCase.id} />
                        <select name="actionType" aria-label={`Recovery type for ${serviceCase.public_reference}`}>
                          <option value="reclean">Reclean</option>
                          <option value="site_visit">Site visit</option>
                          <option value="apology">Apology</option>
                          <option value="credit_review">Credit review</option>
                          <option value="refund_review">Refund review</option>
                          <option value="crew_coaching">Crew coaching</option>
                          <option value="documentation">Documentation</option>
                          <option value="other">Other</option>
                        </select>
                        <input name="scheduledAt" type="datetime-local" required aria-label={`Recovery target for ${serviceCase.public_reference}`} />
                        <input name="notes" maxLength={2000} placeholder="Scope and completion evidence" aria-label={`Recovery notes for ${serviceCase.public_reference}`} />
                        <button className="btn btn-soft">Plan recovery</button>
                      </form>
                    )}

                    {serviceCase.refund_eligible && (
                      <form action={requestRefundReviewAction} className="ops-form compact refund-form">
                        <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
                        <input type="hidden" name="caseId" value={serviceCase.id} />
                        <input
                          name="amountDollars"
                          type="number"
                          min="0.01"
                          max={(serviceCase.refundable_balance_cents / 100).toFixed(2)}
                          step="0.01"
                          required
                          placeholder="Amount"
                          aria-label={`Refund amount for ${serviceCase.public_reference}`}
                        />
                        <input name="reasonCode" required placeholder="Reason code" aria-label={`Refund reason for ${serviceCase.public_reference}`} />
                        <button className="btn btn-soft">
                          Open refund review · up to {money(serviceCase.refundable_balance_cents)}
                        </button>
                      </form>
                    )}
                  </article>
                );
              })}
              {recovery.serviceCases.length === 0 && (
                <div className="card operator-panel">
                  <p className="copy">No team-allocated service cases are open.</p>
                </div>
              )}
            </div>

            <div className="section-head recovery-section-head">
              <div>
                <span className="eyebrow">02 · Accountable execution</span>
                <h2 className="section-title">Recovery + refund ledgers</h2>
              </div>
              <p className="copy">
                Refund controls record decisions and external receipts. No action on
                this page calls Stripe, transfers money, or purchases anything.
              </p>
            </div>
            <div className="operations-grid">
              <article className="card operator-panel">
                <span className="eyebrow">Recovery queue</span>
                <h2>Planned customer care</h2>
                <div className="ops-ledger-list">
                  {recovery.recoveries.map((item) => (
                    <article key={item.id}>
                      <div>
                        <span className={`status-badge ${item.status}`}>{label(item.status)}</span>
                        <strong>{label(item.action_type)} · {item.public_reference}</strong>
                        <small>
                          {item.owner_label} · {formatDateTime(item.scheduled_at, item.territory_timezone)}
                        </small>
                        {item.notes && <p>{item.notes}</p>}
                      </div>
                      <div className="inline-action-row">
                        {(RECOVERY_NEXT[item.status] ?? []).map((next) => (
                          <form action={recoveryStatusAction} key={next}>
                            <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
                            <input type="hidden" name="recoveryId" value={item.id} />
                            <input type="hidden" name="from" value={item.status} />
                            <input type="hidden" name="to" value={next} />
                            <button className={next === "canceled" ? "btn btn-soft" : "btn btn-primary"}>{label(next)}</button>
                          </form>
                        ))}
                      </div>
                    </article>
                  ))}
                  {recovery.recoveries.length === 0 && <p className="copy">No unfinished recovery actions.</p>}
                </div>
              </article>

              <article className="card operator-panel">
                <span className="eyebrow">Refund decision ledger</span>
                <h2>External processing evidence</h2>
                <div className="ops-ledger-list">
                  {recovery.refunds.map((refund) => (
                    <article key={refund.id}>
                      <div>
                        <span className={`status-badge ${refund.status}`}>{label(refund.status)}</span>
                        <strong>{money(refund.amount_cents)} · {refund.public_reference}</strong>
                        <small>
                          {label(refund.reason_code)}
                          {refund.provider_refund_id ? ` · receipt ${refund.provider_refund_id}` : " · no money movement recorded"}
                        </small>
                      </div>
                      <div className="inline-action-row">
                        {(REFUND_NEXT[refund.status] ?? []).map((next) => (
                          <form action={refundStatusAction} key={next}>
                            <input type="hidden" name="teamId" value={dashboard.selectedTeamId!} />
                            <input type="hidden" name="refundId" value={refund.id} />
                            <input type="hidden" name="from" value={refund.status} />
                            <input type="hidden" name="to" value={next} />
                            {next === "processed" && (
                              <input name="externalReference" required minLength={4} placeholder="External refund receipt" aria-label={`External refund receipt for ${refund.public_reference}`} />
                            )}
                            <button className={next === "canceled" || next === "declined" || next === "failed" ? "btn btn-soft" : "btn btn-primary"}>{label(next)}</button>
                          </form>
                        ))}
                      </div>
                    </article>
                  ))}
                  {recovery.refunds.length === 0 && <p className="copy">No refund decisions for this team.</p>}
                </div>
              </article>
            </div>
            <div className="card operator-panel guardrail-panel">
              <span className="eyebrow">Money boundary</span>
              <h2>Evidence before “processed.”</h2>
              <p className="copy">
                A processed refund requires a reference from the external system that
                actually returned the funds. This application stores that receipt but
                never initiates the transfer.
              </p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
