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

update service_areas set
  seo_phrase = 'Premium property cleaning planning in ' || city,
  headline = 'Reviewed Premium Property Care Planning in ' || city,
  intro = city || ' is inside Lake & Pine''s planning corridor for private estate, completed construction, marine interior, and select commercial requests. Exact coverage depends on property scope, safe access, travel, qualified crew, and the requested window; a city listing is not a capacity promise.',
  highlights = jsonb_build_array(
    jsonb_build_object('title', 'Property + program fit', 'body', 'The operator reviews the property type, scale, condition, specialty finishes, access, and requested outcome.'),
    jsonb_build_object('title', 'Qualified crew capacity', 'body', 'Skills, program experience, availability, time off, workload, duration, and travel buffers are checked before confirmation.'),
    jsonb_build_object('title', 'Honest scheduling', 'body', 'Preferred dates remain preferences until scope, territory, and a feasible crew plan are confirmed.')
  ),
  faqs = jsonb_build_array(
    jsonb_build_array('Is this a confirmed service area?', 'It is a planning area. Exact coverage and timing require property, route, and capacity review.'),
    jsonb_build_array('Can I reserve a date here?', 'No. Submit a preferred date and alternate; an operator confirms a feasible window after review.'),
    jsonb_build_array('What should I share first?', 'Share the program, general location, property scale, priorities, and timing. Do not send access codes or payment details in the public form.')
  )
where slug in ('coeur-dalene', 'spokane', 'post-falls', 'hayden', 'liberty-lake', 'spokane-valley', 'rathdrum');

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
  'SHA-256 hex digest of a guest self-service reference derived by the server from the booking ID; the reference is never stored.';
comment on column bookings.consent_snapshot is
  'Server-owned policy identifiers plus the exact consent labels shown at intake.';

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
  is_dev_seed boolean not null default false,
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
  is_dev_seed boolean not null default false,
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
  owner_label text not null default 'Operator'
    check (char_length(owner_label) between 1 and 120),
  scheduled_at timestamptz not null,
  completed_at timestamptz,
  value_cents integer check (value_cents is null or value_cents >= 0),
  notes text,
  approved_by_label text,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status not in ('scheduled', 'completed') or scheduled_at is not null),
  check (status not in ('approved', 'scheduled', 'completed') or approved_by_label is not null),
  check ((status = 'completed') = (completed_at is not null))
);

create table refund_records (
  id uuid primary key default gen_random_uuid(),
  service_case_id uuid not null references service_cases(id),
  booking_id uuid not null references bookings(id),
  billing_record_id uuid not null references billing_records(id),
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
  is_dev_seed boolean not null default false,
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
  is_dev_seed boolean not null default false,
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
create unique index refund_records_one_active_case_idx
  on refund_records (service_case_id)
  where status not in ('declined', 'failed', 'canceled');
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

create function validate_recovery_status_transition() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status = old.status then return new; end if;
  if not (
    (old.status = 'planned' and new.status in ('approved', 'canceled'))
    or (old.status = 'approved' and new.status in ('scheduled', 'completed', 'canceled'))
    or (old.status = 'scheduled' and new.status in ('completed', 'approved', 'canceled'))
  ) then
    raise exception 'Invalid recovery transition from % to %', old.status, new.status
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger service_recovery_transition_guard
before update of status on service_recovery_actions
for each row execute function validate_recovery_status_transition();

create function assert_service_case_recovery_consistency(
  service_case_to_validate uuid,
  service_case_status text
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if service_case_status = 'reclean_scheduled' and not exists (
    select 1 from service_recovery_actions recovery
    where recovery.service_case_id = service_case_to_validate
      and recovery.action_type = 'reclean'
      and recovery.status in ('scheduled', 'completed')
  ) then
    raise exception 'Service case % needs a scheduled reclean recovery action', service_case_to_validate
      using errcode = '23514';
  end if;
  if service_case_status in ('resolved', 'closed') and exists (
    select 1 from service_recovery_actions recovery
    where recovery.service_case_id = service_case_to_validate
      and recovery.status in ('planned', 'approved', 'scheduled')
  ) then
    raise exception 'Service case % has unfinished recovery actions', service_case_to_validate
      using errcode = '23514';
  end if;
end
$$;

revoke all on function assert_service_case_recovery_consistency(uuid, text) from public;

create function validate_service_case_recovery_state() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform assert_service_case_recovery_consistency(new.id, new.status);
  return new;
end
$$;

create trigger service_cases_recovery_consistency_guard
before insert or update of status on service_cases
for each row execute function validate_service_case_recovery_state();

create function revalidate_service_case_after_recovery_mutation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  affected_case uuid;
  affected_status text;
begin
  for affected_case in
    select distinct service_case_id
    from (values
      (case when tg_op <> 'INSERT' then old.service_case_id else null end),
      (case when tg_op <> 'DELETE' then new.service_case_id else null end)
    ) cases(service_case_id)
    where service_case_id is not null
  loop
    select status into affected_status from service_cases where id = affected_case;
    if affected_status is not null then
      perform assert_service_case_recovery_consistency(affected_case, affected_status);
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; else return new; end if;
end
$$;

create trigger service_recovery_case_consistency_guard
after insert or update of status, action_type, service_case_id or delete
on service_recovery_actions
for each row execute function revalidate_service_case_after_recovery_mutation();

-- The current launch market is US-only. Service eligibility compares the first
-- five digits while accepting common ZIP+4 formatting at intake.
create function normalize_us_postal_code(raw_postal_code text) returns text
language sql
immutable
strict
parallel safe
as $$
  select substring(trim(raw_postal_code) from '^([0-9]{5})(-[0-9]{4})?$')
$$;

revoke all on function normalize_us_postal_code(text) from public;

alter table territory_postal_codes
  add constraint territory_postal_codes_us_format_check
  check (postal_code ~ '^[0-9]{5}(-[0-9]{4})?$');

create function validate_territory_activation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then
    return new;
  end if;
  if not exists (
    select 1 from territory_postal_codes postal
    where postal.territory_id = new.id and postal.status = 'active'
  ) then
    raise exception 'Territory % needs an active postal code before activation', new.id
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from cleaners cleaner
    where cleaner.home_territory_id = new.id
      and cleaner.status = 'active'
      and cleaner.screening_status = 'verified'
      and exists (
        select 1 from cleaner_availability_rules availability
        where availability.cleaner_id = cleaner.id
          and availability.status = 'active'
          and (availability.territory_id is null or availability.territory_id = new.id)
      )
  ) then
    raise exception 'Territory % needs a screened, available cleaner before activation', new.id
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger service_territories_activation_guard
before insert or update of status on service_territories
for each row execute function validate_territory_activation();

create function guard_active_territory_postal_capacity() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if old.status <> 'active' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'UPDATE'
     and new.territory_id = old.territory_id
     and new.status = 'active' then
    return new;
  end if;
  if exists (
    select 1 from service_territories territory
    where territory.id = old.territory_id and territory.status = 'active'
  ) and not exists (
    select 1 from territory_postal_codes postal
    where postal.territory_id = old.territory_id
      and postal.status = 'active'
      and postal.postal_code <> old.postal_code
  ) then
    raise exception 'Active territory % must retain an active postal code', old.territory_id
      using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end
$$;

create trigger territory_postal_codes_capacity_guard
before update or delete on territory_postal_codes
for each row execute function guard_active_territory_postal_capacity();

create function pause_territory_without_cleaner_capacity(territory_to_check uuid) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if territory_to_check is null then
    return;
  end if;
  update service_territories territory
  set status = 'paused'
  where territory.id = territory_to_check
    and territory.status = 'active'
    and not exists (
      select 1
      from cleaners cleaner
      where cleaner.home_territory_id = territory.id
        and cleaner.status = 'active'
        and cleaner.screening_status = 'verified'
        and exists (
          select 1 from cleaner_availability_rules availability
          where availability.cleaner_id = cleaner.id
            and availability.status = 'active'
            and (availability.territory_id is null or availability.territory_id = territory.id)
        )
    );
end
$$;

revoke all on function pause_territory_without_cleaner_capacity(uuid) from public;

create function assert_cleaner_schedule_capacity(
  requested_cleaner_id uuid,
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
  cleaner_state text;
  cleaner_screening_state text;
  cleaner_home_territory uuid;
  cleaner_daily_minutes integer;
  cleaner_weekly_minutes integer;
  cleaner_daily_jobs integer;
  territory_timezone text;
  local_start timestamp;
  local_end timestamp;
  day_start_at timestamptz;
  day_end_at timestamptz;
  week_start_at timestamptz;
  week_end_at timestamptz;
  requested_minutes integer;
  used_daily_minutes integer;
  used_weekly_minutes integer;
  used_daily_jobs integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(requested_cleaner_id::text, 0));

  select c.status, c.screening_status, c.home_territory_id,
         c.max_daily_minutes, c.max_weekly_minutes, c.max_daily_jobs,
         t.timezone
    into cleaner_state, cleaner_screening_state, cleaner_home_territory,
         cleaner_daily_minutes, cleaner_weekly_minutes,
         cleaner_daily_jobs, territory_timezone
  from cleaners c
  join service_territories t on t.id = requested_territory_id
  where c.id = requested_cleaner_id;

  if cleaner_state is distinct from 'active' then
    raise exception 'Cleaner % is not active', requested_cleaner_id using errcode = '23514';
  end if;
  if cleaner_screening_state is distinct from 'verified' then
    raise exception 'Cleaner % does not have verified screening', requested_cleaner_id
      using errcode = '23514';
  end if;
  if cleaner_home_territory is distinct from requested_territory_id then
    raise exception 'Cleaner % is not assigned to schedule territory %', requested_cleaner_id, requested_territory_id
      using errcode = '23514';
  end if;

  local_start := requested_start at time zone territory_timezone;
  local_end := requested_end at time zone territory_timezone;
  if local_start::date is distinct from local_end::date then
    raise exception 'Cleaner assignments must fit within one local availability day'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from cleaner_availability_rules availability
    where availability.cleaner_id = requested_cleaner_id
      and availability.status = 'active'
      and (availability.territory_id is null or availability.territory_id = requested_territory_id)
      and availability.day_of_week = extract(dow from local_start)::integer
      and availability.effective_from <= local_start::date
      and (availability.effective_to is null or availability.effective_to >= local_start::date)
      and availability.start_time <= local_start::time
      and availability.end_time >= local_end::time
  ) then
    raise exception 'Cleaner % is outside recurring availability for this territory', requested_cleaner_id
      using errcode = '23514';
  end if;

  if exists (
    select 1 from cleaner_time_off time_off
    where time_off.cleaner_id = requested_cleaner_id
      and time_off.status = 'approved'
      and time_off.start_at < requested_end
      and time_off.end_at > requested_start
  ) then
    raise exception 'Cleaner % has approved time off during this job', requested_cleaner_id
      using errcode = '23P01';
  end if;

  if exists (
    select 1
    from job_assignments a
    join job_schedules s on s.id = a.job_schedule_id
    where a.cleaner_id = requested_cleaner_id
      and s.id <> requested_schedule_id
      and a.status in ('accepted', 'confirmed')
      and s.status <> 'canceled'
      and s.start_at < requested_end + make_interval(mins => requested_travel_buffer)
      and s.end_at + make_interval(mins => s.travel_buffer_minutes) > requested_start
  ) then
    raise exception 'Cleaner % has an overlapping assignment or travel buffer', requested_cleaner_id
      using errcode = '23P01';
  end if;

  requested_minutes := ceil(extract(epoch from (requested_end - requested_start)) / 60)::integer;
  day_start_at := local_start::date::timestamp at time zone territory_timezone;
  day_end_at := (local_start::date + 1)::timestamp at time zone territory_timezone;
  week_start_at := date_trunc('week', local_start) at time zone territory_timezone;
  week_end_at := (date_trunc('week', local_start) + interval '7 days') at time zone territory_timezone;

  select coalesce(sum(ceil(extract(epoch from
           (least(s.end_at, day_end_at) - greatest(s.start_at, day_start_at))) / 60)), 0)::integer,
         count(distinct s.id)::integer
    into used_daily_minutes, used_daily_jobs
  from job_assignments a
  join job_schedules s on s.id = a.job_schedule_id
  where a.cleaner_id = requested_cleaner_id
    and s.id <> requested_schedule_id
    and a.status in ('accepted', 'confirmed')
    and s.status <> 'canceled'
    and s.start_at < day_end_at and s.end_at > day_start_at;

  if used_daily_minutes + requested_minutes > cleaner_daily_minutes then
    raise exception 'Cleaner % would exceed daily minute capacity', requested_cleaner_id
      using errcode = '23514';
  end if;
  if used_daily_jobs + 1 > cleaner_daily_jobs then
    raise exception 'Cleaner % would exceed daily job capacity', requested_cleaner_id
      using errcode = '23514';
  end if;

  select coalesce(sum(ceil(extract(epoch from
           (least(s.end_at, week_end_at) - greatest(s.start_at, week_start_at))) / 60)), 0)::integer
    into used_weekly_minutes
  from job_assignments a
  join job_schedules s on s.id = a.job_schedule_id
  where a.cleaner_id = requested_cleaner_id
    and s.id <> requested_schedule_id
    and a.status in ('accepted', 'confirmed')
    and s.status <> 'canceled'
    and s.start_at < week_end_at and s.end_at > week_start_at;

  if used_weekly_minutes + requested_minutes > cleaner_weekly_minutes then
    raise exception 'Cleaner % would exceed weekly minute capacity', requested_cleaner_id
      using errcode = '23514';
  end if;
end
$$;

revoke all on function assert_cleaner_schedule_capacity(uuid, uuid, timestamptz, timestamptz, uuid, integer) from public;

create function validate_job_schedule_readiness() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  booking_qualification text;
  booking_vertical text;
  booking_postal text;
  territory_state text;
  assigned_cleaner record;
  accepted_count integer;
  accepted_skills text[];
  required_elapsed_minutes integer;
begin
  if new.status = 'canceled' then
    return new;
  end if;
  required_elapsed_minutes := ceil(new.labor_minutes::numeric / new.required_crew_size / 30) * 30;
  if extract(epoch from (new.end_at - new.start_at)) / 60 < required_elapsed_minutes then
    raise exception 'Schedule % needs at least % elapsed minutes for % labor minutes and % cleaners',
      new.id, required_elapsed_minutes, new.labor_minutes, new.required_crew_size
      using errcode = '23514';
  end if;

  select qualification_status, service_vertical, normalize_us_postal_code(contact ->> 'zip')
    into booking_qualification, booking_vertical, booking_postal
    from bookings where id = new.booking_id;
  select status into territory_state from service_territories where id = new.territory_id;

  if territory_state is distinct from 'active' then
    raise exception 'Schedule territory % must be active', new.territory_id
      using errcode = '23514';
  end if;

  if booking_postal is null or not exists (
    select 1 from territory_postal_codes postal
    where postal.territory_id = new.territory_id
      and postal.status = 'active'
      and normalize_us_postal_code(postal.postal_code) = booking_postal
  ) then
    raise exception 'Booking % postal code is not active in schedule territory %', new.booking_id, new.territory_id
      using errcode = '23514';
  end if;

  if booking_vertical is not null and booking_vertical is distinct from new.service_vertical then
    raise exception 'Schedule vertical % does not match booking vertical %', new.service_vertical, booking_vertical
      using errcode = '23514';
  end if;

  if new.status in ('confirmed', 'en_route', 'in_progress', 'quality_review', 'completed') then
    if booking_qualification is distinct from 'approved' then
      raise exception 'Booking % must be qualification-approved before schedule confirmation', new.booking_id
        using errcode = '23514';
    end if;
    select count(distinct a.cleaner_id)::integer,
           coalesce(array_agg(distinct skill) filter (where skill is not null), '{}')
      into accepted_count, accepted_skills
    from job_assignments a
    join cleaners c on c.id = a.cleaner_id
    left join lateral unnest(c.skills) skill on true
    where a.job_schedule_id = new.id and a.status in ('accepted', 'confirmed');
    if accepted_count <> new.required_crew_size then
      raise exception 'Schedule % needs exactly % accepted cleaners before confirmation; found %',
        new.id, new.required_crew_size, accepted_count using errcode = '23514';
    end if;
    if not new.required_skills <@ accepted_skills then
      raise exception 'Accepted crew for schedule % does not cover every required skill', new.id
        using errcode = '23514';
    end if;
  end if;

  for assigned_cleaner in
    select a.cleaner_id from job_assignments a
    where a.job_schedule_id = new.id and a.status in ('accepted', 'confirmed')
  loop
    perform assert_cleaner_schedule_capacity(
      assigned_cleaner.cleaner_id, new.id, new.start_at, new.end_at,
      new.territory_id, new.travel_buffer_minutes
    );
  end loop;
  return new;
end
$$;

create trigger job_schedules_readiness_guard
before insert or update on job_schedules
for each row execute function validate_job_schedule_readiness();

create function validate_premium_booking_confirmation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.service_vertical is not null
     and new.status in ('confirmed', 'scheduled', 'in_progress', 'completed', 'follow_up')
     and new.qualification_status is distinct from 'approved' then
    raise exception 'Premium booking % must be qualification-approved before confirmation', new.id
      using errcode = '23514';
  end if;
  if new.service_vertical is not null and new.status in ('confirmed', 'scheduled')
     and not exists (
       select 1 from job_schedules schedule
       where schedule.booking_id = new.id and schedule.status = 'confirmed'
     ) then
    raise exception 'Premium booking % requires a confirmed schedule and accepted crew', new.id
      using errcode = '23514';
  end if;
  if new.service_vertical is not null and new.status = 'in_progress'
     and not exists (
       select 1 from job_schedules schedule
       where schedule.booking_id = new.id
         and schedule.status in ('en_route', 'in_progress', 'quality_review')
     ) then
    raise exception 'Premium booking % cannot be in progress without an active schedule', new.id
      using errcode = '23514';
  end if;
  if new.service_vertical is not null and new.status in ('completed', 'follow_up')
     and not exists (
       select 1 from job_schedules schedule
       where schedule.booking_id = new.id and schedule.status = 'completed'
     ) then
    raise exception 'Premium booking % cannot be completed before its schedule', new.id
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger premium_booking_confirmation_guard
before insert or update of status, qualification_status on bookings
for each row execute function validate_premium_booking_confirmation();

create function validate_job_assignment_capacity() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
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

  select start_at, end_at, territory_id, travel_buffer_minutes, required_crew_size
    into requested_start, requested_end, requested_territory, requested_travel_buffer,
         requested_crew_size
  from job_schedules
  where id = new.job_schedule_id
  for update;
  if requested_start is null then
    raise exception 'Assignment schedule % does not exist', new.job_schedule_id
      using errcode = '23503';
  end if;

  select count(distinct assignment.cleaner_id)::integer
    into accepted_count
  from job_assignments assignment
  where assignment.job_schedule_id = new.job_schedule_id
    and assignment.status in ('accepted', 'confirmed')
    and assignment.id <> new.id;
  if accepted_count + 1 > requested_crew_size then
    raise exception 'Schedule % cannot accept more than % cleaners', new.job_schedule_id, requested_crew_size
      using errcode = '23514';
  end if;

  perform assert_cleaner_schedule_capacity(
    new.cleaner_id, new.job_schedule_id, requested_start, requested_end,
    requested_territory, requested_travel_buffer
  );

  return new;
end
$$;

create trigger job_assignments_capacity_guard
before insert or update of status, cleaner_id, job_schedule_id on job_assignments
for each row execute function validate_job_assignment_capacity();

create function revalidate_schedule_readiness(schedule_to_validate uuid) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- A no-op parent update runs the authoritative schedule readiness trigger
  -- against the post-mutation assignment/cleaner/availability state. Any failure
  -- rolls the originating mutation back in the same transaction.
  update job_schedules
  set version = version
  where id = schedule_to_validate
    and status in ('confirmed', 'en_route', 'in_progress', 'quality_review');
end
$$;

revoke all on function revalidate_schedule_readiness(uuid) from public;

create function revalidate_schedules_after_assignment_mutation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    perform revalidate_schedule_readiness(old.job_schedule_id);
    return old;
  end if;
  if tg_op = 'INSERT' then
    perform revalidate_schedule_readiness(new.job_schedule_id);
    return new;
  end if;
  perform revalidate_schedule_readiness(old.job_schedule_id);
  if new.job_schedule_id is distinct from old.job_schedule_id then
    perform revalidate_schedule_readiness(new.job_schedule_id);
  end if;
  return new;
end
$$;

create trigger job_assignments_parent_readiness_guard
after insert or update or delete on job_assignments
for each row execute function revalidate_schedules_after_assignment_mutation();

create function revalidate_schedules_after_cleaner_mutation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  assigned_schedule uuid;
begin
  for assigned_schedule in
    select distinct assignment.job_schedule_id
    from job_assignments assignment
    where assignment.cleaner_id = new.id
      and assignment.status in ('accepted', 'confirmed')
  loop
    perform revalidate_schedule_readiness(assigned_schedule);
  end loop;
  return new;
end
$$;

create trigger cleaners_assignment_readiness_guard
after update of status, screening_status, screening_verified_at, home_territory_id,
  skills, max_daily_minutes, max_weekly_minutes, max_daily_jobs
on cleaners for each row execute function revalidate_schedules_after_cleaner_mutation();

create function maintain_territory_after_cleaner_mutation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform pause_territory_without_cleaner_capacity(old.home_territory_id);
  if new.home_territory_id is distinct from old.home_territory_id then
    perform pause_territory_without_cleaner_capacity(new.home_territory_id);
  end if;
  return new;
end
$$;

-- Alphabetical ordering makes this run after the assignment-readiness guard.
-- Mutations that would strand live work fail; safe capacity loss pauses sales.
create trigger z_cleaners_territory_capacity_guard
after update of status, screening_status, screening_verified_at, home_territory_id
on cleaners for each row execute function maintain_territory_after_cleaner_mutation();

create function revalidate_schedules_after_availability_mutation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  affected_cleaner uuid;
  assigned_schedule uuid;
begin
  affected_cleaner := case when tg_op = 'DELETE' then old.cleaner_id else new.cleaner_id end;
  for assigned_schedule in
    select distinct assignment.job_schedule_id
    from job_assignments assignment
    where assignment.cleaner_id = affected_cleaner
      and assignment.status in ('accepted', 'confirmed')
  loop
    perform revalidate_schedule_readiness(assigned_schedule);
  end loop;
  if tg_op = 'UPDATE' and old.cleaner_id is distinct from new.cleaner_id then
    for assigned_schedule in
      select distinct assignment.job_schedule_id
      from job_assignments assignment
      where assignment.cleaner_id = old.cleaner_id
        and assignment.status in ('accepted', 'confirmed')
    loop
      perform revalidate_schedule_readiness(assigned_schedule);
    end loop;
  end if;
  perform pause_territory_without_cleaner_capacity((
    select cleaner.home_territory_id from cleaners cleaner
    where cleaner.id = affected_cleaner
  ));
  if tg_op = 'UPDATE' and old.cleaner_id is distinct from new.cleaner_id then
    perform pause_territory_without_cleaner_capacity((
      select cleaner.home_territory_id from cleaners cleaner
      where cleaner.id = old.cleaner_id
    ));
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end
$$;

create trigger cleaner_availability_parent_readiness_guard
after insert or update or delete on cleaner_availability_rules
for each row execute function revalidate_schedules_after_availability_mutation();

create function revalidate_schedules_after_territory_mutation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  affected_schedule uuid;
begin
  for affected_schedule in
    select schedule.id
    from job_schedules schedule
    where schedule.territory_id = new.id
      and schedule.status in ('confirmed', 'en_route', 'in_progress', 'quality_review')
  loop
    perform revalidate_schedule_readiness(affected_schedule);
  end loop;
  return new;
end
$$;

create trigger service_territories_schedule_readiness_guard
after update of status, timezone on service_territories
for each row execute function revalidate_schedules_after_territory_mutation();

create function revalidate_schedules_after_postal_mutation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  affected_territory uuid;
  affected_schedule uuid;
begin
  for affected_territory in
    select distinct territory_id
    from (values (old.territory_id),
      (case when tg_op = 'UPDATE' then new.territory_id else null end)) ids(territory_id)
    where territory_id is not null
  loop
    for affected_schedule in
      select schedule.id from job_schedules schedule
      where schedule.territory_id = affected_territory
        and schedule.status in ('confirmed', 'en_route', 'in_progress', 'quality_review')
    loop
      perform revalidate_schedule_readiness(affected_schedule);
    end loop;
  end loop;
  if tg_op = 'DELETE' then return old; else return new; end if;
end
$$;

create trigger territory_postal_codes_schedule_readiness_guard
after update or delete on territory_postal_codes
for each row execute function revalidate_schedules_after_postal_mutation();

create function validate_time_off_against_assignments() returns trigger
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
    where assignment.cleaner_id = new.cleaner_id
      and assignment.status in ('accepted', 'confirmed')
      and schedule.status <> 'canceled'
      and schedule.start_at < new.end_at
      and schedule.end_at > new.start_at
  ) then
    raise exception 'Approved time off conflicts with an accepted assignment for cleaner %', new.cleaner_id
      using errcode = '23P01';
  end if;
  return new;
end
$$;

create trigger cleaner_time_off_assignment_guard
before insert or update of status, cleaner_id, start_at, end_at on cleaner_time_off
for each row execute function validate_time_off_against_assignments();

create function synchronize_booking_from_schedule() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  synchronized_status text;
  event_type text;
begin
  synchronized_status := case
    when new.status in ('tentative', 'held') then 'ready'
    when new.status = 'confirmed' then 'scheduled'
    when new.status in ('en_route', 'in_progress', 'quality_review') then 'in_progress'
    when new.status = 'completed' then 'completed'
    when new.status = 'canceled' then 'canceled'
  end;

  update bookings booking
  set status = synchronized_status,
      territory_id = new.territory_id,
      scheduled_date = (new.start_at at time zone territory.timezone)::date,
      scheduled_window = case
        when new.status = 'canceled' then booking.scheduled_window
        else to_char(new.start_at at time zone territory.timezone, 'FMHH12:MI AM')
          || '–' || to_char(new.end_at at time zone territory.timezone, 'FMHH12:MI AM')
          || ' ' || territory.timezone
      end
  from service_territories territory
  where booking.id = new.booking_id and territory.id = new.territory_id;

  event_type := case
    when tg_op = 'INSERT' then 'schedule_created'
    when old.status is distinct from new.status then 'schedule_status_changed'
    else 'schedule_rescheduled'
  end;
  insert into booking_events (booking_id, type, data)
  values (
    new.booking_id,
    event_type,
    jsonb_build_object('scheduleId', new.id, 'scheduleStatus', new.status, 'bookingStatus', synchronized_status)
  );

  if new.status = 'completed' then
    insert into follow_ups (booking_id, kind, channel, status, scheduled_for, is_dev_seed)
    select new.booking_id, follow_up.kind, 'manual', 'planned', now() + follow_up.delay, booking.is_dev_seed
    from bookings booking
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

create trigger job_schedules_booking_sync
after insert or update of status, start_at, end_at, territory_id on job_schedules
for each row execute function synchronize_booking_from_schedule();

create function validate_refund_integrity() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  case_booking_id uuid;
  case_kind text;
  case_state text;
  billing_booking_id uuid;
  billing_amount integer;
  billing_state text;
  committed_amount integer;
begin
  select booking_id, case_type, status
    into case_booking_id, case_kind, case_state
  from service_cases where id = new.service_case_id for update;
  if case_booking_id is distinct from new.booking_id
     or case_kind not in ('refund_review', 'complaint', 'reclean', 'damage')
     or case_state <> 'refund_pending' then
    raise exception 'Refund requires a refund-eligible case in refund_pending for the same booking'
      using errcode = '23514';
  end if;

  select booking_id, amount_cents, status
    into billing_booking_id, billing_amount, billing_state
  from billing_records where id = new.billing_record_id for update;
  if billing_booking_id is distinct from new.booking_id or billing_state <> 'paid' then
    raise exception 'Refund requires a paid billing record for the same booking'
      using errcode = '23514';
  end if;

  select coalesce(sum(amount_cents), 0)::integer into committed_amount
  from refund_records
  where billing_record_id = new.billing_record_id
    and id <> new.id
    and status not in ('declined', 'failed', 'canceled');
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

create trigger refund_records_integrity_guard
before insert or update of service_case_id, booking_id, billing_record_id, amount_cents, status, provider_refund_id
on refund_records for each row execute function validate_refund_integrity();

create function synchronize_processed_refund() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  processed_total integer;
  billed_total integer;
begin
  if new.status = 'processed' and old.status is distinct from new.status then
    update service_cases
    set status = 'resolved', resolution_type = 'refund',
        resolution_summary = 'External refund receipt recorded; funds were returned outside this application.',
        resolved_at = now()
    where id = new.service_case_id and status = 'refund_pending';

    select coalesce(sum(amount_cents), 0)::integer into processed_total
    from refund_records
    where billing_record_id = new.billing_record_id and status = 'processed';
    select amount_cents into billed_total from billing_records where id = new.billing_record_id;
    if processed_total >= billed_total then
      update billing_records set status = 'refunded' where id = new.billing_record_id and status = 'paid';
    end if;
  end if;
  return new;
end
$$;

create trigger refund_records_case_sync
after update of status on refund_records
for each row execute function synchronize_processed_refund();

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
      (service_case_id, event_type, from_status, to_status, actor_label, event_data, is_dev_seed)
    values
      (new.id, 'case_submitted', null, new.status, current_user,
       jsonb_build_object('caseType', new.case_type), new.is_dev_seed);
  elsif old.status is distinct from new.status then
    insert into service_case_events
      (service_case_id, event_type, from_status, to_status, actor_label, is_dev_seed)
    values
      (new.id, 'status_changed', old.status, new.status, current_user, new.is_dev_seed);
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
    (entity_type, entity_id, booking_id, service_case_id, field_name, from_state, to_state, is_dev_seed)
  values
    (tg_table_name, new.id, booking_ref, case_ref, tg_argv[0], old_state, new_state,
     coalesce((to_jsonb(new) ->> 'is_dev_seed')::boolean, false));
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
  if coalesce((to_jsonb(old) ->> 'is_dev_seed')::boolean, false) then
    return old;
  end if;
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
    create role lakeandpine_app login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
  end if;
end
$$;

-- Production currently connects through a dedicated Supavisor credential for this
-- role. Preserve that non-privileged LOGIN path; disabling it is a separately
-- approved credential-revocation action. Runtime still selects and verifies this
-- exact non-owner role on every connection.
alter role lakeandpine_app login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
-- Supabase's server connection opens as the project `postgres` role, then the
-- startup `role` parameter selects this non-owner role on every pooled backend.
-- INHERIT is deliberately false: owner sessions keep owner privileges unless
-- they explicitly select the RLS-bound application role.
grant lakeandpine_app to postgres with admin false, inherit false, set true;
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
grant execute on function assert_cleaner_schedule_capacity(uuid, uuid, timestamptz, timestamptz, uuid, integer) to lakeandpine_app;
grant execute on function revalidate_schedule_readiness(uuid) to lakeandpine_app;
grant execute on function normalize_us_postal_code(text) to lakeandpine_app;
grant execute on function pause_territory_without_cleaner_capacity(uuid) to lakeandpine_app;
grant execute on function assert_service_case_recovery_consistency(uuid, text) to lakeandpine_app;

alter default privileges in schema public revoke all on tables from public;
alter default privileges in schema public revoke all on sequences from public;
alter default privileges in schema public grant select, insert, update, delete on tables to lakeandpine_app;
alter default privileges in schema public grant usage, select on sequences to lakeandpine_app;

comment on table operations_state_events is
  'Append-only status-transition evidence. Event data must exclude private contact details and provider secrets.';

comment on table notification_outbox is
  'Durable transactional-notification work. Request persistence never depends on immediate provider delivery.';
