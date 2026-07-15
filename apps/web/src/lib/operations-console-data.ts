import "server-only";

import type postgres from "postgres";

import { sql } from "./db";
import { stageCustomerRescheduleProposal } from "./field-reschedule";
import {
  buildBoundedCrewGroups,
  rankAssignmentSuggestions,
  requiredElapsedMinutes,
  type AssignmentCandidate,
  type AssignmentSuggestion,
  type CleanerCapacity,
  type SchedulingJob,
  type ServiceVertical,
} from "./operations-scheduling";
import { localDateTimeToUtc, validateUtcInterval } from "./zoned-datetime";

export type TerritoryRow = {
  id: string;
  code: string;
  name: string;
  timezone: string;
  status: "draft" | "active" | "paused";
  travel_buffer_minutes: number;
  postal_codes: { code: string; status: string }[];
  is_dev_seed: boolean;
};

export type CleanerOpsRow = {
  id: string;
  full_name: string;
  email: string | null;
  status: string;
  screening_status: string;
  home_territory_id: string | null;
  home_territory_name: string | null;
  skills: string[];
  vertical_experience: string[];
  availability_count: number;
  is_dev_seed: boolean;
};

export type ApplicationRow = {
  id: string;
  public_reference: string;
  full_name: string;
  email: string;
  home_base: string | null;
  service_interests: string[];
  status: string;
  created_at: string;
  is_dev_seed: boolean;
};

export type QualificationRow = {
  id: string;
  service_vertical: ServiceVertical;
  scheduled_date: string;
  scheduled_window: string;
  qualification_status: string;
  required_crew_size: number;
  estimated_duration_minutes: number | null;
  required_skills: string[];
  contact_name: string;
  contact_zip: string;
  is_dev_seed: boolean;
};

export type ScheduleRow = {
  id: string;
  booking_id: string;
  service_vertical: ServiceVertical;
  territory_id: string;
  territory_name: string;
  territory_timezone: string;
  start_at: string;
  end_at: string;
  status: string;
  required_crew_size: number;
  required_skills: string[];
  labor_minutes: number;
  travel_buffer_minutes: number;
  assignment_count: number;
  is_dev_seed: boolean;
};

export type AssignmentOpsRow = {
  id: string;
  job_schedule_id: string;
  cleaner_name: string;
  assignment_role: string;
  status: string;
};

export type ServiceCaseRow = {
  id: string;
  public_reference: string;
  case_type: string;
  booking_id: string | null;
  booking_mutation_eligible: boolean;
  contact_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  status: string;
  priority: string;
  details: string;
  created_at: string;
  refundable_balance_cents: number;
  refund_eligible: boolean;
  has_open_refund: boolean;
  has_schedule: boolean;
  has_scheduled_reclean: boolean;
  territory_timezone: string;
  is_dev_seed: boolean;
};

export type RefundRow = {
  id: string;
  service_case_id: string;
  booking_id: string;
  amount_cents: number;
  status: string;
  provider: string;
  reason_code: string;
  provider_refund_id: string | null;
  created_at: string;
};

export type RecoveryRow = {
  id: string;
  public_reference: string;
  action_type: string;
  status: string;
  owner_label: string;
  scheduled_at: string | null;
  completed_at: string | null;
  notes: string | null;
  territory_timezone: string;
};

export type TimeOffOpsRow = {
  id: string;
  cleaner_id: string;
  cleaner_name: string;
  start_at: string;
  end_at: string;
  status: string;
  reason_category: string;
  territory_timezone: string;
  is_dev_seed: boolean;
  version: number;
};

export type OutboxSummary = { status: string; count: number };
export type OutboxQueueRow = {
  id: string;
  booking_id: string;
  notification_type: string;
  recipient_kind: string;
  status: string;
  attempt_count: number;
  last_error_code: string | null;
  created_at: string;
};

type QueryClient = typeof sql | postgres.TransactionSql;

export async function withStaffActor<T>(
  customerId: string,
  run: (transaction: postgres.TransactionSql) => Promise<T>,
) {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_customer_id', ${customerId}, true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select private.lock_current_workforce_access(${customerId})`;
    const access = await transaction<{ id: string }[]>`
      select id from workforce_memberships
      where customer_id = ${customerId} and team_id is null
        and role in ('owner','gm') and status = 'active'
      limit 1`;
    if (!access[0]) {
      throw new Error("Owner or GM access is required for national service operations");
    }
    return run(transaction);
  });
}

export async function getOperationsConsole(customerId: string, devOnly: boolean) {
  return withStaffActor(customerId, async (query) => {
  const [
    territories,
    cleaners,
    applications,
    qualifications,
    schedules,
    assignments,
    serviceCases,
    recoveries,
    refunds,
    timeOff,
    outbox,
    outboxQueue,
  ] = await Promise.all([
    query<TerritoryRow[]>`
      select t.id, t.code, t.name, t.timezone, t.status, t.travel_buffer_minutes, t.is_dev_seed,
             coalesce(jsonb_agg(jsonb_build_object('code', p.postal_code, 'status', p.status)
               order by p.postal_code) filter (where p.postal_code is not null), '[]') as postal_codes
      from service_territories t
      left join territory_postal_codes p on p.territory_id = t.id
      where (${devOnly} = false or t.is_dev_seed)
      group by t.id order by t.name`,
    query<CleanerOpsRow[]>`
      select c.id, c.full_name, c.email, c.status, c.screening_status,
             c.home_territory_id, t.name as home_territory_name, c.skills,
             c.vertical_experience, c.is_dev_seed,
             count(a.id)::int as availability_count
      from cleaners c
      left join service_territories t on t.id = c.home_territory_id
      left join cleaner_availability_rules a on a.cleaner_id = c.id and a.status = 'active'
      where (${devOnly} = false or c.is_dev_seed)
      group by c.id, t.name order by c.full_name`,
    query<ApplicationRow[]>`
      select id, public_reference, full_name, email, home_base, service_interests,
             status, created_at::text, is_dev_seed
      from cleaner_applications
      where (${devOnly} = false or is_dev_seed)
        and status not in ('declined', 'withdrawn')
      order by created_at desc limit 50`,
    query<QualificationRow[]>`
      select id, service_vertical, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date,
             scheduled_window, qualification_status, required_crew_size,
             estimated_duration_minutes, required_skills,
             coalesce(contact ->> 'name', 'Unnamed request') as contact_name,
             coalesce(contact ->> 'zip', 'ZIP not supplied') as contact_zip, is_dev_seed
      from bookings
      where service_vertical is not null and (${devOnly} = false or is_dev_seed)
        and qualification_status not in ('declined')
        and status not in ('completed', 'follow_up', 'canceled')
      order by created_at desc limit 60`,
    query<ScheduleRow[]>`
      select s.id, s.booking_id, s.service_vertical, s.territory_id, t.name as territory_name,
             t.timezone as territory_timezone, s.start_at::text, s.end_at::text, s.status,
             s.required_crew_size, s.required_skills, s.labor_minutes,
             s.travel_buffer_minutes, s.is_dev_seed, count(a.id)::int as assignment_count
      from job_schedules s join service_territories t on t.id = s.territory_id
      left join job_assignments a on a.job_schedule_id = s.id
        and a.status in ('accepted', 'confirmed')
      where (${devOnly} = false or s.is_dev_seed)
        and s.end_at >= now() - interval '7 days'
      group by s.id, t.name, t.timezone
      order by s.start_at asc limit 60`,
    query<AssignmentOpsRow[]>`
      select assignment.id, assignment.job_schedule_id,
             cleaner.full_name as cleaner_name, assignment.assignment_role,
             assignment.status
      from job_assignments assignment
      join job_schedules schedule on schedule.id = assignment.job_schedule_id
      join cleaners cleaner on cleaner.id = assignment.cleaner_id
      where assignment.status in ('proposed', 'accepted', 'confirmed')
        and schedule.status in ('tentative', 'held')
        and (${devOnly} = false or (assignment.is_dev_seed and schedule.is_dev_seed))
      order by assignment.assigned_at asc`,
    query<ServiceCaseRow[]>`
      select c.id, c.public_reference, c.case_type, c.booking_id,
             coalesce(contact ->> 'name', 'Unnamed customer') as contact_name,
             nullif(contact ->> 'email', '') as contact_email,
             nullif(contact ->> 'phone', '') as contact_phone,
             c.status, c.priority, c.details, c.created_at::text, c.is_dev_seed,
             (c.booking_id is not null
               and exists (
                 select 1 from bookings booking
                 where booking.id = c.booking_id
                   and booking.status in ('requested', 'reviewing', 'ready', 'confirmed', 'scheduled')
               )
               and not exists (
                 select 1 from job_schedules schedule
                 where schedule.booking_id = c.booking_id
                   and schedule.status not in ('tentative', 'held', 'confirmed')
               )) as booking_mutation_eligible,
             exists(select 1 from job_schedules schedule where schedule.booking_id = c.booking_id)
               as has_schedule,
             exists(
               select 1 from service_recovery_actions recovery
               where recovery.service_case_id = c.id
                 and recovery.action_type = 'reclean'
                 and recovery.status in ('scheduled', 'completed')
             ) as has_scheduled_reclean,
             coalesce((
               select territory.timezone
               from job_schedules schedule
               join service_territories territory on territory.id = schedule.territory_id
               where schedule.booking_id = c.booking_id
               limit 1
             ), 'America/Los_Angeles') as territory_timezone,
             coalesce(refundable.balance_cents, 0)::int as refundable_balance_cents,
             (c.booking_id is not null
               and c.case_type in ('refund_review', 'complaint', 'reclean', 'damage')
               and c.status = 'refund_pending'
               and coalesce(refundable.balance_cents, 0) > 0
               and not exists (
                 select 1 from refund_records refund
                 where refund.service_case_id = c.id
                   and refund.status in ('requested', 'approved', 'ready_for_manual_processing', 'failed')
               )) as refund_eligible,
             exists(
               select 1 from refund_records refund
               where refund.service_case_id = c.id
                 and refund.status in ('requested', 'approved', 'ready_for_manual_processing', 'failed')
             ) as has_open_refund
      from service_cases c
      left join lateral (
        select sum(greatest(billing.amount_cents - coalesce(committed.amount_cents, 0), 0)) as balance_cents
        from billing_records billing
        left join lateral (
          select sum(refund.amount_cents) as amount_cents
          from refund_records refund
          where refund.billing_record_id = billing.id
            and refund.status not in ('declined', 'failed', 'canceled')
        ) committed on true
        where billing.booking_id = c.booking_id and billing.status = 'paid'
      ) refundable on true
      where (${devOnly} = false or c.is_dev_seed)
        and c.status not in ('closed', 'canceled')
      order by case c.priority when 'urgent' then 0 when 'high' then 1 else 2 end,
               c.created_at asc limit 60`,
    query<RecoveryRow[]>`
      select recovery.id, service_case.public_reference, recovery.action_type,
             recovery.status, recovery.owner_label, recovery.scheduled_at::text,
             recovery.completed_at::text, recovery.notes,
             coalesce(schedule_territory.timezone, booking_territory.timezone,
               'America/Los_Angeles') as territory_timezone
      from service_recovery_actions recovery
      join service_cases service_case on service_case.id = recovery.service_case_id
      left join bookings booking on booking.id = recovery.booking_id
      left join service_territories booking_territory on booking_territory.id = booking.territory_id
      left join job_schedules schedule on schedule.booking_id = booking.id
      left join service_territories schedule_territory on schedule_territory.id = schedule.territory_id
      where (${devOnly} = false or recovery.is_dev_seed)
        and recovery.status not in ('completed', 'canceled')
      order by recovery.scheduled_at asc, recovery.created_at asc limit 60`,
    query<RefundRow[]>`
      select id, service_case_id, booking_id, amount_cents, status, provider,
             reason_code, provider_refund_id, created_at::text
      from refund_records
      where (${devOnly} = false or is_dev_seed)
      order by created_at desc limit 50`,
    query<TimeOffOpsRow[]>`
      select o.id, o.cleaner_id, c.full_name as cleaner_name, o.start_at::text,
             o.end_at::text, o.status, o.reason_category, o.is_dev_seed,
             territory.timezone as territory_timezone, o.version
      from cleaner_time_off o join cleaners c on c.id = o.cleaner_id
      join service_territories territory on territory.id = c.home_territory_id
      where (${devOnly} = false or o.is_dev_seed)
        and o.status = 'requested'
      order by o.start_at asc limit 50`,
    query<OutboxSummary[]>`
      select status, count(*)::int as count from notification_outbox
      where (${devOnly} = false or exists (
        select 1 from bookings b where b.id = notification_outbox.booking_id and b.is_dev_seed
      ) or exists (
        select 1 from service_cases c where c.id = notification_outbox.service_case_id and c.is_dev_seed
      )) group by status order by status`,
    query<OutboxQueueRow[]>`
      select o.id, o.booking_id, o.notification_type, o.recipient_kind, o.status,
             o.attempt_count, o.last_error_code, o.created_at::text
      from notification_outbox o left join bookings b on b.id = o.booking_id
      left join service_cases c on c.id = o.service_case_id
      where o.status in ('pending', 'retry', 'failed')
        and (${devOnly} = false or b.is_dev_seed or c.is_dev_seed)
      order by o.created_at asc limit 50`,
  ]);
  return {
    territories,
    cleaners,
    applications,
    qualifications,
    schedules,
    assignments,
    serviceCases,
    recoveries,
    refunds,
    timeOff,
    outbox,
    outboxQueue,
  };
  });
}

type CapacityRow = {
  id: string;
  skills: string[];
  vertical_experience: ServiceVertical[];
  max_daily_minutes: number;
  max_weekly_minutes: number;
  max_daily_jobs: number;
  home_territory_id: string | null;
};

type SpanRow = {
  cleaner_id: string;
  start_at: string;
  end_at: string;
  minutes_today?: number;
  minutes_week?: number;
};

const MAX_CREW_COMBINATIONS = 2_000;
const MAX_SCHEDULE_SUGGESTIONS = 25;

export type ConsoleSuggestion = AssignmentSuggestion & {
  cleanerIds: string[];
  cleanerNames: string[];
};

export async function getScheduleSuggestions(
  scheduleId: string,
  devOnly: boolean,
  eligibleCleanerIds: readonly string[] | undefined,
  query: QueryClient,
): Promise<ConsoleSuggestion[]> {
  const restrictCleanerIds = eligibleCleanerIds !== undefined;
  const scopedCleanerIds = [...(eligibleCleanerIds ?? [])];
  if (restrictCleanerIds && scopedCleanerIds.length === 0) return [];
  const schedules = await query<
    (ScheduleRow & {
      qualification_status: string;
      qualification_requirements: Record<string, unknown>;
      customer_id: string | null;
      team_id: string | null;
    })[]
  >`
    select s.id, s.booking_id, s.service_vertical, s.territory_id, t.name as territory_name,
           t.timezone as territory_timezone, s.start_at::text, s.end_at::text, s.status,
           s.required_crew_size, s.required_skills, s.labor_minutes, s.travel_buffer_minutes,
           s.is_dev_seed, 0::int as assignment_count, b.qualification_status,
           b.qualification_requirements, b.customer_id, allocation.team_id
    from job_schedules s join bookings b on b.id = s.booking_id
    join service_territories t on t.id = s.territory_id
    left join team_job_allocations allocation on allocation.job_schedule_id = s.id
    where s.id = ${scheduleId} and (${devOnly} = false or (s.is_dev_seed and b.is_dev_seed))`;
  const schedule = schedules[0];
  if (!schedule || !["tentative", "held"].includes(schedule.status))
    return [];

  const preferences = schedule.customer_id && schedule.team_id
    ? await query<Array<{ cleaner_id: string; preference: "preferred" | "avoid" }>>`
        select cleaner_id, preference
        from customer_cleaner_preferences
        where customer_id = ${schedule.customer_id}
          and team_id = ${schedule.team_id} and active`
    : [];
  const preferredCleanerIds = preferences
    .filter((preference) => preference.preference === "preferred")
    .map((preference) => preference.cleaner_id);
  const avoidedCleanerIds = preferences
    .filter((preference) => preference.preference === "avoid")
    .map((preference) => preference.cleaner_id);

  const acceptedAssignments = await query<{ cleaner_id: string }[]>`
    select cleaner_id
    from job_assignments
    where job_schedule_id = ${scheduleId}
      and status in ('accepted', 'confirmed')`;
  const acceptedCleanerIds = [
    ...new Set(acceptedAssignments.map((assignment) => assignment.cleaner_id)),
  ];
  if (acceptedCleanerIds.some((cleanerId) => avoidedCleanerIds.includes(cleanerId))) {
    return [];
  }
  const scopedCleanerIdSet = new Set(scopedCleanerIds);
  if (
    restrictCleanerIds &&
    acceptedCleanerIds.some((cleanerId) => !scopedCleanerIdSet.has(cleanerId))
  ) {
    return [];
  }

  const [acceptedCapacity, unassignedCapacity] = await Promise.all([
    query<(CapacityRow & { full_name: string })[]>`
      select id, full_name, skills, vertical_experience, max_daily_minutes,
             max_weekly_minutes, max_daily_jobs, home_territory_id
      from cleaners where status = 'active' and screening_status = 'verified'
        and home_territory_id = ${schedule.territory_id}
        and id = any(${acceptedCleanerIds}::uuid[])
        and not (id = any(${avoidedCleanerIds}::uuid[]))
        and (${devOnly} = false or is_dev_seed)
        and (${restrictCleanerIds} = false or id = any(${scopedCleanerIds}::uuid[]))`,
    query<(CapacityRow & { full_name: string })[]>`
      select id, full_name, skills, vertical_experience, max_daily_minutes,
             max_weekly_minutes, max_daily_jobs, home_territory_id
      from cleaners where status = 'active' and screening_status = 'verified'
        and home_territory_id = ${schedule.territory_id}
        and not (id = any(${acceptedCleanerIds}::uuid[]))
        and not (id = any(${avoidedCleanerIds}::uuid[]))
        and (${devOnly} = false or is_dev_seed)
        and (${restrictCleanerIds} = false or id = any(${scopedCleanerIds}::uuid[]))
      order by
        (vertical_experience @> array[${schedule.service_vertical}]::text[]) desc,
        (skills @> ${schedule.required_skills}::text[]) desc,
        full_name`,
  ]);
  if (acceptedCapacity.length !== acceptedCleanerIds.length) return [];
  const capacity = [...acceptedCapacity, ...unassignedCapacity];
  const capacityIds = capacity.map((cleaner) => cleaner.id);
  if (capacityIds.length === 0) return [];

  const [availability, timeOff, assignments, loads] = await Promise.all([
    query<SpanRow[]>`
      select a.cleaner_id,
        (((s.start_at at time zone t.timezone)::date + a.start_time) at time zone t.timezone)::text as start_at,
        (((s.start_at at time zone t.timezone)::date + a.end_time) at time zone t.timezone)::text as end_at
      from job_schedules s join service_territories t on t.id = s.territory_id
      join cleaner_availability_rules a on
        (a.territory_id is null or a.territory_id = s.territory_id)
        and a.day_of_week = extract(dow from s.start_at at time zone t.timezone)::int
        and a.status = 'active'
        and a.effective_from <= (s.start_at at time zone t.timezone)::date
        and (a.effective_to is null or a.effective_to >= (s.start_at at time zone t.timezone)::date)
      where s.id = ${scheduleId}
        and a.cleaner_id = any(${capacityIds}::uuid[])
        and (${restrictCleanerIds} = false or a.cleaner_id = any(${scopedCleanerIds}::uuid[]))`,
    query<SpanRow[]>`
      select o.cleaner_id, o.start_at::text, o.end_at::text
      from cleaner_time_off o where o.status = 'approved'
        and o.start_at < ${schedule.end_at}::timestamptz and o.end_at > ${schedule.start_at}::timestamptz
        and o.cleaner_id = any(${capacityIds}::uuid[])
        and (${restrictCleanerIds} = false or o.cleaner_id = any(${scopedCleanerIds}::uuid[]))`,
    query<SpanRow[]>`
      select cleaner_id, start_at::text, end_at::text
      from private.current_staff_candidate_assignment_spans(
        ${scheduleId}::uuid,
        ${capacityIds}::uuid[]
      )`,
    query<
      { cleaner_id: string; jobs_today: number; minutes_today: number; minutes_week: number }[]
    >`
      select cleaner_id, jobs_today, minutes_today, minutes_week
      from private.current_staff_candidate_assignment_loads(
        ${scheduleId}::uuid,
        ${capacityIds}::uuid[]
      )`,
  ]);

  const nameById = new Map(
    capacity.map((cleaner) => [cleaner.id, cleaner.full_name]),
  );
  const indexSpans = (rows: SpanRow[]) => {
    const result = new Map<string, { start: string; end: string }[]>();
    for (const row of rows) {
      const spans = result.get(row.cleaner_id) ?? [];
      spans.push({ start: row.start_at, end: row.end_at });
      result.set(row.cleaner_id, spans);
    }
    return result;
  };
  const availabilityByCleaner = indexSpans(availability);
  const timeOffByCleaner = indexSpans(timeOff);
  const assignmentsByCleaner = indexSpans(assignments);
  const loadsByCleaner = new Map(loads.map((load) => [load.cleaner_id, load]));
  const capacityById = new Map<string, CleanerCapacity>();
  for (const cleaner of capacity) {
    const load = loadsByCleaner.get(cleaner.id);
    capacityById.set(cleaner.id, {
      id: cleaner.id,
      active: true,
      skills: cleaner.skills,
      verticalExperience: cleaner.vertical_experience,
      availability: availabilityByCleaner.get(cleaner.id) ?? [],
      timeOff: timeOffByCleaner.get(cleaner.id) ?? [],
      assignments: assignmentsByCleaner.get(cleaner.id) ?? [],
      assignedJobsToday: load?.jobs_today ?? 0,
      assignedMinutesToday: load?.minutes_today ?? 0,
      assignedMinutesThisWeek: load?.minutes_week ?? 0,
      maxDailyJobs: cleaner.max_daily_jobs,
      maxDailyMinutes: cleaner.max_daily_minutes,
      maxWeeklyMinutes: cleaner.max_weekly_minutes,
    });
  }

  const requirements = schedule.qualification_requirements ?? {};
  const job: SchedulingJob = {
    id: schedule.id,
    vertical: schedule.service_vertical,
    territoryId: schedule.territory_id,
    start: schedule.start_at,
    end: schedule.end_at,
    requiredCrewSize: schedule.required_crew_size,
    requiredSkills: schedule.required_skills,
    qualificationApproved: schedule.qualification_status === "approved",
    safeAccessReady: requirements.siteReady === true,
    utilitiesReady: requirements.utilitiesReady !== false,
    constructionReady:
      schedule.service_vertical !== "construction" ||
      requirements.constructionReady === true,
    dockAccessReady:
      schedule.service_vertical !== "marine" ||
      requirements.dockAccessReady === true,
    finishRestrictionsAcknowledged:
      requirements.finishRestrictionsAcknowledged === true,
    urgency: requirements.deadlineCritical === true ? "deadline" : "standard",
    preferredCleanerIds,
  };
  const acceptedCleanerCapacity = acceptedCleanerIds.map(
    (id) => capacityById.get(id)!,
  );
  const availableCleanerCapacity = unassignedCapacity.map(
    (cleaner) => capacityById.get(cleaner.id)!,
  );
  const crewGroups = buildBoundedCrewGroups({
    job,
    acceptedCleaners: acceptedCleanerCapacity,
    availableCleaners: availableCleanerCapacity,
    travelBufferMinutes: schedule.travel_buffer_minutes,
    limit: MAX_CREW_COMBINATIONS,
  });
  const candidates: AssignmentCandidate[] = crewGroups.map((group) => ({
    id: group
      .map((cleaner) => cleaner.id)
      .sort()
      .join("+"),
    territoryIds: [schedule.territory_id],
    cleaners: group,
    estimatedTravelMinutes: schedule.travel_buffer_minutes,
    travelBufferMinutes: schedule.travel_buffer_minutes,
  }));
  return rankAssignmentSuggestions(job, candidates)
    .slice(0, MAX_SCHEDULE_SUGGESTIONS)
    .map((suggestion) => {
    const cleanerIds = suggestion.candidateId.split("+");
    return {
      ...suggestion,
      cleanerIds,
      cleanerNames: cleanerIds.map(
        (id) => nameById.get(id) ?? "Unknown cleaner",
      ),
    };
    });
}

export async function getStaffScheduleSuggestions(
  customerId: string,
  scheduleId: string,
  devOnly: boolean,
) {
  return withStaffActor(customerId, (transaction) =>
    getScheduleSuggestions(scheduleId, devOnly, undefined, transaction),
  );
}

export async function createTerritoryDraft(input: {
  customerId: string;
  code: string;
  name: string;
  postalCodes: string[];
  devOnly: boolean;
}) {
  return withStaffActor(input.customerId, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into service_territories (code, name, status, is_dev_seed)
      values (${input.code}, ${input.name}, 'draft', ${input.devOnly}) returning id`;
    for (const postalCode of input.postalCodes) {
      await tx`insert into territory_postal_codes (territory_id, postal_code, status)
        values (${rows[0].id}, ${postalCode}, 'review') on conflict do nothing`;
    }
    return rows[0];
  });
}

export async function setPostalCodeStatus(
  customerId: string,
  territoryId: string,
  postalCode: string,
  status: "review" | "active" | "excluded",
  devOnly: boolean,
) {
  await withStaffActor(customerId, async (tx) => {
    await tx`update territory_postal_codes p set status = ${status}
      from service_territories t where p.territory_id = t.id and t.id = ${territoryId}
        and p.postal_code = ${postalCode} and (${devOnly} = false or t.is_dev_seed)`;
  });
}

export async function setTerritoryStatus(
  customerId: string,
  territoryId: string,
  status: "draft" | "active" | "paused",
  devOnly: boolean,
) {
  await withStaffActor(customerId, async (tx) => {
    if (status === "active") {
      const readiness = await tx<{ ready: boolean }[]>`
        select exists(select 1 from territory_postal_codes where territory_id = ${territoryId} and status = 'active')
          and exists(
            select 1 from cleaners cleaner
            where cleaner.home_territory_id = ${territoryId}
              and cleaner.status = 'active'
              and cleaner.screening_status = 'verified'
              and exists (
                select 1 from cleaner_availability_rules availability
                where availability.cleaner_id = cleaner.id
                  and availability.status = 'active'
                  and (availability.territory_id is null or availability.territory_id = ${territoryId})
              )
          ) as ready`;
      if (!readiness[0]?.ready)
        throw new Error(
          "An active postal code and a screened, available cleaner are required before territory activation",
        );
    }
    await tx`update service_territories set status = ${status} where id = ${territoryId}
      and (${devOnly} = false or is_dev_seed)`;
  });
}

export async function setCleanerApplicationStatus(
  customerId: string,
  applicationId: string,
  from: string,
  to: string,
  devOnly: boolean,
) {
  return withStaffActor(customerId, async (tx) => {
    const rows = await tx<
      { id: string }[]
    >`update cleaner_applications set status = ${to}
      where id = ${applicationId} and status = ${from}
        and (${devOnly} = false or is_dev_seed) returning id`;
    return Boolean(rows[0]);
  });
}

export async function createOnboardingCleaner(
  customerId: string,
  applicationId: string,
  territoryId: string,
  devOnly: boolean,
) {
  return withStaffActor(customerId, async (tx) => {
    const applications = await tx<
      {
        full_name: string;
        email: string;
        phone: string | null;
        service_interests: ServiceVertical[];
        is_dev_seed: boolean;
      }[]
    >`
      select full_name, email, phone, service_interests, is_dev_seed from cleaner_applications
      where id = ${applicationId} and status in ('offer', 'onboarding')
        and (${devOnly} = false or is_dev_seed) for update`;
    const application = applications[0];
    if (!application)
      throw new Error("Move the application to offer before onboarding");
    const existing = await tx<
      { id: string }[]
    >`select id from cleaners where lower(email) = lower(${application.email}) limit 1`;
    if (existing[0]) return existing[0];
    const territories = await tx<
      { id: string }[]
    >`select id from service_territories where id = ${territoryId}
      and (${devOnly} = false or is_dev_seed)`;
    if (!territories[0]) throw new Error("Choose a valid home territory");
    const rows = await tx<{ id: string }[]>`insert into cleaners
      (full_name, email, phone, status, screening_status, home_territory_id,
       skills, vertical_experience, is_dev_seed)
      values (${application.full_name}, ${application.email}, ${application.phone}, 'onboarding',
        'not_recorded', ${territoryId}, '{}', ${application.service_interests}, ${devOnly}) returning id`;
    await tx`update cleaner_applications set status = 'onboarding' where id = ${applicationId}`;
    return rows[0];
  });
}

export async function verifyCleanerScreening(
  customerId: string,
  cleanerId: string,
  devOnly: boolean,
) {
  return withStaffActor(customerId, async (tx) => {
    const rows = await tx<{ id: string }[]>`update cleaners
      set screening_status = 'verified', screening_verified_at = now()
      where id = ${cleanerId} and status = 'onboarding'
        and (${devOnly} = false or is_dev_seed) returning id`;
    return Boolean(rows[0]);
  });
}

export async function addCleanerAvailability(input: {
  customerId: string;
  cleanerId: string;
  territoryId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  devOnly: boolean;
}) {
  await withStaffActor(input.customerId, async (tx) => {
    const cleaners = await tx<
      { id: string }[]
    >`select id from cleaners where id = ${input.cleanerId}
      and home_territory_id = ${input.territoryId} and (${input.devOnly} = false or is_dev_seed)`;
    if (!cleaners[0]) throw new Error("Cleaner and territory do not match");
    await tx`insert into cleaner_availability_rules
      (cleaner_id, territory_id, day_of_week, start_time, end_time, status)
      values (${input.cleanerId}, ${input.territoryId}, ${input.dayOfWeek}, ${input.startTime}, ${input.endTime}, 'active')`;
  });
}

export async function setCleanerStatus(
  customerId: string,
  cleanerId: string,
  status: "active" | "paused" | "inactive",
  devOnly: boolean,
) {
  await withStaffActor(customerId, async (tx) => {
    if (status === "active") {
      const readiness = await tx<{ ready: boolean }[]>`select
        c.screening_status = 'verified'
        and c.home_territory_id is not null
        and exists(select 1 from cleaner_availability_rules a where a.cleaner_id = c.id and a.status = 'active') as ready
        from cleaners c where c.id = ${cleanerId} and (${devOnly} = false or c.is_dev_seed)`;
      if (!readiness[0]?.ready)
        throw new Error(
          "Verified screening, a home territory, and active availability are required before activation",
        );
    }
    await tx`update cleaners set status = ${status} where id = ${cleanerId}
      and (${devOnly} = false or is_dev_seed)`;
  });
}

export async function setCleanerCapabilities(input: {
  customerId: string;
  cleanerId: string;
  skills: string[];
  verticalExperience: ServiceVertical[];
  devOnly: boolean;
}) {
  await withStaffActor(input.customerId, async (tx) => {
    await tx`update cleaners set skills = ${input.skills}, vertical_experience = ${input.verticalExperience}
      where id = ${input.cleanerId} and (${input.devOnly} = false or is_dev_seed)`;
  });
}

export async function setQualificationStatus(
  customerId: string,
  bookingId: string,
  from: string,
  to: string,
  requirements: Record<string, unknown>,
  devOnly: boolean,
) {
  return withStaffActor(customerId, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update bookings set qualification_status = ${to}, qualification_requirements = qualification_requirements || ${tx.json(requirements as postgres.JSONValue)}
      where id = ${bookingId} and qualification_status = ${from}
        and (${devOnly} = false or is_dev_seed) returning id`;
    return Boolean(rows[0]);
  });
}

export async function createJobSchedule(input: {
  customerId: string;
  bookingId: string;
  territoryId: string;
  startLocal: string;
  endLocal: string;
  devOnly: boolean;
}) {
  return withStaffActor(input.customerId, async (tx) => {
    const bookings = await tx<
      {
        service_vertical: ServiceVertical;
        required_crew_size: number;
        required_skills: string[];
        estimated_duration_minutes: number;
        is_dev_seed: boolean;
      }[]
    >`
      select service_vertical, required_crew_size, required_skills, estimated_duration_minutes, is_dev_seed
      from bookings where id = ${input.bookingId} and qualification_status = 'approved'
        and status in ('requested', 'reviewing', 'ready')
        and (${input.devOnly} = false or is_dev_seed) for update`;
    if (!bookings[0]?.service_vertical)
      throw new Error(
        "Booking must be qualification-approved before scheduling",
      );
    const territories = await tx<
      { travel_buffer_minutes: number; timezone: string }[]
    >`
      select travel_buffer_minutes, timezone from service_territories where id = ${input.territoryId}
        and status = 'active' and (${input.devOnly} = false or is_dev_seed)`;
    if (!territories[0])
      throw new Error("Choose an active, capacity-backed territory");
    const startAt = localDateTimeToUtc(input.startLocal, territories[0].timezone);
    const endAt = localDateTimeToUtc(input.endLocal, territories[0].timezone);
    validateUtcInterval(startAt, endAt, { maxMinutes: 24 * 60 });
    const elapsedMinutes = Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60000);
    const booking = bookings[0];
    const laborMinutes = Math.max(
      booking.estimated_duration_minutes ?? elapsedMinutes,
      30,
    );
    const requiredMinutes = requiredElapsedMinutes(
      laborMinutes,
      booking.required_crew_size,
    );
    if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < requiredMinutes) {
      throw new Error(
        `Schedule needs at least ${requiredMinutes} elapsed minutes for this labor plan and crew size`,
      );
    }
    const rows = await tx<{ id: string }[]>`
      insert into job_schedules (booking_id, territory_id, service_vertical, start_at, end_at,
        status, required_crew_size, required_skills, labor_minutes, travel_buffer_minutes, is_dev_seed)
      values (${input.bookingId}, ${input.territoryId}, ${booking.service_vertical}, ${startAt},
        ${endAt}, 'tentative', ${booking.required_crew_size}, ${booking.required_skills},
        ${laborMinutes}, ${territories[0].travel_buffer_minutes},
        ${input.devOnly}) returning id`;
    return rows[0];
  });
}

export async function setJobScheduleStatus(
  customerId: string,
  scheduleId: string,
  from: string,
  to: string,
  devOnly: boolean,
) {
  const allowed = new Set([
    "tentative:held",
    "held:tentative",
    "confirmed:en_route",
    "en_route:in_progress",
    "in_progress:quality_review",
    "quality_review:completed",
  ]);
  if (!allowed.has(`${from}:${to}`)) {
    throw new Error(
      "Confirmation, cancellation, and recovery changes require the scoped field workflow",
    );
  }
  return withStaffActor(customerId, async (tx) => {
    const rows = await tx<
      { id: string }[]
    >`update job_schedules set status = ${to}, version = version + 1
      where id = ${scheduleId} and status = ${from}
        and (${devOnly} = false or is_dev_seed) returning id`;
    return Boolean(rows[0]);
  });
}

export async function proposeAssignmentCandidate(
  customerId: string,
  scheduleId: string,
  candidateId: string,
  devOnly: boolean,
) {
  await withStaffActor(customerId, async (tx) => {
    const lockedSchedules = await tx<{ id: string; team_id: string }[]>`
      select schedule.id, allocation.team_id
      from job_schedules schedule
      join team_job_allocations allocation
        on allocation.job_schedule_id = schedule.id
      where schedule.id = ${scheduleId}
        and schedule.status in ('tentative', 'held')
        and (${devOnly} = false or (
          schedule.is_dev_seed and allocation.is_dev_seed
        ))
      for update of schedule, allocation`;
    if (!lockedSchedules[0]) {
      throw new Error("Crew proposals are limited to tentative or held schedules");
    }
    const suggestions = await getScheduleSuggestions(
      scheduleId,
      devOnly,
      undefined,
      tx,
    );
    const suggestion = suggestions.find(
      (item) => item.candidateId === candidateId && item.eligible,
    );
    if (!suggestion) {
      throw new Error("That crew is no longer eligible; refresh suggestions");
    }
    const acceptedAssignments = await tx<{ cleaner_id: string }[]>`
      select cleaner_id
      from job_assignments
      where job_schedule_id = ${scheduleId}
        and status in ('accepted', 'confirmed')`;
    if (
      acceptedAssignments.some(
        (assignment) => !suggestion.cleanerIds.includes(assignment.cleaner_id),
      )
    ) {
      throw new Error(
        "The selected crew must retain every cleaner who already accepted",
      );
    }
    await tx`
      update job_assignments
      set status = 'removed', responded_at = now()
      where job_schedule_id = ${scheduleId}
        and status = 'proposed'
        and cleaner_id <> all(${suggestion.cleanerIds}::uuid[])`;
    for (const [index, cleanerId] of suggestion.cleanerIds.entries()) {
      await tx`insert into job_assignments
        (job_schedule_id, cleaner_id, team_id, assignment_role, status, suggestion_score,
         suggestion_reasons, assigned_by_label, is_dev_seed)
        values (${scheduleId}, ${cleanerId}, ${lockedSchedules[0].team_id},
          ${index === 0 ? "lead" : "member"}, 'proposed',
          ${suggestion.score}, ${tx.json(suggestion.reasons as postgres.JSONValue)}, 'Operator', ${devOnly})
        on conflict (job_schedule_id, cleaner_id) do update set
          team_id = excluded.team_id,
          assignment_role = excluded.assignment_role,
          status = case
            when job_assignments.status in ('accepted', 'confirmed') then job_assignments.status
            else 'proposed'
          end,
          suggestion_score = excluded.suggestion_score,
          suggestion_reasons = excluded.suggestion_reasons, assigned_at = now()`;
    }
  });
}

export async function removeAssignmentFromPlanningSchedule(
  customerId: string,
  assignmentId: string,
  devOnly: boolean,
) {
  return withStaffActor(customerId, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      select assignment.id
      from job_assignments assignment
      join job_schedules schedule on schedule.id = assignment.job_schedule_id
      where assignment.id = ${assignmentId}
        and assignment.status in ('proposed', 'accepted', 'confirmed')
        and schedule.status in ('tentative', 'held')
        and (${devOnly} = false or (assignment.is_dev_seed and schedule.is_dev_seed))
      for update of schedule, assignment`;
    if (!rows[0]) {
      throw new Error(
        "Assignments can be removed only while the schedule is tentative or held",
      );
    }
    const changed = await tx<{ id: string }[]>`
      update job_assignments
      set status = 'removed', responded_at = now()
      where id = ${assignmentId}
      returning id`;
    return Boolean(changed[0]);
  });
}

export async function setServiceCaseStatus(
  customerId: string,
  caseId: string,
  from: string,
  to: string,
  resolutionSummary: string | null,
  devOnly: boolean,
) {
  return withStaffActor(customerId, async (tx) => {
    const rows = await tx<
      { id: string }[]
    >`update service_cases
      set status = ${to},
          resolution_summary = case
            when ${to} in ('resolved', 'closed') then ${resolutionSummary}
            when ${to} not in ('declined', 'canceled') then null
            else resolution_summary
          end,
          resolution_type = case
            when ${to} not in ('resolved', 'closed', 'declined', 'canceled') then null
            else resolution_type
          end,
          resolved_at = case
            when ${to} = 'resolved' then now()
            when ${to} not in ('resolved', 'closed', 'declined', 'canceled') then null
            else resolved_at
          end,
          closed_at = case
            when ${to} = 'closed' then now()
            when ${to} not in ('resolved', 'closed', 'declined', 'canceled') then null
            else closed_at
          end
      where id = ${caseId} and status = ${from} and (${devOnly} = false or is_dev_seed) returning id`;
    return Boolean(rows[0]);
  });
}

export async function rescheduleBookingFromCase(input: {
  customerId: string;
  caseId: string;
  startLocal: string;
  endLocal: string;
  devOnly: boolean;
}) {
  return withStaffActor(input.customerId, async (tx) => {
    const rows = await tx<
      {
        schedule_id: string;
        organization_id: string;
        team_id: string;
        actor_membership_id: string;
      }[]
    >`
      select schedule.id as schedule_id, allocation.organization_id,
        allocation.team_id, actor.id as actor_membership_id
      from service_cases c
      join bookings booking on booking.id = c.booking_id
      join job_schedules schedule on schedule.booking_id = c.booking_id
      join team_job_allocations allocation
        on allocation.job_schedule_id = schedule.id
      join workforce_memberships actor
        on actor.customer_id = ${input.customerId}
       and actor.organization_id = allocation.organization_id
       and actor.team_id is null and actor.role in ('owner','gm')
       and actor.status = 'active'
      where c.id = ${input.caseId} and c.case_type = 'reschedule'
        and c.status = 'action_planned'
        and booking.status in ('requested', 'reviewing', 'ready', 'confirmed', 'scheduled')
        and schedule.status in ('tentative', 'held', 'confirmed')
        and (${input.devOnly} = false or (
          c.is_dev_seed and schedule.is_dev_seed and booking.is_dev_seed
          and allocation.is_dev_seed
        ))
      order by schedule.start_at desc
      limit 1`;
    if (!rows[0])
      throw new Error(
        "Reschedule case must be action-planned and allocated to a branch",
      );
    return stageCustomerRescheduleProposal(tx, {
      organizationId: rows[0].organization_id,
      teamId: rows[0].team_id,
      serviceCaseId: input.caseId,
      scheduleId: rows[0].schedule_id,
      actorMembershipId: rows[0].actor_membership_id,
      startLocal: input.startLocal,
      endLocal: input.endLocal,
      proposalNote: "Reschedule requested through national service recovery.",
      devOnly: input.devOnly,
    });
  });
}

export async function updateUnscheduledBookingPreferenceFromCase(input: {
  customerId: string;
  caseId: string;
  preferredDate: string;
  devOnly: boolean;
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.preferredDate)) {
    throw new Error("Choose a valid preferred date");
  }
  const preferredDate = new Date(`${input.preferredDate}T12:00:00.000Z`);
  if (
    Number.isNaN(preferredDate.getTime()) ||
    preferredDate.toISOString().slice(0, 10) !== input.preferredDate ||
    preferredDate.getTime() < Date.now() - 24 * 60 * 60_000
  ) {
    throw new Error("Choose a future preferred date");
  }
  return withStaffActor(input.customerId, async (tx) => {
    const rows = await tx<{ booking_id: string }[]>`
      select service_case.booking_id
      from service_cases service_case
      join bookings booking on booking.id = service_case.booking_id
      where service_case.id = ${input.caseId}
        and service_case.case_type = 'reschedule'
        and service_case.status = 'action_planned'
        and booking.status in ('requested', 'reviewing', 'ready')
        and not exists (
          select 1 from job_schedules schedule where schedule.booking_id = booking.id
        )
        and (${input.devOnly} = false or (service_case.is_dev_seed and booking.is_dev_seed))
      for update of service_case, booking`;
    if (!rows[0]) {
      throw new Error(
        "Preferred-date updates are limited to action-planned requests without a schedule",
      );
    }
    await tx`
      update bookings
      set scheduled_date = ${input.preferredDate},
          scheduled_window = 'Customer preference; time not confirmed'
      where id = ${rows[0].booking_id}`;
    await tx`
      update service_cases
      set status = 'resolved', resolution_type = 'rescheduled',
          resolution_summary = 'Preferred date updated before scheduling; no appointment was confirmed.',
          resolved_at = now()
      where id = ${input.caseId}`;
    return rows[0];
  });
}

export async function cancelBookingFromCase(
  customerId: string,
  caseId: string,
  devOnly: boolean,
) {
  return withStaffActor(customerId, async (tx) => {
    const rows = await tx<
      { booking_id: string }[]
    >`select service_case.booking_id
      from service_cases service_case
      join bookings booking on booking.id = service_case.booking_id
      where service_case.id = ${caseId}
        and service_case.case_type = 'cancel'
        and service_case.status = 'action_planned'
        and booking.status in ('requested', 'reviewing', 'ready', 'confirmed', 'scheduled')
        and (${devOnly} = false or (service_case.is_dev_seed and booking.is_dev_seed))
      for update of service_case, booking`;
    if (!rows[0])
      throw new Error(
        "Cancellation case must be action-planned and linked to a booking",
      );
    const bookingId = rows[0].booking_id;
    const schedules = await tx<{ id: string; status: string }[]>`
      select id, status from job_schedules where booking_id = ${bookingId} for update`;
    if (
      schedules[0] &&
      !["tentative", "held", "confirmed"].includes(schedules[0].status)
    ) {
      throw new Error("Service already started; use service recovery instead");
    }
    if (schedules[0]) {
      await tx`update job_schedules set status = 'canceled', version = version + 1
        where id = ${schedules[0].id}`;
    } else {
      const canceled = await tx<{ id: string }[]>`
        update bookings set status = 'canceled'
        where id = ${bookingId}
          and status in ('requested', 'reviewing', 'ready', 'confirmed', 'scheduled')
        returning id`;
      if (!canceled[0]) throw new Error("Booking is no longer eligible for cancellation");
    }
    const canceledBookings = await tx<{ id: string }[]>`
      select id from bookings where id = ${bookingId} and status = 'canceled'`;
    if (!canceledBookings[0]) {
      throw new Error("Booking cancellation did not complete");
    }
    await tx`update service_cases set status = 'resolved', resolution_type = 'canceled',
      resolution_summary = 'Booking and active schedule canceled by operator.', resolved_at = now()
      where id = ${caseId}`;
  });
}

export async function createRecoveryAction(input: {
  customerId: string;
  caseId: string;
  type: string;
  scheduledLocal: string;
  notes: string;
  devOnly: boolean;
}) {
  return withStaffActor(input.customerId, async (tx) => {
    const cases = await tx<
      { booking_id: string | null; timezone: string }[]
    >`
      select service_case.booking_id,
             coalesce(schedule_territory.timezone, booking_territory.timezone,
               'America/Los_Angeles') as timezone
      from service_cases service_case
      left join bookings booking on booking.id = service_case.booking_id
      left join service_territories booking_territory on booking_territory.id = booking.territory_id
      left join job_schedules schedule on schedule.booking_id = booking.id
      left join service_territories schedule_territory on schedule_territory.id = schedule.territory_id
      where service_case.id = ${input.caseId}
        and service_case.status not in ('resolved', 'closed', 'declined', 'canceled')
        and (${input.devOnly} = false or service_case.is_dev_seed)
      for update of service_case`;
    if (!cases[0]) throw new Error("Choose an open service case");
    const scheduledAt = localDateTimeToUtc(
      input.scheduledLocal,
      cases[0].timezone,
    );
    if (Date.parse(scheduledAt) < Date.now() - 5 * 60_000) {
      throw new Error("Recovery target time must be in the future");
    }
    const rows = await tx<{ id: string }[]>`
      insert into service_recovery_actions
        (service_case_id, action_type, scheduled_at, notes)
      values (${input.caseId}, ${input.type}, ${scheduledAt},
        ${input.notes || null})
      returning id`;
    return rows[0];
  });
}

export async function setRecoveryStatus(
  customerId: string,
  recoveryId: string,
  from: string,
  to: string,
  devOnly: boolean,
) {
  return withStaffActor(customerId, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update service_recovery_actions
      set status = ${to}
      where id = ${recoveryId} and status = ${from}
        and (${devOnly} = false or is_dev_seed)
      returning id`;
    return Boolean(rows[0]);
  });
}

export async function createRefundReview(input: {
  customerId: string;
  caseId: string;
  amountCents: number;
  reasonCode: string;
  devOnly: boolean;
}) {
  return withStaffActor(input.customerId, async (tx) => {
    const rows = await tx<
      { booking_id: string; billing_record_id: string; remaining_cents: number }[]
    >`
      select service_case.booking_id, billing.id as billing_record_id,
             (billing.amount_cents - coalesce((
               select sum(refund.amount_cents) from refund_records refund
               where refund.billing_record_id = billing.id
                 and refund.status not in ('declined', 'failed', 'canceled')
             ), 0))::int
               as remaining_cents
      from service_cases service_case
      join billing_records billing on billing.booking_id = service_case.booking_id
        and billing.status = 'paid'
      where service_case.id = ${input.caseId}
        and service_case.case_type in ('refund_review', 'complaint', 'reclean', 'damage')
        and service_case.status = 'refund_pending'
        and not exists (
          select 1 from refund_records unfinished_refund
          where unfinished_refund.service_case_id = service_case.id
            and unfinished_refund.status in ('requested', 'approved', 'ready_for_manual_processing', 'failed')
        )
        and (${input.devOnly} = false or (service_case.is_dev_seed and billing.is_dev_seed))
        and billing.amount_cents - coalesce((
          select sum(refund.amount_cents) from refund_records refund
          where refund.billing_record_id = billing.id
            and refund.status not in ('declined', 'failed', 'canceled')
        ), 0) >= ${input.amountCents}
      order by billing.occurred_at desc
      limit 1
      for update of service_case, billing`;
    if (!rows[0]) {
      throw new Error(
        "Refund review requires a refund-pending eligible case and enough remaining paid balance",
      );
    }
    await tx`insert into refund_records
      (service_case_id, booking_id, billing_record_id, amount_cents, reason_code)
      values (${input.caseId}, ${rows[0].booking_id}, ${rows[0].billing_record_id},
        ${input.amountCents}, ${input.reasonCode})`;
  });
}

export async function setRefundStatus(
  customerId: string,
  refundId: string,
  from: string,
  to: string,
  providerReference: string | null,
  devOnly: boolean,
) {
  return withStaffActor(customerId, async (tx) => {
    const rows = await tx<
      { id: string }[]
    >`update refund_records set status = ${to},
        provider_refund_id = case when ${to} = 'processed' then ${providerReference} else provider_refund_id end
      where id = ${refundId} and status = ${from} and (${devOnly} = false or is_dev_seed) returning id`;
    return Boolean(rows[0]);
  });
}

export async function reviewTimeOff(
  customerId: string,
  timeOffId: string,
  status: "approved" | "declined",
  version: number,
  reason: string | null,
  devOnly: boolean,
) {
  await withStaffActor(customerId, async (transaction) => {
    const rows = await transaction<{ id: string }[]>`
      update cleaner_time_off
      set status = ${status}, review_reason = ${reason}
      where id = ${timeOffId} and status = 'requested'
        and version = ${version}
        and (${devOnly} = false or is_dev_seed)
      returning id`;
    if (!rows[0]) throw new Error("Time-off request changed or is outside your scope");
  });
}
