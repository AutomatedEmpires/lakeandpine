-- Customer scheduling authority ------------------------------------------------
--
-- This migration is intentionally additive. It does not enable public intake,
-- seed production scheduling policy, send notifications, or move money. Active
-- policy and evidenced workforce capacity are both required before a customer
-- can receive a capacity-backed slot.

create table service_scheduling_policies (
  id uuid primary key default gen_random_uuid(),
  service_id text not null references services(id),
  territory_id uuid not null references service_territories(id),
  version integer not null check (version > 0),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'retired')),
  scheduling_path text not null default 'consultation'
    check (scheduling_path in ('direct', 'conditional_hold', 'consultation')),
  condition_key text,
  condition_label text,
  allowed_contexts text[] not null default '{}',
  allowed_size_bands text[] not null default array['compact', 'standard']::text[]
    check (allowed_size_bands <@ array['compact', 'standard', 'large', 'exceptional']::text[]),
  allowed_conditions text[] not null default array['maintained']::text[]
    check (allowed_conditions <@ array['maintained', 'detailed', 'project']::text[]),
  allowed_cadences text[] not null default array['project']::text[]
    check (allowed_cadences <@ array['project', 'weekly', 'biweekly', 'monthly', 'seasonal', 'custom']::text[]),
  labor_minutes integer not null check (labor_minutes between 30 and 2400),
  required_crew_size integer not null check (required_crew_size between 1 and 20),
  required_skills text[] not null default '{}',
  travel_buffer_minutes integer not null default 30
    check (travel_buffer_minutes between 0 and 180),
  minimum_lead_hours integer not null default 24
    check (minimum_lead_hours between 1 and 720),
  horizon_days integer not null default 35
    check (horizon_days between 1 and 180),
  slot_increment_minutes integer not null default 60
    check (slot_increment_minutes in (15, 30, 60, 120)),
  operating_start time not null default time '08:00',
  operating_end time not null default time '17:00',
  selection_hold_minutes integer not null default 15
    check (selection_hold_minutes between 5 and 60),
  conditional_hold_minutes integer not null default 1440
    check (conditional_hold_minutes between 15 and 10080),
  recurring_horizon_days integer not null default 90
    check (recurring_horizon_days between 7 and 180),
  commercial_requirement text not null default 'manual_invoice'
    check (commercial_requirement in ('manual_invoice', 'proposal_acceptance', 'none')),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (service_id, territory_id, version),
  check (operating_end > operating_start),
  check (
    (scheduling_path = 'conditional_hold' and condition_key is not null and condition_label is not null)
    or (scheduling_path <> 'conditional_hold')
  )
);

create unique index service_scheduling_policies_one_active_idx
  on service_scheduling_policies (service_id, territory_id)
  where status = 'active';
create index service_scheduling_policies_territory_idx
  on service_scheduling_policies (territory_id, status);

create table capacity_holds (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings(id) on delete cascade,
  job_schedule_id uuid not null unique references job_schedules(id) on delete cascade,
  policy_id uuid not null references service_scheduling_policies(id),
  territory_id uuid not null references service_territories(id),
  service_id text not null references services(id),
  hold_kind text not null check (hold_kind in ('direct', 'conditional')),
  status text not null default 'active'
    check (status in ('active', 'confirmed', 'expired', 'released', 'canceled')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  expires_at timestamptz not null,
  condition_key text,
  condition_label text,
  idempotency_key_hash text not null unique
    check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  qualification_snapshot jsonb not null default '{}',
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at),
  check (expires_at > created_at),
  check (
    (hold_kind = 'conditional' and condition_key is not null and condition_label is not null)
    or (hold_kind = 'direct')
  )
);

create index capacity_holds_active_window_idx
  on capacity_holds (territory_id, start_at, end_at)
  where status = 'active';
create index capacity_holds_expiration_idx
  on capacity_holds (expires_at)
  where status = 'active';
create index capacity_holds_policy_idx on capacity_holds (policy_id);
create index capacity_holds_service_idx on capacity_holds (service_id);

create table schedule_events (
  id bigint generated always as identity primary key,
  booking_id uuid not null references bookings(id) on delete cascade,
  job_schedule_id uuid references job_schedules(id) on delete set null,
  capacity_hold_id uuid references capacity_holds(id) on delete set null,
  event_type text not null check (event_type in (
    'hold_created', 'hold_expired', 'hold_released', 'scope_pending',
    'confirmed', 'rescheduled', 'cancellation_requested', 'canceled'
  )),
  actor_kind text not null default 'system'
    check (actor_kind in ('customer', 'guest', 'operator', 'cleaner', 'system')),
  old_start_at timestamptz,
  old_end_at timestamptz,
  new_start_at timestamptz,
  new_end_at timestamptz,
  reason_code text,
  event_data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index schedule_events_booking_idx on schedule_events (booking_id, created_at desc);
create index schedule_events_schedule_idx on schedule_events (job_schedule_id, created_at desc);
create index schedule_events_hold_idx on schedule_events (capacity_hold_id);

alter table job_assignments drop constraint job_assignments_status_check;
alter table job_assignments add constraint job_assignments_status_check
  check (status in ('reserved', 'proposed', 'accepted', 'confirmed', 'declined', 'removed'));

comment on column job_assignments.status is
  'reserved is a short-lived capacity reservation and never claims cleaner acceptance.';
comment on table service_scheduling_policies is
  'Versioned operator policy. No service/territory is directly schedulable without one active row.';
comment on table capacity_holds is
  'Customer-selected, capacity-backed service windows. Expiration is authoritative even before cleanup runs.';
comment on table schedule_events is
  'Append-only customer scheduling history. Event data must exclude contact data, access secrets, and workforce-private details.';

create function validate_capacity_hold_authority() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  booking_record record;
  schedule_record record;
  policy_record record;
  maximum_hold_minutes integer;
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status and not (
    (old.status = 'active' and new.status in ('confirmed', 'expired', 'released', 'canceled'))
    or (old.status = 'confirmed' and new.status = 'canceled')
  ) then
    raise exception 'Invalid capacity hold transition % to %', old.status, new.status
      using errcode = '23514';
  end if;

  select booking.id, booking.service_id, booking.territory_id,
         booking.qualification_status
    into booking_record
  from bookings booking
  where booking.id = new.booking_id;
  select schedule.id, schedule.booking_id, schedule.territory_id,
         schedule.service_vertical, schedule.start_at, schedule.end_at,
         schedule.status, schedule.labor_minutes, schedule.required_crew_size,
         schedule.required_skills, schedule.travel_buffer_minutes
    into schedule_record
  from job_schedules schedule
  where schedule.id = new.job_schedule_id;
  select policy.id, policy.service_id, policy.territory_id,
         policy.status, policy.scheduling_path,
         policy.condition_key, policy.condition_label,
         policy.selection_hold_minutes, policy.conditional_hold_minutes,
         policy.labor_minutes, policy.required_crew_size, policy.required_skills,
         policy.travel_buffer_minutes, policy.minimum_lead_hours,
         policy.horizon_days, policy.operating_start, policy.operating_end,
         territory.timezone
    into policy_record
  from service_scheduling_policies policy
  join service_territories territory on territory.id = policy.territory_id
  where policy.id = new.policy_id;

  if schedule_record.id is null or schedule_record.booking_id is distinct from new.booking_id then
    raise exception 'Capacity hold schedule must belong to its booking'
      using errcode = '23514';
  end if;
  if booking_record.service_id is distinct from new.service_id
     or booking_record.territory_id is distinct from new.territory_id
     or schedule_record.territory_id is distinct from new.territory_id
     or schedule_record.service_vertical is distinct from new.service_id then
    raise exception 'Capacity hold service and territory must match booking and schedule'
      using errcode = '23514';
  end if;
  if schedule_record.start_at is distinct from new.start_at
     or schedule_record.end_at is distinct from new.end_at then
    raise exception 'Capacity hold must exactly match its job schedule window'
      using errcode = '23514';
  end if;
  if policy_record.id is null
     or policy_record.service_id is distinct from new.service_id
     or policy_record.territory_id is distinct from new.territory_id then
    raise exception 'Capacity hold policy must match its service and territory'
      using errcode = '23514';
  end if;
  if (new.hold_kind = 'direct' and policy_record.scheduling_path <> 'direct')
     or (new.hold_kind = 'conditional' and policy_record.scheduling_path <> 'conditional_hold') then
    raise exception 'Capacity hold kind must match its policy scheduling path'
      using errcode = '23514';
  end if;

  if schedule_record.labor_minutes is distinct from policy_record.labor_minutes
     or schedule_record.required_crew_size is distinct from policy_record.required_crew_size
     or schedule_record.required_skills is distinct from policy_record.required_skills
     or schedule_record.travel_buffer_minutes is distinct from policy_record.travel_buffer_minutes then
    raise exception 'Schedule demand and travel buffer must come from scheduling policy'
      using errcode = '23514';
  end if;

  if new.status <> 'active' then
    return new;
  end if;
  if policy_record.status <> 'active' or schedule_record.status <> 'held' then
    raise exception 'Active capacity hold requires an active policy and held schedule'
      using errcode = '23514';
  end if;
  if new.hold_kind = 'direct' and booking_record.qualification_status <> 'approved' then
    raise exception 'Direct capacity hold requires approved standardized scope'
      using errcode = '23514';
  end if;
  if new.hold_kind = 'conditional'
     and (new.condition_key is distinct from policy_record.condition_key
       or new.condition_label is distinct from policy_record.condition_label) then
    raise exception 'Conditional capacity hold must preserve the named policy condition'
      using errcode = '23514';
  end if;
  if (new.start_at at time zone policy_record.timezone)::date
       is distinct from (new.end_at at time zone policy_record.timezone)::date
     or (new.start_at at time zone policy_record.timezone)::time < policy_record.operating_start
     or (new.end_at at time zone policy_record.timezone)::time > policy_record.operating_end then
    raise exception 'Capacity hold must fit policy operating hours in territory time'
      using errcode = '23514';
  end if;
  if (tg_op = 'INSERT' or new.start_at is distinct from old.start_at)
     and (new.start_at < now() + make_interval(hours => policy_record.minimum_lead_hours)
       or new.start_at > now() + make_interval(days => policy_record.horizon_days)) then
    raise exception 'Capacity hold must fit policy lead time and scheduling horizon'
      using errcode = '23514';
  end if;

  maximum_hold_minutes := case new.hold_kind
    when 'direct' then policy_record.selection_hold_minutes
    else policy_record.conditional_hold_minutes
  end;
  if new.expires_at > new.created_at + make_interval(mins => maximum_hold_minutes) then
    raise exception 'Capacity hold exceeds the policy time-to-live'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger capacity_holds_authority_guard
before insert or update of booking_id, job_schedule_id, policy_id, territory_id,
  service_id, hold_kind, status, start_at, end_at, expires_at, condition_key,
  condition_label, created_at
on capacity_holds for each row execute function validate_capacity_hold_authority();

revoke all on function validate_capacity_hold_authority() from public;

create function assert_scheduling_reservation_capacity(
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

  -- Reuse the established readiness, territory, availability, time-off,
  -- accepted-work overlap, and base daily/weekly capacity checks.
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
  day_start_at := local_start::date at time zone territory_timezone;
  day_end_at := (local_start::date + 1) at time zone territory_timezone;
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

revoke all on function assert_scheduling_reservation_capacity(uuid, uuid, uuid, timestamptz, timestamptz, uuid, integer) from public;

create function validate_job_assignment_reservation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  requested_start timestamptz;
  requested_end timestamptz;
  requested_territory uuid;
  requested_travel_buffer integer;
begin
  if new.status not in ('reserved', 'accepted', 'confirmed') then
    return new;
  end if;

  select start_at, end_at, territory_id, travel_buffer_minutes
    into requested_start, requested_end, requested_territory, requested_travel_buffer
  from job_schedules
  where id = new.job_schedule_id
  for update;
  if requested_start is null then
    raise exception 'Assignment schedule % does not exist', new.job_schedule_id
      using errcode = '23503';
  end if;

  if new.status = 'reserved' and not exists (
    select 1 from capacity_holds hold
    where hold.job_schedule_id = new.job_schedule_id
      and hold.status = 'active'
      and hold.expires_at > now()
  ) then
    raise exception 'Reserved assignment % requires an unexpired active capacity hold', new.id
      using errcode = '23514';
  end if;

  perform assert_scheduling_reservation_capacity(
    new.cleaner_id,
    new.id,
    new.job_schedule_id,
    requested_start,
    requested_end,
    requested_territory,
    requested_travel_buffer
  );
  return new;
end
$$;

create trigger job_assignments_reservation_guard
before insert or update of status, cleaner_id, job_schedule_id on job_assignments
for each row execute function validate_job_assignment_reservation();

create function assert_capacity_hold_lifecycle(schedule_to_check uuid) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  hold_record record;
  schedule_record record;
  qualifying_assignment_count integer;
  reserved_assignment_count integer;
  qualifying_skills text[];
  reserved_assignment record;
begin
  if schedule_to_check is null then
    return;
  end if;
  -- Deferred constraint triggers from hold, assignment, and schedule mutations
  -- all serialize on the same key. The second concurrent committer therefore
  -- validates against the first transaction's committed lifecycle state.
  perform pg_advisory_xact_lock(hashtextextended(schedule_to_check::text, 1));

  select hold.id, hold.status, hold.expires_at, hold.booking_id,
         hold.policy_id, hold.territory_id, hold.service_id,
         hold.start_at, hold.end_at, hold.hold_kind,
         booking.service_id as booking_service_id,
         booking.territory_id as booking_territory_id,
         booking.qualification_status,
         policy.status as policy_status,
         policy.service_id as policy_service_id,
         policy.territory_id as policy_territory_id,
         policy.scheduling_path, policy.labor_minutes,
         policy.required_crew_size as policy_crew_size,
         policy.required_skills as policy_skills,
         policy.travel_buffer_minutes as policy_travel_buffer,
         territory.status as territory_status, territory.timezone
    into hold_record
  from capacity_holds hold
  join bookings booking on booking.id = hold.booking_id
  join service_scheduling_policies policy on policy.id = hold.policy_id
  join service_territories territory on territory.id = hold.territory_id
  where hold.job_schedule_id = schedule_to_check;
  if hold_record.id is null then
    return;
  end if;
  select schedule.id, schedule.booking_id, schedule.territory_id,
         schedule.service_vertical, schedule.start_at, schedule.end_at,
         schedule.status, schedule.labor_minutes, schedule.required_crew_size,
         schedule.required_skills, schedule.travel_buffer_minutes
    into schedule_record
  from job_schedules schedule
  where schedule.id = schedule_to_check;
  if schedule_record.id is null then
    raise exception 'Capacity hold requires its job schedule'
      using errcode = '23514';
  end if;
  if schedule_record.booking_id is distinct from hold_record.booking_id
     or schedule_record.territory_id is distinct from hold_record.territory_id
     or schedule_record.service_vertical is distinct from hold_record.service_id
     or schedule_record.start_at is distinct from hold_record.start_at
     or schedule_record.end_at is distinct from hold_record.end_at
     or hold_record.booking_service_id is distinct from hold_record.service_id
     or hold_record.booking_territory_id is distinct from hold_record.territory_id
     or hold_record.policy_service_id is distinct from hold_record.service_id
     or hold_record.policy_territory_id is distinct from hold_record.territory_id
     or schedule_record.labor_minutes is distinct from hold_record.labor_minutes
     or schedule_record.required_crew_size is distinct from hold_record.policy_crew_size
     or schedule_record.required_skills is distinct from hold_record.policy_skills
     or schedule_record.travel_buffer_minutes is distinct from hold_record.policy_travel_buffer
     or (hold_record.hold_kind = 'direct' and hold_record.scheduling_path <> 'direct')
     or (hold_record.hold_kind = 'conditional' and hold_record.scheduling_path <> 'conditional_hold') then
    raise exception 'Capacity hold lifecycle no longer matches booking, schedule, and policy authority'
      using errcode = '23514';
  end if;

  select count(distinct assignment.cleaner_id)::integer
    into reserved_assignment_count
  from job_assignments assignment
  where assignment.job_schedule_id = schedule_to_check
    and assignment.status = 'reserved';

  if hold_record.status = 'active' and hold_record.expires_at > now() then
    select count(distinct assignment.cleaner_id)::integer,
           coalesce(array_agg(distinct skill) filter (where skill is not null), '{}')
      into qualifying_assignment_count, qualifying_skills
    from job_assignments assignment
    join cleaners cleaner on cleaner.id = assignment.cleaner_id
    left join lateral unnest(cleaner.skills) skill on true
    where assignment.job_schedule_id = schedule_to_check
      and assignment.status = 'reserved'
      and cleaner.status = 'active'
      and cleaner.screening_status = 'verified'
      and cleaner.home_territory_id = schedule_record.territory_id
      and exists (
        select 1 from cleaner_availability_rules availability
        where availability.cleaner_id = cleaner.id
          and availability.status = 'active'
          and (availability.territory_id is null
            or availability.territory_id = schedule_record.territory_id)
          and availability.day_of_week = extract(dow from
            schedule_record.start_at at time zone hold_record.timezone)::integer
          and availability.effective_from <=
            (schedule_record.start_at at time zone hold_record.timezone)::date
          and (availability.effective_to is null or availability.effective_to >=
            (schedule_record.start_at at time zone hold_record.timezone)::date)
          and availability.start_time <=
            (schedule_record.start_at at time zone hold_record.timezone)::time
          and availability.end_time >=
            (schedule_record.end_at at time zone hold_record.timezone)::time
      )
      and not exists (
        select 1 from cleaner_time_off time_off
        where time_off.cleaner_id = cleaner.id
          and time_off.status = 'approved'
          and time_off.start_at < schedule_record.end_at
          and time_off.end_at > schedule_record.start_at
      );
    if schedule_record.status <> 'held'
       or hold_record.policy_status <> 'active'
       or hold_record.territory_status <> 'active'
       or (hold_record.hold_kind = 'direct'
         and hold_record.qualification_status <> 'approved')
       or qualifying_assignment_count <> schedule_record.required_crew_size
       or not schedule_record.required_skills <@ qualifying_skills then
      raise exception 'Active capacity hold requires exact skill-qualified reserved crew'
        using errcode = '23514';
    end if;
    for reserved_assignment in
      select assignment.id, assignment.cleaner_id
      from job_assignments assignment
      where assignment.job_schedule_id = schedule_to_check
        and assignment.status = 'reserved'
      order by assignment.cleaner_id
    loop
      perform assert_scheduling_reservation_capacity(
        reserved_assignment.cleaner_id,
        reserved_assignment.id,
        schedule_record.id,
        schedule_record.start_at,
        schedule_record.end_at,
        schedule_record.territory_id,
        schedule_record.travel_buffer_minutes
      );
    end loop;
    return;
  end if;

  if hold_record.status = 'confirmed' then
    select count(distinct assignment.cleaner_id)::integer,
           coalesce(array_agg(distinct skill) filter (where skill is not null), '{}')
      into qualifying_assignment_count, qualifying_skills
    from job_assignments assignment
    join cleaners cleaner on cleaner.id = assignment.cleaner_id
    left join lateral unnest(cleaner.skills) skill on true
    where assignment.job_schedule_id = schedule_to_check
      and assignment.status in ('accepted', 'confirmed');
    if schedule_record.status <> 'confirmed'
       or qualifying_assignment_count <> schedule_record.required_crew_size
       or not schedule_record.required_skills <@ qualifying_skills
       or reserved_assignment_count <> 0 then
      raise exception 'Confirmed capacity hold requires exact accepted crew and confirmed schedule'
        using errcode = '23514';
    end if;
    return;
  end if;

  if reserved_assignment_count <> 0 then
    raise exception 'Inactive or expired capacity hold cannot retain reserved crew'
      using errcode = '23514';
  end if;
  if hold_record.status in ('expired', 'released', 'canceled')
     and schedule_record.status <> 'canceled' then
    raise exception 'Inactive capacity hold requires a canceled schedule'
      using errcode = '23514';
  end if;
end
$$;

create function revalidate_capacity_holds_for_cleaner(cleaner_to_check uuid) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  held_schedule uuid;
begin
  if cleaner_to_check is null then return; end if;
  for held_schedule in
    select distinct hold.job_schedule_id
    from capacity_holds hold
    join job_assignments assignment on assignment.job_schedule_id = hold.job_schedule_id
    where assignment.cleaner_id = cleaner_to_check
      and assignment.status = 'reserved'
      and hold.status = 'active'
      and hold.expires_at > now()
    order by hold.job_schedule_id
  loop
    perform assert_capacity_hold_lifecycle(held_schedule);
  end loop;
end
$$;

create function validate_capacity_hold_lifecycle_trigger() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  affected_cleaner uuid;
begin
  if tg_table_name = 'capacity_holds' then
    if tg_op <> 'DELETE' then perform assert_capacity_hold_lifecycle(new.job_schedule_id); end if;
    if tg_op <> 'INSERT' and (tg_op = 'DELETE' or old.job_schedule_id is distinct from new.job_schedule_id) then
      perform assert_capacity_hold_lifecycle(old.job_schedule_id);
    end if;
  elsif tg_table_name = 'job_assignments' then
    if tg_op <> 'DELETE' then perform assert_capacity_hold_lifecycle(new.job_schedule_id); end if;
    if tg_op <> 'INSERT' and (tg_op = 'DELETE' or old.job_schedule_id is distinct from new.job_schedule_id) then
      perform assert_capacity_hold_lifecycle(old.job_schedule_id);
    end if;
    if tg_op <> 'DELETE' then
      perform revalidate_capacity_holds_for_cleaner(new.cleaner_id);
    end if;
    if tg_op <> 'INSERT'
       and (tg_op = 'DELETE' or old.cleaner_id is distinct from new.cleaner_id) then
      perform revalidate_capacity_holds_for_cleaner(old.cleaner_id);
    end if;
  else
    if tg_op <> 'DELETE' then perform assert_capacity_hold_lifecycle(new.id); end if;
    if tg_op = 'DELETE' then perform assert_capacity_hold_lifecycle(old.id); end if;
    if tg_op <> 'DELETE' then
      for affected_cleaner in
        select distinct assignment.cleaner_id
        from job_assignments assignment
        where assignment.job_schedule_id = new.id
          and assignment.status in ('reserved', 'accepted', 'confirmed')
        order by assignment.cleaner_id
      loop
        perform revalidate_capacity_holds_for_cleaner(affected_cleaner);
      end loop;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end
$$;

create function reject_direct_capacity_hold_delete() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- Preserve whole-booking cascades while forcing ordinary lifecycle changes
  -- through explicit terminal statuses and their deferred coherence checks.
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'Capacity holds must be expired, released, or canceled; direct delete is prohibited'
    using errcode = '42501';
end
$$;

create trigger capacity_holds_delete_guard
before delete on capacity_holds for each row
execute function reject_direct_capacity_hold_delete();

create function validate_capacity_hold_parent_trigger() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  affected_schedule uuid;
  affected_cleaner uuid;
  affected_parent uuid;
begin
  if tg_table_name = 'bookings' then
    affected_parent := case when tg_op = 'DELETE' then old.id else new.id end;
    for affected_schedule in
      select schedule.id from job_schedules schedule
      join capacity_holds hold on hold.job_schedule_id = schedule.id
      where schedule.booking_id = affected_parent
    loop perform assert_capacity_hold_lifecycle(affected_schedule); end loop;
  elsif tg_table_name = 'cleaners' then
    affected_cleaner := case when tg_op = 'DELETE' then old.id else new.id end;
    for affected_schedule in
      select distinct assignment.job_schedule_id
      from job_assignments assignment
      join capacity_holds hold on hold.job_schedule_id = assignment.job_schedule_id
      where assignment.cleaner_id = affected_cleaner
    loop perform assert_capacity_hold_lifecycle(affected_schedule); end loop;
  elsif tg_table_name = 'cleaner_availability_rules' then
    affected_cleaner := case when tg_op = 'DELETE' then old.cleaner_id else new.cleaner_id end;
    for affected_schedule in
      select distinct assignment.job_schedule_id
      from job_assignments assignment
      join capacity_holds hold on hold.job_schedule_id = assignment.job_schedule_id
      where assignment.cleaner_id = affected_cleaner
    loop perform assert_capacity_hold_lifecycle(affected_schedule); end loop;
    if tg_op = 'UPDATE' and old.cleaner_id is distinct from new.cleaner_id then
      for affected_schedule in
        select distinct assignment.job_schedule_id
        from job_assignments assignment
        join capacity_holds hold on hold.job_schedule_id = assignment.job_schedule_id
        where assignment.cleaner_id = old.cleaner_id
      loop perform assert_capacity_hold_lifecycle(affected_schedule); end loop;
    end if;
  elsif tg_table_name = 'service_scheduling_policies' then
    affected_parent := case when tg_op = 'DELETE' then old.id else new.id end;
    for affected_schedule in
      select hold.job_schedule_id from capacity_holds hold
      where hold.policy_id = affected_parent
    loop perform assert_capacity_hold_lifecycle(affected_schedule); end loop;
  else
    affected_parent := case when tg_op = 'DELETE' then old.id else new.id end;
    for affected_schedule in
      select hold.job_schedule_id from capacity_holds hold
      where hold.territory_id = affected_parent
    loop perform assert_capacity_hold_lifecycle(affected_schedule); end loop;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end
$$;

create function freeze_versioned_scheduling_policy() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status and not (
    (old.status = 'draft' and new.status = 'active')
    or (old.status = 'active' and new.status = 'retired')
  ) then
    raise exception 'Invalid scheduling policy transition % to %', old.status, new.status
      using errcode = '23514';
  end if;
  if old.status in ('active', 'retired')
     and (to_jsonb(new) - array['status', 'updated_at']::text[])
       is distinct from (to_jsonb(old) - array['status', 'updated_at']::text[]) then
    raise exception 'Active and retired scheduling policy versions are immutable'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger service_scheduling_policies_version_guard
before update on service_scheduling_policies for each row
execute function freeze_versioned_scheduling_policy();

create constraint trigger capacity_holds_lifecycle_guard
after insert or update or delete on capacity_holds
deferrable initially deferred for each row
execute function validate_capacity_hold_lifecycle_trigger();
create constraint trigger job_assignments_hold_lifecycle_guard
after insert or update or delete on job_assignments
deferrable initially deferred for each row
execute function validate_capacity_hold_lifecycle_trigger();
create constraint trigger job_schedules_hold_lifecycle_guard
after insert or update or delete on job_schedules
deferrable initially deferred for each row
execute function validate_capacity_hold_lifecycle_trigger();
create constraint trigger bookings_hold_lifecycle_guard
after update or delete on bookings
deferrable initially deferred for each row
execute function validate_capacity_hold_parent_trigger();
create constraint trigger cleaners_hold_lifecycle_guard
after update or delete on cleaners
deferrable initially deferred for each row
execute function validate_capacity_hold_parent_trigger();
create constraint trigger cleaner_availability_hold_lifecycle_guard
after insert or update or delete on cleaner_availability_rules
deferrable initially deferred for each row
execute function validate_capacity_hold_parent_trigger();
create constraint trigger scheduling_policy_hold_lifecycle_guard
after update or delete on service_scheduling_policies
deferrable initially deferred for each row
execute function validate_capacity_hold_parent_trigger();
create constraint trigger territory_hold_lifecycle_guard
after update or delete on service_territories
deferrable initially deferred for each row
execute function validate_capacity_hold_parent_trigger();

revoke all on function assert_capacity_hold_lifecycle(uuid) from public;
revoke all on function revalidate_capacity_holds_for_cleaner(uuid) from public;
revoke all on function validate_capacity_hold_lifecycle_trigger() from public;
revoke all on function reject_direct_capacity_hold_delete() from public;
revoke all on function validate_capacity_hold_parent_trigger() from public;
revoke all on function freeze_versioned_scheduling_policy() from public;

create function validate_time_off_against_capacity_holds() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status <> 'approved' then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.cleaner_id::text, 0));
  if exists (
    select 1
    from job_assignments assignment
    join job_schedules schedule on schedule.id = assignment.job_schedule_id
    join capacity_holds hold on hold.job_schedule_id = schedule.id
    where assignment.cleaner_id = new.cleaner_id
      and assignment.status = 'reserved'
      and schedule.status <> 'canceled'
      and hold.status = 'active'
      and hold.expires_at > now()
      and schedule.start_at < new.end_at
      and schedule.end_at > new.start_at
  ) then
    raise exception 'Approved time off conflicts with an active capacity hold for cleaner %', new.cleaner_id
      using errcode = '23P01';
  end if;
  return new;
end
$$;

create trigger cleaner_time_off_capacity_hold_guard
before insert or update of status, cleaner_id, start_at, end_at on cleaner_time_off
for each row execute function validate_time_off_against_capacity_holds();

create function expire_customer_capacity_holds() returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  expired_hold record;
  expired_count integer := 0;
begin
  for expired_hold in
    update capacity_holds
    set status = 'expired', updated_at = now()
    where status = 'active' and expires_at <= now()
    returning id, booking_id, job_schedule_id
  loop
    update job_assignments
    set status = 'removed', responded_at = now()
    where job_schedule_id = expired_hold.job_schedule_id and status = 'reserved';
    update job_schedules
    set status = 'canceled', version = version + 1
    where id = expired_hold.job_schedule_id and status in ('tentative', 'held');
    insert into schedule_events
      (booking_id, job_schedule_id, capacity_hold_id, event_type, actor_kind, reason_code)
    values
      (expired_hold.booking_id, expired_hold.job_schedule_id, expired_hold.id,
       'hold_expired', 'system', 'hold_ttl_elapsed');
    expired_count := expired_count + 1;
  end loop;
  return expired_count;
end
$$;

revoke all on function expire_customer_capacity_holds() from public;

create function reject_schedule_event_mutation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'Schedule events are append-only' using errcode = '42501';
end
$$;

create trigger schedule_events_immutable
before update or delete on schedule_events
for each row execute function reject_schedule_event_mutation();

alter table service_scheduling_policies enable row level security;
alter table capacity_holds enable row level security;
alter table schedule_events enable row level security;

revoke all on service_scheduling_policies, capacity_holds, schedule_events from public;
grant select, insert, update, delete on service_scheduling_policies, capacity_holds to lakeandpine_app;
grant select, insert, update, delete on schedule_events to lakeandpine_app;
grant usage, select on sequence schedule_events_id_seq to lakeandpine_app;
grant execute on function assert_scheduling_reservation_capacity(uuid, uuid, uuid, timestamptz, timestamptz, uuid, integer) to lakeandpine_app;
grant execute on function assert_capacity_hold_lifecycle(uuid) to lakeandpine_app;
grant execute on function revalidate_capacity_holds_for_cleaner(uuid) to lakeandpine_app;
grant execute on function expire_customer_capacity_holds() to lakeandpine_app;

create policy lakeandpine_app_all_service_scheduling_policies
  on service_scheduling_policies for all to lakeandpine_app
  using (true) with check (true);
create policy lakeandpine_app_all_capacity_holds
  on capacity_holds for all to lakeandpine_app
  using (true) with check (true);
create policy lakeandpine_app_all_schedule_events
  on schedule_events for all to lakeandpine_app
  using (true) with check (true);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on service_scheduling_policies, capacity_holds, schedule_events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on service_scheduling_policies, capacity_holds, schedule_events from authenticated;
  end if;
end
$$;
