import "server-only";

import type postgres from "postgres";

import {
  arrivalWindowForStartMinutes,
  evaluateLocalSchedule,
  rescheduleProposalExpiry,
} from "./field-operations";
import { requiredElapsedMinutes } from "./operations-scheduling";
import { localDateTimeToUtc, validateUtcInterval } from "./zoned-datetime";

type Transaction = postgres.TransactionSql;

function localDateTimeMinutes(value: string, label: string) {
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error(`Choose a valid local reschedule ${label}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Choose a valid local reschedule ${label}`);
  }
  return hour * 60 + minute + second / 60;
}

function branchTimeMinutes(value: string, label: string) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(value);
  if (!match) throw new Error(`${label} is not a valid branch time`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59 || second !== 0) {
    throw new Error(`${label} must be a whole-minute branch time`);
  }
  return hour * 60 + minute;
}

function clock(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export async function stageCustomerRescheduleProposal(
  transaction: Transaction,
  input: {
    organizationId: string;
    teamId: string;
    serviceCaseId: string;
    scheduleId: string;
    actorMembershipId: string;
    startLocal: string;
    endLocal: string;
    proposalNote: string;
    devOnly: boolean;
  },
) {
  const rows = await transaction<Array<{
    allocation_id: string;
    booking_id: string;
    customer_id: string;
    timezone: string;
    arrival_window_minutes: number;
    operating_start_time: string;
    latest_arrival_time: string;
    hard_finish_time: string;
    labor_minutes: number;
    required_crew_size: number;
    schedule_status: string;
    current_start_at: string;
    territory_id: string;
    travel_buffer_minutes: number;
  }>>`
    select allocation.id as allocation_id, booking.id as booking_id,
      booking.customer_id, team.timezone, team.arrival_window_minutes,
      team.operating_start_time::text, team.latest_arrival_time::text,
      team.hard_finish_time::text,
      schedule.labor_minutes, schedule.required_crew_size,
      schedule.status as schedule_status, schedule.start_at::text as current_start_at,
      schedule.territory_id,
      schedule.travel_buffer_minutes
    from team_job_allocations allocation
    join cleaning_teams team
      on team.organization_id = allocation.organization_id
     and team.id = allocation.team_id
    join job_schedules schedule on schedule.id = allocation.job_schedule_id
    join bookings booking on booking.id = schedule.booking_id
    join service_cases service_case
      on service_case.id = ${input.serviceCaseId}
     and service_case.booking_id = booking.id
    join workforce_memberships actor
      on actor.id = ${input.actorMembershipId}
     and actor.organization_id = allocation.organization_id
     and actor.status = 'active'
     and (
       (actor.team_id = allocation.team_id and actor.role = 'manager')
       or (actor.team_id is null and actor.role in ('owner','gm'))
     )
    where allocation.organization_id = ${input.organizationId}
      and allocation.team_id = ${input.teamId}
      and schedule.id = ${input.scheduleId}
      and schedule.status in ('tentative','held','confirmed')
      and service_case.case_type = 'reschedule'
      and service_case.status = 'action_planned'
      and booking.customer_id is not null
      and booking.status in ('requested','reviewing','ready','confirmed','scheduled')
      and (${input.devOnly} = false or (
        allocation.is_dev_seed and schedule.is_dev_seed
        and booking.is_dev_seed and service_case.is_dev_seed
      ))
    for update of allocation, schedule, booking, service_case`;
  const row = rows[0];
  if (!row) {
    throw new Error("Reschedule case changed, is unallocated, or is outside your authority");
  }
  if (Date.parse(row.current_start_at) <= Date.now()) {
    throw new Error(
      "Work at or past its current start cannot use the standard reschedule flow; open an execution recovery instead",
    );
  }

  const startAt = localDateTimeToUtc(input.startLocal, row.timezone);
  const endAt = localDateTimeToUtc(input.endLocal, row.timezone);
  validateUtcInterval(startAt, endAt, { maxMinutes: 24 * 60 });
  if (Date.parse(startAt) <= Date.now()) {
    throw new Error("A proposed reschedule must start in the future");
  }
  if (input.startLocal.slice(0, 10) !== input.endLocal.slice(0, 10)) {
    throw new Error("A proposed reschedule must start and finish on the same branch day");
  }
  const startMinutes = localDateTimeMinutes(input.startLocal, "start");
  const endMinutes = localDateTimeMinutes(input.endLocal, "finish");
  const scheduleFit = evaluateLocalSchedule(startMinutes, endMinutes, {
    operatingStartMinutes: branchTimeMinutes(
      row.operating_start_time,
      "Operating start",
    ),
    latestArrivalMinutes: branchTimeMinutes(
      row.latest_arrival_time,
      "Latest arrival",
    ),
    hardFinishMinutes: branchTimeMinutes(row.hard_finish_time, "Hard finish"),
  });
  if (!scheduleFit.eligible) {
    throw new Error(scheduleFit.blockers.join(" "));
  }
  const elapsedMinutes = Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60_000);
  const minimumMinutes = requiredElapsedMinutes(
    row.labor_minutes,
    row.required_crew_size,
  );
  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < minimumMinutes) {
    throw new Error(
      `Reschedule needs at least ${minimumMinutes} elapsed minutes for the existing labor plan`,
    );
  }

  const assigned = await transaction<Array<{ cleaner_id: string }>>`
    select assignment.cleaner_id
    from job_assignments assignment
    join workforce_memberships membership
      on membership.organization_id = ${input.organizationId}
     and membership.team_id = ${input.teamId}
     and membership.cleaner_id = assignment.cleaner_id
     and membership.status = 'active'
     and membership.role in ('cleaner', 'shift_lead')
    where assignment.job_schedule_id = ${input.scheduleId}
      and assignment.team_id = ${input.teamId}
      and assignment.status in ('accepted','confirmed')
      and not exists (
        select 1 from customer_cleaner_preferences preference
        where preference.organization_id = ${input.organizationId}
          and preference.team_id = ${input.teamId}
          and preference.customer_id = ${row.customer_id}
          and preference.cleaner_id = assignment.cleaner_id
          and preference.active and preference.preference = 'avoid'
      )`;
  if (assigned.length < row.required_crew_size) {
    throw new Error("Assign a complete, customer-compatible crew before proposing this change");
  }
  for (const assignment of assigned) {
    await transaction`
      select assert_cleaner_schedule_capacity(
        ${assignment.cleaner_id}, ${input.scheduleId}, ${startAt}, ${endAt},
        ${row.territory_id}, ${row.travel_buffer_minutes}
      )`;
  }

  const window = arrivalWindowForStartMinutes(startMinutes);
  if (!window) {
    throw new Error("Arrival must fall within a supported 8 AM–4 PM branch window");
  }
  if (window.endMinutes - window.startMinutes !== row.arrival_window_minutes) {
    throw new Error("The branch arrival-window policy does not match this scheduling surface");
  }
  const localDate = input.startLocal.slice(0, 10);
  const arrivalWindowStart = localDateTimeToUtc(
    `${localDate}T${clock(window.startMinutes)}`,
    row.timezone,
  );
  const arrivalWindowEnd = localDateTimeToUtc(
    `${localDate}T${clock(window.endMinutes)}`,
    row.timezone,
  );
  const expiresAt = rescheduleProposalExpiry(row.current_start_at, startAt);

  await transaction`
    update schedule_proposals
    set status = 'superseded'
    where job_schedule_id = ${input.scheduleId}
      and service_case_id = ${input.serviceCaseId}
      and status in ('draft','pending_customer','approved','changes_requested')`;
  if (row.schedule_status === "tentative") {
    const held = await transaction<{ id: string }[]>`
      update job_schedules
      set status = 'held', version = version + 1
      where id = ${input.scheduleId} and status = 'tentative'
      returning id`;
    if (!held[0]) throw new Error("Schedule changed; refresh and try again");
  }

  await transaction`
    insert into schedule_proposals
      (organization_id, team_id, team_job_allocation_id, job_schedule_id,
       service_case_id, proposed_start_at, proposed_end_at, customer_id,
       arrival_window_start, arrival_window_end, proposal_note, expires_at,
       is_dev_seed)
    values (${input.organizationId}, ${input.teamId}, ${row.allocation_id},
      ${input.scheduleId}, ${input.serviceCaseId}, ${startAt}, ${endAt},
      ${row.customer_id}, ${arrivalWindowStart}, ${arrivalWindowEnd},
      ${input.proposalNote}, ${expiresAt}, ${input.devOnly})`;
  const cases = await transaction<{ id: string }[]>`
    update service_cases
    set status = 'awaiting_customer', resolution_type = null,
        resolution_summary = null, resolved_at = null, closed_at = null
    where id = ${input.serviceCaseId} and status = 'action_planned'
    returning id`;
  if (!cases[0]) throw new Error("Reschedule case changed; refresh and try again");
  await transaction`
    insert into job_communications
      (organization_id, team_id, team_job_allocation_id, customer_id,
       sender_kind, audience, template_key, body, is_dev_seed)
    values (${input.organizationId}, ${input.teamId}, ${row.allocation_id},
      ${row.customer_id}, 'staff', 'customer', 'arrival_update',
      ${`Lake & Pine proposed ${window.label} for your requested reschedule. Please approve it or request another change in your dashboard.`},
      ${input.devOnly})`;

  return {
    schedule_id: input.scheduleId,
    service_case_id: input.serviceCaseId,
    arrival_window_id: window.id,
  };
}
