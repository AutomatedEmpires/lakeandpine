import type { Metadata } from "next";
import Link from "next/link";

import { resolveOperatorIdentity } from "@/lib/auth";
import {
  getOperationsConsole,
  getScheduleSuggestions,
} from "@/lib/operations-console-data";

import {
  applicationStatusAction,
  cancelCaseBookingAction,
  cleanerAvailabilityAction,
  cleanerCapabilitiesAction,
  cleanerStatusAction,
  createScheduleAction,
  createTerritoryAction,
  onboardCleanerAction,
  postalCodeStatusAction,
  proposeCrewAction,
  removePlanningAssignmentAction,
  qualificationStatusAction,
  recoveryAction,
  recoveryStatusAction,
  rescheduleCaseAction,
  refundStatusAction,
  requestRefundReviewAction,
  retryNotificationAction,
  scheduleStatusAction,
  serviceCaseStatusAction,
  territoryStatusAction,
  timeOffReviewAction,
  updateUnscheduledPreferenceAction,
  verifyCleanerScreeningAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Operations Control",
  robots: { index: false, follow: false },
};

const QUALIFICATION_NEXT: Record<string, string[]> = {
  requested: [
    "needs_information",
    "walkthrough_needed",
    "proposal_sent",
    "declined",
  ],
  needs_information: [
    "requested",
    "walkthrough_needed",
    "proposal_sent",
    "declined",
  ],
  walkthrough_needed: ["proposal_sent", "needs_information", "declined"],
  proposal_sent: ["approved", "needs_information", "declined"],
};
const APPLICATION_NEXT: Record<string, string[]> = {
  submitted: ["reviewing", "declined"],
  reviewing: ["interview", "declined"],
  interview: ["offer", "declined"],
  offer: ["onboarding", "declined"],
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
const REFUND_NEXT: Record<string, string[]> = {
  requested: ["approved", "declined", "canceled"],
  approved: ["ready_for_manual_processing", "canceled"],
  ready_for_manual_processing: ["processed", "failed", "canceled"],
  failed: ["ready_for_manual_processing", "canceled"],
};
const RECOVERY_NEXT: Record<string, string[]> = {
  planned: ["approved", "canceled"],
  approved: ["scheduled", "completed", "canceled"],
  scheduled: ["completed", "approved", "canceled"],
};
const SCHEDULE_NEXT: Record<string, string[]> = {
  tentative: ["held", "canceled"],
  held: ["confirmed", "tentative", "canceled"],
  confirmed: ["en_route", "held", "canceled"],
  en_route: ["in_progress", "confirmed", "canceled"],
  in_progress: ["quality_review", "confirmed"],
  quality_review: ["completed", "in_progress"],
};
const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function label(value: string) {
  return value.replaceAll("_", " ");
}

function formatDateTime(
  value: string,
  timeZone = "America/Los_Angeles",
) {
  return new Date(value).toLocaleString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ schedule?: string }>;
}) {
  const identity = await resolveOperatorIdentity();
  if (identity.state !== "authed" && identity.state !== "preview") {
    return (
      <div className="route-page">
        <section className="container page-hero">
          <div className="page-panel operator-locked">
            <span className="eyebrow">Private operations control</span>
            <h1>
              {identity.state === "denied"
                ? "This account is not an operator."
                : "Operator sign-in required."}
            </h1>
            <p className="lead">
              Territories, applicant records, schedules, complaints, and refund
              decisions are private.
            </p>
            <Link
              className="btn btn-primary"
              href="/sign-in?redirect_url=/operator/operations"
            >
              Sign in
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const data = await getOperationsConsole(identity.devOnly);
  const params = await searchParams;
  const selectedSchedule =
    data.schedules.find((item) => item.id === params.schedule) ??
    data.schedules.find(
      (item) => !["completed", "canceled"].includes(item.status),
    ) ??
    null;
  const suggestions = selectedSchedule
    ? await getScheduleSuggestions(selectedSchedule.id, identity.devOnly)
    : [];
  const selectedAssignments = selectedSchedule
    ? data.assignments.filter(
        (assignment) => assignment.job_schedule_id === selectedSchedule.id,
      )
    : [];
  const scheduledBookingIds = new Set(
    data.schedules.map((item) => item.booking_id),
  );
  const activeTerritories = data.territories.filter(
    (item) => item.status === "active",
  );

  return (
    <div className="route-page operator-page operations-control">
      <section className="container page-hero">
        {identity.state === "preview" && (
          <div className="preview-banner">
            <strong>Demo operations:</strong> only synthetic rows are visible;
            irreversible provider actions are never performed here.
          </div>
        )}
        <div className="operator-hero">
          <div>
            <span className="eyebrow">Private command center</span>
            <h1>Operations control</h1>
            <p className="lead">
              Qualify the work, prove territory capacity, propose an eligible
              crew, and keep service recovery auditable. No button on this page
              moves money.
            </p>
          </div>
          <div className="card operator-summary">
            <span>Qualification queue</span>
            <strong>
              {
                data.qualifications.filter(
                  (item) => item.qualification_status !== "approved",
                ).length
              }
            </strong>
            <span>Open service cases</span>
            <strong>{data.serviceCases.length}</strong>
          </div>
        </div>
        <nav className="operations-tabs" aria-label="Operator workspaces">
          <Link href="/operator">Job workbench</Link>
          <a href="#territories">Territories</a>
          <a href="#people">People</a>
          <a href="#schedule">Scheduling</a>
          <a href="#recovery">Recovery</a>
        </nav>
      </section>

      <section
        id="territories"
        className="container section operator-section operations-section"
      >
        <div className="section-head">
          <div>
            <span className="eyebrow">01 · Areas</span>
            <h2 className="section-title">Capacity-backed territories</h2>
          </div>
          <p className="copy">
            A territory remains draft until at least one postal code and one
            screened, available cleaner are active. Public area pages never
            override this control.
          </p>
        </div>
        <div className="operations-grid">
          <article className="card operator-panel">
            <h3>Create a planning territory</h3>
            <form action={createTerritoryAction} className="ops-form">
              <div className="field">
                <label htmlFor="territory-name">Name</label>
                <input
                  id="territory-name"
                  name="name"
                  required
                  placeholder="Coeur d'Alene core"
                />
              </div>
              <div className="field">
                <label htmlFor="territory-code">Internal code</label>
                <input
                  id="territory-code"
                  name="code"
                  required
                  pattern="[a-z0-9_-]{2,50}"
                  placeholder="cda_core"
                />
              </div>
              <div className="field full">
                <label htmlFor="territory-postal">
                  Postal codes for review
                </label>
                <input
                  id="territory-postal"
                  name="postalCodes"
                  required
                  placeholder="83814, 83815"
                />
              </div>
              <button className="btn btn-primary">Create draft</button>
            </form>
          </article>
          <div className="ops-list">
            {data.territories.map((territory) => (
              <article
                className="card operator-panel ops-row"
                key={territory.id}
              >
                <div className="ops-row-head">
                  <div>
                    <span className="eyebrow">{territory.code}</span>
                    <h3>{territory.name}</h3>
                  </div>
                  <span className={`status-badge ${territory.status}`}>
                    {territory.status}
                  </span>
                </div>
                <p className="copy">
                  Default travel buffer: {territory.travel_buffer_minutes}{" "}
                  minutes · {territory.timezone}
                </p>
                <div className="postal-list">
                  {territory.postal_codes.map((postal) => (
                    <form action={postalCodeStatusAction} key={postal.code}>
                      <input
                        type="hidden"
                        name="territoryId"
                        value={territory.id}
                      />
                      <input
                        type="hidden"
                        name="postalCode"
                        value={postal.code}
                      />
                      <span>{postal.code}</span>
                      <select
                        name="status"
                        defaultValue={postal.status}
                        aria-label={`Status for postal code ${postal.code} in ${territory.name}`}
                      >
                        <option value="review">review</option>
                        <option value="active">active</option>
                        <option value="excluded">excluded</option>
                      </select>
                      <button
                        className="btn btn-soft"
                        aria-label={`Save status for postal code ${postal.code}`}
                      >
                        Save
                      </button>
                    </form>
                  ))}
                </div>
                <form
                  action={territoryStatusAction}
                  className="inline-ops-form"
                >
                  <input
                    type="hidden"
                    name="territoryId"
                    value={territory.id}
                  />
                  <select
                    name="status"
                    defaultValue={territory.status}
                    aria-label={`Status for territory ${territory.name}`}
                  >
                    <option value="draft">draft</option>
                    <option value="active">active</option>
                    <option value="paused">paused</option>
                  </select>
                  <button
                    className="btn btn-soft"
                    aria-label={`Update territory ${territory.name}`}
                  >
                    Update territory
                  </button>
                </form>
              </article>
            ))}
            {data.territories.length === 0 && (
              <div className="card operator-panel">
                <p className="copy">
                  No territory has been created. Scheduling correctly remains
                  unavailable.
                </p>
              </div>
            )}
          </div>
        </div>
      </section>

      <section
        id="people"
        className="section operator-section operations-section section-tint"
      >
        <div className="container">
          <div className="section-head">
            <div>
              <span className="eyebrow">02 · People</span>
              <h2 className="section-title">
                Applications, screening, and availability
              </h2>
            </div>
            <p className="copy">
              The system never auto-hires or fabricates screening. A human moves
              candidates through the pipeline and attests only after
              verification is complete.
            </p>
          </div>
          <div className="operations-grid">
            <div className="ops-list">
              <h3>Applicant queue</h3>
              {data.applications.map((application) => (
                <article
                  className="card operator-panel ops-row"
                  key={application.id}
                >
                  <div className="ops-row-head">
                    <div>
                      <strong>{application.full_name}</strong>
                      <small>
                        {application.public_reference} ·{" "}
                        {application.home_base || "home base not supplied"}
                      </small>
                    </div>
                    <span className={`status-badge ${application.status}`}>
                      {label(application.status)}
                    </span>
                  </div>
                  <p className="copy">
                    Programs:{" "}
                    {application.service_interests.join(", ") || "not selected"}
                  </p>
                  <form
                    action={applicationStatusAction}
                    className="inline-ops-form"
                  >
                    <input
                      type="hidden"
                      name="applicationId"
                      value={application.id}
                    />
                    <input
                      type="hidden"
                      name="from"
                      value={application.status}
                    />
                    <select
                      name="to"
                      defaultValue=""
                      aria-label={`Next application decision for ${application.full_name}`}
                    >
                      <option value="" disabled>
                        Next decision
                      </option>
                      {(APPLICATION_NEXT[application.status] ?? []).map(
                        (next) => (
                          <option key={next} value={next}>
                            {label(next)}
                          </option>
                        ),
                      )}
                    </select>
                    <button
                      className="btn btn-soft"
                      aria-label={`Record application decision for ${application.full_name}`}
                    >
                      Record decision
                    </button>
                  </form>
                  {application.status === "offer" && (
                    <form
                      action={onboardCleanerAction}
                      className="inline-ops-form"
                    >
                      <input
                        type="hidden"
                        name="applicationId"
                        value={application.id}
                      />
                      <select
                        name="territoryId"
                        required
                        defaultValue=""
                        aria-label={`Home territory for ${application.full_name}`}
                      >
                        <option value="" disabled>
                          Home territory
                        </option>
                        {data.territories.map((territory) => (
                          <option key={territory.id} value={territory.id}>
                            {territory.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn btn-primary"
                        aria-label={`Create onboarding profile for ${application.full_name}`}
                      >
                        Create onboarding profile
                      </button>
                    </form>
                  )}
                </article>
              ))}
              {data.applications.length === 0 && (
                <div className="card operator-panel">
                  <p className="copy">No open applications.</p>
                </div>
              )}
            </div>
            <div className="ops-list">
              <h3>Cleaner readiness</h3>
              {data.cleaners.map((cleaner) => (
                <article
                  className="card operator-panel ops-row"
                  key={cleaner.id}
                >
                  <div className="ops-row-head">
                    <div>
                      <strong>{cleaner.full_name}</strong>
                      <small>
                        {cleaner.home_territory_name ?? "No territory"} ·{" "}
                        {cleaner.availability_count} availability rules
                      </small>
                    </div>
                    <span className={`status-badge ${cleaner.status}`}>
                      {cleaner.status}
                    </span>
                  </div>
                  <p className="copy">
                    Screening: {label(cleaner.screening_status)} · Programs:{" "}
                    {cleaner.vertical_experience.join(", ") || "not recorded"}
                  </p>
                  <form
                    action={cleanerCapabilitiesAction}
                    className="ops-form"
                  >
                    <input type="hidden" name="cleanerId" value={cleaner.id} />
                    <div className="field">
                      <label htmlFor={`cleaner-skills-${cleaner.id}`}>
                        Capability codes
                      </label>
                      <input
                        id={`cleaner-skills-${cleaner.id}`}
                        name="skills"
                        defaultValue={cleaner.skills.join(", ")}
                        placeholder="estate-care, finish-awareness"
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`cleaner-programs-${cleaner.id}`}>
                        Verified program experience
                      </label>
                      <input
                        id={`cleaner-programs-${cleaner.id}`}
                        name="verticalExperience"
                        defaultValue={cleaner.vertical_experience.join(", ")}
                        placeholder="estate, construction"
                      />
                    </div>
                    <button
                      className="btn btn-soft"
                      aria-label={`Record reviewed capabilities for ${cleaner.full_name}`}
                    >
                      Record reviewed capabilities
                    </button>
                  </form>
                  {cleaner.status === "onboarding" &&
                    cleaner.screening_status !== "verified" && (
                      <form action={verifyCleanerScreeningAction}>
                        <input
                          type="hidden"
                          name="cleanerId"
                          value={cleaner.id}
                        />
                        <input
                          type="hidden"
                          name="attestation"
                          value="verified"
                        />
                        <button
                          className="btn btn-soft"
                          aria-label={`Attest verified screening for ${cleaner.full_name}`}
                        >
                          Attest verified screening
                        </button>
                      </form>
                    )}
                  {cleaner.home_territory_id && (
                    <form
                      action={cleanerAvailabilityAction}
                      className="ops-form compact"
                    >
                      <input
                        type="hidden"
                        name="cleanerId"
                        value={cleaner.id}
                      />
                      <input
                        type="hidden"
                        name="territoryId"
                        value={cleaner.home_territory_id}
                      />
                      <select
                        name="dayOfWeek"
                        aria-label={`Availability day for ${cleaner.full_name}`}
                      >
                        {DAYS.map((day, index) => (
                          <option key={day} value={index}>
                            {day}
                          </option>
                        ))}
                      </select>
                      <input
                        name="startTime"
                        type="time"
                        required
                        aria-label={`Availability start for ${cleaner.full_name}`}
                      />
                      <input
                        name="endTime"
                        type="time"
                        required
                        aria-label={`Availability end for ${cleaner.full_name}`}
                      />
                      <button
                        className="btn btn-soft"
                        aria-label={`Add availability for ${cleaner.full_name}`}
                      >
                        Add availability
                      </button>
                    </form>
                  )}
                  <form
                    action={cleanerStatusAction}
                    className="inline-ops-form"
                  >
                    <input type="hidden" name="cleanerId" value={cleaner.id} />
                    <select
                      name="status"
                      aria-label={`Status for cleaner ${cleaner.full_name}`}
                      defaultValue={
                        cleaner.status === "onboarding"
                          ? "active"
                          : cleaner.status
                      }
                    >
                      <option value="active">active</option>
                      <option value="paused">paused</option>
                      <option value="inactive">inactive</option>
                    </select>
                    <button
                      className="btn btn-soft"
                      aria-label={`Update status for cleaner ${cleaner.full_name}`}
                    >
                      Update status
                    </button>
                  </form>
                </article>
              ))}
              {data.cleaners.length === 0 && (
                <div className="card operator-panel">
                  <p className="copy">
                    No cleaner profiles. Territory activation remains blocked.
                  </p>
                </div>
              )}
            </div>
          </div>
          {data.timeOff.length > 0 && (
            <div className="card operator-panel timeoff-ops">
              <h3>Time-off decisions</h3>
              {data.timeOff.map((item) => (
                <div key={item.id}>
                  <div>
                    <strong>{item.cleaner_name}</strong>
                    <span>
                      {formatDateTime(item.start_at, item.territory_timezone)} →{" "}
                      {formatDateTime(item.end_at, item.territory_timezone)} ·{" "}
                      {label(item.reason_category)}
                    </span>
                  </div>
                  <form action={timeOffReviewAction}>
                    <input type="hidden" name="timeOffId" value={item.id} />
                    <button
                      className="btn btn-soft"
                      name="status"
                      value="declined"
                      aria-label={`Decline time-off request for ${item.cleaner_name}`}
                    >
                      Decline
                    </button>
                    <button
                      className="btn btn-primary"
                      name="status"
                      value="approved"
                      aria-label={`Approve time-off request for ${item.cleaner_name}`}
                    >
                      Approve
                    </button>
                  </form>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section
        id="schedule"
        className="container section operator-section operations-section"
      >
        <div className="section-head">
          <div>
            <span className="eyebrow">03 · Scheduling</span>
            <h2 className="section-title">
              Qualify first. Then schedule intelligently.
            </h2>
          </div>
          <p className="copy">
            Hard gates cover scope approval, safe access, utilities, specialty
            restrictions, territorial fit, availability, time off, overlapping
            work, travel buffers, and daily/weekly capacity.
          </p>
        </div>
        <div className="ops-list qualification-list">
          {data.qualifications.map((request) => (
            <article className="card operator-panel ops-row" key={request.id}>
              <div className="ops-row-head">
                <div>
                  <strong>{request.contact_name}</strong>
                  <small>
                    {request.service_vertical} · {request.contact_zip} · prefers{" "}
                    {request.scheduled_date} {request.scheduled_window}
                  </small>
                </div>
                <span
                  className={`status-badge ${request.qualification_status}`}
                >
                  {label(request.qualification_status)}
                </span>
              </div>
              <p className="copy">
                Plan: {request.estimated_duration_minutes ?? "review"} labor
                minutes · {request.required_crew_size} crew ·{" "}
                {request.required_skills.join(", ")}
              </p>
              {request.qualification_status !== "approved" && (
                <form
                  action={qualificationStatusAction}
                  className="qualification-form"
                >
                  <input type="hidden" name="bookingId" value={request.id} />
                  <input
                    type="hidden"
                    name="from"
                    value={request.qualification_status}
                  />
                  <input
                    type="hidden"
                    name="vertical"
                    value={request.service_vertical}
                  />
                  <div className="qualification-checks">
                    <label>
                      <input type="checkbox" name="siteReady" /> Safe
                      site/access
                    </label>
                    <label>
                      <input type="checkbox" name="utilitiesReady" /> Utilities
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        name="finishRestrictionsAcknowledged"
                      />{" "}
                      Finish restrictions
                    </label>
                    {request.service_vertical === "construction" && (
                      <label>
                        <input type="checkbox" name="constructionReady" />{" "}
                        Trades complete
                      </label>
                    )}
                    {request.service_vertical === "marine" && (
                      <label>
                        <input type="checkbox" name="dockAccessReady" /> Vessel
                        access
                      </label>
                    )}
                  </div>
                  <select
                    name="to"
                    required
                    defaultValue=""
                    aria-label={`Qualification decision for ${request.contact_name}`}
                  >
                    <option value="" disabled>
                      Qualification decision
                    </option>
                    {(
                      QUALIFICATION_NEXT[request.qualification_status] ?? []
                    ).map((next) => (
                      <option value={next} key={next}>
                        {label(next)}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn-primary"
                    aria-label={`Record qualification review for ${request.contact_name}`}
                  >
                    Record review
                  </button>
                </form>
              )}
              {request.qualification_status === "approved" &&
                !scheduledBookingIds.has(request.id) && (
                  <form
                    action={createScheduleAction}
                    className="ops-form compact schedule-form"
                  >
                    <input type="hidden" name="bookingId" value={request.id} />
                    <select
                      name="territoryId"
                      required
                      defaultValue=""
                      aria-label={`Active territory for ${request.contact_name}`}
                    >
                      <option value="" disabled>
                        Active territory
                      </option>
                      {activeTerritories.map((territory) => (
                        <option key={territory.id} value={territory.id}>
                          {territory.name} · {territory.timezone}
                        </option>
                      ))}
                    </select>
                    <p className="copy">
                      Enter wall-clock time in the timezone shown for the selected
                      territory. DST gaps and repeated times are rejected.
                    </p>
                    <input
                      name="startAt"
                      type="datetime-local"
                      required
                      aria-label={`Schedule start for ${request.contact_name}`}
                    />
                    <input
                      name="endAt"
                      type="datetime-local"
                      required
                      aria-label={`Schedule end for ${request.contact_name}`}
                    />
                    <button
                      className="btn btn-primary"
                      aria-label={`Create tentative schedule for ${request.contact_name}`}
                    >
                      Create tentative schedule
                    </button>
                  </form>
                )}
            </article>
          ))}
          {data.qualifications.length === 0 && (
            <div className="card operator-panel">
              <p className="copy">
                No premium requests in the qualification queue.
              </p>
            </div>
          )}
        </div>

        <div className="schedule-console">
          <aside className="card operator-panel">
            <span className="eyebrow">Scheduled work</span>
            <div className="schedule-list">
              {data.schedules.map((schedule) => (
                <div
                  className={
                    selectedSchedule?.id === schedule.id
                      ? "schedule-entry selected"
                      : "schedule-entry"
                  }
                  key={schedule.id}
                >
                  <Link
                    href={`/operator/operations?schedule=${schedule.id}#schedule`}
                  >
                    <strong>
                      {schedule.service_vertical} · {schedule.territory_name}
                    </strong>
                    <span>
                      {formatDateTime(schedule.start_at, schedule.territory_timezone)} ·{" "}
                      {schedule.assignment_count}/{schedule.required_crew_size}{" "}
                      accepted · {label(schedule.status)}
                    </span>
                  </Link>
                  <div className="schedule-actions">
                    {(SCHEDULE_NEXT[schedule.status] ?? []).map((next) => (
                      <form action={scheduleStatusAction} key={next}>
                        <input
                          type="hidden"
                          name="scheduleId"
                          value={schedule.id}
                        />
                        <input
                          type="hidden"
                          name="from"
                          value={schedule.status}
                        />
                        <button
                          className="btn btn-soft"
                          name="to"
                          value={next}
                          aria-label={`${label(next)} schedule for ${schedule.service_vertical} in ${schedule.territory_name} starting ${formatDateTime(schedule.start_at, schedule.territory_timezone)}`}
                        >
                          {label(next)}
                        </button>
                      </form>
                    ))}
                  </div>
                </div>
              ))}
              {data.schedules.length === 0 && (
                <p className="copy">No schedules yet.</p>
              )}
            </div>
          </aside>
          <article className="card operator-panel">
            <span className="eyebrow">Explainable crew suggestions</span>
            <h3>
              {selectedSchedule
                ? `${selectedSchedule.service_vertical} · ${formatDateTime(selectedSchedule.start_at, selectedSchedule.territory_timezone)}`
                : "Select a schedule"}
            </h3>
            {selectedSchedule && selectedAssignments.length > 0 && (
              <div className="ops-list" style={{ marginBottom: 16 }}>
                <strong>Current planning cohort</strong>
                {selectedAssignments.map((assignment) => (
                  <form
                    action={removePlanningAssignmentAction}
                    className="inline-ops-form"
                    key={assignment.id}
                  >
                    <input
                      type="hidden"
                      name="assignmentId"
                      value={assignment.id}
                    />
                    <span>
                      {assignment.cleaner_name} ·{" "}
                      {label(assignment.assignment_role)} · {label(assignment.status)}
                    </span>
                    <button
                      className="btn btn-soft"
                      aria-label={`Remove ${assignment.cleaner_name} from this tentative planning schedule`}
                    >
                      Remove from plan
                    </button>
                  </form>
                ))}
              </div>
            )}
            {suggestions.map((suggestion) => (
              <div
                className={`crew-suggestion ${suggestion.eligible ? "eligible" : "blocked"}`}
                key={suggestion.candidateId}
              >
                <div>
                  <strong>{suggestion.cleanerNames.join(" + ")}</strong>
                  <span>
                    {suggestion.eligible
                      ? `Score ${suggestion.score}`
                      : "Blocked"}
                  </span>
                </div>
                <p>
                  {(suggestion.eligible
                    ? suggestion.reasons
                    : suggestion.blockers
                  ).join(" · ")}
                </p>
                {suggestion.eligible && selectedSchedule && (
                  <form action={proposeCrewAction}>
                    <input
                      type="hidden"
                      name="scheduleId"
                      value={selectedSchedule.id}
                    />
                    <input
                      type="hidden"
                      name="candidateId"
                      value={suggestion.candidateId}
                    />
                    <button
                      className="btn btn-primary"
                      aria-label={`Propose crew ${suggestion.cleanerNames.join(" and ")}`}
                    >
                      Propose this crew
                    </button>
                  </form>
                )}
              </div>
            ))}
            {selectedSchedule && suggestions.length === 0 && (
              <p className="copy">
                No complete crew combination is currently eligible. Add screened
                cleaners and matching availability; do not force an assignment.
              </p>
            )}
          </article>
        </div>
      </section>

      <section
        id="recovery"
        className="section operator-section operations-section section-tint"
      >
        <div className="container">
          <div className="section-head">
            <div>
              <span className="eyebrow">04 · Service recovery</span>
              <h2 className="section-title">
                Reschedules, complaints, recleans, and refunds
              </h2>
            </div>
            <p className="copy">
              Cases have an immutable lifecycle trail. Refund rows document
              decisions and external receipts; they never call Stripe or move
              money.
            </p>
          </div>
          <div className="operations-grid">
            <div className="ops-list">
              {data.serviceCases.map((serviceCase) => (
                <article
                  className="card operator-panel ops-row"
                  key={serviceCase.id}
                >
                  <div className="ops-row-head">
                    <div>
                      <strong>
                        {serviceCase.public_reference} ·{" "}
                        {serviceCase.contact_name}
                      </strong>
                      <small>
                        {label(serviceCase.case_type)} ·{" "}
                        {formatDateTime(serviceCase.created_at)}
                      </small>
                    </div>
                    <span className={`status-badge ${serviceCase.priority}`}>
                      {serviceCase.priority}
                    </span>
                  </div>
                  <p className="copy">
                    Private contact: {serviceCase.contact_email ?? "email not supplied"}
                    {" · "}
                    {serviceCase.contact_phone ?? "phone not supplied"}
                  </p>
                  <p>{serviceCase.details}</p>
                  {!serviceCase.booking_id && (
                    <p className="copy">
                      Unlinked case · no booking mutation is available. Contact the
                      customer using the private details above and obtain a verified
                      service reference before changing a booking.
                    </p>
                  )}
                  {serviceCase.booking_id &&
                    ["reschedule", "cancel"].includes(serviceCase.case_type) &&
                    !serviceCase.booking_mutation_eligible && (
                      <p className="copy">
                        Service is already underway or closed · schedule mutation is
                        disabled. Use complaint/recovery controls instead.
                      </p>
                    )}
                  <form
                    action={serviceCaseStatusAction}
                    className="inline-ops-form"
                  >
                    <input type="hidden" name="caseId" value={serviceCase.id} />
                    <input
                      type="hidden"
                      name="from"
                      value={serviceCase.status}
                    />
                    <select
                      name="to"
                      defaultValue=""
                      required
                      aria-label={`Next state for service case ${serviceCase.public_reference}`}
                    >
                      <option value="" disabled>
                        Next case state
                      </option>
                      {(CASE_NEXT[serviceCase.status] ?? [])
                        .filter(
                          (next) =>
                            !serviceCase.has_open_refund &&
                            (next !== "reclean_scheduled" ||
                              serviceCase.has_scheduled_reclean),
                        )
                        .map((next) => (
                        <option value={next} key={next}>
                          {label(next)}
                        </option>
                      ))}
                    </select>
                    <input
                      name="resolutionSummary"
                      maxLength={2000}
                      placeholder="Customer-visible outcome (required to resolve or close)"
                      aria-label={`Resolution summary for service case ${serviceCase.public_reference}`}
                    />
                    <button
                      className="btn btn-soft"
                      aria-label={`Update service case ${serviceCase.public_reference}`}
                    >
                      Update case
                    </button>
                  </form>
                  {serviceCase.has_open_refund && (
                    <p className="copy">
                      Finish, decline, or cancel the open refund decision before
                      changing this case state.
                    </p>
                  )}
                  {serviceCase.case_type === "reschedule" &&
                    serviceCase.booking_mutation_eligible &&
                    !serviceCase.has_schedule &&
                    serviceCase.status === "action_planned" && (
                      <form
                        action={updateUnscheduledPreferenceAction}
                        className="ops-form compact"
                      >
                        <input
                          type="hidden"
                          name="caseId"
                          value={serviceCase.id}
                        />
                        <input
                          name="preferredDate"
                          type="date"
                          required
                          aria-label={`New preferred date for unscheduled service case ${serviceCase.public_reference}`}
                        />
                        <button className="btn btn-primary">
                          Update preference · no appointment
                        </button>
                      </form>
                    )}
                  {serviceCase.case_type === "reschedule" &&
                    serviceCase.booking_mutation_eligible &&
                    serviceCase.has_schedule &&
                    serviceCase.status === "action_planned" && (
                      <form
                        action={rescheduleCaseAction}
                        className="ops-form compact"
                      >
                        <input
                          type="hidden"
                          name="caseId"
                          value={serviceCase.id}
                        />
                        <p className="copy">
                          Enter wall-clock time in {serviceCase.territory_timezone}.
                          DST gaps and repeated times are rejected.
                        </p>
                        <input
                          name="startAt"
                          type="datetime-local"
                          required
                          aria-label={`New start for service case ${serviceCase.public_reference}`}
                        />
                        <input
                          name="endAt"
                          type="datetime-local"
                          required
                          aria-label={`New end for service case ${serviceCase.public_reference}`}
                        />
                        <button
                          className="btn btn-primary"
                          aria-label={`Apply capacity-checked reschedule for case ${serviceCase.public_reference}`}
                        >
                          Apply capacity-checked reschedule
                        </button>
                      </form>
                    )}
                  {serviceCase.case_type === "cancel" &&
                    serviceCase.booking_mutation_eligible &&
                    serviceCase.status === "action_planned" && (
                      <form action={cancelCaseBookingAction}>
                        <input
                          type="hidden"
                          name="caseId"
                          value={serviceCase.id}
                        />
                        <input
                          type="hidden"
                          name="confirmation"
                          value="cancel"
                        />
                        <button
                          className="btn btn-soft"
                          aria-label={`Cancel booking and active schedule for case ${serviceCase.public_reference}`}
                        >
                          Cancel booking + active schedule
                        </button>
                      </form>
                    )}
                  {!["resolved", "closed", "declined", "canceled"].includes(
                    serviceCase.status,
                  ) && (
                  <form action={recoveryAction} className="ops-form compact">
                    <input type="hidden" name="caseId" value={serviceCase.id} />
                    <select
                      name="type"
                      aria-label={`Recovery action for service case ${serviceCase.public_reference}`}
                    >
                      <option value="reclean">Reclean</option>
                      <option value="site_visit">Site visit</option>
                      <option value="apology">Apology</option>
                      <option value="credit_review">Credit review</option>
                      <option value="refund_review">Refund review</option>
                      <option value="crew_coaching">Crew coaching</option>
                      <option value="documentation">Documentation</option>
                    </select>
                    <input
                      name="ownerLabel"
                      required
                      maxLength={120}
                      placeholder="Owner"
                      aria-label={`Recovery owner for service case ${serviceCase.public_reference}`}
                    />
                    <input
                      name="scheduledAt"
                      type="datetime-local"
                      required
                      aria-label={`Recovery target time in ${serviceCase.territory_timezone} for service case ${serviceCase.public_reference}`}
                    />
                    <input
                      name="notes"
                      maxLength={2000}
                      placeholder="Scope, handoff, and completion evidence needed"
                      aria-label={`Recovery notes for service case ${serviceCase.public_reference}`}
                    />
                    <p className="copy">
                      Target time uses {serviceCase.territory_timezone}. Reclean
                      timing is a separate recovery plan, not a confirmed main
                      appointment or crew assignment.
                    </p>
                    <button
                      className="btn btn-soft"
                      aria-label={`Plan recovery for service case ${serviceCase.public_reference}`}
                    >
                      Plan recovery
                    </button>
                  </form>
                  )}
                  {serviceCase.refund_eligible && (
                    <form
                      action={requestRefundReviewAction}
                      className="ops-form compact refund-form"
                    >
                      <input
                        type="hidden"
                        name="caseId"
                        value={serviceCase.id}
                      />
                      <input
                        name="amountDollars"
                        type="number"
                        min="1"
                        max={(
                          serviceCase.refundable_balance_cents / 100
                        ).toFixed(2)}
                        step="0.01"
                        required
                        placeholder="Amount for review"
                        aria-label={`Refund amount to review for service case ${serviceCase.public_reference}`}
                      />
                      <input
                        name="reasonCode"
                        required
                        placeholder="Reason code"
                        aria-label={`Refund reason code for service case ${serviceCase.public_reference}`}
                      />
                      <button
                        className="btn btn-soft"
                        aria-label={`Open refund review for service case ${serviceCase.public_reference}`}
                      >
                        Open refund review · up to $
                        {(serviceCase.refundable_balance_cents / 100).toFixed(2)}
                      </button>
                    </form>
                  )}
                </article>
              ))}
              {data.serviceCases.length === 0 && (
                <div className="card operator-panel">
                  <p className="copy">No open service cases.</p>
                </div>
              )}
            </div>
            <div className="ops-list">
              <h3>Recovery action queue</h3>
              {data.recoveries.map((recovery) => (
                <article
                  className="card operator-panel ops-row"
                  key={recovery.id}
                >
                  <div className="ops-row-head">
                    <div>
                      <strong>
                        {label(recovery.action_type)} · {recovery.public_reference}
                      </strong>
                      <small>
                        Owner {recovery.owner_label} · {recovery.scheduled_at
                          ? formatDateTime(
                              recovery.scheduled_at,
                              recovery.territory_timezone,
                            )
                          : "target not set"} · {recovery.territory_timezone}
                      </small>
                    </div>
                    <span className={`status-badge ${recovery.status}`}>
                      {label(recovery.status)}
                    </span>
                  </div>
                  {recovery.notes && <p>{recovery.notes}</p>}
                  {(RECOVERY_NEXT[recovery.status] ?? []).map((next) => (
                    <form
                      action={recoveryStatusAction}
                      className="inline-ops-form"
                      key={next}
                    >
                      <input type="hidden" name="recoveryId" value={recovery.id} />
                      <input type="hidden" name="from" value={recovery.status} />
                      <input type="hidden" name="to" value={next} />
                      <button
                        className="btn btn-soft"
                        aria-label={`${label(next)} ${label(recovery.action_type)} recovery plan ${recovery.public_reference}`}
                      >
                        {label(next)}
                      </button>
                    </form>
                  ))}
                </article>
              ))}
              {data.recoveries.length === 0 && (
                <div className="card operator-panel">
                  <p className="copy">No open recovery actions.</p>
                </div>
              )}
              <h3>Refund decision ledger</h3>
              {data.refunds.map((refund) => (
                <article
                  className="card operator-panel ops-row"
                  key={refund.id}
                >
                  <div className="ops-row-head">
                    <div>
                      <strong>
                        ${(refund.amount_cents / 100).toFixed(2)} ·{" "}
                        {label(refund.reason_code)}
                      </strong>
                      <small>
                        {refund.provider_refund_id
                          ? `External receipt ${refund.provider_refund_id}`
                          : "No money movement recorded"}
                      </small>
                    </div>
                    <span className={`status-badge ${refund.status}`}>
                      {label(refund.status)}
                    </span>
                  </div>
                  {(REFUND_NEXT[refund.status] ?? []).map((next) => (
                    <form
                      action={refundStatusAction}
                      className="inline-ops-form"
                      key={next}
                    >
                      <input type="hidden" name="refundId" value={refund.id} />
                      <input type="hidden" name="from" value={refund.status} />
                      <input type="hidden" name="to" value={next} />
                      {next === "processed" && (
                        <input
                          name="providerReference"
                          required
                          placeholder="External refund receipt"
                          aria-label={`External receipt for ${label(refund.reason_code)} refund`}
                        />
                      )}
                      <button
                        className="btn btn-soft"
                        aria-label={`${label(next)} ${label(refund.reason_code)} refund for $${(refund.amount_cents / 100).toFixed(2)}`}
                      >
                        {label(next)}
                      </button>
                    </form>
                  ))}
                </article>
              ))}
              {data.refunds.length === 0 && (
                <div className="card operator-panel">
                  <p className="copy">No refund decisions recorded.</p>
                </div>
              )}
              <article className="card operator-panel">
                <h3>Notification outbox</h3>
                <div className="outbox-summary">
                  {data.outbox.map((item) => (
                    <div key={item.status}>
                      <span>{label(item.status)}</span>
                      <strong>{item.count}</strong>
                    </div>
                  ))}
                  {data.outbox.length === 0 && (
                    <p className="copy">No queued notifications.</p>
                  )}
                </div>
                {data.outboxQueue.length > 0 && (
                  <div className="outbox-queue">
                    {data.outboxQueue.map((item) => (
                      <form action={retryNotificationAction} key={item.id}>
                        <input type="hidden" name="outboxId" value={item.id} />
                        <div>
                          <strong>{label(item.notification_type)}</strong>
                          <span>
                            {item.recipient_kind} · {item.status} · attempt {item.attempt_count}
                            {item.last_error_code
                              ? ` · ${label(item.last_error_code)}`
                              : ""}
                          </span>
                        </div>
                        <button
                          className="btn btn-soft"
                          aria-label={`Retry ${label(item.notification_type)} notification to ${item.recipient_kind}`}
                        >
                          Retry safely
                        </button>
                      </form>
                    ))}
                  </div>
                )}
              </article>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
