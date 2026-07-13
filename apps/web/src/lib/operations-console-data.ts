import "server-only";

import type postgres from "postgres";

import { sql } from "./db";
import {
  rankAssignmentSuggestions,
  requiredElapsedMinutes,
  type AssignmentCandidate,
  type AssignmentSuggestion,
  type CleanerCapacity,
  type SchedulingJob,
  type ServiceVertical,
} from "./operations-scheduling";

export type TerritoryRow = {
  id: string;
  code: string;
  name: string;
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

export type ServiceCaseRow = {
  id: string;
  public_reference: string;
  case_type: string;
  booking_id: string | null;
  contact_name: string;
  status: string;
  priority: string;
  details: string;
  created_at: string;
  refundable_balance_cents: number;
  refund_eligible: boolean;
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

export type TimeOffOpsRow = {
  id: string;
  cleaner_id: string;
  cleaner_name: string;
  start_at: string;
  end_at: string;
  status: string;
  reason_category: string;
  is_dev_seed: boolean;
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

export async function getOperationsConsole(devOnly: boolean) {
  const [
    territories,
    cleaners,
    applications,
    qualifications,
    schedules,
    serviceCases,
    refunds,
    timeOff,
    outbox,
    outboxQueue,
  ] = await Promise.all([
    sql<TerritoryRow[]>`
      select t.id, t.code, t.name, t.status, t.travel_buffer_minutes, t.is_dev_seed,
             coalesce(jsonb_agg(jsonb_build_object('code', p.postal_code, 'status', p.status)
               order by p.postal_code) filter (where p.postal_code is not null), '[]') as postal_codes
      from service_territories t
      left join territory_postal_codes p on p.territory_id = t.id
      where (${devOnly} = false or t.is_dev_seed)
      group by t.id order by t.name`,
    sql<CleanerOpsRow[]>`
      select c.id, c.full_name, c.email, c.status, c.screening_status,
             c.home_territory_id, t.name as home_territory_name, c.skills,
             c.vertical_experience, c.is_dev_seed,
             count(a.id)::int as availability_count
      from cleaners c
      left join service_territories t on t.id = c.home_territory_id
      left join cleaner_availability_rules a on a.cleaner_id = c.id and a.status = 'active'
      where (${devOnly} = false or c.is_dev_seed)
      group by c.id, t.name order by c.full_name`,
    sql<ApplicationRow[]>`
      select id, public_reference, full_name, email, home_base, service_interests,
             status, created_at::text, is_dev_seed
      from cleaner_applications
      where (${devOnly} = false or is_dev_seed)
        and status not in ('declined', 'withdrawn')
      order by created_at desc limit 50`,
    sql<QualificationRow[]>`
      select id, service_vertical, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date,
             scheduled_window, qualification_status, required_crew_size,
             estimated_duration_minutes, required_skills,
             coalesce(contact ->> 'name', 'Unnamed request') as contact_name,
             coalesce(contact ->> 'zip', 'ZIP not supplied') as contact_zip, is_dev_seed
      from bookings
      where service_vertical is not null and (${devOnly} = false or is_dev_seed)
        and qualification_status not in ('declined')
      order by created_at desc limit 60`,
    sql<ScheduleRow[]>`
      select s.id, s.booking_id, s.service_vertical, s.territory_id, t.name as territory_name,
             t.timezone as territory_timezone, s.start_at::text, s.end_at::text, s.status,
             s.required_crew_size, s.required_skills, s.labor_minutes,
             s.travel_buffer_minutes, s.is_dev_seed, count(a.id)::int as assignment_count
      from job_schedules s join service_territories t on t.id = s.territory_id
      left join job_assignments a on a.job_schedule_id = s.id and a.status <> 'removed'
      where (${devOnly} = false or s.is_dev_seed)
        and s.end_at >= now() - interval '7 days'
      group by s.id, t.name, t.timezone
      order by s.start_at asc limit 60`,
    sql<ServiceCaseRow[]>`
      select c.id, c.public_reference, c.case_type, c.booking_id,
             coalesce(contact ->> 'name', 'Unnamed customer') as contact_name,
             c.status, c.priority, c.details, c.created_at::text, c.is_dev_seed,
             coalesce(refundable.balance_cents, 0)::int as refundable_balance_cents,
             (c.booking_id is not null
               and c.case_type in ('refund_review', 'complaint', 'reclean', 'damage')
               and c.status = 'refund_pending'
               and coalesce(refundable.balance_cents, 0) > 0) as refund_eligible
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
    sql<RefundRow[]>`
      select id, service_case_id, booking_id, amount_cents, status, provider,
             reason_code, provider_refund_id, created_at::text
      from refund_records
      where (${devOnly} = false or is_dev_seed)
      order by created_at desc limit 50`,
    sql<TimeOffOpsRow[]>`
      select o.id, o.cleaner_id, c.full_name as cleaner_name, o.start_at::text,
             o.end_at::text, o.status, o.reason_category, o.is_dev_seed
      from cleaner_time_off o join cleaners c on c.id = o.cleaner_id
      where (${devOnly} = false or o.is_dev_seed)
        and o.status = 'requested'
      order by o.start_at asc limit 50`,
    sql<OutboxSummary[]>`
      select status, count(*)::int as count from notification_outbox
      where (${devOnly} = false or exists (
        select 1 from bookings b where b.id = notification_outbox.booking_id and b.is_dev_seed
      ) or exists (
        select 1 from service_cases c where c.id = notification_outbox.service_case_id and c.is_dev_seed
      )) group by status order by status`,
    sql<OutboxQueueRow[]>`
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
    serviceCases,
    refunds,
    timeOff,
    outbox,
    outboxQueue,
  };
}

type CapacityRow = {
  id: string;
  skills: string[];
  vertical_experience: ServiceVertical[];
  max_daily_minutes: number;
  max_weekly_minutes: number;
  home_territory_id: string | null;
};

type SpanRow = {
  cleaner_id: string;
  start_at: string;
  end_at: string;
  minutes_today?: number;
  minutes_week?: number;
};

function combinations<T>(items: T[], size: number, limit = 30): T[][] {
  const result: T[][] = [];
  function visit(start: number, selected: T[]) {
    if (result.length >= limit) return;
    if (selected.length === size) {
      result.push(selected);
      return;
    }
    for (
      let index = start;
      index <= items.length - (size - selected.length);
      index += 1
    ) {
      visit(index + 1, [...selected, items[index]]);
    }
  }
  visit(0, []);
  return result;
}

export type ConsoleSuggestion = AssignmentSuggestion & {
  cleanerIds: string[];
  cleanerNames: string[];
};

export async function getScheduleSuggestions(
  scheduleId: string,
  devOnly: boolean,
): Promise<ConsoleSuggestion[]> {
  const schedules = await sql<
    (ScheduleRow & {
      qualification_status: string;
      qualification_requirements: Record<string, unknown>;
    })[]
  >`
    select s.id, s.booking_id, s.service_vertical, s.territory_id, t.name as territory_name,
           t.timezone as territory_timezone, s.start_at::text, s.end_at::text, s.status,
           s.required_crew_size, s.required_skills, s.labor_minutes, s.travel_buffer_minutes,
           s.is_dev_seed, 0::int as assignment_count, b.qualification_status,
           b.qualification_requirements
    from job_schedules s join bookings b on b.id = s.booking_id
    join service_territories t on t.id = s.territory_id
    where s.id = ${scheduleId} and (${devOnly} = false or (s.is_dev_seed and b.is_dev_seed))`;
  const schedule = schedules[0];
  if (!schedule || ["completed", "canceled"].includes(schedule.status))
    return [];

  const [capacity, availability, timeOff, assignments, loads] =
    await Promise.all([
      sql<(CapacityRow & { full_name: string })[]>`
      select id, full_name, skills, vertical_experience, max_daily_minutes,
             max_weekly_minutes, home_territory_id
      from cleaners where status = 'active'
        and home_territory_id = ${schedule.territory_id}
        and (${devOnly} = false or is_dev_seed)
      order by full_name limit 20`,
      sql<SpanRow[]>`
      select a.cleaner_id,
        (((s.start_at at time zone t.timezone)::date + a.start_time) at time zone t.timezone)::text as start_at,
        (((s.start_at at time zone t.timezone)::date + a.end_time) at time zone t.timezone)::text as end_at
      from job_schedules s join service_territories t on t.id = s.territory_id
      join cleaner_availability_rules a on a.territory_id = s.territory_id
        and a.day_of_week = extract(dow from s.start_at at time zone t.timezone)::int
        and a.status = 'active'
        and a.effective_from <= (s.start_at at time zone t.timezone)::date
        and (a.effective_to is null or a.effective_to >= (s.start_at at time zone t.timezone)::date)
      where s.id = ${scheduleId}`,
      sql<SpanRow[]>`
      select o.cleaner_id, o.start_at::text, o.end_at::text
      from cleaner_time_off o where o.status = 'approved'
        and o.start_at < ${schedule.end_at}::timestamptz and o.end_at > ${schedule.start_at}::timestamptz`,
      sql<SpanRow[]>`
      select a.cleaner_id, s.start_at::text, s.end_at::text
      from job_assignments a join job_schedules s on s.id = a.job_schedule_id
      where a.status in ('accepted', 'confirmed') and s.id <> ${scheduleId}
        and s.status not in ('completed', 'canceled')
        and s.start_at < ${schedule.end_at}::timestamptz + interval '3 hours'
        and s.end_at > ${schedule.start_at}::timestamptz - interval '3 hours'`,
      sql<
        { cleaner_id: string; minutes_today: number; minutes_week: number }[]
      >`
      select c.id as cleaner_id,
        coalesce(sum(extract(epoch from (s.end_at - s.start_at)) / 60)
          filter (where (s.start_at at time zone 'America/Los_Angeles')::date =
            (${schedule.start_at}::timestamptz at time zone 'America/Los_Angeles')::date), 0)::int as minutes_today,
        coalesce(sum(extract(epoch from (s.end_at - s.start_at)) / 60)
          filter (where date_trunc('week', s.start_at at time zone 'America/Los_Angeles') =
            date_trunc('week', ${schedule.start_at}::timestamptz at time zone 'America/Los_Angeles')), 0)::int as minutes_week
      from cleaners c left join job_assignments a on a.cleaner_id = c.id and a.status in ('accepted', 'confirmed')
      left join job_schedules s on s.id = a.job_schedule_id and s.status not in ('completed', 'canceled')
      where c.status = 'active' and c.home_territory_id = ${schedule.territory_id}
        and (${devOnly} = false or c.is_dev_seed) group by c.id`,
    ]);

  const nameById = new Map(
    capacity.map((cleaner) => [cleaner.id, cleaner.full_name]),
  );
  const capacityById = new Map<string, CleanerCapacity>();
  for (const cleaner of capacity) {
    const load = loads.find((row) => row.cleaner_id === cleaner.id);
    capacityById.set(cleaner.id, {
      id: cleaner.id,
      active: true,
      skills: cleaner.skills,
      verticalExperience: cleaner.vertical_experience,
      availability: availability
        .filter((row) => row.cleaner_id === cleaner.id)
        .map((row) => ({ start: row.start_at, end: row.end_at })),
      timeOff: timeOff
        .filter((row) => row.cleaner_id === cleaner.id)
        .map((row) => ({ start: row.start_at, end: row.end_at })),
      assignments: assignments
        .filter((row) => row.cleaner_id === cleaner.id)
        .map((row) => ({ start: row.start_at, end: row.end_at })),
      assignedMinutesToday: load?.minutes_today ?? 0,
      assignedMinutesThisWeek: load?.minutes_week ?? 0,
      maxDailyMinutes: cleaner.max_daily_minutes,
      maxWeeklyMinutes: cleaner.max_weekly_minutes,
    });
  }

  const crewGroups = combinations(capacity, schedule.required_crew_size);
  const candidates: AssignmentCandidate[] = crewGroups.map((group) => ({
    id: group
      .map((cleaner) => cleaner.id)
      .sort()
      .join("+"),
    territoryIds: [schedule.territory_id],
    cleaners: group.map((cleaner) => capacityById.get(cleaner.id)!),
    estimatedTravelMinutes: schedule.travel_buffer_minutes,
    travelBufferMinutes: schedule.travel_buffer_minutes,
  }));
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
  };
  return rankAssignmentSuggestions(job, candidates).map((suggestion) => {
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

export async function createTerritoryDraft(input: {
  code: string;
  name: string;
  postalCodes: string[];
  devOnly: boolean;
}) {
  return sql.begin(async (tx) => {
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
  territoryId: string,
  postalCode: string,
  status: "review" | "active" | "excluded",
  devOnly: boolean,
) {
  await sql`update territory_postal_codes p set status = ${status}
    from service_territories t where p.territory_id = t.id and t.id = ${territoryId}
      and p.postal_code = ${postalCode} and (${devOnly} = false or t.is_dev_seed)`;
}

export async function setTerritoryStatus(
  territoryId: string,
  status: "draft" | "active" | "paused",
  devOnly: boolean,
) {
  if (status === "active") {
    const readiness = await sql<{ ready: boolean }[]>`
      select exists(select 1 from territory_postal_codes where territory_id = ${territoryId} and status = 'active')
        and exists(select 1 from cleaners where home_territory_id = ${territoryId} and status = 'active') as ready`;
    if (!readiness[0]?.ready)
      throw new Error(
        "An active postal code and active cleaner are required before territory activation",
      );
  }
  await sql`update service_territories set status = ${status} where id = ${territoryId}
    and (${devOnly} = false or is_dev_seed)`;
}

export async function setCleanerApplicationStatus(
  applicationId: string,
  from: string,
  to: string,
  devOnly: boolean,
) {
  const rows = await sql<
    { id: string }[]
  >`update cleaner_applications set status = ${to}
    where id = ${applicationId} and status = ${from}
      and (${devOnly} = false or is_dev_seed) returning id`;
  return Boolean(rows[0]);
}

export async function createOnboardingCleaner(
  applicationId: string,
  territoryId: string,
  devOnly: boolean,
) {
  return sql.begin(async (tx) => {
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
  cleanerId: string,
  devOnly: boolean,
) {
  const rows = await sql<{ id: string }[]>`update cleaners
    set screening_status = 'verified', screening_verified_at = now()
    where id = ${cleanerId} and status = 'onboarding'
      and (${devOnly} = false or is_dev_seed) returning id`;
  return Boolean(rows[0]);
}

export async function addCleanerAvailability(input: {
  cleanerId: string;
  territoryId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  devOnly: boolean;
}) {
  const cleaners = await sql<
    { id: string }[]
  >`select id from cleaners where id = ${input.cleanerId}
    and home_territory_id = ${input.territoryId} and (${input.devOnly} = false or is_dev_seed)`;
  if (!cleaners[0]) throw new Error("Cleaner and territory do not match");
  await sql`insert into cleaner_availability_rules
    (cleaner_id, territory_id, day_of_week, start_time, end_time, status)
    values (${input.cleanerId}, ${input.territoryId}, ${input.dayOfWeek}, ${input.startTime}, ${input.endTime}, 'active')`;
}

export async function setCleanerStatus(
  cleanerId: string,
  status: "active" | "paused" | "inactive",
  devOnly: boolean,
) {
  if (status === "active") {
    const readiness = await sql<{ ready: boolean }[]>`select
      c.screening_status = 'verified'
      and c.home_territory_id is not null
      and exists(select 1 from cleaner_availability_rules a where a.cleaner_id = c.id and a.status = 'active') as ready
      from cleaners c where c.id = ${cleanerId} and (${devOnly} = false or c.is_dev_seed)`;
    if (!readiness[0]?.ready)
      throw new Error(
        "Verified screening, a home territory, and active availability are required before activation",
      );
  }
  await sql`update cleaners set status = ${status} where id = ${cleanerId}
    and (${devOnly} = false or is_dev_seed)`;
}

export async function setCleanerCapabilities(input: {
  cleanerId: string;
  skills: string[];
  verticalExperience: ServiceVertical[];
  devOnly: boolean;
}) {
  await sql`update cleaners set skills = ${input.skills}, vertical_experience = ${input.verticalExperience}
    where id = ${input.cleanerId} and (${input.devOnly} = false or is_dev_seed)`;
}

export async function setQualificationStatus(
  bookingId: string,
  from: string,
  to: string,
  requirements: Record<string, unknown>,
  devOnly: boolean,
) {
  const rows = await sql<{ id: string }[]>`
    update bookings set qualification_status = ${to}, qualification_requirements = qualification_requirements || ${sql.json(requirements as postgres.JSONValue)}
    where id = ${bookingId} and qualification_status = ${from}
      and (${devOnly} = false or is_dev_seed) returning id`;
  return Boolean(rows[0]);
}

export async function createJobSchedule(input: {
  bookingId: string;
  territoryId: string;
  startAt: string;
  endAt: string;
  devOnly: boolean;
}) {
  return sql.begin(async (tx) => {
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
        and (${input.devOnly} = false or is_dev_seed) for update`;
    if (!bookings[0]?.service_vertical)
      throw new Error(
        "Booking must be qualification-approved before scheduling",
      );
    const territories = await tx<{ travel_buffer_minutes: number }[]>`
      select travel_buffer_minutes from service_territories where id = ${input.territoryId}
        and status = 'active' and (${input.devOnly} = false or is_dev_seed)`;
    if (!territories[0])
      throw new Error("Choose an active, capacity-backed territory");
    const elapsedMinutes = Math.round(
      (Date.parse(input.endAt) - Date.parse(input.startAt)) / 60000,
    );
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
      values (${input.bookingId}, ${input.territoryId}, ${booking.service_vertical}, ${input.startAt},
        ${input.endAt}, 'tentative', ${booking.required_crew_size}, ${booking.required_skills},
        ${laborMinutes}, ${territories[0].travel_buffer_minutes},
        ${input.devOnly}) returning id`;
    return rows[0];
  });
}

export async function setJobScheduleStatus(
  scheduleId: string,
  from: string,
  to: string,
  devOnly: boolean,
) {
  const rows = await sql<
    { id: string }[]
  >`update job_schedules set status = ${to}, version = version + 1
    where id = ${scheduleId} and status = ${from}
      and (${devOnly} = false or is_dev_seed) returning id`;
  return Boolean(rows[0]);
}

export async function proposeAssignmentCandidate(
  scheduleId: string,
  candidateId: string,
  devOnly: boolean,
) {
  const suggestions = await getScheduleSuggestions(scheduleId, devOnly);
  const suggestion = suggestions.find(
    (item) => item.candidateId === candidateId && item.eligible,
  );
  if (!suggestion)
    throw new Error("That crew is no longer eligible; refresh suggestions");
  await sql.begin(async (tx) => {
    for (const [index, cleanerId] of suggestion.cleanerIds.entries()) {
      await tx`insert into job_assignments
        (job_schedule_id, cleaner_id, assignment_role, status, suggestion_score,
         suggestion_reasons, assigned_by_label, is_dev_seed)
        values (${scheduleId}, ${cleanerId}, ${index === 0 ? "lead" : "member"}, 'proposed',
          ${suggestion.score}, ${tx.json(suggestion.reasons as postgres.JSONValue)}, 'Operator', ${devOnly})
        on conflict (job_schedule_id, cleaner_id) do update set
          status = 'proposed', suggestion_score = excluded.suggestion_score,
          suggestion_reasons = excluded.suggestion_reasons, assigned_at = now()`;
    }
  });
}

export async function setServiceCaseStatus(
  caseId: string,
  from: string,
  to: string,
  devOnly: boolean,
) {
  const rows = await sql<
    { id: string }[]
  >`update service_cases set status = ${to}
    where id = ${caseId} and status = ${from} and (${devOnly} = false or is_dev_seed) returning id`;
  return Boolean(rows[0]);
}

export async function rescheduleBookingFromCase(input: {
  caseId: string;
  startAt: string;
  endAt: string;
  devOnly: boolean;
}) {
  return sql.begin(async (tx) => {
    const rows = await tx<
      { schedule_id: string; labor_minutes: number; required_crew_size: number }[]
    >`
      select s.id as schedule_id, s.labor_minutes, s.required_crew_size from service_cases c
      join job_schedules s on s.booking_id = c.booking_id
      where c.id = ${input.caseId} and c.case_type = 'reschedule'
        and c.status = 'action_planned' and (${input.devOnly} = false or (c.is_dev_seed and s.is_dev_seed))
      for update of c, s`;
    if (!rows[0])
      throw new Error(
        "Reschedule case must be action-planned and linked to a schedule",
      );
    const elapsedMinutes = Math.round(
      (Date.parse(input.endAt) - Date.parse(input.startAt)) / 60000,
    );
    const requiredMinutes = requiredElapsedMinutes(
      rows[0].labor_minutes,
      rows[0].required_crew_size,
    );
    if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < requiredMinutes) {
      throw new Error(
        `Reschedule needs at least ${requiredMinutes} elapsed minutes for the existing labor plan and crew size`,
      );
    }
    await tx`update job_schedules set start_at = ${input.startAt}, end_at = ${input.endAt},
      version = version + 1 where id = ${rows[0].schedule_id}`;
    await tx`update bookings b set
      scheduled_date = (s.start_at at time zone t.timezone)::date,
      scheduled_window = 'Operator-confirmed window'
      from job_schedules s join service_territories t on t.id = s.territory_id
      where s.id = ${rows[0].schedule_id} and b.id = s.booking_id`;
    await tx`update service_cases set status = 'resolved', resolution_type = 'rescheduled',
      resolution_summary = 'Schedule updated by operator after capacity validation.', resolved_at = now()
      where id = ${input.caseId}`;
    return rows[0];
  });
}

export async function cancelBookingFromCase(caseId: string, devOnly: boolean) {
  return sql.begin(async (tx) => {
    const rows = await tx<
      { booking_id: string }[]
    >`select booking_id from service_cases
      where id = ${caseId} and case_type = 'cancel' and status = 'action_planned'
        and booking_id is not null and (${devOnly} = false or is_dev_seed) for update`;
    if (!rows[0])
      throw new Error(
        "Cancellation case must be action-planned and linked to a booking",
      );
    const bookingId = rows[0].booking_id;
    await tx`update job_schedules set status = 'canceled', version = version + 1
      where booking_id = ${bookingId} and status <> 'completed'`;
    await tx`update bookings set status = 'canceled' where id = ${bookingId} and status <> 'completed'`;
    await tx`insert into booking_events (booking_id, type, data)
      values (${bookingId}, 'canceled_from_service_case', ${tx.json({ serviceCaseId: caseId })})`;
    await tx`update service_cases set status = 'resolved', resolution_type = 'canceled',
      resolution_summary = 'Booking and active schedule canceled by operator.', resolved_at = now()
      where id = ${caseId}`;
  });
}

export async function createRecoveryAction(input: {
  caseId: string;
  bookingId: string | null;
  type: string;
  notes: string;
  devOnly: boolean;
}) {
  await sql`insert into service_recovery_actions
    (service_case_id, booking_id, action_type, notes, status, is_dev_seed)
    select id, booking_id, ${input.type}, ${input.notes || null}, 'planned', ${input.devOnly}
    from service_cases where id = ${input.caseId} and (${input.devOnly} = false or is_dev_seed)`;
}

export async function createRefundReview(input: {
  caseId: string;
  amountCents: number;
  reasonCode: string;
  devOnly: boolean;
}) {
  return sql.begin(async (tx) => {
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
      (service_case_id, booking_id, billing_record_id, amount_cents, reason_code,
       status, provider, requested_by_label, is_dev_seed)
      values (${input.caseId}, ${rows[0].booking_id}, ${rows[0].billing_record_id},
        ${input.amountCents}, ${input.reasonCode}, 'requested', 'manual', 'Operator', ${input.devOnly})`;
  });
}

export async function setRefundStatus(
  refundId: string,
  from: string,
  to: string,
  providerReference: string | null,
  devOnly: boolean,
) {
  const rows = await sql<
    { id: string }[]
  >`update refund_records set status = ${to},
      approved_by_label = case when ${to} = 'approved' then 'Operator' else approved_by_label end,
      approved_at = case when ${to} = 'approved' then now() else approved_at end,
      processed_at = case when ${to} = 'processed' then now() else processed_at end,
      provider_refund_id = case when ${to} = 'processed' then ${providerReference} else provider_refund_id end
    where id = ${refundId} and status = ${from} and (${devOnly} = false or is_dev_seed) returning id`;
  return Boolean(rows[0]);
}

export async function reviewTimeOff(
  timeOffId: string,
  status: "approved" | "declined",
  devOnly: boolean,
) {
  await sql`update cleaner_time_off set status = ${status}, reviewed_by_label = 'Operator', reviewed_at = now()
    where id = ${timeOffId} and status = 'requested' and (${devOnly} = false or is_dev_seed)`;
}
