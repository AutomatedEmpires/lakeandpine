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
