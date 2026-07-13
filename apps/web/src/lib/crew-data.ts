import "server-only";

import { sql } from "./db";

export type Cleaner = {
  id: string;
  external_auth_id: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  status: "onboarding" | "active" | "paused" | "inactive";
  skills: string[];
  vertical_experience: string[];
  home_territory_name: string | null;
  max_daily_minutes: number;
  max_weekly_minutes: number;
  is_dev_seed: boolean;
};

export type CrewAssignment = {
  id: string;
  schedule_id: string;
  service_vertical: string;
  start_at: string;
  end_at: string;
  schedule_status: string;
  assignment_status: string;
  assignment_role: string;
  territory_name: string;
  required_skills: string[];
  planning_direction: string | null;
};

export type AvailabilityRule = {
  id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  territory_name: string | null;
  status: string;
};

export type TimeOffRow = {
  id: string;
  start_at: string;
  end_at: string;
  status: string;
  reason_category: string;
};

async function cleanerSelect(where: ReturnType<typeof sql>) {
  const rows = await sql<Cleaner[]>`
    select c.id, c.external_auth_id, c.full_name, c.email, c.phone, c.status,
           c.skills, c.vertical_experience, t.name as home_territory_name,
           c.max_daily_minutes, c.max_weekly_minutes, c.is_dev_seed
    from cleaners c
    left join service_territories t on t.id = c.home_territory_id
    where ${where}
    limit 1`;
  return rows[0] ?? null;
}

export async function getCleanerByExternalAuthId(externalAuthId: string) {
  return cleanerSelect(sql`c.external_auth_id = ${externalAuthId}`);
}

export async function getCleanerByEmail(email: string) {
  return cleanerSelect(sql`lower(c.email) = lower(${email})`);
}

export async function linkCleanerExternalAuthIdByVerifiedEmail(
  externalAuthId: string,
  verifiedEmail: string,
) {
  const normalizedEmail = verifiedEmail.trim().toLowerCase();
  if (!externalAuthId || !normalizedEmail) return false;

  return sql.begin(async (transaction) => {
    const alreadyLinked = await transaction<{ id: string }[]>`
      select id from cleaners
      where external_auth_id = ${externalAuthId}
      limit 1 for update`;
    if (alreadyLinked[0]) return true;

    const candidates = await transaction<
      { id: string; external_auth_id: string | null }[]
    >`
      select id, external_auth_id from cleaners
      where lower(email) = ${normalizedEmail}
        and status in ('onboarding', 'active')
      order by created_at asc
      limit 2 for update`;
    if (candidates.length !== 1 || candidates[0].external_auth_id) return false;

    const linked = await transaction<{ id: string }[]>`
      update cleaners set external_auth_id = ${externalAuthId}
      where id = ${candidates[0].id} and external_auth_id is null
      returning id`;
    return Boolean(linked[0]);
  });
}

export async function getCrewAssignments(cleanerId: string, devOnly: boolean) {
  return sql<CrewAssignment[]>`
    select a.id, s.id as schedule_id, s.service_vertical, s.start_at::text,
           s.end_at::text, s.status as schedule_status, a.status as assignment_status,
           a.assignment_role, t.name as territory_name, s.required_skills,
           b.planning_direction
    from job_assignments a
    join job_schedules s on s.id = a.job_schedule_id
    join bookings b on b.id = s.booking_id
    join service_territories t on t.id = s.territory_id
    where a.cleaner_id = ${cleanerId}
      and (${devOnly} = false or (a.is_dev_seed and s.is_dev_seed and b.is_dev_seed))
      and s.start_at >= now() - interval '1 day'
    order by s.start_at asc
    limit 30`;
}

export async function getCleanerAvailability(cleanerId: string) {
  return sql<AvailabilityRule[]>`
    select a.id, a.day_of_week, a.start_time::text, a.end_time::text,
           t.name as territory_name, a.status
    from cleaner_availability_rules a
    left join service_territories t on t.id = a.territory_id
    where a.cleaner_id = ${cleanerId}
      and (a.effective_to is null or a.effective_to >= current_date)
    order by a.day_of_week, a.start_time`;
}

export async function getCleanerTimeOff(cleanerId: string) {
  return sql<TimeOffRow[]>`
    select id, start_at::text, end_at::text, status, reason_category
    from cleaner_time_off
    where cleaner_id = ${cleanerId}
      and end_at >= now() - interval '1 day'
    order by start_at asc
    limit 20`;
}

export async function respondToAssignment(
  cleanerId: string,
  assignmentId: string,
  response: "accepted" | "declined",
  devOnly: boolean,
) {
  const rows = await sql<{ id: string }[]>`
    update job_assignments a
    set status = ${response}, responded_at = now()
    from job_schedules s
    where a.id = ${assignmentId}
      and a.cleaner_id = ${cleanerId}
      and a.job_schedule_id = s.id
      and a.status = 'proposed'
      and (${devOnly} = false or (a.is_dev_seed and s.is_dev_seed))
    returning a.id`;
  return Boolean(rows[0]);
}

export async function requestTimeOff(input: {
  cleanerId: string;
  startAt: string;
  endAt: string;
  reasonCategory: "unavailable" | "personal" | "medical" | "training" | "other";
}) {
  await sql`
    insert into cleaner_time_off (cleaner_id, start_at, end_at, reason_category, status)
    values (${input.cleanerId}, ${input.startAt}, ${input.endAt}, ${input.reasonCategory}, 'requested')`;
}
