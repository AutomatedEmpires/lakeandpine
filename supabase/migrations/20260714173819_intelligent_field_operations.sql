-- Intelligent branch routing, schedule approval, and field execution.
--
-- Requests may be captured outside a branch's standard radius, but a customer
-- proposal cannot be issued until an operator either confirms the route is in
-- range or records an explicit exception. External delivery, purchasing,
-- refunds, payroll, and tip collection remain approval/provider-gated ledgers.

set local lock_timeout = '5s';
set local statement_timeout = '5min';

alter table cleaning_teams
  add column origin_label text,
  add column origin_latitude numeric(9,6),
  add column origin_longitude numeric(9,6),
  add column service_radius_miles numeric(6,2) not null default 30
    check (service_radius_miles between 1 and 250),
  add column operating_start_time time not null default '08:00',
  add column latest_arrival_time time not null default '16:00',
  add column hard_finish_time time not null default '19:00',
  add column arrival_window_minutes integer not null default 120
    check (arrival_window_minutes between 30 and 240),
  add column support_email text,
  add column public_phone text,
  add constraint cleaning_teams_origin_pair_check check (
    (origin_latitude is null and origin_longitude is null)
    or (origin_latitude between -90 and 90 and origin_longitude between -180 and 180)
  ),
  add constraint cleaning_teams_operating_hours_check check (
    operating_start_time < latest_arrival_time
    and latest_arrival_time < hard_finish_time
  ),
  add constraint cleaning_teams_support_email_check check (
    support_email is null or (
      char_length(support_email) between 5 and 320
      and support_email = lower(support_email)
      and support_email like '%@%'
    )
  );

comment on column cleaning_teams.service_radius_miles is
  'Standard route radius from the branch origin. Requests outside it remain reviewable.';
comment on column cleaning_teams.latest_arrival_time is
  'Latest allowed planned arrival, inclusive. It is not the job finish time.';
comment on column cleaning_teams.hard_finish_time is
  'Hard local-time completion cap enforced when work is allocated to the team.';

-- A booking may have only one live reschedule workflow. Collapse any legacy
-- duplicate before enforcing the invariant so a second form submission cannot
-- strand every linked replacement proposal.
with ranked_active_reschedules as (
  select id,
    row_number() over (
      partition by booking_id order by created_at desc, id desc
    ) as active_rank
  from service_cases
  where booking_id is not null
    and case_type = 'reschedule'
    and status not in ('resolved', 'closed', 'declined', 'canceled')
)
update service_cases service_case
set status = 'canceled',
    resolution_type = 'no_action',
    resolution_summary = 'Superseded duplicate reschedule request during field-operations upgrade.',
    updated_at = now()
from ranked_active_reschedules ranked
where service_case.id = ranked.id and ranked.active_rank > 1;

create unique index service_cases_one_active_reschedule_per_booking_idx
  on service_cases (booking_id)
  where booking_id is not null
    and case_type = 'reschedule'
    and status not in ('resolved', 'closed', 'declined', 'canceled');

create table service_location_assessments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  team_id uuid,
  address_fingerprint text not null check (address_fingerprint ~ '^[0-9a-f]{64}$'),
  branch_origin_label text,
  branch_origin_latitude numeric(9,6),
  branch_origin_longitude numeric(9,6),
  property_latitude numeric(9,6),
  property_longitude numeric(9,6),
  distance_miles numeric(8,2) check (distance_miles is null or distance_miles >= 0),
  duration_minutes integer check (duration_minutes is null or duration_minutes between 0 and 1440),
  standard_radius_miles numeric(6,2) not null default 30
    check (standard_radius_miles between 1 and 250),
  calculation_method text not null default 'manual_review'
    check (calculation_method in ('route_provider', 'straight_line', 'postal_hint', 'manual_review')),
  assessment_status text not null default 'manual_review'
    check (assessment_status in (
      'inside_standard_radius', 'outside_standard_radius',
      'manual_review', 'approved_exception'
    )),
  provider text not null default 'manual'
    check (provider in ('manual', 'mapbox', 'postal_hint')),
  provider_resolved_address text
    check (provider_resolved_address is null or char_length(provider_resolved_address) <= 500),
  provider_match_confidence text
    check (provider_match_confidence is null or provider_match_confidence in ('exact', 'high', 'medium', 'low')),
  provider_coordinate_accuracy text
    check (provider_coordinate_accuracy is null or provider_coordinate_accuracy in ('rooftop', 'parcel', 'point', 'interpolated', 'approximate', 'intersection')),
  calculated_at timestamptz,
  override_by_membership_id uuid references workforce_memberships(id) on delete set null,
  override_reason text check (override_reason is null or char_length(override_reason) between 4 and 1000),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_location_assessments_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id),
  constraint service_location_assessments_coordinate_pair_check check (
    (property_latitude is null and property_longitude is null)
    or (property_latitude between -90 and 90 and property_longitude between -180 and 180)
  ),
  constraint service_location_assessments_origin_pair_check check (
    (branch_origin_latitude is null and branch_origin_longitude is null)
    or (branch_origin_latitude between -90 and 90 and branch_origin_longitude between -180 and 180)
  ),
  constraint service_location_assessments_override_check check (
    assessment_status <> 'approved_exception'
    or (override_by_membership_id is not null and override_reason is not null)
  )
);
create index service_location_assessments_queue_idx
  on service_location_assessments (organization_id, team_id, assessment_status, created_at);
create index service_location_assessments_override_idx
  on service_location_assessments (override_by_membership_id)
  where override_by_membership_id is not null;

create function private.enrich_unallocated_service_location_assessment(
  target_booking_id uuid,
  expected_address_fingerprint text,
  new_branch_origin_label text,
  new_branch_origin_latitude double precision,
  new_branch_origin_longitude double precision,
  new_property_latitude double precision,
  new_property_longitude double precision,
  new_distance_miles double precision,
  new_standard_radius_miles double precision,
  new_calculation_method text,
  new_assessment_status text,
  new_provider text,
  new_provider_resolved_address text,
  new_provider_match_confidence text,
  new_provider_coordinate_accuracy text,
  new_calculated_at timestamptz
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  updated_assessment_id uuid;
begin
  if private.current_customer_id() is not null
    or private.current_cleaner_id() is not null then
    raise exception 'Route enrichment requires the internal intake actor'
      using errcode = '42501';
  end if;
  if new_assessment_status not in (
      'inside_standard_radius', 'outside_standard_radius', 'manual_review'
    )
    or new_calculation_method not in ('straight_line', 'manual_review')
    or new_provider not in ('manual', 'mapbox') then
    raise exception 'Route enrichment evidence is invalid' using errcode = '23514';
  end if;
  if new_provider = 'manual' and (
    new_calculation_method <> 'manual_review'
    or new_assessment_status <> 'manual_review'
    or new_property_latitude is not null
    or new_property_longitude is not null
    or new_distance_miles is not null
    or new_provider_resolved_address is not null
    or new_provider_match_confidence is not null
    or new_provider_coordinate_accuracy is not null
    or new_calculated_at is not null
  ) then
    raise exception 'Manual route evidence cannot assert a calculated result'
      using errcode = '23514';
  end if;
  if new_provider = 'mapbox' and (
    new_branch_origin_latitude is null
    or new_branch_origin_longitude is null
    or new_property_latitude is null
    or new_property_longitude is null
    or new_distance_miles is null
    or new_calculated_at is null
    or abs(new_distance_miles - private.haversine_miles(
      new_branch_origin_latitude::numeric,
      new_branch_origin_longitude::numeric,
      new_property_latitude::numeric,
      new_property_longitude::numeric
    )::double precision) > 0.011
    or (
      new_calculation_method = 'straight_line'
      and (
        new_provider_match_confidence is distinct from 'exact'
        or coalesce(new_provider_coordinate_accuracy, '')
          not in ('rooftop', 'parcel', 'point')
        or new_assessment_status is distinct from case
          when new_distance_miles > new_standard_radius_miles
            then 'outside_standard_radius'
          else 'inside_standard_radius'
        end
      )
    )
    or (
      new_calculation_method = 'manual_review'
      and new_assessment_status is distinct from 'manual_review'
    )
  ) then
    raise exception 'Map route evidence is internally inconsistent'
      using errcode = '23514';
  end if;

  update public.service_location_assessments assessment
  set branch_origin_label = new_branch_origin_label,
      branch_origin_latitude = new_branch_origin_latitude,
      branch_origin_longitude = new_branch_origin_longitude,
      property_latitude = new_property_latitude,
      property_longitude = new_property_longitude,
      distance_miles = new_distance_miles,
      standard_radius_miles = new_standard_radius_miles,
      calculation_method = new_calculation_method,
      assessment_status = new_assessment_status,
      provider = new_provider,
      provider_resolved_address = new_provider_resolved_address,
      provider_match_confidence = new_provider_match_confidence,
      provider_coordinate_accuracy = new_provider_coordinate_accuracy,
      calculated_at = new_calculated_at,
      updated_at = now()
  where assessment.booking_id = target_booking_id
    and assessment.address_fingerprint = expected_address_fingerprint
    and assessment.team_id is null
    and assessment.override_by_membership_id is null
    and new_branch_origin_label is not distinct from assessment.branch_origin_label
    and new_branch_origin_latitude is not distinct from assessment.branch_origin_latitude
    and new_branch_origin_longitude is not distinct from assessment.branch_origin_longitude
    and new_standard_radius_miles is not distinct from assessment.standard_radius_miles
    and not exists (
      select 1
      from public.job_schedules schedule
      join public.team_job_allocations allocation
        on allocation.job_schedule_id = schedule.id
      where schedule.booking_id = assessment.booking_id
    )
  returning assessment.id into updated_assessment_id;

  if updated_assessment_id is null then
    raise exception 'Booking route assessment is no longer safe to enrich'
      using errcode = '55000';
  end if;
  return updated_assessment_id;
end
$$;

create table private.service_location_assessment_decisions (
  id bigint generated always as identity primary key,
  assessment_id uuid not null references public.service_location_assessments(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  organization_id uuid not null,
  team_id uuid not null,
  decision_kind text not null check (decision_kind in ('approved_exception', 'invalidated')),
  prior_status text not null,
  resulting_status text not null,
  schedule_status text,
  actor_membership_id uuid references public.workforce_memberships(id) on delete set null,
  reason text not null check (char_length(reason) between 4 and 1000),
  distance_miles numeric(8,2),
  standard_radius_miles numeric(6,2) not null,
  branch_origin_label text,
  created_at timestamptz not null default now(),
  constraint service_location_decisions_team_fkey
    foreign key (organization_id, team_id)
    references public.cleaning_teams (organization_id, id)
);
create index service_location_decisions_assessment_idx
  on private.service_location_assessment_decisions (assessment_id, created_at desc);
create index service_location_decisions_booking_idx
  on private.service_location_assessment_decisions (booking_id, created_at desc);
create index service_location_decisions_actor_idx
  on private.service_location_assessment_decisions (actor_membership_id)
  where actor_membership_id is not null;
create index service_location_decisions_team_idx
  on private.service_location_assessment_decisions (organization_id, team_id, created_at desc);
revoke all on table private.service_location_assessment_decisions from public;
revoke all on table private.service_location_assessment_decisions from lakeandpine_app;

-- Existing allocated work predates route evidence. Backfill a deliberately
-- fail-closed manual-review record so it is visible to managers and cannot
-- advance silently under the new execution rules.
with allocated_booking as (
  select distinct on (booking.id)
    booking.id as booking_id,
    allocation.organization_id,
    allocation.team_id,
    team.origin_label,
    team.origin_latitude,
    team.origin_longitude,
    team.service_radius_miles,
    booking.contact,
    (booking.is_dev_seed and allocation.is_dev_seed) as is_dev_seed
  from bookings booking
  join job_schedules schedule on schedule.booking_id = booking.id
  join team_job_allocations allocation on allocation.job_schedule_id = schedule.id
  join cleaning_teams team
    on team.organization_id = allocation.organization_id
   and team.id = allocation.team_id
  where schedule.status in (
    'tentative', 'held', 'confirmed', 'en_route', 'in_progress', 'quality_review'
  )
  order by booking.id, allocation.allocated_at desc, allocation.id
), normalized as (
  select allocated_booking.*,
    lower(regexp_replace(concat_ws(', ',
      contact->>'street', nullif(contact->>'unit', ''), contact->>'city',
      contact->>'state', contact->>'zip', 'US'
    ), '\s+', ' ', 'g')) as normalized_address
  from allocated_booking
)
insert into service_location_assessments
  (booking_id, organization_id, team_id, address_fingerprint,
   branch_origin_label, branch_origin_latitude, branch_origin_longitude,
   standard_radius_miles, calculation_method, assessment_status, provider,
   is_dev_seed)
select booking_id, organization_id, team_id,
  md5(normalized_address) || md5('lakeandpine:' || normalized_address),
  origin_label, origin_latitude, origin_longitude, service_radius_miles,
  'manual_review', 'manual_review', 'manual', is_dev_seed
from normalized
on conflict (booking_id) do nothing;

create table schedule_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  team_job_allocation_id uuid not null,
  job_schedule_id uuid not null references job_schedules(id) on delete cascade,
  service_case_id uuid references service_cases(id) on delete set null,
  proposed_start_at timestamptz,
  proposed_end_at timestamptz,
  customer_id uuid not null references customers(id) on delete restrict,
  arrival_window_start timestamptz not null,
  arrival_window_end timestamptz not null,
  status text not null default 'pending_customer'
    check (status in (
      'draft', 'pending_customer', 'approved', 'changes_requested',
      'withdrawn', 'superseded', 'expired'
    )),
  version integer not null check (version > 0),
  proposed_by_membership_id uuid not null references workforce_memberships(id) on delete restrict,
  proposal_note text check (proposal_note is null or char_length(proposal_note) <= 2000),
  customer_response_note text check (customer_response_note is null or char_length(customer_response_note) <= 2000),
  responded_at timestamptz,
  expires_at timestamptz,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedule_proposals_allocation_fkey
    foreign key (organization_id, team_id, team_job_allocation_id)
    references team_job_allocations (organization_id, team_id, id),
  constraint schedule_proposals_window_check check (
    arrival_window_end > arrival_window_start
    and arrival_window_end <= arrival_window_start + interval '4 hours'
  ),
  constraint schedule_proposals_reschedule_timing_check check (
    (proposed_start_at is null and proposed_end_at is null)
    or (proposed_start_at is not null and proposed_end_at is not null
      and proposed_end_at > proposed_start_at)
  ),
  constraint schedule_proposals_schedule_version_key unique (job_schedule_id, version)
);
create unique index schedule_proposals_one_open_idx
  on schedule_proposals (job_schedule_id)
  where status in ('draft', 'pending_customer', 'changes_requested');
create index schedule_proposals_customer_idx
  on schedule_proposals (customer_id, status, created_at desc);
create index schedule_proposals_service_case_idx
  on schedule_proposals (service_case_id)
  where service_case_id is not null;
create index schedule_proposals_team_idx
  on schedule_proposals (organization_id, team_id, status, created_at desc);
create index schedule_proposals_allocation_scope_idx
  on schedule_proposals (organization_id, team_id, team_job_allocation_id);
create index schedule_proposals_proposer_idx
  on schedule_proposals (proposed_by_membership_id);

-- Work that was already physically under way when this migration landed
-- cannot obtain a truthful retroactive arrival-window approval. Preserve a
-- narrow, immutable audit snapshot that allows only forward execution after a
-- manager resolves the new route review. Future confirmed work must receive a
-- real customer proposal; no row is created for it here.
create table private.legacy_field_execution_continuity (
  job_schedule_id uuid primary key references public.job_schedules(id) on delete cascade,
  organization_id uuid not null,
  team_id uuid not null,
  team_job_allocation_id uuid not null unique,
  original_status text not null
    check (original_status in ('en_route', 'in_progress', 'quality_review')),
  original_start_at timestamptz not null,
  original_end_at timestamptz not null,
  migration_key text not null
    check (migration_key = '20260714173819_intelligent_field_operations'),
  created_at timestamptz not null default now(),
  constraint legacy_field_execution_allocation_fkey
    foreign key (organization_id, team_id, team_job_allocation_id)
    references public.team_job_allocations (organization_id, team_id, id)
);
revoke all on table private.legacy_field_execution_continuity from public;
revoke all on table private.legacy_field_execution_continuity from lakeandpine_app;

insert into private.legacy_field_execution_continuity
  (job_schedule_id, organization_id, team_id, team_job_allocation_id,
   original_status, original_start_at, original_end_at, migration_key)
select schedule.id, allocation.organization_id, allocation.team_id, allocation.id,
  schedule.status, schedule.start_at, schedule.end_at,
  '20260714173819_intelligent_field_operations'
from public.job_schedules schedule
join public.team_job_allocations allocation on allocation.job_schedule_id = schedule.id
where schedule.status in ('en_route', 'in_progress', 'quality_review')
on conflict (job_schedule_id) do nothing;

create table customer_cleaner_preferences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  customer_id uuid not null references customers(id) on delete cascade,
  cleaner_id uuid not null references cleaners(id) on delete cascade,
  source_allocation_id uuid not null,
  preference text not null check (preference in ('preferred', 'avoid')),
  note text check (note is null or char_length(note) <= 1000),
  active boolean not null default true,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_cleaner_preferences_allocation_fkey
    foreign key (organization_id, team_id, source_allocation_id)
    references team_job_allocations (organization_id, team_id, id),
  constraint customer_cleaner_preferences_customer_cleaner_key
    unique (team_id, customer_id, cleaner_id)
);
create index customer_cleaner_preferences_team_idx
  on customer_cleaner_preferences (organization_id, team_id, preference, active);
create index customer_cleaner_preferences_customer_idx
  on customer_cleaner_preferences (customer_id, active);
create index customer_cleaner_preferences_cleaner_idx
  on customer_cleaner_preferences (cleaner_id, active);
create index customer_cleaner_preferences_allocation_scope_idx
  on customer_cleaner_preferences (organization_id, team_id, source_allocation_id);

create table job_communications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  team_job_allocation_id uuid not null,
  customer_id uuid not null references customers(id) on delete restrict,
  sender_kind text not null check (sender_kind in ('customer', 'cleaner', 'staff', 'system')),
  sender_membership_id uuid references workforce_memberships(id) on delete set null,
  sender_cleaner_id uuid references cleaners(id) on delete set null,
  sender_customer_id uuid references customers(id) on delete set null,
  audience text not null check (audience in ('customer', 'assigned_crew', 'team_operations')),
  template_key text check (template_key is null or template_key in (
    'running_15_late', 'running_30_late', 'access_question', 'arrival_update',
    'schedule_conflict', 'scope_issue', 'custom'
  )),
  body text not null check (char_length(body) between 1 and 2000),
  channel text not null default 'in_app' check (channel in ('in_app', 'email', 'sms')),
  delivery_status text not null default 'recorded'
    check (delivery_status in ('recorded', 'queued', 'sent', 'failed', 'suppressed')),
  provider_message_id text,
  delivery_error text check (delivery_error is null or char_length(delivery_error) <= 1000),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  constraint job_communications_allocation_fkey
    foreign key (organization_id, team_id, team_job_allocation_id)
    references team_job_allocations (organization_id, team_id, id),
  constraint job_communications_sender_check check (
    (sender_kind = 'customer' and sender_customer_id is not null and sender_cleaner_id is null)
    or (sender_kind = 'cleaner' and sender_cleaner_id is not null and sender_customer_id is null)
    or (sender_kind = 'staff' and sender_membership_id is not null)
    or (sender_kind = 'system' and sender_membership_id is null
      and sender_cleaner_id is null and sender_customer_id is null)
  )
);
create index job_communications_allocation_idx
  on job_communications (team_job_allocation_id, created_at);
create index job_communications_team_idx
  on job_communications (organization_id, team_id, created_at desc);
create index job_communications_customer_idx
  on job_communications (customer_id, created_at desc);
create index job_communications_sender_membership_idx
  on job_communications (sender_membership_id)
  where sender_membership_id is not null;
create index job_communications_sender_cleaner_idx
  on job_communications (sender_cleaner_id)
  where sender_cleaner_id is not null;
create index job_communications_sender_customer_idx
  on job_communications (sender_customer_id)
  where sender_customer_id is not null;
create index job_communications_allocation_scope_idx
  on job_communications (organization_id, team_id, team_job_allocation_id);

create table mileage_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  workforce_membership_id uuid not null references workforce_memberships(id) on delete restrict,
  cleaner_id uuid not null references cleaners(id) on delete restrict,
  team_job_allocation_id uuid,
  service_date date not null,
  miles numeric(8,2) not null check (miles > 0 and miles <= 1000),
  purpose text not null check (purpose in ('to_job', 'between_jobs', 'supply_run', 'training', 'other')),
  vehicle_label text check (vehicle_label is null or char_length(vehicle_label) <= 120),
  note text check (note is null or char_length(note) <= 1000),
  status text not null default 'submitted'
    check (status in ('submitted', 'approved', 'rejected', 'exported', 'recorded_paid')),
  reviewed_by_membership_id uuid references workforce_memberships(id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) <= 1000),
  version integer not null default 1 check (version > 0),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mileage_entries_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id),
  constraint mileage_entries_allocation_fkey
    foreign key (organization_id, team_id, team_job_allocation_id)
    references team_job_allocations (organization_id, team_id, id),
  constraint mileage_entries_review_check check (
    status = 'submitted'
    or (reviewed_by_membership_id is not null and reviewed_at is not null)
  )
);
create index mileage_entries_team_queue_idx
  on mileage_entries (organization_id, team_id, status, service_date desc);
create index mileage_entries_cleaner_idx
  on mileage_entries (cleaner_id, service_date desc);
create index mileage_entries_membership_idx
  on mileage_entries (workforce_membership_id, service_date desc);
create index mileage_entries_allocation_idx
  on mileage_entries (team_job_allocation_id)
  where team_job_allocation_id is not null;
create index mileage_entries_allocation_scope_idx
  on mileage_entries (organization_id, team_id, team_job_allocation_id);
create index mileage_entries_reviewer_idx
  on mileage_entries (reviewed_by_membership_id)
  where reviewed_by_membership_id is not null;

create table job_issue_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  team_job_allocation_id uuid,
  reported_by_membership_id uuid not null references workforce_memberships(id) on delete restrict,
  reported_by_cleaner_id uuid references cleaners(id) on delete set null,
  issue_type text not null check (issue_type in (
    'schedule_conflict', 'access', 'safety', 'vehicle', 'customer_note',
    'scope', 'inventory', 'quality', 'other'
  )),
  severity text not null default 'medium'
    check (severity in ('low', 'medium', 'high', 'critical')),
  summary text not null check (char_length(summary) between 2 and 1000),
  private_details text check (private_details is null or char_length(private_details) <= 4000),
  customer_visible boolean not null default false,
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'resolved', 'dismissed')),
  assigned_to_membership_id uuid references workforce_memberships(id) on delete set null,
  resolution_note text check (resolution_note is null or char_length(resolution_note) <= 2000),
  resolved_at timestamptz,
  version integer not null default 1 check (version > 0),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_issue_reports_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id),
  constraint job_issue_reports_allocation_fkey
    foreign key (organization_id, team_id, team_job_allocation_id)
    references team_job_allocations (organization_id, team_id, id),
  constraint job_issue_reports_resolution_check check (
    status not in ('resolved', 'dismissed')
    or (resolved_at is not null and resolution_note is not null
      and char_length(resolution_note) >= 2)
  )
);
create index job_issue_reports_team_queue_idx
  on job_issue_reports (organization_id, team_id, status, severity, created_at);
create index job_issue_reports_reporter_idx
  on job_issue_reports (reported_by_membership_id, created_at desc);
create index job_issue_reports_cleaner_idx
  on job_issue_reports (reported_by_cleaner_id, created_at desc)
  where reported_by_cleaner_id is not null;
create index job_issue_reports_allocation_idx
  on job_issue_reports (team_job_allocation_id, created_at desc)
  where team_job_allocation_id is not null;
create index job_issue_reports_allocation_scope_idx
  on job_issue_reports (organization_id, team_id, team_job_allocation_id);
create index job_issue_reports_assignee_idx
  on job_issue_reports (assigned_to_membership_id)
  where assigned_to_membership_id is not null;

create table team_duty_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  workforce_membership_id uuid not null references workforce_memberships(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  duty_kind text not null default 'manager_on_duty'
    check (duty_kind in ('manager_on_duty', 'shift_lead_on_duty')),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'active', 'completed', 'canceled')),
  created_by_membership_id uuid not null references workforce_memberships(id) on delete restrict,
  note text check (note is null or char_length(note) <= 1000),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_duty_assignments_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id),
  check (ends_at > starts_at and ends_at <= starts_at + interval '24 hours')
);
create index team_duty_assignments_active_idx
  on team_duty_assignments (organization_id, team_id, status, starts_at, ends_at);
create index team_duty_assignments_member_idx
  on team_duty_assignments (workforce_membership_id, starts_at desc);
create index team_duty_assignments_creator_idx
  on team_duty_assignments (created_by_membership_id);

create table tip_intents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  team_job_allocation_id uuid not null,
  customer_id uuid not null references customers(id) on delete restrict,
  cleaner_id uuid references cleaners(id) on delete restrict,
  amount_cents integer not null check (amount_cents between 100 and 100000),
  currency text not null default 'USD' check (currency = 'USD'),
  status text not null default 'pending_collection'
    check (status in ('pending_collection', 'recorded', 'declined', 'canceled')),
  provider text not null default 'manual' check (provider in ('manual', 'stripe')),
  provider_reference text,
  recorded_by_membership_id uuid references workforce_memberships(id) on delete set null,
  note text check (note is null or char_length(note) <= 500),
  version integer not null default 1 check (version > 0),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tip_intents_allocation_fkey
    foreign key (organization_id, team_id, team_job_allocation_id)
    references team_job_allocations (organization_id, team_id, id),
  constraint tip_intents_one_customer_cleaner_job_key
    unique nulls not distinct (team_job_allocation_id, customer_id, cleaner_id),
  constraint tip_intents_recorded_evidence_check check (
    status <> 'recorded'
    or (provider_reference is not null and recorded_by_membership_id is not null)
  )
);
create index tip_intents_team_status_idx
  on tip_intents (organization_id, team_id, status, created_at desc);
create index tip_intents_customer_idx
  on tip_intents (customer_id, created_at desc);
create index tip_intents_cleaner_idx
  on tip_intents (cleaner_id, created_at desc)
  where cleaner_id is not null;
create index tip_intents_allocation_scope_idx
  on tip_intents (organization_id, team_id, team_job_allocation_id);
create index tip_intents_recorder_idx
  on tip_intents (recorded_by_membership_id)
  where recorded_by_membership_id is not null;
create unique index tip_intents_recorded_provider_reference_key
  on tip_intents (provider, provider_reference)
  where status = 'recorded' and provider_reference is not null;

alter table checklist_items
  add column organization_id uuid references organizations(id) on delete cascade,
  add column team_id uuid,
  add column team_job_allocation_id uuid,
  add column completed_by_membership_id uuid references workforce_memberships(id) on delete set null,
  add column completed_by_cleaner_id uuid references cleaners(id) on delete set null,
  add column completion_note text check (completion_note is null or char_length(completion_note) <= 1000),
  add column version integer not null default 1 check (version > 0),
  add constraint checklist_items_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id),
  add constraint checklist_items_allocation_fkey
    foreign key (organization_id, team_id, team_job_allocation_id)
    references team_job_allocations (organization_id, team_id, id),
  add constraint checklist_items_scope_pair_check check (
    (organization_id is null and team_id is null and team_job_allocation_id is null)
    or (organization_id is not null and team_id is not null and team_job_allocation_id is not null)
  );
create index checklist_items_allocation_idx
  on checklist_items (team_job_allocation_id, state, sort)
  where team_job_allocation_id is not null;
create index checklist_items_completion_actor_idx
  on checklist_items (completed_by_membership_id)
  where completed_by_membership_id is not null;
create index checklist_items_completion_cleaner_idx
  on checklist_items (completed_by_cleaner_id)
  where completed_by_cleaner_id is not null;
create index checklist_items_allocation_scope_idx
  on checklist_items (organization_id, team_id, team_job_allocation_id);

update checklist_items item
set organization_id = allocation.organization_id,
    team_id = allocation.team_id,
    team_job_allocation_id = allocation.id
from job_schedules schedule
join team_job_allocations allocation on allocation.job_schedule_id = schedule.id
where schedule.booking_id = item.booking_id;

-- Active allocated work must never reach execution with an empty closeout
-- contract. Preserve existing customer scope; add one generic fail-safe step
-- only where an older operational booking had no checklist at all.
insert into checklist_items
  (booking_id, room_label, label, sort, organization_id, team_id,
   team_job_allocation_id, is_dev_seed)
select schedule.booking_id, null,
  'Complete the approved service scope and document every exception', 0,
  allocation.organization_id, allocation.team_id, allocation.id,
  (schedule.is_dev_seed and allocation.is_dev_seed)
from job_schedules schedule
join team_job_allocations allocation on allocation.job_schedule_id = schedule.id
where schedule.status in ('tentative', 'held', 'confirmed', 'en_route', 'in_progress')
  and not exists (
    select 1 from checklist_items item
    where item.team_job_allocation_id = allocation.id
  );

create function private.lakeandpine_intake_organization_id()
returns uuid language sql stable security definer
set search_path = '' as $$
  select organization.id
  from public.organizations organization
  where organization.slug = 'lake-and-pine'
    and organization.status = 'active'
$$;
comment on function private.lakeandpine_intake_organization_id() is
  'Returns only the active Lake & Pine organization identifier needed by anonymous request intake.';

create function private.haversine_miles(
  origin_latitude numeric,
  origin_longitude numeric,
  destination_latitude numeric,
  destination_longitude numeric
) returns numeric
language plpgsql immutable security invoker set search_path = '' as $$
declare
  latitude_delta double precision;
  longitude_delta double precision;
  haversine_value double precision;
begin
  if origin_latitude is null or origin_longitude is null
    or destination_latitude is null or destination_longitude is null then
    return null;
  end if;
  latitude_delta := radians((destination_latitude - origin_latitude)::double precision);
  longitude_delta := radians((destination_longitude - origin_longitude)::double precision);
  haversine_value := sin(latitude_delta / 2) ^ 2
    + cos(radians(origin_latitude::double precision))
    * cos(radians(destination_latitude::double precision))
    * sin(longitude_delta / 2) ^ 2;
  haversine_value := least(1::double precision, greatest(0::double precision, haversine_value));
  return round((3958.7613 * 2
    * atan2(sqrt(haversine_value), sqrt(1 - haversine_value)))::numeric, 2);
end
$$;

create function private.recalculate_location_assessment(
  target_assessment_id uuid,
  target_organization_id uuid,
  target_team_id uuid,
  clear_override boolean
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  assessment record;
  team record;
  recalculated_distance numeric;
begin
  select * into assessment
  from public.service_location_assessments
  where id = target_assessment_id
  for update;
  if not found then
    return;
  end if;

  select id, organization_id, origin_label, origin_latitude, origin_longitude,
         service_radius_miles
    into team
  from public.cleaning_teams
  where id = target_team_id and organization_id = target_organization_id;
  if not found then
    raise exception 'Location assessment requires an existing team scope';
  end if;

  recalculated_distance := private.haversine_miles(
    team.origin_latitude, team.origin_longitude,
    assessment.property_latitude, assessment.property_longitude
  );

  update public.service_location_assessments
  set organization_id = target_organization_id,
      team_id = target_team_id,
      branch_origin_label = team.origin_label,
      branch_origin_latitude = team.origin_latitude,
      branch_origin_longitude = team.origin_longitude,
      standard_radius_miles = team.service_radius_miles,
      distance_miles = recalculated_distance,
      calculation_method = case
        when assessment.calculation_method = 'manual_review' then 'manual_review'
        when recalculated_distance is null then 'manual_review'
        else 'straight_line'
      end,
      assessment_status = case
        when assessment.calculation_method = 'manual_review' then 'manual_review'
        when recalculated_distance is null then 'manual_review'
        when recalculated_distance > team.service_radius_miles then 'outside_standard_radius'
        else 'inside_standard_radius'
      end,
      provider = assessment.provider,
      calculated_at = case
        when assessment.calculation_method = 'manual_review' then assessment.calculated_at
        when recalculated_distance is null then null
        else now()
      end,
      override_by_membership_id = case
        when clear_override then null else override_by_membership_id end,
      override_reason = case when clear_override then null else override_reason end,
      updated_at = now()
  where id = target_assessment_id;
end
$$;

create function private.customer_owns_allocation(requested_allocation_id uuid)
returns boolean language sql stable security definer
set search_path = '' as $$
  select exists (
    select 1
    from public.team_job_allocations allocation
    join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
    join public.bookings booking on booking.id = schedule.booking_id
    where allocation.id = requested_allocation_id
      and booking.customer_id = private.current_customer_id()
  )
$$;

create function private.current_staff_can_plan_territory(requested_territory_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and exists (
      select 1
      from public.workforce_memberships membership
      where membership.customer_id = private.current_customer_id()
        and membership.status = 'active'
        and (
          (membership.team_id is null and membership.role in ('owner', 'gm'))
          or (membership.role in ('manager', 'shift_lead')
            and exists (
              select 1
              from public.team_service_territories coverage
              join public.cleaning_teams team
                on team.organization_id = coverage.organization_id
               and team.id = coverage.team_id
               and team.status = 'active'
              where coverage.organization_id = membership.organization_id
                and coverage.team_id = membership.team_id
                and coverage.territory_id = requested_territory_id
                and coverage.status = 'active'
            ))
        )
    )
$$;

create function private.current_staff_can_manage_job_schedule(requested_schedule_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and exists (
      select 1
      from public.job_schedules schedule
      where schedule.id = requested_schedule_id
        and (
          exists (
            select 1 from public.team_job_allocations allocation
            where allocation.job_schedule_id = schedule.id
              and private.can_access_team(allocation.organization_id,
                allocation.team_id, array['owner','gm','manager','shift_lead'])
          )
          or (not exists (
              select 1 from public.team_job_allocations allocation
              where allocation.job_schedule_id = schedule.id
            ) and private.current_staff_can_plan_territory(schedule.territory_id))
        )
    )
$$;

create function private.current_manager_can_manage_job_schedule(requested_schedule_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and exists (
      select 1
      from public.job_schedules schedule
      where schedule.id = requested_schedule_id
        and (
          exists (
            select 1 from public.team_job_allocations allocation
            where allocation.job_schedule_id = schedule.id
              and private.can_access_team(allocation.organization_id,
                allocation.team_id, array['owner','gm','manager'])
          )
          or (not exists (
              select 1 from public.team_job_allocations allocation
              where allocation.job_schedule_id = schedule.id
            ) and exists (
              select 1
              from public.workforce_memberships membership
              where membership.customer_id = private.current_customer_id()
                and membership.status = 'active'
                and (
                  (membership.team_id is null and membership.role in ('owner','gm'))
                  or (membership.role = 'manager'
                    and exists (
                      select 1
                      from public.team_service_territories coverage
                      join public.cleaning_teams team
                        on team.organization_id = coverage.organization_id
                       and team.id = coverage.team_id
                       and team.status = 'active'
                      where coverage.organization_id = membership.organization_id
                        and coverage.team_id = membership.team_id
                        and coverage.territory_id = schedule.territory_id
                        and coverage.status = 'active'
                    ))
                )
            ))
        )
    )
$$;

create function private.current_customer_visible_job_issues()
returns table (
  id uuid,
  team_job_allocation_id uuid,
  issue_type text,
  severity text,
  summary text,
  status text,
  is_dev_seed boolean
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.current_customer_id() is null
    or private.current_cleaner_id() is not null then
    raise exception 'Customer-visible issue projection requires one customer actor'
      using errcode = '42501';
  end if;
  return query
    select issue.id, issue.team_job_allocation_id, issue.issue_type,
      issue.severity, issue.summary, issue.status, issue.is_dev_seed
    from public.job_issue_reports issue
    join public.team_job_allocations allocation
      on allocation.id = issue.team_job_allocation_id
     and allocation.organization_id = issue.organization_id
     and allocation.team_id = issue.team_id
    join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
    join public.bookings booking on booking.id = schedule.booking_id
    where issue.customer_visible
      and booking.customer_id = private.current_customer_id()
    order by issue.created_at desc;
end
$$;

create function private.current_customer_quality_reviews()
returns table (
  id uuid,
  team_job_allocation_id uuid,
  cleaner_id uuid,
  rating integer,
  is_dev_seed boolean
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.current_customer_id() is null
    or private.current_cleaner_id() is not null then
    raise exception 'Customer review projection requires one customer actor'
      using errcode = '42501';
  end if;
  return query
    select review.id, review.team_job_allocation_id, review.cleaner_id,
      review.rating, review.is_dev_seed
    from public.quality_reviews review
    join public.team_job_allocations allocation
      on allocation.id = review.team_job_allocation_id
     and allocation.organization_id = review.organization_id
     and allocation.team_id = review.team_id
    join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
    join public.bookings booking on booking.id = schedule.booking_id
    where review.source = 'verified_customer'
      and review.customer_id = private.current_customer_id()
      and booking.customer_id = private.current_customer_id()
    order by review.created_at desc;
end
$$;

create function private.guard_location_assessment_decision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  current_schedule_id uuid;
  current_schedule_status text;
  legacy_route_review boolean := false;
begin
  if new.assessment_status is not distinct from old.assessment_status
    and new.override_by_membership_id is not distinct from old.override_by_membership_id
    and new.override_reason is not distinct from old.override_reason then
    return new;
  end if;

  select schedule.id, schedule.status
    into current_schedule_id, current_schedule_status
  from public.job_schedules schedule
  where schedule.booking_id = old.booking_id;

  legacy_route_review := current_schedule_status in (
      'en_route', 'in_progress', 'quality_review'
    )
    and new.assessment_status = 'approved_exception'
    and old.assessment_status in ('manual_review', 'outside_standard_radius')
    and new.override_by_membership_id is not null
    and new.override_reason is not null
    and exists (
      select 1
      from private.legacy_field_execution_continuity legacy
      join public.job_schedules schedule on schedule.id = legacy.job_schedule_id
      where legacy.job_schedule_id = current_schedule_id
        and legacy.organization_id = old.organization_id
        and legacy.team_id = old.team_id
        and schedule.start_at = legacy.original_start_at
        and schedule.end_at = legacy.original_end_at
    )
    and not exists (
      select 1
      from private.service_location_assessment_decisions decision
      where decision.assessment_id = old.id
        and decision.decision_kind = 'approved_exception'
    );

  if current_schedule_status in ('completed', 'canceled')
    or (
      current_schedule_status in ('en_route', 'in_progress', 'quality_review')
      and not legacy_route_review
    ) then
    raise exception 'Historical route decisions are immutable after execution begins'
      using errcode = '55000';
  end if;

  if new.assessment_status = 'approved_exception' then
    if old.assessment_status not in ('manual_review', 'outside_standard_radius')
      or (
        current_schedule_status not in ('tentative', 'held', 'confirmed')
        and not legacy_route_review
      )
      or new.override_by_membership_id is null
      or new.override_reason is null then
      raise exception 'A route exception may approve one current review only'
      using errcode = '55000';
    end if;
    if private.current_customer_id() is null
      or private.current_cleaner_id() is not null
      or not private.is_current_membership(new.override_by_membership_id)
      or not private.can_access_team(
        new.organization_id, new.team_id, array['owner','gm','manager']
      ) then
      raise exception 'Route exception approval requires the current authorized manager identity'
        using errcode = '42501';
    end if;
  elsif old.assessment_status = 'approved_exception' then
    if current_schedule_status not in ('tentative', 'held')
      or new.override_by_membership_id is not null
      or new.override_reason is not null
      or (
        new.branch_origin_label is not distinct from old.branch_origin_label
        and new.branch_origin_latitude is not distinct from old.branch_origin_latitude
        and new.branch_origin_longitude is not distinct from old.branch_origin_longitude
        and new.standard_radius_miles is not distinct from old.standard_radius_miles
        and new.distance_miles is not distinct from old.distance_miles
      ) then
      raise exception 'A route exception may only be invalidated by pre-confirmation route recalculation'
        using errcode = '55000';
    end if;
  end if;
  return new;
end
$$;
create trigger service_location_assessments_decision_guard
  before update of assessment_status, override_by_membership_id, override_reason
  on service_location_assessments for each row
  execute function private.guard_location_assessment_decision();

create function private.audit_location_assessment_decision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  current_schedule_status text;
begin
  if new.assessment_status = 'approved_exception'
    and old.assessment_status <> 'approved_exception' then
    select schedule.status into current_schedule_status
    from public.job_schedules schedule where schedule.booking_id = new.booking_id;
    insert into private.service_location_assessment_decisions
      (assessment_id, booking_id, organization_id, team_id, decision_kind,
       prior_status, resulting_status, schedule_status, actor_membership_id,
       reason, distance_miles, standard_radius_miles, branch_origin_label)
    values (new.id, new.booking_id, new.organization_id, new.team_id,
      'approved_exception', old.assessment_status, new.assessment_status,
      current_schedule_status, new.override_by_membership_id,
      new.override_reason, new.distance_miles, new.standard_radius_miles,
      new.branch_origin_label);
  elsif old.assessment_status = 'approved_exception'
    and new.assessment_status <> 'approved_exception' then
    select schedule.status into current_schedule_status
    from public.job_schedules schedule where schedule.booking_id = new.booking_id;
    insert into private.service_location_assessment_decisions
      (assessment_id, booking_id, organization_id, team_id, decision_kind,
       prior_status, resulting_status, schedule_status, actor_membership_id,
       reason, distance_miles, standard_radius_miles, branch_origin_label)
    values (new.id, new.booking_id, new.organization_id, new.team_id,
      'invalidated', old.assessment_status, new.assessment_status,
      current_schedule_status, old.override_by_membership_id,
      'Prior route exception invalidated by pre-confirmation route recalculation.',
      new.distance_miles, new.standard_radius_miles, new.branch_origin_label);
  end if;
  return new;
end
$$;
create trigger service_location_assessments_decision_audit
  after update of assessment_status, override_by_membership_id, override_reason
  on service_location_assessments for each row
  execute function private.audit_location_assessment_decision();

create function private.guard_location_assessment_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  team_context record;
  expected_distance numeric;
  expected_method text;
  expected_status text;
begin
  if new.id is not distinct from old.id
    and new.booking_id is not distinct from old.booking_id
    and new.organization_id is not distinct from old.organization_id
    and new.team_id is not distinct from old.team_id
    and new.address_fingerprint is not distinct from old.address_fingerprint
    and new.branch_origin_label is not distinct from old.branch_origin_label
    and new.branch_origin_latitude is not distinct from old.branch_origin_latitude
    and new.branch_origin_longitude is not distinct from old.branch_origin_longitude
    and new.property_latitude is not distinct from old.property_latitude
    and new.property_longitude is not distinct from old.property_longitude
    and new.distance_miles is not distinct from old.distance_miles
    and new.duration_minutes is not distinct from old.duration_minutes
    and new.standard_radius_miles is not distinct from old.standard_radius_miles
    and new.calculation_method is not distinct from old.calculation_method
    and new.assessment_status is not distinct from old.assessment_status
    and new.provider is not distinct from old.provider
    and new.provider_resolved_address is not distinct from old.provider_resolved_address
    and new.provider_match_confidence is not distinct from old.provider_match_confidence
    and new.provider_coordinate_accuracy is not distinct from old.provider_coordinate_accuracy
    and new.calculated_at is not distinct from old.calculated_at
    and new.override_by_membership_id is not distinct from old.override_by_membership_id
    and new.override_reason is not distinct from old.override_reason
    and new.is_dev_seed is not distinct from old.is_dev_seed
    and new.created_at is not distinct from old.created_at then
    return new;
  end if;

  -- The decision trigger immediately before this guard authorizes and
  -- attributes one explicit manager exception. That path may change only the
  -- decision status and its two actor-evidence fields; every measured and
  -- provider-supplied fact remains byte-for-byte immutable.
  if old.assessment_status in ('manual_review', 'outside_standard_radius')
    and new.assessment_status = 'approved_exception'
    and new.override_by_membership_id is not null
    and new.override_reason is not null
    and (to_jsonb(new)
      - 'assessment_status' - 'override_by_membership_id' - 'override_reason')
      = (to_jsonb(old)
      - 'assessment_status' - 'override_by_membership_id' - 'override_reason') then
    return new;
  end if;

  -- The intake enrichment function may replace only the fail-safe manual
  -- evidence on an unallocated request. RLS prevents a direct null-actor
  -- UPDATE; the narrow SECURITY DEFINER function is the only app-role path.
  if private.current_customer_id() is null
    and private.current_cleaner_id() is null
    and old.team_id is null and new.team_id is null
    and new.id = old.id
    and new.booking_id = old.booking_id
    and new.organization_id = old.organization_id
    and new.address_fingerprint = old.address_fingerprint
    and new.branch_origin_label is not distinct from old.branch_origin_label
    and new.branch_origin_latitude is not distinct from old.branch_origin_latitude
    and new.branch_origin_longitude is not distinct from old.branch_origin_longitude
    and new.standard_radius_miles = old.standard_radius_miles
    and new.duration_minutes is not distinct from old.duration_minutes
    and old.provider = 'manual'
    and old.calculation_method = 'manual_review'
    and old.assessment_status = 'manual_review'
    and old.property_latitude is null and old.property_longitude is null
    and old.distance_miles is null and old.calculated_at is null
    and old.override_by_membership_id is null and old.override_reason is null
    and new.provider = 'mapbox'
    and new.property_latitude is not null and new.property_longitude is not null
    and new.distance_miles is not null and new.calculated_at is not null
    and abs(new.distance_miles - private.haversine_miles(
      new.branch_origin_latitude, new.branch_origin_longitude,
      new.property_latitude, new.property_longitude
    )) <= 0.011
    and (
      (new.calculation_method = 'straight_line'
        and new.provider_match_confidence = 'exact'
        and new.provider_coordinate_accuracy in ('rooftop', 'parcel', 'point')
        and new.assessment_status = case
          when new.distance_miles > new.standard_radius_miles
            then 'outside_standard_radius'
          else 'inside_standard_radius'
        end)
      or (new.calculation_method = 'manual_review'
        and new.assessment_status = 'manual_review')
    )
    and new.override_by_membership_id is null and new.override_reason is null
    and new.is_dev_seed = old.is_dev_seed
    and new.created_at = old.created_at
    and not exists (
      select 1
      from public.job_schedules schedule
      join public.team_job_allocations allocation
        on allocation.job_schedule_id = schedule.id
      where schedule.booking_id = old.booking_id
    ) then
    return new;
  end if;

  -- Allocation and branch-policy triggers may deterministically recalculate a
  -- still-planning assessment. They cannot rewrite the customer address,
  -- provider evidence, historical identity, or an executing/closed visit.
  if new.id = old.id
    and new.booking_id = old.booking_id
    and new.organization_id = old.organization_id
    and new.team_id is not null
    and (old.team_id is null or old.team_id = new.team_id)
    and new.address_fingerprint = old.address_fingerprint
    and new.property_latitude is not distinct from old.property_latitude
    and new.property_longitude is not distinct from old.property_longitude
    and new.duration_minutes is not distinct from old.duration_minutes
    and new.provider = old.provider
    and new.provider_resolved_address is not distinct from old.provider_resolved_address
    and new.provider_match_confidence is not distinct from old.provider_match_confidence
    and new.provider_coordinate_accuracy is not distinct from old.provider_coordinate_accuracy
    and new.override_by_membership_id is null and new.override_reason is null
    and new.is_dev_seed = old.is_dev_seed
    and new.created_at = old.created_at then
    select team.origin_label, team.origin_latitude, team.origin_longitude,
           team.service_radius_miles, schedule.status as schedule_status
      into team_context
    from public.job_schedules schedule
    join public.team_job_allocations allocation
      on allocation.job_schedule_id = schedule.id
    join public.cleaning_teams team
      on team.organization_id = allocation.organization_id
     and team.id = allocation.team_id
    where schedule.booking_id = new.booking_id
      and allocation.organization_id = new.organization_id
      and allocation.team_id = new.team_id
    limit 1;

    if found and team_context.schedule_status in ('tentative', 'held') then
      expected_distance := private.haversine_miles(
        team_context.origin_latitude, team_context.origin_longitude,
        new.property_latitude, new.property_longitude
      );
      expected_method := case
        when old.calculation_method = 'manual_review' or expected_distance is null
          then 'manual_review'
        else 'straight_line'
      end;
      expected_status := case
        when expected_method = 'manual_review' then 'manual_review'
        when expected_distance > team_context.service_radius_miles
          then 'outside_standard_radius'
        else 'inside_standard_radius'
      end;
      if new.branch_origin_label is not distinct from team_context.origin_label
        and new.branch_origin_latitude is not distinct from team_context.origin_latitude
        and new.branch_origin_longitude is not distinct from team_context.origin_longitude
        and new.standard_radius_miles is not distinct from team_context.service_radius_miles
        and new.distance_miles is not distinct from expected_distance
        and new.calculation_method = expected_method
        and new.assessment_status = expected_status
        and new.calculated_at is not distinct from (case
          when expected_method = 'manual_review' then old.calculated_at
          else now()
        end) then
        return new;
      end if;
    end if;
  end if;

  raise exception 'Route assessment identity and evidence are immutable outside narrow pre-confirmation recalculation'
    using errcode = '55000';
end
$$;
create trigger service_location_assessments_evidence_guard
  before update on service_location_assessments for each row
  execute function private.guard_location_assessment_evidence();

create function private.customer_has_team_service(requested_team_id uuid)
returns boolean language sql stable security definer
set search_path = '' as $$
  select exists (
    select 1
    from public.team_job_allocations allocation
    join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
    join public.bookings booking on booking.id = schedule.booking_id
    where allocation.team_id = requested_team_id
      and booking.customer_id = private.current_customer_id()
  )
$$;

create function private.cleaner_assigned_to_allocation(requested_allocation_id uuid)
returns boolean language sql stable security definer
set search_path = '' as $$
  select exists (
    select 1
    from public.team_job_allocations allocation
    join public.job_assignments assignment
      on assignment.job_schedule_id = allocation.job_schedule_id
     and assignment.team_id = allocation.team_id
    join public.workforce_memberships membership
      on membership.organization_id = allocation.organization_id
     and membership.team_id = allocation.team_id
     and membership.cleaner_id = private.current_cleaner_id()
     and membership.status = 'active'
     and membership.role in ('cleaner', 'shift_lead')
    where allocation.id = requested_allocation_id
      and assignment.cleaner_id = private.current_cleaner_id()
      and assignment.status in ('accepted', 'confirmed')
  )
$$;

create function private.cleaner_assigned_to_booking(requested_booking_id uuid)
returns boolean language sql stable security definer
set search_path = '' as $$
  select exists (
    select 1
    from public.job_schedules schedule
    join public.team_job_allocations allocation
      on allocation.job_schedule_id = schedule.id
    join public.job_assignments assignment
      on assignment.job_schedule_id = schedule.id
     and assignment.team_id = allocation.team_id
    join public.workforce_memberships membership
      on membership.organization_id = allocation.organization_id
     and membership.team_id = allocation.team_id
     and membership.cleaner_id = private.current_cleaner_id()
     and membership.status = 'active'
     and membership.role in ('cleaner', 'shift_lead')
    where schedule.booking_id = requested_booking_id
      and assignment.cleaner_id = private.current_cleaner_id()
      and assignment.status in ('accepted', 'confirmed')
  )
$$;

create function private.current_actor_can_read_job_schedule(requested_schedule_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when private.current_customer_id() is not null
      and private.current_cleaner_id() is not null then false
    when private.current_cleaner_id() is not null then exists (
      select 1 from public.job_schedules schedule
      where schedule.id = requested_schedule_id
        and private.cleaner_assigned_to_booking(schedule.booking_id)
    )
    when private.current_customer_id() is not null then
      private.current_staff_can_manage_job_schedule(requested_schedule_id)
      or exists (
        select 1
        from public.job_schedules schedule
        join public.bookings booking on booking.id = schedule.booking_id
        where schedule.id = requested_schedule_id
          and booking.customer_id = private.current_customer_id()
      )
    else false
  end
$$;

create function private.current_cleaner_can_view_duty_member(
  requested_membership_id uuid
) returns boolean language sql stable security definer
set search_path = '' as $$
  select exists (
    select 1
    from public.team_duty_assignments duty
    join public.workforce_memberships subject
      on subject.id = duty.workforce_membership_id
     and subject.status = 'active'
    join public.workforce_memberships viewer
      on viewer.organization_id = duty.organization_id
     and viewer.team_id = duty.team_id
     and viewer.cleaner_id = private.current_cleaner_id()
     and viewer.status = 'active'
     and viewer.role in ('cleaner', 'shift_lead')
    where duty.workforce_membership_id = requested_membership_id
      and duty.status in ('scheduled', 'active')
      and duty.starts_at <= now()
      and duty.ends_at > now()
  )
$$;

create function private.current_cleaner_duty_coverage()
returns table (
  id uuid,
  team_id uuid,
  duty_kind text,
  display_name text,
  starts_at timestamptz,
  ends_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.current_cleaner_id() is null
    or private.current_customer_id() is not null then
    raise exception 'Duty coverage projection requires one cleaner actor'
      using errcode = '42501';
  end if;

  return query
    select duty.id, duty.team_id, duty.duty_kind,
      coalesce(nullif(trim(staff.full_name), ''),
        nullif(trim(cleaner.full_name), ''),
        case duty.duty_kind
          when 'manager_on_duty' then 'Manager on duty'
          else 'Shift lead on duty'
        end) as display_name,
      duty.starts_at, duty.ends_at
    from public.team_duty_assignments duty
    join public.workforce_memberships subject
      on subject.id = duty.workforce_membership_id
     and subject.organization_id = duty.organization_id
     and (
       subject.team_id = duty.team_id
       or (subject.team_id is null and subject.role in ('owner', 'gm'))
     )
     and subject.status = 'active'
     and (
       (duty.duty_kind = 'manager_on_duty'
         and subject.role in ('owner', 'gm', 'manager'))
       or (duty.duty_kind = 'shift_lead_on_duty'
         and subject.role in ('owner', 'gm', 'manager', 'shift_lead'))
     )
    join public.workforce_memberships viewer
      on viewer.organization_id = duty.organization_id
     and viewer.team_id = duty.team_id
     and viewer.cleaner_id = private.current_cleaner_id()
     and viewer.status = 'active'
     and viewer.role in ('cleaner', 'shift_lead')
    left join public.customers staff on staff.id = subject.customer_id
    left join public.cleaners cleaner on cleaner.id = subject.cleaner_id
    where duty.status in ('scheduled', 'active')
      and duty.starts_at <= now()
      and duty.ends_at > now()
    order by duty.starts_at, duty.id;
end
$$;

create function private.cancel_invalid_member_duty() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> 'active'
    or new.role is distinct from old.role
    or new.team_id is distinct from old.team_id
    or new.organization_id is distinct from old.organization_id then
    update public.team_duty_assignments duty
    set status = 'canceled',
        note = case
          when nullif(trim(duty.note), '') is null then
            'Automatically canceled because the assigned membership became inactive or changed scope.'
          else left(duty.note, greatest(0, 1000 - char_length(
            'Automatically canceled because the assigned membership became inactive or changed scope.'
          ) - 3)) || ' · '
            || 'Automatically canceled because the assigned membership became inactive or changed scope.'
        end,
        updated_at = now()
    where duty.workforce_membership_id = old.id
      and duty.status in ('scheduled', 'active')
      and duty.ends_at > now();
  end if;
  return new;
end
$$;
create trigger workforce_memberships_cancel_invalid_duty
  after update of status, role, team_id, organization_id
  on workforce_memberships for each row
  execute function private.cancel_invalid_member_duty();

update team_duty_assignments duty
set status = 'canceled',
    note = case
      when nullif(trim(duty.note), '') is null then
        'Canceled during field-operations rollout because the assigned membership is not currently eligible.'
      else left(duty.note, greatest(0, 1000 - char_length(
        'Canceled during field-operations rollout because the assigned membership is not currently eligible.'
      ) - 3)) || ' · '
        || 'Canceled during field-operations rollout because the assigned membership is not currently eligible.'
    end,
    updated_at = now()
from workforce_memberships membership
where membership.id = duty.workforce_membership_id
  and duty.status in ('scheduled', 'active')
  and (
    membership.status <> 'active'
    or membership.organization_id <> duty.organization_id
    or (
      membership.team_id is distinct from duty.team_id
      and not (membership.team_id is null and membership.role in ('owner', 'gm'))
    )
    or (duty.duty_kind = 'manager_on_duty'
      and membership.role not in ('owner', 'gm', 'manager'))
    or (duty.duty_kind = 'shift_lead_on_duty'
      and membership.role not in ('owner', 'gm', 'manager', 'shift_lead'))
  );

create function private.guard_team_duty_lifecycle() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  automatic_cancellation_note constant text :=
    'Automatically canceled because the assigned membership became inactive or changed scope.';
begin
  if tg_op = 'INSERT' then
    if new.ends_at <= clock_timestamp() then
      raise exception 'Duty coverage must end in the future'
        using errcode = '23514';
    end if;
    new.status := case when new.starts_at <= clock_timestamp()
      then 'active' else 'scheduled' end;
    return new;
  end if;

  if new.id <> old.id
    or new.organization_id <> old.organization_id
    or new.team_id <> old.team_id
    or new.workforce_membership_id <> old.workforce_membership_id
    or new.starts_at <> old.starts_at
    or new.ends_at <> old.ends_at
    or new.duty_kind <> old.duty_kind
    or new.created_by_membership_id <> old.created_by_membership_id
    or new.is_dev_seed <> old.is_dev_seed
    or new.created_at <> old.created_at then
    raise exception 'Duty coverage identity and time window are immutable'
      using errcode = '55000';
  end if;
  if old.status in ('completed', 'canceled')
    and new.status is distinct from old.status then
    raise exception 'Terminal duty coverage is immutable'
      using errcode = '55000';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'scheduled' and new.status in ('active', 'canceled'))
    or (old.status = 'active' and new.status in ('completed', 'canceled'))
  ) then
    raise exception 'Invalid duty coverage lifecycle transition'
      using errcode = '55000';
  end if;
  if old.status = 'scheduled' and new.status = 'active'
    and (clock_timestamp() < old.starts_at or clock_timestamp() >= old.ends_at) then
    raise exception 'Scheduled duty becomes active only inside its coverage window'
      using errcode = '55000';
  end if;
  if new.note is distinct from old.note and not (
    pg_trigger_depth() > 1
    and new.status = 'canceled'
    and new.note = case
      when nullif(trim(old.note), '') is null then automatic_cancellation_note
      else left(old.note, greatest(0,
        1000 - char_length(automatic_cancellation_note) - 3))
        || ' · ' || automatic_cancellation_note
    end
  ) then
    raise exception 'Duty notes are immutable except the automatic cancellation annotation'
      using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger team_duty_assignments_lifecycle_guard
  before insert or update on team_duty_assignments for each row
  execute function private.guard_team_duty_lifecycle();

create function private.has_complete_current_team_crew(
  target_schedule_id uuid,
  target_organization_id uuid,
  target_team_id uuid,
  required_crew integer
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform 1
  from public.workforce_memberships membership
  where membership.organization_id = target_organization_id
    and membership.team_id = target_team_id
    and membership.status = 'active'
    and membership.role in ('cleaner', 'shift_lead')
    and membership.cleaner_id is not null
  order by membership.id
  for share;

  return (
    select count(distinct assignment.cleaner_id) = required_crew
    from public.job_assignments assignment
    join public.workforce_memberships membership
      on membership.organization_id = target_organization_id
     and membership.team_id = target_team_id
     and membership.cleaner_id = assignment.cleaner_id
     and membership.status = 'active'
     and membership.role in ('cleaner', 'shift_lead')
    where assignment.job_schedule_id = target_schedule_id
      and assignment.team_id = target_team_id
      and assignment.status in ('accepted', 'confirmed')
  );
end
$$;

create function private.reconcile_ineligible_cleaner_assignments() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.cleaner_id is null or old.team_id is null
    or (
      new.status = 'active'
      and new.role in ('cleaner', 'shift_lead')
      and new.organization_id = old.organization_id
      and new.team_id = old.team_id
      and new.cleaner_id = old.cleaner_id
    )
    or exists (
      select 1 from public.workforce_memberships replacement
      where replacement.id <> old.id
        and replacement.organization_id = old.organization_id
        and replacement.team_id = old.team_id
        and replacement.cleaner_id = old.cleaner_id
        and replacement.status = 'active'
        and replacement.role in ('cleaner', 'shift_lead')
    ) then
    return new;
  end if;

  update public.job_schedules schedule
  set status = 'held', version = version + 1
  where schedule.status = 'confirmed'
    and exists (
      select 1
      from public.team_job_allocations allocation
      join public.job_assignments assignment
        on assignment.job_schedule_id = allocation.job_schedule_id
       and assignment.team_id = allocation.team_id
      where allocation.job_schedule_id = schedule.id
        and allocation.organization_id = old.organization_id
        and allocation.team_id = old.team_id
        and assignment.cleaner_id = old.cleaner_id
        and assignment.status in ('proposed', 'accepted', 'confirmed')
    );

  update public.job_assignments assignment
  set status = 'removed', responded_at = now()
  from public.team_job_allocations allocation,
       public.job_schedules schedule
  where allocation.job_schedule_id = assignment.job_schedule_id
    and schedule.id = assignment.job_schedule_id
    and allocation.organization_id = old.organization_id
    and allocation.team_id = old.team_id
    and assignment.team_id = old.team_id
    and assignment.cleaner_id = old.cleaner_id
    and assignment.status in ('proposed', 'accepted', 'confirmed')
    and schedule.status in ('tentative', 'held');
  return new;
end
$$;
create trigger workforce_memberships_reconcile_ineligible_assignments
  after update of status, role, team_id, organization_id, cleaner_id
  on workforce_memberships for each row
  execute function private.reconcile_ineligible_cleaner_assignments();

update job_schedules schedule
set status = 'held', version = version + 1
where schedule.status = 'confirmed'
  and exists (
    select 1
    from team_job_allocations allocation
    join job_assignments assignment
      on assignment.job_schedule_id = allocation.job_schedule_id
     and assignment.team_id = allocation.team_id
     and assignment.status in ('proposed', 'accepted', 'confirmed')
    where allocation.job_schedule_id = schedule.id
      and not exists (
        select 1 from workforce_memberships membership
        where membership.organization_id = allocation.organization_id
          and membership.team_id = allocation.team_id
          and membership.cleaner_id = assignment.cleaner_id
          and membership.status = 'active'
          and membership.role in ('cleaner', 'shift_lead')
      )
  );
update job_assignments assignment
set status = 'removed', responded_at = now()
from team_job_allocations allocation, job_schedules schedule
where allocation.job_schedule_id = assignment.job_schedule_id
  and schedule.id = assignment.job_schedule_id
  and assignment.team_id = allocation.team_id
  and assignment.status in ('proposed', 'accepted', 'confirmed')
  and schedule.status in ('tentative', 'held')
  and not exists (
    select 1 from workforce_memberships membership
    where membership.organization_id = allocation.organization_id
      and membership.team_id = allocation.team_id
      and membership.cleaner_id = assignment.cleaner_id
      and membership.status = 'active'
      and membership.role in ('cleaner', 'shift_lead')
  );

create function private.guard_allocation_scope_immutability() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.organization_id <> old.organization_id
    or new.team_id <> old.team_id
    or new.job_schedule_id <> old.job_schedule_id then
    raise exception 'Allocated job identity is immutable; create a reviewed replacement allocation'
      using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger team_job_allocations_scope_immutability_guard
  before update of organization_id, team_id, job_schedule_id
  on team_job_allocations for each row
  execute function private.guard_allocation_scope_immutability();

create function private.lock_customer_team_cleaner_preference(
  target_organization_id uuid,
  target_team_id uuid,
  target_customer_id uuid,
  target_cleaner_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if target_organization_id is null or target_team_id is null
    or target_customer_id is null or target_cleaner_id is null then
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    target_organization_id::text || ':' || target_team_id::text || ':'
      || target_customer_id::text || ':' || target_cleaner_id::text,
    20260714173819
  ));
end
$$;

create function private.guard_allocation_customer_avoid() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  target_customer_id uuid;
  target_cleaner_id uuid;
begin
  select booking.customer_id into target_customer_id
  from public.job_schedules schedule
  join public.bookings booking on booking.id = schedule.booking_id
  where schedule.id = new.job_schedule_id;
  if target_customer_id is not null then
    for target_cleaner_id in
      select assignment.cleaner_id
      from public.job_assignments assignment
      where assignment.job_schedule_id = new.job_schedule_id
        and assignment.status in ('proposed', 'accepted', 'confirmed')
      order by assignment.cleaner_id
    loop
      perform private.lock_customer_team_cleaner_preference(
        new.organization_id, new.team_id, target_customer_id, target_cleaner_id
      );
    end loop;
  end if;
  if exists (
    select 1
    from public.job_schedules schedule
    join public.bookings booking on booking.id = schedule.booking_id
    join public.job_assignments assignment
      on assignment.job_schedule_id = schedule.id
     and assignment.status in ('proposed', 'accepted', 'confirmed')
    join public.customer_cleaner_preferences preference
      on preference.organization_id = new.organization_id
     and preference.team_id = new.team_id
     and preference.customer_id = booking.customer_id
     and preference.cleaner_id = assignment.cleaner_id
     and preference.active and preference.preference = 'avoid'
    where schedule.id = new.job_schedule_id
  ) then
    raise exception 'Allocated crew conflicts with an active customer do-not-schedule preference'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger team_job_allocations_customer_avoid_guard
  before insert or update of organization_id, team_id, job_schedule_id
  on team_job_allocations for each row
  execute function private.guard_allocation_customer_avoid();

create function private.validate_allocation_operating_hours() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  schedule_row record;
  team_row record;
  local_start timestamp;
  local_end timestamp;
begin
  select start_at, end_at, status into schedule_row
  from public.job_schedules where id = new.job_schedule_id;
  select timezone, operating_start_time, latest_arrival_time, hard_finish_time
    into team_row
  from public.cleaning_teams
  where organization_id = new.organization_id and id = new.team_id
  for share;

  if schedule_row is null or team_row is null then
    raise exception 'Allocation requires an existing schedule and team';
  end if;
  if schedule_row.status not in ('tentative', 'held') then
    raise exception 'Only tentative or held schedules may be allocated; confirm after route and customer approval'
      using errcode = '23514';
  end if;
  local_start := schedule_row.start_at at time zone team_row.timezone;
  local_end := schedule_row.end_at at time zone team_row.timezone;
  if local_start::date <> local_end::date
    or local_start::time < team_row.operating_start_time
    or local_start::time > team_row.latest_arrival_time
    or local_end::time > team_row.hard_finish_time then
    raise exception
      'Schedule must start between % and % and finish by % in %',
      team_row.operating_start_time, team_row.latest_arrival_time,
      team_row.hard_finish_time, team_row.timezone;
  end if;
  return new;
end
$$;
create trigger team_job_allocations_operating_hours_guard
  before insert or update of organization_id, team_id, job_schedule_id
  on team_job_allocations for each row
  execute function private.validate_allocation_operating_hours();

create function private.sync_allocation_field_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  target_booking_id uuid;
  target_assessment_id uuid;
begin
  select booking_id into target_booking_id
  from public.job_schedules where id = new.job_schedule_id;
  update public.job_assignments
  set team_id = new.team_id
  where job_schedule_id = new.job_schedule_id
    and team_id is null
    and status in ('accepted', 'confirmed');
  update public.checklist_items
  set organization_id = new.organization_id,
      team_id = new.team_id,
      team_job_allocation_id = new.id
  where booking_id = target_booking_id;
  if not exists (
    select 1 from public.checklist_items item
    where item.team_job_allocation_id = new.id
  ) then
    insert into public.checklist_items
      (booking_id, room_label, label, sort, organization_id, team_id,
       team_job_allocation_id, is_dev_seed)
    values (target_booking_id, null,
      'Complete the approved service scope and document every exception', 0,
      new.organization_id, new.team_id, new.id, new.is_dev_seed);
  end if;
  select id into target_assessment_id
  from public.service_location_assessments
  where booking_id = target_booking_id;
  perform private.recalculate_location_assessment(
    target_assessment_id, new.organization_id, new.team_id, true
  );
  return new;
end
$$;
create trigger team_job_allocations_field_scope_sync
  after insert or update of organization_id, team_id, job_schedule_id
  on team_job_allocations for each row
  execute function private.sync_allocation_field_scope();

create function private.refresh_pending_team_location_assessments() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  assessment_id uuid;
begin
  if new.origin_label is not distinct from old.origin_label
    and new.origin_latitude is not distinct from old.origin_latitude
    and new.origin_longitude is not distinct from old.origin_longitude
    and new.service_radius_miles is not distinct from old.service_radius_miles then
    return new;
  end if;

  for assessment_id in
    select assessment.id
    from public.service_location_assessments assessment
    join public.bookings booking on booking.id = assessment.booking_id
    left join public.job_schedules schedule on schedule.booking_id = booking.id
    where assessment.organization_id = new.organization_id
      and assessment.team_id = new.id
      and (schedule.id is null or schedule.status in ('tentative', 'held'))
  loop
    perform private.recalculate_location_assessment(
      assessment_id, new.organization_id, new.id, true
    );
  end loop;
  return new;
end
$$;
create trigger cleaning_teams_pending_assessment_refresh
  after update of origin_label, origin_latitude, origin_longitude, service_radius_miles
  on cleaning_teams for each row
  execute function private.refresh_pending_team_location_assessments();

create function private.guard_cleaning_team_update_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.current_cleaner_id() is not null
    or private.current_customer_id() is null then
    raise exception 'Cleaning-team updates require one staff actor'
      using errcode = '42501';
  end if;
  if private.can_access_organization(old.organization_id, array['owner','gm']) then
    if new.id <> old.id or new.organization_id <> old.organization_id then
      raise exception 'Cleaning-team primary scope is immutable'
        using errcode = '55000';
    end if;
    return new;
  end if;
  if not private.can_access_team(
      old.organization_id, old.id, array['manager'])
    or new.id <> old.id
    or new.organization_id <> old.organization_id
    or new.code <> old.code
    or new.name <> old.name
    or new.status <> old.status
    or new.territory_ids is distinct from old.territory_ids
    or new.vertical_specialties is distinct from old.vertical_specialties
    or new.timezone <> old.timezone
    or new.is_dev_seed <> old.is_dev_seed
    or new.created_at <> old.created_at then
    raise exception 'Branch managers may update only field-policy and contact settings'
      using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger cleaning_teams_update_scope_guard
  before update on cleaning_teams for each row
  execute function private.guard_cleaning_team_update_scope();

create function private.guard_team_field_policy_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  violating_schedule_id uuid;
  violating_proposal_id uuid;
begin
  if new.timezone is not distinct from old.timezone
    and new.operating_start_time is not distinct from old.operating_start_time
    and new.latest_arrival_time is not distinct from old.latest_arrival_time
    and new.hard_finish_time is not distinct from old.hard_finish_time
    and new.arrival_window_minutes is not distinct from old.arrival_window_minutes then
    return new;
  end if;

  select schedule.id into violating_schedule_id
  from public.team_job_allocations allocation
  join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
  where allocation.organization_id = new.organization_id
    and allocation.team_id = new.id
    and schedule.status in (
      'tentative', 'held', 'confirmed', 'en_route', 'in_progress', 'quality_review'
    )
    and (
      (schedule.start_at at time zone new.timezone)::date
        <> (schedule.end_at at time zone new.timezone)::date
      or (schedule.start_at at time zone new.timezone)::time
        < new.operating_start_time
      or (schedule.start_at at time zone new.timezone)::time
        > new.latest_arrival_time
      or (schedule.end_at at time zone new.timezone)::time
        > new.hard_finish_time
    )
  order by schedule.start_at
  limit 1;
  if violating_schedule_id is not null then
    raise exception
      'Branch field policy would strand active schedule %; reschedule or finish it before tightening hours',
      violating_schedule_id
      using errcode = '55000';
  end if;

  select proposal.id into violating_proposal_id
  from public.schedule_proposals proposal
  join public.job_schedules schedule on schedule.id = proposal.job_schedule_id
  where proposal.organization_id = new.organization_id
    and proposal.team_id = new.id
    and proposal.status in ('draft', 'pending_customer', 'approved', 'changes_requested')
    and (proposal.expires_at is null or proposal.expires_at > now())
    and (
      extract(epoch from (
        proposal.arrival_window_end - proposal.arrival_window_start
      )) / 60 <> new.arrival_window_minutes
      or (coalesce(proposal.proposed_start_at, schedule.start_at)
        at time zone new.timezone)::date
        <> (coalesce(proposal.proposed_end_at, schedule.end_at)
          at time zone new.timezone)::date
      or (coalesce(proposal.proposed_start_at, schedule.start_at)
        at time zone new.timezone)::time < new.operating_start_time
      or (coalesce(proposal.proposed_start_at, schedule.start_at)
        at time zone new.timezone)::time > new.latest_arrival_time
      or (coalesce(proposal.proposed_end_at, schedule.end_at)
        at time zone new.timezone)::time > new.hard_finish_time
    )
  order by proposal.created_at
  limit 1;
  if violating_proposal_id is not null then
    raise exception
      'Branch field policy would invalidate open schedule proposal %; resolve or restage it first',
      violating_proposal_id
      using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger cleaning_teams_field_policy_change_guard
  before update of timezone, operating_start_time, latest_arrival_time,
    hard_finish_time, arrival_window_minutes
  on cleaning_teams for each row
  execute function private.guard_team_field_policy_change();

create function private.validate_schedule_proposal() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  context record;
  effective_start timestamptz;
  effective_end timestamptz;
  local_start timestamp;
  local_end timestamp;
  crew_cleaner_id uuid;
begin
  select allocation.organization_id, allocation.team_id,
         allocation.job_schedule_id, schedule.booking_id,
         schedule.start_at, schedule.end_at, schedule.territory_id,
         schedule.travel_buffer_minutes, schedule.required_crew_size,
         booking.customer_id,
         team.timezone, team.operating_start_time,
         team.latest_arrival_time, team.hard_finish_time,
         team.arrival_window_minutes,
         assessment.assessment_status
    into context
  from public.team_job_allocations allocation
  join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
  join public.bookings booking on booking.id = schedule.booking_id
  join public.cleaning_teams team
    on team.organization_id = allocation.organization_id
   and team.id = allocation.team_id
  left join public.service_location_assessments assessment
    on assessment.booking_id = booking.id
  where allocation.id = new.team_job_allocation_id
  for share of team;

  if context is null
    or context.organization_id <> new.organization_id
    or context.team_id <> new.team_id
    or context.job_schedule_id <> new.job_schedule_id
    or context.customer_id is null
    or context.customer_id <> new.customer_id then
    raise exception 'Schedule proposal scope does not match the allocated customer job';
  end if;
  if new.service_case_id is not null and not exists (
    select 1
    from public.service_cases service_case
    where service_case.id = new.service_case_id
      and service_case.booking_id = context.booking_id
      and service_case.case_type = 'reschedule'
      and (
        new.status in ('withdrawn', 'superseded', 'expired')
        or service_case.status in ('action_planned', 'awaiting_customer')
      )
  ) then
    raise exception 'Reschedule proposal must reference the active case for this booking';
  end if;
  if new.service_case_id is null
    and new.status in ('draft', 'pending_customer', 'approved', 'changes_requested')
    and exists (
      select 1
      from public.service_cases service_case
      where service_case.booking_id = context.booking_id
        and service_case.case_type = 'reschedule'
        and service_case.status not in ('resolved', 'closed', 'declined', 'canceled')
    ) then
    raise exception 'An active reschedule case requires a linked replacement proposal';
  end if;
  if (new.service_case_id is null and new.proposed_start_at is not null)
    or (new.service_case_id is not null and new.proposed_start_at is null) then
    raise exception 'Only a linked reschedule case may carry proposed replacement timing';
  end if;
  if tg_op = 'INSERT'
    and new.status in ('withdrawn', 'superseded', 'expired') then
    raise exception 'Schedule proposals cannot begin in a terminal state'
      using errcode = '23514';
  end if;
  -- Terminal cleanup must remain possible after route or crew evidence becomes
  -- stale. The dedicated lifecycle trigger has already frozen every term and
  -- constrained the active-to-terminal transition.
  if tg_op = 'UPDATE'
    and new.status in ('withdrawn', 'superseded', 'expired') then
    return new;
  end if;
  if context.assessment_status is null
    or context.assessment_status not in ('inside_standard_radius', 'approved_exception') then
    raise exception 'Route assessment must be approved before proposing a schedule';
  end if;
  if not private.has_complete_current_team_crew(
    new.job_schedule_id, new.organization_id, new.team_id,
    context.required_crew_size
  ) then
    raise exception 'A complete active branch crew is required before proposing a schedule';
  end if;
  effective_start := coalesce(new.proposed_start_at, context.start_at);
  effective_end := coalesce(new.proposed_end_at, context.end_at);
  if effective_start <= clock_timestamp() then
    raise exception 'An active schedule proposal must begin in the future'
      using errcode = '22007';
  end if;
  -- Re-run the authoritative capacity boundary for the replacement interval,
  -- not merely the schedule's current interval. The capacity function takes a
  -- per-cleaner transaction lock. While that lock is held, the additional
  -- proposal query below also treats every live customer offer as a reserved
  -- interval, preventing two jobs from offering the same cleaner twice.
  for crew_cleaner_id in
    select distinct assignment.cleaner_id
    from public.job_assignments assignment
    join public.workforce_memberships membership
      on membership.organization_id = context.organization_id
     and membership.team_id = context.team_id
     and membership.cleaner_id = assignment.cleaner_id
     and membership.status = 'active'
     and membership.role in ('cleaner', 'shift_lead')
    where assignment.job_schedule_id = new.job_schedule_id
      and assignment.team_id = context.team_id
      and assignment.status in ('accepted', 'confirmed')
    order by assignment.cleaner_id
  loop
    perform public.assert_cleaner_schedule_capacity(
      crew_cleaner_id, new.job_schedule_id, effective_start, effective_end,
      context.territory_id, context.travel_buffer_minutes
    );
    if exists (
      select 1
      from public.job_assignments other_assignment
      join public.job_schedules other_schedule
        on other_schedule.id = other_assignment.job_schedule_id
      join public.schedule_proposals other_proposal
        on other_proposal.job_schedule_id = other_schedule.id
       and other_proposal.status in (
         'draft', 'pending_customer', 'approved', 'changes_requested'
       )
       and (other_proposal.expires_at is null
         or other_proposal.expires_at > clock_timestamp())
      where other_assignment.cleaner_id = crew_cleaner_id
        and other_assignment.status in ('accepted', 'confirmed')
        and other_schedule.id <> new.job_schedule_id
        and other_schedule.status not in ('completed', 'canceled')
        and coalesce(other_proposal.proposed_start_at, other_schedule.start_at)
          < effective_end + make_interval(mins => context.travel_buffer_minutes)
        and coalesce(other_proposal.proposed_end_at, other_schedule.end_at)
          + make_interval(mins => other_schedule.travel_buffer_minutes)
          > effective_start
    ) then
      raise exception
        'Cleaner % has an overlapping active customer proposal or travel buffer',
        crew_cleaner_id using errcode = '23P01';
    end if;
  end loop;
  local_start := effective_start at time zone context.timezone;
  local_end := effective_end at time zone context.timezone;
  if effective_start < new.arrival_window_start
    or effective_start > new.arrival_window_end
    or (
      effective_start = new.arrival_window_end
      and local_start::time <> context.latest_arrival_time
    ) then
    raise exception 'Planned arrival must fall inside the proposed customer window';
  end if;
  if extract(epoch from (new.arrival_window_end - new.arrival_window_start)) / 60
    <> context.arrival_window_minutes then
    raise exception 'Proposal window must match the branch arrival-window duration';
  end if;
  if local_start::date <> local_end::date
    or local_start::time < context.operating_start_time
    or local_start::time > context.latest_arrival_time
    or local_end::time > context.hard_finish_time then
    raise exception 'Proposed work violates the branch operating-hour caps';
  end if;
  if new.expires_at is not null and new.expires_at <= now()
    and new.status in ('draft', 'pending_customer', 'approved', 'changes_requested') then
    raise exception 'Schedule proposal expiry must be in the future';
  end if;
  if new.status = 'approved'
    and private.current_customer_id() is distinct from new.customer_id then
    raise exception 'Only the linked customer may approve a schedule proposal'
      using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger schedule_proposals_scope_guard
  before insert or update on schedule_proposals for each row
  execute function private.validate_schedule_proposal();

create function private.guard_customer_schedule_response() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.organization_id <> old.organization_id
    or new.team_id <> old.team_id
    or new.team_job_allocation_id <> old.team_job_allocation_id
    or new.job_schedule_id <> old.job_schedule_id
    or new.service_case_id is distinct from old.service_case_id
    or new.proposed_start_at is distinct from old.proposed_start_at
    or new.proposed_end_at is distinct from old.proposed_end_at
    or new.customer_id <> old.customer_id
    or new.arrival_window_start <> old.arrival_window_start
    or new.arrival_window_end <> old.arrival_window_end
    or new.version <> old.version
    or new.proposed_by_membership_id <> old.proposed_by_membership_id
    or new.proposal_note is distinct from old.proposal_note
    or new.expires_at is distinct from old.expires_at
    or new.is_dev_seed <> old.is_dev_seed
    or new.created_at <> old.created_at then
    raise exception 'Schedule proposal terms and identity are immutable after creation'
      using errcode = '55000';
  end if;

  if pg_trigger_depth() > 1
    and old.status in ('draft', 'pending_customer', 'approved', 'changes_requested')
    and new.status = 'superseded'
    and new.customer_response_note is not distinct from old.customer_response_note
    and new.responded_at is not distinct from old.responded_at then
    return new;
  end if;

  if private.current_customer_id() = old.customer_id
    and private.current_cleaner_id() is null then
    if old.status <> 'pending_customer'
      or new.status not in ('approved', 'changes_requested') then
      raise exception 'Customer response may only approve or request changes to the current proposal';
    end if;
    new.responded_at := now();
    return new;
  end if;

  if private.current_cleaner_id() is not null
    or private.current_customer_id() = old.customer_id
    or old.status not in ('draft', 'pending_customer', 'approved', 'changes_requested')
    or new.status not in ('withdrawn', 'superseded', 'expired')
    or new.customer_response_note is distinct from old.customer_response_note
    or new.responded_at is distinct from old.responded_at then
    raise exception 'Only staff may close an active schedule proposal without changing its terms'
      using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger schedule_proposals_customer_response_guard
  before update on schedule_proposals for each row
  execute function private.guard_customer_schedule_response();

create function private.invalidate_stale_approvals_for_reschedule_case()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.booking_id is null or new.case_type <> 'reschedule'
    or new.status in ('resolved', 'closed', 'declined', 'canceled') then
    return new;
  end if;
  if tg_op = 'UPDATE'
    and new.booking_id is not distinct from old.booking_id
    and new.case_type is not distinct from old.case_type
    and new.status is not distinct from old.status then
    return new;
  end if;

  perform 1
  from public.job_schedules schedule
  where schedule.booking_id = new.booking_id
  order by schedule.id
  for update;

  update public.schedule_proposals proposal
  set status = 'superseded', updated_at = now()
  from public.job_schedules schedule
  where proposal.job_schedule_id = schedule.id
    and schedule.booking_id = new.booking_id
    and schedule.status in ('tentative', 'held')
    and proposal.service_case_id is distinct from new.id
    and proposal.status in ('draft', 'pending_customer', 'approved', 'changes_requested');
  return new;
end
$$;
create trigger service_cases_reschedule_approval_invalidation
  after insert or update on service_cases for each row
  execute function private.invalidate_stale_approvals_for_reschedule_case();

create function private.require_approved_schedule_proposal() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  context record;
  timing_changed boolean;
  has_window_evidence boolean;
  local_start timestamp;
  local_end timestamp;
begin
  timing_changed := tg_op = 'UPDATE' and (
    old.start_at is distinct from new.start_at
    or old.end_at is distinct from new.end_at
  );
  if tg_op = 'INSERT' and new.start_at <= clock_timestamp() then
    raise exception 'A new schedule must begin in the future'
      using errcode = '22007';
  end if;
  if timing_changed and new.start_at <= clock_timestamp() then
    raise exception 'A retimed schedule must begin in the future'
      using errcode = '22007';
  end if;

  select allocation.organization_id, allocation.team_id,
         team.timezone, team.operating_start_time,
         team.latest_arrival_time, team.hard_finish_time,
         assessment.assessment_status
    into context
  from public.team_job_allocations allocation
  join public.cleaning_teams team
    on team.organization_id = allocation.organization_id
   and team.id = allocation.team_id
  left join public.service_location_assessments assessment
    on assessment.booking_id = new.booking_id
  where allocation.job_schedule_id = new.id
  for share of team;

  if context is null then
    if new.status in ('confirmed', 'en_route', 'in_progress', 'quality_review', 'completed') then
      raise exception 'A team allocation is required before work may be confirmed or executed';
    end if;
    return new;
  end if;

  local_start := new.start_at at time zone context.timezone;
  local_end := new.end_at at time zone context.timezone;
  if local_start::date <> local_end::date
    or local_start::time < context.operating_start_time
    or local_start::time > context.latest_arrival_time
    or local_end::time > context.hard_finish_time then
    raise exception 'Allocated schedule violates the branch operating-hour caps';
  end if;

  if (
      new.status = 'confirmed'
      or (tg_op = 'UPDATE' and old.status = 'confirmed' and new.status = 'en_route')
    ) and not private.has_complete_current_team_crew(
      new.id, context.organization_id, context.team_id, new.required_crew_size
    ) then
    raise exception 'A complete active branch crew is required before confirmation or dispatch';
  end if;

  if timing_changed and new.status not in ('tentative', 'held', 'confirmed') then
    raise exception 'Dispatched or completed work cannot be retimed; create a reviewed recovery record';
  end if;
  if timing_changed and old.start_at <= now() then
    raise exception 'Work at or past its planned start cannot be retimed; create a reviewed recovery record';
  end if;
  if timing_changed and old.status = 'confirmed' and not exists (
    select 1
    from public.schedule_proposals proposal
    where proposal.job_schedule_id = new.id
      and proposal.service_case_id is not null
      and proposal.status = 'approved'
      and (proposal.expires_at is null or proposal.expires_at > now())
      and proposal.proposed_start_at = new.start_at
      and proposal.proposed_end_at = new.end_at
      and not exists (
        select 1 from public.service_cases active_case
        where active_case.booking_id = new.booking_id
          and active_case.case_type = 'reschedule'
          and active_case.status not in ('resolved', 'closed', 'declined', 'canceled')
          and active_case.id is distinct from proposal.service_case_id
      )
  ) then
    raise exception 'Confirmed work may only be retimed to the exact customer-approved recovery proposal';
  end if;

  if new.status = 'confirmed'
    and (tg_op = 'INSERT' or old.status <> 'confirmed')
    and (
      private.current_cleaner_id() is not null
      or (
        private.current_customer_id() is not null
        and not private.can_access_team(
          context.organization_id, context.team_id, array['owner','gm','manager']
        )
      )
    ) then
    raise exception 'Manager schedule-approval authority is required for confirmation'
      using errcode = '42501';
  end if;

  if timing_changed then
    update public.schedule_proposals proposal
    set status = 'superseded', updated_at = now()
    where proposal.job_schedule_id = new.id
      and proposal.status in ('draft', 'pending_customer', 'approved', 'changes_requested')
      and not (
        (
          proposal.service_case_id is not null
          and proposal.proposed_start_at = new.start_at
          and proposal.proposed_end_at = new.end_at
        )
        or (
          proposal.service_case_id is null
          and new.start_at >= proposal.arrival_window_start
          and (
            new.start_at < proposal.arrival_window_end
            or (
              new.start_at = proposal.arrival_window_end
              and (new.start_at at time zone context.timezone)::time
                = context.latest_arrival_time
            )
          )
        )
      );
  end if;

  has_window_evidence := exists (
        select 1 from public.schedule_proposals proposal
        where proposal.job_schedule_id = new.id
          and proposal.status = 'approved'
          and (
            not exists (
              select 1 from public.service_cases active_case
              where active_case.booking_id = new.booking_id
                and active_case.case_type = 'reschedule'
                and active_case.status not in (
                  'resolved', 'closed', 'declined', 'canceled'
                )
                and active_case.id is distinct from proposal.service_case_id
            )
            or (
              tg_op = 'UPDATE' and not timing_changed
              and old.status in ('confirmed', 'en_route', 'in_progress', 'quality_review')
            )
          )
          and (
            proposal.expires_at is null
            or proposal.expires_at > now()
            or (
              tg_op = 'UPDATE' and not timing_changed
              and old.status in ('confirmed', 'en_route', 'in_progress', 'quality_review')
            )
          )
          and (
            (
              proposal.service_case_id is not null
              and proposal.proposed_start_at = new.start_at
              and proposal.proposed_end_at = new.end_at
            )
            or (
              proposal.service_case_id is null
              and new.start_at >= proposal.arrival_window_start
              and (
                new.start_at < proposal.arrival_window_end
                or (
                  new.start_at = proposal.arrival_window_end
                  and (new.start_at at time zone context.timezone)::time
                    = context.latest_arrival_time
                )
              )
            )
          )
      );
  if not has_window_evidence and tg_op = 'UPDATE' and not timing_changed then
    has_window_evidence := exists (
      select 1
      from private.legacy_field_execution_continuity legacy
      where legacy.job_schedule_id = new.id
        and legacy.original_start_at = new.start_at
        and legacy.original_end_at = new.end_at
        and (
          (old.status = 'en_route' and new.status = 'in_progress')
          or (old.status = 'in_progress' and new.status = 'quality_review')
          or (old.status = 'quality_review' and new.status = 'completed')
          or old.status = new.status
        )
    );
  end if;

  if new.status in ('confirmed', 'en_route', 'in_progress', 'quality_review', 'completed')
    and (
      context.assessment_status not in ('inside_standard_radius', 'approved_exception')
      or not has_window_evidence
    ) then
    raise exception 'Current route and customer window approval are required for this schedule state';
  end if;
  return new;
end
$$;
create trigger job_schedules_customer_approval_guard
  before insert or update of status, start_at, end_at on job_schedules for each row
  execute function private.require_approved_schedule_proposal();

create function private.guard_schedule_execution_clock() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  approved_window_start timestamptz;
begin
  if not (
    (old.status = 'confirmed' and new.status = 'en_route')
    or (old.status = 'en_route' and new.status = 'in_progress')
  ) then
    return new;
  end if;

  select proposal.arrival_window_start
    into approved_window_start
  from public.schedule_proposals proposal
  where proposal.job_schedule_id = new.id
    and proposal.status = 'approved'
    and new.start_at >= proposal.arrival_window_start
    and new.start_at <= proposal.arrival_window_end
  order by proposal.version desc, proposal.created_at desc
  limit 1;
  approved_window_start := coalesce(approved_window_start, new.start_at);

  if old.status = 'confirmed'
    and clock_timestamp() < approved_window_start
      - make_interval(mins => new.travel_buffer_minutes) then
    raise exception 'Dispatch cannot begin before the approved arrival window travel buffer'
      using errcode = '55000';
  end if;
  if old.status = 'en_route'
    and clock_timestamp() < approved_window_start then
    raise exception 'Service cannot begin before the customer-approved arrival window'
      using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger job_schedules_execution_clock_guard
  before update of status on job_schedules for each row
  execute function private.guard_schedule_execution_clock();

create function private.guard_job_schedule_actor_and_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if not private.current_staff_can_plan_territory(new.territory_id)
      or new.status <> 'tentative'
      or new.version <> 1 then
      raise exception 'Schedule creation requires authorized staff and a tentative version-one plan'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- Internal readiness checks intentionally issue a no-op parent update.
  if pg_trigger_depth() > 1
    and new.id = old.id
    and new.booking_id = old.booking_id
    and new.territory_id = old.territory_id
    and new.service_vertical = old.service_vertical
    and new.start_at = old.start_at and new.end_at = old.end_at
    and new.status = old.status
    and new.required_crew_size = old.required_crew_size
    and new.required_skills is not distinct from old.required_skills
    and new.labor_minutes = old.labor_minutes
    and new.travel_buffer_minutes = old.travel_buffer_minutes
    and new.version = old.version
    and new.created_by_label = old.created_by_label
    and new.is_dev_seed = old.is_dev_seed
    and new.created_at = old.created_at then
    return new;
  end if;

  -- Membership reconciliation may safely return confirmed work to held.
  if pg_trigger_depth() > 1
    and old.status = 'confirmed' and new.status = 'held'
    and new.version = old.version + 1
    and new.id = old.id and new.booking_id = old.booking_id
    and new.territory_id = old.territory_id
    and new.service_vertical = old.service_vertical
    and new.start_at = old.start_at and new.end_at = old.end_at
    and new.required_crew_size = old.required_crew_size
    and new.required_skills is not distinct from old.required_skills
    and new.labor_minutes = old.labor_minutes
    and new.travel_buffer_minutes = old.travel_buffer_minutes
    and new.created_by_label = old.created_by_label
    and new.is_dev_seed = old.is_dev_seed
    and new.created_at = old.created_at then
    return new;
  end if;

  if not private.current_staff_can_manage_job_schedule(old.id) then
    raise exception 'Customers and cleaners have read-only schedule access'
      using errcode = '42501';
  end if;
  if new.id <> old.id
    or new.booking_id <> old.booking_id
    or new.created_by_label <> old.created_by_label
    or new.is_dev_seed <> old.is_dev_seed
    or new.created_at <> old.created_at then
    raise exception 'Schedule identity and creation evidence are immutable'
      using errcode = '55000';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'Schedule updates require the next version'
      using errcode = '55000';
  end if;
  if new.territory_id <> old.territory_id
    and not private.current_staff_can_plan_territory(new.territory_id) then
    raise exception 'Schedule territory must remain in the actor''s covered planning queue'
      using errcode = '42501';
  end if;
  if new.status is distinct from old.status
    and (
      new.status in ('confirmed', 'canceled')
      or (old.status = 'confirmed' and new.status = 'held')
    )
    and not private.current_manager_can_manage_job_schedule(old.id) then
    raise exception 'Schedule confirmation, cancellation, and approval rollback require a manager'
      using errcode = '42501';
  end if;
  if old.status = 'confirmed'
    and new.status = 'confirmed'
    and (new.start_at is distinct from old.start_at
      or new.end_at is distinct from old.end_at)
    and not private.current_manager_can_manage_job_schedule(old.id) then
    raise exception 'Applying an approved confirmed-job reschedule requires a manager'
      using errcode = '42501';
  end if;
  if old.status in ('confirmed','en_route','in_progress','quality_review','completed','canceled')
    and (
      new.territory_id <> old.territory_id
      or new.service_vertical <> old.service_vertical
      or new.required_crew_size <> old.required_crew_size
      or new.required_skills is distinct from old.required_skills
      or new.labor_minutes <> old.labor_minutes
      or new.travel_buffer_minutes <> old.travel_buffer_minutes
      or ((new.start_at <> old.start_at or new.end_at <> old.end_at)
        and not (old.status = 'confirmed' and new.status = 'confirmed'))
    ) then
    raise exception 'Confirmed schedule plan fields are immutable outside an approved reschedule'
      using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger job_schedules_actor_evidence_guard
  before insert or update on job_schedules for each row
  execute function private.guard_job_schedule_actor_and_evidence();

create function private.guard_schedule_checklist_closeout() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  legacy_terminal_closeout boolean := false;
begin
  if old.status = 'in_progress' and new.status = 'quality_review' then
    -- A schedule that was already in progress when this migration landed can
    -- have truthful terminal checklist state without the new actor/timestamp
    -- columns. Preserve only that exact frozen schedule/allocation snapshot;
    -- every post-migration execution still needs full audited evidence.
    legacy_terminal_closeout := exists (
      select 1
      from private.legacy_field_execution_continuity legacy
      join public.team_job_allocations allocation
        on allocation.id = legacy.team_job_allocation_id
       and allocation.organization_id = legacy.organization_id
       and allocation.team_id = legacy.team_id
       and allocation.job_schedule_id = legacy.job_schedule_id
      where legacy.job_schedule_id = new.id
        and legacy.original_status = 'in_progress'
        and legacy.original_start_at = old.start_at
        and legacy.original_end_at = old.end_at
        and new.start_at = legacy.original_start_at
        and new.end_at = legacy.original_end_at
        and exists (
          select 1
          from public.checklist_items item
          where item.team_job_allocation_id = allocation.id
        )
        and not exists (
          select 1
          from public.checklist_items item
          where item.team_job_allocation_id = allocation.id
            and item.state not in ('completed', 'skipped')
        )
    );

    if not legacy_terminal_closeout
    and (
      not exists (
        select 1
        from public.team_job_allocations allocation
        join public.checklist_items item
          on item.team_job_allocation_id = allocation.id
        where allocation.job_schedule_id = new.id
      )
      or exists (
        select 1
        from public.team_job_allocations allocation
        join public.checklist_items item
          on item.team_job_allocation_id = allocation.id
        where allocation.job_schedule_id = new.id
          and (
            item.state not in ('completed', 'skipped')
            or item.completed_at is null
            or item.completed_by_membership_id is null
            or (item.state = 'skipped'
              and char_length(trim(coalesce(item.completion_note, ''))) < 2)
          )
      )
    ) then
      raise exception 'Quality review requires at least one field checklist item and audited completion evidence for every item'
        using errcode = '55000';
    end if;
  end if;
  return new;
end
$$;
create trigger job_schedules_field_checklist_closeout_guard
  before update of status on job_schedules for each row
  execute function private.guard_schedule_checklist_closeout();

create function private.guard_customer_cleaner_preference() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (
    new.id <> old.id
    or new.organization_id <> old.organization_id
    or new.team_id <> old.team_id
    or new.customer_id <> old.customer_id
    or new.cleaner_id <> old.cleaner_id
    or new.is_dev_seed <> old.is_dev_seed
    or new.created_at <> old.created_at
  ) then
    raise exception 'Cleaner preference identity is immutable'
      using errcode = '55000';
  end if;
  perform private.lock_customer_team_cleaner_preference(
    new.organization_id, new.team_id, new.customer_id, new.cleaner_id
  );
  if not exists (
    select 1
    from public.team_job_allocations allocation
    join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
    join public.bookings booking on booking.id = schedule.booking_id
    join public.job_assignments assignment
      on assignment.job_schedule_id = schedule.id
     and assignment.team_id = allocation.team_id
     and assignment.cleaner_id = new.cleaner_id
     and assignment.status in ('accepted', 'confirmed')
    where allocation.id = new.source_allocation_id
      and allocation.organization_id = new.organization_id
      and allocation.team_id = new.team_id
      and booking.customer_id = new.customer_id
      and schedule.status = 'completed'
  ) then
    raise exception 'Cleaner preference requires a completed verified shared service job';
  end if;
  if new.active and new.preference = 'avoid' and exists (
    select 1
    from public.team_job_allocations allocation
    join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
    join public.bookings booking on booking.id = schedule.booking_id
    join public.job_assignments assignment
      on assignment.job_schedule_id = schedule.id
     and assignment.team_id = allocation.team_id
     and assignment.cleaner_id = new.cleaner_id
     and assignment.status in ('proposed', 'accepted', 'confirmed')
    where allocation.organization_id = new.organization_id
      and allocation.team_id = new.team_id
      and booking.customer_id = new.customer_id
      and schedule.status in (
        'tentative', 'held', 'confirmed', 'en_route', 'in_progress', 'quality_review'
      )
  ) then
    raise exception 'Reassign active work before saving a do-not-schedule preference'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger customer_cleaner_preferences_scope_guard
  before insert or update on customer_cleaner_preferences for each row
  execute function private.guard_customer_cleaner_preference();

create function private.guard_avoided_cleaner_assignment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  preference_scope record;
begin
  if new.status in ('proposed', 'accepted', 'confirmed') then
    select allocation.organization_id, booking.customer_id
      into preference_scope
    from public.job_schedules schedule
    join public.bookings booking on booking.id = schedule.booking_id
    join public.team_job_allocations allocation
      on allocation.job_schedule_id = schedule.id
     and allocation.team_id = new.team_id
    where schedule.id = new.job_schedule_id
    limit 1;
    if preference_scope is not null and preference_scope.customer_id is not null then
      perform private.lock_customer_team_cleaner_preference(
        preference_scope.organization_id, new.team_id,
        preference_scope.customer_id, new.cleaner_id
      );
    end if;
  end if;
  if new.status in ('proposed', 'accepted', 'confirmed') and exists (
    select 1
    from public.job_schedules schedule
    join public.bookings booking on booking.id = schedule.booking_id
    join public.team_job_allocations allocation
      on allocation.job_schedule_id = schedule.id
     and allocation.team_id = new.team_id
    join public.customer_cleaner_preferences preference
      on preference.organization_id = allocation.organization_id
     and preference.team_id = allocation.team_id
     and preference.customer_id = booking.customer_id
     and preference.cleaner_id = new.cleaner_id
     and preference.active
     and preference.preference = 'avoid'
    where schedule.id = new.job_schedule_id
  ) then
    raise exception 'Customer marked this cleaner do-not-schedule for the assigned team'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger job_assignments_customer_avoid_guard
  before insert or update of team_id, cleaner_id, status
  on job_assignments for each row
  execute function private.guard_avoided_cleaner_assignment();

create function private.guard_assignment_current_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  eligible_membership_id uuid;
begin
  if new.status not in ('proposed', 'accepted', 'confirmed') or new.team_id is null then
    return new;
  end if;
  select membership.id into eligible_membership_id
  from public.team_job_allocations allocation
  join public.workforce_memberships membership
    on membership.organization_id = allocation.organization_id
   and membership.team_id = allocation.team_id
   and membership.cleaner_id = new.cleaner_id
   and membership.status = 'active'
   and membership.role in ('cleaner', 'shift_lead')
  where allocation.job_schedule_id = new.job_schedule_id
    and allocation.team_id = new.team_id
  order by membership.id
  limit 1
  for share of membership;
  if eligible_membership_id is null and exists (
    select 1 from public.team_job_allocations allocation
    where allocation.job_schedule_id = new.job_schedule_id
      and allocation.team_id = new.team_id
  ) then
    raise exception 'Active assignment requires a current cleaner membership in the allocated team'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger job_assignments_current_membership_guard
  before insert or update of team_id, cleaner_id, status
  on job_assignments for each row
  execute function private.guard_assignment_current_membership();

create function private.guard_field_subject_memberships() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  subject_valid boolean;
begin
  if tg_table_name = 'mileage_entries' then
    perform membership.id
    from public.workforce_memberships membership
    where membership.id = new.workforce_membership_id
      and membership.organization_id = new.organization_id
      and membership.team_id = new.team_id
      and membership.cleaner_id = new.cleaner_id
      and membership.status = 'active'
      and membership.role in ('cleaner','shift_lead')
    for share;
    subject_valid := found;
  elsif tg_table_name = 'job_issue_reports' then
    perform membership.id
    from public.workforce_memberships membership
    where membership.id = new.reported_by_membership_id
      and membership.organization_id = new.organization_id
      and membership.team_id = new.team_id
      and membership.cleaner_id is not distinct from new.reported_by_cleaner_id
      and membership.status = 'active'
    for share;
    subject_valid := found;
  elsif tg_table_name = 'team_duty_assignments' then
    perform membership.id
    from public.workforce_memberships membership
    where membership.id = new.workforce_membership_id
      and membership.organization_id = new.organization_id
      and membership.status = 'active'
      and (
        (new.duty_kind = 'manager_on_duty' and membership.role in ('owner','gm','manager'))
        or (new.duty_kind = 'shift_lead_on_duty'
          and membership.role in ('owner','gm','manager','shift_lead'))
      )
      and (membership.team_id = new.team_id
        or (membership.team_id is null and membership.role in ('owner','gm')))
    for share;
    subject_valid := found;
  else
    subject_valid := false;
  end if;
  if not coalesce(subject_valid, false) then
    raise exception 'Field operation subject must be an active member of the same team';
  end if;
  return new;
end
$$;
create trigger mileage_entries_subject_scope_guard
  before insert or update of organization_id, team_id, workforce_membership_id,
    cleaner_id
  on mileage_entries for each row execute function private.guard_field_subject_memberships();
create trigger job_issue_reports_subject_scope_guard
  before insert or update of organization_id, team_id, reported_by_membership_id,
    reported_by_cleaner_id
  on job_issue_reports for each row execute function private.guard_field_subject_memberships();
create trigger team_duty_assignments_subject_scope_guard
  before insert or update of organization_id, team_id, workforce_membership_id,
    duty_kind
  on team_duty_assignments for each row execute function private.guard_field_subject_memberships();

create trigger service_location_assessments_override_scope_guard
  before insert or update of override_by_membership_id
  on service_location_assessments for each row
  execute function validate_scoped_actor_membership('override_by_membership_id');
create trigger schedule_proposals_actor_scope_guard
  before insert or update of proposed_by_membership_id
  on schedule_proposals for each row
  execute function validate_scoped_actor_membership('proposed_by_membership_id');
create trigger job_communications_actor_scope_guard
  before insert or update of sender_membership_id
  on job_communications for each row
  execute function validate_scoped_actor_membership('sender_membership_id');
create trigger mileage_entries_reviewer_scope_guard
  before insert or update of reviewed_by_membership_id
  on mileage_entries for each row
  execute function validate_scoped_actor_membership('reviewed_by_membership_id');
create trigger job_issue_reports_assignee_scope_guard
  before insert or update of assigned_to_membership_id
  on job_issue_reports for each row
  execute function validate_scoped_actor_membership('assigned_to_membership_id');

create function private.guard_quality_review_actor() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1
    from public.team_job_allocations allocation
    join public.job_assignments assignment
      on assignment.job_schedule_id = allocation.job_schedule_id
     and assignment.team_id = allocation.team_id
     and assignment.cleaner_id = new.cleaner_id
     and assignment.status in ('accepted', 'confirmed')
    where allocation.id = new.team_job_allocation_id
      and allocation.organization_id = new.organization_id
      and allocation.team_id = new.team_id
  ) then
    raise exception 'Quality review cleaner must belong to the allocated team crew'
      using errcode = '23514';
  end if;
  if private.current_customer_id() is not null
    and private.current_cleaner_id() is not null then
    raise exception 'Quality review requires exactly one actor'
      using errcode = '42501';
  end if;

  if new.source = 'verified_customer'
    and new.customer_id = private.current_customer_id()
    and new.created_by_membership_id is null
    and private.current_cleaner_id() is null then
    new.verified_at := now();
    new.evidence_reference := 'customer:' || new.customer_id::text
      || ':allocation:' || new.team_job_allocation_id::text;
    return new;
  end if;

  if private.current_customer_id() is null
    or private.current_cleaner_id() is not null
    or not private.is_current_membership(new.created_by_membership_id) then
    raise exception 'Staff quality review requires its current actor membership'
      using errcode = '42501';
  end if;
  if new.source = 'verified_customer' then
    raise exception 'Verified customer reviews must be submitted by the linked customer'
      using errcode = '42501';
  elsif new.customer_id is not null or new.verified_at is not null then
    raise exception 'Internal quality evidence cannot impersonate a customer review'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger quality_reviews_customer_actor_guard
  before insert on quality_reviews for each row
  execute function private.guard_quality_review_actor();

create function private.guard_job_issue_lifecycle() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'open'
      or new.resolution_note is not null
      or new.resolved_at is not null
      or new.version <> 1 then
      raise exception 'A field issue must begin as an unresolved open report'
        using errcode = '23514';
    end if;
    if private.current_cleaner_id() is not null
      and (new.assigned_to_membership_id is not null or new.customer_visible) then
      raise exception 'A cleaner cannot assign or publish their own field escalation'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if new.organization_id <> old.organization_id
    or new.team_id <> old.team_id
    or new.team_job_allocation_id is distinct from old.team_job_allocation_id
    or new.reported_by_membership_id <> old.reported_by_membership_id
    or new.reported_by_cleaner_id is distinct from old.reported_by_cleaner_id
    or new.issue_type <> old.issue_type
    or new.severity <> old.severity
    or new.summary <> old.summary
    or new.private_details is distinct from old.private_details
    or new.is_dev_seed <> old.is_dev_seed
    or new.created_at is distinct from old.created_at then
    raise exception 'Original field issue report evidence is immutable'
      using errcode = '55000';
  end if;
  if old.status in ('resolved', 'dismissed') then
    raise exception 'Closed issue evidence is immutable; create a new linked issue for follow-up'
      using errcode = '55000';
  end if;
  if old.status = 'acknowledged' and new.status = 'open' then
    raise exception 'An acknowledged issue cannot return to open'
      using errcode = '55000';
  end if;
  if new.status in ('resolved', 'dismissed') and (
    new.resolved_at is null
    or new.resolution_note is null
    or char_length(new.resolution_note) < 2
  ) then
    raise exception 'Closing an issue requires immutable resolution evidence';
  end if;
  if new.status not in ('resolved', 'dismissed') and new.resolved_at is not null then
    raise exception 'Only a closed issue may carry a resolution timestamp';
  end if;
  if private.current_cleaner_id() = old.reported_by_cleaner_id
    and (
      new.customer_visible is distinct from old.customer_visible
      or new.assigned_to_membership_id is distinct from old.assigned_to_membership_id
      or new.resolution_note is distinct from old.resolution_note
      or new.resolved_at is distinct from old.resolved_at
    ) then
    raise exception 'A cleaner cannot assign or resolve their own field escalation'
      using errcode = '42501';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'Issue decisions require the next optimistic-lock version'
      using errcode = '40001';
  end if;
  return new;
end
$$;
create trigger job_issue_reports_lifecycle_guard
  before insert or update on job_issue_reports for each row
  execute function private.guard_job_issue_lifecycle();
create trigger team_duty_assignments_creator_scope_guard
  before insert or update of created_by_membership_id
  on team_duty_assignments for each row
  execute function validate_scoped_actor_membership('created_by_membership_id');
create trigger tip_intents_recorder_scope_guard
  before insert or update of recorded_by_membership_id
  on tip_intents for each row
  execute function validate_scoped_actor_membership('recorded_by_membership_id');

create function private.guard_job_communication_actor() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  communication_context record;
  expected_template_body text;
begin
  select schedule.status as schedule_status, schedule.start_at, schedule.end_at,
         nullif(split_part(trim(coalesce(booking.contact ->> 'name', '')), ' ', 1), '')
           as customer_first_name
    into communication_context
  from public.team_job_allocations allocation
  join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
  join public.bookings booking on booking.id = schedule.booking_id
  where allocation.id = new.team_job_allocation_id
    and allocation.organization_id = new.organization_id
    and allocation.team_id = new.team_id
    and booking.customer_id = new.customer_id
  for share of schedule;
  if not found then
    raise exception 'Communication customer and team must match the allocated booking'
      using errcode = '23514';
  end if;
  if new.sender_kind = 'customer' then
    if new.sender_customer_id is distinct from private.current_customer_id()
      or new.customer_id is distinct from private.current_customer_id()
      or private.current_cleaner_id() is not null
      or new.sender_membership_id is not null
      or new.sender_cleaner_id is not null
      or new.audience not in ('assigned_crew', 'team_operations')
      or new.template_key is distinct from 'custom'
      or new.channel <> 'in_app'
      or new.delivery_status <> 'recorded'
      or new.provider_message_id is not null
      or new.delivery_error is not null then
      raise exception 'Customer communication actor is invalid' using errcode = '42501';
    end if;
    if new.audience = 'assigned_crew' and not exists (
      select 1
      from public.team_job_allocations allocation
      join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
      join public.job_assignments assignment
        on assignment.job_schedule_id = schedule.id
       and assignment.team_id = allocation.team_id
       and assignment.status in ('accepted', 'confirmed')
      join public.workforce_memberships membership
        on membership.organization_id = allocation.organization_id
       and membership.team_id = allocation.team_id
       and membership.cleaner_id = assignment.cleaner_id
       and membership.status = 'active'
       and membership.role in ('cleaner', 'shift_lead')
      where allocation.id = new.team_job_allocation_id
        and schedule.status in (
          'confirmed', 'en_route', 'in_progress', 'quality_review'
        )
    ) then
      raise exception 'Assigned-crew messaging requires live work and a current crew'
        using errcode = '55000';
    end if;
  elsif new.sender_kind = 'cleaner' then
    if new.sender_cleaner_id is distinct from private.current_cleaner_id()
      or private.current_customer_id() is not null
      or not private.is_current_membership(new.sender_membership_id)
      or new.sender_customer_id is not null
      or new.audience not in ('customer', 'team_operations')
      or not private.cleaner_assigned_to_allocation(new.team_job_allocation_id)
      or coalesce(new.template_key, '')
        not in ('custom', 'running_15_late', 'running_30_late')
      or new.channel <> 'in_app'
      or new.delivery_status <> 'recorded'
      or new.provider_message_id is not null
      or new.delivery_error is not null then
      raise exception 'Cleaner communication actor is invalid' using errcode = '42501';
    end if;
    if communication_context.schedule_status not in (
      'confirmed', 'en_route', 'in_progress'
    ) then
      raise exception 'Cleaner customer updates require confirmed or active work'
        using errcode = '55000';
    end if;
    if new.template_key in ('running_15_late', 'running_30_late') then
      if not (
        communication_context.schedule_status in ('en_route', 'in_progress')
        or (
          communication_context.schedule_status = 'confirmed'
          and clock_timestamp() >= communication_context.start_at - interval '1 hour'
          and clock_timestamp() <= communication_context.end_at
        )
      ) then
        raise exception 'Late-arrival templates open only near the approved visit'
          using errcode = '55000';
      end if;
      expected_template_body := case
        when communication_context.customer_first_name is null then 'Hi, '
        else 'Hi ' || communication_context.customer_first_name || ', '
      end || 'your Lake & Pine team is running about '
        || case when new.template_key = 'running_15_late' then '15' else '30' end
        || ' minutes behind. We’ll keep you updated here. Your service scope remains unchanged.';
      if new.body is distinct from expected_template_body then
        raise exception 'Late-arrival template body must match the audited wording'
          using errcode = '23514';
      end if;
    end if;
  elsif new.sender_kind = 'staff' then
    if not private.is_current_membership(new.sender_membership_id)
      or private.current_cleaner_id() is not null
      or new.sender_cleaner_id is not null
      or new.sender_customer_id is not null
      or (new.audience = 'customer'
        and communication_context.schedule_status = 'canceled') then
      raise exception 'Staff communication actor is invalid' using errcode = '42501';
    end if;
  elsif private.current_customer_id() is not null
    or private.current_cleaner_id() is not null
    or new.sender_membership_id is not null
    or new.sender_cleaner_id is not null
    or new.sender_customer_id is not null then
    raise exception 'System communication requires an internal system actor'
      using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger job_communications_actor_guard
  before insert on job_communications for each row
  execute function private.guard_job_communication_actor();

create function private.guard_cleaner_mileage_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  mileage_window record;
  current_team_date date;
begin
  if tg_op = 'INSERT'
    or (tg_op = 'UPDATE'
      and private.current_cleaner_id() = old.cleaner_id
      and private.current_customer_id() is null) then
    if private.current_cleaner_id() is distinct from new.cleaner_id
      or private.current_customer_id() is not null then
      raise exception 'Mileage submission requires exactly its cleaner actor'
        using errcode = '42501';
    end if;
    if new.team_job_allocation_id is not null then
      select (schedule.start_at at time zone team.timezone)::date
               as expected_service_date,
             schedule.start_at
               - make_interval(mins => schedule.travel_buffer_minutes)
               as opens_at,
             schedule.end_at + interval '14 days' as closes_at
        into mileage_window
      from public.team_job_allocations allocation
      join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
      join public.cleaning_teams team
        on team.organization_id = allocation.organization_id
       and team.id = allocation.team_id
      where allocation.id = new.team_job_allocation_id
        and allocation.organization_id = new.organization_id
        and allocation.team_id = new.team_id;
      if not found
        or new.service_date <> mileage_window.expected_service_date
        or clock_timestamp() < mileage_window.opens_at
        or clock_timestamp() > mileage_window.closes_at then
        raise exception 'Linked mileage must match the team-local visit date and submission window'
          using errcode = '55000';
      end if;
    else
      select (clock_timestamp() at time zone team.timezone)::date
        into current_team_date
      from public.cleaning_teams team
      where team.organization_id = new.organization_id and team.id = new.team_id;
      if current_team_date is null
        or new.service_date > current_team_date
        or new.service_date < current_team_date - 31 then
        raise exception 'Unlinked mileage must be from the last 31 team-local days'
          using errcode = '55000';
      end if;
    end if;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'submitted'
      or new.reviewed_by_membership_id is not null
      or new.reviewed_at is not null
      or new.review_note is not null
      or new.version <> 1 then
      raise exception 'Mileage evidence must begin as one unreviewed submission'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if private.current_cleaner_id() = old.cleaner_id
    and private.current_customer_id() is null then
    if old.status <> 'submitted' or new.status <> 'submitted'
      or new.organization_id <> old.organization_id
      or new.team_id <> old.team_id
      or new.workforce_membership_id <> old.workforce_membership_id
      or new.cleaner_id <> old.cleaner_id
      or new.team_job_allocation_id is distinct from old.team_job_allocation_id
      or new.reviewed_by_membership_id is distinct from old.reviewed_by_membership_id
      or new.reviewed_at is distinct from old.reviewed_at
      or new.review_note is distinct from old.review_note
      or new.is_dev_seed <> old.is_dev_seed
      or new.created_at is distinct from old.created_at then
      raise exception 'Cleaner may only revise an unreviewed mileage submission'
        using errcode = '42501';
    end if;
    new.version := old.version + 1;
  elsif private.current_customer_id() is not null
    and private.current_cleaner_id() is null then
    if old.status <> 'submitted'
      or new.status not in ('approved', 'rejected')
      or new.organization_id <> old.organization_id
      or new.team_id <> old.team_id
      or new.workforce_membership_id <> old.workforce_membership_id
      or new.cleaner_id <> old.cleaner_id
      or new.team_job_allocation_id is distinct from old.team_job_allocation_id
      or new.service_date <> old.service_date
      or new.miles <> old.miles
      or new.purpose <> old.purpose
      or new.vehicle_label is distinct from old.vehicle_label
      or new.note is distinct from old.note
      or new.reviewed_by_membership_id is null
      or not private.is_current_membership(new.reviewed_by_membership_id)
      or new.reviewed_at is null
      or new.is_dev_seed <> old.is_dev_seed
      or new.created_at is distinct from old.created_at
      or new.version <> old.version + 1 then
      raise exception 'Mileage review may only approve or reject one immutable submission'
        using errcode = '42501';
    end if;
  else
    raise exception 'Mileage updates require the submitting cleaner or an authorized reviewer'
      using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger mileage_entries_cleaner_update_guard
  before insert or update on mileage_entries for each row
  execute function private.guard_cleaner_mileage_update();

create function private.validate_tip_intent_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1
    from public.team_job_allocations allocation
    join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
    join public.bookings booking on booking.id = schedule.booking_id
    where allocation.id = new.team_job_allocation_id
      and allocation.organization_id = new.organization_id
      and allocation.team_id = new.team_id
      and booking.customer_id = new.customer_id
      and schedule.status = 'completed'
      and (
        new.cleaner_id is null
        or exists (
          select 1 from public.job_assignments assignment
          where assignment.job_schedule_id = schedule.id
            and assignment.team_id = allocation.team_id
            and assignment.cleaner_id = new.cleaner_id
            and assignment.status in ('accepted', 'confirmed')
        )
      )
  ) then
    raise exception 'Tip intent must match the completed allocation, customer, and assigned cleaner'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger tip_intents_scope_guard
  before insert or update of organization_id, team_id, team_job_allocation_id,
    customer_id, cleaner_id
  on tip_intents for each row
  execute function private.validate_tip_intent_scope();

create function private.guard_tip_intent_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if private.current_customer_id() is distinct from new.customer_id
      or private.current_cleaner_id() is not null
      or new.status <> 'pending_collection'
      or new.provider <> 'manual'
      or new.provider_reference is not null
      or new.recorded_by_membership_id is not null
      or new.version <> 1 then
      raise exception 'Tip intent must begin as the linked customer''s uncollected request'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if new.version <> old.version then
    raise exception 'Tip intent version is managed by the database' using errcode = '55000';
  end if;
  if private.current_customer_id() = old.customer_id then
    if old.status not in ('pending_collection','canceled')
      or new.status not in ('pending_collection','canceled')
      or new.organization_id <> old.organization_id
      or new.team_id <> old.team_id
      or new.team_job_allocation_id <> old.team_job_allocation_id
      or new.customer_id <> old.customer_id
      or new.cleaner_id is distinct from old.cleaner_id
      or new.currency <> old.currency
      or new.provider <> old.provider
      or new.provider_reference is distinct from old.provider_reference
      or new.recorded_by_membership_id is distinct from old.recorded_by_membership_id
      or new.is_dev_seed <> old.is_dev_seed then
      raise exception 'Customer may only revise or cancel an uncollected tip intent'
        using errcode = '42501';
    end if;
  elsif private.current_customer_id() is not null then
    if old.status <> 'pending_collection'
      or new.status not in ('recorded', 'declined', 'canceled')
      or new.organization_id <> old.organization_id
      or new.team_id <> old.team_id
      or new.team_job_allocation_id <> old.team_job_allocation_id
      or new.customer_id <> old.customer_id
      or new.cleaner_id is distinct from old.cleaner_id
      or new.amount_cents <> old.amount_cents
      or new.currency <> old.currency
      or new.provider <> old.provider
      or new.note is distinct from old.note
      or new.is_dev_seed <> old.is_dev_seed
      or not private.is_current_membership(new.recorded_by_membership_id)
      or (new.status = 'recorded' and new.provider_reference is null)
      or (new.status <> 'recorded' and new.provider_reference is not null) then
      raise exception 'Tip decision must be an evidence-backed transition from pending'
        using errcode = '42501';
    end if;
  else
    raise exception 'Tip intent updates require the linked customer or an authorized manager'
      using errcode = '42501';
  end if;
  new.version := old.version + 1;
  return new;
end
$$;
create trigger tip_intents_customer_update_guard
  before insert or update on tip_intents for each row
  execute function private.guard_tip_intent_update();

create function private.guard_checklist_completion() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  allocation_context record;
  actor_membership_id uuid;
begin
  if tg_op = 'INSERT' then
    if new.team_job_allocation_id is null then
      if private.current_cleaner_id() is not null
        or (
          private.current_customer_id() is not null
          and not exists (
            select 1 from public.bookings booking
            where booking.id = new.booking_id
              and booking.customer_id = private.current_customer_id()
              and booking.status = 'requested'
              and booking.created_at >= transaction_timestamp() - interval '5 minutes'
              and booking.is_dev_seed = new.is_dev_seed
          )
        )
        or (
          private.current_customer_id() is null
          and not exists (
            select 1 from public.bookings booking
            where booking.id = new.booking_id
              and booking.status = 'requested'
              and booking.created_at >= transaction_timestamp() - interval '5 minutes'
              and booking.is_dev_seed = new.is_dev_seed
          )
        )
        or new.organization_id is not null
        or new.team_id is not null
        or new.state <> 'pending'
        or new.completed_at is not null
        or new.completed_by_membership_id is not null
        or new.completed_by_cleaner_id is not null
        or new.completion_note is not null
        or new.version <> 1 then
        raise exception 'Intake checklist rows must begin unscoped and without completion evidence'
          using errcode = '42501';
      end if;
      perform 1
      from public.job_schedules schedule
      join public.team_job_allocations allocation
        on allocation.job_schedule_id = schedule.id
      where schedule.booking_id = new.booking_id
      order by allocation.id
      limit 1
      for share of schedule, allocation;
      if found then
        raise exception 'Unscoped checklist rows cannot be appended after branch allocation'
          using errcode = '55000';
      end if;
      return new;
    end if;

    -- The allocation-scope trigger adds exactly one generic fail-safe item
    -- when a legacy/manual booking reaches a branch without intake checklist
    -- rows. No caller can use this path to pre-complete or forge evidence.
    if pg_trigger_depth() > 1
      and new.label = 'Complete the approved service scope and document every exception'
      and new.room_id is null and new.room_label is null
      and new.state = 'pending'
      and new.completed_at is null
      and new.completed_by_membership_id is null
      and new.completed_by_cleaner_id is null
      and new.completion_note is null
      and new.version = 1
      and exists (
        select 1
        from public.team_job_allocations allocation
        join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
        where allocation.id = new.team_job_allocation_id
          and allocation.organization_id = new.organization_id
          and allocation.team_id = new.team_id
          and schedule.booking_id = new.booking_id
          and schedule.status in ('tentative', 'held')
      ) then
      return new;
    end if;

    select allocation.organization_id, allocation.team_id,
           schedule.status as schedule_status, schedule.booking_id
      into allocation_context
    from public.team_job_allocations allocation
    join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
    where allocation.id = new.team_job_allocation_id
    for share of schedule;

    if not found
      or allocation_context.organization_id <> new.organization_id
      or allocation_context.team_id <> new.team_id
      or allocation_context.booking_id <> new.booking_id
      or allocation_context.schedule_status not in ('tentative', 'held')
      or private.current_customer_id() is null
      or private.current_cleaner_id() is not null
      or new.state <> 'pending'
      or new.completed_at is not null
      or new.completed_by_membership_id is not null
      or new.completed_by_cleaner_id is not null
      or new.completion_note is not null
      or new.version <> 1 then
      raise exception 'Allocated checklist rows require an authorized planning-stage manager and no evidence'
        using errcode = '42501';
    end if;

    select membership.id into actor_membership_id
    from public.workforce_memberships membership
    where membership.organization_id = allocation_context.organization_id
      and membership.customer_id = private.current_customer_id()
      and membership.status = 'active'
      and (
        (membership.team_id = allocation_context.team_id
          and membership.role = 'manager')
        or (membership.team_id is null and membership.role in ('owner', 'gm'))
      )
    order by case when membership.team_id = allocation_context.team_id then 0 else 1 end,
      case membership.role when 'manager' then 0 when 'gm' then 1 else 2 end,
      membership.id
    limit 1
    for share of membership;
    if actor_membership_id is null then
      raise exception 'Allocated checklist creation requires an authorized manager'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.team_job_allocation_id is not null
      and not (old.is_dev_seed
        and private.current_customer_id() is null
        and private.current_cleaner_id() is null
        and pg_trigger_depth() > 1) then
      raise exception 'Allocated checklist evidence cannot be deleted'
        using errcode = '55000';
    end if;
    return old;
  end if;

  -- Allocation creation may attach the pre-existing intake checklist while the
  -- schedule is still in planning. This is the only mutable scope transition.
  if old.team_job_allocation_id is null
    and new.team_job_allocation_id is not null
    and new.id = old.id
    and new.booking_id = old.booking_id
    and new.label = old.label
    and new.room_id is not distinct from old.room_id
    and new.room_label is not distinct from old.room_label
    and new.sort = old.sort
    and new.state = old.state
    and new.completed_at is not distinct from old.completed_at
    and new.completed_by_membership_id is not distinct from old.completed_by_membership_id
    and new.completed_by_cleaner_id is not distinct from old.completed_by_cleaner_id
    and new.completion_note is not distinct from old.completion_note
    and new.version = old.version
    and new.is_dev_seed = old.is_dev_seed
    and new.created_at = old.created_at
    and exists (
      select 1
      from public.team_job_allocations allocation
      join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
      where allocation.id = new.team_job_allocation_id
        and allocation.organization_id = new.organization_id
        and allocation.team_id = new.team_id
        and schedule.booking_id = new.booking_id
        and schedule.status in ('tentative', 'held')
    ) then
    return new;
  end if;

  -- Keep the legacy, unallocated national-service checklist behavior intact.
  if old.team_job_allocation_id is null and new.team_job_allocation_id is null then
    return new;
  end if;

  select allocation.organization_id, allocation.team_id,
         schedule.status as schedule_status
    into allocation_context
  from public.team_job_allocations allocation
  join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
  where allocation.id = old.team_job_allocation_id
  for share of schedule;

  if not found or allocation_context.schedule_status <> 'in_progress' then
    raise exception 'Allocation checklist evidence is mutable only while service is in progress'
      using errcode = '55000';
  end if;
  if new.id <> old.id
    or new.booking_id <> old.booking_id
    or new.organization_id is distinct from old.organization_id
    or new.team_id is distinct from old.team_id
    or new.team_job_allocation_id is distinct from old.team_job_allocation_id
    or new.label <> old.label
    or new.room_id is distinct from old.room_id
    or new.room_label is distinct from old.room_label
    or new.sort <> old.sort
    or new.is_dev_seed <> old.is_dev_seed
    or new.created_at is distinct from old.created_at then
    raise exception 'Allocated checklist identity is immutable'
      using errcode = '55000';
  end if;
  if new.state = 'skipped'
    and char_length(trim(coalesce(new.completion_note, ''))) < 2 then
    raise exception 'Skipping a field checklist item requires an exception note'
      using errcode = '23514';
  end if;

  if private.current_cleaner_id() is not null
    and private.current_customer_id() is null then
    select membership.id into actor_membership_id
    from public.job_assignments assignment
    join public.team_job_allocations allocation
      on allocation.job_schedule_id = assignment.job_schedule_id
     and allocation.id = old.team_job_allocation_id
     and allocation.team_id = assignment.team_id
    join public.workforce_memberships membership
      on membership.organization_id = allocation.organization_id
     and membership.team_id = allocation.team_id
     and membership.cleaner_id = private.current_cleaner_id()
     and membership.status = 'active'
     and membership.role in ('cleaner', 'shift_lead')
    where assignment.cleaner_id = private.current_cleaner_id()
      and assignment.status in ('accepted', 'confirmed')
    order by case membership.role when 'shift_lead' then 0 else 1 end,
      membership.id
    limit 1
    for share of membership;
    if actor_membership_id is null then
      raise exception 'Cleaner may update only an assigned team checklist'
        using errcode = '42501';
    end if;
  elsif private.current_customer_id() is not null
    and private.current_cleaner_id() is null then
    select membership.id into actor_membership_id
    from public.workforce_memberships membership
    where membership.organization_id = allocation_context.organization_id
      and membership.customer_id = private.current_customer_id()
      and membership.status = 'active'
      and (
        (membership.team_id = allocation_context.team_id
          and membership.role in ('manager', 'shift_lead'))
        or (membership.team_id is null and membership.role in ('owner', 'gm'))
      )
    order by case when membership.team_id = allocation_context.team_id then 0 else 1 end,
      case membership.role
        when 'shift_lead' then 0 when 'manager' then 1
        when 'gm' then 2 else 3
      end,
      membership.id
    limit 1
    for share of membership;
    if actor_membership_id is null then
      raise exception 'An authorized field membership is required for checklist evidence'
        using errcode = '42501';
    end if;
  else
    raise exception 'Checklist evidence requires exactly one field actor'
      using errcode = '42501';
  end if;

  new.completed_by_membership_id := case when new.state in ('completed', 'skipped')
    then actor_membership_id else null end;
  new.completed_by_cleaner_id := case
    when new.state in ('completed', 'skipped')
      and private.current_cleaner_id() is not null
      then private.current_cleaner_id()
    else null
  end;
  new.completed_at := case when new.state in ('completed', 'skipped')
    then now() else null end;
  new.version := old.version + 1;
  return new;
end
$$;
create trigger checklist_items_completion_guard
  before insert or update or delete on checklist_items for each row
  execute function private.guard_checklist_completion();

create function private.guard_crew_time_entry_start_window() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  schedule_context record;
begin
  if private.current_cleaner_id() is null then
    return new;
  end if;

  select schedule.start_at, schedule.end_at, schedule.travel_buffer_minutes,
         coalesce(proposal.arrival_window_start, schedule.start_at) as window_start
    into schedule_context
  from public.team_job_allocations allocation
  join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
  left join lateral (
    select candidate.arrival_window_start
    from public.schedule_proposals candidate
    where candidate.job_schedule_id = schedule.id
      and candidate.status = 'approved'
      and schedule.start_at >= candidate.arrival_window_start
      and schedule.start_at <= candidate.arrival_window_end
    order by candidate.version desc, candidate.created_at desc
    limit 1
  ) proposal on true
  where allocation.id = new.team_job_allocation_id;

  if schedule_context is null
    or new.clock_in_at < schedule_context.window_start
      - make_interval(mins => schedule_context.travel_buffer_minutes)
    or new.clock_in_at > schedule_context.end_at + interval '12 hours' then
    raise exception 'Crew time may start only near the approved service window'
      using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger job_time_entries_start_window_guard
  before insert on job_time_entries for each row
  execute function private.guard_crew_time_entry_start_window();

create trigger service_location_assessments_updated_at
  before update on service_location_assessments
  for each row execute function set_updated_at();
create trigger schedule_proposals_updated_at
  before update on schedule_proposals
  for each row execute function set_updated_at();
create trigger customer_cleaner_preferences_updated_at
  before update on customer_cleaner_preferences
  for each row execute function set_updated_at();
create trigger mileage_entries_updated_at
  before update on mileage_entries
  for each row execute function set_updated_at();
create trigger job_issue_reports_updated_at
  before update on job_issue_reports
  for each row execute function set_updated_at();
create trigger team_duty_assignments_updated_at
  before update on team_duty_assignments
  for each row execute function set_updated_at();
create trigger tip_intents_updated_at
  before update on tip_intents
  for each row execute function set_updated_at();

alter table service_location_assessments enable row level security;
alter table schedule_proposals enable row level security;
alter table customer_cleaner_preferences enable row level security;
alter table job_communications enable row level security;
alter table mileage_entries enable row level security;
alter table job_issue_reports enable row level security;
alter table team_duty_assignments enable row level security;
alter table tip_intents enable row level security;

revoke all on function private.lakeandpine_intake_organization_id() from public;
revoke all on function private.haversine_miles(numeric, numeric, numeric, numeric) from public;
revoke all on function private.recalculate_location_assessment(uuid, uuid, uuid, boolean) from public;
revoke all on function private.guard_location_assessment_decision() from public;
revoke all on function private.audit_location_assessment_decision() from public;
revoke all on function private.guard_location_assessment_evidence() from public;
revoke all on function private.guard_team_field_policy_change() from public;
revoke all on function private.guard_cleaning_team_update_scope() from public;
revoke all on function private.lock_customer_team_cleaner_preference(uuid, uuid, uuid, uuid) from public;
revoke all on function private.has_complete_current_team_crew(uuid, uuid, uuid, integer) from public;
revoke all on function private.enrich_unallocated_service_location_assessment(
  uuid, text, text, double precision, double precision, double precision,
  double precision, double precision, double precision, text, text, text,
  text, text, text, timestamptz
) from public;
revoke all on function private.reconcile_ineligible_cleaner_assignments() from public;
revoke all on function private.customer_owns_allocation(uuid) from public;
revoke all on function private.current_staff_can_plan_territory(uuid) from public;
revoke all on function private.current_staff_can_manage_job_schedule(uuid) from public;
revoke all on function private.current_manager_can_manage_job_schedule(uuid) from public;
revoke all on function private.current_actor_can_read_job_schedule(uuid) from public;
revoke all on function private.customer_has_team_service(uuid) from public;
revoke all on function private.cleaner_assigned_to_allocation(uuid) from public;
revoke all on function private.cleaner_assigned_to_booking(uuid) from public;
revoke all on function private.current_cleaner_can_view_duty_member(uuid) from public;
revoke all on function private.current_cleaner_duty_coverage() from public;
revoke all on function private.current_customer_visible_job_issues() from public;
revoke all on function private.current_customer_quality_reviews() from public;
revoke all on function private.cancel_invalid_member_duty() from public;
revoke all on function private.guard_team_duty_lifecycle() from public;
revoke all on function private.guard_allocation_scope_immutability() from public;
revoke all on function private.guard_allocation_customer_avoid() from public;
revoke all on function private.validate_allocation_operating_hours() from public;
revoke all on function private.sync_allocation_field_scope() from public;
revoke all on function private.refresh_pending_team_location_assessments() from public;
revoke all on function private.validate_schedule_proposal() from public;
revoke all on function private.guard_customer_schedule_response() from public;
revoke all on function private.invalidate_stale_approvals_for_reschedule_case() from public;
revoke all on function private.require_approved_schedule_proposal() from public;
revoke all on function private.guard_schedule_execution_clock() from public;
revoke all on function private.guard_job_schedule_actor_and_evidence() from public;
revoke all on function private.guard_schedule_checklist_closeout() from public;
revoke all on function private.guard_customer_cleaner_preference() from public;
revoke all on function private.guard_avoided_cleaner_assignment() from public;
revoke all on function private.guard_assignment_current_membership() from public;
revoke all on function private.guard_field_subject_memberships() from public;
revoke all on function private.guard_quality_review_actor() from public;
revoke all on function private.guard_checklist_completion() from public;
revoke all on function private.guard_crew_time_entry_start_window() from public;
revoke all on function private.guard_job_communication_actor() from public;
revoke all on function private.guard_cleaner_mileage_update() from public;
revoke all on function private.guard_job_issue_lifecycle() from public;
revoke all on function private.validate_tip_intent_scope() from public;
revoke all on function private.guard_tip_intent_update() from public;

do $$
declare
  private_table text;
  private_tables constant text[] := array[
    'service_location_assessments', 'schedule_proposals',
    'customer_cleaner_preferences', 'job_communications', 'mileage_entries',
    'job_issue_reports', 'team_duty_assignments', 'tip_intents'
  ];
begin
  foreach private_table in array private_tables loop
    execute format(
      'grant select, insert, update, delete on table public.%I to lakeandpine_app',
      private_table
    );
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', private_table);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table public.%I from authenticated', private_table);
    end if;
  end loop;
end
$$;

grant execute on function private.lakeandpine_intake_organization_id() to lakeandpine_app;
grant execute on function private.customer_owns_allocation(uuid) to lakeandpine_app;
grant execute on function private.current_staff_can_plan_territory(uuid) to lakeandpine_app;
grant execute on function private.current_staff_can_manage_job_schedule(uuid) to lakeandpine_app;
grant execute on function private.current_manager_can_manage_job_schedule(uuid) to lakeandpine_app;
grant execute on function private.current_actor_can_read_job_schedule(uuid) to lakeandpine_app;
grant execute on function private.customer_has_team_service(uuid) to lakeandpine_app;
grant execute on function private.cleaner_assigned_to_allocation(uuid) to lakeandpine_app;
grant execute on function private.cleaner_assigned_to_booking(uuid) to lakeandpine_app;
grant execute on function private.current_cleaner_duty_coverage() to lakeandpine_app;
grant execute on function private.current_customer_visible_job_issues() to lakeandpine_app;
grant execute on function private.current_customer_quality_reviews() to lakeandpine_app;
grant execute on function private.enrich_unallocated_service_location_assessment(
  uuid, text, text, double precision, double precision, double precision,
  double precision, double precision, double precision, text, text, text,
  text, text, text, timestamptz
) to lakeandpine_app;

drop policy workforce_memberships_read on workforce_memberships;
create policy workforce_memberships_read
  on workforce_memberships for select to lakeandpine_app using (
    private.can_access_organization(organization_id, array['owner','gm'])
    or (private.current_cleaner_id() is null and team_id is not null
      and private.can_access_team(
        organization_id, team_id, array['manager','shift_lead']))
    or customer_id = private.current_customer_id()
    or cleaner_id = private.current_cleaner_id()
  );

drop policy lakeandpine_app_all_job_schedules on job_schedules;
create policy job_schedules_scoped_read
  on job_schedules for select to lakeandpine_app using (
    private.current_actor_can_read_job_schedule(id)
  );
create policy job_schedules_scoped_insert
  on job_schedules for insert to lakeandpine_app with check (
    private.current_staff_can_plan_territory(territory_id)
    and status = 'tentative'
    and version = 1
  );
create policy job_schedules_scoped_update
  on job_schedules for update to lakeandpine_app using (
    private.current_staff_can_manage_job_schedule(id)
  ) with check (
    private.current_staff_can_manage_job_schedule(id)
  );
create policy job_schedules_scoped_delete
  on job_schedules for delete to lakeandpine_app using (false);

drop policy cleaning_teams_scoped_read on cleaning_teams;
create policy cleaning_teams_scoped_read
  on cleaning_teams for select to lakeandpine_app using (
    private.can_access_team(
      organization_id, id, array['owner','gm','manager','shift_lead','cleaner'])
    or private.customer_has_team_service(id)
  );

drop policy team_job_allocations_read on team_job_allocations;
create policy team_job_allocations_read
  on team_job_allocations for select to lakeandpine_app using (
    private.can_access_team(
      organization_id, team_id,
      array['owner','gm','manager','shift_lead','cleaner'])
    or private.customer_owns_allocation(id)
  );

create policy service_location_assessments_read
  on service_location_assessments for select to lakeandpine_app using (
    (team_id is not null and private.can_access_team(
      organization_id, team_id, array['owner','gm','manager','shift_lead']))
    or (team_id is null and private.can_access_organization(
      organization_id, array['owner','gm']))
    or exists (
      select 1 from bookings booking
      where booking.id = booking_id
        and booking.customer_id = private.current_customer_id()
    )
    or private.cleaner_assigned_to_booking(booking_id)
  );
create policy service_location_assessments_insert
  on service_location_assessments for insert to lakeandpine_app with check (
    (private.current_customer_id() is null and private.current_cleaner_id() is null)
    or (team_id is not null and private.can_access_team(
      organization_id, team_id, array['owner','gm','manager']))
    or (team_id is null and private.can_access_organization(
      organization_id, array['owner','gm']))
  );
create policy service_location_assessments_update
  on service_location_assessments for update to lakeandpine_app using (
    (team_id is not null and private.can_access_team(
      organization_id, team_id, array['owner','gm','manager']))
    or (team_id is null and private.can_access_organization(
      organization_id, array['owner','gm']))
  ) with check (
    (team_id is not null and private.can_access_team(
      organization_id, team_id, array['owner','gm','manager']))
    or (team_id is null and private.can_access_organization(
      organization_id, array['owner','gm']))
  );
create policy service_location_assessments_delete_denied
  on service_location_assessments for delete to lakeandpine_app using (false);

create policy schedule_proposals_read
  on schedule_proposals for select to lakeandpine_app using (
    private.can_access_team(
      organization_id, team_id, array['owner','gm','manager','shift_lead'])
    or private.customer_owns_allocation(team_job_allocation_id)
    or private.cleaner_assigned_to_allocation(team_job_allocation_id)
  );
create policy schedule_proposals_insert
  on schedule_proposals for insert to lakeandpine_app with check (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    and private.is_current_membership(proposed_by_membership_id)
  );
create policy schedule_proposals_update
  on schedule_proposals for update to lakeandpine_app using (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or private.customer_owns_allocation(team_job_allocation_id)
  ) with check (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or private.customer_owns_allocation(team_job_allocation_id)
  );
create policy schedule_proposals_delete_denied
  on schedule_proposals for delete to lakeandpine_app using (false);

create policy customer_cleaner_preferences_read
  on customer_cleaner_preferences for select to lakeandpine_app using (
    private.can_access_team(
      organization_id, team_id, array['owner','gm','manager','shift_lead'])
    or customer_id = private.current_customer_id()
  );
create policy customer_cleaner_preferences_insert
  on customer_cleaner_preferences for insert to lakeandpine_app with check (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or customer_id = private.current_customer_id()
  );
create policy customer_cleaner_preferences_update
  on customer_cleaner_preferences for update to lakeandpine_app using (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or customer_id = private.current_customer_id()
  ) with check (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or customer_id = private.current_customer_id()
  );
create policy customer_cleaner_preferences_delete_denied
  on customer_cleaner_preferences for delete to lakeandpine_app using (false);

create policy job_communications_read
  on job_communications for select to lakeandpine_app using (
    private.can_access_team(
      organization_id, team_id, array['owner','gm','manager','shift_lead'])
    or (
      customer_id = private.current_customer_id()
      and (audience = 'customer' or sender_customer_id = private.current_customer_id())
    )
    or (
      private.cleaner_assigned_to_allocation(team_job_allocation_id)
      and (audience = 'assigned_crew' or sender_cleaner_id = private.current_cleaner_id())
    )
  );
create policy job_communications_insert
  on job_communications for insert to lakeandpine_app with check (
    (sender_kind = 'staff'
      and private.can_access_team(
        organization_id, team_id, array['owner','gm','manager','shift_lead'])
      and private.is_current_membership(sender_membership_id))
    or (sender_kind = 'customer'
      and sender_customer_id = private.current_customer_id()
      and customer_id = private.current_customer_id()
      and private.customer_owns_allocation(team_job_allocation_id))
    or (sender_kind = 'cleaner'
      and sender_cleaner_id = private.current_cleaner_id()
      and private.is_current_membership(sender_membership_id)
      and private.cleaner_assigned_to_allocation(team_job_allocation_id))
  );
create policy job_communications_update_denied
  on job_communications for update to lakeandpine_app using (false) with check (false);
create policy job_communications_delete_denied
  on job_communications for delete to lakeandpine_app using (false);

create policy mileage_entries_read
  on mileage_entries for select to lakeandpine_app using (
    private.can_access_team(
      organization_id, team_id, array['owner','gm','manager','shift_lead'])
    or cleaner_id = private.current_cleaner_id()
  );
create policy mileage_entries_insert
  on mileage_entries for insert to lakeandpine_app with check (
    cleaner_id = private.current_cleaner_id()
    and private.current_customer_id() is null
    and private.is_current_membership(workforce_membership_id)
    and (team_job_allocation_id is null
      or private.cleaner_assigned_to_allocation(team_job_allocation_id))
    and status = 'submitted'
  );
create policy mileage_entries_update
  on mileage_entries for update to lakeandpine_app using (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or cleaner_id = private.current_cleaner_id()
  ) with check (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or (cleaner_id = private.current_cleaner_id() and status = 'submitted')
  );
create policy mileage_entries_delete_denied
  on mileage_entries for delete to lakeandpine_app using (false);

create policy job_issue_reports_read
  on job_issue_reports for select to lakeandpine_app using (
    private.can_access_team(
      organization_id, team_id, array['owner','gm','manager'])
    or reported_by_cleaner_id = private.current_cleaner_id()
  );
create policy job_issue_reports_insert
  on job_issue_reports for insert to lakeandpine_app with check (
    (private.can_access_team(
      organization_id, team_id, array['owner','gm','manager','shift_lead'])
      and private.is_current_membership(reported_by_membership_id))
    or (reported_by_cleaner_id = private.current_cleaner_id()
      and private.is_current_membership(reported_by_membership_id)
      and (team_job_allocation_id is null
        or private.cleaner_assigned_to_allocation(team_job_allocation_id)))
  );
create policy job_issue_reports_update
  on job_issue_reports for update to lakeandpine_app using (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or reported_by_cleaner_id = private.current_cleaner_id()
  ) with check (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or (reported_by_cleaner_id = private.current_cleaner_id() and status = 'open')
  );
create policy job_issue_reports_delete_denied
  on job_issue_reports for delete to lakeandpine_app using (false);

create policy team_duty_assignments_read
  on team_duty_assignments for select to lakeandpine_app using (
    private.current_cleaner_id() is null
    and private.can_access_team(
      organization_id, team_id, array['owner','gm','manager','shift_lead'])
  );
create policy team_duty_assignments_insert
  on team_duty_assignments for insert to lakeandpine_app with check (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    and private.is_current_membership(created_by_membership_id)
  );
create policy team_duty_assignments_update
  on team_duty_assignments for update to lakeandpine_app using (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
  ) with check (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
  );
create policy team_duty_assignments_delete_denied
  on team_duty_assignments for delete to lakeandpine_app using (false);

create policy tip_intents_read
  on tip_intents for select to lakeandpine_app using (
    private.can_access_team(
      organization_id, team_id, array['owner','gm','manager','shift_lead'])
    or customer_id = private.current_customer_id()
    or (
      cleaner_id = private.current_cleaner_id()
      and private.cleaner_assigned_to_allocation(team_job_allocation_id)
    )
  );
create policy tip_intents_insert
  on tip_intents for insert to lakeandpine_app with check (
    customer_id = private.current_customer_id()
    and private.current_cleaner_id() is null
    and private.customer_owns_allocation(team_job_allocation_id)
    and status = 'pending_collection'
    and provider = 'manual'
    and provider_reference is null
    and recorded_by_membership_id is null
    and version = 1
  );
create policy tip_intents_update
  on tip_intents for update to lakeandpine_app using (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or customer_id = private.current_customer_id()
  ) with check (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or (customer_id = private.current_customer_id() and status in ('pending_collection','canceled'))
  );
create policy tip_intents_delete_denied
  on tip_intents for delete to lakeandpine_app using (false);

drop policy lakeandpine_app_all_checklist_items on checklist_items;
create policy checklist_items_scoped_read
  on checklist_items for select to lakeandpine_app using (
    (team_job_allocation_id is not null and (
      private.can_access_team(
        organization_id, team_id, array['owner','gm','manager','shift_lead'])
      or private.cleaner_assigned_to_allocation(team_job_allocation_id)
      or private.customer_owns_allocation(team_job_allocation_id)
    ))
    or (team_job_allocation_id is null and private.can_access_organization(
      (select id from organizations where slug = 'lake-and-pine'), array['owner','gm']))
  );
create policy checklist_items_scoped_insert
  on checklist_items for insert to lakeandpine_app with check (
    (private.current_customer_id() is null and private.current_cleaner_id() is null)
    or (team_job_allocation_id is null
      and private.current_cleaner_id() is null
      and exists (
        select 1 from bookings booking
        where booking.id = booking_id
          and booking.customer_id = private.current_customer_id()
          and booking.status = 'requested'
          and booking.created_at >= transaction_timestamp() - interval '5 minutes'
      ))
    or (team_job_allocation_id is not null and private.can_access_team(
      organization_id, team_id, array['owner','gm','manager']))
    or (team_job_allocation_id is null and private.can_access_organization(
      (select id from organizations where slug = 'lake-and-pine'), array['owner','gm']))
  );
create policy checklist_items_scoped_update
  on checklist_items for update to lakeandpine_app using (
    (team_job_allocation_id is not null and (
      private.can_access_team(
        organization_id, team_id, array['owner','gm','manager','shift_lead'])
      or private.cleaner_assigned_to_allocation(team_job_allocation_id)
    ))
    or (team_job_allocation_id is null and private.can_access_organization(
      (select id from organizations where slug = 'lake-and-pine'), array['owner','gm']))
  ) with check (
    (team_job_allocation_id is not null and (
      private.can_access_team(
        organization_id, team_id, array['owner','gm','manager','shift_lead'])
      or private.cleaner_assigned_to_allocation(team_job_allocation_id)
    ))
    or (team_job_allocation_id is null and private.can_access_organization(
      (select id from organizations where slug = 'lake-and-pine'), array['owner','gm']))
  );
create policy checklist_items_scoped_delete
  on checklist_items for delete to lakeandpine_app using (false);

create function private.current_customer_can_submit_quality_review(
  requested_allocation_id uuid,
  requested_organization_id uuid,
  requested_team_id uuid,
  requested_cleaner_id uuid,
  requested_customer_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and requested_customer_id = private.current_customer_id()
    and exists (
      select 1
      from public.team_job_allocations allocation
      join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
      join public.bookings booking on booking.id = schedule.booking_id
      join public.job_assignments assignment
        on assignment.job_schedule_id = allocation.job_schedule_id
       and assignment.team_id = allocation.team_id
      where allocation.id = requested_allocation_id
        and allocation.organization_id = requested_organization_id
        and allocation.team_id = requested_team_id
        and booking.customer_id = requested_customer_id
        and schedule.status = 'completed'
        and assignment.cleaner_id = requested_cleaner_id
        and assignment.status in ('accepted', 'confirmed')
    )
$$;
revoke all on function private.current_customer_can_submit_quality_review(
  uuid, uuid, uuid, uuid, uuid
) from public;
grant execute on function private.current_customer_can_submit_quality_review(
  uuid, uuid, uuid, uuid, uuid
) to lakeandpine_app;

drop policy quality_reviews_read on quality_reviews;
create policy quality_reviews_read on quality_reviews for select to lakeandpine_app using (
  private.can_access_team(
    organization_id, team_id, array['owner','gm','manager','shift_lead'])
);
drop policy quality_reviews_insert on quality_reviews;
create policy quality_reviews_insert on quality_reviews for insert to lakeandpine_app with check (
  (private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    and private.is_current_membership(created_by_membership_id))
  or (
    source = 'verified_customer'
    and customer_id = private.current_customer_id()
    and private.current_cleaner_id() is null
    and created_by_membership_id is null
    and private.current_customer_can_submit_quality_review(
      team_job_allocation_id, organization_id, team_id, cleaner_id, customer_id
    )
  )
);

-- Final production boundary hardening ----------------------------------------

-- National ownership is never first-come-first-served. A database administrator
-- must pre-authorize one private founder sign-in email; a successful claim
-- consumes that authorization in the same transaction.
create table private.owner_bootstrap_authorizations (
  normalized_email text primary key
    check (normalized_email = lower(trim(normalized_email))
      and normalized_email like '%@%'
      and char_length(normalized_email) between 5 and 320),
  consumed_at timestamptz,
  consumed_by_customer_id uuid references public.customers(id) on delete restrict,
  created_at timestamptz not null default now(),
  check ((consumed_at is null) = (consumed_by_customer_id is null))
);
revoke all on table private.owner_bootstrap_authorizations from public;
revoke all on table private.owner_bootstrap_authorizations from lakeandpine_app;

create or replace function private.bootstrap_lakeandpine_owner(target_customer_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_organization_id uuid;
  target_is_dev_seed boolean;
  target_email text;
  membership_id uuid;
begin
  if private.current_customer_id() is distinct from target_customer_id
    or private.current_cleaner_id() is not null then
    raise exception 'Owner bootstrap identity mismatch' using errcode = '42501';
  end if;
  select lower(trim(customer.email)), customer.is_dev_seed
    into target_email, target_is_dev_seed
  from public.customers customer
  where customer.id = target_customer_id
    and customer.role = 'staff'
    and customer.email is not null
  for update;
  if not found then
    raise exception 'Only an existing staff identity can bootstrap ownership'
      using errcode = '42501';
  end if;
  perform 1
  from private.owner_bootstrap_authorizations founder_auth
  where founder_auth.normalized_email = target_email
    and founder_auth.consumed_at is null
  for update;
  if not found then
    raise exception 'This founder identity is not pre-authorized for owner bootstrap'
      using errcode = '42501';
  end if;
  select organization.id into target_organization_id
  from public.organizations organization
  where organization.slug = 'lake-and-pine' and organization.status = 'active'
  for update;
  if target_organization_id is null then
    raise exception 'Lake & Pine organization is unavailable' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.workforce_memberships membership
    where membership.organization_id = target_organization_id
      and membership.role = 'owner' and membership.status = 'active'
  ) then
    raise exception 'National ownership has already been established'
      using errcode = '42501';
  end if;
  insert into public.workforce_memberships
    (organization_id, customer_id, role, status, title, is_dev_seed)
  values (
    target_organization_id, target_customer_id, 'owner', 'active',
    'National owner', target_is_dev_seed
  )
  returning id into membership_id;
  update private.owner_bootstrap_authorizations founder_auth
  set consumed_at = clock_timestamp(), consumed_by_customer_id = target_customer_id
  where founder_auth.normalized_email = target_email
    and founder_auth.consumed_at is null;
  if not found then
    raise exception 'Owner bootstrap authorization was concurrently consumed'
      using errcode = '40001';
  end if;
  return membership_id;
end
$$;
revoke all on function private.bootstrap_lakeandpine_owner(uuid) from public;
grant execute on function private.bootstrap_lakeandpine_owner(uuid) to lakeandpine_app;

-- Once route evidence exists, the five address keys are frozen. Non-route
-- contact metadata may still be corrected without invalidating evidence.
create function private.normalized_booking_route_address(contact_value jsonb)
returns text language sql immutable security definer set search_path = '' as $$
  select concat_ws('|',
    regexp_replace(lower(trim(coalesce(contact_value ->> 'street', ''))), '\s+', ' ', 'g'),
    regexp_replace(lower(trim(coalesce(contact_value ->> 'unit', ''))), '\s+', ' ', 'g'),
    regexp_replace(lower(trim(coalesce(contact_value ->> 'city', ''))), '\s+', ' ', 'g'),
    regexp_replace(lower(trim(coalesce(contact_value ->> 'state', ''))), '\s+', ' ', 'g'),
    regexp_replace(lower(trim(coalesce(contact_value ->> 'zip', ''))), '\s+', ' ', 'g')
  )
$$;
create function private.guard_booking_route_address() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.normalized_booking_route_address(new.contact)
      is not distinct from private.normalized_booking_route_address(old.contact) then
    return new;
  end if;
  if exists (
    select 1 from public.service_location_assessments assessment
    where assessment.booking_id = old.id
  ) then
    raise exception 'An assessed service address requires the controlled reassessment workflow'
      using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger bookings_route_address_guard
  before update of contact on bookings for each row
  execute function private.guard_booking_route_address();
revoke all on function private.normalized_booking_route_address(jsonb) from public;
revoke all on function private.guard_booking_route_address() from public;

-- Customer surfaces receive only the assignment fields needed for continuity,
-- messaging, reviews, tips, and preferences. Scoring and internal assignment
-- evidence never become raw customer-readable rows.
create function private.current_customer_allocation_has_cleaner(
  requested_allocation_id uuid,
  requested_cleaner_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and exists (
      select 1
      from public.team_job_allocations allocation
      join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
      join public.bookings booking on booking.id = schedule.booking_id
      join public.job_assignments assignment
        on assignment.job_schedule_id = schedule.id
       and assignment.team_id = allocation.team_id
       and assignment.cleaner_id = requested_cleaner_id
       and assignment.status in ('accepted', 'confirmed')
      join public.workforce_memberships membership
        on membership.organization_id = allocation.organization_id
       and membership.team_id = allocation.team_id
       and membership.cleaner_id = assignment.cleaner_id
       and membership.status = 'active'
       and membership.role in ('cleaner', 'shift_lead')
      where allocation.id = requested_allocation_id
        and booking.customer_id = private.current_customer_id()
    )
$$;
create function private.current_customer_allocation_has_active_crew(
  requested_allocation_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and exists (
      select 1
      from public.team_job_allocations allocation
      join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
      join public.bookings booking on booking.id = schedule.booking_id
      join public.job_assignments assignment
        on assignment.job_schedule_id = schedule.id
       and assignment.team_id = allocation.team_id
       and assignment.status in ('accepted', 'confirmed')
      join public.workforce_memberships membership
        on membership.organization_id = allocation.organization_id
       and membership.team_id = allocation.team_id
       and membership.cleaner_id = assignment.cleaner_id
       and membership.status = 'active'
       and membership.role in ('cleaner', 'shift_lead')
      where allocation.id = requested_allocation_id
        and booking.customer_id = private.current_customer_id()
    )
$$;
create function private.current_customer_job_assignments()
returns table (
  team_job_allocation_id uuid,
  cleaner_id uuid,
  cleaner_name text,
  assignment_role text,
  preference text,
  schedule_status text,
  service_vertical text,
  schedule_start_at timestamptz,
  timezone text,
  service_location text,
  crew_message_open boolean
) language sql stable security definer set search_path = '' as $$
  select allocation.id, cleaner.id, cleaner.full_name,
    assignment.assignment_role, preference.preference, schedule.status,
    schedule.service_vertical, schedule.start_at, team.timezone,
    concat_ws(', ', nullif(booking.contact->>'street', ''),
      nullif(booking.contact->>'city', ''), nullif(booking.contact->>'state', '')),
    schedule.status in ('confirmed','en_route','in_progress','quality_review')
      and private.current_customer_allocation_has_active_crew(allocation.id)
  from public.team_job_allocations allocation
  join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
  join public.bookings booking on booking.id = schedule.booking_id
  join public.cleaning_teams team on team.id = allocation.team_id
  join public.job_assignments assignment
    on assignment.job_schedule_id = schedule.id
   and assignment.team_id = allocation.team_id
   and assignment.status in ('accepted','confirmed')
  join public.cleaners cleaner on cleaner.id = assignment.cleaner_id
  left join public.customer_cleaner_preferences preference
    on preference.team_id = allocation.team_id
   and preference.customer_id = booking.customer_id
   and preference.cleaner_id = cleaner.id and preference.active
  where private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and booking.customer_id = private.current_customer_id()
    and schedule.status in (
      'confirmed','en_route','in_progress','quality_review','completed'
    )
  order by schedule.start_at desc, cleaner.full_name
$$;

create function private.current_cleaner_job_issue_reports()
returns table (
  id uuid,
  team_job_allocation_id uuid,
  issue_type text,
  severity text,
  summary text,
  status text,
  is_dev_seed boolean,
  created_at timestamptz
) language sql stable security definer set search_path = '' as $$
  select issue.id, issue.team_job_allocation_id, issue.issue_type,
    issue.severity, issue.summary, issue.status, issue.is_dev_seed,
    issue.created_at
  from public.job_issue_reports issue
  where private.current_customer_id() is null
    and private.current_cleaner_id() is not null
    and issue.reported_by_cleaner_id = private.current_cleaner_id()
    and exists (
      select 1 from public.workforce_memberships membership
      where membership.organization_id = issue.organization_id
        and membership.team_id = issue.team_id
        and membership.cleaner_id = private.current_cleaner_id()
        and membership.status = 'active'
        and membership.role in ('cleaner', 'shift_lead')
    )
$$;

revoke all on function private.current_customer_allocation_has_cleaner(uuid, uuid) from public;
revoke all on function private.current_customer_allocation_has_active_crew(uuid) from public;
revoke all on function private.current_customer_job_assignments() from public;
revoke all on function private.current_cleaner_job_issue_reports() from public;
grant execute on function private.current_customer_allocation_has_cleaner(uuid, uuid) to lakeandpine_app;
grant execute on function private.current_customer_allocation_has_active_crew(uuid) to lakeandpine_app;
grant execute on function private.current_customer_job_assignments() to lakeandpine_app;
grant execute on function private.current_cleaner_job_issue_reports() to lakeandpine_app;

-- The remaining final-boundary guards apply to application-role traffic while
-- preserving database-owner maintenance and migration fixture setup. `SET
-- ROLE lakeandpine_app` is intentionally treated exactly like a direct runtime
-- connection so verifier probes cannot bypass these guards.
create function private.application_role_is_active()
returns boolean language sql stable security invoker set search_path = '' as $$
  select session_user = 'lakeandpine_app'
    or current_user = 'lakeandpine_app'
    or coalesce(current_setting('role', true), '') = 'lakeandpine_app'
$$;
revoke all on function private.application_role_is_active() from public;
grant execute on function private.application_role_is_active() to lakeandpine_app;

-- A raw assessment INSERT can establish only the fail-safe manual-review row
-- that accompanies a newly captured request. Calculated route facts and
-- manager exceptions are available only through their dedicated update paths.
create function private.guard_location_assessment_intake() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  booking_customer_id uuid;
begin
  if not private.application_role_is_active() then
    return new;
  end if;
  if private.current_cleaner_id() is not null
    or (private.current_customer_id() is not null
      and private.current_cleaner_id() is not null) then
    raise exception 'Route assessment intake does not accept a cleaner actor'
      using errcode = '42501';
  end if;
  select booking.customer_id into booking_customer_id
  from public.bookings booking
  where booking.id = new.booking_id
  for share;
  if not found
    or (private.current_customer_id() is null and booking_customer_id is not null)
    or (private.current_customer_id() is not null
      and booking_customer_id is distinct from private.current_customer_id())
    or new.organization_id is distinct from private.lakeandpine_intake_organization_id()
    or new.team_id is not null
    or new.calculation_method <> 'manual_review'
    or new.assessment_status <> 'manual_review'
    or new.provider <> 'manual'
    or new.property_latitude is not null
    or new.property_longitude is not null
    or new.distance_miles is not null
    or new.duration_minutes is not null
    or new.provider_resolved_address is not null
    or new.provider_match_confidence is not null
    or new.provider_coordinate_accuracy is not null
    or new.calculated_at is not null
    or new.override_by_membership_id is not null
    or new.override_reason is not null
    or nullif(trim(coalesce(new.branch_origin_label, '')), '') is null
    or new.branch_origin_latitude is null
    or new.branch_origin_longitude is null
    or exists (
      select 1 from public.job_schedules schedule
      where schedule.booking_id = new.booking_id
    ) then
    raise exception 'Route intake must begin as one unallocated manual-review assessment'
      using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger service_location_assessments_intake_guard
  before insert on service_location_assessments for each row
  execute function private.guard_location_assessment_intake();
revoke all on function private.guard_location_assessment_intake() from public;

drop policy service_location_assessments_insert on service_location_assessments;
create policy service_location_assessments_insert
  on service_location_assessments for insert to lakeandpine_app with check (
    private.current_cleaner_id() is null
    and organization_id = private.lakeandpine_intake_organization_id()
    and team_id is null
    and exists (
      select 1 from bookings booking
      where booking.id = booking_id
        and (
          (private.current_customer_id() is null and booking.customer_id is null)
          or booking.customer_id = private.current_customer_id()
        )
    )
  );

-- Scheduling recommendations may consider a cleaner's aggregate workload
-- without granting a branch raw access to another branch's assignments.
create function private.current_staff_can_consider_cleaner_for_schedule(
  requested_schedule_id uuid,
  requested_cleaner_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  with target as (
    select schedule.id, schedule.territory_id,
      allocation.organization_id, allocation.team_id
    from public.job_schedules schedule
    left join public.team_job_allocations allocation
      on allocation.job_schedule_id = schedule.id
    where schedule.id = requested_schedule_id
  )
  select private.current_staff_can_manage_job_schedule(requested_schedule_id)
    and exists (
      select 1
      from target
      join public.workforce_memberships candidate
        on candidate.organization_id = coalesce(
          target.organization_id, private.lakeandpine_intake_organization_id()
        )
       and candidate.cleaner_id = requested_cleaner_id
       and candidate.status = 'active'
       and candidate.role in ('cleaner', 'shift_lead')
      where private.can_access_organization(
          candidate.organization_id, array['owner', 'gm']
        )
        or (
          candidate.team_id is not null
          and private.can_access_team(
            candidate.organization_id, candidate.team_id,
            array['manager', 'shift_lead']
          )
          and (
            target.team_id = candidate.team_id
            or (target.team_id is null
              and exists (
                select 1
                from public.team_service_territories coverage
                join public.cleaning_teams team
                  on team.organization_id = coverage.organization_id
                 and team.id = coverage.team_id
                 and team.status = 'active'
                where coverage.organization_id = candidate.organization_id
                  and coverage.team_id = candidate.team_id
                  and coverage.territory_id = target.territory_id
                  and coverage.status = 'active'
              ))
          )
        )
    )
$$;

create function private.current_staff_candidate_assignment_spans(
  requested_schedule_id uuid,
  requested_cleaner_ids uuid[]
) returns table (
  cleaner_id uuid,
  start_at timestamptz,
  end_at timestamptz
) language plpgsql stable security definer set search_path = '' as $$
declare
  target_start timestamptz;
  target_end timestamptz;
begin
  if not private.current_staff_can_manage_job_schedule(requested_schedule_id)
    or coalesce(cardinality(requested_cleaner_ids), 0) > 100 then
    raise exception 'Candidate workload request is outside staff scheduling scope'
      using errcode = '42501';
  end if;
  select schedule.start_at, schedule.end_at into target_start, target_end
  from public.job_schedules schedule
  where schedule.id = requested_schedule_id;
  if not found then
    raise exception 'Candidate workload schedule was not found' using errcode = '22023';
  end if;
  return query
    select assignment.cleaner_id, schedule.start_at, schedule.end_at
    from public.job_assignments assignment
    join public.job_schedules schedule on schedule.id = assignment.job_schedule_id
    where assignment.cleaner_id = any(coalesce(requested_cleaner_ids, '{}'::uuid[]))
      and private.current_staff_can_consider_cleaner_for_schedule(
        requested_schedule_id, assignment.cleaner_id
      )
      and assignment.status in ('accepted', 'confirmed')
      and schedule.id <> requested_schedule_id
      and schedule.status not in ('completed', 'canceled')
      and schedule.start_at < target_end + interval '3 hours'
      and schedule.end_at > target_start - interval '3 hours';
end
$$;

create function private.current_staff_candidate_assignment_loads(
  requested_schedule_id uuid,
  requested_cleaner_ids uuid[]
) returns table (
  cleaner_id uuid,
  jobs_today integer,
  minutes_today integer,
  minutes_week integer
) language plpgsql stable security definer set search_path = '' as $$
declare
  target_start timestamptz;
  target_timezone text;
begin
  if not private.current_staff_can_manage_job_schedule(requested_schedule_id)
    or coalesce(cardinality(requested_cleaner_ids), 0) > 100 then
    raise exception 'Candidate workload request is outside staff scheduling scope'
      using errcode = '42501';
  end if;
  select schedule.start_at, territory.timezone
    into target_start, target_timezone
  from public.job_schedules schedule
  join public.service_territories territory on territory.id = schedule.territory_id
  where schedule.id = requested_schedule_id;
  if not found then
    raise exception 'Candidate workload schedule was not found' using errcode = '22023';
  end if;
  return query
    with permitted as (
      select distinct candidate_id as candidate_cleaner_id
      from unnest(coalesce(requested_cleaner_ids, '{}'::uuid[])) candidate_id
      where private.current_staff_can_consider_cleaner_for_schedule(
        requested_schedule_id, candidate_id
      )
    ), workload as (
      select permitted.candidate_cleaner_id,
        schedule.id as workload_schedule_id,
        schedule.start_at as workload_start,
        schedule.end_at as workload_end
      from permitted
      left join public.job_assignments assignment
        on assignment.cleaner_id = permitted.candidate_cleaner_id
       and assignment.status in ('accepted', 'confirmed')
      left join public.job_schedules schedule
        on schedule.id = assignment.job_schedule_id
       and schedule.id <> requested_schedule_id
       and schedule.status not in ('completed', 'canceled')
    )
    select workload.candidate_cleaner_id,
      count(distinct workload.workload_schedule_id) filter (
        where (workload.workload_start at time zone target_timezone)::date
          = (target_start at time zone target_timezone)::date
      )::integer,
      coalesce(sum(extract(epoch from
        (workload.workload_end - workload.workload_start)) / 60) filter (
          where (workload.workload_start at time zone target_timezone)::date
            = (target_start at time zone target_timezone)::date
        ), 0)::integer,
      coalesce(sum(extract(epoch from
        (workload.workload_end - workload.workload_start)) / 60) filter (
          where date_trunc('week',
              workload.workload_start at time zone target_timezone)
            = date_trunc('week', target_start at time zone target_timezone)
        ), 0)::integer
    from workload
    group by workload.candidate_cleaner_id;
end
$$;

revoke all on function private.current_staff_can_consider_cleaner_for_schedule(uuid, uuid) from public;
revoke all on function private.current_staff_candidate_assignment_spans(uuid, uuid[]) from public;
revoke all on function private.current_staff_candidate_assignment_loads(uuid, uuid[]) from public;
grant execute on function private.current_staff_can_consider_cleaner_for_schedule(uuid, uuid) to lakeandpine_app;
grant execute on function private.current_staff_candidate_assignment_spans(uuid, uuid[]) to lakeandpine_app;
grant execute on function private.current_staff_candidate_assignment_loads(uuid, uuid[]) to lakeandpine_app;

-- Raw cleaner issue rows contain internal assignment and audit fields. Cleaners
-- use the bounded projection above; managers retain the scoped operational row.
drop policy job_issue_reports_read on job_issue_reports;
create policy job_issue_reports_read
  on job_issue_reports for select to lakeandpine_app using (
    private.can_access_team(
      organization_id, team_id, array['owner', 'gm', 'manager']
    )
  );
drop policy job_issue_reports_update on job_issue_reports;
create policy job_issue_reports_update
  on job_issue_reports for update to lakeandpine_app using (
    private.can_access_team(
      organization_id, team_id, array['owner', 'gm', 'manager']
    )
  ) with check (
    private.can_access_team(
      organization_id, team_id, array['owner', 'gm', 'manager']
    )
  );

-- Ledger row identity and creation time are evidence, not editable metadata.
create function private.guard_field_ledger_row_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.id is distinct from old.id
    or new.created_at is distinct from old.created_at then
    raise exception '% row identity and creation evidence are immutable', tg_table_name
      using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger mileage_entries_row_identity_guard
  before update of id, created_at on mileage_entries for each row
  execute function private.guard_field_ledger_row_identity();
create trigger job_issue_reports_row_identity_guard
  before update of id, created_at on job_issue_reports for each row
  execute function private.guard_field_ledger_row_identity();
create trigger tip_intents_row_identity_guard
  before update of id, created_at on tip_intents for each row
  execute function private.guard_field_ledger_row_identity();
revoke all on function private.guard_field_ledger_row_identity() from public;

-- Assignment rows are writable only by a scoped manager while work is still
-- being planned, or by the named cleaner making one proposed-work response.
-- Customers receive the bounded projection and never the raw scoring evidence.
create function private.guard_job_assignment_actor() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.application_role_is_active() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Assignment history is retained; remove it through status'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if private.current_customer_id() is null
      or private.current_cleaner_id() is not null
      or not private.current_manager_can_manage_job_schedule(new.job_schedule_id)
      or new.status <> 'proposed'
      or new.responded_at is not null
      or new.team_id is null
      or not exists (
          select 1 from public.team_job_allocations allocation
          where allocation.job_schedule_id = new.job_schedule_id
            and allocation.team_id = new.team_id
        )
      or not exists (
          select 1 from public.job_schedules schedule
          where schedule.id = new.job_schedule_id
            and schedule.status in ('tentative', 'held')
        ) then
      raise exception 'Assignment creation requires a scoped manager proposal'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- Allocation creation may attach an already-accepted legacy assignment to
  -- the branch. No response, score, timestamp, or identity may change with it.
  if pg_trigger_depth() > 1
    and old.team_id is null and new.team_id is not null
    and (to_jsonb(new) - 'team_id') = (to_jsonb(old) - 'team_id')
    and exists (
      select 1 from public.team_job_allocations allocation
      where allocation.job_schedule_id = old.job_schedule_id
        and allocation.team_id = new.team_id
    ) then
    return new;
  end if;

  -- Membership revocation deterministically removes planning-stage work. The
  -- nested reconciliation trigger is accepted only after no eligible current
  -- membership remains and it changes exactly status plus response time.
  if pg_trigger_depth() > 1
    and old.status in ('proposed', 'accepted', 'confirmed')
    and new.status = 'removed'
    and (to_jsonb(new) - 'status' - 'responded_at')
      = (to_jsonb(old) - 'status' - 'responded_at')
    and not exists (
      select 1
      from public.team_job_allocations allocation
      join public.workforce_memberships membership
        on membership.organization_id = allocation.organization_id
       and membership.team_id = allocation.team_id
       and membership.cleaner_id = old.cleaner_id
       and membership.status = 'active'
       and membership.role in ('cleaner', 'shift_lead')
      where allocation.job_schedule_id = old.job_schedule_id
        and allocation.team_id = old.team_id
    ) then
    new.responded_at := clock_timestamp();
    return new;
  end if;

  if private.current_cleaner_id() = old.cleaner_id
    and private.current_customer_id() is null then
    if old.status <> 'proposed'
      or new.status not in ('accepted', 'declined')
      or (to_jsonb(new) - 'status' - 'responded_at')
        <> (to_jsonb(old) - 'status' - 'responded_at')
      or old.team_id is null
      or not exists (
        select 1 from public.job_schedules schedule
        where schedule.id = old.job_schedule_id
          and schedule.status in ('tentative', 'held')
      )
      or not exists (
        select 1
        from public.team_job_allocations allocation
        join public.workforce_memberships membership
          on membership.organization_id = allocation.organization_id
         and membership.team_id = allocation.team_id
         and membership.cleaner_id = old.cleaner_id
         and membership.status = 'active'
         and membership.role in ('cleaner', 'shift_lead')
        where allocation.job_schedule_id = old.job_schedule_id
          and allocation.team_id = old.team_id
      ) then
      raise exception 'Cleaner may only accept or decline their current proposal'
        using errcode = '42501';
    end if;
    new.responded_at := clock_timestamp();
    return new;
  end if;

  if private.current_cleaner_id() is not null
    or private.current_customer_id() is null
    or not private.current_manager_can_manage_job_schedule(old.job_schedule_id)
    or not exists (
      select 1 from public.job_schedules schedule
      where schedule.id = old.job_schedule_id
        and schedule.status in ('tentative', 'held')
    )
    or new.id <> old.id
    or new.job_schedule_id <> old.job_schedule_id
    or new.cleaner_id <> old.cleaner_id
    or new.team_id is null
    or (old.team_id is not null and new.team_id <> old.team_id)
    or not exists (
      select 1 from public.team_job_allocations allocation
      where allocation.job_schedule_id = old.job_schedule_id
        and allocation.team_id = new.team_id
    )
    or new.assigned_by_label <> old.assigned_by_label
    or new.is_dev_seed <> old.is_dev_seed
    or (to_jsonb(new)
      - 'assignment_role' - 'status' - 'suggestion_score'
      - 'suggestion_reasons' - 'assigned_at' - 'responded_at')
      <> (to_jsonb(old)
      - 'assignment_role' - 'status' - 'suggestion_score'
      - 'suggestion_reasons' - 'assigned_at' - 'responded_at')
    or not (
      new.status = old.status
      or (new.status = 'proposed'
        and old.status not in ('accepted', 'confirmed'))
      or (new.status = 'removed'
        and old.status in ('proposed', 'accepted', 'confirmed'))
    ) then
    raise exception 'Manager assignment update exceeds planning authority'
      using errcode = '42501';
  end if;
  if new.status = 'proposed' then
    new.responded_at := null;
  elsif new.status = 'removed' and old.status <> 'removed' then
    new.responded_at := clock_timestamp();
  elsif new.responded_at is distinct from old.responded_at then
    raise exception 'Assignment response evidence is database managed'
      using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger job_assignments_actor_guard
  before insert or update or delete on job_assignments for each row
  execute function private.guard_job_assignment_actor();
revoke all on function private.guard_job_assignment_actor() from public;

drop policy lakeandpine_app_all_job_assignments on job_assignments;
create policy job_assignments_read
  on job_assignments for select to lakeandpine_app using (
    private.current_staff_can_manage_job_schedule(job_schedule_id)
    or (
      cleaner_id = private.current_cleaner_id()
      and private.current_customer_id() is null
      and team_id is not null
      and exists (
        select 1
        from team_job_allocations allocation
        join workforce_memberships membership
          on membership.organization_id = allocation.organization_id
         and membership.team_id = allocation.team_id
         and membership.cleaner_id = job_assignments.cleaner_id
         and membership.status = 'active'
         and membership.role in ('cleaner', 'shift_lead')
        where allocation.job_schedule_id = job_assignments.job_schedule_id
          and allocation.team_id = job_assignments.team_id
      )
    )
  );
create policy job_assignments_insert
  on job_assignments for insert to lakeandpine_app with check (
    status = 'proposed'
    and private.current_manager_can_manage_job_schedule(job_schedule_id)
  );
create policy job_assignments_update
  on job_assignments for update to lakeandpine_app using (
    private.current_manager_can_manage_job_schedule(job_schedule_id)
    or (
      cleaner_id = private.current_cleaner_id()
      and private.current_customer_id() is null
      and team_id is not null
    )
  ) with check (
    private.current_manager_can_manage_job_schedule(job_schedule_id)
    or (
      cleaner_id = private.current_cleaner_id()
      and private.current_customer_id() is null
      and team_id is not null
    )
  );
create policy job_assignments_delete_denied
  on job_assignments for delete to lakeandpine_app using (false);

create function private.current_cleaner_assignments(require_dev_seed boolean)
returns table (
  id uuid,
  schedule_id uuid,
  service_vertical text,
  start_at text,
  end_at text,
  schedule_status text,
  assignment_status text,
  assignment_role text,
  territory_name text,
  territory_timezone text,
  required_skills text[],
  planning_direction text
) language plpgsql stable security definer set search_path = '' as $$
begin
  if private.current_cleaner_id() is null
    or private.current_customer_id() is not null then
    raise exception 'Cleaner schedule projection requires one cleaner actor'
      using errcode = '42501';
  end if;
  return query
  select assignment.id, schedule.id, schedule.service_vertical,
         schedule.start_at::text, schedule.end_at::text,
         schedule.status, assignment.status, assignment.assignment_role,
         territory.name, territory.timezone, schedule.required_skills,
         booking.planning_direction
  from public.job_assignments assignment
  join public.job_schedules schedule on schedule.id = assignment.job_schedule_id
  join public.bookings booking on booking.id = schedule.booking_id
  join public.service_territories territory on territory.id = schedule.territory_id
  join public.team_job_allocations allocation
    on allocation.job_schedule_id = schedule.id
   and allocation.team_id = assignment.team_id
  join public.workforce_memberships membership
    on membership.organization_id = allocation.organization_id
   and membership.team_id = allocation.team_id
   and membership.cleaner_id = assignment.cleaner_id
   and membership.status = 'active'
   and membership.role in ('cleaner', 'shift_lead')
  where assignment.cleaner_id = private.current_cleaner_id()
    and (not coalesce(require_dev_seed, false)
      or (assignment.is_dev_seed and schedule.is_dev_seed and booking.is_dev_seed))
    and schedule.start_at >= clock_timestamp() - interval '1 day'
  order by schedule.start_at, assignment.id
  limit 30;
end
$$;
revoke all on function private.current_cleaner_assignments(boolean) from public;
grant execute on function private.current_cleaner_assignments(boolean)
  to lakeandpine_app;

-- Service recovery is customer-private and branch-scoped. Unallocated cases
-- remain in the national owner/GM queue until a booking allocation assigns the
-- exact branch automatically.
create function private.current_staff_can_manage_service_case_scope(
  requested_booking_id uuid,
  requested_assigned_team_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and case
      when requested_booking_id is null then
        requested_assigned_team_id is null
        and private.can_access_organization(
          private.lakeandpine_intake_organization_id(), array['owner', 'gm']
        )
      when exists (
        select 1
        from public.job_schedules schedule
        join public.team_job_allocations allocation
          on allocation.job_schedule_id = schedule.id
        where schedule.booking_id = requested_booking_id
      ) then exists (
        select 1
        from public.job_schedules schedule
        join public.team_job_allocations allocation
          on allocation.job_schedule_id = schedule.id
        where schedule.booking_id = requested_booking_id
          and (requested_assigned_team_id is null
            or requested_assigned_team_id = allocation.team_id)
          and private.can_access_team(
            allocation.organization_id, allocation.team_id,
            array['owner', 'gm', 'manager']
          )
      )
      else requested_assigned_team_id is null
        and private.can_access_organization(
          private.lakeandpine_intake_organization_id(), array['owner', 'gm']
        )
    end
$$;

create function private.current_staff_can_manage_service_case(
  requested_service_case_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.service_cases service_case
    where service_case.id = requested_service_case_id
      and private.current_staff_can_manage_service_case_scope(
        service_case.booking_id, service_case.assigned_team_id
      )
  )
$$;

-- A private, transaction-bound capability lets the public definer insert one
-- prevalidated case without opening raw null-actor INSERT access. The runtime
-- role has no rights on this table.
create table private.public_service_case_write_authorizations (
  service_case_id uuid primary key,
  backend_pid integer not null,
  transaction_id xid8 not null,
  created_at timestamptz not null default clock_timestamp()
);
revoke all on table private.public_service_case_write_authorizations from public;
revoke all on table private.public_service_case_write_authorizations from lakeandpine_app;

create function private.consume_public_service_case_write_authorization(
  requested_service_case_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from private.public_service_case_write_authorizations write_auth
  where write_auth.service_case_id = requested_service_case_id
    and write_auth.backend_pid = pg_backend_pid()
    and write_auth.transaction_id = pg_current_xact_id();
  return found;
end
$$;
revoke all on function private.consume_public_service_case_write_authorization(uuid) from public;

create function private.create_public_service_case(
  requested_idempotency_hash text,
  requested_case_type text,
  requested_booking_reference_hash text,
  requested_public_reference text,
  requested_contact jsonb,
  requested_details text,
  requested_preferred_date date,
  requested_alternate_date date,
  requested_consent_snapshot jsonb
) returns table (
  service_case_id uuid,
  case_reference text,
  duplicate boolean,
  outcome text,
  notification_outbox_id uuid
) language plpgsql security definer set search_path = '' as $$
declare
  normalized_email text;
  linked_booking public.bookings%rowtype;
  existing_case record;
  created_case_id uuid;
  created_notification_id uuid;
  requires_booking boolean;
begin
  if private.current_customer_id() is not null
    or private.current_cleaner_id() is not null
    or requested_idempotency_hash is null
    or requested_idempotency_hash !~ '^[0-9a-f]{64}$'
    or requested_case_type not in (
      'reschedule', 'cancel', 'complaint', 'reclean',
      'refund_review', 'damage', 'other'
    )
    or requested_public_reference is null
    or char_length(requested_public_reference) not between 8 and 80
    or jsonb_typeof(requested_contact) is distinct from 'object'
    or jsonb_typeof(requested_consent_snapshot) is distinct from 'object'
    or char_length(trim(coalesce(requested_details, ''))) not between 1 and 6000 then
    raise exception 'Public service-case intake is invalid' using errcode = '22023';
  end if;
  normalized_email := lower(trim(coalesce(requested_contact ->> 'email', '')));
  if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or char_length(normalized_email) > 320
    or char_length(trim(coalesce(requested_contact ->> 'name', ''))) not between 2 and 200 then
    raise exception 'Public service-case contact is invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(requested_idempotency_hash, 0));
  select service_case.id, service_case.public_reference
    into existing_case
  from public.service_cases service_case
  where service_case.idempotency_key = requested_idempotency_hash;
  if found then
    return query select existing_case.id, existing_case.public_reference, true,
      'accepted'::text, null::uuid;
    return;
  end if;

  requires_booking := requested_case_type in (
    'reschedule', 'cancel', 'reclean', 'refund_review', 'damage'
  );
  if requested_booking_reference_hash is not null then
    if requested_booking_reference_hash !~ '^[0-9a-f]{64}$' then
      return query select null::uuid, null::text, false,
        'invalid_reference'::text, null::uuid;
      return;
    end if;
    select booking.id, booking.customer_id, booking.contact, booking.status,
           booking.is_dev_seed
      into linked_booking
    from public.bookings booking
    where booking.public_reference_token_hash = requested_booking_reference_hash
      and lower(trim(coalesce(booking.contact ->> 'email', ''))) = normalized_email
    for update;
    if not found then
      return query select null::uuid, null::text, false,
        'invalid_reference'::text, null::uuid;
      return;
    end if;
  elsif requires_booking then
    return query select null::uuid, null::text, false,
      'invalid_reference'::text, null::uuid;
    return;
  end if;

  if linked_booking.id is not null
    and requested_case_type in ('reschedule', 'cancel')
    and (
      linked_booking.status not in (
        'requested', 'reviewing', 'ready', 'confirmed', 'scheduled'
      )
      or exists (
        select 1 from public.job_schedules schedule
        where schedule.booking_id = linked_booking.id
          and schedule.status not in ('tentative', 'held', 'confirmed')
      )
    ) then
    return query select null::uuid, null::text, false,
      'invalid_lifecycle'::text, null::uuid;
    return;
  end if;

  if linked_booking.id is not null and requested_case_type = 'reschedule' then
    perform pg_advisory_xact_lock(hashtextextended(linked_booking.id::text, 1));
    select service_case.id, service_case.public_reference
      into existing_case
    from public.service_cases service_case
    where service_case.booking_id = linked_booking.id
      and service_case.case_type = 'reschedule'
      and service_case.status not in ('resolved', 'closed', 'declined', 'canceled')
    order by service_case.created_at desc, service_case.id desc
    limit 1;
    if found then
      return query select existing_case.id, existing_case.public_reference,
        true, 'accepted'::text, null::uuid;
      return;
    end if;
  end if;

  created_case_id := gen_random_uuid();
  insert into private.public_service_case_write_authorizations
    (service_case_id, backend_pid, transaction_id)
  values (created_case_id, pg_backend_pid(), pg_current_xact_id());
  insert into public.service_cases
    (id, public_reference, idempotency_key, case_type, booking_id, customer_id,
     contact, details, preferred_date, alternate_date, status, priority,
     consent_snapshot, consented_at, first_response_due_at, is_dev_seed)
  values (
    created_case_id, requested_public_reference, requested_idempotency_hash,
    requested_case_type, linked_booking.id, linked_booking.customer_id,
    requested_contact, trim(requested_details), requested_preferred_date,
    requested_alternate_date, 'submitted', 'normal', requested_consent_snapshot,
    clock_timestamp(), clock_timestamp() + interval '4 hours',
    coalesce(linked_booking.is_dev_seed, false)
  );
  insert into public.notification_outbox
    (service_case_id, customer_id, notification_type, channel, recipient_kind,
     template_key, template_data, deduplication_key, next_attempt_at, is_dev_seed)
  values (
    created_case_id, linked_booking.customer_id, 'ops_notification', 'email',
    'ops', 'ops-service-case', jsonb_build_object('serviceCaseId', created_case_id),
    'service-case:' || created_case_id::text || ':ops_notification',
    clock_timestamp() + interval '15 minutes',
    coalesce(linked_booking.is_dev_seed, false)
  )
  returning id into created_notification_id;
  return query select created_case_id, requested_public_reference, false,
    'accepted'::text, created_notification_id;
end
$$;

revoke all on function private.create_public_service_case(
  text, text, text, text, jsonb, text, date, date, jsonb
) from public;
grant execute on function private.create_public_service_case(
  text, text, text, text, jsonb, text, date, date, jsonb
) to lakeandpine_app;

create function private.guard_service_case_actor() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  linked_booking record;
  actor_contact jsonb;
begin
  if not private.application_role_is_active() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Service-case history cannot be deleted by the application'
      using errcode = '42501';
  end if;
  if tg_op = 'INSERT'
    and private.consume_public_service_case_write_authorization(new.id) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if private.current_customer_id() is not null
      and private.current_cleaner_id() is null
      and new.customer_id = private.current_customer_id() then
      if new.booking_id is not null then
        select booking.customer_id, booking.contact, booking.is_dev_seed
          into linked_booking
        from public.bookings booking
        where booking.id = new.booking_id
          and booking.customer_id = private.current_customer_id()
        for share;
        if not found then
          raise exception 'Customer service case must use an owned booking'
            using errcode = '42501';
        end if;
        new.contact := linked_booking.contact;
        new.is_dev_seed := linked_booking.is_dev_seed;
      else
        select jsonb_strip_nulls(jsonb_build_object(
            'name', customer.full_name,
            'email', customer.email,
            'phone', customer.phone
          )) into actor_contact
        from public.customers customer
        where customer.id = private.current_customer_id();
        new.contact := coalesce(actor_contact, '{}'::jsonb);
        new.is_dev_seed := false;
      end if;
      if new.idempotency_key is not null
        or new.status <> 'submitted'
        or new.priority <> 'normal'
        or new.resolution_type is not null
        or new.resolution_summary is not null
        or new.assigned_cleaner_id is not null
        or new.assigned_team_id is not null
        or new.resolved_at is not null
        or new.closed_at is not null then
        raise exception 'Customer case must begin as an unassigned submission'
          using errcode = '42501';
      end if;
      new.first_response_due_at := clock_timestamp() + interval '4 hours';
      return new;
    end if;

    if private.current_cleaner_id() is not null
      or private.current_customer_id() is null
      or not private.current_staff_can_manage_service_case_scope(
        new.booking_id, new.assigned_team_id
      )
      or new.status <> 'submitted'
      or new.priority <> 'normal'
      or new.resolution_type is not null
      or new.resolution_summary is not null
      or new.assigned_cleaner_id is not null
      or new.resolved_at is not null
      or new.closed_at is not null
      or (
        new.booking_id is not null
        and not exists (
          select 1 from public.bookings booking
          where booking.id = new.booking_id
            and booking.customer_id is not distinct from new.customer_id
        )
      ) then
      raise exception 'Raw service-case creation requires scoped staff or its customer'
        using errcode = '42501';
    end if;
    new.first_response_due_at := coalesce(
      new.first_response_due_at, clock_timestamp() + interval '4 hours'
    );
    return new;
  end if;

  -- Allocation creation may attach an exact branch to previously unallocated
  -- booking cases. This nested change cannot alter any case content or state.
  if pg_trigger_depth() > 1
    and old.assigned_team_id is null and new.assigned_team_id is not null
    and (to_jsonb(new) - 'assigned_team_id' - 'updated_at')
      = (to_jsonb(old) - 'assigned_team_id' - 'updated_at')
    and exists (
      select 1
      from public.job_schedules schedule
      join public.team_job_allocations allocation
        on allocation.job_schedule_id = schedule.id
      where schedule.booking_id = old.booking_id
        and allocation.team_id = new.assigned_team_id
    ) then
    return new;
  end if;

  if private.current_customer_id() = old.customer_id
    and private.current_cleaner_id() is null then
    if old.status <> 'awaiting_customer'
      or new.status <> 'action_planned'
      or new.resolution_type is not null
      or new.resolution_summary is not null
      or new.resolved_at is not null
      or new.closed_at is not null
      or (to_jsonb(new)
        - 'status' - 'resolution_type' - 'resolution_summary'
        - 'resolved_at' - 'closed_at' - 'updated_at')
        <> (to_jsonb(old)
        - 'status' - 'resolution_type' - 'resolution_summary'
        - 'resolved_at' - 'closed_at' - 'updated_at')
      or (old.case_type = 'reschedule' and not exists (
        select 1 from public.schedule_proposals proposal
        where proposal.service_case_id = old.id
          and proposal.status = 'changes_requested'
      )) then
      raise exception 'Customer may only return an awaiting case without changing evidence'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if private.current_cleaner_id() is not null
    or private.current_customer_id() is null
    or not private.current_staff_can_manage_service_case(old.id)
    or new.id <> old.id
    or new.public_reference <> old.public_reference
    or new.idempotency_key is distinct from old.idempotency_key
    or new.case_type <> old.case_type
    or new.booking_id is distinct from old.booking_id
    or new.customer_id is distinct from old.customer_id
    or new.assigned_team_id is distinct from old.assigned_team_id
    or new.is_dev_seed <> old.is_dev_seed
    or new.created_at is distinct from old.created_at then
    raise exception 'Service-case update is outside the actor branch scope'
      using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger service_cases_actor_guard
  before insert or update or delete on service_cases for each row
  execute function private.guard_service_case_actor();
revoke all on function private.guard_service_case_actor() from public;

drop policy lakeandpine_app_all_service_cases on service_cases;
create policy service_cases_read
  on service_cases for select to lakeandpine_app using (
    private.current_staff_can_manage_service_case(id)
    or (
      private.current_cleaner_id() is null
      and private.current_customer_id() is not null
      and (
        customer_id = private.current_customer_id()
        or exists (
          select 1 from bookings booking
          where booking.id = service_cases.booking_id
            and booking.customer_id = private.current_customer_id()
        )
      )
    )
  );
create policy service_cases_insert
  on service_cases for insert to lakeandpine_app with check (
    (
      private.current_cleaner_id() is null
      and customer_id = private.current_customer_id()
      and status = 'submitted'
      and (booking_id is null or exists (
        select 1 from bookings booking
        where booking.id = service_cases.booking_id
          and booking.customer_id = private.current_customer_id()
      ))
    )
    or (
      status = 'submitted'
      and private.current_staff_can_manage_service_case_scope(
        booking_id, assigned_team_id
      )
    )
  );
create policy service_cases_update
  on service_cases for update to lakeandpine_app using (
    private.current_staff_can_manage_service_case(id)
    or (
      private.current_cleaner_id() is null
      and customer_id = private.current_customer_id()
    )
  ) with check (
    private.current_staff_can_manage_service_case(id)
    or (
      private.current_cleaner_id() is null
      and customer_id = private.current_customer_id()
    )
  );
create policy service_cases_delete_denied
  on service_cases for delete to lakeandpine_app using (false);

revoke all on function private.current_staff_can_manage_service_case_scope(uuid, uuid) from public;
revoke all on function private.current_staff_can_manage_service_case(uuid) from public;
grant execute on function private.current_staff_can_manage_service_case_scope(uuid, uuid) to lakeandpine_app;
grant execute on function private.current_staff_can_manage_service_case(uuid) to lakeandpine_app;

-- Booking rows hold the customer address, access notes, consent, and planning
-- spine. Reads are customer-, branch-, or assigned-cleaner scoped; guest retry
-- possession reveals only the UUID attached to one unguessable idempotency hash.
create function private.current_staff_can_access_booking(
  requested_booking_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and exists (
      select 1 from public.bookings booking
      where booking.id = requested_booking_id
        and (
          private.can_access_organization(
            private.lakeandpine_intake_organization_id(), array['owner', 'gm']
          )
          or exists (
            select 1
            from public.job_schedules schedule
            join public.team_job_allocations allocation
              on allocation.job_schedule_id = schedule.id
            where schedule.booking_id = booking.id
              and private.can_access_team(
                allocation.organization_id, allocation.team_id,
                array['manager', 'shift_lead']
              )
          )
        )
    )
$$;

create function private.current_manager_can_update_booking(
  requested_booking_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and exists (
      select 1 from public.bookings booking
      where booking.id = requested_booking_id
        and (
          private.can_access_organization(
            private.lakeandpine_intake_organization_id(), array['owner', 'gm']
          )
          or exists (
            select 1
            from public.job_schedules schedule
            join public.team_job_allocations allocation
              on allocation.job_schedule_id = schedule.id
            where schedule.booking_id = booking.id
              and private.can_access_team(
                allocation.organization_id, allocation.team_id,
                array['manager']
              )
          )
        )
    )
$$;

create function private.current_customer_can_claim_booking(
  requested_booking_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and exists (
      select 1
      from public.bookings booking
      join public.customers actor
        on actor.id = private.current_customer_id()
       and actor.clerk_user_id is not null
       and actor.email is not null
       and lower(trim(actor.email))
         = lower(trim(coalesce(booking.contact ->> 'email', '')))
      left join public.customers prior on prior.id = booking.customer_id
      where booking.id = requested_booking_id
        and (
          booking.customer_id is null
          or booking.customer_id = actor.id
          or (
            lower(trim(coalesce(prior.email, ''))) = lower(trim(actor.email))
            and (prior.clerk_user_id is null
              or prior.clerk_user_id = actor.clerk_user_id)
          )
        )
    )
$$;

create function private.current_intake_booking_by_idempotency(
  requested_idempotency_hash text
) returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
  matched_booking_id uuid;
begin
  if private.current_cleaner_id() is not null
    or requested_idempotency_hash is null
    or requested_idempotency_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Booking retry identity is invalid' using errcode = '42501';
  end if;
  select booking.id into matched_booking_id
  from public.bookings booking
  where booking.idempotency_key = requested_idempotency_hash
  limit 1;
  return matched_booking_id;
end
$$;

create function private.guard_booking_actor_boundary() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.application_role_is_active() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Booking history cannot be deleted by the application'
      using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if private.current_cleaner_id() is not null
      or (private.current_customer_id() is null and new.customer_id is not null)
      or (private.current_customer_id() is not null
        and new.customer_id is distinct from private.current_customer_id())
      or (new.customer_id is not null and not exists (
        select 1 from public.customers customer
        where customer.id = new.customer_id
          and customer.clerk_user_id is not null
          and lower(trim(coalesce(customer.email, '')))
            = lower(trim(coalesce(new.contact ->> 'email', '')))
      ))
      or new.status <> 'requested'
      or new.service_vertical is null
      or new.service_id <> new.service_vertical
      or new.territory_id is not null
      or new.home_id is not null
      or new.estimate_cents is not null
      or new.quote_id is not null
      or new.qualification_status not in ('requested', 'walkthrough_needed')
      or new.request_source not in ('web_booking', 'runtime_smoke')
      or new.idempotency_key is null
      or new.public_reference_token_hash is null
      or jsonb_typeof(new.contact) is distinct from 'object'
      or jsonb_typeof(new.consent_snapshot) is distinct from 'object'
      or new.consented_at is null
      or new.consent_version is null
      or new.consent_notice_date is null
      or new.scheduled_date < current_date
      or new.scheduled_date > (current_date + interval '18 months')::date
      or (new.request_source = 'runtime_smoke') is distinct from new.is_dev_seed then
      raise exception 'Booking INSERT must be a consented premium intake request'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if private.current_customer_can_claim_booking(old.id)
    and new.customer_id = private.current_customer_id()
    and (to_jsonb(new) - 'customer_id' - 'updated_at')
      = (to_jsonb(old) - 'customer_id' - 'updated_at') then
    return new;
  end if;

  -- Schedule synchronization is the sole cleaner-driven booking mutation. It
  -- may change only the mirrored status, territory, date, and display window.
  if pg_trigger_depth() > 1
    and (to_jsonb(new)
      - 'status' - 'territory_id' - 'scheduled_date'
      - 'scheduled_window' - 'updated_at')
      = (to_jsonb(old)
      - 'status' - 'territory_id' - 'scheduled_date'
      - 'scheduled_window' - 'updated_at')
    and (
      private.cleaner_assigned_to_booking(old.id)
      or exists (
        select 1 from public.job_schedules schedule
        where schedule.booking_id = old.id
          and private.current_staff_can_manage_job_schedule(schedule.id)
      )
    ) then
    return new;
  end if;

  if private.current_cleaner_id() is not null
    or private.current_customer_id() is null
    or not private.current_manager_can_update_booking(old.id)
    or (to_jsonb(new)
      - 'status' - 'qualification_status' - 'qualification_requirements'
      - 'scheduled_date' - 'scheduled_window' - 'updated_at')
      <> (to_jsonb(old)
      - 'status' - 'qualification_status' - 'qualification_requirements'
      - 'scheduled_date' - 'scheduled_window' - 'updated_at') then
    raise exception 'Booking mutation is outside customer or scoped staff authority'
      using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger bookings_actor_boundary_guard
  before insert or update or delete on bookings for each row
  execute function private.guard_booking_actor_boundary();

drop policy lakeandpine_app_all_bookings on bookings;
create policy bookings_read
  on bookings for select to lakeandpine_app using (
    customer_id = private.current_customer_id()
    or private.current_staff_can_access_booking(id)
    or private.cleaner_assigned_to_booking(id)
  );
create policy bookings_insert
  on bookings for insert to lakeandpine_app with check (
    private.current_cleaner_id() is null
    and (
      (private.current_customer_id() is null and customer_id is null)
      or customer_id = private.current_customer_id()
    )
    and status = 'requested'
    and request_source in ('web_booking', 'runtime_smoke')
  );
create policy bookings_update
  on bookings for update to lakeandpine_app using (
    private.current_manager_can_update_booking(id)
    or private.current_customer_can_claim_booking(id)
  ) with check (
    private.current_manager_can_update_booking(id)
    or private.current_customer_can_claim_booking(id)
  );
create policy bookings_delete_denied
  on bookings for delete to lakeandpine_app using (false);

revoke all on function private.current_staff_can_access_booking(uuid) from public;
revoke all on function private.current_manager_can_update_booking(uuid) from public;
revoke all on function private.current_customer_can_claim_booking(uuid) from public;
revoke all on function private.current_intake_booking_by_idempotency(text) from public;
revoke all on function private.guard_booking_actor_boundary() from public;
grant execute on function private.current_staff_can_access_booking(uuid) to lakeandpine_app;
grant execute on function private.current_manager_can_update_booking(uuid) to lakeandpine_app;
grant execute on function private.current_customer_can_claim_booking(uuid) to lakeandpine_app;
grant execute on function private.current_intake_booking_by_idempotency(text) to lakeandpine_app;
revoke update on table bookings from lakeandpine_app;
grant update (
  customer_id, status, qualification_status, qualification_requirements,
  scheduled_date, scheduled_window
) on table bookings to lakeandpine_app;

-- Inherited lifecycle triggers validate or derive trusted state across tables.
-- They run with the migration owner's visibility so later RLS tightening cannot
-- hide evidence from an invariant check. Direct execution remains unavailable.
create or replace function public.validate_quality_review_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  booking_customer_id uuid;
  schedule_status text;
begin
  select booking.customer_id, schedule.status
    into booking_customer_id, schedule_status
  from public.team_job_allocations allocation
  join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
  join public.bookings booking on booking.id = schedule.booking_id
  join public.job_assignments assignment
    on assignment.job_schedule_id = schedule.id
    and assignment.cleaner_id = new.cleaner_id
    and assignment.status in ('accepted','confirmed')
  where allocation.id = new.team_job_allocation_id
    and allocation.organization_id = new.organization_id
    and allocation.team_id = new.team_id;
  if booking_customer_id is null then
    raise exception 'Quality review requires a cleaner who worked the allocated job'
      using errcode = '23514';
  end if;
  if new.source = 'verified_customer' then
    if schedule_status <> 'completed'
      or new.customer_id is distinct from booking_customer_id then
      raise exception 'Customer review requires completed work and the booking customer'
        using errcode = '23514';
    end if;
  elsif schedule_status not in ('quality_review','completed') then
    raise exception 'Quality evidence is accepted only during closeout or after completion'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.validate_job_assignment_capacity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  requested_start timestamptz;
  requested_end timestamptz;
  requested_territory uuid;
  requested_travel_buffer integer;
  requested_crew_size integer;
  accepted_count integer;
begin
  if new.status not in ('accepted', 'confirmed') then
    return new;
  end if;
  select schedule.start_at, schedule.end_at, schedule.territory_id,
         schedule.travel_buffer_minutes, schedule.required_crew_size
    into requested_start, requested_end, requested_territory,
         requested_travel_buffer, requested_crew_size
  from public.job_schedules schedule
  where schedule.id = new.job_schedule_id
  for update;
  if requested_start is null then
    raise exception 'Assignment schedule % does not exist', new.job_schedule_id
      using errcode = '23503';
  end if;
  select count(distinct assignment.cleaner_id)::integer
    into accepted_count
  from public.job_assignments assignment
  where assignment.job_schedule_id = new.job_schedule_id
    and assignment.status in ('accepted', 'confirmed')
    and assignment.id <> new.id;
  if accepted_count + 1 > requested_crew_size then
    raise exception 'Schedule % cannot accept more than % cleaners',
      new.job_schedule_id, requested_crew_size using errcode = '23514';
  end if;
  perform public.assert_cleaner_schedule_capacity(
    new.cleaner_id, new.job_schedule_id, requested_start, requested_end,
    requested_territory, requested_travel_buffer
  );
  return new;
end
$$;

create or replace function public.validate_job_schedule_readiness() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  booking_qualification text;
  booking_state text;
  booking_vertical text;
  booking_postal text;
  territory_state text;
  assigned_cleaner record;
  accepted_count integer;
  accepted_skills text[];
  required_elapsed_minutes integer;
begin
  if new.status = 'canceled' then
    if tg_op = 'INSERT' then
      raise exception 'A schedule cannot be created in canceled state'
        using errcode = '23514';
    end if;
    return new;
  end if;
  required_elapsed_minutes :=
    ceil(new.labor_minutes::numeric / new.required_crew_size / 30) * 30;
  if extract(epoch from (new.end_at - new.start_at)) / 60
      < required_elapsed_minutes then
    raise exception 'Schedule % needs at least % elapsed minutes for % labor minutes and % cleaners',
      new.id, required_elapsed_minutes, new.labor_minutes, new.required_crew_size
      using errcode = '23514';
  end if;

  select booking.qualification_status, booking.status, booking.service_vertical,
         public.normalize_us_postal_code(booking.contact ->> 'zip')
    into booking_qualification, booking_state, booking_vertical, booking_postal
  from public.bookings booking where booking.id = new.booking_id;
  select territory.status into territory_state
  from public.service_territories territory where territory.id = new.territory_id;

  if territory_state is distinct from 'active' then
    raise exception 'Schedule territory % must be active', new.territory_id
      using errcode = '23514';
  end if;
  if (tg_op = 'INSERT' and booking_state not in ('requested', 'reviewing', 'ready'))
     or booking_state in ('completed', 'follow_up', 'canceled') then
    raise exception 'Booking % in state % is not eligible for schedule mutation',
      new.booking_id, booking_state using errcode = '23514';
  end if;
  if booking_postal is null or not exists (
    select 1 from public.territory_postal_codes postal
    where postal.territory_id = new.territory_id
      and postal.status = 'active'
      and public.normalize_us_postal_code(postal.postal_code) = booking_postal
  ) then
    raise exception 'Booking % postal code is not active in schedule territory %',
      new.booking_id, new.territory_id using errcode = '23514';
  end if;
  if booking_vertical is not null
      and booking_vertical is distinct from new.service_vertical then
    raise exception 'Schedule vertical % does not match booking vertical %',
      new.service_vertical, booking_vertical using errcode = '23514';
  end if;

  if new.status in ('confirmed', 'en_route', 'in_progress', 'quality_review', 'completed') then
    if booking_qualification is distinct from 'approved' then
      raise exception 'Booking % must be qualification-approved before schedule confirmation',
        new.booking_id using errcode = '23514';
    end if;
    select count(distinct assignment.cleaner_id)::integer,
           coalesce(array_agg(distinct skill) filter (where skill is not null), '{}')
      into accepted_count, accepted_skills
    from public.job_assignments assignment
    join public.cleaners cleaner on cleaner.id = assignment.cleaner_id
    left join lateral unnest(cleaner.skills) skill on true
    where assignment.job_schedule_id = new.id
      and assignment.status in ('accepted', 'confirmed');
    if accepted_count <> new.required_crew_size then
      raise exception 'Schedule % needs exactly % accepted cleaners before confirmation; found %',
        new.id, new.required_crew_size, accepted_count using errcode = '23514';
    end if;
    if not new.required_skills <@ accepted_skills then
      raise exception 'Accepted crew for schedule % does not cover every required skill',
        new.id using errcode = '23514';
    end if;
  end if;

  for assigned_cleaner in
    select assignment.cleaner_id from public.job_assignments assignment
    where assignment.job_schedule_id = new.id
      and assignment.status in ('accepted', 'confirmed')
  loop
    perform public.assert_cleaner_schedule_capacity(
      assigned_cleaner.cleaner_id, new.id, new.start_at, new.end_at,
      new.territory_id, new.travel_buffer_minutes
    );
  end loop;
  return new;
end
$$;

create or replace function public.synchronize_booking_from_schedule() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  synchronized_status text;
  derived_event_type text;
begin
  synchronized_status := case
    when new.status in ('tentative', 'held') then 'ready'
    when new.status = 'confirmed' then 'scheduled'
    when new.status in ('en_route', 'in_progress', 'quality_review') then 'in_progress'
    when new.status = 'completed' then 'completed'
    when new.status = 'canceled' then 'canceled'
  end;

  update public.bookings booking
  set status = synchronized_status,
      territory_id = new.territory_id,
      scheduled_date = (new.start_at at time zone territory.timezone)::date,
      scheduled_window = case
        when new.status = 'canceled' then booking.scheduled_window
        else to_char(new.start_at at time zone territory.timezone, 'FMHH12:MI AM')
          || '–' || to_char(new.end_at at time zone territory.timezone, 'FMHH12:MI AM')
          || ' ' || territory.timezone
      end
  from public.service_territories territory
  where booking.id = new.booking_id and territory.id = new.territory_id;

  derived_event_type := case
    when tg_op = 'INSERT' then 'schedule_created'
    when old.status is distinct from new.status then 'schedule_status_changed'
    else 'schedule_rescheduled'
  end;
  insert into public.booking_events (booking_id, type, data)
  values (
    new.booking_id,
    derived_event_type,
    jsonb_build_object(
      'scheduleId', new.id,
      'scheduleStatus', new.status,
      'bookingStatus', synchronized_status
    )
  );

  if new.status = 'completed' then
    insert into public.follow_ups
      (booking_id, kind, channel, status, scheduled_for, is_dev_seed)
    select new.booking_id, follow_up.kind, 'manual', 'planned',
      clock_timestamp() + follow_up.delay, booking.is_dev_seed
    from public.bookings booking
    cross join (values
      ('service_check_in'::text, interval '2 hours'),
      ('review_request'::text, interval '24 hours')
    ) as follow_up(kind, delay)
    where booking.id = new.booking_id
    on conflict (booking_id, kind) do nothing;
  end if;
  return new;
end
$$;

create or replace function public.create_verified_review_bonus() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  tier public.review_bonus_tiers%rowtype;
  cleaner_membership public.workforce_memberships%rowtype;
begin
  if new.source <> 'verified_customer' or new.verified_at is null then
    return new;
  end if;
  select membership.* into cleaner_membership
  from public.workforce_memberships membership
  where membership.organization_id = new.organization_id
    and membership.team_id = new.team_id
    and membership.cleaner_id = new.cleaner_id
    and membership.role in ('cleaner','shift_lead')
    and membership.status = 'active'
  limit 1;
  if cleaner_membership.id is null then return new; end if;

  select candidate.* into tier
  from public.review_bonus_tiers candidate
  where candidate.organization_id = new.organization_id
    and (candidate.team_id is null or candidate.team_id = new.team_id)
    and candidate.active
    and new.rating >= candidate.minimum_rating
  order by candidate.minimum_rating desc, candidate.bonus_cents desc
  limit 1;
  if tier.id is null then return new; end if;

  insert into public.bonus_awards
    (organization_id, team_id, workforce_membership_id, quality_review_id,
     bonus_tier_id, amount_cents, reason, status, is_dev_seed)
  values
    (new.organization_id, new.team_id, cleaner_membership.id, new.id,
     tier.id, tier.bonus_cents, tier.name || ' — verified customer review',
     'proposed', new.is_dev_seed)
  on conflict do nothing;
  return new;
end
$$;

revoke all on function public.validate_job_schedule_readiness() from public;
revoke all on function public.validate_job_schedule_readiness() from lakeandpine_app;
revoke all on function public.validate_quality_review_evidence() from public;
revoke all on function public.validate_quality_review_evidence() from lakeandpine_app;
revoke all on function public.validate_job_assignment_capacity() from public;
revoke all on function public.validate_job_assignment_capacity() from lakeandpine_app;
revoke all on function public.synchronize_booking_from_schedule() from public;
revoke all on function public.synchronize_booking_from_schedule() from lakeandpine_app;
revoke all on function public.create_verified_review_bonus() from public;
revoke all on function public.create_verified_review_bonus() from lakeandpine_app;

-- Refund decisions are operational/financial records. They inherit exactly the
-- linked case's owner/GM/branch-manager scope and are never customer- or
-- cleaner-writable raw rows.
alter table refund_records
  add column requested_by_customer_id uuid references customers(id) on delete restrict,
  add column approved_by_customer_id uuid references customers(id) on delete restrict;
create index refund_records_requested_by_customer_idx
  on refund_records (requested_by_customer_id)
  where requested_by_customer_id is not null;
create index refund_records_approved_by_customer_idx
  on refund_records (approved_by_customer_id)
  where approved_by_customer_id is not null;

create or replace function public.validate_refund_integrity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  case_booking_id uuid;
  case_kind text;
  case_state text;
  case_is_dev_seed boolean;
  billing_booking_id uuid;
  billing_amount integer;
  billing_state text;
  billing_is_dev_seed boolean;
  committed_amount integer;
  actor_customer_id uuid;
  actor_label text;
begin
  if private.application_role_is_active() then
    actor_customer_id := private.current_customer_id();
    if actor_customer_id is null
      or private.current_cleaner_id() is not null
      or not private.current_staff_can_manage_service_case(new.service_case_id) then
      raise exception 'Refund mutation requires scoped owner, GM, or manager authority'
        using errcode = '42501';
    end if;
    select coalesce(
      nullif(trim(customer.full_name), ''),
      'Staff ' || left(customer.id::text, 8)
    ) into actor_label
    from public.customers customer
    where customer.id = actor_customer_id;
    if actor_label is null then
      raise exception 'Refund actor identity is unavailable' using errcode = '42501';
    end if;

    if tg_op = 'INSERT' then
      if new.status <> 'requested'
        or new.provider <> 'manual'
        or new.provider_refund_id is not null
        or new.approved_by_label is not null
        or new.approved_by_customer_id is not null
        or new.approved_at is not null
        or new.processed_at is not null
        or new.failure_code is not null
        or new.reason_code !~ '^[a-z0-9][a-z0-9_-]{0,79}$' then
        raise exception 'A refund must begin as one bounded manual review request'
          using errcode = '42501';
      end if;
      new.requested_by_customer_id := actor_customer_id;
      new.requested_by_label := actor_label;
      new.requested_at := clock_timestamp();
      new.provider := 'manual';
    else
      if new.id <> old.id
        or new.service_case_id <> old.service_case_id
        or new.booking_id <> old.booking_id
        or new.billing_record_id <> old.billing_record_id
        or new.amount_cents <> old.amount_cents
        or new.currency <> old.currency
        or new.reason_code <> old.reason_code
        or new.provider <> old.provider
        or new.requested_by_customer_id is distinct from old.requested_by_customer_id
        or new.requested_by_label <> old.requested_by_label
        or new.requested_at is distinct from old.requested_at
        or new.is_dev_seed <> old.is_dev_seed
        or new.created_at is distinct from old.created_at
        or new.approved_by_customer_id is distinct from old.approved_by_customer_id
        or new.approved_by_label is distinct from old.approved_by_label
        or new.approved_at is distinct from old.approved_at
        or new.processed_at is distinct from old.processed_at then
        raise exception 'Refund financial subject, attribution, and receipts are immutable'
          using errcode = '42501';
      end if;
      if not (
        (old.status = 'requested' and new.status in ('approved','declined','canceled'))
        or (old.status = 'approved'
          and new.status in ('ready_for_manual_processing','canceled'))
        or (old.status = 'ready_for_manual_processing'
          and new.status in ('processed','failed','canceled'))
        or (old.status = 'failed'
          and new.status in ('ready_for_manual_processing','canceled'))
      ) then
        raise exception 'Refund status transition is not allowed'
          using errcode = '55000';
      end if;
      if new.status = 'approved' then
        new.approved_by_customer_id := actor_customer_id;
        new.approved_by_label := actor_label;
        new.approved_at := clock_timestamp();
      end if;
      if new.status = 'processed' then
        new.provider_refund_id := nullif(trim(new.provider_refund_id), '');
        if char_length(coalesce(new.provider_refund_id, '')) not between 4 and 255 then
          raise exception 'Processed refunds require a bounded external provider receipt'
            using errcode = '23514';
        end if;
        new.processed_at := clock_timestamp();
        new.failure_code := null;
      elsif new.provider_refund_id is distinct from old.provider_refund_id then
        raise exception 'A provider receipt may be recorded only while processing a refund'
          using errcode = '42501';
      end if;
      if new.status = 'failed' then
        new.failure_code := left(
          coalesce(nullif(trim(new.failure_code), ''), 'manual_processing_failed'),
          120
        );
      elsif new.status = 'ready_for_manual_processing' then
        new.failure_code := null;
      elsif new.failure_code is distinct from old.failure_code then
        raise exception 'Failure evidence may change only on a processing failure or retry'
          using errcode = '42501';
      end if;
    end if;
  end if;

  select service_case.booking_id, service_case.case_type, service_case.status,
      service_case.is_dev_seed
    into case_booking_id, case_kind, case_state, case_is_dev_seed
  from public.service_cases service_case
  where service_case.id = new.service_case_id
  for update;
  if case_booking_id is distinct from new.booking_id
     or case_kind not in ('refund_review', 'complaint', 'reclean', 'damage')
     or case_state <> 'refund_pending' then
    raise exception 'Refund requires a refund-eligible case in refund_pending for the same booking'
      using errcode = '23514';
  end if;

  select billing.booking_id, billing.amount_cents, billing.status,
      billing.is_dev_seed
    into billing_booking_id, billing_amount, billing_state, billing_is_dev_seed
  from public.billing_records billing
  where billing.id = new.billing_record_id
  for update;
  if billing_booking_id is distinct from new.booking_id or billing_state <> 'paid' then
    raise exception 'Refund requires a paid billing record for the same booking'
      using errcode = '23514';
  end if;
  if case_is_dev_seed is distinct from billing_is_dev_seed then
    raise exception 'Refund case and billing environment must match'
      using errcode = '23514';
  end if;
  if private.application_role_is_active() then
    new.is_dev_seed := case_is_dev_seed;
  end if;

  select coalesce(sum(refund.amount_cents), 0)::integer into committed_amount
  from public.refund_records refund
  where refund.billing_record_id = new.billing_record_id
    and refund.id <> new.id
    and refund.status not in ('declined', 'failed', 'canceled');
  if new.status not in ('declined', 'failed', 'canceled') then
    committed_amount := committed_amount + new.amount_cents;
  end if;
  if committed_amount > billing_amount then
    raise exception 'Refund decisions exceed the paid billing amount'
      using errcode = '23514';
  end if;
  if new.status = 'processed' and new.provider_refund_id is null then
    raise exception 'Processed refunds require an external provider receipt'
      using errcode = '23514';
  end if;
  return new;
end
$$;

revoke all on function public.validate_refund_integrity() from public;
revoke all on function public.validate_refund_integrity() from lakeandpine_app;

drop policy lakeandpine_app_all_refund_records on refund_records;
revoke insert, update on table refund_records from lakeandpine_app;
grant insert (
  service_case_id, booking_id, billing_record_id, amount_cents, reason_code
) on refund_records to lakeandpine_app;
grant update (
  status, provider_refund_id, failure_code, operator_note
) on refund_records to lakeandpine_app;
create policy refund_records_read
  on refund_records for select to lakeandpine_app using (
    private.current_staff_can_manage_service_case(service_case_id)
  );
create policy refund_records_insert
  on refund_records for insert to lakeandpine_app with check (
    private.current_staff_can_manage_service_case(service_case_id)
  );
create policy refund_records_update
  on refund_records for update to lakeandpine_app using (
    private.current_staff_can_manage_service_case(service_case_id)
  ) with check (
    private.current_staff_can_manage_service_case(service_case_id)
  );
create policy refund_records_delete_denied
  on refund_records for delete to lakeandpine_app using (false);

-- Inherited account and public-intake privacy boundary -----------------------

-- A staff actor can see a customer identity only at national scope, through a
-- branch that actually serves that customer, or as a historical/current staff
-- subject of that branch. Ordinary customer identity reads remain self-only.
create function private.current_staff_can_access_customer(
  requested_customer_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and (
      private.can_access_organization(
        private.lakeandpine_intake_organization_id(), array['owner', 'gm']
      )
      or exists (
        select 1
        from public.workforce_memberships subject
        where subject.customer_id = requested_customer_id
          and subject.organization_id = private.lakeandpine_intake_organization_id()
          and subject.team_id is not null
          and private.can_access_team(
            subject.organization_id, subject.team_id,
            array['manager', 'shift_lead']
          )
      )
      or exists (
        select 1
        from public.bookings booking
        join public.job_schedules schedule on schedule.booking_id = booking.id
        join public.team_job_allocations allocation
          on allocation.job_schedule_id = schedule.id
        where booking.customer_id = requested_customer_id
          and private.can_access_team(
            allocation.organization_id, allocation.team_id,
            array['manager', 'shift_lead']
          )
      )
    )
$$;

create function private.current_staff_can_access_cleaner(
  requested_cleaner_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and (
      private.can_access_organization(
        private.lakeandpine_intake_organization_id(), array['owner', 'gm']
      )
      or exists (
        select 1
        from public.workforce_memberships subject
        where subject.cleaner_id = requested_cleaner_id
          and subject.organization_id = private.lakeandpine_intake_organization_id()
          and subject.team_id is not null
          and private.can_access_team(
            subject.organization_id, subject.team_id,
            array['manager', 'shift_lead']
          )
      )
    )
$$;

create function private.current_manager_can_update_cleaner(
  requested_cleaner_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and (
      private.can_access_organization(
        private.lakeandpine_intake_organization_id(), array['owner', 'gm']
      )
      or exists (
        select 1
        from public.workforce_memberships subject
        where subject.cleaner_id = requested_cleaner_id
          and subject.organization_id = private.lakeandpine_intake_organization_id()
          and subject.team_id is not null
          and subject.status = 'active'
          and subject.role in ('cleaner', 'shift_lead')
          and private.can_access_team(
            subject.organization_id, subject.team_id, array['manager']
          )
      )
    )
$$;

create function private.customer_identity_by_clerk_id(
  requested_clerk_user_id text
) returns table (
  id uuid,
  clerk_user_id text,
  email text,
  full_name text,
  phone text,
  role text,
  referral_credit_cents integer
) language plpgsql stable security definer set search_path = '' as $$
begin
  if requested_clerk_user_id is null
    or char_length(trim(requested_clerk_user_id)) not between 1 and 255
    or requested_clerk_user_id ~ '[[:cntrl:]]' then
    return;
  end if;
  return query
  select customer.id, customer.clerk_user_id, customer.email,
    customer.full_name, customer.phone, customer.role,
    customer.referral_credit_cents
  from public.customers customer
  where customer.clerk_user_id = requested_clerk_user_id
  limit 1;
end
$$;

create function private.customer_identity_by_verified_email(
  requested_verified_email text
) returns table (
  id uuid,
  clerk_user_id text,
  email text,
  full_name text,
  phone text,
  role text,
  referral_credit_cents integer
) language plpgsql stable security definer set search_path = '' as $$
declare
  normalized_email text := lower(trim(requested_verified_email));
begin
  if normalized_email is null
    or char_length(normalized_email) not between 5 and 320
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or (select count(*) from public.customers customer
        where lower(trim(customer.email)) = normalized_email) <> 1 then
    return;
  end if;
  return query
  select customer.id, customer.clerk_user_id, customer.email,
    customer.full_name, customer.phone, customer.role,
    customer.referral_credit_cents
  from public.customers customer
  where lower(trim(customer.email)) = normalized_email
  limit 1;
end
$$;

create function private.upsert_customer_from_verified_clerk_identity(
  requested_clerk_user_id text,
  requested_verified_email text,
  requested_full_name text,
  requested_phone text
) returns table (
  id uuid,
  clerk_user_id text,
  email text,
  full_name text,
  phone text,
  role text,
  referral_credit_cents integer
) language plpgsql security definer set search_path = '' as $$
declare
  normalized_email text := nullif(lower(trim(requested_verified_email)), '');
  normalized_name text := nullif(trim(requested_full_name), '');
  normalized_phone text := nullif(trim(requested_phone), '');
  matched_customer public.customers%rowtype;
  email_customer_ids uuid[];
  can_store_email boolean := false;
begin
  if requested_clerk_user_id is null
    or char_length(trim(requested_clerk_user_id)) not between 1 and 255
    or requested_clerk_user_id ~ '[[:cntrl:]]' then
    raise exception 'Verified Clerk identity is invalid' using errcode = '22023';
  end if;
  if normalized_email is not null and (
    char_length(normalized_email) not between 5 and 320
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ) then
    raise exception 'Verified email is invalid' using errcode = '22023';
  end if;
  if normalized_name is not null and char_length(normalized_name) > 200 then
    raise exception 'Customer name is too long' using errcode = '22023';
  end if;
  if normalized_phone is not null and char_length(normalized_phone) > 50 then
    raise exception 'Customer phone is too long' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('customer-clerk:' || requested_clerk_user_id, 9101)
  );
  if normalized_email is not null then
    perform pg_advisory_xact_lock(
      hashtextextended('customer-email:' || normalized_email, 9102)
    );
  end if;

  select customer.* into matched_customer
  from public.customers customer
  where customer.clerk_user_id = requested_clerk_user_id
  limit 1
  for update;

  if normalized_email is not null then
    perform 1
    from public.customers customer
    where lower(trim(customer.email)) = normalized_email
    order by customer.created_at, customer.id
    for update;
    select array_agg(customer.id order by customer.created_at, customer.id)
      into email_customer_ids
    from public.customers customer
    where lower(trim(customer.email)) = normalized_email;
  end if;

  if matched_customer.id is not null then
    can_store_email := normalized_email is not null
      and (
        coalesce(cardinality(email_customer_ids), 0) = 0
        or (
          cardinality(email_customer_ids) = 1
          and email_customer_ids[1] = matched_customer.id
        )
      );
    update public.customers customer
    set email = case when can_store_email then normalized_email else customer.email end,
        full_name = coalesce(normalized_name, customer.full_name),
        phone = coalesce(normalized_phone, customer.phone)
    where customer.id = matched_customer.id
    returning customer.* into matched_customer;
  elsif coalesce(cardinality(email_customer_ids), 0) = 1 then
    select customer.* into matched_customer
    from public.customers customer
    where customer.id = email_customer_ids[1]
    for update;
    if matched_customer.clerk_user_id is null
      or matched_customer.clerk_user_id = requested_clerk_user_id then
      update public.customers customer
      set clerk_user_id = requested_clerk_user_id,
          email = normalized_email,
          full_name = coalesce(normalized_name, customer.full_name),
          phone = coalesce(normalized_phone, customer.phone)
      where customer.id = matched_customer.id
      returning customer.* into matched_customer;
      can_store_email := true;
    else
      insert into public.customers
        (clerk_user_id, full_name, phone)
      values (requested_clerk_user_id, normalized_name, normalized_phone)
      returning * into matched_customer;
    end if;
  else
    can_store_email := normalized_email is not null
      and coalesce(cardinality(email_customer_ids), 0) = 0;
    insert into public.customers
      (clerk_user_id, email, full_name, phone)
    values (
      requested_clerk_user_id,
      case when can_store_email then normalized_email else null end,
      normalized_name, normalized_phone
    )
    returning * into matched_customer;
  end if;

  if can_store_email
    and lower(trim(coalesce(matched_customer.email, ''))) = normalized_email then
    perform set_config(
      'lakeandpine.current_customer_id', matched_customer.id::text, true
    );
    perform set_config('lakeandpine.current_cleaner_id', '', true);
    update public.bookings booking
    set customer_id = matched_customer.id
    where booking.customer_id is null
      and lower(trim(coalesce(booking.contact ->> 'email', ''))) = normalized_email;
  end if;

  return query
  select customer.id, customer.clerk_user_id, customer.email,
    customer.full_name, customer.phone, customer.role,
    customer.referral_credit_cents
  from public.customers customer
  where customer.id = matched_customer.id;
end
$$;

create table private.cleaner_identity_claim_authorizations (
  cleaner_id uuid primary key references public.cleaners(id) on delete cascade,
  external_auth_id text not null unique,
  backend_pid integer not null,
  transaction_id xid8 not null,
  created_at timestamptz not null default clock_timestamp()
);
revoke all on table private.cleaner_identity_claim_authorizations from public;
revoke all on table private.cleaner_identity_claim_authorizations from lakeandpine_app;

create function private.consume_cleaner_identity_claim(
  requested_cleaner_id uuid,
  requested_external_auth_id text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from private.cleaner_identity_claim_authorizations claim_auth
  where claim_auth.cleaner_id = requested_cleaner_id
    and claim_auth.external_auth_id = requested_external_auth_id
    and claim_auth.backend_pid = pg_backend_pid()
    and claim_auth.transaction_id = pg_current_xact_id();
  return found;
end
$$;

create function private.cleaner_identity_by_external_auth_id(
  requested_external_auth_id text
) returns table (
  id uuid,
  external_auth_id text,
  full_name text,
  email text,
  phone text,
  status text,
  skills text[],
  vertical_experience text[],
  home_territory_name text,
  home_territory_timezone text,
  max_daily_minutes integer,
  max_weekly_minutes integer,
  is_dev_seed boolean
) language plpgsql stable security definer set search_path = '' as $$
begin
  if requested_external_auth_id is null
    or char_length(trim(requested_external_auth_id)) not between 1 and 255
    or requested_external_auth_id ~ '[[:cntrl:]]' then
    return;
  end if;
  return query
  select cleaner.id, cleaner.external_auth_id, cleaner.full_name,
    cleaner.email, cleaner.phone, cleaner.status, cleaner.skills,
    cleaner.vertical_experience, territory.name, territory.timezone,
    cleaner.max_daily_minutes, cleaner.max_weekly_minutes,
    cleaner.is_dev_seed
  from public.cleaners cleaner
  left join public.service_territories territory
    on territory.id = cleaner.home_territory_id
  where cleaner.external_auth_id = requested_external_auth_id
  limit 1;
end
$$;

create function private.cleaner_identity_by_verified_email(
  requested_verified_email text
) returns table (
  id uuid,
  external_auth_id text,
  full_name text,
  email text,
  phone text,
  status text,
  skills text[],
  vertical_experience text[],
  home_territory_name text,
  home_territory_timezone text,
  max_daily_minutes integer,
  max_weekly_minutes integer,
  is_dev_seed boolean
) language plpgsql stable security definer set search_path = '' as $$
declare
  normalized_email text := lower(trim(requested_verified_email));
begin
  if normalized_email is null
    or char_length(normalized_email) not between 5 and 320
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or (select count(*) from public.cleaners cleaner
        where lower(trim(cleaner.email)) = normalized_email) <> 1 then
    return;
  end if;
  return query
  select cleaner.id, cleaner.external_auth_id, cleaner.full_name,
    cleaner.email, cleaner.phone, cleaner.status, cleaner.skills,
    cleaner.vertical_experience, territory.name, territory.timezone,
    cleaner.max_daily_minutes, cleaner.max_weekly_minutes,
    cleaner.is_dev_seed
  from public.cleaners cleaner
  left join public.service_territories territory
    on territory.id = cleaner.home_territory_id
  where lower(trim(cleaner.email)) = normalized_email
  limit 1;
end
$$;

create function private.claim_cleaner_external_auth_id(
  requested_external_auth_id text,
  requested_verified_email text
) returns table (
  id uuid,
  external_auth_id text,
  full_name text,
  email text,
  phone text,
  status text,
  skills text[],
  vertical_experience text[],
  home_territory_name text,
  home_territory_timezone text,
  max_daily_minutes integer,
  max_weekly_minutes integer,
  is_dev_seed boolean
) language plpgsql security definer set search_path = '' as $$
declare
  normalized_email text := lower(trim(requested_verified_email));
  candidate_ids uuid[];
  candidate public.cleaners%rowtype;
begin
  if requested_external_auth_id is null
    or char_length(trim(requested_external_auth_id)) not between 1 and 255
    or requested_external_auth_id ~ '[[:cntrl:]]'
    or normalized_email is null
    or char_length(normalized_email) not between 5 and 320
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return;
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('cleaner-auth:' || requested_external_auth_id, 9201)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('cleaner-email:' || normalized_email, 9202)
  );

  select cleaner.* into candidate
  from public.cleaners cleaner
  where cleaner.external_auth_id = requested_external_auth_id
  for update;
  if candidate.id is not null then
    if lower(trim(coalesce(candidate.email, ''))) <> normalized_email then
      return;
    end if;
  else
    perform 1
    from public.cleaners cleaner
    where lower(trim(cleaner.email)) = normalized_email
      and cleaner.status in ('onboarding', 'active')
    order by cleaner.created_at, cleaner.id
    for update;
    select array_agg(cleaner.id order by cleaner.created_at, cleaner.id)
      into candidate_ids
    from public.cleaners cleaner
    where lower(trim(cleaner.email)) = normalized_email
      and cleaner.status in ('onboarding', 'active');
    if coalesce(cardinality(candidate_ids), 0) <> 1 then
      return;
    end if;
    select cleaner.* into candidate
    from public.cleaners cleaner
    where cleaner.id = candidate_ids[1]
    for update;
    if candidate.external_auth_id is not null then
      return;
    end if;
    insert into private.cleaner_identity_claim_authorizations
      (cleaner_id, external_auth_id, backend_pid, transaction_id)
    values (
      candidate.id, requested_external_auth_id, pg_backend_pid(),
      pg_current_xact_id()
    );
    update public.cleaners cleaner
    set external_auth_id = requested_external_auth_id
    where cleaner.id = candidate.id and cleaner.external_auth_id is null
    returning cleaner.* into candidate;
    if candidate.id is null then
      raise exception 'Cleaner identity claim changed concurrently'
        using errcode = '40001';
    end if;
  end if;

  return query
  select cleaner.id, cleaner.external_auth_id, cleaner.full_name,
    cleaner.email, cleaner.phone, cleaner.status, cleaner.skills,
    cleaner.vertical_experience, territory.name, territory.timezone,
    cleaner.max_daily_minutes, cleaner.max_weekly_minutes,
    cleaner.is_dev_seed
  from public.cleaners cleaner
  left join public.service_territories territory
    on territory.id = cleaner.home_territory_id
  where cleaner.id = candidate.id;
end
$$;

create function private.guard_cleaner_actor_boundary() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.application_role_is_active() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Cleaner identities cannot be deleted by the application'
      using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.external_auth_id is not null
      or not private.can_access_organization(
        private.lakeandpine_intake_organization_id(), array['owner', 'gm']
      ) then
      raise exception 'Cleaner creation requires national staff authority'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.external_auth_id is distinct from old.external_auth_id then
    if old.external_auth_id is null
      and new.external_auth_id is not null
      and (to_jsonb(new) - 'external_auth_id' - 'updated_at')
        = (to_jsonb(old) - 'external_auth_id' - 'updated_at')
      and private.consume_cleaner_identity_claim(new.id, new.external_auth_id) then
      return new;
    end if;
    raise exception 'Cleaner external identity is immutable outside verified claim'
      using errcode = '42501';
  end if;

  if new.id <> old.id
    or new.is_dev_seed <> old.is_dev_seed
    or new.created_at is distinct from old.created_at then
    raise exception 'Cleaner record identity is immutable' using errcode = '55000';
  end if;

  if private.can_access_organization(
    private.lakeandpine_intake_organization_id(), array['owner', 'gm']
  ) then
    return new;
  end if;

  if private.current_manager_can_update_cleaner(old.id)
    and new.full_name = old.full_name
    and new.email is not distinct from old.email
    and new.phone is not distinct from old.phone
    and new.engagement_type = old.engagement_type
    and new.screening_status = old.screening_status
    and new.screening_verified_at is not distinct from old.screening_verified_at
    and new.operator_notes is not distinct from old.operator_notes
    and (
      new.status <> 'active'
      or exists (
        select 1
        from public.workforce_memberships membership
        where membership.cleaner_id = old.id
          and membership.status = 'active'
          and membership.team_id is not null
          and private.can_access_team(
            membership.organization_id, membership.team_id,
            array['manager']
          )
      )
    ) then
    return new;
  end if;
  raise exception 'Cleaner update is outside the actor branch scope'
    using errcode = '42501';
end
$$;
create trigger cleaner_actor_boundary_guard
  before insert or update or delete on cleaners for each row
  execute function private.guard_cleaner_actor_boundary();

drop policy lakeandpine_app_all_customers on customers;
revoke select, insert, update, delete on table customers from lakeandpine_app;
grant select (
  id, email, full_name, phone, role, referral_credit_cents,
  is_dev_seed, created_at, updated_at
) on customers to lakeandpine_app;
create policy customers_safe_read
  on customers for select to lakeandpine_app using (
    (private.current_cleaner_id() is null
      and id = private.current_customer_id())
    or private.current_staff_can_access_customer(id)
  );

drop policy lakeandpine_app_all_cleaners on cleaners;
revoke select, delete on table cleaners from lakeandpine_app;
grant select (
  id, full_name, email, phone, status, engagement_type,
  screening_status, screening_verified_at, home_territory_id, skills,
  vertical_experience, max_daily_minutes, max_weekly_minutes,
  max_daily_jobs, travel_buffer_minutes, is_dev_seed, created_at, updated_at
) on cleaners to lakeandpine_app;
create policy cleaners_safe_read
  on cleaners for select to lakeandpine_app using (
    id = private.current_cleaner_id()
    or private.current_staff_can_access_cleaner(id)
  );
create policy cleaners_national_insert
  on cleaners for insert to lakeandpine_app with check (
    private.can_access_organization(
      private.lakeandpine_intake_organization_id(), array['owner', 'gm']
    )
  );
create policy cleaners_scoped_update
  on cleaners for update to lakeandpine_app using (
    private.current_manager_can_update_cleaner(id)
  ) with check (
    private.current_manager_can_update_cleaner(id)
  );
create policy cleaners_delete_denied
  on cleaners for delete to lakeandpine_app using (false);

create function private.create_public_cleaner_application(
  requested_idempotency_hash text,
  requested_public_reference text,
  requested_full_name text,
  requested_email text,
  requested_phone text,
  requested_home_base text,
  requested_service_interests text[],
  requested_territory_interests text[],
  requested_availability_summary text,
  requested_experience_summary text,
  requested_transportation_confirmed boolean,
  requested_consent_snapshot jsonb
) returns table (
  public_reference text,
  duplicate boolean
) language plpgsql security definer set search_path = '' as $$
declare
  normalized_email text := lower(trim(requested_email));
  normalized_reference text := upper(trim(requested_public_reference));
  existing_reference text;
begin
  if requested_idempotency_hash is null
    or requested_idempotency_hash !~ '^[0-9a-f]{64}$'
    or normalized_reference !~ '^TEAM-[0-9A-F]{10}$'
    or char_length(trim(coalesce(requested_full_name, ''))) not between 2 and 200
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or char_length(normalized_email) > 320
    or char_length(coalesce(requested_phone, '')) > 50
    or char_length(coalesce(requested_home_base, '')) > 200
    or char_length(coalesce(requested_availability_summary, '')) > 2000
    or char_length(coalesce(requested_experience_summary, '')) > 3000
    or requested_transportation_confirmed is distinct from true
    or requested_service_interests is null
    or cardinality(requested_service_interests) not between 1 and 4
    or not requested_service_interests
      <@ array['estate', 'construction', 'marine', 'commercial']::text[]
    or cardinality(requested_territory_interests) > 20
    or exists (
      select 1 from unnest(coalesce(requested_territory_interests, '{}')) value
      where char_length(trim(value)) not between 1 and 100
    )
    or jsonb_typeof(requested_consent_snapshot) is distinct from 'object'
    or requested_consent_snapshot ->> 'privacy' <> 'true'
    or char_length(coalesce(requested_consent_snapshot ->> 'policyVersion', ''))
      not between 1 and 100
    or char_length(coalesce(requested_consent_snapshot ->> 'privacyNoticeDate', ''))
      not between 8 and 20
    or pg_column_size(requested_consent_snapshot) > 4096 then
    raise exception 'Cleaner application intake is invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cleaner-application:' || requested_idempotency_hash, 9301)
  );
  select application.public_reference into existing_reference
  from public.cleaner_applications application
  where application.idempotency_key = requested_idempotency_hash
  limit 1;
  if existing_reference is not null then
    return query select existing_reference, true;
    return;
  end if;

  insert into public.cleaner_applications
    (public_reference, idempotency_key, full_name, email, phone, home_base,
     transportation_confirmed, service_interests, territory_interests,
     availability_summary, experience_summary, status, consent_snapshot,
     consented_at, is_dev_seed)
  values (
    normalized_reference, requested_idempotency_hash,
    trim(requested_full_name), normalized_email,
    nullif(trim(requested_phone), ''), nullif(trim(requested_home_base), ''),
    true, requested_service_interests,
    coalesce(requested_territory_interests, '{}'),
    nullif(trim(requested_availability_summary), ''),
    nullif(trim(requested_experience_summary), ''), 'submitted',
    requested_consent_snapshot, clock_timestamp(), false
  );
  return query select normalized_reference, false;
end
$$;

drop policy lakeandpine_app_all_cleaner_applications on cleaner_applications;
revoke insert, delete on table cleaner_applications from lakeandpine_app;
create policy cleaner_applications_national_read
  on cleaner_applications for select to lakeandpine_app using (
    private.can_access_organization(
      private.lakeandpine_intake_organization_id(), array['owner', 'gm']
    )
  );
create policy cleaner_applications_national_update
  on cleaner_applications for update to lakeandpine_app using (
    private.can_access_organization(
      private.lakeandpine_intake_organization_id(), array['owner', 'gm']
    )
  ) with check (
    private.can_access_organization(
      private.lakeandpine_intake_organization_id(), array['owner', 'gm']
    )
  );

create function private.consume_request_rate_limit(
  requested_scope text,
  requested_key_hash text,
  requested_limit integer,
  requested_window_seconds integer
) returns table (
  allowed boolean,
  remaining integer,
  retry_after_seconds integer
) language plpgsql security definer set search_path = '' as $$
declare
  observed_at timestamptz := clock_timestamp();
  fixed_window_start timestamptz;
  fixed_window_end timestamptz;
  observed_count integer;
  observed_blocked_until timestamptz;
begin
  if requested_scope not in (
      'booking', 'concierge', 'service_case', 'cleaner_application'
    )
    or requested_key_hash is null
    or requested_key_hash !~ '^[0-9a-f]{64}$'
    or requested_limit not between 1 and 10000
    or requested_window_seconds not between 1 and 86400 then
    raise exception 'Rate-limit request is invalid' using errcode = '22023';
  end if;

  fixed_window_start := to_timestamp(
    floor(extract(epoch from observed_at) / requested_window_seconds)
      * requested_window_seconds
  );
  fixed_window_end := fixed_window_start
    + make_interval(secs => requested_window_seconds);

  with expired as (
    select limiter.scope, limiter.key_hash, limiter.window_start
    from public.request_rate_limits limiter
    where limiter.expires_at < observed_at
    order by limiter.expires_at
    limit 100
  )
  delete from public.request_rate_limits limiter
  using expired
  where limiter.scope = expired.scope
    and limiter.key_hash = expired.key_hash
    and limiter.window_start = expired.window_start;

  insert into public.request_rate_limits
    (scope, key_hash, window_start, window_seconds, request_count,
     blocked_until, expires_at)
  values (
    requested_scope, requested_key_hash, fixed_window_start,
    requested_window_seconds, 1, null,
    fixed_window_end + make_interval(secs => requested_window_seconds)
  )
  on conflict (scope, key_hash, window_start) do update
  set request_count = public.request_rate_limits.request_count + 1,
      blocked_until = case
        when public.request_rate_limits.request_count + 1 > requested_limit
          then greatest(
            coalesce(public.request_rate_limits.blocked_until, fixed_window_end),
            fixed_window_end
          )
        else public.request_rate_limits.blocked_until
      end,
      expires_at = greatest(public.request_rate_limits.expires_at,
        fixed_window_end + make_interval(secs => requested_window_seconds))
  returning request_count, blocked_until
    into observed_count, observed_blocked_until;

  return query select
    observed_count <= requested_limit
      and (observed_blocked_until is null or observed_blocked_until <= observed_at),
    greatest(requested_limit - observed_count, 0),
    case
      when observed_count <= requested_limit
        and (observed_blocked_until is null
          or observed_blocked_until <= observed_at) then 0
      else greatest(1, ceil(extract(epoch from
        (coalesce(observed_blocked_until, fixed_window_end) - observed_at)))::integer)
    end;
end
$$;

drop policy lakeandpine_app_all_request_rate_limits on request_rate_limits;
revoke select, insert, update, delete on table request_rate_limits from lakeandpine_app;

revoke all on function private.current_staff_can_access_customer(uuid) from public;
revoke all on function private.current_staff_can_access_cleaner(uuid) from public;
revoke all on function private.current_manager_can_update_cleaner(uuid) from public;
revoke all on function private.customer_identity_by_clerk_id(text) from public;
revoke all on function private.customer_identity_by_verified_email(text) from public;
revoke all on function private.upsert_customer_from_verified_clerk_identity(
  text, text, text, text
) from public;
revoke all on function private.consume_cleaner_identity_claim(uuid, text) from public;
revoke all on function private.cleaner_identity_by_external_auth_id(text) from public;
revoke all on function private.cleaner_identity_by_verified_email(text) from public;
revoke all on function private.claim_cleaner_external_auth_id(text, text) from public;
revoke all on function private.guard_cleaner_actor_boundary() from public;
revoke all on function private.create_public_cleaner_application(
  text, text, text, text, text, text, text[], text[], text, text, boolean, jsonb
) from public;
revoke all on function private.consume_request_rate_limit(
  text, text, integer, integer
) from public;
grant execute on function private.current_staff_can_access_customer(uuid) to lakeandpine_app;
grant execute on function private.current_staff_can_access_cleaner(uuid) to lakeandpine_app;
grant execute on function private.current_manager_can_update_cleaner(uuid) to lakeandpine_app;
grant execute on function private.customer_identity_by_clerk_id(text) to lakeandpine_app;
grant execute on function private.customer_identity_by_verified_email(text) to lakeandpine_app;
grant execute on function private.upsert_customer_from_verified_clerk_identity(
  text, text, text, text
) to lakeandpine_app;
grant execute on function private.cleaner_identity_by_external_auth_id(text) to lakeandpine_app;
grant execute on function private.cleaner_identity_by_verified_email(text) to lakeandpine_app;
grant execute on function private.claim_cleaner_external_auth_id(text, text) to lakeandpine_app;
grant execute on function private.create_public_cleaner_application(
  text, text, text, text, text, text, text[], text[], text, text, boolean, jsonb
) to lakeandpine_app;
grant execute on function private.consume_request_rate_limit(
  text, text, integer, integer
) to lakeandpine_app;

-- Customer-owned property, support, and billing surfaces --------------------

create function private.guard_customer_home_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.application_role_is_active() then
    return new;
  end if;
  if private.current_cleaner_id() is not null
    or private.current_customer_id() is null
    or old.customer_id <> private.current_customer_id()
    or new.customer_id <> private.current_customer_id()
    or (to_jsonb(new) - 'cleaner_notes' - 'updated_at')
      <> (to_jsonb(old) - 'cleaner_notes' - 'updated_at')
    or char_length(coalesce(new.cleaner_notes, '')) > 4000 then
    raise exception 'Customer home update may change only care notes'
      using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger homes_customer_update_guard
  before update on homes for each row
  execute function private.guard_customer_home_update();

drop policy lakeandpine_app_all_homes on homes;
revoke insert, delete on table homes from lakeandpine_app;
create policy homes_customer_read
  on homes for select to lakeandpine_app using (
    private.current_cleaner_id() is null
    and customer_id = private.current_customer_id()
  );
create policy homes_customer_notes_update
  on homes for update to lakeandpine_app using (
    private.current_cleaner_id() is null
    and customer_id = private.current_customer_id()
  ) with check (
    private.current_cleaner_id() is null
    and customer_id = private.current_customer_id()
  );

create function private.current_customer_billing_history()
returns table (
  id uuid,
  description text,
  amount_cents integer,
  status text,
  occurred_at timestamptz
) language plpgsql stable security definer set search_path = '' as $$
begin
  if private.current_customer_id() is null
    or private.current_cleaner_id() is not null then
    raise exception 'Customer billing identity is required' using errcode = '42501';
  end if;
  return query
  select billing.id, billing.description, billing.amount_cents,
    billing.status, billing.occurred_at
  from public.billing_records billing
  where billing.customer_id = private.current_customer_id()
  order by billing.occurred_at desc, billing.id;
end
$$;

create function private.current_staff_can_access_billing_record(
  requested_billing_record_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.billing_records billing
    where billing.id = requested_billing_record_id
      and (
        private.can_access_organization(
          private.lakeandpine_intake_organization_id(), array['owner', 'gm']
        )
        or (billing.booking_id is not null
          and private.current_staff_can_access_booking(billing.booking_id))
      )
  )
$$;

drop policy lakeandpine_app_all_billing_records on billing_records;
revoke select, insert, update, delete on table billing_records from lakeandpine_app;
grant select (
  id, customer_id, booking_id, description, amount_cents, status,
  occurred_at, is_dev_seed
) on billing_records to lakeandpine_app;
create policy billing_records_staff_read
  on billing_records for select to lakeandpine_app using (
    private.current_staff_can_access_billing_record(id)
  );

create or replace function public.synchronize_processed_refund() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  processed_total integer;
  billed_total integer;
begin
  if new.status = 'processed' and old.status is distinct from new.status then
    update public.service_cases service_case
    set status = 'resolved', resolution_type = 'refund',
        resolution_summary = 'External refund receipt recorded; funds were returned outside this application.',
        resolved_at = now()
    where service_case.id = new.service_case_id
      and service_case.status = 'refund_pending';

    select coalesce(sum(refund.amount_cents), 0)::integer into processed_total
    from public.refund_records refund
    where refund.billing_record_id = new.billing_record_id
      and refund.status = 'processed';
    select billing.amount_cents into billed_total
    from public.billing_records billing
    where billing.id = new.billing_record_id;
    if processed_total >= billed_total then
      update public.billing_records billing
      set status = 'refunded'
      where billing.id = new.billing_record_id and billing.status = 'paid';
    end if;
  end if;
  return new;
end
$$;

alter table support_messages
  add column service_case_id uuid references service_cases(id) on delete restrict;
create index support_messages_service_case_idx
  on support_messages (service_case_id, created_at, id)
  where service_case_id is not null;
create unique index support_messages_one_customer_exchange_per_case_idx
  on support_messages (service_case_id, sender)
  where service_case_id is not null and sender in ('customer', 'concierge');

create function private.current_staff_can_access_support_message(
  requested_service_case_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and (
      private.can_access_organization(
        private.lakeandpine_intake_organization_id(), array['owner', 'gm']
      )
      or (requested_service_case_id is not null
        and private.current_staff_can_manage_service_case(
          requested_service_case_id
        ))
    )
$$;

create function private.append_service_case_customer_acknowledgement(
  requested_service_case_id uuid
) returns bigint language plpgsql security definer set search_path = '' as $$
declare
  owned_case public.service_cases%rowtype;
  acknowledgement_body text;
  message_id bigint;
begin
  if private.current_customer_id() is null
    or private.current_cleaner_id() is not null then
    raise exception 'Customer service-case identity is required'
      using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('service-case-ack:' || requested_service_case_id::text, 9401)
  );
  select service_case.* into owned_case
  from public.service_cases service_case
  where service_case.id = requested_service_case_id
    and service_case.customer_id = private.current_customer_id()
  for share;
  if owned_case.id is null then
    raise exception 'Service-case acknowledgement is unavailable'
      using errcode = '42501';
  end if;

  acknowledgement_body := case
    when owned_case.case_type = 'reschedule' then
      'Your reschedule request ' || owned_case.public_reference
      || ' is in the operator queue. The current visit remains unchanged until a new window is confirmed.'
    else
      'Your ' || replace(owned_case.case_type, '_', ' ') || ' request '
      || owned_case.public_reference
      || ' is in the operator queue. No schedule or payment changes until an operator confirms them.'
  end;
  select message.id into message_id
  from public.support_messages message
  where message.service_case_id = owned_case.id
    and message.customer_id = owned_case.customer_id
    and message.sender = 'concierge'
  order by message.created_at, message.id
  limit 1;
  if message_id is null then
    insert into public.support_messages
      (customer_id, service_case_id, sender, body, is_dev_seed)
    values (
      owned_case.customer_id, owned_case.id, 'concierge', acknowledgement_body,
      owned_case.is_dev_seed
    )
    returning id into message_id;
  end if;
  return message_id;
end
$$;

create function private.guard_support_message_insert() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  -- Bounded SECURITY DEFINER acknowledgement/payment functions execute their
  -- derived insert as the migration owner. Direct runtime INSERTs still run as
  -- the application role and must satisfy the customer/staff checks below.
  if current_user <> 'lakeandpine_app' then
    return new;
  end if;
  if char_length(trim(coalesce(new.body, ''))) not between 1 and 6000 then
    raise exception 'Support message body is invalid' using errcode = '22023';
  end if;
  if private.current_cleaner_id() is null
    and private.current_customer_id() = new.customer_id
    and new.sender = 'customer'
    and new.is_dev_seed = false then
    return new;
  end if;
  if private.current_cleaner_id() is null
    and private.current_staff_can_access_support_message(new.service_case_id)
    and new.sender = 'staff' then
    return new;
  end if;
  raise exception 'Support sender is outside the actor scope'
    using errcode = '42501';
end
$$;
create trigger support_messages_actor_guard
  before insert on support_messages for each row
  execute function private.guard_support_message_insert();

drop policy lakeandpine_app_all_support_messages on support_messages;
revoke insert, update, delete on table support_messages from lakeandpine_app;
grant insert (customer_id, sender, body) on support_messages to lakeandpine_app;
create policy support_messages_scoped_read
  on support_messages for select to lakeandpine_app using (
    (private.current_cleaner_id() is null
      and customer_id = private.current_customer_id())
    or private.current_staff_can_access_support_message(service_case_id)
  );
create policy support_messages_scoped_insert
  on support_messages for insert to lakeandpine_app with check (
    (private.current_cleaner_id() is null
      and customer_id = private.current_customer_id()
      and sender = 'customer' and is_dev_seed = false)
    or (private.current_staff_can_access_support_message(service_case_id)
      and sender = 'staff')
  );

-- Operator-only notes and follow-ups inherit the booking's exact branch scope.
create function private.guard_follow_up_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.application_role_is_active()
    and (
      new.id <> old.id
      or new.booking_id <> old.booking_id
      or new.kind <> old.kind
      or new.is_dev_seed <> old.is_dev_seed
      or new.created_at is distinct from old.created_at
    ) then
    raise exception 'Follow-up identity is immutable' using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger follow_ups_identity_guard
  before update on follow_ups for each row
  execute function private.guard_follow_up_identity();

drop policy lakeandpine_app_all_internal_notes on internal_notes;
revoke update, delete on table internal_notes from lakeandpine_app;
create policy internal_notes_staff_read
  on internal_notes for select to lakeandpine_app using (
    private.current_staff_can_access_booking(booking_id)
  );
create policy internal_notes_staff_insert
  on internal_notes for insert to lakeandpine_app with check (
    private.current_staff_can_access_booking(booking_id)
    and is_dev_seed = (select booking.is_dev_seed
      from bookings booking where booking.id = booking_id)
  );

drop policy lakeandpine_app_all_follow_ups on follow_ups;
revoke delete on table follow_ups from lakeandpine_app;
create policy follow_ups_staff_read
  on follow_ups for select to lakeandpine_app using (
    private.current_staff_can_access_booking(booking_id)
  );
create policy follow_ups_staff_insert
  on follow_ups for insert to lakeandpine_app with check (
    private.current_staff_can_access_booking(booking_id)
    and is_dev_seed = (select booking.is_dev_seed
      from bookings booking where booking.id = booking_id)
  );
create policy follow_ups_staff_update
  on follow_ups for update to lakeandpine_app using (
    private.current_staff_can_access_booking(booking_id)
  ) with check (
    private.current_staff_can_access_booking(booking_id)
  );

-- Territory catalog and cleaner availability remain useful without exposing
-- qualification/evidence notes or permitting cross-branch mutation.
create function private.current_staff_can_access_territory(
  requested_territory_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and exists (
      select 1
      from public.service_territories territory
      where territory.id = requested_territory_id
        and (
          private.can_access_organization(
            private.lakeandpine_intake_organization_id(), array['owner', 'gm']
          )
          or exists (
            select 1
            from public.workforce_memberships membership
            join public.team_service_territories coverage
              on coverage.organization_id = membership.organization_id
             and coverage.team_id = membership.team_id
             and coverage.territory_id = territory.id
             and coverage.status = 'active'
            where membership.team_id is not null
              and membership.status = 'active'
              and membership.role in ('manager', 'shift_lead')
              and membership.customer_id = private.current_customer_id()
          )
        )
    )
$$;

drop policy lakeandpine_app_all_service_territories on service_territories;
revoke select on table service_territories from lakeandpine_app;
grant select (
  id, code, name, timezone, status, travel_buffer_minutes,
  is_dev_seed, created_at, updated_at
) on service_territories to lakeandpine_app;
create policy service_territories_safe_read
  on service_territories for select to lakeandpine_app using (
    private.current_staff_can_access_territory(id)
    or (
      status = 'active'
      and private.current_cleaner_id() is not null
      and (
        exists (select 1 from cleaners cleaner
          where cleaner.id = private.current_cleaner_id()
            and cleaner.home_territory_id = service_territories.id)
        or exists (select 1 from cleaner_availability_rules availability
          where availability.cleaner_id = private.current_cleaner_id()
            and availability.territory_id = service_territories.id)
        or exists (
          select 1
          from job_assignments assignment
          join job_schedules schedule
            on schedule.id = assignment.job_schedule_id
          where assignment.cleaner_id = private.current_cleaner_id()
            and schedule.territory_id = service_territories.id
        )
      )
    )
    or (
      status = 'active'
      and private.current_cleaner_id() is null
      and private.current_customer_id() is not null
      and exists (select 1 from bookings booking
        where booking.customer_id = private.current_customer_id()
          and booking.territory_id = service_territories.id)
    )
  );
create policy service_territories_national_insert
  on service_territories for insert to lakeandpine_app with check (
    private.can_access_organization(
      private.lakeandpine_intake_organization_id(), array['owner', 'gm']
    )
  );
create policy service_territories_national_update
  on service_territories for update to lakeandpine_app using (
    private.can_access_organization(
      private.lakeandpine_intake_organization_id(), array['owner', 'gm']
    )
  ) with check (
    private.can_access_organization(
      private.lakeandpine_intake_organization_id(), array['owner', 'gm']
    )
  );
create policy service_territories_national_delete
  on service_territories for delete to lakeandpine_app using (
    private.can_access_organization(
      private.lakeandpine_intake_organization_id(), array['owner', 'gm']
    )
  );

drop policy lakeandpine_app_all_territory_postal_codes on territory_postal_codes;
revoke select on table territory_postal_codes from lakeandpine_app;
grant select (territory_id, postal_code, status, created_at)
  on territory_postal_codes to lakeandpine_app;
create policy territory_postal_codes_national_read
  on territory_postal_codes for select to lakeandpine_app using (
    private.can_access_organization(
      private.lakeandpine_intake_organization_id(), array['owner', 'gm']
    )
    or private.current_staff_can_access_territory(territory_id)
  );
create policy territory_postal_codes_national_insert
  on territory_postal_codes for insert to lakeandpine_app with check (
    private.can_access_organization(
      private.lakeandpine_intake_organization_id(), array['owner', 'gm']
    )
  );
create policy territory_postal_codes_national_update
  on territory_postal_codes for update to lakeandpine_app using (
    private.can_access_organization(
      private.lakeandpine_intake_organization_id(), array['owner', 'gm']
    )
  ) with check (
    private.can_access_organization(
      private.lakeandpine_intake_organization_id(), array['owner', 'gm']
    )
  );
create policy territory_postal_codes_national_delete
  on territory_postal_codes for delete to lakeandpine_app using (
    private.can_access_organization(
      private.lakeandpine_intake_organization_id(), array['owner', 'gm']
    )
  );

create or replace function public.pause_territory_without_cleaner_capacity(
  territory_to_check uuid
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if territory_to_check is null then
    return;
  end if;
  update public.service_territories territory
  set status = 'paused'
  where territory.id = territory_to_check
    and territory.status = 'active'
    and not exists (
      select 1
      from public.cleaners cleaner
      where cleaner.home_territory_id = territory.id
        and cleaner.status = 'active'
        and cleaner.screening_status = 'verified'
        and exists (
          select 1 from public.cleaner_availability_rules availability
          where availability.cleaner_id = cleaner.id
            and availability.status = 'active'
            and (availability.territory_id is null
              or availability.territory_id = territory.id)
        )
    );
end
$$;
revoke execute on function public.pause_territory_without_cleaner_capacity(uuid)
  from lakeandpine_app;

drop policy lakeandpine_app_all_cleaner_availability_rules
  on cleaner_availability_rules;
revoke delete on table cleaner_availability_rules from lakeandpine_app;

create function private.current_staff_can_access_cleaner_availability(
  requested_cleaner_id uuid,
  requested_territory_id uuid,
  allowed_local_roles text[]
) returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_customer_id() is not null
    and private.current_cleaner_id() is null
    and exists (
      select 1
      from public.cleaners cleaner
      join public.workforce_memberships subject
        on subject.cleaner_id = cleaner.id
       and subject.team_id is not null
       and subject.status = 'active'
       and subject.role in ('cleaner', 'shift_lead')
      join public.team_service_territories coverage
        on coverage.organization_id = subject.organization_id
       and coverage.team_id = subject.team_id
       and coverage.territory_id = coalesce(
         requested_territory_id, cleaner.home_territory_id
       )
       and coverage.status = 'active'
      where cleaner.id = requested_cleaner_id
        and coalesce(requested_territory_id, cleaner.home_territory_id) is not null
        and (
          private.can_access_organization(
            subject.organization_id, array['owner', 'gm']
          )
          or private.can_access_team(
            subject.organization_id, subject.team_id, allowed_local_roles
          )
        )
    )
$$;

create function private.guard_cleaner_availability_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.application_role_is_active() then
    return new;
  end if;
  if not private.current_staff_can_access_cleaner_availability(
      new.cleaner_id, new.territory_id, array['manager']
    ) then
    raise exception 'Cleaner availability is outside the actor team coverage'
      using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'active' then
      raise exception 'Cleaner availability must begin active'
        using errcode = '23514';
    end if;
  elsif new.id <> old.id
    or new.cleaner_id <> old.cleaner_id
    or new.territory_id is distinct from old.territory_id
    or new.created_at is distinct from old.created_at then
    raise exception 'Cleaner availability identity and creation evidence are immutable'
      using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger cleaner_availability_scope_guard
  before insert or update on cleaner_availability_rules for each row
  execute function private.guard_cleaner_availability_scope();
revoke all on function private.current_staff_can_access_cleaner_availability(
  uuid, uuid, text[]
) from public;
revoke all on function private.guard_cleaner_availability_scope() from public;
grant execute on function private.current_staff_can_access_cleaner_availability(
  uuid, uuid, text[]
) to lakeandpine_app;

create policy cleaner_availability_scoped_read
  on cleaner_availability_rules for select to lakeandpine_app using (
    cleaner_id = private.current_cleaner_id()
    or private.current_staff_can_access_cleaner_availability(
      cleaner_id, territory_id, array['manager', 'shift_lead']
    )
  );
create policy cleaner_availability_staff_insert
  on cleaner_availability_rules for insert to lakeandpine_app with check (
    private.current_staff_can_access_cleaner_availability(
      cleaner_id, territory_id, array['manager']
    )
  );
create policy cleaner_availability_staff_update
  on cleaner_availability_rules for update to lakeandpine_app using (
    private.current_staff_can_access_cleaner_availability(
      cleaner_id, territory_id, array['manager']
    )
  ) with check (
    private.current_staff_can_access_cleaner_availability(
      cleaner_id, territory_id, array['manager']
    )
  );

-- Legacy organization/team guards must inspect the full database state even
-- after the application role is narrowed by RLS. Trigger execution does not
-- require a callable RPC surface, so keep the validator private to triggers.
create or replace function public.validate_team_job_allocation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1
    from public.team_service_territories coverage
    join public.job_schedules schedule
      on schedule.territory_id = coverage.territory_id
    where coverage.organization_id = new.organization_id
      and coverage.team_id = new.team_id
      and coverage.status = 'active'
      and schedule.id = new.job_schedule_id
  ) then
    raise exception 'Schedule territory is outside the active team coverage area'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.job_assignments assignment
    where assignment.job_schedule_id = new.job_schedule_id
      and assignment.team_id is not null
      and assignment.team_id <> new.team_id
  ) then
    raise exception 'Schedule assignments must match the allocated team'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.job_assignments assignment
    where assignment.job_schedule_id = new.job_schedule_id
      and assignment.status in ('accepted', 'confirmed')
      and not exists (
        select 1
        from public.workforce_memberships membership
        where membership.organization_id = new.organization_id
          and membership.team_id = new.team_id
          and membership.cleaner_id = assignment.cleaner_id
          and membership.role in ('cleaner', 'shift_lead')
          and membership.status = 'active'
      )
  ) then
    raise exception 'Accepted crew must be active in the allocated team'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.job_schedules schedule
    join public.service_cases service_case
      on service_case.booking_id = schedule.booking_id
    where schedule.id = new.job_schedule_id
      and service_case.assigned_team_id is not null
      and service_case.assigned_team_id <> new.team_id
  ) then
    raise exception 'Allocated team must match existing service-case ownership'
      using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function public.validate_team_job_allocation() from public;
revoke all on function public.validate_team_job_allocation() from lakeandpine_app;

-- Workforce status is a privileged, auditable transition. Derive the actor
-- from the verified request identity and enforce the same hierarchy in RLS and
-- the trigger: only the owner may change a GM; owner/GM may change a manager;
-- owner/GM or that branch's manager may change a shift lead or cleaner.
create or replace function public.guard_workforce_membership_history()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor_membership_id uuid;
begin
  if tg_op = 'DELETE' then
    if old.is_dev_seed
      and not private.application_role_is_active()
      and coalesce(current_setting('lakeandpine.dev_seed_purge', true), '') = '1' then
      return old;
    end if;
    raise exception 'Workforce memberships are ended, never deleted'
      using errcode = '55000';
  end if;
  if old.role = 'owner' then
    raise exception 'Owner transfer requires a reviewed administrative migration'
      using errcode = '42501';
  end if;
  if (to_jsonb(new)
      - 'status' - 'ended_at' - 'status_reason'
      - 'status_changed_by_membership_id' - 'status_changed_at' - 'updated_at')
      <> (to_jsonb(old)
      - 'status' - 'ended_at' - 'status_reason'
      - 'status_changed_by_membership_id' - 'status_changed_at' - 'updated_at')
    or new.status is not distinct from old.status
    or not (
      (old.status = 'active' and new.status in ('paused', 'ended'))
      or (old.status = 'paused' and new.status in ('active', 'ended'))
    )
    or char_length(trim(coalesce(new.status_reason, ''))) < 4 then
    raise exception 'Invalid or destructive workforce membership transition'
      using errcode = '55000';
  end if;

  if private.application_role_is_active() then
    if private.current_customer_id() is null
      or private.current_cleaner_id() is not null then
      raise exception 'Workforce status changes require one verified staff actor'
        using errcode = '42501';
    end if;
    select membership.id into actor_membership_id
    from public.workforce_memberships membership
    where membership.organization_id = old.organization_id
      and membership.customer_id = private.current_customer_id()
      and membership.status = 'active'
      and (
        (old.role = 'gm'
          and membership.team_id is null and membership.role = 'owner')
        or (old.role = 'manager'
          and membership.team_id is null and membership.role in ('owner', 'gm'))
        or (old.role in ('shift_lead', 'cleaner') and (
          (membership.team_id is null and membership.role in ('owner', 'gm'))
          or (membership.team_id = old.team_id and membership.role = 'manager')
        ))
      )
    order by case membership.role
      when 'owner' then 1 when 'gm' then 2 else 3 end, membership.id
    limit 1
    for share;
    if actor_membership_id is null then
      raise exception 'Actor cannot change this workforce membership'
        using errcode = '42501';
    end if;
    new.status_changed_by_membership_id := actor_membership_id;
    new.status_changed_at := clock_timestamp();
    new.ended_at := case when new.status = 'ended' then current_date else null end;
  elsif new.status_changed_by_membership_id is null
    or new.status_changed_at is null
    or new.status_changed_at is not distinct from old.status_changed_at
    or not exists (
      select 1
      from public.workforce_memberships actor
      where actor.id = new.status_changed_by_membership_id
        and actor.organization_id = new.organization_id
        and (actor.team_id is null or actor.team_id = new.team_id)
        and actor.status = 'active'
    ) then
    raise exception 'Administrative workforce transition requires fresh scoped evidence'
      using errcode = '55000';
  end if;

  if ((new.status = 'ended') <> (new.ended_at is not null)) then
    raise exception 'Ended workforce status and end date must agree'
      using errcode = '55000';
  end if;
  return new;
end
$$;
revoke all on function public.guard_workforce_membership_history() from public;
revoke all on function public.guard_workforce_membership_history() from lakeandpine_app;

drop policy workforce_memberships_update on workforce_memberships;
create policy workforce_memberships_update
  on workforce_memberships for update to lakeandpine_app using (
    (role = 'gm'
      and private.can_access_organization(organization_id, array['owner']))
    or (role = 'manager'
      and private.can_access_organization(organization_id, array['owner', 'gm']))
    or (role in ('shift_lead', 'cleaner') and (
      private.can_access_organization(organization_id, array['owner', 'gm'])
      or (team_id is not null and private.can_access_team(
        organization_id, team_id, array['manager']
      ))
    ))
  ) with check (
    (role = 'gm'
      and private.can_access_organization(organization_id, array['owner']))
    or (role = 'manager'
      and private.can_access_organization(organization_id, array['owner', 'gm']))
    or (role in ('shift_lead', 'cleaner') and (
      private.can_access_organization(organization_id, array['owner', 'gm'])
      or (team_id is not null and private.can_access_team(
        organization_id, team_id, array['manager']
      ))
    ))
  );
revoke update on table workforce_memberships from lakeandpine_app;
grant update (status, ended_at, status_reason)
  on table workforce_memberships to lakeandpine_app;

-- Append-only lifecycle evidence and scoped recovery work -------------------

alter table service_case_events
  add column actor_membership_id uuid
    references workforce_memberships(id) on delete set null;
create index service_case_events_actor_membership_idx
  on service_case_events (actor_membership_id)
  where actor_membership_id is not null;
alter table operations_state_events
  add column actor_membership_id uuid
    references workforce_memberships(id) on delete set null;
create index operations_state_events_actor_membership_idx
  on operations_state_events (actor_membership_id)
  where actor_membership_id is not null;

create function private.current_actor_for_scope(
  requested_organization_id uuid,
  requested_team_id uuid
) returns table (
  actor_membership_id uuid,
  actor_role text
) language plpgsql stable security definer set search_path = '' as $$
declare
  matched_membership_id uuid;
  matched_membership_role text;
  current_customer_role text;
begin
  select membership.id, membership.role
    into matched_membership_id, matched_membership_role
  from public.workforce_memberships membership
  where membership.organization_id = requested_organization_id
    and membership.status = 'active'
    and (
      membership.customer_id = private.current_customer_id()
      or membership.cleaner_id = private.current_cleaner_id()
    )
    and (
      (requested_team_id is null and membership.team_id is null)
      or (requested_team_id is not null
        and (membership.team_id is null or membership.team_id = requested_team_id))
    )
  order by case when membership.team_id = requested_team_id then 0 else 1 end,
    case membership.role
      when 'owner' then 1 when 'gm' then 2 when 'manager' then 3
      when 'shift_lead' then 4 else 5 end,
    membership.id
  limit 1;
  if matched_membership_id is not null then
    return query select matched_membership_id, matched_membership_role;
    return;
  end if;
  if private.current_cleaner_id() is not null then
    return query select null::uuid, 'unscoped_cleaner'::text;
    return;
  end if;
  if private.current_customer_id() is not null then
    select customer.role into current_customer_role
    from public.customers customer
    where customer.id = private.current_customer_id();
    return query select null::uuid, case
      when current_customer_role = 'staff' then 'unscoped_staff'::text
      else 'customer'::text
    end;
    return;
  end if;
  return query select null::uuid, 'system'::text;
end
$$;
revoke all on function private.current_actor_for_scope(uuid, uuid) from public;
revoke all on function private.current_actor_for_scope(uuid, uuid)
  from lakeandpine_app;

create function private.current_actor_role_label()
returns text language sql stable security definer set search_path = '' as $$
  select case
    when private.current_cleaner_id() is not null then 'cleaner'
    when exists (
      select 1 from public.customers customer
      where customer.id = private.current_customer_id()
        and customer.role = 'staff'
    ) then 'staff'
    when private.current_customer_id() is not null then 'customer'
    else 'system'
  end
$$;

create or replace function public.record_service_case_lifecycle()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor record;
  event_organization_id uuid;
  event_team_id uuid;
begin
  event_team_id := new.assigned_team_id;
  select coalesce(team.organization_id, private.lakeandpine_intake_organization_id())
    into event_organization_id
  from (select 1) singleton
  left join public.cleaning_teams team on team.id = event_team_id;
  select * into actor
  from private.current_actor_for_scope(event_organization_id, event_team_id);
  if tg_op = 'INSERT' then
    insert into public.service_case_events
      (service_case_id, event_type, from_status, to_status, actor_label,
       actor_membership_id, event_data, is_dev_seed)
    values (
      new.id, 'case_submitted', null, new.status,
      actor.actor_role, actor.actor_membership_id,
      jsonb_build_object('caseType', new.case_type), new.is_dev_seed
    );
  elsif old.status is distinct from new.status then
    insert into public.service_case_events
      (service_case_id, event_type, from_status, to_status, actor_label,
       actor_membership_id, is_dev_seed)
    values (
      new.id, 'status_changed', old.status, new.status,
      actor.actor_role, actor.actor_membership_id, new.is_dev_seed
    );
  end if;
  return new;
end
$$;

-- Notes, follow-ups, and recovery decisions carry exact branch actor evidence.
alter table internal_notes
  add column author_membership_id uuid
    references workforce_memberships(id) on delete set null;
create index internal_notes_author_membership_idx
  on internal_notes (author_membership_id)
  where author_membership_id is not null;

create function private.guard_internal_note_actor() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  event_organization_id uuid;
  event_team_id uuid;
  booking_is_dev_seed boolean;
  actor record;
  actor_display_name text;
begin
  if not private.application_role_is_active() then
    return new;
  end if;
  select booking.is_dev_seed into booking_is_dev_seed
  from public.bookings booking where booking.id = new.booking_id;
  if not found or not private.current_staff_can_access_booking(new.booking_id) then
    raise exception 'Internal note requires exact booking staff authority'
      using errcode = '42501';
  end if;
  select allocation.organization_id, allocation.team_id
    into event_organization_id, event_team_id
  from public.job_schedules schedule
  join public.team_job_allocations allocation
    on allocation.job_schedule_id = schedule.id
  where schedule.booking_id = new.booking_id
  order by allocation.allocated_at desc, allocation.id
  limit 1;
  event_organization_id := coalesce(
    event_organization_id, private.lakeandpine_intake_organization_id()
  );
  select * into actor
  from private.current_actor_for_scope(event_organization_id, event_team_id);
  if actor.actor_membership_id is null then
    raise exception 'Internal note requires an accountable scoped membership'
      using errcode = '42501';
  end if;
  select coalesce(
      nullif(trim(customer.full_name), ''),
      nullif(trim(cleaner.full_name), ''),
      initcap(replace(membership.role, '_', ' '))
    ) into actor_display_name
  from public.workforce_memberships membership
  left join public.customers customer on customer.id = membership.customer_id
  left join public.cleaners cleaner on cleaner.id = membership.cleaner_id
  where membership.id = actor.actor_membership_id;
  new.author_membership_id := actor.actor_membership_id;
  new.author_label := actor_display_name;
  new.is_dev_seed := booking_is_dev_seed;
  return new;
end
$$;
create trigger internal_notes_actor_guard
  before insert on internal_notes for each row
  execute function private.guard_internal_note_actor();
revoke all on function private.guard_internal_note_actor() from public;
revoke all on function private.guard_internal_note_actor() from lakeandpine_app;
revoke insert on table internal_notes from lakeandpine_app;
grant insert (booking_id, body) on table internal_notes to lakeandpine_app;

create or replace function private.guard_follow_up_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  booking_is_dev_seed boolean;
begin
  if not private.application_role_is_active() then
    return new;
  end if;
  select booking.is_dev_seed into booking_is_dev_seed
  from public.bookings booking where booking.id = new.booking_id;
  if not found or not private.current_staff_can_access_booking(new.booking_id) then
    raise exception 'Follow-up requires exact booking staff authority'
      using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    new.status := 'planned';
    new.completed_at := null;
    new.is_dev_seed := booking_is_dev_seed;
    return new;
  end if;
  if new.id <> old.id
    or new.booking_id <> old.booking_id
    or new.kind <> old.kind
    or new.channel <> old.channel
    or new.scheduled_for is distinct from old.scheduled_for
    or new.is_dev_seed <> old.is_dev_seed
    or new.created_at is distinct from old.created_at
    or old.status in ('completed', 'canceled')
    or new.status is not distinct from old.status
    or not (
      (old.status = 'planned' and new.status in ('ready', 'completed', 'canceled'))
      or (old.status = 'ready' and new.status in ('completed', 'canceled'))
    ) then
    raise exception 'Invalid or destructive follow-up transition'
      using errcode = '55000';
  end if;
  new.completed_at := case
    when new.status = 'completed' then clock_timestamp()
    else null
  end;
  return new;
end
$$;
drop trigger follow_ups_identity_guard on follow_ups;
create trigger follow_ups_identity_guard
  before insert or update on follow_ups for each row
  execute function private.guard_follow_up_identity();
revoke update on table follow_ups from lakeandpine_app;
grant update (status) on table follow_ups to lakeandpine_app;
revoke insert on table follow_ups from lakeandpine_app;
grant insert (booking_id, kind, channel, scheduled_for)
  on table follow_ups to lakeandpine_app;

alter table service_recovery_actions
  add column owner_membership_id uuid
    references workforce_memberships(id) on delete set null,
  add column approved_by_membership_id uuid
    references workforce_memberships(id) on delete set null,
  add column approved_at timestamptz,
  add column completed_by_membership_id uuid
    references workforce_memberships(id) on delete set null,
  add column canceled_by_membership_id uuid
    references workforce_memberships(id) on delete set null,
  add column canceled_at timestamptz;
create index service_recovery_owner_membership_idx
  on service_recovery_actions (owner_membership_id)
  where owner_membership_id is not null;
create index service_recovery_approver_membership_idx
  on service_recovery_actions (approved_by_membership_id)
  where approved_by_membership_id is not null;
create index service_recovery_completer_membership_idx
  on service_recovery_actions (completed_by_membership_id)
  where completed_by_membership_id is not null;
create index service_recovery_canceler_membership_idx
  on service_recovery_actions (canceled_by_membership_id)
  where canceled_by_membership_id is not null;

create function private.guard_service_recovery_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  owned_case record;
  event_organization_id uuid;
  event_team_id uuid;
  actor record;
  actor_display_name text;
begin
  if not private.application_role_is_active() then
    return new;
  end if;
  select service_case.booking_id, service_case.assigned_team_id,
         service_case.is_dev_seed, team.organization_id
    into owned_case
  from public.service_cases service_case
  left join public.cleaning_teams team on team.id = service_case.assigned_team_id
  where service_case.id = new.service_case_id
  for share of service_case;
  if not found
    or not private.current_staff_can_manage_service_case(new.service_case_id) then
    raise exception 'Recovery action requires exact service-case authority'
      using errcode = '42501';
  end if;
  event_team_id := owned_case.assigned_team_id;
  event_organization_id := coalesce(
    owned_case.organization_id, private.lakeandpine_intake_organization_id()
  );
  select * into actor
  from private.current_actor_for_scope(event_organization_id, event_team_id);
  if actor.actor_membership_id is null then
    raise exception 'Recovery action requires an accountable scoped membership'
      using errcode = '42501';
  end if;
  select coalesce(
      nullif(trim(customer.full_name), ''),
      nullif(trim(cleaner.full_name), ''),
      initcap(replace(membership.role, '_', ' '))
    ) into actor_display_name
  from public.workforce_memberships membership
  left join public.customers customer on customer.id = membership.customer_id
  left join public.cleaners cleaner on cleaner.id = membership.cleaner_id
  where membership.id = actor.actor_membership_id;

  if tg_op = 'INSERT' then
    new.booking_id := owned_case.booking_id;
    new.status := 'planned';
    new.owner_membership_id := actor.actor_membership_id;
    new.owner_label := actor_display_name;
    new.approved_by_membership_id := null;
    new.approved_by_label := null;
    new.approved_at := null;
    new.completed_by_membership_id := null;
    new.completed_at := null;
    new.canceled_by_membership_id := null;
    new.canceled_at := null;
    new.is_dev_seed := owned_case.is_dev_seed;
    if new.scheduled_at < clock_timestamp() - interval '5 minutes' then
      raise exception 'Recovery target time cannot begin in the past'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if (to_jsonb(new)
      - 'status' - 'approved_by_membership_id' - 'approved_by_label'
      - 'approved_at' - 'completed_by_membership_id' - 'completed_at'
      - 'canceled_by_membership_id' - 'canceled_at' - 'updated_at')
      <> (to_jsonb(old)
      - 'status' - 'approved_by_membership_id' - 'approved_by_label'
      - 'approved_at' - 'completed_by_membership_id' - 'completed_at'
      - 'canceled_by_membership_id' - 'canceled_at' - 'updated_at')
    or old.status in ('completed', 'canceled')
    or new.status is not distinct from old.status
    or not (
      (old.status = 'planned' and new.status in ('approved', 'canceled'))
      or (old.status = 'approved'
        and new.status in ('scheduled', 'completed', 'canceled'))
      or (old.status = 'scheduled'
        and new.status in ('approved', 'completed', 'canceled'))
    ) then
    raise exception 'Invalid or destructive recovery transition'
      using errcode = '55000';
  end if;
  if old.status = 'planned' and new.status = 'approved' then
    new.approved_by_membership_id := actor.actor_membership_id;
    new.approved_by_label := actor_display_name;
    new.approved_at := clock_timestamp();
  else
    new.approved_by_membership_id := old.approved_by_membership_id;
    new.approved_by_label := old.approved_by_label;
    new.approved_at := old.approved_at;
  end if;
  if new.status = 'completed' then
    if new.approved_by_membership_id is null then
      raise exception 'Recovery completion requires prior approval evidence'
        using errcode = '23514';
    end if;
    new.completed_by_membership_id := actor.actor_membership_id;
    new.completed_at := clock_timestamp();
  else
    new.completed_by_membership_id := old.completed_by_membership_id;
    new.completed_at := old.completed_at;
  end if;
  if new.status = 'canceled' then
    new.canceled_by_membership_id := actor.actor_membership_id;
    new.canceled_at := clock_timestamp();
  else
    new.canceled_by_membership_id := old.canceled_by_membership_id;
    new.canceled_at := old.canceled_at;
  end if;
  return new;
end
$$;
create trigger service_recovery_evidence_guard
  before insert or update on service_recovery_actions for each row
  execute function private.guard_service_recovery_evidence();
revoke all on function private.guard_service_recovery_evidence() from public;
revoke all on function private.guard_service_recovery_evidence()
  from lakeandpine_app;
revoke insert, update on table service_recovery_actions from lakeandpine_app;
grant insert (service_case_id, action_type, scheduled_at, value_cents, notes)
  on table service_recovery_actions to lakeandpine_app;
grant update (status) on table service_recovery_actions to lakeandpine_app;

drop policy lakeandpine_app_all_service_case_events on service_case_events;
revoke insert, update, delete on table service_case_events from lakeandpine_app;
create policy service_case_events_staff_read
  on service_case_events for select to lakeandpine_app using (
    private.current_staff_can_manage_service_case(service_case_id)
  );

drop policy lakeandpine_app_all_service_recovery_actions
  on service_recovery_actions;
revoke delete on table service_recovery_actions from lakeandpine_app;
create policy service_recovery_actions_staff_read
  on service_recovery_actions for select to lakeandpine_app using (
    private.current_staff_can_manage_service_case(service_case_id)
  );
create policy service_recovery_actions_staff_insert
  on service_recovery_actions for insert to lakeandpine_app with check (
    private.current_staff_can_manage_service_case(service_case_id)
  );
create policy service_recovery_actions_staff_update
  on service_recovery_actions for update to lakeandpine_app using (
    private.current_staff_can_manage_service_case(service_case_id)
  ) with check (
    private.current_staff_can_manage_service_case(service_case_id)
  );

create unique index booking_events_one_requested_idx
  on booking_events (booking_id) where type = 'requested';

create function private.record_booking_fact_events() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status is distinct from new.status then
    insert into public.booking_events (booking_id, type, data)
    values (
      new.id, 'status_changed',
      jsonb_build_object('bookingStatus', new.status)
    );
  end if;
  if old.scheduled_date is distinct from new.scheduled_date then
    insert into public.booking_events (booking_id, type, data)
    values (
      new.id, 'preferred_date_changed',
      jsonb_build_object('scheduledDate', new.scheduled_date)
    );
  end if;
  return new;
end
$$;
create trigger bookings_fact_event_recorder
  after update of status, scheduled_date on bookings for each row
  execute function private.record_booking_fact_events();
revoke all on function private.record_booking_fact_events() from public;
revoke all on function private.record_booking_fact_events() from lakeandpine_app;

create function private.guard_booking_event_append() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  linked_customer_id uuid;
begin
  if not private.application_role_is_active() then
    return new;
  end if;
  if char_length(trim(coalesce(new.type, ''))) not between 1 and 80
    or jsonb_typeof(new.data) is distinct from 'object'
    or pg_column_size(new.data) > 16384 then
    raise exception 'Booking event is invalid' using errcode = '22023';
  end if;
  select booking.customer_id into linked_customer_id
  from public.bookings booking where booking.id = new.booking_id;
  if not found then
    raise exception 'Booking event subject is unavailable' using errcode = '42501';
  end if;
  if new.type = 'requested'
    and private.current_cleaner_id() is null
    and (
      (private.current_customer_id() is null and linked_customer_id is null)
      or linked_customer_id = private.current_customer_id()
    ) then
    return new;
  end if;
  if pg_trigger_depth() > 1
    and new.type in (
      'schedule_created', 'schedule_status_changed', 'schedule_rescheduled'
    )
    and (new.data - 'scheduleId' - 'scheduleStatus' - 'bookingStatus') = '{}'::jsonb
    and exists (
      select 1
      from public.job_schedules schedule
      join public.bookings booking on booking.id = schedule.booking_id
      where schedule.booking_id = new.booking_id
        and schedule.id::text = new.data ->> 'scheduleId'
        and schedule.status = new.data ->> 'scheduleStatus'
        and booking.status = new.data ->> 'bookingStatus'
        and booking.status = case
          when schedule.status in ('tentative', 'held') then 'ready'
          when schedule.status = 'confirmed' then 'scheduled'
          when schedule.status in ('en_route', 'in_progress', 'quality_review')
            then 'in_progress'
          when schedule.status = 'completed' then 'completed'
          when schedule.status = 'canceled' then 'canceled'
        end
    ) then
    return new;
  end if;
  if pg_trigger_depth() > 1
    and new.type = 'status_changed'
    and (new.data - 'bookingStatus') = '{}'::jsonb
    and exists (
      select 1 from public.bookings booking
      where booking.id = new.booking_id
        and booking.status = new.data ->> 'bookingStatus'
    ) then
    return new;
  end if;
  if pg_trigger_depth() > 1
    and new.type = 'preferred_date_changed'
    and (new.data - 'scheduledDate') = '{}'::jsonb
    and exists (
      select 1 from public.bookings booking
      where booking.id = new.booking_id
        and booking.scheduled_date::text
          is not distinct from new.data ->> 'scheduledDate'
    ) then
    return new;
  end if;
  raise exception 'Booking event is outside the actor scope'
    using errcode = '42501';
end
$$;
create trigger booking_events_append_guard
  before insert on booking_events for each row
  execute function private.guard_booking_event_append();

drop policy lakeandpine_app_all_booking_events on booking_events;
revoke update, delete on table booking_events from lakeandpine_app;
create policy booking_events_staff_read
  on booking_events for select to lakeandpine_app using (
    private.current_staff_can_access_booking(booking_id)
  );
create policy booking_events_scoped_insert
  on booking_events for insert to lakeandpine_app with check (
    (
      type = 'requested'
      and private.current_cleaner_id() is null
      and exists (
        select 1 from bookings booking
        where booking.id = booking_id
          and (
            (private.current_customer_id() is null
              and booking.customer_id is null)
            or booking.customer_id = private.current_customer_id()
          )
      )
    )
  );

create or replace function public.record_operations_state_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  old_state text;
  new_state text;
  booking_ref uuid;
  case_ref uuid;
  event_organization_id uuid;
  event_team_id uuid;
  actor record;
begin
  old_state := to_jsonb(old) ->> tg_argv[0];
  new_state := to_jsonb(new) ->> tg_argv[0];
  if old_state is not distinct from new_state then
    return new;
  end if;
  booking_ref := case
    when tg_table_name = 'bookings' then new.id
    when tg_table_name = 'job_schedules'
      then nullif(to_jsonb(new) ->> 'booking_id', '')::uuid
    else nullif(to_jsonb(new) ->> 'booking_id', '')::uuid
  end;
  if booking_ref is null and tg_table_name = 'job_assignments' then
    select schedule.booking_id into booking_ref
    from public.job_schedules schedule
    where schedule.id = nullif(to_jsonb(new) ->> 'job_schedule_id', '')::uuid;
  end if;
  case_ref := case
    when tg_table_name = 'service_cases' then new.id
    else nullif(to_jsonb(new) ->> 'service_case_id', '')::uuid
  end;
  if booking_ref is not null then
    select allocation.organization_id, allocation.team_id
      into event_organization_id, event_team_id
    from public.job_schedules schedule
    join public.team_job_allocations allocation
      on allocation.job_schedule_id = schedule.id
    where schedule.booking_id = booking_ref
    order by allocation.allocated_at desc, allocation.id
    limit 1;
  end if;
  if event_team_id is null and case_ref is not null then
    select team.organization_id, service_case.assigned_team_id
      into event_organization_id, event_team_id
    from public.service_cases service_case
    left join public.cleaning_teams team
      on team.id = service_case.assigned_team_id
    where service_case.id = case_ref;
  end if;
  event_organization_id := coalesce(
    event_organization_id, private.lakeandpine_intake_organization_id()
  );
  select * into actor
  from private.current_actor_for_scope(event_organization_id, event_team_id);
  insert into public.operations_state_events
    (entity_type, entity_id, booking_id, service_case_id, field_name,
     from_state, to_state, actor_role, actor_membership_id, is_dev_seed)
  values (
    tg_table_name, new.id, booking_ref, case_ref, tg_argv[0], old_state,
    new_state, actor.actor_role, actor.actor_membership_id,
    coalesce((to_jsonb(new) ->> 'is_dev_seed')::boolean, false)
  );
  return new;
end
$$;

drop policy lakeandpine_app_all_operations_state_events on operations_state_events;
revoke select, insert, update, delete on table operations_state_events
  from lakeandpine_app;

-- Dormant legacy property/intake tables have no production runtime contract.
drop policy lakeandpine_app_all_quotes on quotes;
drop policy lakeandpine_app_all_leads on leads;
drop policy lakeandpine_app_all_rooms on rooms;
drop policy lakeandpine_app_all_cleaning_team_members on cleaning_team_members;
revoke select, insert, update, delete on table quotes from lakeandpine_app;
revoke select, insert, update, delete on table leads from lakeandpine_app;
revoke select, insert, update, delete on table rooms from lakeandpine_app;
revoke select, insert, update, delete on table cleaning_team_members
  from lakeandpine_app;

-- Future public tables and sequences must opt into the application role.
alter default privileges in schema public
  revoke select, insert, update, delete on tables from lakeandpine_app;
alter default privileges in schema public
  revoke usage, select on sequences from lakeandpine_app;

revoke all on function private.guard_customer_home_update() from public;
revoke all on function private.current_customer_billing_history() from public;
revoke all on function private.current_staff_can_access_billing_record(uuid) from public;
revoke all on function private.current_staff_can_access_support_message(uuid) from public;
revoke all on function private.append_service_case_customer_acknowledgement(uuid) from public;
revoke all on function private.guard_support_message_insert() from public;
revoke all on function private.guard_follow_up_identity() from public;
revoke all on function private.current_staff_can_access_territory(uuid) from public;
revoke all on function private.current_actor_role_label() from public;
revoke all on function private.guard_booking_event_append() from public;
grant execute on function private.current_customer_billing_history() to lakeandpine_app;
grant execute on function private.current_staff_can_access_billing_record(uuid)
  to lakeandpine_app;
grant execute on function private.current_staff_can_access_support_message(uuid)
  to lakeandpine_app;
grant execute on function private.current_staff_can_access_territory(uuid)
  to lakeandpine_app;
grant execute on function private.append_service_case_customer_acknowledgement(uuid)
  to lakeandpine_app;

-- Durable notification queue boundary ---------------------------------------

create function private.enqueue_booking_intake_notifications(
  requested_booking_id uuid
) returns table (
  customer_notification_id uuid,
  ops_notification_id uuid
) language plpgsql security definer set search_path = '' as $$
declare
  linked_booking public.bookings%rowtype;
  customer_deduplication_key text;
  ops_deduplication_key text;
begin
  select booking.* into linked_booking
  from public.bookings booking
  where booking.id = requested_booking_id
  for share;
  if linked_booking.id is null
    or private.current_cleaner_id() is not null
    or not (
      (private.current_customer_id() is null
        and linked_booking.customer_id is null)
      or linked_booking.customer_id = private.current_customer_id()
      or private.current_staff_can_access_booking(linked_booking.id)
    )
    or char_length(trim(coalesce(linked_booking.contact ->> 'email', '')))
      not between 5 and 320 then
    raise exception 'Booking notification enqueue is outside the actor scope'
      using errcode = '42501';
  end if;
  customer_deduplication_key :=
    'booking:' || linked_booking.id::text || ':customer_confirmation';
  ops_deduplication_key :=
    'booking:' || linked_booking.id::text || ':ops_notification';

  insert into public.notification_outbox
    (booking_id, customer_id, notification_type, channel, recipient_kind,
     recipient_address, template_key, template_data, deduplication_key,
     next_attempt_at, is_dev_seed)
  values (
    linked_booking.id, linked_booking.customer_id, 'customer_confirmation',
    'email', 'customer', lower(trim(linked_booking.contact ->> 'email')),
    'booking-request-received',
    jsonb_build_object('bookingId', linked_booking.id),
    customer_deduplication_key, clock_timestamp() + interval '15 minutes',
    linked_booking.is_dev_seed
  )
  on conflict (deduplication_key) do nothing
  returning id into customer_notification_id;
  if customer_notification_id is null then
    select notification.id into customer_notification_id
    from public.notification_outbox notification
    where notification.booking_id = linked_booking.id
      and notification.notification_type = 'customer_confirmation'
      and notification.channel = 'email'
      and notification.recipient_kind = 'customer'
      and notification.recipient_address =
        lower(trim(linked_booking.contact ->> 'email'))
      and notification.template_key = 'booking-request-received'
      and notification.template_data =
        jsonb_build_object('bookingId', linked_booking.id)
      and notification.deduplication_key = customer_deduplication_key
      and notification.is_dev_seed = linked_booking.is_dev_seed;
  end if;
  if customer_notification_id is null then
    raise exception 'Booking customer notification conflict'
      using errcode = '23505';
  end if;

  insert into public.notification_outbox
    (booking_id, customer_id, notification_type, channel, recipient_kind,
     recipient_address, template_key, template_data, deduplication_key,
     next_attempt_at, is_dev_seed)
  values (
    linked_booking.id, linked_booking.customer_id, 'ops_notification',
    'email', 'ops', null, 'ops-booking-request',
    jsonb_build_object('bookingId', linked_booking.id),
    ops_deduplication_key, clock_timestamp() + interval '15 minutes',
    linked_booking.is_dev_seed
  )
  on conflict (deduplication_key) do nothing
  returning id into ops_notification_id;
  if ops_notification_id is null then
    select notification.id into ops_notification_id
    from public.notification_outbox notification
    where notification.booking_id = linked_booking.id
      and notification.notification_type = 'ops_notification'
      and notification.channel = 'email'
      and notification.recipient_kind = 'ops'
      and notification.recipient_address is null
      and notification.template_key = 'ops-booking-request'
      and notification.template_data =
        jsonb_build_object('bookingId', linked_booking.id)
      and notification.deduplication_key = ops_deduplication_key
      and notification.is_dev_seed = linked_booking.is_dev_seed;
  end if;
  if ops_notification_id is null then
    raise exception 'Booking ops notification conflict' using errcode = '23505';
  end if;
  return next;
end
$$;

create function private.enqueue_service_case_ops_notification(
  requested_service_case_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  linked_case public.service_cases%rowtype;
  authoritative_customer_id uuid;
  expected_deduplication_key text;
  notification_id uuid;
begin
  if private.current_customer_id() is null
    or private.current_cleaner_id() is not null then
    raise exception 'Service-case notification actor is invalid'
      using errcode = '42501';
  end if;
  select service_case.* into linked_case
  from public.service_cases service_case
  where service_case.id = requested_service_case_id
  for share;
  if linked_case.id is null then
    raise exception 'Service-case notification subject is unavailable'
      using errcode = '42501';
  end if;
  select coalesce(
    linked_case.customer_id,
    (select booking.customer_id from public.bookings booking
      where booking.id = linked_case.booking_id)
  ) into authoritative_customer_id;
  if not (
    authoritative_customer_id = private.current_customer_id()
    or private.current_staff_can_manage_service_case(linked_case.id)
  ) then
    raise exception 'Service-case notification is outside the actor scope'
      using errcode = '42501';
  end if;
  expected_deduplication_key :=
    'service-case:' || linked_case.id::text || ':ops_notification';
  insert into public.notification_outbox
    (service_case_id, customer_id, notification_type, channel, recipient_kind,
     template_key, template_data, deduplication_key, next_attempt_at, is_dev_seed)
  values (
    linked_case.id, authoritative_customer_id, 'ops_notification', 'email',
    'ops', 'ops-service-case',
    jsonb_build_object('serviceCaseId', linked_case.id),
    expected_deduplication_key, clock_timestamp() + interval '15 minutes',
    linked_case.is_dev_seed
  )
  on conflict (deduplication_key) do nothing
  returning id into notification_id;
  if notification_id is null then
    select notification.id into notification_id
    from public.notification_outbox notification
    where notification.service_case_id = linked_case.id
      and notification.customer_id is not distinct from authoritative_customer_id
      and notification.booking_id is null
      and notification.notification_type = 'ops_notification'
      and notification.channel = 'email'
      and notification.recipient_kind = 'ops'
      and notification.recipient_address is null
      and notification.template_key = 'ops-service-case'
      and notification.template_data =
        jsonb_build_object('serviceCaseId', linked_case.id)
      and notification.deduplication_key = expected_deduplication_key
      and notification.is_dev_seed = linked_case.is_dev_seed;
  end if;
  if notification_id is null then
    raise exception 'Service-case notification conflict' using errcode = '23505';
  end if;
  return notification_id;
end
$$;

create function private.create_authenticated_service_case(
  requested_idempotency_hash text,
  requested_public_reference text,
  requested_customer_id uuid,
  requested_booking_id uuid,
  requested_case_type text,
  requested_details text
) returns table (
  service_case_id uuid,
  case_reference text,
  duplicate boolean,
  notification_outbox_id uuid
) language plpgsql security definer set search_path = '' as $$
declare
  existing_case public.service_cases%rowtype;
  active_reschedule public.service_cases%rowtype;
  owned_customer public.customers%rowtype;
  linked_booking public.bookings%rowtype;
  created_case_id uuid;
  created_notification_id uuid;
  authoritative_contact jsonb;
  authoritative_is_dev_seed boolean;
begin
  if private.current_cleaner_id() is not null
    or private.current_customer_id() is distinct from requested_customer_id
    or requested_idempotency_hash !~ '^[0-9a-f]{64}$'
    or char_length(coalesce(requested_public_reference, '')) not between 8 and 80
    or requested_case_type not in (
      'reschedule', 'cancel', 'complaint', 'reclean',
      'refund_review', 'damage', 'other'
    )
    or char_length(trim(coalesce(requested_details, ''))) not between 1 and 4000 then
    raise exception 'Authenticated service-case intake is invalid'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'authenticated-service-case:' || requested_customer_id::text
        || ':' || requested_idempotency_hash,
      9402
    )
  );
  select service_case.* into existing_case
  from public.service_cases service_case
  where service_case.idempotency_key = requested_idempotency_hash
  for share;
  if existing_case.id is not null then
    if existing_case.customer_id is distinct from requested_customer_id
      or existing_case.booking_id is distinct from requested_booking_id
      or existing_case.case_type <> requested_case_type
      or existing_case.details <> trim(requested_details) then
      raise exception 'Idempotency key was already used for another service request'
        using errcode = '23505';
    end if;
    return query select existing_case.id, existing_case.public_reference,
      true, null::uuid;
    return;
  end if;

  select customer.* into owned_customer
  from public.customers customer
  where customer.id = requested_customer_id
  for share;
  if owned_customer.id is null then
    raise exception 'Authenticated customer account is unavailable'
      using errcode = '42501';
  end if;

  if requested_booking_id is not null then
    select booking.* into linked_booking
    from public.bookings booking
    where booking.id = requested_booking_id
      and booking.customer_id = requested_customer_id
    for update;
    if linked_booking.id is null then
      raise exception 'Authenticated service case must use an owned booking'
        using errcode = '42501';
    end if;
  end if;
  if requested_case_type in (
      'reschedule', 'cancel', 'reclean', 'refund_review', 'damage'
    ) and linked_booking.id is null then
    raise exception 'This service-case type requires an owned booking'
      using errcode = '23514';
  end if;
  if requested_case_type in ('reschedule', 'cancel')
    and linked_booking.status not in (
      'requested', 'reviewing', 'ready', 'confirmed', 'scheduled'
    ) then
    raise exception 'Booking is no longer eligible for a schedule change'
      using errcode = '23514';
  end if;

  if requested_case_type = 'reschedule' then
    perform pg_advisory_xact_lock(
      hashtextextended('active-reschedule:' || linked_booking.id::text, 9403)
    );
    select service_case.* into active_reschedule
    from public.service_cases service_case
    where service_case.booking_id = linked_booking.id
      and service_case.case_type = 'reschedule'
      and service_case.status not in ('resolved', 'closed', 'declined', 'canceled')
    order by service_case.created_at desc, service_case.id desc
    limit 1;
    if active_reschedule.id is not null then
      return query select active_reschedule.id, active_reschedule.public_reference,
        true, null::uuid;
      return;
    end if;
  end if;

  authoritative_contact := case
    when linked_booking.id is not null then linked_booking.contact
    else jsonb_strip_nulls(jsonb_build_object(
      'name', owned_customer.full_name,
      'email', owned_customer.email,
      'phone', owned_customer.phone
    ))
  end;
  authoritative_is_dev_seed := case
    when linked_booking.id is not null then linked_booking.is_dev_seed
    else owned_customer.is_dev_seed
  end;
  created_case_id := gen_random_uuid();
  insert into private.public_service_case_write_authorizations
    (service_case_id, backend_pid, transaction_id)
  values (created_case_id, pg_backend_pid(), pg_current_xact_id());
  insert into public.service_cases
    (id, public_reference, idempotency_key, case_type, booking_id, customer_id,
     contact, details, status, priority, consent_snapshot, consented_at,
     first_response_due_at, is_dev_seed)
  values (
    created_case_id, requested_public_reference, requested_idempotency_hash,
    requested_case_type, linked_booking.id, requested_customer_id,
    authoritative_contact, trim(requested_details), 'submitted', 'normal',
    jsonb_build_object('source', 'authenticated_dashboard_support'),
    clock_timestamp(), clock_timestamp() + interval '4 hours',
    authoritative_is_dev_seed
  );
  insert into public.support_messages
    (customer_id, service_case_id, sender, body, is_dev_seed)
  values (
    requested_customer_id, created_case_id, 'customer',
    trim(requested_details), authoritative_is_dev_seed
  );
  created_notification_id :=
    private.enqueue_service_case_ops_notification(created_case_id);
  if created_notification_id is null then
    raise exception 'Service-case notification could not be queued'
      using errcode = '55000';
  end if;
  return query select created_case_id, requested_public_reference,
    false, created_notification_id;
end
$$;

revoke all on function private.create_authenticated_service_case(
  text, text, uuid, uuid, text, text
) from public;
grant execute on function private.create_authenticated_service_case(
  text, text, uuid, uuid, text, text
) to lakeandpine_app;

create function private.finish_initial_booking_notification_delivery(
  requested_outbox_id uuid,
  requested_booking_id uuid,
  requested_notification_type text,
  requested_outcome text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if requested_notification_type not in (
      'customer_confirmation', 'ops_notification'
    )
    or requested_outcome not in ('sent', 'suppressed', 'skipped', 'failed') then
    raise exception 'Booking delivery outcome is invalid' using errcode = '22023';
  end if;
  update public.notification_outbox notification
  set status = case requested_outcome
        when 'sent' then 'sent'
        when 'suppressed' then 'canceled'
        when 'failed' then 'retry'
        else 'failed'
      end,
      attempt_count = notification.attempt_count + 1,
      sent_at = case when requested_outcome = 'sent'
        then clock_timestamp() else notification.sent_at end,
      next_attempt_at = case when requested_outcome = 'failed'
        then clock_timestamp() + interval '15 minutes'
        else notification.next_attempt_at end,
      last_error_code = case when requested_outcome = 'sent'
        then null else requested_outcome end,
      locked_at = null
  where notification.booking_id = requested_booking_id
    and notification.id = requested_outbox_id
    and notification.notification_type = requested_notification_type
    and notification.status = 'pending'
    and notification.attempt_count = 0
    and notification.locked_at is null;
  return found;
end
$$;

create function private.finish_initial_service_case_notification_delivery(
  requested_outbox_id uuid,
  requested_service_case_id uuid,
  requested_outcome text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if requested_outcome not in ('sent', 'suppressed', 'skipped', 'failed') then
    raise exception 'Service-case delivery outcome is invalid' using errcode = '22023';
  end if;
  update public.notification_outbox notification
  set status = case requested_outcome
        when 'sent' then 'sent'
        when 'suppressed' then 'canceled'
        when 'failed' then 'retry'
        else 'failed'
      end,
      attempt_count = notification.attempt_count + 1,
      sent_at = case when requested_outcome = 'sent'
        then clock_timestamp() else notification.sent_at end,
      next_attempt_at = case when requested_outcome = 'failed'
        then clock_timestamp() + interval '15 minutes'
        else notification.next_attempt_at end,
      last_error_code = case when requested_outcome = 'sent'
        then null else requested_outcome end,
      locked_at = null
  where notification.service_case_id = requested_service_case_id
    and notification.id = requested_outbox_id
    and notification.notification_type = 'ops_notification'
    and notification.status = 'pending'
    and notification.attempt_count = 0
    and notification.locked_at is null;
  return found;
end
$$;

create function private.claim_notification_outbox_delivery(
  requested_outbox_id uuid,
  require_dev_seed boolean
) returns table (
  id uuid,
  claim_locked_at timestamptz,
  delivery_idempotency_key text,
  booking_id uuid,
  service_case_id uuid,
  notification_type text,
  booking_contact jsonb,
  service_title text,
  scheduled_date text,
  scheduled_window text,
  qualification_status text,
  planning_direction text,
  case_reference text,
  case_type text
) language plpgsql security definer set search_path = '' as $$
declare
  claimed_at timestamptz := clock_timestamp();
begin
  if private.current_customer_id() is null
    or private.current_cleaner_id() is not null then
    raise exception 'Staff notification actor is required' using errcode = '42501';
  end if;
  return query
  with candidate as (
    select notification.id
    from public.notification_outbox notification
    where notification.id = requested_outbox_id
      and notification.notification_type in (
        'customer_confirmation', 'ops_notification'
      )
      and (not coalesce(require_dev_seed, false) or notification.is_dev_seed)
      and (
        (notification.status in ('pending', 'retry')
          and notification.next_attempt_at <= claimed_at)
        or notification.status = 'failed'
        or (notification.status = 'processing'
          and notification.locked_at < claimed_at - interval '15 minutes')
      )
      and (
        (notification.booking_id is not null
          and private.current_staff_can_access_booking(notification.booking_id))
        or (notification.service_case_id is not null
          and private.current_staff_can_manage_service_case(
            notification.service_case_id
          ))
      )
    for update skip locked
  ), claimed as (
    update public.notification_outbox notification
    set status = 'processing', locked_at = claimed_at,
        last_error_code = null
    from candidate
    where notification.id = candidate.id
    returning notification.*
  )
  select claimed.id, claimed.locked_at, claimed.deduplication_key,
    claimed.booking_id, claimed.service_case_id, claimed.notification_type,
    booking.contact, service.title,
    to_char(booking.scheduled_date, 'YYYY-MM-DD'),
    booking.scheduled_window, booking.qualification_status,
    booking.planning_direction, service_case.public_reference,
    service_case.case_type
  from claimed
  left join public.bookings booking on booking.id = claimed.booking_id
  left join public.services service on service.id = booking.service_id
  left join public.service_cases service_case
    on service_case.id = claimed.service_case_id;
end
$$;

create function private.finish_notification_outbox_delivery(
  requested_outbox_id uuid,
  requested_claim_locked_at timestamptz,
  requested_outcome text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if private.current_customer_id() is null
    or private.current_cleaner_id() is not null
    or requested_claim_locked_at is null
    or requested_outcome not in ('sent', 'suppressed', 'skipped', 'failed') then
    raise exception 'Notification finish request is invalid' using errcode = '42501';
  end if;
  update public.notification_outbox notification
  set status = case requested_outcome
        when 'sent' then 'sent'
        when 'suppressed' then 'canceled'
        when 'failed' then 'retry'
        else 'failed'
      end,
      attempt_count = notification.attempt_count + 1,
      sent_at = case when requested_outcome = 'sent'
        then clock_timestamp() else notification.sent_at end,
      next_attempt_at = case when requested_outcome = 'failed'
        then clock_timestamp() + interval '15 minutes'
        else notification.next_attempt_at end,
      last_error_code = case when requested_outcome = 'sent'
        then null else requested_outcome end,
      locked_at = null
  where notification.id = requested_outbox_id
    and notification.status = 'processing'
    and notification.locked_at = requested_claim_locked_at
    and (
      (notification.booking_id is not null
        and private.current_staff_can_access_booking(notification.booking_id))
      or (notification.service_case_id is not null
        and private.current_staff_can_manage_service_case(
          notification.service_case_id
        ))
    );
  return found;
end
$$;

drop policy lakeandpine_app_all_notification_outbox on notification_outbox;
revoke insert, update, delete on table notification_outbox from lakeandpine_app;
create policy notification_outbox_national_read
  on notification_outbox for select to lakeandpine_app using (
    private.can_access_organization(
      private.lakeandpine_intake_organization_id(), array['owner', 'gm']
    )
  );

-- Customer payment identity and signed Stripe event boundary ----------------

create function private.current_customer_payment_identity()
returns table (
  customer_id uuid,
  email text,
  stripe_customer_id text
) language plpgsql stable security definer set search_path = '' as $$
begin
  if private.current_customer_id() is null
    or private.current_cleaner_id() is not null then
    raise exception 'Customer payment identity is required' using errcode = '42501';
  end if;
  return query
  select customer.id, lower(trim(customer.email)), customer.stripe_customer_id
  from public.customers customer
  where customer.id = private.current_customer_id()
    and customer.clerk_user_id is not null
    and char_length(trim(coalesce(customer.email, ''))) between 5 and 320
  limit 1;
end
$$;

create function private.bind_current_customer_stripe_customer_id(
  requested_stripe_customer_id text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  actor_customer public.customers%rowtype;
begin
  if private.current_customer_id() is null
    or private.current_cleaner_id() is not null
    or requested_stripe_customer_id is null
    or requested_stripe_customer_id !~ '^cus_[A-Za-z0-9]{3,252}$' then
    return false;
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('stripe-customer:' || requested_stripe_customer_id, 9501)
  );
  select customer.* into actor_customer
  from public.customers customer
  where customer.id = private.current_customer_id()
    and customer.clerk_user_id is not null
    and customer.email is not null
  for update;
  if actor_customer.id is null
    or (actor_customer.stripe_customer_id is not null
      and actor_customer.stripe_customer_id <> requested_stripe_customer_id)
    or exists (
      select 1 from public.customers customer
      where customer.stripe_customer_id = requested_stripe_customer_id
        and customer.id <> actor_customer.id
    ) then
    return false;
  end if;
  if actor_customer.stripe_customer_id is null then
    update public.customers customer
    set stripe_customer_id = requested_stripe_customer_id
    where customer.id = actor_customer.id and customer.stripe_customer_id is null;
  end if;
  return true;
end
$$;

create function private.claim_stripe_event_receipt(
  requested_event_id text,
  requested_event_type text,
  requested_livemode boolean,
  requested_payload_sha256 text
) returns table (
  claimed boolean,
  receipt_status text
) language plpgsql security definer set search_path = '' as $$
declare
  existing_receipt public.stripe_event_receipts%rowtype;
begin
  if requested_event_id is null
    or char_length(requested_event_id) not between 5 and 255
    or requested_event_id !~ '^evt_[A-Za-z0-9]+$'
    or requested_event_type is null
    or char_length(requested_event_type) not between 3 and 200
    or requested_event_type !~ '^[a-z0-9_.]+$'
    or requested_livemode is null
    or requested_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Stripe receipt identity is invalid' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('stripe-event:' || requested_event_id, 9601)
  );
  select receipt.* into existing_receipt
  from public.stripe_event_receipts receipt
  where receipt.event_id = requested_event_id
  for update;
  if existing_receipt.event_id is null then
    insert into public.stripe_event_receipts
      (event_id, event_type, livemode, payload_sha256, status,
       attempt_count, last_attempt_at)
    values (
      requested_event_id, requested_event_type, requested_livemode,
      requested_payload_sha256, 'processing', 1, clock_timestamp()
    );
    claimed := true;
    receipt_status := 'processing';
    return next;
    return;
  end if;
  if existing_receipt.event_type <> requested_event_type
    or existing_receipt.livemode <> requested_livemode
    or existing_receipt.payload_sha256 <> requested_payload_sha256 then
    raise exception 'Stripe event receipt identity mismatch'
      using errcode = '22000';
  end if;
  if existing_receipt.status in ('processed', 'ignored') then
    claimed := false;
    receipt_status := existing_receipt.status;
    return next;
    return;
  end if;
  if existing_receipt.status = 'processing'
    and existing_receipt.last_attempt_at >=
      clock_timestamp() - interval '15 minutes' then
    claimed := false;
    receipt_status := 'processing';
    return next;
    return;
  end if;
  update public.stripe_event_receipts receipt
  set status = 'processing',
      attempt_count = receipt.attempt_count + 1,
      last_attempt_at = clock_timestamp(),
      processed_at = null,
      last_error_code = null
  where receipt.event_id = requested_event_id;
  claimed := true;
  receipt_status := 'processing';
  return next;
end
$$;

create function private.complete_stripe_checkout_session(
  requested_event_id text,
  requested_payload_sha256 text,
  requested_customer_id uuid,
  requested_stripe_customer_id text,
  requested_description text,
  requested_amount_cents integer,
  requested_paid_payment_intent_id text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  actor_customer public.customers%rowtype;
  receipt public.stripe_event_receipts%rowtype;
  existing_billing public.billing_records%rowtype;
begin
  if requested_stripe_customer_id !~ '^cus_[A-Za-z0-9]{3,252}$'
    or char_length(trim(coalesce(requested_description, ''))) not between 1 and 500
    or requested_amount_cents not between 0 and 100000000
    or (requested_paid_payment_intent_id is not null
      and requested_paid_payment_intent_id !~ '^pi_[A-Za-z0-9]{3,252}$') then
    raise exception 'Stripe checkout completion is invalid' using errcode = '22023';
  end if;
  select event_receipt.* into receipt
  from public.stripe_event_receipts event_receipt
  where event_receipt.event_id = requested_event_id
    and event_receipt.payload_sha256 = requested_payload_sha256
    and event_receipt.event_type in (
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded'
    )
    and event_receipt.status = 'processing'
  for update;
  if receipt.event_id is null then
    return false;
  end if;
  select customer.* into actor_customer
  from public.customers customer
  where customer.id = requested_customer_id
    and customer.clerk_user_id is not null
  for update;
  if actor_customer.id is null
    or (actor_customer.stripe_customer_id is not null
      and actor_customer.stripe_customer_id <> requested_stripe_customer_id)
    or exists (
      select 1 from public.customers customer
      where customer.stripe_customer_id = requested_stripe_customer_id
        and customer.id <> requested_customer_id
    ) then
    raise exception 'Stripe checkout customer identity mismatch'
      using errcode = '42501';
  end if;
  if actor_customer.stripe_customer_id is null then
    update public.customers customer
    set stripe_customer_id = requested_stripe_customer_id
    where customer.id = requested_customer_id
      and customer.stripe_customer_id is null;
  end if;
  if requested_paid_payment_intent_id is not null then
    insert into public.billing_records
      (customer_id, description, amount_cents, status,
       stripe_payment_intent_id, is_dev_seed)
    values (
      requested_customer_id, trim(requested_description),
      requested_amount_cents, 'paid', requested_paid_payment_intent_id,
      actor_customer.is_dev_seed
    )
    on conflict do nothing;
    select billing.* into existing_billing
    from public.billing_records billing
    where billing.stripe_payment_intent_id = requested_paid_payment_intent_id;
    if existing_billing.id is null
      or existing_billing.customer_id <> requested_customer_id
      or existing_billing.amount_cents <> requested_amount_cents
      or existing_billing.status <> 'paid'
      or existing_billing.description <> trim(requested_description) then
      raise exception 'Stripe payment-intent receipt conflict'
        using errcode = '23505';
    end if;
  end if;
  update public.stripe_event_receipts event_receipt
  set status = 'processed', processed_at = clock_timestamp(),
      last_error_code = null
  where event_receipt.event_id = requested_event_id
    and event_receipt.payload_sha256 = requested_payload_sha256
    and event_receipt.status = 'processing';
  return found;
end
$$;

create function private.complete_stripe_invoice_paid(
  requested_event_id text,
  requested_payload_sha256 text,
  requested_customer_id uuid,
  requested_stripe_customer_id text,
  requested_description text,
  requested_amount_cents integer,
  requested_stripe_invoice_id text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  actor_customer public.customers%rowtype;
  receipt public.stripe_event_receipts%rowtype;
  existing_billing public.billing_records%rowtype;
begin
  if requested_stripe_customer_id !~ '^cus_[A-Za-z0-9]{3,252}$'
    or requested_stripe_invoice_id !~ '^in_[A-Za-z0-9]{3,252}$'
    or char_length(trim(coalesce(requested_description, ''))) not between 1 and 500
    or requested_amount_cents not between 0 and 100000000 then
    raise exception 'Stripe invoice completion is invalid' using errcode = '22023';
  end if;
  select event_receipt.* into receipt
  from public.stripe_event_receipts event_receipt
  where event_receipt.event_id = requested_event_id
    and event_receipt.payload_sha256 = requested_payload_sha256
    and event_receipt.event_type = 'invoice.paid'
    and event_receipt.status = 'processing'
  for update;
  if receipt.event_id is null then
    return false;
  end if;
  select customer.* into actor_customer
  from public.customers customer
  where customer.id = requested_customer_id
    and customer.stripe_customer_id = requested_stripe_customer_id
    and customer.clerk_user_id is not null
  for update;
  if actor_customer.id is null then
    raise exception 'Stripe invoice customer identity mismatch'
      using errcode = '42501';
  end if;
  insert into public.billing_records
    (customer_id, description, amount_cents, status, stripe_invoice_id,
     is_dev_seed)
  values (
    actor_customer.id, trim(requested_description), requested_amount_cents,
    'paid', requested_stripe_invoice_id, actor_customer.is_dev_seed
  )
  on conflict do nothing;
  select billing.* into existing_billing
  from public.billing_records billing
  where billing.stripe_invoice_id = requested_stripe_invoice_id;
  if existing_billing.id is null
    or existing_billing.customer_id <> actor_customer.id
    or existing_billing.amount_cents <> requested_amount_cents
    or existing_billing.status <> 'paid'
    or existing_billing.description <> trim(requested_description) then
    raise exception 'Stripe invoice receipt conflict' using errcode = '23505';
  end if;
  update public.stripe_event_receipts event_receipt
  set status = 'processed', processed_at = clock_timestamp(),
      last_error_code = null
  where event_receipt.event_id = requested_event_id
    and event_receipt.payload_sha256 = requested_payload_sha256
    and event_receipt.status = 'processing';
  return found;
end
$$;

create function private.complete_stripe_payment_failed(
  requested_event_id text,
  requested_payload_sha256 text,
  requested_customer_id uuid,
  requested_stripe_customer_id text,
  requested_stripe_invoice_id text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  actor_customer public.customers%rowtype;
  receipt public.stripe_event_receipts%rowtype;
begin
  if requested_stripe_customer_id !~ '^cus_[A-Za-z0-9]{3,252}$'
    or requested_stripe_invoice_id !~ '^in_[A-Za-z0-9]{3,252}$' then
    raise exception 'Stripe payment-failure identity is invalid'
      using errcode = '22023';
  end if;
  select event_receipt.* into receipt
  from public.stripe_event_receipts event_receipt
  where event_receipt.event_id = requested_event_id
    and event_receipt.payload_sha256 = requested_payload_sha256
    and event_receipt.event_type = 'invoice.payment_failed'
    and event_receipt.status = 'processing'
  for update;
  if receipt.event_id is null then
    return false;
  end if;
  select customer.* into actor_customer
  from public.customers customer
  where customer.id = requested_customer_id
    and customer.stripe_customer_id = requested_stripe_customer_id
    and customer.clerk_user_id is not null
  for update;
  if actor_customer.id is null then
    raise exception 'Stripe payment-failure customer identity mismatch'
      using errcode = '42501';
  end if;
  insert into public.support_messages
    (customer_id, sender, body, is_dev_seed)
  values (
    actor_customer.id, 'concierge',
    'We could not confirm the latest payment. Your service schedule has not been changed; please review billing or contact support.',
    actor_customer.is_dev_seed
  );
  update public.stripe_event_receipts event_receipt
  set status = 'processed', processed_at = clock_timestamp(),
      last_error_code = null
  where event_receipt.event_id = requested_event_id
    and event_receipt.payload_sha256 = requested_payload_sha256
    and event_receipt.status = 'processing';
  return found;
end
$$;

create function private.finish_stripe_event_receipt(
  requested_event_id text,
  requested_payload_sha256 text,
  requested_outcome text,
  requested_error_code text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  safe_error_code text;
begin
  if requested_outcome not in ('ignored', 'failed')
    or requested_payload_sha256 !~ '^[0-9a-f]{64}$'
    or char_length(coalesce(requested_error_code, '')) > 500 then
    raise exception 'Stripe receipt outcome is invalid' using errcode = '22023';
  end if;
  safe_error_code := left(regexp_replace(
    coalesce(nullif(requested_error_code, ''), 'WebhookProcessingError'),
    '[^A-Za-z0-9_.:-]', '', 'g'
  ), 120);
  if safe_error_code = '' then
    safe_error_code := 'WebhookProcessingError';
  end if;
  update public.stripe_event_receipts receipt
  set status = requested_outcome,
      processed_at = case when requested_outcome = 'ignored'
        then clock_timestamp() else null end,
      last_error_code = case when requested_outcome = 'failed'
        then safe_error_code else null end
  where receipt.event_id = requested_event_id
    and receipt.payload_sha256 = requested_payload_sha256
    and receipt.status = 'processing';
  return found;
end
$$;

drop policy lakeandpine_app_all_stripe_event_receipts on stripe_event_receipts;
revoke select, insert, update, delete on table stripe_event_receipts
  from lakeandpine_app;

revoke all on function private.enqueue_booking_intake_notifications(uuid) from public;
revoke all on function private.enqueue_service_case_ops_notification(uuid) from public;
revoke all on function private.finish_initial_booking_notification_delivery(
  uuid, uuid, text, text
) from public;
revoke all on function private.finish_initial_service_case_notification_delivery(
  uuid, uuid, text
) from public;
revoke all on function private.claim_notification_outbox_delivery(uuid, boolean)
  from public;
revoke all on function private.finish_notification_outbox_delivery(
  uuid, timestamptz, text
) from public;
revoke all on function private.current_customer_payment_identity() from public;
revoke all on function private.bind_current_customer_stripe_customer_id(text)
  from public;
revoke all on function private.claim_stripe_event_receipt(
  text, text, boolean, text
) from public;
revoke all on function private.complete_stripe_checkout_session(
  text, text, uuid, text, text, integer, text
) from public;
revoke all on function private.complete_stripe_invoice_paid(
  text, text, uuid, text, text, integer, text
) from public;
revoke all on function private.complete_stripe_payment_failed(
  text, text, uuid, text, text
) from public;
revoke all on function private.finish_stripe_event_receipt(
  text, text, text, text
) from public;
grant execute on function private.enqueue_booking_intake_notifications(uuid)
  to lakeandpine_app;
grant execute on function private.enqueue_service_case_ops_notification(uuid)
  to lakeandpine_app;
grant execute on function private.finish_initial_booking_notification_delivery(
  uuid, uuid, text, text
) to lakeandpine_app;
grant execute on function private.finish_initial_service_case_notification_delivery(
  uuid, uuid, text
) to lakeandpine_app;
grant execute on function private.claim_notification_outbox_delivery(uuid, boolean)
  to lakeandpine_app;
grant execute on function private.finish_notification_outbox_delivery(
  uuid, timestamptz, text
) to lakeandpine_app;
grant execute on function private.current_customer_payment_identity()
  to lakeandpine_app;
grant execute on function private.bind_current_customer_stripe_customer_id(text)
  to lakeandpine_app;
grant execute on function private.claim_stripe_event_receipt(
  text, text, boolean, text
) to lakeandpine_app;
grant execute on function private.complete_stripe_checkout_session(
  text, text, uuid, text, text, integer, text
) to lakeandpine_app;
grant execute on function private.complete_stripe_invoice_paid(
  text, text, uuid, text, text, integer, text
) to lakeandpine_app;
grant execute on function private.complete_stripe_payment_failed(
  text, text, uuid, text, text
) to lakeandpine_app;
grant execute on function private.finish_stripe_event_receipt(
  text, text, text, text
) to lakeandpine_app;

-- Accountable time and leave evidence --------------------------------------
-- The national foundation exposed mutable time evidence through broad row
-- grants and trusted caller-supplied actor IDs. Keep raw clock/leave facts
-- immutable, stamp the current actor in the database, and allow only explicit
-- lifecycle transitions through the application role.

alter table public.job_time_entries
  add column created_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column submitted_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column submitted_at timestamptz,
  add column reviewed_at timestamptz,
  add column review_reason text,
  add constraint job_time_entries_review_reason_length_check check (
    review_reason is null
    or char_length(trim(review_reason)) between 2 and 1000
  );

alter table public.job_time_entries
  drop constraint job_time_entries_approved_by_membership_id_fkey,
  add constraint job_time_entries_approved_by_membership_id_fkey
    foreign key (approved_by_membership_id)
    references public.workforce_memberships(id) on delete restrict;

update public.job_time_entries
set submitted_at = coalesce(submitted_at, clock_out_at)
where status <> 'open' and submitted_at is null;

update public.job_time_entries
set reviewed_at = coalesce(reviewed_at, approved_at, updated_at),
    review_reason = case
      when status = 'rejected' and review_reason is null
        then coalesce(nullif(trim(adjustment_reason), ''), 'Legacy rejected time entry')
      else review_reason
    end
where status in ('approved', 'rejected')
  and (reviewed_at is null or (status = 'rejected' and review_reason is null));

create index job_time_entries_creator_idx
  on public.job_time_entries (created_by_membership_id)
  where created_by_membership_id is not null;
create index job_time_entries_submitter_idx
  on public.job_time_entries (submitted_by_membership_id)
  where submitted_by_membership_id is not null;

alter table public.cleaner_time_off
  add column requested_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column version integer not null default 1,
  add column review_reason text,
  add constraint cleaner_time_off_version_check check (version > 0),
  add constraint cleaner_time_off_review_reason_length_check check (
    review_reason is null
    or char_length(trim(review_reason)) between 2 and 1000
  );

alter table public.cleaner_time_off
  drop constraint cleaner_time_off_cleaner_id_fkey,
  drop constraint cleaner_time_off_organization_id_fkey,
  drop constraint cleaner_time_off_reviewed_by_membership_id_fkey,
  add constraint cleaner_time_off_cleaner_id_fkey
    foreign key (cleaner_id) references public.cleaners(id) on delete restrict,
  add constraint cleaner_time_off_organization_id_fkey
    foreign key (organization_id) references public.organizations(id) on delete restrict,
  add constraint cleaner_time_off_reviewed_by_membership_id_fkey
    foreign key (reviewed_by_membership_id)
    references public.workforce_memberships(id) on delete restrict;

update public.cleaner_time_off
set review_reason = coalesce(
      review_reason,
      case when status = 'declined' then 'Legacy declined time-off request' end
    )
where status = 'declined' and review_reason is null;

create index cleaner_time_off_requester_idx
  on public.cleaner_time_off (requested_by_membership_id)
  where requested_by_membership_id is not null;

drop trigger if exists job_time_entries_approver_scope_guard
  on public.job_time_entries;
drop trigger if exists job_time_entries_team_assignment_guard
  on public.job_time_entries;
drop trigger if exists job_time_entries_crew_update_guard
  on public.job_time_entries;
drop trigger if exists job_time_entries_start_window_guard
  on public.job_time_entries;
drop trigger if exists cleaner_time_off_assignment_guard
  on public.cleaner_time_off;

revoke all on function public.validate_team_time_entry()
  from public, lakeandpine_app;
revoke all on function public.validate_time_off_against_assignments()
  from public, lakeandpine_app;
revoke all on function private.guard_crew_time_entry_update()
  from public, lakeandpine_app;
revoke all on function private.guard_crew_time_entry_start_window()
  from public, lakeandpine_app;

create function private.guard_job_time_entry_evidence() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_customer_id uuid := private.current_customer_id();
  actor_cleaner_id uuid := private.current_cleaner_id();
  actor_membership record;
  allocation_context record;
  evidence_at timestamptz := clock_timestamp();
begin
  -- Migration owners and offline import tooling do not set an application
  -- actor. Their writes remain available for controlled backfills.
  if actor_customer_id is null and actor_cleaner_id is null then
    return new;
  end if;
  if actor_customer_id is not null and actor_cleaner_id is not null then
    raise exception 'Time evidence requires exactly one current actor'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    select allocation.organization_id, allocation.team_id,
           allocation.is_dev_seed,
           schedule.status as schedule_status,
           schedule.start_at, schedule.end_at,
           schedule.travel_buffer_minutes,
           greatest(1, ceil(
             schedule.labor_minutes::numeric / schedule.required_crew_size
           )::integer) as trusted_estimate,
           coalesce((
             select proposal.arrival_window_start
             from public.schedule_proposals proposal
             where proposal.job_schedule_id = schedule.id
               and proposal.status = 'approved'
               and schedule.start_at between proposal.arrival_window_start
                 and proposal.arrival_window_end
             order by proposal.version desc, proposal.created_at desc
             limit 1
           ), schedule.start_at) as arrival_window_start
      into allocation_context
    from public.team_job_allocations allocation
    join public.job_schedules schedule
      on schedule.id = allocation.job_schedule_id
    join public.job_assignments assignment
      on assignment.job_schedule_id = schedule.id
     and assignment.cleaner_id = new.cleaner_id
     and assignment.status in ('accepted', 'confirmed')
    join public.workforce_memberships subject
      on subject.organization_id = allocation.organization_id
     and subject.team_id = allocation.team_id
     and subject.cleaner_id = new.cleaner_id
     and subject.role in ('cleaner', 'shift_lead')
     and subject.status = 'active'
    where allocation.id = new.team_job_allocation_id
      and allocation.organization_id = new.organization_id
      and allocation.team_id = new.team_id
    limit 1
    for share of allocation, schedule, assignment, subject;

    if not found then
      raise exception 'Time entry requires accepted work and active team membership'
        using errcode = '23514';
    end if;

    if actor_cleaner_id is not null then
      select membership.id, membership.role, membership.is_dev_seed
        into actor_membership
      from public.workforce_memberships membership
      where membership.organization_id = new.organization_id
        and membership.team_id = new.team_id
        and membership.cleaner_id = actor_cleaner_id
        and membership.status = 'active'
        and membership.role in ('cleaner', 'shift_lead')
      order by case membership.role when 'shift_lead' then 0 else 1 end,
        membership.id
      limit 1
      for share of membership;
      if not found
        or new.cleaner_id <> actor_cleaner_id
        or new.status <> 'open'
        or new.source <> 'crew_timer'
        or new.clock_out_at is not null
        or new.break_minutes <> 0
        or new.approved_by_membership_id is not null
        or new.approved_at is not null
        or new.created_by_membership_id is not null
        or new.submitted_by_membership_id is not null
        or new.submitted_at is not null
        or new.reviewed_at is not null
        or new.review_reason is not null
        or new.adjustment_reason is not null
        or new.version <> 1
        or allocation_context.schedule_status
          not in ('confirmed', 'en_route', 'in_progress') then
        raise exception 'Crew clock creation must start current accepted work'
          using errcode = '42501';
      end if;
      new.clock_in_at := evidence_at;
    else
      select membership.id, membership.role, membership.is_dev_seed
        into actor_membership
      from public.workforce_memberships membership
      where membership.organization_id = new.organization_id
        and membership.customer_id = actor_customer_id
        and membership.status = 'active'
        and (
          (membership.team_id = new.team_id and membership.role = 'manager')
          or (membership.team_id is null and membership.role in ('owner', 'gm'))
        )
      order by case when membership.team_id = new.team_id then 0 else 1 end,
        case membership.role when 'manager' then 0 when 'gm' then 1 else 2 end,
        membership.id
      limit 1
      for share of membership;
      if not found
        or new.status <> 'submitted'
        or new.source <> 'manager_entry'
        or allocation_context.schedule_status not in (
          'confirmed', 'en_route', 'in_progress', 'quality_review', 'completed'
        )
        or new.clock_out_at is null
        or new.clock_out_at > evidence_at + interval '1 minute'
        or new.clock_out_at - new.clock_in_at > interval '24 hours'
        or char_length(trim(coalesce(new.adjustment_reason, ''))) < 2
        or new.approved_by_membership_id is not null
        or new.approved_at is not null
        or new.created_by_membership_id is not null
        or new.submitted_by_membership_id is not null
        or new.submitted_at is not null
        or new.reviewed_at is not null
        or new.review_reason is not null
        or new.version <> 1 then
        raise exception 'Manager time entry requires complete unreviewed raw evidence'
          using errcode = '42501';
      end if;
    end if;

    if new.clock_in_at < allocation_context.arrival_window_start
        - make_interval(mins => allocation_context.travel_buffer_minutes)
      or new.clock_in_at > allocation_context.end_at + interval '12 hours'
      or (new.clock_out_at is not null
        and new.clock_out_at > allocation_context.end_at + interval '12 hours') then
      raise exception 'Time evidence is outside the approved service window'
        using errcode = '55000';
    end if;

    new.estimated_minutes_snapshot := allocation_context.trusted_estimate;
    new.created_by_membership_id := actor_membership.id;
    new.is_dev_seed := allocation_context.is_dev_seed;
    new.created_at := evidence_at;
    new.updated_at := evidence_at;
    if new.status = 'submitted' then
      new.submitted_by_membership_id := actor_membership.id;
      new.submitted_at := evidence_at;
    end if;
    return new;
  end if;

  if new.id <> old.id
    or new.organization_id <> old.organization_id
    or new.team_id <> old.team_id
    or new.team_job_allocation_id <> old.team_job_allocation_id
    or new.cleaner_id <> old.cleaner_id
    or new.clock_in_at is distinct from old.clock_in_at
    or new.estimated_minutes_snapshot <> old.estimated_minutes_snapshot
    or new.source <> old.source
    or new.created_by_membership_id is distinct from old.created_by_membership_id
    or new.is_dev_seed <> old.is_dev_seed
    or new.created_at is distinct from old.created_at
    or new.version <> old.version then
    raise exception 'Time-entry subject and raw creation evidence are immutable'
      using errcode = '55000';
  end if;

  if actor_cleaner_id is not null then
    select membership.id, membership.role
      into actor_membership
    from public.workforce_memberships membership
    where membership.organization_id = old.organization_id
      and membership.team_id = old.team_id
      and membership.cleaner_id = actor_cleaner_id
      and membership.status = 'active'
      and membership.role in ('cleaner', 'shift_lead')
    order by case membership.role when 'shift_lead' then 0 else 1 end,
      membership.id
    limit 1
    for share of membership;
    if not found
      or actor_cleaner_id <> old.cleaner_id
      or old.status <> 'open'
      or new.status <> 'submitted'
      or old.clock_out_at is not null
      or new.adjustment_reason is distinct from old.adjustment_reason
      or new.approved_by_membership_id is distinct from old.approved_by_membership_id
      or new.approved_at is distinct from old.approved_at
      or new.submitted_by_membership_id is distinct from old.submitted_by_membership_id
      or new.submitted_at is distinct from old.submitted_at
      or new.reviewed_at is distinct from old.reviewed_at
      or new.review_reason is distinct from old.review_reason then
      raise exception 'Cleaner may only submit the current open clock'
        using errcode = '42501';
    end if;
    new.clock_out_at := evidence_at;
    new.submitted_by_membership_id := actor_membership.id;
    new.submitted_at := evidence_at;
    new.version := old.version + 1;
    return new;
  end if;

  select membership.id, membership.role
    into actor_membership
  from public.workforce_memberships membership
  where membership.organization_id = old.organization_id
    and membership.customer_id = actor_customer_id
    and membership.status = 'active'
    and (
      (membership.team_id = old.team_id and membership.role = 'manager')
      or (membership.team_id is null and membership.role in ('owner', 'gm'))
    )
  order by case when membership.team_id = old.team_id then 0 else 1 end,
    case membership.role when 'manager' then 0 when 'gm' then 1 else 2 end,
    membership.id
  limit 1
  for share of membership;
  if not found then
    raise exception 'Current manager membership is required for time evidence'
      using errcode = '42501';
  end if;

  if old.status = 'open' and new.status = 'submitted' then
    if old.clock_out_at is not null
      or new.approved_by_membership_id is distinct from old.approved_by_membership_id
      or new.approved_at is distinct from old.approved_at
      or new.submitted_by_membership_id is distinct from old.submitted_by_membership_id
      or new.submitted_at is distinct from old.submitted_at
      or new.reviewed_at is distinct from old.reviewed_at
      or new.review_reason is distinct from old.review_reason
      or char_length(trim(coalesce(new.adjustment_reason, ''))) < 2 then
      raise exception 'Manager clock closure requires an adjustment reason'
        using errcode = '42501';
    end if;
    new.clock_out_at := evidence_at;
    new.submitted_by_membership_id := actor_membership.id;
    new.submitted_at := evidence_at;
    new.version := old.version + 1;
    return new;
  end if;

  if old.status = 'submitted' and new.status in ('approved', 'rejected') then
    if new.clock_out_at is distinct from old.clock_out_at
      or new.break_minutes <> old.break_minutes
      or new.adjustment_reason is distinct from old.adjustment_reason
      or new.submitted_by_membership_id is distinct from old.submitted_by_membership_id
      or new.submitted_at is distinct from old.submitted_at
      or new.approved_by_membership_id is distinct from old.approved_by_membership_id
      or new.approved_at is distinct from old.approved_at
      or new.reviewed_at is distinct from old.reviewed_at
      or (new.status = 'rejected'
        and char_length(trim(coalesce(new.review_reason, ''))) < 2) then
      raise exception 'Time review cannot rewrite raw work evidence'
        using errcode = '42501';
    end if;
    new.review_reason := nullif(trim(new.review_reason), '');
    new.approved_by_membership_id := actor_membership.id;
    new.approved_at := case when new.status = 'approved'
      then evidence_at else null end;
    new.reviewed_at := evidence_at;
    new.version := old.version + 1;
    return new;
  end if;

  raise exception 'Invalid time-entry lifecycle transition'
    using errcode = '55000';
end
$$;

create trigger job_time_entries_application_evidence_guard
  before insert or update on public.job_time_entries
  for each row execute function private.guard_job_time_entry_evidence();

create function private.guard_cleaner_time_off_evidence() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_customer_id uuid := private.current_customer_id();
  actor_cleaner_id uuid := private.current_cleaner_id();
  actor_membership record;
  evidence_at timestamptz := clock_timestamp();
begin
  if actor_customer_id is null and actor_cleaner_id is null then
    return new;
  end if;
  if actor_customer_id is not null and actor_cleaner_id is not null then
    raise exception 'Time-off evidence requires exactly one current actor'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if actor_cleaner_id is null
      or new.cleaner_id <> actor_cleaner_id
      or new.organization_id is null
      or new.team_id is null
      or new.status <> 'requested'
      or new.reviewed_by_membership_id is not null
      or new.reviewed_by_label is not null
      or new.reviewed_at is not null
      or new.requested_by_membership_id is not null
      or new.review_reason is not null
      or new.version <> 1
      or new.start_at < evidence_at - interval '5 minutes'
      or new.end_at > new.start_at + interval '31 days' then
      raise exception 'Cleaner time-off creation requires a current self request'
        using errcode = '42501';
    end if;
    select membership.id, membership.role, membership.is_dev_seed
      into actor_membership
    from public.workforce_memberships membership
    where membership.organization_id = new.organization_id
      and membership.team_id = new.team_id
      and membership.cleaner_id = actor_cleaner_id
      and membership.status = 'active'
      and membership.role in ('cleaner', 'shift_lead')
    order by case membership.role when 'shift_lead' then 0 else 1 end,
      membership.id
    limit 1
    for share of membership;
    if not found then
      raise exception 'Time-off request requires active membership in this team'
        using errcode = '42501';
    end if;
    new.requested_by_membership_id := actor_membership.id;
    new.is_dev_seed := actor_membership.is_dev_seed;
    new.created_at := evidence_at;
    new.updated_at := evidence_at;
    return new;
  end if;

  if new.id <> old.id
    or new.organization_id is distinct from old.organization_id
    or new.team_id is distinct from old.team_id
    or new.cleaner_id <> old.cleaner_id
    or new.start_at is distinct from old.start_at
    or new.end_at is distinct from old.end_at
    or new.reason_category <> old.reason_category
    or new.private_note is distinct from old.private_note
    or new.requested_by_membership_id is distinct from old.requested_by_membership_id
    or new.is_dev_seed <> old.is_dev_seed
    or new.created_at is distinct from old.created_at
    or new.version <> old.version then
    raise exception 'Time-off subject and request evidence are immutable'
      using errcode = '55000';
  end if;

  if actor_cleaner_id is not null then
    select membership.id, membership.role
      into actor_membership
    from public.workforce_memberships membership
    where membership.organization_id = old.organization_id
      and membership.team_id = old.team_id
      and membership.cleaner_id = actor_cleaner_id
      and membership.status = 'active'
      and membership.role in ('cleaner', 'shift_lead')
    order by case membership.role when 'shift_lead' then 0 else 1 end,
      membership.id
    limit 1
    for share of membership;
    if not found
      or actor_cleaner_id <> old.cleaner_id
      or old.status <> 'requested'
      or new.status <> 'canceled'
      or new.reviewed_by_membership_id is distinct from old.reviewed_by_membership_id
      or new.reviewed_by_label is distinct from old.reviewed_by_label
      or new.reviewed_at is distinct from old.reviewed_at
      or new.review_reason is distinct from old.review_reason then
      raise exception 'Cleaner may only cancel a pending self request'
        using errcode = '42501';
    end if;
    new.version := old.version + 1;
    return new;
  end if;

  select membership.id, membership.role
    into actor_membership
  from public.workforce_memberships membership
  where membership.organization_id = old.organization_id
    and membership.customer_id = actor_customer_id
    and membership.status = 'active'
    and (
      (membership.team_id = old.team_id and membership.role = 'manager')
      or (membership.team_id is null and membership.role in ('owner', 'gm'))
    )
  order by case when membership.team_id = old.team_id then 0 else 1 end,
    case membership.role when 'manager' then 0 when 'gm' then 1 else 2 end,
    membership.id
  limit 1
  for share of membership;
  if not found
    or old.status <> 'requested'
    or new.status not in ('approved', 'declined')
    or new.reviewed_by_membership_id is distinct from old.reviewed_by_membership_id
    or new.reviewed_by_label is distinct from old.reviewed_by_label
    or new.reviewed_at is distinct from old.reviewed_at
    or (new.status = 'declined'
      and char_length(trim(coalesce(new.review_reason, ''))) < 2) then
    raise exception 'Time-off review requires a current scoped manager decision'
      using errcode = '42501';
  end if;

  if new.status = 'approved' then
    perform pg_advisory_xact_lock(hashtextextended(old.cleaner_id::text, 0));
    perform cleaner.id from public.cleaners cleaner
      where cleaner.id = old.cleaner_id for update;
    if exists (
      select 1
      from public.job_assignments assignment
      join public.job_schedules schedule
        on schedule.id = assignment.job_schedule_id
      where assignment.cleaner_id = old.cleaner_id
        and assignment.status in ('accepted', 'confirmed')
        and schedule.status <> 'canceled'
        and schedule.start_at < old.end_at
        and schedule.end_at > old.start_at
    ) then
      raise exception 'Approved time off conflicts with accepted work'
        using errcode = '23P01';
    end if;
  end if;

  new.review_reason := nullif(trim(new.review_reason), '');
  new.reviewed_by_membership_id := actor_membership.id;
  new.reviewed_by_label := initcap(replace(actor_membership.role, '_', ' '));
  new.reviewed_at := evidence_at;
  new.version := old.version + 1;
  return new;
end
$$;

create trigger cleaner_time_off_application_evidence_guard
  before insert or update on public.cleaner_time_off
  for each row execute function private.guard_cleaner_time_off_evidence();

revoke all on function private.guard_job_time_entry_evidence()
  from public, lakeandpine_app;
revoke all on function private.guard_cleaner_time_off_evidence()
  from public, lakeandpine_app;

drop policy if exists job_time_entries_read on public.job_time_entries;
drop policy if exists job_time_entries_insert on public.job_time_entries;
drop policy if exists job_time_entries_update on public.job_time_entries;
drop policy if exists job_time_entries_delete on public.job_time_entries;
create policy job_time_entries_read
  on public.job_time_entries for select to lakeandpine_app using (
    private.can_access_team(
      organization_id, team_id, array['owner', 'gm', 'manager']
    )
    or (cleaner_id = private.current_cleaner_id()
      and private.current_customer_id() is null)
  );
create policy job_time_entries_insert
  on public.job_time_entries for insert to lakeandpine_app with check (
    (
      cleaner_id = private.current_cleaner_id()
      and private.current_customer_id() is null
      and source = 'crew_timer'
      and status = 'open'
      and private.is_current_membership(created_by_membership_id)
    )
    or (
      private.current_cleaner_id() is null
      and private.can_access_team(
        organization_id, team_id, array['owner', 'gm', 'manager']
      )
      and source = 'manager_entry'
      and status = 'submitted'
      and private.is_current_membership(created_by_membership_id)
    )
  );
create policy job_time_entries_update
  on public.job_time_entries for update to lakeandpine_app using (
    private.can_access_team(
      organization_id, team_id, array['owner', 'gm', 'manager']
    )
    or (cleaner_id = private.current_cleaner_id()
      and private.current_customer_id() is null)
  ) with check (
    private.can_access_team(
      organization_id, team_id, array['owner', 'gm', 'manager']
    )
    or (cleaner_id = private.current_cleaner_id()
      and private.current_customer_id() is null)
  );
create policy job_time_entries_delete
  on public.job_time_entries for delete to lakeandpine_app using (false);

drop policy if exists cleaner_time_off_read on public.cleaner_time_off;
drop policy if exists cleaner_time_off_insert on public.cleaner_time_off;
drop policy if exists cleaner_time_off_update on public.cleaner_time_off;
drop policy if exists cleaner_time_off_delete on public.cleaner_time_off;
create policy cleaner_time_off_read
  on public.cleaner_time_off for select to lakeandpine_app using (
    (cleaner_id = private.current_cleaner_id()
      and private.current_customer_id() is null)
    or (organization_id is not null and team_id is not null
      and private.can_access_team(
        organization_id, team_id,
        array['owner', 'gm', 'manager']
      ))
  );
create policy cleaner_time_off_insert
  on public.cleaner_time_off for insert to lakeandpine_app with check (
    private.current_customer_id() is null
    and cleaner_id = private.current_cleaner_id()
    and status = 'requested'
    and private.is_current_membership(requested_by_membership_id)
  );
create policy cleaner_time_off_update
  on public.cleaner_time_off for update to lakeandpine_app using (
    private.can_access_team(
      organization_id, team_id, array['owner', 'gm', 'manager']
    )
    or (cleaner_id = private.current_cleaner_id()
      and private.current_customer_id() is null)
  ) with check (
    private.can_access_team(
      organization_id, team_id, array['owner', 'gm', 'manager']
    )
    or (cleaner_id = private.current_cleaner_id()
      and private.current_customer_id() is null)
  );
create policy cleaner_time_off_delete
  on public.cleaner_time_off for delete to lakeandpine_app using (false);

revoke insert, update, delete on table public.job_time_entries
  from lakeandpine_app;
grant insert (
  organization_id, team_id, team_job_allocation_id, cleaner_id,
  clock_in_at, clock_out_at, break_minutes, estimated_minutes_snapshot,
  status, source, adjustment_reason
) on table public.job_time_entries to lakeandpine_app;
grant update (
  clock_out_at, break_minutes, status, adjustment_reason, review_reason
) on table public.job_time_entries to lakeandpine_app;

revoke insert, update, delete on table public.cleaner_time_off
  from lakeandpine_app;
grant insert (
  organization_id, team_id, cleaner_id, start_at, end_at,
  reason_category, private_note
) on table public.cleaner_time_off to lakeandpine_app;
grant update (status, review_reason)
  on table public.cleaner_time_off to lakeandpine_app;

-- Verified Stripe webhook receipts -----------------------------------------
-- The runtime role must never be able to manufacture a provider receipt from
-- caller-asserted event fields. Stripe's exact raw payload is authenticated in
-- the database with an admin-managed secret. A successful verification issues
-- a short-lived, single-use capability; every terminal operation consumes it
-- and re-derives business facts from the authenticated payload.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
alter extension pgcrypto set schema extensions;

create table private.stripe_webhook_config (
  singleton boolean primary key default true check (singleton),
  webhook_secret text not null check (
    octet_length(webhook_secret) between 16 and 512
    and webhook_secret !~ '[[:space:][:cntrl:]]'
  ),
  expected_livemode boolean not null,
  signature_tolerance_seconds integer not null default 300 check (
    signature_tolerance_seconds between 60 and 900
  ),
  capability_ttl_seconds integer not null default 300 check (
    capability_ttl_seconds between 30 and 600
  ),
  configured_by name not null default current_user,
  configured_at timestamptz not null default clock_timestamp()
);

comment on table private.stripe_webhook_config is
  'DB-admin-only Stripe webhook verification settings. Never expose or seed the webhook secret.';

alter table private.stripe_webhook_config enable row level security;
revoke all on table private.stripe_webhook_config
  from public, lakeandpine_app;

create table private.stripe_event_processing_capabilities (
  capability_id uuid primary key default gen_random_uuid(),
  event_id text not null references public.stripe_event_receipts(event_id)
    on delete cascade,
  event_type text not null,
  livemode boolean not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload_document jsonb not null check (jsonb_typeof(payload_document) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at),
  check (consumed_at is null or consumed_at >= created_at)
);

comment on table private.stripe_event_processing_capabilities is
  'Ephemeral authenticated Stripe payloads bound to one-use processing capabilities; inaccessible to the runtime role.';

create index stripe_event_processing_capabilities_event_idx
  on private.stripe_event_processing_capabilities(event_id);
create index stripe_event_processing_capabilities_expiry_idx
  on private.stripe_event_processing_capabilities(expires_at)
  where consumed_at is null;

alter table private.stripe_event_processing_capabilities enable row level security;
revoke all on table private.stripe_event_processing_capabilities
  from public, lakeandpine_app;

create function private.constant_time_bytea_equals(
  left_value bytea,
  right_value bytea
) returns boolean language plpgsql immutable strict set search_path = '' as $$
declare
  difference integer := 0;
  byte_index integer;
begin
  if octet_length(left_value) <> octet_length(right_value) then
    return false;
  end if;
  if octet_length(left_value) = 0 then
    return true;
  end if;
  for byte_index in 0..octet_length(left_value) - 1 loop
    difference := difference
      | (get_byte(left_value, byte_index) # get_byte(right_value, byte_index));
  end loop;
  return difference = 0;
end
$$;

create function private.stripe_json_object_id(requested_value jsonb)
returns text language sql immutable set search_path = '' as $$
  select case jsonb_typeof(requested_value)
    when 'string' then requested_value #>> '{}'
    when 'object' then requested_value ->> 'id'
    else null
  end
$$;

create function private.stripe_event_is_lakeandpine(
  requested_event_type text,
  requested_payload jsonb
) returns boolean language sql immutable set search_path = '' as $$
  select case
    when requested_event_type in (
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded'
    ) then coalesce(
      requested_payload #>> '{data,object,metadata,lakeandpine}' = 'v1', false
    )
    when requested_event_type in ('invoice.paid', 'invoice.payment_failed')
      then coalesce(
        requested_payload #>>
          '{data,object,parent,subscription_details,metadata,lakeandpine}' = 'v1',
        false
      )
    else false
  end
$$;

create function private.verify_and_claim_stripe_event(
  requested_raw_payload text,
  requested_signature_header text
) returns table (
  claimed boolean,
  receipt_status text,
  processing_capability uuid,
  event_id text,
  event_type text,
  livemode boolean,
  payload_sha256 text
) language plpgsql security definer set search_path = '' as $$
declare
  webhook_config private.stripe_webhook_config%rowtype;
  signature_components text[];
  signature_values text[] := array[]::text[];
  signature_component text;
  signature_timestamp_text text;
  signature_timestamp bigint;
  current_epoch bigint;
  expected_signature bytea;
  candidate_signature text;
  signature_matches boolean := false;
  payload_document jsonb;
  derived_event_id text;
  derived_event_type text;
  derived_livemode boolean;
  derived_payload_sha256 text;
  existing_receipt public.stripe_event_receipts%rowtype;
  observed_at timestamptz := clock_timestamp();
begin
  if requested_raw_payload is null
    or octet_length(requested_raw_payload) not between 2 and 1048576
    or requested_signature_header is null
    or octet_length(requested_signature_header) not between 8 and 4096 then
    raise exception 'Stripe signed request is outside accepted bounds'
      using errcode = '22023';
  end if;

  select config.* into webhook_config
  from private.stripe_webhook_config config
  where config.singleton = true;
  if not found then
    raise exception 'Stripe database verification is not configured'
      using errcode = '55000';
  end if;

  signature_components := regexp_split_to_array(requested_signature_header, ',');
  if cardinality(signature_components) not between 2 and 32 then
    raise exception 'Stripe signature header is invalid' using errcode = '22023';
  end if;

  foreach signature_component in array signature_components loop
    signature_component := btrim(signature_component);
    if signature_component ~ '^t=' then
      if signature_timestamp_text is not null
        or signature_component !~ '^t=[0-9]{9,12}$' then
        raise exception 'Stripe signature timestamp is invalid'
          using errcode = '22023';
      end if;
      signature_timestamp_text := substr(signature_component, 3);
    elsif signature_component ~ '^v1=' then
      if signature_component !~ '^v1=[0-9A-Fa-f]{64}$'
        or cardinality(signature_values) >= 8 then
        raise exception 'Stripe v1 signature is invalid' using errcode = '22023';
      end if;
      signature_values := array_append(
        signature_values, lower(substr(signature_component, 4))
      );
    elsif signature_component !~ '^[A-Za-z0-9_]{1,16}=[A-Za-z0-9]{1,256}$' then
      raise exception 'Stripe signature component is invalid' using errcode = '22023';
    end if;
  end loop;

  if signature_timestamp_text is null or cardinality(signature_values) = 0 then
    raise exception 'Stripe signature evidence is incomplete' using errcode = '22023';
  end if;
  signature_timestamp := signature_timestamp_text::bigint;
  current_epoch := floor(extract(epoch from observed_at))::bigint;
  if abs(current_epoch - signature_timestamp) >
      webhook_config.signature_tolerance_seconds then
    raise exception 'Stripe signature timestamp is stale' using errcode = '22023';
  end if;

  expected_signature := extensions.hmac(
    convert_to(signature_timestamp_text || '.' || requested_raw_payload, 'UTF8'),
    convert_to(webhook_config.webhook_secret, 'UTF8'),
    'sha256'
  );
  foreach candidate_signature in array signature_values loop
    if private.constant_time_bytea_equals(
      expected_signature, decode(candidate_signature, 'hex')
    ) then
      signature_matches := true;
    end if;
  end loop;
  if not signature_matches then
    raise exception 'Stripe signature verification failed' using errcode = '42501';
  end if;

  begin
    payload_document := requested_raw_payload::jsonb;
  exception when others then
    raise exception 'Stripe payload is not valid JSON' using errcode = '22023';
  end;
  if coalesce(jsonb_typeof(payload_document), '') <> 'object'
    or coalesce(payload_document ->> 'object', '') <> 'event'
    or coalesce(jsonb_typeof(payload_document -> 'livemode'), '') <> 'boolean' then
    raise exception 'Stripe payload is not an event' using errcode = '22023';
  end if;

  derived_event_id := payload_document ->> 'id';
  derived_event_type := payload_document ->> 'type';
  derived_livemode := (payload_document ->> 'livemode')::boolean;
  if derived_event_id is null
    or char_length(derived_event_id) not between 5 and 255
    or derived_event_id !~ '^evt_[A-Za-z0-9]+$'
    or derived_event_type is null
    or char_length(derived_event_type) not between 3 and 200
    or derived_event_type !~ '^[a-z0-9_.]+$' then
    raise exception 'Stripe event identity is invalid' using errcode = '22023';
  end if;
  if derived_livemode <> webhook_config.expected_livemode then
    raise exception 'Stripe event mode does not match database configuration'
      using errcode = '42501';
  end if;

  derived_payload_sha256 := encode(
    extensions.digest(convert_to(requested_raw_payload, 'UTF8'), 'sha256'), 'hex'
  );
  event_id := derived_event_id;
  event_type := derived_event_type;
  livemode := derived_livemode;
  payload_sha256 := derived_payload_sha256;
  processing_capability := null;

  -- Bound retention even when a worker disappears after verification. Terminal
  -- operations delete their token immediately; this incremental sweep handles
  -- abandoned expired payloads without turning one webhook into an unbounded job.
  delete from private.stripe_event_processing_capabilities capability
  where capability.capability_id in (
    select expired.capability_id
    from private.stripe_event_processing_capabilities expired
    where expired.expires_at <= observed_at
      or expired.consumed_at is not null
    order by expired.expires_at, expired.capability_id
    limit 100
  );

  perform pg_advisory_xact_lock(
    hashtextextended('verified-stripe-event:' || derived_event_id, 9611)
  );
  select receipt.* into existing_receipt
  from public.stripe_event_receipts receipt
  where receipt.event_id = derived_event_id
  for update;

  if existing_receipt.event_id is null then
    insert into public.stripe_event_receipts
      (event_id, event_type, livemode, payload_sha256, status,
       attempt_count, last_attempt_at, received_at, updated_at)
    values (
      derived_event_id, derived_event_type, derived_livemode,
      derived_payload_sha256, 'processing', 1, observed_at, observed_at,
      observed_at
    );
  else
    if existing_receipt.event_type <> derived_event_type
      or existing_receipt.livemode <> derived_livemode
      or existing_receipt.payload_sha256 <> derived_payload_sha256 then
      raise exception 'Stripe event receipt identity mismatch'
        using errcode = '22000';
    end if;
    if existing_receipt.status in ('processed', 'ignored') then
      claimed := false;
      receipt_status := existing_receipt.status;
      return next;
      return;
    end if;
    if existing_receipt.status = 'processing'
      and existing_receipt.last_attempt_at >= observed_at - make_interval(
        secs => webhook_config.capability_ttl_seconds
      ) then
      claimed := false;
      receipt_status := 'processing';
      return next;
      return;
    end if;
    update public.stripe_event_receipts receipt
    set status = 'processing',
        attempt_count = receipt.attempt_count + 1,
        last_attempt_at = observed_at,
        processed_at = null,
        last_error_code = null,
        updated_at = observed_at
    where receipt.event_id = derived_event_id;
  end if;

  delete from private.stripe_event_processing_capabilities capability
  where capability.event_id = derived_event_id
    and (capability.consumed_at is not null or capability.expires_at <= observed_at);
  insert into private.stripe_event_processing_capabilities
    (event_id, event_type, livemode, payload_sha256, payload_document,
     created_at, expires_at)
  values (
    derived_event_id, derived_event_type, derived_livemode,
    derived_payload_sha256, payload_document, observed_at,
    observed_at + make_interval(secs => webhook_config.capability_ttl_seconds)
  )
  returning capability_id into processing_capability;
  claimed := true;
  receipt_status := 'processing';
  return next;
end
$$;

create function private.consume_verified_stripe_capability(
  requested_processing_capability uuid
) returns table (
  verified_event_id text,
  verified_event_type text,
  verified_livemode boolean,
  verified_payload_sha256 text,
  verified_payload_document jsonb
) language plpgsql set search_path = '' as $$
declare
  capability private.stripe_event_processing_capabilities%rowtype;
  receipt public.stripe_event_receipts%rowtype;
  observed_at timestamptz := clock_timestamp();
begin
  if requested_processing_capability is null then
    raise exception 'Stripe processing capability is required'
      using errcode = '42501';
  end if;
  select token.* into capability
  from private.stripe_event_processing_capabilities token
  where token.capability_id = requested_processing_capability
  for update;
  if capability.capability_id is null
    or capability.consumed_at is not null
    or capability.expires_at <= observed_at then
    raise exception 'Stripe processing capability is invalid or expired'
      using errcode = '42501';
  end if;
  select event_receipt.* into receipt
  from public.stripe_event_receipts event_receipt
  where event_receipt.event_id = capability.event_id
    and event_receipt.event_type = capability.event_type
    and event_receipt.livemode = capability.livemode
    and event_receipt.payload_sha256 = capability.payload_sha256
    and event_receipt.status = 'processing'
  for update;
  if receipt.event_id is null then
    raise exception 'Stripe receipt is not processable' using errcode = '42501';
  end if;
  update private.stripe_event_processing_capabilities token
  set consumed_at = observed_at
  where token.capability_id = capability.capability_id
    and token.consumed_at is null;
  if not found then
    raise exception 'Stripe processing capability was already consumed'
      using errcode = '42501';
  end if;
  return query select capability.event_id, capability.event_type,
    capability.livemode, capability.payload_sha256,
    capability.payload_document;
end
$$;

create function private.complete_verified_stripe_event(
  requested_processing_capability uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  verified record;
  event_object jsonb;
  metadata jsonb;
  derived_customer_id_text text;
  derived_client_reference_id text;
  derived_metadata_customer_id text;
  derived_customer_id uuid;
  derived_stripe_customer_id text;
  derived_payment_intent_id text;
  derived_subscription_id text;
  derived_stripe_invoice_id text;
  derived_amount_text text;
  derived_amount_cents integer;
  derived_description text;
  actor_customer public.customers%rowtype;
  existing_billing public.billing_records%rowtype;
  observed_at timestamptz := clock_timestamp();
begin
  select * into verified
  from private.consume_verified_stripe_capability(
    requested_processing_capability
  );
  if verified.verified_event_id is null then
    return false;
  end if;
  if verified.verified_event_type not in (
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'invoice.paid',
      'invoice.payment_failed'
    )
    or not private.stripe_event_is_lakeandpine(
      verified.verified_event_type, verified.verified_payload_document
    ) then
    raise exception 'Stripe event is not eligible for completion'
      using errcode = '42501';
  end if;

  event_object := verified.verified_payload_document #> '{data,object}';
  if event_object is null or jsonb_typeof(event_object) <> 'object' then
    raise exception 'Stripe event object is invalid' using errcode = '22023';
  end if;

  if verified.verified_event_type in (
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded'
  ) then
    metadata := event_object -> 'metadata';
    derived_client_reference_id := nullif(
      event_object ->> 'client_reference_id', ''
    );
    derived_metadata_customer_id := nullif(metadata ->> 'customerId', '');
    if derived_client_reference_id is not null
      and derived_metadata_customer_id is not null
      and derived_client_reference_id <> derived_metadata_customer_id then
      raise exception 'Stripe checkout customer identity mismatch'
        using errcode = '42501';
    end if;
    derived_customer_id_text := coalesce(
      derived_client_reference_id, derived_metadata_customer_id
    );
    if derived_customer_id_text is null
      or derived_customer_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'Stripe checkout customer identity is invalid'
        using errcode = '22023';
    end if;
    derived_customer_id := derived_customer_id_text::uuid;
    derived_stripe_customer_id := private.stripe_json_object_id(
      event_object -> 'customer'
    );
    if derived_stripe_customer_id is null
      or derived_stripe_customer_id !~ '^cus_[A-Za-z0-9]{3,252}$' then
      raise exception 'Stripe checkout provider customer is invalid'
        using errcode = '22023';
    end if;
    derived_amount_text := event_object ->> 'amount_total';
    if jsonb_typeof(event_object -> 'amount_total') <> 'number'
      or derived_amount_text !~ '^[0-9]{1,9}$' then
      raise exception 'Stripe checkout amount is invalid' using errcode = '22023';
    end if;
    derived_amount_cents := derived_amount_text::integer;
    if derived_amount_cents > 100000000 then
      raise exception 'Stripe checkout amount is outside accepted bounds'
        using errcode = '22023';
    end if;
    if event_object ->> 'mode' not in ('payment', 'subscription') then
      raise exception 'Stripe checkout mode is invalid' using errcode = '22023';
    end if;
    if event_object ->> 'mode' = 'subscription' then
      derived_subscription_id := private.stripe_json_object_id(
        event_object -> 'subscription'
      );
      if derived_subscription_id is null
        or derived_subscription_id !~ '^sub_[A-Za-z0-9]{3,252}$' then
        raise exception 'Stripe subscription checkout has no subscription'
          using errcode = '22023';
      end if;
    end if;
    if event_object ->> 'payment_status' = 'paid' then
      derived_payment_intent_id := private.stripe_json_object_id(
        event_object -> 'payment_intent'
      );
      if derived_payment_intent_id is not null
        and derived_payment_intent_id !~ '^pi_[A-Za-z0-9]{3,252}$' then
        raise exception 'Stripe checkout payment intent is invalid'
          using errcode = '22023';
      end if;
      if event_object ->> 'mode' = 'payment'
        and derived_amount_cents > 0
        and derived_payment_intent_id is null then
        raise exception 'Paid Stripe checkout has no payment intent'
          using errcode = '22023';
      end if;
    else
      derived_payment_intent_id := null;
    end if;
    derived_description := left(regexp_replace(
      'Checkout — ' || coalesce(
        nullif(btrim(metadata ->> 'planId'), ''), 'plan'
      ), '[[:cntrl:]]', ' ', 'g'
    ), 500);

    select customer.* into actor_customer
    from public.customers customer
    where customer.id = derived_customer_id
      and customer.clerk_user_id is not null
    for update;
    if actor_customer.id is null
      or (actor_customer.stripe_customer_id is not null
        and actor_customer.stripe_customer_id <> derived_stripe_customer_id)
      or exists (
        select 1 from public.customers customer
        where customer.stripe_customer_id = derived_stripe_customer_id
          and customer.id <> derived_customer_id
      ) then
      raise exception 'Stripe checkout customer binding is invalid'
        using errcode = '42501';
    end if;
    if actor_customer.stripe_customer_id is null then
      update public.customers customer
      set stripe_customer_id = derived_stripe_customer_id
      where customer.id = derived_customer_id
        and customer.stripe_customer_id is null;
    end if;
    if derived_payment_intent_id is not null then
      insert into public.billing_records
        (customer_id, description, amount_cents, status,
         stripe_payment_intent_id, is_dev_seed)
      values (
        derived_customer_id, derived_description, derived_amount_cents,
        'paid', derived_payment_intent_id, actor_customer.is_dev_seed
      )
      on conflict do nothing;
      select billing.* into existing_billing
      from public.billing_records billing
      where billing.stripe_payment_intent_id = derived_payment_intent_id;
      if existing_billing.id is null
        or existing_billing.customer_id <> derived_customer_id
        or existing_billing.amount_cents <> derived_amount_cents
        or existing_billing.status <> 'paid'
        or existing_billing.description <> derived_description then
        raise exception 'Stripe payment-intent receipt conflict'
          using errcode = '23505';
      end if;
    end if;
  else
    metadata := event_object #> '{parent,subscription_details,metadata}';
    derived_customer_id_text := metadata ->> 'customerId';
    if derived_customer_id_text is null
      or derived_customer_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'Stripe invoice customer identity is invalid'
        using errcode = '22023';
    end if;
    derived_customer_id := derived_customer_id_text::uuid;
    derived_stripe_customer_id := private.stripe_json_object_id(
      event_object -> 'customer'
    );
    derived_stripe_invoice_id := event_object ->> 'id';
    if derived_stripe_customer_id is null
      or derived_stripe_customer_id !~ '^cus_[A-Za-z0-9]{3,252}$'
      or derived_stripe_invoice_id is null
      or derived_stripe_invoice_id !~ '^in_[A-Za-z0-9]{3,252}$' then
      raise exception 'Stripe invoice provider identity is invalid'
        using errcode = '22023';
    end if;
    select customer.* into actor_customer
    from public.customers customer
    where customer.id = derived_customer_id
      and customer.stripe_customer_id = derived_stripe_customer_id
      and customer.clerk_user_id is not null
    for update;
    if actor_customer.id is null then
      raise exception 'Stripe invoice customer binding is invalid'
        using errcode = '42501';
    end if;

    if verified.verified_event_type = 'invoice.paid' then
      derived_amount_text := event_object ->> 'amount_paid';
      if jsonb_typeof(event_object -> 'amount_paid') <> 'number'
        or derived_amount_text !~ '^[0-9]{1,9}$' then
        raise exception 'Stripe invoice amount is invalid' using errcode = '22023';
      end if;
      derived_amount_cents := derived_amount_text::integer;
      if derived_amount_cents > 100000000 then
        raise exception 'Stripe invoice amount is outside accepted bounds'
          using errcode = '22023';
      end if;
      derived_description := left(regexp_replace(
        coalesce(
          nullif(btrim(event_object #>> '{lines,data,0,description}'), ''),
          'Recurring cleaning invoice'
        ), '[[:cntrl:]]', ' ', 'g'
      ), 500);
      insert into public.billing_records
        (customer_id, description, amount_cents, status, stripe_invoice_id,
         is_dev_seed)
      values (
        derived_customer_id, derived_description, derived_amount_cents,
        'paid', derived_stripe_invoice_id, actor_customer.is_dev_seed
      )
      on conflict do nothing;
      select billing.* into existing_billing
      from public.billing_records billing
      where billing.stripe_invoice_id = derived_stripe_invoice_id;
      if existing_billing.id is null
        or existing_billing.customer_id <> derived_customer_id
        or existing_billing.amount_cents <> derived_amount_cents
        or existing_billing.status <> 'paid'
        or existing_billing.description <> derived_description then
        raise exception 'Stripe invoice receipt conflict' using errcode = '23505';
      end if;
    else
      insert into public.support_messages
        (customer_id, sender, body, is_dev_seed)
      values (
        derived_customer_id, 'concierge',
        'We could not confirm the latest payment. Your service schedule has not been changed; please review billing or contact support.',
        actor_customer.is_dev_seed
      );
    end if;
  end if;

  update public.stripe_event_receipts receipt
  set status = 'processed', processed_at = observed_at,
      last_error_code = null, updated_at = observed_at
  where receipt.event_id = verified.verified_event_id
    and receipt.event_type = verified.verified_event_type
    and receipt.livemode = verified.verified_livemode
    and receipt.payload_sha256 = verified.verified_payload_sha256
    and receipt.status = 'processing';
  if not found then
    raise exception 'Stripe receipt completion lost its processing lease'
      using errcode = '40001';
  end if;
  delete from private.stripe_event_processing_capabilities capability
  where capability.capability_id = requested_processing_capability
    and capability.consumed_at is not null;
  return true;
end
$$;

create function private.ignore_verified_stripe_event(
  requested_processing_capability uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  verified record;
  observed_at timestamptz := clock_timestamp();
begin
  select * into verified
  from private.consume_verified_stripe_capability(
    requested_processing_capability
  );
  if verified.verified_event_id is null then
    return false;
  end if;
  if verified.verified_event_type in (
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'invoice.paid',
      'invoice.payment_failed'
    )
    and private.stripe_event_is_lakeandpine(
      verified.verified_event_type, verified.verified_payload_document
    ) then
    raise exception 'Owned Stripe events cannot be ignored'
      using errcode = '42501';
  end if;
  update public.stripe_event_receipts receipt
  set status = 'ignored', processed_at = observed_at,
      last_error_code = null, updated_at = observed_at
  where receipt.event_id = verified.verified_event_id
    and receipt.event_type = verified.verified_event_type
    and receipt.livemode = verified.verified_livemode
    and receipt.payload_sha256 = verified.verified_payload_sha256
    and receipt.status = 'processing';
  if not found then
    raise exception 'Stripe ignore lost its processing lease'
      using errcode = '40001';
  end if;
  delete from private.stripe_event_processing_capabilities capability
  where capability.capability_id = requested_processing_capability
    and capability.consumed_at is not null;
  return true;
end
$$;

create function private.fail_verified_stripe_event(
  requested_processing_capability uuid,
  requested_error_code text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  verified record;
  safe_error_code text;
  observed_at timestamptz := clock_timestamp();
begin
  if char_length(coalesce(requested_error_code, '')) > 500 then
    raise exception 'Stripe failure code is outside accepted bounds'
      using errcode = '22023';
  end if;
  safe_error_code := left(regexp_replace(
    coalesce(nullif(requested_error_code, ''), 'WebhookProcessingError'),
    '[^A-Za-z0-9_.:-]', '', 'g'
  ), 120);
  if safe_error_code = '' then
    safe_error_code := 'WebhookProcessingError';
  end if;
  select * into verified
  from private.consume_verified_stripe_capability(
    requested_processing_capability
  );
  if verified.verified_event_id is null then
    return false;
  end if;
  update public.stripe_event_receipts receipt
  set status = 'failed', processed_at = null,
      last_error_code = safe_error_code, updated_at = observed_at
  where receipt.event_id = verified.verified_event_id
    and receipt.event_type = verified.verified_event_type
    and receipt.livemode = verified.verified_livemode
    and receipt.payload_sha256 = verified.verified_payload_sha256
    and receipt.status = 'processing';
  if not found then
    raise exception 'Stripe failure recording lost its processing lease'
      using errcode = '40001';
  end if;
  delete from private.stripe_event_processing_capabilities capability
  where capability.capability_id = requested_processing_capability
    and capability.consumed_at is not null;
  return true;
end
$$;

-- Retire the caller-asserted receipt and completion APIs. They remain defined
-- only so this additive migration can be staged safely over the predecessor;
-- the runtime role cannot execute them.
revoke all on function private.claim_stripe_event_receipt(
  text, text, boolean, text
) from public, lakeandpine_app;
revoke all on function private.complete_stripe_checkout_session(
  text, text, uuid, text, text, integer, text
) from public, lakeandpine_app;
revoke all on function private.complete_stripe_invoice_paid(
  text, text, uuid, text, text, integer, text
) from public, lakeandpine_app;
revoke all on function private.complete_stripe_payment_failed(
  text, text, uuid, text, text
) from public, lakeandpine_app;
revoke all on function private.finish_stripe_event_receipt(
  text, text, text, text
) from public, lakeandpine_app;

revoke all on function private.constant_time_bytea_equals(bytea, bytea)
  from public, lakeandpine_app;
revoke all on function private.stripe_json_object_id(jsonb)
  from public, lakeandpine_app;
revoke all on function private.stripe_event_is_lakeandpine(text, jsonb)
  from public, lakeandpine_app;
revoke all on function private.consume_verified_stripe_capability(uuid)
  from public, lakeandpine_app;
revoke all on function private.verify_and_claim_stripe_event(text, text)
  from public;
revoke all on function private.complete_verified_stripe_event(uuid)
  from public;
revoke all on function private.ignore_verified_stripe_event(uuid)
  from public;
revoke all on function private.fail_verified_stripe_event(uuid, text)
  from public;

grant execute on function private.verify_and_claim_stripe_event(text, text)
  to lakeandpine_app;
grant execute on function private.complete_verified_stripe_event(uuid)
  to lakeandpine_app;
grant execute on function private.ignore_verified_stripe_event(uuid)
  to lakeandpine_app;
grant execute on function private.fail_verified_stripe_event(uuid, text)
  to lakeandpine_app;

-- Financial and inventory evidence hardening -------------------------------
--
-- The application supplies business facts, never its own audit identity or
-- lifecycle receipts. Every application-role write below resolves the current
-- verified identity to one active workforce membership and stamps it in the
-- database transaction that creates or advances the record.

alter table public.inventory_transactions
  add column restock_request_id uuid
    references public.restock_requests(id) on delete restrict;
create unique index inventory_transactions_restock_receipt_key
  on public.inventory_transactions (restock_request_id)
  where restock_request_id is not null;
create index inventory_transactions_allocation_scope_hardened_idx
  on public.inventory_transactions (
    organization_id, team_id, team_job_allocation_id
  ) where team_job_allocation_id is not null;
alter table public.inventory_transactions
  add constraint inventory_transactions_allocation_scope_fkey
  foreign key (organization_id, team_id, team_job_allocation_id)
  references public.team_job_allocations (organization_id, team_id, id);

alter table public.restock_requests
  add column approved_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column approved_at timestamptz,
  add column approval_note text
    check (approval_note is null or char_length(approval_note) <= 1000),
  add column ordered_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column order_note text
    check (order_note is null or char_length(order_note) <= 1000),
  add column received_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column receipt_note text
    check (receipt_note is null or char_length(receipt_note) <= 1000),
  add column canceled_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column canceled_at timestamptz,
  add column cancellation_note text
    check (cancellation_note is null or char_length(cancellation_note) <= 1000),
  add column decline_note text
    check (decline_note is null or char_length(decline_note) <= 1000);
create index restock_requests_approver_idx
  on public.restock_requests (approved_by_membership_id)
  where approved_by_membership_id is not null;
create index restock_requests_order_actor_idx
  on public.restock_requests (ordered_by_membership_id)
  where ordered_by_membership_id is not null;
create index restock_requests_receipt_actor_idx
  on public.restock_requests (received_by_membership_id)
  where received_by_membership_id is not null;
create index restock_requests_cancel_actor_idx
  on public.restock_requests (canceled_by_membership_id)
  where canceled_by_membership_id is not null;

-- Older rows had only one mutable actor. Preserve the strongest recoverable
-- attribution during upgrade; all new transitions use distinct receipts.
update public.restock_requests request
set approved_by_membership_id = request.decision_by_membership_id,
    approved_at = request.decided_at,
    approval_note = request.decision_note
where request.status in ('approved', 'ordered', 'received')
  and request.approved_by_membership_id is null;
update public.restock_requests request
set ordered_by_membership_id = request.decision_by_membership_id,
    order_note = request.decision_note
where request.status in ('ordered', 'received')
  and request.ordered_by_membership_id is null;
update public.restock_requests request
set received_by_membership_id = request.decision_by_membership_id,
    receipt_note = request.decision_note
where request.status = 'received'
  and request.received_by_membership_id is null;

alter table public.bonus_awards
  add column created_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column exported_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column exported_at timestamptz,
  add column paid_recorded_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column paid_recorded_at timestamptz,
  add column canceled_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column canceled_at timestamptz;
create index bonus_awards_creator_idx
  on public.bonus_awards (created_by_membership_id)
  where created_by_membership_id is not null;
create index bonus_awards_export_actor_idx
  on public.bonus_awards (exported_by_membership_id)
  where exported_by_membership_id is not null;
create index bonus_awards_paid_actor_idx
  on public.bonus_awards (paid_recorded_by_membership_id)
  where paid_recorded_by_membership_id is not null;
create index bonus_awards_cancel_actor_idx
  on public.bonus_awards (canceled_by_membership_id)
  where canceled_by_membership_id is not null;

update public.bonus_awards award
set exported_by_membership_id = award.approved_by_membership_id,
    exported_at = award.approved_at
where award.status in ('exported', 'recorded_paid')
  and award.exported_by_membership_id is null;
update public.bonus_awards award
set paid_recorded_by_membership_id = award.approved_by_membership_id,
    paid_recorded_at = award.approved_at
where award.status = 'recorded_paid'
  and award.paid_recorded_by_membership_id is null;

alter table public.workforce_events
  add column acknowledged_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column resolved_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column appealed_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column appealed_at timestamptz,
  add column appeal_note text
    check (appeal_note is null or char_length(appeal_note) <= 1000),
  add column resolution_note text
    check (resolution_note is null or char_length(resolution_note) <= 2000),
  add column version integer not null default 1 check (version > 0);
create index workforce_events_ack_actor_idx
  on public.workforce_events (acknowledged_by_membership_id)
  where acknowledged_by_membership_id is not null;
create index workforce_events_resolver_idx
  on public.workforce_events (resolved_by_membership_id)
  where resolved_by_membership_id is not null;
create index workforce_events_appeal_actor_idx
  on public.workforce_events (appealed_by_membership_id)
  where appealed_by_membership_id is not null;

create function private.require_current_actor_membership(
  requested_organization_id uuid,
  requested_team_id uuid,
  allowed_roles text[]
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  actor_id uuid;
  actor_role text;
begin
  if (private.current_customer_id() is null)
      = (private.current_cleaner_id() is null) then
    raise exception 'Operation requires exactly one verified actor identity'
      using errcode = '42501';
  end if;

  select actor.actor_membership_id, actor.actor_role
    into actor_id, actor_role
  from private.current_actor_for_scope(
    requested_organization_id, requested_team_id
  ) actor;

  if actor_id is null or not (actor_role = any(allowed_roles)) then
    raise exception 'Current actor lacks the required scoped membership'
      using errcode = '42501';
  end if;

  -- Keep authorization and the evidence write linearizable with membership
  -- revocation until the surrounding transaction commits.
  perform membership.id
  from public.workforce_memberships membership
  where membership.id = actor_id
    and membership.organization_id = requested_organization_id
    and (membership.team_id is null
      or membership.team_id = requested_team_id)
    and membership.status = 'active'
  for share;
  if not found then
    raise exception 'Current actor membership changed during the operation'
      using errcode = '40001';
  end if;
  return actor_id;
end
$$;
revoke all on function private.require_current_actor_membership(
  uuid, uuid, text[]
) from public, lakeandpine_app;

create function private.guard_team_job_allocation_evidence()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  schedule_estimate integer;
  derived_dev_seed boolean;
begin
  if tg_op = 'UPDATE' then
    if new.assigned_by_membership_id is distinct from old.assigned_by_membership_id
      or new.allocated_at is distinct from old.allocated_at
      or new.is_dev_seed is distinct from old.is_dev_seed then
      raise exception 'Allocation creation evidence is immutable'
        using errcode = '55000';
    end if;
    return new;
  end if;

  select schedule.labor_minutes,
         (schedule.is_dev_seed or team.is_dev_seed)
    into schedule_estimate, derived_dev_seed
  from public.job_schedules schedule
  join public.cleaning_teams team
    on team.organization_id = new.organization_id
   and team.id = new.team_id
  where schedule.id = new.job_schedule_id
  for share of schedule, team;
  if not found then
    raise exception 'Allocation requires one existing schedule and team'
      using errcode = '23503';
  end if;

  if private.application_role_is_active() then
    new.assigned_by_membership_id :=
      private.require_current_actor_membership(
        new.organization_id, new.team_id,
        array['owner', 'gm', 'manager', 'shift_lead']
      );
    new.estimated_labor_minutes := schedule_estimate;
    new.allocated_at := clock_timestamp();
    new.is_dev_seed := derived_dev_seed;
  elsif new.assigned_by_membership_id is not null and not exists (
    select 1
    from public.workforce_memberships actor
    where actor.id = new.assigned_by_membership_id
      and actor.organization_id = new.organization_id
      and (actor.team_id is null or actor.team_id = new.team_id)
      and actor.status = 'active'
  ) then
    raise exception 'Allocation actor must be active in the target scope'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger team_job_allocations_exact_actor_guard
  before insert or update on public.team_job_allocations for each row
  execute function private.guard_team_job_allocation_evidence();
revoke all on function private.guard_team_job_allocation_evidence()
  from public, lakeandpine_app;

create function private.guard_inventory_product_evidence()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  derived_dev_seed boolean;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.organization_id is distinct from old.organization_id
      or new.team_id is distinct from old.team_id
      or new.created_by_membership_id is distinct from old.created_by_membership_id
      or new.is_dev_seed is distinct from old.is_dev_seed
      or new.created_at is distinct from old.created_at then
      raise exception 'Inventory product identity and creation evidence are immutable'
        using errcode = '55000';
    end if;
    return new;
  end if;

  select team.is_dev_seed into derived_dev_seed
  from public.cleaning_teams team
  where team.organization_id = new.organization_id
    and team.id = new.team_id
  for share;
  if not found then
    raise exception 'Inventory product requires an existing team'
      using errcode = '23503';
  end if;
  if private.application_role_is_active() then
    new.created_by_membership_id :=
      private.require_current_actor_membership(
        new.organization_id, new.team_id,
        array['owner', 'gm', 'manager', 'shift_lead']
      );
    new.is_dev_seed := derived_dev_seed;
    new.created_at := clock_timestamp();
    new.updated_at := new.created_at;
  end if;
  return new;
end
$$;
create trigger inventory_products_exact_actor_guard
  before insert or update on public.inventory_products for each row
  execute function private.guard_inventory_product_evidence();
revoke all on function private.guard_inventory_product_evidence()
  from public, lakeandpine_app;

create or replace function private.guard_quality_review_actor()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1
    from public.team_job_allocations allocation
    join public.job_assignments assignment
      on assignment.job_schedule_id = allocation.job_schedule_id
     and assignment.team_id = allocation.team_id
     and assignment.cleaner_id = new.cleaner_id
     and assignment.status in ('accepted', 'confirmed')
    where allocation.id = new.team_job_allocation_id
      and allocation.organization_id = new.organization_id
      and allocation.team_id = new.team_id
  ) then
    raise exception 'Quality review cleaner must belong to the allocated team crew'
      using errcode = '23514';
  end if;
  if private.current_customer_id() is not null
    and private.current_cleaner_id() is not null then
    raise exception 'Quality review requires exactly one actor'
      using errcode = '42501';
  end if;

  if new.source = 'verified_customer'
    and new.customer_id = private.current_customer_id()
    and private.current_cleaner_id() is null then
    new.created_by_membership_id := null;
    new.verified_at := clock_timestamp();
    new.evidence_reference := 'customer:' || new.customer_id::text
      || ':allocation:' || new.team_job_allocation_id::text;
    return new;
  end if;

  if private.current_customer_id() is null
    or private.current_cleaner_id() is not null
    or new.source = 'verified_customer'
    or new.customer_id is not null
    or new.verified_at is not null then
    raise exception 'Internal quality evidence requires one scoped staff actor'
      using errcode = '42501';
  end if;
  new.created_by_membership_id :=
    private.require_current_actor_membership(
      new.organization_id, new.team_id,
      array['owner', 'gm', 'manager']
    );
  return new;
end
$$;
revoke all on function private.guard_quality_review_actor()
  from public, lakeandpine_app;

create function private.guard_compensation_rate_actor()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  subject_dev_seed boolean;
begin
  if tg_op = 'UPDATE' then
    if new.created_by_membership_id is distinct from old.created_by_membership_id
      or new.is_dev_seed is distinct from old.is_dev_seed
      or new.created_at is distinct from old.created_at then
      raise exception 'Compensation creation evidence is immutable'
        using errcode = '55000';
    end if;
    return new;
  end if;

  select subject.is_dev_seed into subject_dev_seed
  from public.workforce_memberships subject
  where subject.id = new.workforce_membership_id
    and subject.organization_id = new.organization_id
    and subject.team_id = new.team_id
  for share;
  if not found then
    raise exception 'Compensation subject must belong to the target team'
      using errcode = '23514';
  end if;
  if private.application_role_is_active() then
    new.created_by_membership_id :=
      private.require_current_actor_membership(
        new.organization_id, new.team_id,
        array['owner', 'gm', 'manager']
      );
    new.status := 'active';
    new.is_dev_seed := subject_dev_seed;
    new.created_at := clock_timestamp();
    new.updated_at := new.created_at;
  end if;
  return new;
end
$$;
create trigger compensation_rates_exact_actor_guard
  before insert or update on public.compensation_rates for each row
  execute function private.guard_compensation_rate_actor();
revoke all on function private.guard_compensation_rate_actor()
  from public, lakeandpine_app;

create or replace function public.guard_compensation_rate_overlap()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'compensation-rate:' || new.workforce_membership_id::text,
      20260714173819
    )
  );
  if new.status = 'active' and exists (
    select 1
    from public.compensation_rates existing
    where existing.workforce_membership_id = new.workforce_membership_id
      and existing.id <> new.id
      and existing.status = 'active'
      and daterange(
        existing.effective_from,
        coalesce(existing.effective_to, 'infinity'::date), '[]'
      ) && daterange(
        new.effective_from,
        coalesce(new.effective_to, 'infinity'::date), '[]'
      )
  ) then
    raise exception 'Active compensation periods cannot overlap'
      using errcode = '23P01';
  end if;
  return new;
end
$$;
revoke all on function public.guard_compensation_rate_overlap()
  from public, lakeandpine_app;

create or replace function public.apply_inventory_transaction()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  current_balance numeric(12,3);
  next_balance numeric(12,3);
  product_row record;
  actor_id uuid;
  actor_row record;
  request_row record;
  evidence_at timestamptz := clock_timestamp();
begin
  select product.unit_cost_cents, product.is_dev_seed
    into product_row
  from public.inventory_products product
  join public.inventory_locations location
    on location.organization_id = product.organization_id
   and location.team_id = product.team_id
   and location.id = new.location_id
  where product.id = new.product_id
    and product.organization_id = new.organization_id
    and product.team_id = new.team_id
  for share of product, location;
  if not found then
    raise exception 'Inventory movement product and location must share one team scope'
      using errcode = '23514';
  end if;

  if new.team_job_allocation_id is not null and not exists (
    select 1
    from public.team_job_allocations allocation
    where allocation.id = new.team_job_allocation_id
      and allocation.organization_id = new.organization_id
      and allocation.team_id = new.team_id
  ) then
    raise exception 'Inventory allocation must belong to the same team scope'
      using errcode = '23514';
  end if;

  if new.restock_request_id is not null then
    select request.id, request.organization_id, request.team_id,
           request.location_id, request.product_id, request.status,
           request.quantity_requested, request.estimated_unit_cost_cents,
           request.received_by_membership_id, request.is_dev_seed
      into request_row
    from public.restock_requests request
    where request.id = new.restock_request_id
    for share;
    if not found
      or request_row.organization_id <> new.organization_id
      or request_row.team_id <> new.team_id
      or request_row.location_id <> new.location_id
      or request_row.product_id <> new.product_id
      or request_row.status <> 'received'
      or request_row.received_by_membership_id is null then
      raise exception 'Restock receipt ledger link is invalid or incomplete'
        using errcode = '23514';
    end if;
    new.transaction_type := 'receipt';
    new.quantity_delta := request_row.quantity_requested;
    new.actor_membership_id := request_row.received_by_membership_id;
    new.unit_cost_cents := request_row.estimated_unit_cost_cents;
    new.note := 'Received approved restock';
    new.is_dev_seed := request_row.is_dev_seed;
  elsif private.application_role_is_active() then
    actor_id := private.require_current_actor_membership(
      new.organization_id, new.team_id,
      case when new.transaction_type = 'usage'
        then array['owner', 'gm', 'manager', 'shift_lead', 'cleaner']
        else array['owner', 'gm', 'manager', 'shift_lead']
      end
    );
    new.actor_membership_id := actor_id;
    new.is_dev_seed := product_row.is_dev_seed;
    new.unit_cost_cents := case
      when new.transaction_type = 'receipt' then product_row.unit_cost_cents
      else null
    end;
  elsif new.actor_membership_id is not null and not exists (
    select 1
    from public.workforce_memberships actor
    where actor.id = new.actor_membership_id
      and actor.organization_id = new.organization_id
      and (actor.team_id is null or actor.team_id = new.team_id)
      and actor.status = 'active'
  ) then
    raise exception 'Inventory actor must be active in the target scope'
      using errcode = '23514';
  end if;

  if new.actor_membership_id is not null then
    select actor.cleaner_id, actor.role into actor_row
    from public.workforce_memberships actor
    where actor.id = new.actor_membership_id
      and actor.organization_id = new.organization_id
      and (actor.team_id is null or actor.team_id = new.team_id)
    for share;
    if not found then
      raise exception 'Inventory actor membership is outside the movement scope'
        using errcode = '23514';
    end if;
    new.cleaner_id := actor_row.cleaner_id;
  elsif private.application_role_is_active() then
    raise exception 'Application inventory movement requires an accountable actor'
      using errcode = '42501';
  end if;

  if private.application_role_is_active()
    and actor_row.role = 'cleaner'
    and new.transaction_type <> 'usage' then
    raise exception 'Cleaners may record only their own product usage'
      using errcode = '42501';
  end if;
  if actor_row.cleaner_id is not null
    and new.team_job_allocation_id is not null
    and not exists (
      select 1
      from public.team_job_allocations allocation
      join public.job_assignments assignment
        on assignment.job_schedule_id = allocation.job_schedule_id
       and assignment.cleaner_id = actor_row.cleaner_id
       and assignment.status in ('accepted', 'confirmed')
      where allocation.id = new.team_job_allocation_id
        and allocation.organization_id = new.organization_id
        and allocation.team_id = new.team_id
    ) then
    raise exception 'Cleaner inventory usage may link only to accepted assigned work'
      using errcode = '42501';
  end if;

  if (new.transaction_type in ('usage', 'waste', 'transfer_out')
        and new.quantity_delta >= 0)
    or (new.transaction_type in ('receipt', 'return', 'transfer_in')
        and new.quantity_delta <= 0) then
    raise exception 'Inventory transaction direction does not match its type'
      using errcode = '23514';
  end if;

  new.created_at := evidence_at;
  perform pg_catalog.set_config(
    'lakeandpine.inventory_ledger_write', '1', true
  );
  select stock.on_hand into current_balance
  from public.inventory_stock stock
  where stock.organization_id = new.organization_id
    and stock.team_id = new.team_id
    and stock.location_id = new.location_id
    and stock.product_id = new.product_id
  for update;
  if not found then
    raise exception 'Create the team stock record before recording inventory activity'
      using errcode = '23503';
  end if;
  next_balance := current_balance + new.quantity_delta;
  if next_balance < 0 then
    raise exception 'Inventory usage exceeds available team stock'
      using errcode = '23514';
  end if;
  update public.inventory_stock stock
  set on_hand = next_balance,
      last_counted_at = case
        when new.transaction_type = 'adjustment' then evidence_at
        else stock.last_counted_at
      end,
      updated_at = evidence_at
  where stock.organization_id = new.organization_id
    and stock.team_id = new.team_id
    and stock.location_id = new.location_id
    and stock.product_id = new.product_id;
  new.balance_after := next_balance;
  return new;
end
$$;
revoke all on function public.apply_inventory_transaction()
  from public, lakeandpine_app;

create or replace function public.guard_restock_request_lifecycle()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid;
  provided_actor_id uuid;
  product_row record;
  evidence_at timestamptz := clock_timestamp();
begin
  select product.unit_cost_cents, product.purchase_url, product.is_dev_seed
    into product_row
  from public.inventory_products product
  join public.inventory_locations location
    on location.organization_id = product.organization_id
   and location.team_id = product.team_id
   and location.id = new.location_id
  where product.id = new.product_id
    and product.organization_id = new.organization_id
    and product.team_id = new.team_id
  for share of product, location;
  if not found then
    raise exception 'Restock product and location must share one team scope'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if private.application_role_is_active() then
      if new.request_source = 'automatic_threshold' then
        if pg_trigger_depth() < 2 then
          raise exception 'Automatic restock drafts require the stock threshold trigger'
            using errcode = '42501';
        end if;
        new.requested_by_membership_id := null;
      else
        actor_id := private.require_current_actor_membership(
          new.organization_id, new.team_id,
          case when new.request_source = 'cleaner'
            then array['shift_lead', 'cleaner']
            else array['owner', 'gm', 'manager', 'shift_lead']
          end
        );
        new.requested_by_membership_id := actor_id;
      end if;
      new.estimated_unit_cost_cents := product_row.unit_cost_cents;
      new.purchase_url_snapshot := product_row.purchase_url;
      new.status := 'requested';
      new.decision_by_membership_id := null;
      new.decision_note := null;
      new.decided_at := null;
      new.approved_by_membership_id := null;
      new.approved_at := null;
      new.approval_note := null;
      new.ordered_by_membership_id := null;
      new.ordered_at := null;
      new.order_note := null;
      new.received_by_membership_id := null;
      new.received_at := null;
      new.receipt_note := null;
      new.canceled_by_membership_id := null;
      new.canceled_at := null;
      new.cancellation_note := null;
      new.decline_note := null;
      new.version := 1;
      new.is_dev_seed := product_row.is_dev_seed;
      new.created_at := evidence_at;
      new.updated_at := evidence_at;
    elsif new.status <> 'requested'
      or new.decision_by_membership_id is not null
      or new.decided_at is not null
      or new.approved_by_membership_id is not null
      or new.approved_at is not null
      or new.ordered_by_membership_id is not null
      or new.ordered_at is not null
      or new.received_by_membership_id is not null
      or new.received_at is not null
      or new.canceled_by_membership_id is not null
      or new.canceled_at is not null
      or new.version <> 1 then
      raise exception 'Restock requests must begin as one unreviewed request'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.team_id is distinct from old.team_id
    or new.location_id is distinct from old.location_id
    or new.product_id is distinct from old.product_id
    or new.requested_by_membership_id is distinct from old.requested_by_membership_id
    or new.request_source is distinct from old.request_source
    or new.quantity_requested is distinct from old.quantity_requested
    or new.estimated_unit_cost_cents is distinct from old.estimated_unit_cost_cents
    or new.purchase_url_snapshot is distinct from old.purchase_url_snapshot
    or new.is_dev_seed is distinct from old.is_dev_seed
    or new.created_at is distinct from old.created_at
    or not (
      (old.status = 'requested'
        and new.status in ('approved', 'declined', 'canceled'))
      or (old.status = 'approved'
        and new.status in ('ordered', 'canceled'))
      or (old.status = 'ordered'
        and new.status in ('received', 'canceled'))
    ) then
    raise exception 'Invalid or destructive restock transition'
      using errcode = '55000';
  end if;

  provided_actor_id := case
    when old.status = 'requested' and new.status = 'approved'
      then coalesce(new.approved_by_membership_id, new.decision_by_membership_id)
    when old.status = 'requested' and new.status = 'declined'
      then new.decision_by_membership_id
    when new.status = 'ordered' then new.ordered_by_membership_id
    when new.status = 'received' then new.received_by_membership_id
    when new.status = 'canceled' then new.canceled_by_membership_id
    else null
  end;
  if private.application_role_is_active() then
    actor_id := private.require_current_actor_membership(
      old.organization_id, old.team_id,
      array['owner', 'gm', 'manager']
    );
  else
    actor_id := provided_actor_id;
    if actor_id is null or not exists (
      select 1
      from public.workforce_memberships actor
      where actor.id = actor_id
        and actor.organization_id = old.organization_id
        and (actor.team_id is null or actor.team_id = old.team_id)
        and actor.status = 'active'
        and actor.role in ('owner', 'gm', 'manager')
    ) then
      raise exception 'Restock transition requires a fresh scoped actor'
        using errcode = '55000';
    end if;
  end if;

  -- Preserve every completed phase before stamping the one transition being
  -- performed. The legacy decision fields retain only the first decision.
  new.decision_by_membership_id := old.decision_by_membership_id;
  new.decided_at := old.decided_at;
  new.approved_by_membership_id := old.approved_by_membership_id;
  new.approved_at := old.approved_at;
  new.approval_note := old.approval_note;
  new.ordered_by_membership_id := old.ordered_by_membership_id;
  new.ordered_at := old.ordered_at;
  new.order_note := old.order_note;
  new.received_by_membership_id := old.received_by_membership_id;
  new.received_at := old.received_at;
  new.receipt_note := old.receipt_note;
  new.canceled_by_membership_id := old.canceled_by_membership_id;
  new.canceled_at := old.canceled_at;
  new.cancellation_note := old.cancellation_note;
  new.decline_note := old.decline_note;
  new.version := old.version + 1;

  if old.status = 'requested' and new.status = 'approved' then
    new.decision_by_membership_id := actor_id;
    new.decided_at := evidence_at;
    new.approved_by_membership_id := actor_id;
    new.approved_at := evidence_at;
    new.approval_note := new.decision_note;
  elsif old.status = 'requested' and new.status = 'declined' then
    new.decision_by_membership_id := actor_id;
    new.decided_at := evidence_at;
    new.decline_note := new.decision_note;
  elsif new.status = 'ordered' then
    new.ordered_by_membership_id := actor_id;
    new.ordered_at := evidence_at;
    new.order_note := new.decision_note;
  elsif new.status = 'received' then
    new.received_by_membership_id := actor_id;
    new.received_at := evidence_at;
    new.receipt_note := new.decision_note;
  elsif new.status = 'canceled' then
    new.canceled_by_membership_id := actor_id;
    new.canceled_at := evidence_at;
    new.cancellation_note := new.decision_note;
    if old.status = 'requested' then
      new.decision_by_membership_id := actor_id;
      new.decided_at := evidence_at;
    end if;
  end if;
  return new;
end
$$;
revoke all on function public.guard_restock_request_lifecycle()
  from public, lakeandpine_app;

create function private.record_received_restock_inventory()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status <> 'received' and new.status = 'received' then
    insert into public.inventory_transactions
      (organization_id, team_id, location_id, product_id,
       transaction_type, quantity_delta, balance_after,
       actor_membership_id, unit_cost_cents, note,
       restock_request_id, is_dev_seed)
    values (
      new.organization_id, new.team_id, new.location_id, new.product_id,
      'receipt', new.quantity_requested, 0,
      new.received_by_membership_id, new.estimated_unit_cost_cents,
      'Received approved restock', new.id, new.is_dev_seed
    )
    on conflict do nothing;
  end if;
  return null;
end
$$;
create trigger restock_requests_received_inventory_ledger
  after update of status on public.restock_requests for each row
  execute function private.record_received_restock_inventory();
revoke all on function private.record_received_restock_inventory()
  from public, lakeandpine_app;

create or replace function public.guard_bonus_award_transition()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  subject_row record;
  review_row record;
  tier_row record;
  actor_id uuid;
  provided_actor_id uuid;
  provided_external_reference text;
  system_proposal boolean := false;
  derived_dev_seed boolean;
  evidence_at timestamptz := clock_timestamp();
begin
  select subject.cleaner_id, subject.is_dev_seed
    into subject_row
  from public.workforce_memberships subject
  where subject.id = new.workforce_membership_id
    and subject.organization_id = new.organization_id
    and subject.team_id = new.team_id
  for share;
  if not found then
    raise exception 'Bonus subject must belong to the target team'
      using errcode = '23514';
  end if;

  if (new.quality_review_id is null) <> (new.bonus_tier_id is null) then
    raise exception 'Review bonuses require both review and tier evidence'
      using errcode = '23514';
  end if;
  if new.quality_review_id is not null then
    select review.organization_id, review.team_id, review.cleaner_id,
           review.rating, review.source, review.verified_at,
           review.is_dev_seed
      into review_row
    from public.quality_reviews review
    where review.id = new.quality_review_id
    for share;
    select tier.organization_id, tier.team_id, tier.minimum_rating,
           tier.bonus_cents, tier.active, tier.is_dev_seed
      into tier_row
    from public.review_bonus_tiers tier
    where tier.id = new.bonus_tier_id
    for share;
    if review_row.organization_id is null
      or review_row.organization_id <> new.organization_id
      or review_row.team_id <> new.team_id
      or review_row.cleaner_id is distinct from subject_row.cleaner_id
      or tier_row.organization_id is null
      or tier_row.organization_id <> new.organization_id
      or (tier_row.team_id is not null and tier_row.team_id <> new.team_id) then
      raise exception 'Bonus review, tier, cleaner, and team scope must agree'
        using errcode = '23514';
    end if;
    derived_dev_seed := subject_row.is_dev_seed
      or review_row.is_dev_seed or tier_row.is_dev_seed;
  else
    derived_dev_seed := subject_row.is_dev_seed;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'proposed'
      or new.approved_by_membership_id is not null
      or new.approved_at is not null
      or new.exported_by_membership_id is not null
      or new.exported_at is not null
      or new.paid_recorded_by_membership_id is not null
      or new.paid_recorded_at is not null
      or new.canceled_by_membership_id is not null
      or new.canceled_at is not null
      or new.external_reference is not null
      or new.version <> 1 then
      raise exception 'Bonus awards must begin as one unapproved proposal'
        using errcode = '23514';
    end if;
    if new.quality_review_id is not null and (
      review_row.source <> 'verified_customer'
      or review_row.verified_at is null
      or not tier_row.active
      or review_row.rating < tier_row.minimum_rating
      or new.amount_cents <> tier_row.bonus_cents
    ) then
      raise exception 'Review bonus amount and eligibility must match verified tier evidence'
        using errcode = '23514';
    end if;

    system_proposal := new.quality_review_id is not null
      and new.bonus_tier_id is not null
      and pg_trigger_depth() > 1;
    if private.application_role_is_active() and not system_proposal then
      new.created_by_membership_id :=
        private.require_current_actor_membership(
          new.organization_id, new.team_id,
          array['owner', 'gm', 'manager']
        );
    elsif system_proposal then
      new.created_by_membership_id := null;
    elsif new.created_by_membership_id is not null and not exists (
      select 1
      from public.workforce_memberships actor
      where actor.id = new.created_by_membership_id
        and actor.organization_id = new.organization_id
        and (actor.team_id is null or actor.team_id = new.team_id)
        and actor.status = 'active'
        and actor.role in ('owner', 'gm', 'manager')
    ) then
      raise exception 'Bonus proposal actor is outside the target scope'
        using errcode = '23514';
    end if;
    new.is_dev_seed := derived_dev_seed;
    new.created_at := evidence_at;
    new.updated_at := evidence_at;
    return new;
  end if;

  provided_external_reference := new.external_reference;
  provided_actor_id := case
    when old.status = 'proposed' and new.status = 'approved'
      then new.approved_by_membership_id
    when old.status = 'approved' and new.status = 'exported'
      then new.exported_by_membership_id
    when old.status = 'exported' and new.status = 'recorded_paid'
      then new.paid_recorded_by_membership_id
    when new.status = 'canceled' then new.canceled_by_membership_id
    else null
  end;
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.team_id is distinct from old.team_id
    or new.workforce_membership_id is distinct from old.workforce_membership_id
    or new.quality_review_id is distinct from old.quality_review_id
    or new.bonus_tier_id is distinct from old.bonus_tier_id
    or new.amount_cents is distinct from old.amount_cents
    or new.reason is distinct from old.reason
    or new.created_by_membership_id is distinct from old.created_by_membership_id
    or new.is_dev_seed is distinct from old.is_dev_seed
    or new.created_at is distinct from old.created_at
    or not (
      (old.status = 'proposed' and new.status in ('approved', 'canceled'))
      or (old.status = 'approved' and new.status in ('exported', 'canceled'))
      or (old.status = 'exported'
        and new.status in ('recorded_paid', 'canceled'))
    ) then
    raise exception 'Invalid or destructive bonus transition'
      using errcode = '55000';
  end if;

  if private.application_role_is_active() then
    actor_id := private.require_current_actor_membership(
      old.organization_id, old.team_id,
      array['owner', 'gm', 'manager']
    );
  else
    actor_id := provided_actor_id;
    if actor_id is null or not exists (
      select 1
      from public.workforce_memberships actor
      where actor.id = actor_id
        and actor.organization_id = old.organization_id
        and (actor.team_id is null or actor.team_id = old.team_id)
        and actor.status = 'active'
        and actor.role in ('owner', 'gm', 'manager')
    ) then
      raise exception 'Bonus transition requires a fresh scoped actor'
        using errcode = '55000';
    end if;
  end if;

  new.approved_by_membership_id := old.approved_by_membership_id;
  new.approved_at := old.approved_at;
  new.exported_by_membership_id := old.exported_by_membership_id;
  new.exported_at := old.exported_at;
  new.paid_recorded_by_membership_id := old.paid_recorded_by_membership_id;
  new.paid_recorded_at := old.paid_recorded_at;
  new.canceled_by_membership_id := old.canceled_by_membership_id;
  new.canceled_at := old.canceled_at;
  new.external_reference := old.external_reference;
  new.version := old.version + 1;

  if old.status = 'proposed' and new.status = 'approved' then
    if provided_external_reference is not null then
      raise exception 'Bonus approval cannot claim export evidence'
        using errcode = '23514';
    end if;
    new.approved_by_membership_id := actor_id;
    new.approved_at := evidence_at;
  elsif old.status = 'approved' and new.status = 'exported' then
    if char_length(trim(coalesce(provided_external_reference, ''))) < 4 then
      raise exception 'Exported bonus requires a payroll reference'
        using errcode = '23514';
    end if;
    new.exported_by_membership_id := actor_id;
    new.exported_at := evidence_at;
    new.external_reference := trim(provided_external_reference);
  elsif old.status = 'exported' and new.status = 'recorded_paid' then
    if provided_external_reference is distinct from old.external_reference then
      raise exception 'Bonus export reference is immutable after export'
        using errcode = '55000';
    end if;
    new.paid_recorded_by_membership_id := actor_id;
    new.paid_recorded_at := evidence_at;
  elsif new.status = 'canceled' then
    new.canceled_by_membership_id := actor_id;
    new.canceled_at := evidence_at;
  end if;
  return new;
end
$$;
revoke all on function public.guard_bonus_award_transition()
  from public, lakeandpine_app;

alter table public.workforce_events
  add column appeal_reviewed_by_membership_id uuid
    references public.workforce_memberships(id) on delete restrict,
  add column appeal_reviewed_at timestamptz;
create index workforce_events_appeal_reviewer_idx
  on public.workforce_events (appeal_reviewed_by_membership_id)
  where appeal_reviewed_by_membership_id is not null;

create function private.current_actor_can_transition_workforce_event(
  requested_organization_id uuid,
  requested_team_id uuid,
  requested_subject_membership_id uuid,
  requested_event_type text
) returns boolean language sql stable security definer set search_path = '' as $$
  with current_actor as (
    select actor.actor_membership_id
    from private.current_actor_for_scope(
      requested_organization_id, requested_team_id
    ) actor
    where actor.actor_membership_id is not null
  )
  select exists (
    select 1
    from public.workforce_memberships subject
    join current_actor current on true
    join public.workforce_memberships actor
      on actor.id = current.actor_membership_id
    where subject.id = requested_subject_membership_id
      and subject.organization_id = requested_organization_id
      and subject.team_id = requested_team_id
      and actor.organization_id = requested_organization_id
      and actor.status = 'active'
      and (
        actor.id = subject.id
        or (actor.team_id is null and actor.role in ('owner', 'gm'))
        or (actor.team_id = requested_team_id
          and actor.role = 'manager'
          and subject.role in ('shift_lead', 'cleaner'))
        or (actor.team_id = requested_team_id
          and actor.role = 'shift_lead'
          and subject.role in ('shift_lead', 'cleaner')
          and requested_event_type in (
            'callout', 'late', 'no_show', 'safety', 'recognition', 'other'
          ))
      )
  )
$$;
revoke all on function private.current_actor_can_transition_workforce_event(
  uuid, uuid, uuid, text
) from public;
grant execute on function private.current_actor_can_transition_workforce_event(
  uuid, uuid, uuid, text
) to lakeandpine_app;

create function private.guard_workforce_event_creation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid;
  actor_row record;
  subject_row record;
  evidence_at timestamptz := clock_timestamp();
begin
  select subject.role, subject.cleaner_id, subject.is_dev_seed
    into subject_row
  from public.workforce_memberships subject
  where subject.id = new.subject_membership_id
    and subject.organization_id = new.organization_id
    and subject.team_id = new.team_id
  for share;
  if not found then
    raise exception 'Workforce event subject must belong to the target team'
      using errcode = '23514';
  end if;

  if private.application_role_is_active() then
    actor_id := private.require_current_actor_membership(
      new.organization_id, new.team_id,
      array['owner', 'gm', 'manager', 'shift_lead', 'cleaner']
    );
    select actor.role, actor.cleaner_id into actor_row
    from public.workforce_memberships actor
    where actor.id = actor_id
    for share;
    if not private.can_create_workforce_event(
      new.organization_id, new.team_id, new.subject_membership_id,
      new.event_type, actor_id
    ) then
      raise exception 'Current actor cannot create this workforce event'
        using errcode = '42501';
    end if;

    if actor_row.role = 'cleaner' then
      if actor_id <> new.subject_membership_id
        or new.event_type <> 'callout' then
        raise exception 'Cleaners may record only their own callout'
          using errcode = '42501';
      end if;
      new.severity := 'high';
      new.private_details := null;
    elsif actor_row.role = 'shift_lead' then
      new.severity := case new.event_type
        when 'callout' then 'high'
        when 'no_show' then 'high'
        when 'late' then 'medium'
        when 'safety' then 'high'
        when 'recognition' then 'info'
        else 'medium'
      end;
    end if;
    new.created_by_membership_id := actor_id;
    new.status := 'open';
    new.occurred_at := evidence_at;
    new.acknowledged_by_membership_id := null;
    new.acknowledged_at := null;
    new.resolved_by_membership_id := null;
    new.resolved_at := null;
    new.resolution_note := null;
    new.appealed_by_membership_id := null;
    new.appealed_at := null;
    new.appeal_note := null;
    new.appeal_reviewed_by_membership_id := null;
    new.appeal_reviewed_at := null;
    new.version := 1;
    new.is_dev_seed := subject_row.is_dev_seed;
    new.created_at := evidence_at;
    new.updated_at := evidence_at;
  elsif new.status <> 'open'
    or new.acknowledged_at is not null
    or new.resolved_at is not null
    or new.appealed_at is not null
    or new.version <> 1 then
    raise exception 'Workforce events must begin as open raw evidence'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger workforce_events_creation_evidence_guard
  before insert on public.workforce_events for each row
  execute function private.guard_workforce_event_creation();
revoke all on function private.guard_workforce_event_creation()
  from public, lakeandpine_app;

create or replace function public.reject_workforce_event_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid;
  actor_row record;
  subject_row record;
  provided_actor_id uuid;
  provided_resolution_note text;
  provided_appeal_note text;
  evidence_at timestamptz := clock_timestamp();
begin
  if tg_op = 'DELETE' then
    if old.is_dev_seed
      and not private.application_role_is_active()
      and coalesce(
        current_setting('lakeandpine.dev_seed_purge', true), ''
      ) = '1' then
      return old;
    end if;
    raise exception 'Workforce evidence is retained; use a lifecycle decision'
      using errcode = '55000';
  end if;

  provided_resolution_note := new.resolution_note;
  provided_appeal_note := new.appeal_note;
  provided_actor_id := case
    when new.status = 'appealed' then new.appealed_by_membership_id
    when old.status = 'appealed'
      then new.appeal_reviewed_by_membership_id
    when new.status = 'acknowledged'
      then new.acknowledged_by_membership_id
    when new.status = 'resolved' then new.resolved_by_membership_id
    else null
  end;
  if (to_jsonb(new)
      - 'status'
      - 'acknowledged_by_membership_id' - 'acknowledged_at'
      - 'resolved_by_membership_id' - 'resolved_at' - 'resolution_note'
      - 'appealed_by_membership_id' - 'appealed_at' - 'appeal_note'
      - 'appeal_reviewed_by_membership_id' - 'appeal_reviewed_at'
      - 'version' - 'updated_at')
      <> (to_jsonb(old)
      - 'status'
      - 'acknowledged_by_membership_id' - 'acknowledged_at'
      - 'resolved_by_membership_id' - 'resolved_at' - 'resolution_note'
      - 'appealed_by_membership_id' - 'appealed_at' - 'appeal_note'
      - 'appeal_reviewed_by_membership_id' - 'appeal_reviewed_at'
      - 'version' - 'updated_at')
    or new.status is not distinct from old.status
    or not (
      (old.status = 'open'
        and new.status in ('acknowledged', 'resolved', 'appealed'))
      or (old.status = 'acknowledged'
        and new.status in ('resolved', 'appealed'))
      or (old.status = 'resolved' and new.status = 'appealed')
      or (old.status = 'appealed'
        and new.status in ('acknowledged', 'resolved'))
    ) then
    raise exception 'Invalid or destructive workforce-event transition'
      using errcode = '55000';
  end if;

  select subject.role into subject_row
  from public.workforce_memberships subject
  where subject.id = old.subject_membership_id
    and subject.organization_id = old.organization_id
    and subject.team_id = old.team_id
  for share;
  if not found then
    raise exception 'Workforce-event subject scope is unavailable'
      using errcode = '23514';
  end if;

  if private.application_role_is_active() then
    if new.status = 'appealed' then
      select subject.id into actor_id
      from public.workforce_memberships subject
      where subject.id = old.subject_membership_id
        and subject.status = 'active'
        and (
          subject.customer_id = private.current_customer_id()
          or subject.cleaner_id = private.current_cleaner_id()
        )
      for share;
      if actor_id is null then
        raise exception 'Only the event subject may submit an appeal'
          using errcode = '42501';
      end if;
    else
      actor_id := private.require_current_actor_membership(
        old.organization_id, old.team_id,
        array['owner', 'gm', 'manager', 'shift_lead']
      );
      select actor.role, actor.team_id into actor_row
      from public.workforce_memberships actor
      where actor.id = actor_id
      for share;
      if not private.can_create_workforce_event(
        old.organization_id, old.team_id, old.subject_membership_id,
        old.event_type, actor_id
      ) then
        raise exception 'Current actor cannot decide this workforce event'
          using errcode = '42501';
      end if;
    end if;
  else
    actor_id := provided_actor_id;
    if actor_id is null then
      raise exception 'Workforce-event transition requires a fresh actor'
        using errcode = '55000';
    end if;
    select actor.role, actor.team_id into actor_row
    from public.workforce_memberships actor
    where actor.id = actor_id
      and actor.organization_id = old.organization_id
      and (actor.team_id is null or actor.team_id = old.team_id)
      and actor.status = 'active'
    for share;
    if not found
      or (new.status = 'appealed' and actor_id <> old.subject_membership_id)
      or (new.status <> 'appealed' and not (
        (actor_row.team_id is null and actor_row.role in ('owner', 'gm'))
        or (actor_row.team_id = old.team_id
          and actor_row.role = 'manager'
          and subject_row.role in ('shift_lead', 'cleaner'))
        or (actor_row.team_id = old.team_id
          and actor_row.role = 'shift_lead'
          and subject_row.role in ('shift_lead', 'cleaner')
          and old.event_type in (
            'callout', 'late', 'no_show', 'safety', 'recognition', 'other'
          ))
      )) then
      raise exception 'Workforce-event transition actor lacks authority'
        using errcode = '42501';
    end if;
  end if;

  new.acknowledged_by_membership_id := old.acknowledged_by_membership_id;
  new.acknowledged_at := old.acknowledged_at;
  new.resolved_by_membership_id := old.resolved_by_membership_id;
  new.resolved_at := old.resolved_at;
  new.resolution_note := old.resolution_note;
  new.appealed_by_membership_id := old.appealed_by_membership_id;
  new.appealed_at := old.appealed_at;
  new.appeal_note := old.appeal_note;
  new.appeal_reviewed_by_membership_id :=
    old.appeal_reviewed_by_membership_id;
  new.appeal_reviewed_at := old.appeal_reviewed_at;
  new.version := old.version + 1;

  if new.status = 'appealed' then
    if old.appealed_at is not null
      or char_length(trim(coalesce(provided_appeal_note, ''))) < 2 then
      raise exception 'A workforce event accepts one accountable appeal with a reason'
        using errcode = '23514';
    end if;
    new.appealed_by_membership_id := actor_id;
    new.appealed_at := evidence_at;
    new.appeal_note := trim(provided_appeal_note);
  else
    if new.status = 'resolved'
      and char_length(trim(coalesce(provided_resolution_note, ''))) < 2 then
      raise exception 'Resolving workforce evidence requires a decision note'
        using errcode = '23514';
    end if;
    if new.acknowledged_at is null then
      new.acknowledged_by_membership_id := actor_id;
      new.acknowledged_at := evidence_at;
    end if;
    if old.status = 'appealed' then
      new.appeal_reviewed_by_membership_id := actor_id;
      new.appeal_reviewed_at := evidence_at;
    end if;
    if new.status = 'resolved' then
      new.resolved_by_membership_id := actor_id;
      new.resolved_at := evidence_at;
      new.resolution_note := trim(provided_resolution_note);
    end if;
  end if;
  return new;
end
$$;
revoke all on function public.reject_workforce_event_mutation()
  from public, lakeandpine_app;

create or replace function public.create_threshold_restock_draft()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  product_row record;
begin
  select product.automatic_reorder_enabled, product.unit_cost_cents,
         product.purchase_url, product.is_dev_seed
    into product_row
  from public.inventory_products product
  where product.id = new.product_id
    and product.organization_id = new.organization_id
    and product.team_id = new.team_id
  for share;
  if not found then
    raise exception 'Stock threshold product is outside the stock scope'
      using errcode = '23514';
  end if;
  if product_row.automatic_reorder_enabled
    and new.on_hand <= new.reorder_point
    and new.target_level > new.on_hand then
    insert into public.restock_requests
      (organization_id, team_id, location_id, product_id, request_source,
       quantity_requested, estimated_unit_cost_cents, purchase_url_snapshot,
       status, is_dev_seed)
    values (
      new.organization_id, new.team_id, new.location_id, new.product_id,
      'automatic_threshold', new.target_level - new.on_hand,
      product_row.unit_cost_cents, product_row.purchase_url,
      'requested', product_row.is_dev_seed
    )
    on conflict (location_id, product_id)
      where request_source = 'automatic_threshold'
        and status in ('requested', 'approved', 'ordered')
      do nothing;
  end if;
  return new;
end
$$;
revoke all on function public.create_threshold_restock_draft()
  from public, lakeandpine_app;

drop policy workforce_events_update on public.workforce_events;
create policy workforce_events_update
  on public.workforce_events for update to lakeandpine_app using (
    private.current_actor_can_transition_workforce_event(
      organization_id, team_id, subject_membership_id, event_type
    )
  ) with check (
    private.current_actor_can_transition_workforce_event(
      organization_id, team_id, subject_membership_id, event_type
    )
  );

-- Column privileges make actor IDs, timestamps, balances, versions, and
-- lifecycle receipts unreachable from application SQL. BEFORE triggers fill
-- required database-owned columns before constraints and RLS checks run.
revoke insert, update, delete on table public.team_job_allocations
  from lakeandpine_app;
grant insert (organization_id, team_id, job_schedule_id)
  on table public.team_job_allocations to lakeandpine_app;

revoke insert, update, delete on table public.inventory_products
  from lakeandpine_app;
grant insert (
  organization_id, team_id, sku, name, brand, category, unit_label,
  pack_size, preferred_vendor, purchase_url, image_url, safety_sheet_url,
  unit_cost_cents, automatic_reorder_enabled, active
) on table public.inventory_products to lakeandpine_app;
grant update (
  sku, name, brand, category, unit_label, pack_size, preferred_vendor,
  purchase_url, image_url, safety_sheet_url, unit_cost_cents,
  automatic_reorder_enabled, active
) on table public.inventory_products to lakeandpine_app;

revoke insert, update, delete on table public.inventory_transactions
  from lakeandpine_app;
grant insert (
  organization_id, team_id, location_id, product_id, transaction_type,
  quantity_delta, team_job_allocation_id, note
) on table public.inventory_transactions to lakeandpine_app;

revoke insert, update, delete on table public.restock_requests
  from lakeandpine_app;
grant insert (
  organization_id, team_id, location_id, product_id,
  request_source, quantity_requested
) on table public.restock_requests to lakeandpine_app;
grant update (status, decision_note)
  on table public.restock_requests to lakeandpine_app;

revoke insert, update, delete on table public.compensation_rates
  from lakeandpine_app;
grant insert (
  organization_id, team_id, workforce_membership_id, pay_basis,
  amount_cents, currency, effective_from, reason
) on table public.compensation_rates to lakeandpine_app;
grant update (status, effective_to)
  on table public.compensation_rates to lakeandpine_app;

revoke insert, update, delete on table public.quality_reviews
  from lakeandpine_app;
grant insert (
  organization_id, team_id, team_job_allocation_id, cleaner_id,
  customer_id, rating, source, evidence_reference, private_note, is_dev_seed
) on table public.quality_reviews to lakeandpine_app;

revoke insert, update, delete on table public.bonus_awards
  from lakeandpine_app;
grant insert (
  organization_id, team_id, workforce_membership_id,
  quality_review_id, bonus_tier_id, amount_cents, reason
) on table public.bonus_awards to lakeandpine_app;
grant update (status, external_reference)
  on table public.bonus_awards to lakeandpine_app;

revoke insert, update, delete on table public.workforce_events
  from lakeandpine_app;
grant insert (
  organization_id, team_id, subject_membership_id, event_type,
  severity, summary, private_details
) on table public.workforce_events to lakeandpine_app;
grant update (status, appeal_note, resolution_note)
  on table public.workforce_events to lakeandpine_app;
