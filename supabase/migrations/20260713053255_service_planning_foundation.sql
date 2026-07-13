-- Phase 1 service-planning foundation.
--
-- `bookings` remains the service-request/job spine so existing customer data and
-- foreign keys stay intact. New planning detail is stored alongside the request,
-- while normalized operational tables support durable rooms, checklists, private
-- notes, and follow-up work.

alter table bookings drop constraint if exists bookings_status_check;
alter table bookings add constraint bookings_status_check check (
  status in (
    'requested', 'reviewing', 'ready', 'confirmed', 'scheduled',
    'in_progress', 'completed', 'follow_up', 'canceled'
  )
);

alter table bookings
  add column property_profile jsonb not null default '{}',
  add column room_plan jsonb not null default '[]',
  add column cleaning_preferences text[] not null default '{}',
  add column pet_notes text,
  add column special_instructions text,
  add column planning_direction text,
  add column planning_score integer check (planning_score between 0 and 100),
  add column contact_status text not null default 'not_started'
    check (contact_status in ('not_started', 'planned', 'ready', 'completed'));

comment on table bookings is
  'Customer service requests and their operator job lifecycle. Requested dates/windows are preferences until confirmed.';
comment on column bookings.property_profile is
  'Request-time planning snapshot; durable authenticated-customer property data lives in homes.';
comment on column bookings.room_plan is
  'Request-time room selection and notes used to generate the first service checklist.';

create table rooms (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references homes(id) on delete cascade,
  name text not null,
  room_type text not null,
  notes text,
  priority integer not null default 0 check (priority between 0 and 3),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table checklist_items (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  room_id uuid references rooms(id) on delete set null,
  room_label text,
  label text not null,
  state text not null default 'pending'
    check (state in ('pending', 'completed', 'skipped')),
  sort integer not null default 0,
  completed_at timestamptz,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now()
);

create table internal_notes (
  id bigint generated always as identity primary key,
  booking_id uuid not null references bookings(id) on delete cascade,
  author_label text not null default 'Operator',
  body text not null check (char_length(body) between 1 and 4000),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now()
);

create table follow_ups (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  kind text not null check (kind in ('service_check_in', 'review_request')),
  channel text not null default 'manual'
    check (channel in ('manual', 'email', 'sms')),
  status text not null default 'planned'
    check (status in ('planned', 'ready', 'completed', 'canceled')),
  scheduled_for timestamptz,
  completed_at timestamptz,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (booking_id, kind)
);

create index rooms_home_idx on rooms (home_id, priority desc, created_at);
create index checklist_booking_idx on checklist_items (booking_id, state, sort);
create index internal_notes_booking_idx on internal_notes (booking_id, created_at desc);
create index follow_ups_queue_idx on follow_ups (status, scheduled_for);
create index bookings_pipeline_idx on bookings (status, scheduled_date, created_at);

create trigger rooms_updated_at before update on rooms
  for each row execute function set_updated_at();

alter table rooms enable row level security;
alter table checklist_items enable row level security;
alter table internal_notes enable row level security;
alter table follow_ups enable row level security;

-- No Data API policies or grants are added. These private operational tables are
-- reached only through the server-side application role, matching 0001_core.sql.

-- Recovered prototype content included placeholder reviews and unverified trust
-- language. Keep the records for provenance, but never publish them as proof.
update reviews set published = false where source = 'placeholder';
update faqs set answer = 'Cleaner screening and company credentials are being finalized. An operator will share the current verified details before service.'
  where question = 'Are cleaners background-checked?';
update faqs set answer = 'The service policy is being finalized. Any follow-up or make-right terms will be confirmed with the written service scope.'
  where question = 'What is the guarantee?';
update faqs set answer = 'The online flow creates a service request with property details, preferences, and preferred timing. An operator confirms scope, availability, and final pricing before an appointment is scheduled.'
  where question = 'Can I schedule online?';

-- Premium operating model ----------------------------------------------------
-- These are service categories, not availability, pricing, credential, or
-- capacity claims. Each request still requires qualification and a proposal.

insert into services
  (id, title, icon, blurb, price_label, starting_price_cents, tags, bookable, sort, active)
values
  ('estate', 'Estate Care', '✦', 'Detail-led care plans for large and finish-sensitive residences.', 'Custom proposal', null, array['Private residence', 'Finish plan'], true, 1, true),
  ('construction', 'Construction Final Clean', '◇', 'Readiness-gated cleaning plans for completed construction and renovation work.', 'Custom proposal', null, array['Readiness review', 'Site plan'], true, 2, true),
  ('marine', 'Marine Interior Care', '≈', 'Interior cleaning plans shaped around vessel access, materials, and marina timing.', 'Custom proposal', null, array['Interior only', 'Access plan'], true, 3, true),
  ('commercial', 'Commercial Care', '▦', 'Recurring or project cleaning plans for select business environments.', 'Custom proposal', null, array['Scope review', 'Service window'], true, 4, true)
on conflict (id) do update set
  title = excluded.title,
  icon = excluded.icon,
  blurb = excluded.blurb,
  price_label = excluded.price_label,
  starting_price_cents = excluded.starting_price_cents,
  tags = excluded.tags,
  bookable = excluded.bookable,
  sort = excluded.sort,
  active = excluded.active;

update services
set bookable = false, active = false
where id in ('essential', 'deep', 'move', 'rental');

create table service_territories (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9][a-z0-9_-]{1,49}$'),
  name text not null,
  timezone text not null default 'America/Los_Angeles',
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused')),
  travel_buffer_minutes integer not null default 30
    check (travel_buffer_minutes between 0 and 180),
  qualification_notes text,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table territory_postal_codes (
  territory_id uuid not null references service_territories(id) on delete cascade,
  postal_code text not null check (char_length(postal_code) between 3 and 12),
  status text not null default 'review'
    check (status in ('review', 'active', 'excluded')),
  evidence_note text,
  created_at timestamptz not null default now(),
  primary key (territory_id, postal_code)
);

alter table bookings
  add column service_vertical text
    check (service_vertical in ('estate', 'construction', 'marine', 'commercial')),
  add column territory_id uuid references service_territories(id),
  add column qualification_status text not null default 'requested'
    check (qualification_status in (
      'requested', 'needs_information', 'walkthrough_needed',
      'proposal_sent', 'approved', 'declined'
    )),
  add column estimated_duration_minutes integer
    check (estimated_duration_minutes between 30 and 1440),
  add column required_crew_size integer not null default 1
    check (required_crew_size between 1 and 20),
  add column required_skills text[] not null default '{}',
  add column qualification_requirements jsonb not null default '{}',
  add column request_source text not null default 'web_booking'
    check (request_source in ('web_booking', 'operator', 'customer', 'referral', 'import', 'runtime_smoke')),
  add column idempotency_key text unique
    check (idempotency_key is null or idempotency_key ~ '^[0-9a-f]{64}$'),
  add column public_reference_token_hash text unique
    check (public_reference_token_hash is null or public_reference_token_hash ~ '^[0-9a-f]{64}$'),
  add column consent_snapshot jsonb not null default '{}',
  add column consented_at timestamptz,
  add column consent_version text,
  add column consent_notice_date date,
  add constraint bookings_consent_pair_check check (
    (consented_at is null and consent_version is null)
    or (consented_at is not null and consent_version is not null)
  );

comment on column bookings.idempotency_key is
  'SHA-256 hex digest of the caller idempotency key; never store the original key.';
comment on column bookings.public_reference_token_hash is
  'SHA-256 hex digest of a guest self-service secret; the original token is returned once and never stored.';
comment on column bookings.consent_snapshot is
  'Exact application-supplied consent labels and policy references shown at intake; no legal version is fabricated by the database.';

create table cleaners (
  id uuid primary key default gen_random_uuid(),
  external_auth_id text unique,
  full_name text not null,
  email text,
  phone text,
  status text not null default 'onboarding'
    check (status in ('onboarding', 'active', 'paused', 'inactive')),
  engagement_type text not null default 'undetermined'
    check (engagement_type in ('undetermined', 'employee', 'contractor')),
  screening_status text not null default 'not_recorded'
    check (screening_status in ('not_recorded', 'pending', 'verified', 'expired')),
  screening_verified_at timestamptz,
  home_territory_id uuid references service_territories(id),
  skills text[] not null default '{}',
  vertical_experience text[] not null default '{}'
    check (vertical_experience <@ array['estate', 'construction', 'marine', 'commercial']::text[]),
  max_daily_minutes integer not null default 480
    check (max_daily_minutes between 60 and 960),
  max_weekly_minutes integer not null default 2400
    check (max_weekly_minutes between 60 and 6000),
  max_daily_jobs integer not null default 3
    check (max_daily_jobs between 1 and 12),
  travel_buffer_minutes integer not null default 30
    check (travel_buffer_minutes between 0 and 180),
  operator_notes text,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((screening_status = 'verified') = (screening_verified_at is not null))
);

create table cleaner_applications (
  id uuid primary key default gen_random_uuid(),
  public_reference text not null unique,
  idempotency_key text unique
    check (idempotency_key is null or idempotency_key ~ '^[0-9a-f]{64}$'),
  full_name text not null,
  email text not null,
  phone text,
  home_base text,
  transportation_confirmed boolean not null default false,
  service_interests text[] not null default '{}'
    check (service_interests <@ array['estate', 'construction', 'marine', 'commercial']::text[]),
  territory_interests text[] not null default '{}',
  availability_summary text,
  experience_summary text,
  status text not null default 'submitted'
    check (status in ('submitted', 'reviewing', 'interview', 'offer', 'onboarding', 'declined', 'withdrawn')),
  consent_snapshot jsonb not null default '{}',
  consented_at timestamptz,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table cleaner_applications is
  'Private talent intake. Do not store IDs, background reports, bank details, or other screening documents here.';
comment on column cleaner_applications.idempotency_key is
  'SHA-256 hex digest of the caller idempotency key; never store the original key.';

create table cleaning_teams (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  status text not null default 'active'
    check (status in ('active', 'paused', 'inactive')),
  territory_ids uuid[] not null default '{}',
  vertical_specialties text[] not null default '{}'
    check (vertical_specialties <@ array['estate', 'construction', 'marine', 'commercial']::text[]),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table cleaning_team_members (
  team_id uuid not null references cleaning_teams(id) on delete cascade,
  cleaner_id uuid not null references cleaners(id) on delete cascade,
  team_role text not null default 'member'
    check (team_role in ('lead', 'member', 'trainee')),
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  primary key (team_id, cleaner_id, effective_from),
  check (effective_to is null or effective_to >= effective_from)
);

create unique index cleaning_team_members_one_active_idx
  on cleaning_team_members (team_id, cleaner_id)
  where effective_to is null;

create table cleaner_availability_rules (
  id uuid primary key default gen_random_uuid(),
  cleaner_id uuid not null references cleaners(id) on delete cascade,
  territory_id uuid references service_territories(id),
  day_of_week integer not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  effective_from date not null default current_date,
  effective_to date,
  status text not null default 'active' check (status in ('active', 'paused')),
  created_at timestamptz not null default now(),
  check (end_time > start_time),
  check (effective_to is null or effective_to >= effective_from)
);

create table cleaner_time_off (
  id uuid primary key default gen_random_uuid(),
  cleaner_id uuid not null references cleaners(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'declined', 'canceled')),
  reason_category text not null default 'unavailable'
    check (reason_category in ('unavailable', 'personal', 'medical', 'training', 'other')),
  private_note text,
  reviewed_by_label text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);

create table job_schedules (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings(id) on delete cascade,
  territory_id uuid not null references service_territories(id),
  service_vertical text not null
    check (service_vertical in ('estate', 'construction', 'marine', 'commercial')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'tentative'
    check (status in ('tentative', 'held', 'confirmed', 'en_route', 'in_progress', 'quality_review', 'completed', 'canceled')),
  required_crew_size integer not null default 1
    check (required_crew_size between 1 and 20),
  required_skills text[] not null default '{}',
  labor_minutes integer not null check (labor_minutes between 30 and 2400),
  travel_buffer_minutes integer not null default 30
    check (travel_buffer_minutes between 0 and 180),
  version integer not null default 1 check (version > 0),
  created_by_label text not null default 'Operator',
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);

create table job_assignments (
  id uuid primary key default gen_random_uuid(),
  job_schedule_id uuid not null references job_schedules(id) on delete cascade,
  cleaner_id uuid not null references cleaners(id),
  team_id uuid references cleaning_teams(id),
  assignment_role text not null default 'member'
    check (assignment_role in ('lead', 'member', 'quality_reviewer')),
  status text not null default 'proposed'
    check (status in ('proposed', 'accepted', 'confirmed', 'declined', 'removed')),
  suggestion_score integer check (suggestion_score between 0 and 100),
  suggestion_reasons jsonb not null default '[]',
  assigned_by_label text not null default 'Operator',
  assigned_at timestamptz not null default now(),
  responded_at timestamptz,
  is_dev_seed boolean not null default false,
  unique (job_schedule_id, cleaner_id)
);

create table service_cases (
  id uuid primary key default gen_random_uuid(),
  public_reference text not null unique,
  idempotency_key text unique
    check (idempotency_key is null or idempotency_key ~ '^[0-9a-f]{64}$'),
  case_type text not null
    check (case_type in ('reschedule', 'cancel', 'complaint', 'reclean', 'refund_review', 'damage', 'other')),
  booking_id uuid references bookings(id),
  booking_reference_input text,
  customer_id uuid references customers(id),
  contact jsonb not null default '{}',
  details text not null check (char_length(details) between 1 and 6000),
  preferred_date date,
  alternate_date date,
  status text not null default 'submitted'
    check (status in ('submitted', 'triaged', 'awaiting_customer', 'investigating', 'action_planned', 'reclean_scheduled', 'refund_pending', 'resolved', 'closed', 'declined', 'canceled')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  resolution_type text
    check (resolution_type is null or resolution_type in ('rescheduled', 'canceled', 'reclean', 'credit', 'refund', 'information_only', 'no_action')),
  resolution_summary text,
  assigned_cleaner_id uuid references cleaners(id),
  assigned_team_id uuid references cleaning_teams(id),
  consent_snapshot jsonb not null default '{}',
  consented_at timestamptz,
  first_response_due_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column service_cases.idempotency_key is
  'SHA-256 hex digest of the caller idempotency key; never store the original key.';

create table service_case_events (
  id bigint generated always as identity primary key,
  service_case_id uuid not null references service_cases(id) on delete cascade,
  event_type text not null,
  from_status text,
  to_status text,
  actor_label text not null default 'System',
  event_data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table service_recovery_actions (
  id uuid primary key default gen_random_uuid(),
  service_case_id uuid not null references service_cases(id) on delete cascade,
  booking_id uuid references bookings(id),
  action_type text not null
    check (action_type in ('reclean', 'site_visit', 'apology', 'credit_review', 'refund_review', 'crew_coaching', 'documentation', 'other')),
  status text not null default 'planned'
    check (status in ('planned', 'approved', 'scheduled', 'completed', 'canceled')),
  scheduled_at timestamptz,
  completed_at timestamptz,
  value_cents integer check (value_cents is null or value_cents >= 0),
  notes text,
  approved_by_label text,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table refund_records (
  id uuid primary key default gen_random_uuid(),
  service_case_id uuid references service_cases(id),
  booking_id uuid not null references bookings(id),
  billing_record_id uuid references billing_records(id),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'usd' check (currency = 'usd'),
  reason_code text not null,
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'declined', 'ready_for_manual_processing', 'processed', 'failed', 'canceled')),
  provider text not null default 'manual' check (provider in ('manual', 'stripe')),
  provider_refund_id text unique,
  requested_by_label text not null,
  approved_by_label text,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  processed_at timestamptz,
  failure_code text,
  operator_note text,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table refund_records is
  'Refund decisions and processing receipts only. Creating a row never calls a payment provider or moves money.';

create table notification_outbox (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references bookings(id) on delete cascade,
  customer_id uuid references customers(id),
  service_case_id uuid references service_cases(id),
  notification_type text not null
    check (notification_type in ('booking_received', 'customer_confirmation', 'ops_notification', 'schedule_change', 'service_recovery', 'refund_update', 'cleaner_assignment')),
  channel text not null check (channel in ('email', 'sms', 'manual')),
  recipient_kind text not null check (recipient_kind in ('customer', 'ops', 'cleaner')),
  recipient_address text,
  template_key text not null,
  template_data jsonb not null default '{}',
  deduplication_key text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'retry', 'failed', 'canceled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  sent_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (booking_id is not null or customer_id is not null or service_case_id is not null)
);

create table request_rate_limits (
  scope text not null,
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  window_seconds integer not null check (window_seconds between 1 and 86400),
  request_count integer not null default 1 check (request_count >= 0),
  blocked_until timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (scope, key_hash, window_start),
  check (expires_at > window_start)
);

comment on table request_rate_limits is
  'Fixed-window counters keyed by a server-side SHA-256 digest. Raw IP addresses and raw client identifiers must never be stored.';

create table stripe_event_receipts (
  event_id text primary key,
  event_type text not null,
  livemode boolean not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'received'
    check (status in ('received', 'processing', 'processed', 'ignored', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  processed_at timestamptz,
  last_error_code text,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table stripe_event_receipts is
  'Webhook idempotency receipts only. Do not store raw webhook payloads or provider secrets.';

create table operations_state_events (
  id bigint generated always as identity primary key,
  entity_type text not null,
  entity_id uuid not null,
  booking_id uuid references bookings(id) on delete set null,
  service_case_id uuid references service_cases(id) on delete set null,
  field_name text not null,
  from_state text,
  to_state text,
  actor_role text not null default current_user,
  event_data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index service_territories_status_idx on service_territories (status, name);
create index territory_postal_codes_lookup_idx on territory_postal_codes (postal_code, status);
create index bookings_territory_schedule_idx on bookings (territory_id, scheduled_date, status);
create index bookings_qualification_idx on bookings (qualification_status, created_at);
create index cleaners_status_territory_idx on cleaners (status, home_territory_id);
create index cleaner_applications_queue_idx on cleaner_applications (status, created_at);
create index cleaning_team_members_cleaner_idx on cleaning_team_members (cleaner_id, effective_to);
create index cleaner_availability_lookup_idx on cleaner_availability_rules (cleaner_id, day_of_week, status);
create index cleaner_time_off_lookup_idx on cleaner_time_off (cleaner_id, status, start_at, end_at);
create index job_schedules_time_idx on job_schedules (territory_id, status, start_at, end_at);
create index job_assignments_cleaner_idx on job_assignments (cleaner_id, status, job_schedule_id);
create index service_cases_queue_idx on service_cases (status, priority, created_at);
create index service_cases_booking_idx on service_cases (booking_id, created_at);
create index service_case_events_case_idx on service_case_events (service_case_id, created_at);
create index service_recovery_case_idx on service_recovery_actions (service_case_id, status, scheduled_at);
create index refund_records_queue_idx on refund_records (status, created_at);
create index refund_records_booking_idx on refund_records (booking_id, created_at);
create unique index billing_records_payment_intent_unique_idx
  on billing_records (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;
create unique index billing_records_invoice_unique_idx
  on billing_records (stripe_invoice_id)
  where stripe_invoice_id is not null;
create index notification_outbox_queue_idx on notification_outbox (status, next_attempt_at, created_at)
  where status in ('pending', 'retry');
create index request_rate_limits_expiry_idx on request_rate_limits (expires_at);
create index operations_state_entity_idx on operations_state_events (entity_type, entity_id, created_at);
create index operations_state_booking_idx on operations_state_events (booking_id, created_at)
  where booking_id is not null;

create trigger service_territories_updated_at before update on service_territories
  for each row execute function set_updated_at();
create trigger cleaners_updated_at before update on cleaners
  for each row execute function set_updated_at();
create trigger cleaner_applications_updated_at before update on cleaner_applications
  for each row execute function set_updated_at();
create trigger cleaning_teams_updated_at before update on cleaning_teams
  for each row execute function set_updated_at();
create trigger cleaner_time_off_updated_at before update on cleaner_time_off
  for each row execute function set_updated_at();
create trigger job_schedules_updated_at before update on job_schedules
  for each row execute function set_updated_at();
create trigger service_cases_updated_at before update on service_cases
  for each row execute function set_updated_at();
create trigger service_recovery_actions_updated_at before update on service_recovery_actions
  for each row execute function set_updated_at();
create trigger refund_records_updated_at before update on refund_records
  for each row execute function set_updated_at();
create trigger notification_outbox_updated_at before update on notification_outbox
  for each row execute function set_updated_at();
create trigger request_rate_limits_updated_at before update on request_rate_limits
  for each row execute function set_updated_at();
create trigger stripe_event_receipts_updated_at before update on stripe_event_receipts
  for each row execute function set_updated_at();

create function validate_job_schedule_readiness() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  booking_qualification text;
  booking_vertical text;
  assigned_cleaner record;
begin
  select qualification_status, service_vertical into booking_qualification, booking_vertical
    from bookings
    where id = new.booking_id;

  if booking_vertical is not null and booking_vertical is distinct from new.service_vertical then
    raise exception 'Schedule vertical % does not match booking vertical %', new.service_vertical, booking_vertical
      using errcode = '23514';
  end if;

  if new.status in ('confirmed', 'en_route', 'in_progress', 'quality_review', 'completed') then
    if booking_qualification is distinct from 'approved' then
      raise exception 'Booking % must be qualification-approved before schedule confirmation', new.booking_id
        using errcode = '23514';
    end if;
  end if;

  for assigned_cleaner in
    select a.id as assignment_id, a.cleaner_id
    from job_assignments a
    where a.job_schedule_id = new.id
      and a.status in ('accepted', 'confirmed')
  loop
    perform pg_advisory_xact_lock(hashtextextended(assigned_cleaner.cleaner_id::text, 0));

    if exists (
      select 1 from cleaner_time_off t
      where t.cleaner_id = assigned_cleaner.cleaner_id
        and t.status = 'approved'
        and t.start_at < new.end_at
        and t.end_at > new.start_at
    ) then
      raise exception 'Reschedule conflicts with approved time off for cleaner %', assigned_cleaner.cleaner_id
        using errcode = '23P01';
    end if;

    if exists (
      select 1
      from job_assignments a
      join job_schedules s on s.id = a.job_schedule_id
      where a.cleaner_id = assigned_cleaner.cleaner_id
        and a.id <> assigned_cleaner.assignment_id
        and a.status in ('accepted', 'confirmed')
        and s.status not in ('completed', 'canceled')
        and s.start_at < new.end_at + make_interval(mins => new.travel_buffer_minutes)
        and s.end_at + make_interval(mins => s.travel_buffer_minutes) > new.start_at
    ) then
      raise exception 'Reschedule overlaps another assignment for cleaner %', assigned_cleaner.cleaner_id
        using errcode = '23P01';
    end if;
  end loop;
  return new;
end
$$;

create trigger job_schedules_readiness_guard
before insert or update on job_schedules
for each row execute function validate_job_schedule_readiness();

create function validate_job_assignment_capacity() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  requested_start timestamptz;
  requested_end timestamptz;
  cleaner_state text;
begin
  if new.status not in ('accepted', 'confirmed') then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.cleaner_id::text, 0));

  select status into cleaner_state from cleaners where id = new.cleaner_id;
  if cleaner_state is distinct from 'active' then
    raise exception 'Cleaner % is not active', new.cleaner_id using errcode = '23514';
  end if;

  select start_at, end_at into requested_start, requested_end
  from job_schedules
  where id = new.job_schedule_id;

  if exists (
    select 1 from cleaner_time_off t
    where t.cleaner_id = new.cleaner_id
      and t.status = 'approved'
      and t.start_at < requested_end
      and t.end_at > requested_start
  ) then
    raise exception 'Cleaner % has approved time off during this job', new.cleaner_id
      using errcode = '23P01';
  end if;

  if exists (
    select 1
    from job_assignments a
    join job_schedules s on s.id = a.job_schedule_id
    where a.cleaner_id = new.cleaner_id
      and a.id <> new.id
      and a.status in ('accepted', 'confirmed')
      and s.status not in ('completed', 'canceled')
      and s.start_at < requested_end + make_interval(mins => s.travel_buffer_minutes)
      and s.end_at + make_interval(mins => s.travel_buffer_minutes) > requested_start
  ) then
    raise exception 'Cleaner % has an overlapping assignment or travel buffer', new.cleaner_id
      using errcode = '23P01';
  end if;

  return new;
end
$$;

create trigger job_assignments_capacity_guard
before insert or update of status, cleaner_id, job_schedule_id on job_assignments
for each row execute function validate_job_assignment_capacity();

-- Immutable, automatic lifecycle evidence. These trigger functions are
-- SECURITY INVOKER (the Postgres default) and therefore do not bypass RLS.

create function record_service_case_lifecycle() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into service_case_events
      (service_case_id, event_type, from_status, to_status, actor_label, event_data)
    values
      (new.id, 'case_submitted', null, new.status, current_user, jsonb_build_object('caseType', new.case_type));
  elsif old.status is distinct from new.status then
    insert into service_case_events
      (service_case_id, event_type, from_status, to_status, actor_label)
    values
      (new.id, 'status_changed', old.status, new.status, current_user);
  end if;
  return new;
end
$$;

create trigger service_cases_lifecycle_event
after insert or update of status on service_cases
for each row execute function record_service_case_lifecycle();

create function record_operations_state_change() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  old_state text;
  new_state text;
  booking_ref uuid;
  case_ref uuid;
begin
  old_state := to_jsonb(old) ->> tg_argv[0];
  new_state := to_jsonb(new) ->> tg_argv[0];
  if old_state is not distinct from new_state then
    return new;
  end if;

  booking_ref := case
    when tg_table_name = 'bookings' then new.id
    else nullif(to_jsonb(new) ->> 'booking_id', '')::uuid
  end;
  case_ref := case
    when tg_table_name = 'service_cases' then new.id
    else nullif(to_jsonb(new) ->> 'service_case_id', '')::uuid
  end;

  insert into operations_state_events
    (entity_type, entity_id, booking_id, service_case_id, field_name, from_state, to_state)
  values
    (tg_table_name, new.id, booking_ref, case_ref, tg_argv[0], old_state, new_state);
  return new;
end
$$;

create trigger bookings_status_audit
after update of status on bookings
for each row execute function record_operations_state_change('status');
create trigger bookings_qualification_audit
after update of qualification_status on bookings
for each row execute function record_operations_state_change('qualification_status');
create trigger cleaner_applications_status_audit
after update of status on cleaner_applications
for each row execute function record_operations_state_change('status');
create trigger job_schedules_status_audit
after update of status on job_schedules
for each row execute function record_operations_state_change('status');
create trigger job_assignments_status_audit
after update of status on job_assignments
for each row execute function record_operations_state_change('status');
create trigger service_cases_status_audit
after update of status on service_cases
for each row execute function record_operations_state_change('status');
create trigger service_recovery_status_audit
after update of status on service_recovery_actions
for each row execute function record_operations_state_change('status');
create trigger refund_records_status_audit
after update of status on refund_records
for each row execute function record_operations_state_change('status');
create trigger notification_outbox_status_audit
after update of status on notification_outbox
for each row execute function record_operations_state_change('status');

create function reject_immutable_event_mutation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '55000';
end
$$;

create trigger service_case_events_immutable
before update or delete on service_case_events
for each row execute function reject_immutable_event_mutation();
create trigger operations_state_events_immutable
before update or delete on operations_state_events
for each row execute function reject_immutable_event_mutation();

-- The direct server role is intentionally a non-owner, non-superuser role and
-- never bypasses RLS. Existing LOGIN/password settings are left untouched.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'lakeandpine_app') then
    create role lakeandpine_app nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
  end if;
end
$$;

alter role lakeandpine_app nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
grant usage on schema public to lakeandpine_app;

alter table service_territories enable row level security;
alter table territory_postal_codes enable row level security;
alter table cleaners enable row level security;
alter table cleaner_applications enable row level security;
alter table cleaning_teams enable row level security;
alter table cleaning_team_members enable row level security;
alter table cleaner_availability_rules enable row level security;
alter table cleaner_time_off enable row level security;
alter table job_schedules enable row level security;
alter table job_assignments enable row level security;
alter table service_cases enable row level security;
alter table service_case_events enable row level security;
alter table service_recovery_actions enable row level security;
alter table refund_records enable row level security;
alter table notification_outbox enable row level security;
alter table request_rate_limits enable row level security;
alter table stripe_event_receipts enable row level security;
alter table operations_state_events enable row level security;

-- No table is accessible through implicit PUBLIC privileges. Public content
-- remains governed by its explicit anon/auth grants outside this private role.
revoke all on all tables in schema public from public;
revoke all on all sequences in schema public from public;

do $$
declare
  private_table text;
  private_tables constant text[] := array[
    'customers', 'homes', 'quotes', 'leads', 'bookings', 'booking_events',
    'billing_records', 'support_messages', 'rooms', 'checklist_items',
    'internal_notes', 'follow_ups', 'service_territories',
    'territory_postal_codes', 'cleaners', 'cleaner_applications',
    'cleaning_teams', 'cleaning_team_members', 'cleaner_availability_rules',
    'cleaner_time_off', 'job_schedules', 'job_assignments', 'service_cases',
    'service_case_events', 'service_recovery_actions', 'refund_records',
    'notification_outbox', 'request_rate_limits', 'stripe_event_receipts',
    'operations_state_events'
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

    execute format('drop policy if exists %I on public.%I', 'lakeandpine_app_all_' || private_table, private_table);
    execute format(
      'create policy %I on public.%I for all to lakeandpine_app using (true) with check (true)',
      'lakeandpine_app_all_' || private_table,
      private_table
    );
  end loop;
end
$$;

grant select on services, addons, plans, service_areas, faqs, reviews to lakeandpine_app;
grant usage, select on all sequences in schema public to lakeandpine_app;

alter default privileges in schema public revoke all on tables from public;
alter default privileges in schema public revoke all on sequences from public;
alter default privileges in schema public grant select, insert, update, delete on tables to lakeandpine_app;
alter default privileges in schema public grant usage, select on sequences to lakeandpine_app;

comment on table operations_state_events is
  'Append-only status-transition evidence. Event data must exclude private contact details and provider secrets.';

comment on table notification_outbox is
  'Durable transactional-notification work. Request persistence never depends on immediate provider delivery.';
