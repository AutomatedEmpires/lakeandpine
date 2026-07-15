import "server-only";

import { sql } from "./db";
import { localDateTimeToUtc, validateUtcInterval } from "./zoned-datetime";

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
  home_territory_timezone: string | null;
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
  territory_timezone: string;
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

export async function getCleanerByExternalAuthId(externalAuthId: string) {
  if (!externalAuthId) return null;
  const rows = await sql<Cleaner[]>`
    select * from private.cleaner_identity_by_external_auth_id(${externalAuthId}::text)`;
  return rows[0] ?? null;
}

export async function getCleanerByEmail(email: string) {
  const verifiedEmail = email.trim().toLowerCase();
  if (!verifiedEmail) return null;
  const rows = await sql<Cleaner[]>`
    select * from private.cleaner_identity_by_verified_email(${verifiedEmail}::text)`;
  return rows[0] ?? null;
}

export async function linkCleanerExternalAuthIdByVerifiedEmail(
  externalAuthId: string,
  verifiedEmail: string,
) {
  const normalizedEmail = verifiedEmail.trim().toLowerCase();
  if (!externalAuthId || !normalizedEmail) return false;
  const rows = await sql<Cleaner[]>`
    select * from private.claim_cleaner_external_auth_id(
      ${externalAuthId}::text, ${normalizedEmail}::text
    )`;
  return Boolean(rows[0]);
}

export async function getCrewAssignments(cleanerId: string, devOnly: boolean) {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleanerId}, true)`;
    return transaction<CrewAssignment[]>`
      select * from private.current_cleaner_assignments(${devOnly})`;
  });
}

export async function getCleanerAvailability(cleanerId: string) {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleanerId}, true)`;
    return transaction<AvailabilityRule[]>`
      select a.id, a.day_of_week, a.start_time::text, a.end_time::text,
             t.name as territory_name, a.status
      from cleaner_availability_rules a
      left join service_territories t on t.id = a.territory_id
      where a.cleaner_id = ${cleanerId}
        and (a.effective_to is null or a.effective_to >= current_date)
      order by a.day_of_week, a.start_time`;
  });
}

export async function getCleanerTimeOff(cleanerId: string) {
  return sql.begin(async (transaction) => {
    // Clear the staff actor before setting the cleaner actor on this pooled session.
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleanerId}, true)`;
    return transaction<TimeOffRow[]>`
      select id, start_at::text, end_at::text, status, reason_category
      from cleaner_time_off
      where cleaner_id = ${cleanerId}
        and end_at >= now() - interval '1 day'
      order by start_at asc
      limit 20`;
  });
}

export async function respondToAssignment(
  cleanerId: string,
  assignmentId: string,
  response: "accepted" | "declined",
  devOnly: boolean,
) {
  return sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleanerId}, true)`;
    const rows = await transaction<{ id: string }[]>`
      update job_assignments
      set status = ${response}, responded_at = now()
      where id = ${assignmentId}
        and cleaner_id = ${cleanerId}
        and status = 'proposed'
        and team_id is not null
        and (${devOnly} = false or is_dev_seed)
      returning id`;
    return Boolean(rows[0]);
  });
}

export async function requestTimeOff(input: {
  cleanerId: string;
  membershipId: string;
  startLocal: string;
  endLocal: string;
  reasonCategory: "unavailable" | "personal" | "medical" | "training" | "other";
  devOnly: boolean;
}) {
  await sql.begin(async (transaction) => {
    // Clear the staff actor before setting the cleaner actor so a pooled
    // session can never evaluate RLS under a mixed identity.
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${input.cleanerId}, true)`;
    const memberships = await transaction<{
      organization_id: string;
      team_id: string;
      timezone: string;
    }[]>`
      select membership.organization_id, membership.team_id, team.timezone
      from workforce_memberships membership
      join cleaning_teams team on team.id = membership.team_id
      join cleaners cleaner on cleaner.id = membership.cleaner_id
      where membership.id = ${input.membershipId}
        and membership.cleaner_id = ${input.cleanerId}
        and membership.role in ('cleaner','shift_lead')
        and membership.status = 'active'
        and cleaner.status in ('onboarding','active')
        and (${input.devOnly} = false or (
          membership.is_dev_seed and cleaner.is_dev_seed and team.is_dev_seed
        ))
      limit 1`;
    if (!memberships[0]) {
      throw new Error("Choose an active team before requesting time off");
    }
    const startAt = localDateTimeToUtc(input.startLocal, memberships[0].timezone);
    const endAt = localDateTimeToUtc(input.endLocal, memberships[0].timezone);
    validateUtcInterval(startAt, endAt, { maxMinutes: 14 * 24 * 60 });
    await transaction`
      insert into cleaner_time_off
        (organization_id, team_id, cleaner_id, start_at, end_at,
         reason_category)
      values (${memberships[0].organization_id}, ${memberships[0].team_id},
        ${input.cleanerId}, ${startAt}, ${endAt}, ${input.reasonCategory})`;
  });
}
