-- Keep reservation capacity days aligned to the service territory timezone.
-- Casting a date directly with AT TIME ZONE first coerces it through the
-- session timezone. Convert the local date to a timestamp before applying the
-- territory timezone, matching the established base capacity function.

create or replace function assert_scheduling_reservation_capacity(
  requested_cleaner_id uuid,
  requested_assignment_id uuid,
  requested_schedule_id uuid,
  requested_start timestamptz,
  requested_end timestamptz,
  requested_territory_id uuid,
  requested_travel_buffer integer
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  requested_minutes integer;
  territory_timezone text;
  local_start timestamp;
  day_start_at timestamptz;
  day_end_at timestamptz;
  week_start_at timestamptz;
  week_end_at timestamptz;
  cleaner_daily_minutes integer;
  cleaner_weekly_minutes integer;
  cleaner_daily_jobs integer;
  reserved_daily_minutes integer;
  reserved_weekly_minutes integer;
  reserved_daily_jobs integer;
  assigned_daily_minutes integer;
  assigned_weekly_minutes integer;
  assigned_daily_jobs integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(requested_cleaner_id::text, 0));

  perform assert_cleaner_schedule_capacity(
    requested_cleaner_id,
    requested_schedule_id,
    requested_start,
    requested_end,
    requested_territory_id,
    requested_travel_buffer
  );

  select cleaner.max_daily_minutes, cleaner.max_weekly_minutes,
         cleaner.max_daily_jobs, territory.timezone
    into cleaner_daily_minutes, cleaner_weekly_minutes,
         cleaner_daily_jobs, territory_timezone
  from cleaners cleaner
  join service_territories territory on territory.id = requested_territory_id
  where cleaner.id = requested_cleaner_id;

  local_start := requested_start at time zone territory_timezone;
  day_start_at := local_start::date::timestamp at time zone territory_timezone;
  day_end_at := (local_start::date + 1)::timestamp at time zone territory_timezone;
  week_start_at := date_trunc('week', local_start) at time zone territory_timezone;
  week_end_at := (date_trunc('week', local_start) + interval '7 days') at time zone territory_timezone;
  requested_minutes := ceil(extract(epoch from (requested_end - requested_start)) / 60);

  if exists (
    select 1
    from job_assignments assignment
    join job_schedules schedule on schedule.id = assignment.job_schedule_id
    join capacity_holds hold on hold.job_schedule_id = schedule.id
    where assignment.cleaner_id = requested_cleaner_id
      and assignment.status = 'reserved'
      and assignment.id <> requested_assignment_id
      and schedule.id <> requested_schedule_id
      and schedule.status <> 'canceled'
      and hold.status = 'active'
      and hold.expires_at > now()
      and schedule.start_at < requested_end + make_interval(mins => requested_travel_buffer)
      and schedule.end_at + make_interval(mins => schedule.travel_buffer_minutes) > requested_start
  ) then
    raise exception 'Cleaner % has a conflicting active capacity hold', requested_cleaner_id
      using errcode = '23P01';
  end if;

  select
    coalesce(sum(
      case when schedule.start_at < day_end_at and schedule.end_at > day_start_at
        then ceil(extract(epoch from (schedule.end_at - schedule.start_at)) / 60)
        else 0 end
    ), 0)::integer,
    coalesce(sum(
      case when schedule.start_at < week_end_at and schedule.end_at > week_start_at
        then ceil(extract(epoch from (schedule.end_at - schedule.start_at)) / 60)
        else 0 end
    ), 0)::integer,
    count(*) filter (
      where schedule.start_at < day_end_at and schedule.end_at > day_start_at
    )::integer
    into reserved_daily_minutes, reserved_weekly_minutes, reserved_daily_jobs
  from job_assignments assignment
  join job_schedules schedule on schedule.id = assignment.job_schedule_id
  join capacity_holds hold on hold.job_schedule_id = schedule.id
  where assignment.cleaner_id = requested_cleaner_id
    and assignment.status = 'reserved'
    and assignment.id <> requested_assignment_id
    and schedule.id <> requested_schedule_id
    and schedule.status <> 'canceled'
    and hold.status = 'active'
    and hold.expires_at > now()
    and schedule.start_at < week_end_at
    and schedule.end_at > week_start_at;

  select
    coalesce(sum(
      case when schedule.start_at < day_end_at and schedule.end_at > day_start_at
        then ceil(extract(epoch from
          (least(schedule.end_at, day_end_at) - greatest(schedule.start_at, day_start_at))) / 60)
        else 0 end
    ), 0)::integer,
    coalesce(sum(
      case when schedule.start_at < week_end_at and schedule.end_at > week_start_at
        then ceil(extract(epoch from
          (least(schedule.end_at, week_end_at) - greatest(schedule.start_at, week_start_at))) / 60)
        else 0 end
    ), 0)::integer,
    count(distinct schedule.id) filter (
      where schedule.start_at < day_end_at and schedule.end_at > day_start_at
    )::integer
    into assigned_daily_minutes, assigned_weekly_minutes, assigned_daily_jobs
  from job_assignments assignment
  join job_schedules schedule on schedule.id = assignment.job_schedule_id
  where assignment.cleaner_id = requested_cleaner_id
    and assignment.status in ('accepted', 'confirmed')
    and assignment.id <> requested_assignment_id
    and schedule.id <> requested_schedule_id
    and schedule.status <> 'canceled'
    and schedule.start_at < week_end_at
    and schedule.end_at > week_start_at;

  if assigned_daily_jobs + reserved_daily_jobs + 1 > cleaner_daily_jobs then
    raise exception 'Cleaner % would exceed daily job capacity including holds', requested_cleaner_id
      using errcode = '23514';
  end if;
  if assigned_daily_minutes + reserved_daily_minutes + requested_minutes > cleaner_daily_minutes then
    raise exception 'Cleaner % would exceed daily minute capacity including holds', requested_cleaner_id
      using errcode = '23514';
  end if;
  if assigned_weekly_minutes + reserved_weekly_minutes + requested_minutes > cleaner_weekly_minutes then
    raise exception 'Cleaner % would exceed weekly minute capacity including holds', requested_cleaner_id
      using errcode = '23514';
  end if;
end
$$;

revoke all on function assert_scheduling_reservation_capacity(
  uuid, uuid, uuid, timestamptz, timestamptz, uuid, integer
) from public;
grant execute on function assert_scheduling_reservation_capacity(
  uuid, uuid, uuid, timestamptz, timestamptz, uuid, integer
) to lakeandpine_app;
