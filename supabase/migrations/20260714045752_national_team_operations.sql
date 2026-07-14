-- National team operations foundation.
--
-- Lake & Pine remains one premium service operator, but every operational row
-- below is organization/team scoped so a new team starts with an empty ledger
-- and cannot accidentally reference another team's people, stock, or work.
-- Purchasing and payroll remain approval/export ledgers: no trigger spends or
-- moves money.

set local lock_timeout = '5s';
set local statement_timeout = '5min';

create schema if not exists private;
revoke all on schema private from public;

create table team_job_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  job_schedule_id uuid not null unique references job_schedules(id) on delete cascade,
  assigned_by_membership_id uuid references workforce_memberships(id) on delete set null,
  estimated_labor_minutes integer not null check (estimated_labor_minutes between 30 and 2400),
  allocated_at timestamptz not null default now(),
  is_dev_seed boolean not null default false,
  constraint team_job_allocations_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id),
  constraint team_job_allocations_org_team_id_key unique (organization_id, team_id, id)
);
create index team_job_allocations_team_schedule_idx
  on team_job_allocations (organization_id, team_id, allocated_at desc);

create table team_service_territories (
  organization_id uuid not null,
  team_id uuid not null,
  territory_id uuid not null references service_territories(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'paused')),
  priority integer not null default 100 check (priority between 1 and 1000),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (team_id, territory_id),
  constraint team_service_territories_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id)
);
create index team_service_territories_dispatch_idx
  on team_service_territories (organization_id, territory_id, status, priority);
create index team_service_territories_team_scope_idx
  on team_service_territories (organization_id, team_id);
create index team_service_territories_territory_idx
  on team_service_territories (territory_id);

create table inventory_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  sku text not null check (sku ~ '^[A-Z0-9][A-Z0-9_-]{1,49}$'),
  name text not null check (char_length(name) between 2 and 160),
  brand text,
  category text not null default 'general'
    check (category in ('chemical', 'paper', 'tool', 'ppe', 'liner', 'marine', 'finish_care', 'general')),
  unit_label text not null default 'each' check (char_length(unit_label) between 1 and 40),
  pack_size numeric(12,3) not null default 1 check (pack_size > 0),
  preferred_vendor text,
  purchase_url text check (purchase_url is null or purchase_url ~ '^https://'),
  image_url text check (image_url is null or image_url ~ '^https://'),
  safety_sheet_url text check (safety_sheet_url is null or safety_sheet_url ~ '^https://'),
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  automatic_reorder_enabled boolean not null default true,
  active boolean not null default true,
  is_dev_seed boolean not null default false,
  created_by_membership_id uuid references workforce_memberships(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_products_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id),
  constraint inventory_products_team_sku_key unique (team_id, sku),
  constraint inventory_products_scope_id_key unique (organization_id, team_id, id)
);

create table inventory_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  name text not null check (char_length(name) between 2 and 120),
  location_type text not null default 'supply_room'
    check (location_type in ('supply_room', 'vehicle', 'client_site', 'other')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_locations_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id),
  constraint inventory_locations_team_name_key unique (team_id, name),
  constraint inventory_locations_scope_id_key unique (organization_id, team_id, id)
);

create table inventory_stock (
  organization_id uuid not null,
  team_id uuid not null,
  location_id uuid not null,
  product_id uuid not null,
  on_hand numeric(12,3) not null default 0 check (on_hand >= 0),
  reorder_point numeric(12,3) not null default 0 check (reorder_point >= 0),
  target_level numeric(12,3) not null default 0 check (target_level >= reorder_point),
  last_counted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (location_id, product_id),
  constraint inventory_stock_location_fkey
    foreign key (organization_id, team_id, location_id)
    references inventory_locations (organization_id, team_id, id),
  constraint inventory_stock_product_fkey
    foreign key (organization_id, team_id, product_id)
    references inventory_products (organization_id, team_id, id),
  constraint inventory_stock_scope_key
    unique (organization_id, team_id, location_id, product_id)
);

create table inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  location_id uuid not null,
  product_id uuid not null,
  transaction_type text not null
    check (transaction_type in ('receipt', 'usage', 'waste', 'return', 'adjustment', 'transfer_in', 'transfer_out')),
  quantity_delta numeric(12,3) not null check (quantity_delta <> 0),
  balance_after numeric(12,3) not null check (balance_after >= 0),
  actor_membership_id uuid references workforce_memberships(id) on delete set null,
  cleaner_id uuid references cleaners(id) on delete set null,
  team_job_allocation_id uuid references team_job_allocations(id) on delete set null,
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  note text check (note is null or char_length(note) <= 1000),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  constraint inventory_transactions_location_fkey
    foreign key (organization_id, team_id, location_id)
    references inventory_locations (organization_id, team_id, id),
  constraint inventory_transactions_product_fkey
    foreign key (organization_id, team_id, product_id)
    references inventory_products (organization_id, team_id, id)
);

create index inventory_transactions_team_created_idx
  on inventory_transactions (organization_id, team_id, created_at desc);
create index inventory_transactions_product_created_idx
  on inventory_transactions (product_id, created_at desc);
create index inventory_transactions_cleaner_created_idx
  on inventory_transactions (cleaner_id, created_at desc)
  where cleaner_id is not null;

create table restock_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  location_id uuid not null,
  product_id uuid not null,
  requested_by_membership_id uuid references workforce_memberships(id) on delete set null,
  request_source text not null default 'manual'
    check (request_source in ('manual', 'cleaner', 'automatic_threshold')),
  quantity_requested numeric(12,3) not null check (quantity_requested > 0),
  estimated_unit_cost_cents integer check (estimated_unit_cost_cents is null or estimated_unit_cost_cents >= 0),
  purchase_url_snapshot text check (purchase_url_snapshot is null or purchase_url_snapshot ~ '^https://'),
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'ordered', 'received', 'declined', 'canceled')),
  decision_by_membership_id uuid references workforce_memberships(id) on delete set null,
  decision_note text check (decision_note is null or char_length(decision_note) <= 1000),
  decided_at timestamptz,
  ordered_at timestamptz,
  received_at timestamptz,
  version integer not null default 1 check (version > 0),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint restock_requests_location_fkey
    foreign key (organization_id, team_id, location_id)
    references inventory_locations (organization_id, team_id, id),
  constraint restock_requests_product_fkey
    foreign key (organization_id, team_id, product_id)
    references inventory_products (organization_id, team_id, id)
);
create index restock_requests_queue_idx
  on restock_requests (organization_id, team_id, status, created_at);
create unique index restock_requests_one_automatic_open_idx
  on restock_requests (location_id, product_id)
  where request_source = 'automatic_threshold'
    and status in ('requested', 'approved', 'ordered');

create table job_time_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  team_job_allocation_id uuid not null,
  cleaner_id uuid not null references cleaners(id) on delete restrict,
  clock_in_at timestamptz not null,
  clock_out_at timestamptz,
  break_minutes integer not null default 0 check (break_minutes between 0 and 720),
  estimated_minutes_snapshot integer not null check (estimated_minutes_snapshot between 1 and 2400),
  status text not null default 'open'
    check (status in ('open', 'submitted', 'approved', 'rejected')),
  source text not null default 'crew_timer' check (source in ('crew_timer', 'manager_entry', 'import')),
  approved_by_membership_id uuid references workforce_memberships(id) on delete set null,
  approved_at timestamptz,
  adjustment_reason text check (adjustment_reason is null or char_length(adjustment_reason) <= 1000),
  version integer not null default 1 check (version > 0),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_time_entries_allocation_fkey
    foreign key (organization_id, team_id, team_job_allocation_id)
    references team_job_allocations (organization_id, team_id, id),
  check (clock_out_at is null or clock_out_at > clock_in_at),
  check (clock_out_at is null or break_minutes <=
    floor(extract(epoch from (clock_out_at - clock_in_at)) / 60)),
  check ((status = 'open') = (clock_out_at is null))
);
create unique index job_time_entries_one_open_cleaner_idx
  on job_time_entries (cleaner_id) where status = 'open';
create index job_time_entries_team_status_idx
  on job_time_entries (organization_id, team_id, status, clock_in_at desc);
create index job_time_entries_cleaner_idx
  on job_time_entries (cleaner_id, clock_in_at desc);

create table compensation_rates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  workforce_membership_id uuid not null references workforce_memberships(id) on delete restrict,
  pay_basis text not null check (pay_basis in ('hourly', 'salary', 'per_job')),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  effective_from date not null,
  effective_to date,
  status text not null default 'active' check (status in ('draft', 'active', 'ended')),
  created_by_membership_id uuid references workforce_memberships(id) on delete set null,
  reason text not null check (char_length(reason) between 2 and 500),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint compensation_rates_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id),
  check (effective_to is null or effective_to >= effective_from)
);
create index compensation_rates_member_effective_idx
  on compensation_rates (workforce_membership_id, effective_from desc);

create table review_bonus_tiers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  team_id uuid,
  name text not null check (char_length(name) between 2 and 120),
  minimum_rating numeric(2,1) not null check (minimum_rating between 1 and 5),
  bonus_cents integer not null check (bonus_cents > 0),
  active boolean not null default true,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint review_bonus_tiers_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id)
);
create index review_bonus_tiers_scope_idx
  on review_bonus_tiers (organization_id, team_id, active, minimum_rating desc);

create table quality_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  team_job_allocation_id uuid not null,
  cleaner_id uuid not null references cleaners(id) on delete restrict,
  customer_id uuid references customers(id) on delete restrict,
  rating integer not null check (rating between 1 and 5),
  source text not null check (source in ('verified_customer', 'quality_inspection', 'manager_review')),
  verified_at timestamptz,
  evidence_reference text
    check (evidence_reference is null or char_length(evidence_reference) between 4 and 500),
  private_note text check (private_note is null or char_length(private_note) <= 2000),
  created_by_membership_id uuid references workforce_memberships(id) on delete set null,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  constraint quality_reviews_allocation_fkey
    foreign key (organization_id, team_id, team_job_allocation_id)
    references team_job_allocations (organization_id, team_id, id),
  constraint quality_reviews_cleaner_job_key unique (team_job_allocation_id, cleaner_id, source),
  constraint quality_reviews_verified_customer_check check (
    source <> 'verified_customer'
    or (customer_id is not null and verified_at is not null and evidence_reference is not null)
  )
);
create index quality_reviews_team_created_idx
  on quality_reviews (organization_id, team_id, created_at desc);
create index quality_reviews_customer_idx
  on quality_reviews (customer_id)
  where customer_id is not null;

create table bonus_awards (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  workforce_membership_id uuid not null references workforce_memberships(id) on delete restrict,
  quality_review_id uuid references quality_reviews(id) on delete restrict,
  bonus_tier_id uuid references review_bonus_tiers(id) on delete set null,
  amount_cents integer not null check (amount_cents > 0),
  reason text not null check (char_length(reason) between 2 and 500),
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'exported', 'recorded_paid', 'canceled')),
  approved_by_membership_id uuid references workforce_memberships(id) on delete set null,
  approved_at timestamptz,
  external_reference text,
  version integer not null default 1 check (version > 0),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bonus_awards_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id)
);
create unique index bonus_awards_review_tier_idx
  on bonus_awards (quality_review_id, bonus_tier_id)
  where quality_review_id is not null and bonus_tier_id is not null;
create index bonus_awards_team_status_idx
  on bonus_awards (organization_id, team_id, status, created_at desc);

create table workforce_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  subject_membership_id uuid not null references workforce_memberships(id) on delete restrict,
  event_type text not null check (event_type in (
    'hired', 'onboarding', 'callout', 'late', 'no_show', 'strike', 'attendance_warning',
    'performance_coaching', 'final_warning', 'suspension', 'reactivation', 'termination',
    'resignation', 'recognition', 'safety', 'other'
  )),
  severity text not null default 'info' check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved', 'appealed')),
  occurred_at timestamptz not null default now(),
  summary text not null check (char_length(summary) between 2 and 1000),
  private_details text check (private_details is null or char_length(private_details) <= 4000),
  created_by_membership_id uuid references workforce_memberships(id) on delete set null,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_events_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id)
);
create index workforce_events_team_queue_idx
  on workforce_events (organization_id, team_id, status, occurred_at desc);
create index workforce_events_subject_idx
  on workforce_events (subject_membership_id, occurred_at desc);

create function validate_scoped_actor_membership() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  actor_id uuid;
begin
  actor_id := nullif(to_jsonb(new) ->> tg_argv[0], '')::uuid;
  if actor_id is not null and not exists (
    select 1 from workforce_memberships membership
    where membership.id = actor_id
      and membership.organization_id = new.organization_id
      and (membership.team_id is null or membership.team_id = new.team_id)
      and membership.status = 'active'
  ) then
    raise exception 'Actor membership must be active in the organization or target team'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create function validate_scoped_subject_membership() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  subject_id uuid;
begin
  subject_id := nullif(to_jsonb(new) ->> tg_argv[0], '')::uuid;
  if subject_id is not null and not exists (
    select 1 from workforce_memberships membership
    where membership.id = subject_id
      and membership.organization_id = new.organization_id
      and membership.team_id = new.team_id
  ) then
    raise exception 'Subject membership must belong to the target team'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger team_job_allocations_actor_scope_guard
  before insert or update of assigned_by_membership_id on team_job_allocations
  for each row execute function validate_scoped_actor_membership('assigned_by_membership_id');
create trigger inventory_products_actor_scope_guard
  before insert or update of created_by_membership_id on inventory_products
  for each row execute function validate_scoped_actor_membership('created_by_membership_id');
create trigger inventory_transactions_actor_scope_guard
  before insert or update of actor_membership_id on inventory_transactions
  for each row execute function validate_scoped_actor_membership('actor_membership_id');
create trigger restock_requests_requester_scope_guard
  before insert or update of requested_by_membership_id on restock_requests
  for each row execute function validate_scoped_actor_membership('requested_by_membership_id');
create trigger restock_requests_reviewer_scope_guard
  before insert or update of decision_by_membership_id on restock_requests
  for each row execute function validate_scoped_actor_membership('decision_by_membership_id');
create trigger job_time_entries_approver_scope_guard
  before insert or update of approved_by_membership_id on job_time_entries
  for each row execute function validate_scoped_actor_membership('approved_by_membership_id');
create trigger compensation_rates_subject_scope_guard
  before insert or update of workforce_membership_id on compensation_rates
  for each row execute function validate_scoped_subject_membership('workforce_membership_id');
create trigger compensation_rates_actor_scope_guard
  before insert or update of created_by_membership_id on compensation_rates
  for each row execute function validate_scoped_actor_membership('created_by_membership_id');
create trigger quality_reviews_actor_scope_guard
  before insert or update of created_by_membership_id on quality_reviews
  for each row execute function validate_scoped_actor_membership('created_by_membership_id');
create trigger bonus_awards_subject_scope_guard
  before insert or update of workforce_membership_id on bonus_awards
  for each row execute function validate_scoped_subject_membership('workforce_membership_id');
create trigger bonus_awards_approver_scope_guard
  before insert or update of approved_by_membership_id on bonus_awards
  for each row execute function validate_scoped_actor_membership('approved_by_membership_id');
create trigger workforce_events_subject_scope_guard
  before insert or update of subject_membership_id on workforce_events
  for each row execute function validate_scoped_subject_membership('subject_membership_id');
create trigger workforce_events_actor_scope_guard
  before insert or update of created_by_membership_id on workforce_events
  for each row execute function validate_scoped_actor_membership('created_by_membership_id');
create trigger workforce_memberships_status_actor_scope_guard
  before insert or update of status_changed_by_membership_id on workforce_memberships
  for each row execute function validate_scoped_actor_membership('status_changed_by_membership_id');

-- Cover every foreign-key path used by joins, scoped authorization, and
-- cascades. PostgreSQL does not create these indexes automatically.
create index team_job_allocations_actor_idx
  on team_job_allocations (assigned_by_membership_id)
  where assigned_by_membership_id is not null;
create index inventory_products_actor_idx
  on inventory_products (created_by_membership_id)
  where created_by_membership_id is not null;
create index inventory_stock_product_idx
  on inventory_stock (organization_id, team_id, product_id);
create index inventory_transactions_actor_idx
  on inventory_transactions (actor_membership_id)
  where actor_membership_id is not null;
create index inventory_transactions_location_scope_idx
  on inventory_transactions (organization_id, team_id, location_id);
create index inventory_transactions_product_scope_idx
  on inventory_transactions (organization_id, team_id, product_id);
create index inventory_transactions_allocation_idx
  on inventory_transactions (team_job_allocation_id)
  where team_job_allocation_id is not null;
create index restock_requests_requester_idx
  on restock_requests (requested_by_membership_id)
  where requested_by_membership_id is not null;
create index restock_requests_decider_idx
  on restock_requests (decision_by_membership_id)
  where decision_by_membership_id is not null;
create index restock_requests_location_scope_idx
  on restock_requests (organization_id, team_id, location_id);
create index restock_requests_product_scope_idx
  on restock_requests (organization_id, team_id, product_id);
create index job_time_entries_allocation_scope_idx
  on job_time_entries (organization_id, team_id, team_job_allocation_id);
create index job_time_entries_approver_idx
  on job_time_entries (approved_by_membership_id)
  where approved_by_membership_id is not null;
create index compensation_rates_team_idx
  on compensation_rates (organization_id, team_id);
create index compensation_rates_subject_scope_idx
  on compensation_rates (organization_id, team_id, workforce_membership_id);
create index compensation_rates_actor_idx
  on compensation_rates (created_by_membership_id)
  where created_by_membership_id is not null;
create index quality_reviews_allocation_scope_idx
  on quality_reviews (organization_id, team_id, team_job_allocation_id);
create index quality_reviews_cleaner_idx on quality_reviews (cleaner_id);
create index quality_reviews_actor_idx
  on quality_reviews (created_by_membership_id)
  where created_by_membership_id is not null;
create index bonus_awards_membership_idx on bonus_awards (workforce_membership_id);
create index bonus_awards_subject_scope_idx
  on bonus_awards (organization_id, team_id, workforce_membership_id);
create index bonus_awards_tier_idx
  on bonus_awards (bonus_tier_id) where bonus_tier_id is not null;
create index bonus_awards_approver_idx
  on bonus_awards (approved_by_membership_id)
  where approved_by_membership_id is not null;
create index workforce_events_subject_scope_idx
  on workforce_events (organization_id, team_id, subject_membership_id);
create index workforce_events_actor_idx
  on workforce_events (created_by_membership_id)
  where created_by_membership_id is not null;

alter table compensation_rates
  add constraint compensation_rates_subject_scope_fkey
  foreign key (organization_id, team_id, workforce_membership_id)
  references workforce_memberships (organization_id, team_id, id);
alter table bonus_awards
  add constraint bonus_awards_subject_scope_fkey
  foreign key (organization_id, team_id, workforce_membership_id)
  references workforce_memberships (organization_id, team_id, id);
alter table workforce_events
  add constraint workforce_events_subject_scope_fkey
  foreign key (organization_id, team_id, subject_membership_id)
  references workforce_memberships (organization_id, team_id, id);

create function guard_compensation_rate_overlap() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status = 'active' and exists (
    select 1 from compensation_rates existing
    where existing.workforce_membership_id = new.workforce_membership_id
      and existing.id <> new.id
      and existing.status = 'active'
      and daterange(existing.effective_from, coalesce(existing.effective_to, 'infinity'::date), '[]')
        && daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]')
  ) then
    raise exception 'Active compensation periods cannot overlap' using errcode = '23P01';
  end if;
  return new;
end
$$;
create trigger compensation_rates_overlap_guard
  before insert or update on compensation_rates
  for each row execute function guard_compensation_rate_overlap();

create function guard_compensation_rate_history() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_dev_seed and current_user <> 'lakeandpine_app'
      and coalesce(current_setting('lakeandpine.dev_seed_purge', true), '') = '1' then
      return old;
    end if;
    raise exception 'Compensation history is append-only' using errcode = '55000';
  end if;
  if old.status <> 'active' or new.status <> 'ended'
    or new.effective_to is null
    or new.organization_id is distinct from old.organization_id
    or new.team_id is distinct from old.team_id
    or new.workforce_membership_id is distinct from old.workforce_membership_id
    or new.pay_basis is distinct from old.pay_basis
    or new.amount_cents is distinct from old.amount_cents
    or new.currency is distinct from old.currency
    or new.effective_from is distinct from old.effective_from
    or new.created_by_membership_id is distinct from old.created_by_membership_id
    or new.reason is distinct from old.reason
    or new.is_dev_seed is distinct from old.is_dev_seed
    or new.created_at is distinct from old.created_at then
    raise exception 'End the current compensation period and append a new rate'
      using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger compensation_rates_history_guard
  before update or delete on compensation_rates
  for each row execute function guard_compensation_rate_history();

create function guard_workforce_membership_history() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_dev_seed and current_user <> 'lakeandpine_app'
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
  if new.organization_id is distinct from old.organization_id
    or new.team_id is distinct from old.team_id
    or new.customer_id is distinct from old.customer_id
    or new.cleaner_id is distinct from old.cleaner_id
    or new.role is distinct from old.role
    or new.title is distinct from old.title
    or new.hired_at is distinct from old.hired_at
    or new.is_dev_seed is distinct from old.is_dev_seed
    or new.created_at is distinct from old.created_at
    or new.status is not distinct from old.status
    or not (
      (old.status = 'active' and new.status in ('paused','ended'))
      or (old.status = 'paused' and new.status in ('active','ended'))
    )
    or coalesce(char_length(new.status_reason), 0) < 4
    or new.status_changed_by_membership_id is null
    or new.status_changed_at is null
    or ((new.status = 'ended') <> (new.ended_at is not null)) then
    raise exception 'Invalid or destructive workforce membership transition'
      using errcode = '55000';
  end if;
  return new;
end
$$;
create trigger workforce_memberships_history_guard
  before update or delete on workforce_memberships
  for each row execute function guard_workforce_membership_history();

create function validate_quality_review_evidence() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  booking_customer_id uuid;
  schedule_status text;
begin
  select booking.customer_id, schedule.status
  into booking_customer_id, schedule_status
  from team_job_allocations allocation
  join job_schedules schedule on schedule.id = allocation.job_schedule_id
  join bookings booking on booking.id = schedule.booking_id
  join job_assignments assignment
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
    if schedule_status <> 'completed' or new.customer_id is distinct from booking_customer_id then
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
create trigger quality_reviews_evidence_guard
  before insert or update on quality_reviews
  for each row execute function validate_quality_review_evidence();

create function guard_bonus_award_transition() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'proposed'
      or new.approved_by_membership_id is not null
      or new.approved_at is not null
      or new.external_reference is not null
      or new.version <> 1 then
      raise exception 'Bonus awards must begin as an unapproved proposal'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.organization_id is distinct from old.organization_id
    or new.team_id is distinct from old.team_id
    or new.workforce_membership_id is distinct from old.workforce_membership_id
    or new.quality_review_id is distinct from old.quality_review_id
    or new.bonus_tier_id is distinct from old.bonus_tier_id
    or new.amount_cents is distinct from old.amount_cents
    or new.reason is distinct from old.reason
    or new.is_dev_seed is distinct from old.is_dev_seed
    or new.created_at is distinct from old.created_at
    or new.version <> old.version + 1
    or not (
      (old.status = 'proposed' and new.status in ('approved','canceled'))
      or (old.status = 'approved' and new.status in ('exported','canceled'))
      or (old.status = 'exported' and new.status in ('recorded_paid','canceled'))
    ) then
    raise exception 'Invalid or destructive bonus transition' using errcode = '55000';
  end if;
  if new.status in ('approved','exported','recorded_paid')
    and (new.approved_by_membership_id is null or new.approved_at is null) then
    raise exception 'Approved bonus history requires an accountable approver'
      using errcode = '23514';
  end if;
  if new.status in ('exported','recorded_paid')
    and coalesce(char_length(new.external_reference), 0) < 4 then
    raise exception 'Exported or paid bonus records require an external reference'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger bonus_awards_transition_guard
  before insert or update on bonus_awards
  for each row execute function guard_bonus_award_transition();

create function guard_restock_request_lifecycle() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'requested'
      or new.decision_by_membership_id is not null
      or new.decision_note is not null
      or new.decided_at is not null
      or new.ordered_at is not null
      or new.received_at is not null
      or new.version <> 1 then
      raise exception 'Restock requests must begin in requested state'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.organization_id is distinct from old.organization_id
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
    or new.version <> old.version + 1
    or not (
      (old.status = 'requested' and new.status in ('approved','declined','canceled'))
      or (old.status = 'approved' and new.status in ('ordered','canceled'))
      or (old.status = 'ordered' and new.status in ('received','canceled'))
    ) then
    raise exception 'Invalid or destructive restock transition' using errcode = '55000';
  end if;
  if new.decision_by_membership_id is null then
    raise exception 'Restock transitions require an accountable decision maker'
      using errcode = '23514';
  end if;
  if new.status in ('approved','declined','canceled') and new.decided_at is null then
    raise exception 'Restock decision timestamp is required' using errcode = '23514';
  end if;
  if new.status = 'ordered' and new.ordered_at is null then
    raise exception 'Restock order timestamp is required' using errcode = '23514';
  end if;
  if new.status = 'received' then
    if new.received_at is null then
      raise exception 'Restock receipt timestamp is required' using errcode = '23514';
    end if;
    insert into inventory_transactions
      (organization_id, team_id, location_id, product_id, transaction_type,
       quantity_delta, balance_after, actor_membership_id, unit_cost_cents,
       note, is_dev_seed)
    values (new.organization_id, new.team_id, new.location_id, new.product_id,
      'receipt', new.quantity_requested, 0, new.decision_by_membership_id,
      new.estimated_unit_cost_cents, 'Received approved restock', new.is_dev_seed);
  end if;
  return new;
end
$$;
create trigger restock_requests_lifecycle_guard
  before insert or update on restock_requests
  for each row execute function guard_restock_request_lifecycle();

create function reject_workforce_event_mutation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and old.is_dev_seed and current_user <> 'lakeandpine_app'
    and coalesce(current_setting('lakeandpine.dev_seed_purge', true), '') = '1' then
    return old;
  end if;
  raise exception 'Workforce evidence is append-only; add a follow-up event'
    using errcode = '55000';
end
$$;
create trigger workforce_events_immutable
  before update or delete on workforce_events
  for each row execute function reject_workforce_event_mutation();

create function validate_team_job_allocation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from team_service_territories coverage
    join job_schedules schedule on schedule.territory_id = coverage.territory_id
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
    from job_assignments assignment
    where assignment.job_schedule_id = new.job_schedule_id
      and assignment.team_id is not null
      and assignment.team_id <> new.team_id
  ) then
    raise exception 'Schedule assignments must match the allocated team'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from job_assignments assignment
    where assignment.job_schedule_id = new.job_schedule_id
      and assignment.status in ('accepted','confirmed')
      and not exists (
        select 1 from workforce_memberships membership
        where membership.organization_id = new.organization_id
          and membership.team_id = new.team_id
          and membership.cleaner_id = assignment.cleaner_id
          and membership.role in ('cleaner','shift_lead')
          and membership.status = 'active'
      )
  ) then
    raise exception 'Accepted crew must be active in the allocated team'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from job_schedules schedule
    join service_cases service_case on service_case.booking_id = schedule.booking_id
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
create trigger team_job_allocations_team_guard
  before insert or update of organization_id, team_id, job_schedule_id
  on team_job_allocations for each row execute function validate_team_job_allocation();

create function private.validate_service_case_team_assignment() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  allocated_team_id uuid;
begin
  if new.booking_id is null then
    if new.assigned_team_id is not null then
      raise exception 'A team-owned service case requires an allocated booking'
        using errcode = '23514';
    end if;
    return new;
  end if;

  select allocation.team_id into allocated_team_id
  from public.job_schedules schedule
  join public.team_job_allocations allocation
    on allocation.job_schedule_id = schedule.id
  where schedule.booking_id = new.booking_id;

  if new.assigned_team_id is null and allocated_team_id is not null then
    new.assigned_team_id := allocated_team_id;
  elsif new.assigned_team_id is not null
    and new.assigned_team_id is distinct from allocated_team_id then
    raise exception 'Service-case team must match the booking allocation'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create function private.assign_booking_cases_from_allocation() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.service_cases service_case
  set assigned_team_id = new.team_id
  from public.job_schedules schedule
  where schedule.id = new.job_schedule_id
    and service_case.booking_id = schedule.booking_id
    and service_case.assigned_team_id is null;
  return new;
end
$$;
create trigger team_job_allocations_assign_cases
  after insert or update of team_id, job_schedule_id on public.team_job_allocations
  for each row execute function private.assign_booking_cases_from_allocation();

create function validate_team_assignment_membership() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  allocated_team_id uuid;
begin
  if new.team_id is null then return new; end if;
  select allocation.team_id
    into allocated_team_id
  from team_job_allocations allocation
  where allocation.job_schedule_id = new.job_schedule_id;
  if allocated_team_id is not null and allocated_team_id <> new.team_id then
    raise exception 'Assignment team must match the schedule allocation'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from workforce_memberships membership
    join cleaning_teams team on team.id = new.team_id
    where membership.organization_id = team.organization_id
      and membership.team_id = new.team_id
      and membership.cleaner_id = new.cleaner_id
      and membership.role in ('cleaner','shift_lead') and membership.status = 'active'
  ) then
    raise exception 'Cleaner must have active membership in the assignment team'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create function validate_team_time_entry() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from team_job_allocations allocation
    join job_assignments assignment
      on assignment.job_schedule_id = allocation.job_schedule_id
    join workforce_memberships membership
      on membership.organization_id = allocation.organization_id
      and membership.team_id = allocation.team_id
      and membership.cleaner_id = new.cleaner_id
      and membership.role in ('cleaner','shift_lead') and membership.status = 'active'
    where allocation.id = new.team_job_allocation_id
      and allocation.organization_id = new.organization_id
      and allocation.team_id = new.team_id
      and assignment.cleaner_id = new.cleaner_id
      and assignment.status in ('accepted', 'confirmed')
  ) then
    raise exception 'Time entry requires active team membership and accepted work'
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger job_time_entries_team_assignment_guard
  before insert or update of organization_id, team_id, team_job_allocation_id, cleaner_id
  on job_time_entries for each row execute function validate_team_time_entry();

create function guard_inventory_stock_write() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.on_hand <> 0 then
      raise exception 'New stock records must start at zero and receive stock through the ledger'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.team_id is distinct from old.team_id
    or new.location_id is distinct from old.location_id
    or new.product_id is distinct from old.product_id then
    raise exception 'Stock identity is immutable; use transfer ledger entries'
      using errcode = '42501';
  end if;

  if new.on_hand is distinct from old.on_hand
    and (coalesce(current_setting('lakeandpine.inventory_ledger_write', true), '') <> '1'
      or pg_trigger_depth() < 2) then
    raise exception 'Inventory balances may change only through the inventory ledger'
      using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger inventory_stock_ledger_guard
  before insert or update on inventory_stock
  for each row execute function guard_inventory_stock_write();

create function apply_inventory_transaction() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  current_balance numeric(12,3);
  next_balance numeric(12,3);
begin
  if (new.transaction_type in ('usage', 'waste', 'transfer_out') and new.quantity_delta >= 0)
    or (new.transaction_type in ('receipt', 'return', 'transfer_in') and new.quantity_delta <= 0) then
    raise exception 'Inventory transaction direction does not match its type' using errcode = '23514';
  end if;

  if new.cleaner_id is not null and not exists (
    select 1 from workforce_memberships membership
    where membership.organization_id = new.organization_id
      and membership.team_id = new.team_id
      and membership.cleaner_id = new.cleaner_id
      and membership.role in ('cleaner','shift_lead') and membership.status = 'active'
  ) then
    raise exception 'Cleaner inventory use requires active membership in the team'
      using errcode = '23514';
  end if;

  -- The ledger trigger is the only path that may lock and mutate stock for a
  -- cleaner. Set the transaction-local guard before SELECT ... FOR UPDATE so
  -- the UPDATE RLS policy can see that this statement originated in a trigger.
  perform set_config('lakeandpine.inventory_ledger_write', '1', true);
  select on_hand into current_balance
  from inventory_stock
  where organization_id = new.organization_id
    and team_id = new.team_id
    and location_id = new.location_id
    and product_id = new.product_id
  for update;

  if current_balance is null then
    raise exception 'Create the team stock record before recording inventory activity'
      using errcode = '23503';
  end if;

  next_balance := current_balance + new.quantity_delta;
  if next_balance < 0 then
    raise exception 'Inventory usage exceeds available team stock' using errcode = '23514';
  end if;

  update inventory_stock
  set on_hand = next_balance,
      last_counted_at = case when new.transaction_type = 'adjustment' then now() else last_counted_at end,
      updated_at = now()
  where location_id = new.location_id and product_id = new.product_id;
  new.balance_after := next_balance;
  return new;
end
$$;
create trigger inventory_transactions_apply_ledger
  before insert on inventory_transactions
  for each row execute function apply_inventory_transaction();

create function create_threshold_restock_draft() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  product inventory_products%rowtype;
begin
  select * into product from inventory_products where id = new.product_id;
  if product.automatic_reorder_enabled and new.on_hand <= new.reorder_point
     and new.target_level > new.on_hand then
    insert into restock_requests
      (organization_id, team_id, location_id, product_id, request_source,
       quantity_requested, estimated_unit_cost_cents, purchase_url_snapshot,
       status, is_dev_seed)
    values
      (new.organization_id, new.team_id, new.location_id, new.product_id,
       'automatic_threshold', new.target_level - new.on_hand,
       product.unit_cost_cents, product.purchase_url, 'requested', product.is_dev_seed)
    on conflict (location_id, product_id)
      where request_source = 'automatic_threshold'
        and status in ('requested', 'approved', 'ordered')
      do nothing;
  end if;
  return new;
end
$$;
create trigger inventory_stock_reorder_guard
  after insert or update of on_hand, reorder_point, target_level on inventory_stock
  for each row execute function create_threshold_restock_draft();

create function reject_inventory_transaction_mutation() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE'
    and old.is_dev_seed
    and current_user <> 'lakeandpine_app'
    and coalesce(current_setting('lakeandpine.dev_seed_purge', true), '') = '1' then
    return old;
  end if;
  raise exception 'Inventory ledger entries are immutable; add a correcting transaction'
    using errcode = '55000';
end
$$;
create trigger inventory_transactions_immutable
  before update or delete on inventory_transactions
  for each row execute function reject_inventory_transaction_mutation();

create function create_verified_review_bonus() returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  tier review_bonus_tiers%rowtype;
  cleaner_membership workforce_memberships%rowtype;
begin
  if new.source <> 'verified_customer' or new.verified_at is null then
    return new;
  end if;
  select * into cleaner_membership
  from workforce_memberships membership
  where membership.organization_id = new.organization_id
    and membership.team_id = new.team_id
    and membership.cleaner_id = new.cleaner_id
    and membership.role in ('cleaner','shift_lead')
    and membership.status = 'active'
  limit 1;
  if cleaner_membership.id is null then return new; end if;

  select * into tier
  from review_bonus_tiers candidate
  where candidate.organization_id = new.organization_id
    and (candidate.team_id is null or candidate.team_id = new.team_id)
    and candidate.active
    and new.rating >= candidate.minimum_rating
  order by candidate.minimum_rating desc, candidate.bonus_cents desc
  limit 1;
  if tier.id is null then return new; end if;

  insert into bonus_awards
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
create trigger quality_reviews_bonus_draft
  after insert or update of verified_at on quality_reviews
  for each row execute function create_verified_review_bonus();

create trigger organizations_updated_at before update on organizations
  for each row execute function set_updated_at();
create trigger workforce_memberships_updated_at before update on workforce_memberships
  for each row execute function set_updated_at();
create trigger team_service_territories_updated_at before update on team_service_territories
  for each row execute function set_updated_at();
create trigger inventory_products_updated_at before update on inventory_products
  for each row execute function set_updated_at();
create trigger inventory_locations_updated_at before update on inventory_locations
  for each row execute function set_updated_at();
create trigger restock_requests_updated_at before update on restock_requests
  for each row execute function set_updated_at();
create trigger job_time_entries_updated_at before update on job_time_entries
  for each row execute function set_updated_at();
create trigger compensation_rates_updated_at before update on compensation_rates
  for each row execute function set_updated_at();
create trigger review_bonus_tiers_updated_at before update on review_bonus_tiers
  for each row execute function set_updated_at();
create trigger bonus_awards_updated_at before update on bonus_awards
  for each row execute function set_updated_at();
create trigger workforce_events_updated_at before update on workforce_events
  for each row execute function set_updated_at();

create schema if not exists private;
revoke all on schema private from public;

create function private.current_customer_id() returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select nullif(current_setting('lakeandpine.current_customer_id', true), '')::uuid
$$;

create function private.current_cleaner_id() returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select nullif(current_setting('lakeandpine.current_cleaner_id', true), '')::uuid
$$;

create function private.can_access_organization(
  requested_organization_id uuid,
  allowed_roles text[]
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workforce_memberships membership
    where membership.organization_id = requested_organization_id
      and membership.status = 'active'
      and membership.role = any(allowed_roles)
      and (
        membership.customer_id = private.current_customer_id()
        or membership.cleaner_id = private.current_cleaner_id()
      )
  )
$$;

create function private.can_access_team(
  requested_organization_id uuid,
  requested_team_id uuid,
  allowed_roles text[]
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workforce_memberships membership
    where membership.organization_id = requested_organization_id
      and membership.status = 'active'
      and membership.role = any(allowed_roles)
      and (
        membership.team_id is null
        or membership.team_id = requested_team_id
      )
      and (
        membership.customer_id = private.current_customer_id()
        or membership.cleaner_id = private.current_cleaner_id()
      )
  )
$$;

create function private.is_current_membership(requested_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workforce_memberships membership
    where membership.id = requested_membership_id
      and membership.status = 'active'
      and (
        membership.customer_id = private.current_customer_id()
        or membership.cleaner_id = private.current_cleaner_id()
      )
  )
$$;

create function private.can_manage_financial_subject(
  requested_organization_id uuid,
  requested_team_id uuid,
  requested_membership_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workforce_memberships subject
    where subject.id = requested_membership_id
      and subject.organization_id = requested_organization_id
      and subject.team_id = requested_team_id
      and (
        private.can_access_organization(
          requested_organization_id, array['owner','gm']
        )
        or (
          private.can_access_team(
            requested_organization_id, requested_team_id, array['manager']
          )
          and subject.role in ('shift_lead','cleaner')
        )
      )
  )
$$;

create function private.subject_available_to_local_team(
  requested_organization_id uuid,
  requested_team_id uuid,
  requested_customer_id uuid,
  requested_cleaner_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from public.workforce_memberships membership
    where membership.status = 'active'
      and (
        membership.customer_id = requested_customer_id
        or membership.cleaner_id = requested_cleaner_id
      )
      and (
        membership.organization_id is distinct from requested_organization_id
        or membership.team_id is distinct from requested_team_id
      )
  )
$$;

create function private.guard_team_assignment_clean_room() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  excluded_membership_id uuid;
begin
  if new.status <> 'active' then
    return new;
  end if;

  -- Every authorized assignment path locks the underlying identity, including
  -- owner/GM overrides, so concurrent managers cannot both claim the same
  -- previously-unassigned person for different team clean rooms.
  if new.customer_id is not null then
    perform customer.id
    from public.customers customer
    where customer.id = new.customer_id
    for update;
  else
    perform cleaner.id
    from public.cleaners cleaner
    where cleaner.id = new.cleaner_id
    for update;
  end if;

  if private.can_access_organization(new.organization_id, array['owner','gm']) then
    return new;
  end if;

  if private.can_access_team(
    new.organization_id, new.team_id, array['manager']
  ) then
    excluded_membership_id := case when tg_op = 'UPDATE' then old.id else null end;
    if exists (
      select 1
      from public.workforce_memberships membership
      where membership.status = 'active'
        and membership.id is distinct from excluded_membership_id
        and (
          membership.customer_id = new.customer_id
          or membership.cleaner_id = new.cleaner_id
        )
        and (
          membership.organization_id is distinct from new.organization_id
          or membership.team_id is distinct from new.team_id
        )
    ) then
      raise exception 'Local managers cannot transfer or cross-assign another team identity'
        using errcode = '42501';
    end if;
  end if;

  return new;
end
$$;
create trigger workforce_memberships_team_clean_room_guard
  before insert or update of organization_id, team_id, customer_id, cleaner_id, status
  on public.workforce_memberships
  for each row execute function private.guard_team_assignment_clean_room();

create function private.can_read_workforce_event(
  requested_organization_id uuid,
  requested_team_id uuid,
  requested_subject_membership_id uuid,
  requested_event_type text
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workforce_memberships subject
    where subject.id = requested_subject_membership_id
      and subject.organization_id = requested_organization_id
      and subject.team_id = requested_team_id
      and (
        private.can_access_organization(
          requested_organization_id, array['owner','gm']
        )
        or (
          private.can_access_team(
            requested_organization_id, requested_team_id, array['manager']
          )
          and subject.role in ('shift_lead','cleaner')
        )
        or (
          private.can_access_team(
            requested_organization_id, requested_team_id, array['shift_lead']
          )
          and subject.role in ('shift_lead','cleaner')
          and requested_event_type in (
            'callout','late','no_show','safety','recognition','other'
          )
        )
        or private.is_current_membership(requested_subject_membership_id)
      )
  )
$$;

create function private.can_create_workforce_event(
  requested_organization_id uuid,
  requested_team_id uuid,
  requested_subject_membership_id uuid,
  requested_event_type text,
  requested_actor_membership_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workforce_memberships subject
    where subject.id = requested_subject_membership_id
      and subject.organization_id = requested_organization_id
      and subject.team_id = requested_team_id
      and exists (
        select 1
        from public.workforce_memberships actor
        where actor.id = requested_actor_membership_id
          and actor.organization_id = requested_organization_id
          and (actor.team_id is null or actor.team_id = requested_team_id)
          and actor.status = 'active'
          and (
            actor.customer_id = private.current_customer_id()
            or actor.cleaner_id = private.current_cleaner_id()
          )
      )
      and (
        private.can_access_organization(
          requested_organization_id, array['owner','gm']
        )
        or (
          private.can_access_team(
            requested_organization_id, requested_team_id, array['manager']
          )
          and subject.role in ('shift_lead','cleaner')
        )
        or (
          private.can_access_team(
            requested_organization_id, requested_team_id, array['shift_lead']
          )
          and subject.role in ('shift_lead','cleaner')
          and requested_event_type in (
            'callout','late','no_show','safety','recognition','other'
          )
        )
        or (
          requested_event_type = 'callout'
          and private.is_current_membership(requested_subject_membership_id)
        )
      )
  )
$$;

create function private.lock_current_workforce_access(target_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.current_customer_id() is distinct from target_customer_id then
    raise exception 'Workforce access lock identity mismatch' using errcode = '42501';
  end if;

  -- A shared lock makes authorization revocation and an actor operation
  -- linearizable. The lock lasts until the caller's transaction ends.
  perform membership.id
  from public.workforce_memberships membership
  join public.organizations organization
    on organization.id = membership.organization_id
  where membership.customer_id = target_customer_id
    and membership.status = 'active'
  for share of membership, organization;
end
$$;

create function private.lock_team_crew_memberships(
  target_organization_id uuid,
  target_team_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.can_access_team(
    target_organization_id,
    target_team_id,
    array['owner','gm','manager','shift_lead']
  ) then
    raise exception 'Team crew lock is outside the actor scope' using errcode = '42501';
  end if;

  -- Protect a scheduling recommendation from crew revocation until the
  -- proposal transaction finishes, including for shift leads whose RLS role
  -- intentionally cannot update workforce memberships.
  perform membership.id
  from public.workforce_memberships membership
  where membership.organization_id = target_organization_id
    and membership.team_id = target_team_id
    and membership.status = 'active'
    and membership.role in ('cleaner','shift_lead')
    and membership.cleaner_id is not null
  for share;
end
$$;

create function private.lock_active_team_territory_coverage(
  target_organization_id uuid,
  target_team_id uuid,
  target_territory_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  coverage_is_active boolean;
begin
  if not private.can_access_team(
    target_organization_id,
    target_team_id,
    array['owner','gm','manager','shift_lead']
  ) then
    raise exception 'Territory coverage lock is outside the actor scope' using errcode = '42501';
  end if;

  select true into coverage_is_active
  from public.team_service_territories coverage
  where coverage.organization_id = target_organization_id
    and coverage.team_id = target_team_id
    and coverage.territory_id = target_territory_id
    and coverage.status = 'active'
  for share;

  return coalesce(coverage_is_active, false);
end
$$;

create function private.bootstrap_lakeandpine_owner(target_customer_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_organization_id uuid;
  target_is_dev_seed boolean;
  membership_id uuid;
begin
  if private.current_customer_id() is distinct from target_customer_id then
    raise exception 'Owner bootstrap identity mismatch' using errcode = '42501';
  end if;
  select customer.is_dev_seed into target_is_dev_seed
  from public.customers customer
  where customer.id = target_customer_id and customer.role = 'staff';
  if not found then
    raise exception 'Only an existing staff identity can bootstrap ownership'
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
      and role = 'owner' and status = 'active'
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
  return membership_id;
end
$$;

create function private.guard_self_financial_control() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.current_customer_id() is not null and exists (
    select 1 from public.workforce_memberships membership
    where membership.id = new.workforce_membership_id
      and membership.customer_id = private.current_customer_id()
  ) then
    raise exception 'Operators cannot change their own compensation or bonus records'
      using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger compensation_rates_no_self_control
  before insert or update on public.compensation_rates
  for each row execute function private.guard_self_financial_control();
create trigger bonus_awards_no_self_control
  before insert or update on public.bonus_awards
  for each row execute function private.guard_self_financial_control();

create function private.guard_crew_time_entry_update() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  trusted_estimate integer;
  schedule_status text;
begin
  if tg_op = 'INSERT' and private.current_customer_id() is null
    and private.current_cleaner_id() = new.cleaner_id then
    select greatest(1,
        ceil(schedule.labor_minutes::numeric / schedule.required_crew_size)::integer),
      schedule.status
      into trusted_estimate, schedule_status
    from public.team_job_allocations allocation
    join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
    join public.job_assignments assignment
      on assignment.job_schedule_id = schedule.id
      and assignment.cleaner_id = new.cleaner_id
      and assignment.status in ('accepted','confirmed')
    where allocation.id = new.team_job_allocation_id
      and allocation.organization_id = new.organization_id
      and allocation.team_id = new.team_id;
    if trusted_estimate is null
      or schedule_status not in ('confirmed','en_route','in_progress')
      or new.status <> 'open'
      or new.source <> 'crew_timer'
      or new.clock_out_at is not null
      or new.break_minutes <> 0
      or new.estimated_minutes_snapshot <> trusted_estimate
      or new.clock_in_at < clock_timestamp() - interval '5 minutes'
      or new.clock_in_at > clock_timestamp() + interval '1 minute'
      or new.approved_by_membership_id is not null
      or new.approved_at is not null
      or new.adjustment_reason is not null
      or new.version <> 1 then
      raise exception 'Crew clocks must begin from the current accepted assignment'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and private.current_customer_id() is null
    and private.current_cleaner_id() = old.cleaner_id then
    if old.status <> 'open'
      or new.status <> 'submitted'
      or old.clock_out_at is not null
      or new.clock_out_at is null
      or new.clock_out_at < clock_timestamp() - interval '5 minutes'
      or new.clock_out_at > clock_timestamp() + interval '1 minute'
      or new.organization_id is distinct from old.organization_id
      or new.team_id is distinct from old.team_id
      or new.team_job_allocation_id is distinct from old.team_job_allocation_id
      or new.cleaner_id is distinct from old.cleaner_id
      or new.clock_in_at is distinct from old.clock_in_at
      or new.estimated_minutes_snapshot is distinct from old.estimated_minutes_snapshot
      or new.source is distinct from old.source
      or new.approved_by_membership_id is distinct from old.approved_by_membership_id
      or new.approved_at is distinct from old.approved_at
      or new.adjustment_reason is distinct from old.adjustment_reason
      or new.is_dev_seed is distinct from old.is_dev_seed
      or new.created_at is distinct from old.created_at
      or new.version <> old.version + 1 then
      raise exception 'Cleaners may only close an open clock for manager review'
        using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;
create trigger job_time_entries_crew_update_guard
  before insert or update on public.job_time_entries
  for each row execute function private.guard_crew_time_entry_update();

revoke all on function private.current_customer_id() from public;
revoke all on function private.current_cleaner_id() from public;
revoke all on function private.can_access_organization(uuid, text[]) from public;
revoke all on function private.can_access_team(uuid, uuid, text[]) from public;
revoke all on function private.is_current_membership(uuid) from public;
revoke all on function private.can_manage_financial_subject(uuid, uuid, uuid) from public;
revoke all on function private.subject_available_to_local_team(uuid, uuid, uuid, uuid) from public;
revoke all on function private.guard_team_assignment_clean_room() from public;
revoke all on function private.can_read_workforce_event(uuid, uuid, uuid, text) from public;
revoke all on function private.can_create_workforce_event(uuid, uuid, uuid, text, uuid) from public;
revoke all on function private.lock_current_workforce_access(uuid) from public;
revoke all on function private.lock_team_crew_memberships(uuid, uuid) from public;
revoke all on function private.lock_active_team_territory_coverage(uuid, uuid, uuid) from public;
revoke all on function private.bootstrap_lakeandpine_owner(uuid) from public;
revoke all on function private.guard_crew_time_entry_update() from public;
revoke all on function private.guard_self_financial_control() from public;

alter table organizations enable row level security;
alter table workforce_memberships enable row level security;
alter table team_job_allocations enable row level security;
alter table team_service_territories enable row level security;
alter table inventory_products enable row level security;
alter table inventory_locations enable row level security;
alter table inventory_stock enable row level security;
alter table inventory_transactions enable row level security;
alter table restock_requests enable row level security;
alter table job_time_entries enable row level security;
alter table compensation_rates enable row level security;
alter table review_bonus_tiers enable row level security;
alter table quality_reviews enable row level security;
alter table bonus_awards enable row level security;
alter table workforce_events enable row level security;

do $$
declare
  private_table text;
  private_tables constant text[] := array[
    'organizations', 'workforce_memberships', 'team_job_allocations',
    'team_service_territories',
    'inventory_products', 'inventory_locations', 'inventory_stock',
    'inventory_transactions', 'restock_requests', 'job_time_entries',
    'compensation_rates', 'review_bonus_tiers', 'quality_reviews',
    'bonus_awards', 'workforce_events'
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
    execute format(
      'create policy %I on public.%I for all to lakeandpine_app using (true) with check (true)',
      'lakeandpine_app_all_' || private_table,
      private_table
    );
  end loop;
end
$$;

-- Replace the broad application-role policies on this new operations layer
-- with actor-context policies. Server code sets only verified Clerk-derived
-- identities as transaction-local settings; missing context fails closed.
drop policy lakeandpine_app_all_organizations on organizations;
create policy organizations_read on organizations for select to lakeandpine_app
  using (private.can_access_organization(id, array['owner','gm','manager','shift_lead','cleaner']));
create policy organizations_update on organizations for update to lakeandpine_app
  using (private.can_access_organization(id, array['owner']))
  with check (private.can_access_organization(id, array['owner']));
create policy organizations_insert_denied on organizations for insert to lakeandpine_app
  with check (false);
create policy organizations_delete_denied on organizations for delete to lakeandpine_app
  using (false);

drop policy lakeandpine_app_all_workforce_memberships on workforce_memberships;
create policy workforce_memberships_read on workforce_memberships for select to lakeandpine_app
  using (
    private.can_access_organization(organization_id, array['owner','gm'])
    or (team_id is not null
      and private.can_access_team(organization_id, team_id, array['manager','shift_lead']))
    or customer_id = private.current_customer_id()
    or cleaner_id = private.current_cleaner_id()
  );
create policy workforce_memberships_insert on workforce_memberships for insert to lakeandpine_app
  with check (
    private.can_access_organization(organization_id, array['owner'])
    or (team_id is not null
      and private.can_access_organization(organization_id, array['gm'])
      and role in ('manager','shift_lead','cleaner'))
    or (team_id is not null
      and private.can_access_team(organization_id, team_id, array['manager'])
      and role in ('shift_lead','cleaner')
      and private.subject_available_to_local_team(
        organization_id, team_id, customer_id, cleaner_id
      ))
  );
create policy workforce_memberships_update on workforce_memberships for update to lakeandpine_app
  using (
    private.can_access_organization(organization_id, array['owner','gm'])
    or (team_id is not null
      and role in ('shift_lead','cleaner')
      and private.can_access_team(organization_id, team_id, array['manager']))
  )
  with check (
    private.can_access_organization(organization_id, array['owner','gm'])
    or (team_id is not null
      and role in ('shift_lead','cleaner')
      and private.can_access_team(organization_id, team_id, array['manager']))
  );
create policy workforce_memberships_delete on workforce_memberships for delete to lakeandpine_app
  using (false);

drop policy lakeandpine_app_all_team_job_allocations on team_job_allocations;
create policy team_job_allocations_read on team_job_allocations for select to lakeandpine_app
  using (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead','cleaner']));
create policy team_job_allocations_insert on team_job_allocations for insert to lakeandpine_app
  with check (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead']));
create policy team_job_allocations_update on team_job_allocations for update to lakeandpine_app
  using (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead']))
  with check (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead']));
create policy team_job_allocations_delete on team_job_allocations for delete to lakeandpine_app
  using (private.can_access_team(organization_id, team_id, array['owner','gm']));

drop policy lakeandpine_app_all_team_service_territories on team_service_territories;
create policy team_service_territories_read on team_service_territories for select to lakeandpine_app
  using (private.can_access_team(
    organization_id, team_id, array['owner','gm','manager','shift_lead','cleaner']));
create policy team_service_territories_insert on team_service_territories for insert to lakeandpine_app
  with check (private.can_access_organization(organization_id, array['owner','gm']));
create policy team_service_territories_update on team_service_territories for update to lakeandpine_app
  using (private.can_access_organization(organization_id, array['owner','gm']))
  with check (private.can_access_organization(organization_id, array['owner','gm']));
create policy team_service_territories_delete on team_service_territories for delete to lakeandpine_app
  using (private.can_access_organization(organization_id, array['owner','gm']));

drop policy lakeandpine_app_all_inventory_products on inventory_products;
create policy inventory_products_read on inventory_products for select to lakeandpine_app
  using (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead','cleaner']));
create policy inventory_products_insert on inventory_products for insert to lakeandpine_app
  with check (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead']));
create policy inventory_products_update on inventory_products for update to lakeandpine_app
  using (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead']))
  with check (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead']));
create policy inventory_products_delete on inventory_products for delete to lakeandpine_app
  using (private.can_access_team(organization_id, team_id, array['owner','gm']));

drop policy lakeandpine_app_all_inventory_locations on inventory_locations;
create policy inventory_locations_read on inventory_locations for select to lakeandpine_app
  using (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead','cleaner']));
create policy inventory_locations_insert on inventory_locations for insert to lakeandpine_app
  with check (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead']));
create policy inventory_locations_update on inventory_locations for update to lakeandpine_app
  using (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead']))
  with check (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead']));
create policy inventory_locations_delete on inventory_locations for delete to lakeandpine_app
  using (private.can_access_team(organization_id, team_id, array['owner','gm']));

drop policy lakeandpine_app_all_inventory_stock on inventory_stock;
create policy inventory_stock_read on inventory_stock for select to lakeandpine_app
  using (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead','cleaner']));
create policy inventory_stock_insert on inventory_stock for insert to lakeandpine_app
  with check (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead']));
create policy inventory_stock_update on inventory_stock for update to lakeandpine_app
  using (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead'])
    or (private.can_access_team(organization_id, team_id, array['cleaner'])
      and current_setting('lakeandpine.inventory_ledger_write', true) = '1'
      and pg_trigger_depth() > 0)
  )
  with check (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead'])
    or (private.can_access_team(organization_id, team_id, array['cleaner'])
      and current_setting('lakeandpine.inventory_ledger_write', true) = '1'
      and pg_trigger_depth() > 0)
  );
create policy inventory_stock_delete on inventory_stock for delete to lakeandpine_app
  using (false);

drop policy lakeandpine_app_all_inventory_transactions on inventory_transactions;
create policy inventory_transactions_read on inventory_transactions for select to lakeandpine_app
  using (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead'])
    or cleaner_id = private.current_cleaner_id()
  );
create policy inventory_transactions_insert on inventory_transactions for insert to lakeandpine_app
  with check (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or (private.can_access_team(organization_id, team_id, array['shift_lead'])
      and (private.current_customer_id() is not null
        or cleaner_id = private.current_cleaner_id()))
    or (private.can_access_team(organization_id, team_id, array['cleaner'])
      and cleaner_id = private.current_cleaner_id()
      and transaction_type = 'usage'
      and quantity_delta < 0)
  );
create policy inventory_transactions_update_denied on inventory_transactions for update to lakeandpine_app
  using (false) with check (false);
create policy inventory_transactions_delete_denied on inventory_transactions for delete to lakeandpine_app
  using (false);

drop policy lakeandpine_app_all_restock_requests on restock_requests;
create policy restock_requests_read on restock_requests for select to lakeandpine_app
  using (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead'])
    or private.is_current_membership(requested_by_membership_id)
    or (request_source = 'automatic_threshold'
      and private.can_access_team(organization_id, team_id, array['cleaner']))
  );
create policy restock_requests_insert on restock_requests for insert to lakeandpine_app
  with check (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead'])
    or (private.can_access_team(organization_id, team_id, array['cleaner'])
      and private.is_current_membership(requested_by_membership_id))
    or (request_source = 'automatic_threshold'
      and requested_by_membership_id is null
      and pg_trigger_depth() > 0
      and private.can_access_team(
        organization_id, team_id, array['owner','gm','manager','shift_lead','cleaner']))
  );
create policy restock_requests_update on restock_requests for update to lakeandpine_app
  using (private.can_access_team(organization_id, team_id, array['owner','gm','manager']))
  with check (private.can_access_team(organization_id, team_id, array['owner','gm','manager']));
create policy restock_requests_delete on restock_requests for delete to lakeandpine_app
  using (private.can_access_team(organization_id, team_id, array['owner','gm']));

drop policy lakeandpine_app_all_job_time_entries on job_time_entries;
create policy job_time_entries_read on job_time_entries for select to lakeandpine_app
  using (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead'])
    or cleaner_id = private.current_cleaner_id()
  );
create policy job_time_entries_insert on job_time_entries for insert to lakeandpine_app
  with check (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or (private.can_access_team(organization_id, team_id, array['cleaner','shift_lead'])
      and cleaner_id = private.current_cleaner_id()
      and status = 'open' and source = 'crew_timer' and clock_out_at is null
      and break_minutes = 0 and approved_by_membership_id is null
      and approved_at is null and adjustment_reason is null and version = 1)
  );
create policy job_time_entries_update on job_time_entries for update to lakeandpine_app
  using (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or cleaner_id = private.current_cleaner_id()
  )
  with check (
    private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
    or (private.can_access_team(organization_id, team_id, array['cleaner','shift_lead'])
      and cleaner_id = private.current_cleaner_id()
      and status in ('open','submitted')
      and source = 'crew_timer'
      and approved_by_membership_id is null
      and approved_at is null
      and adjustment_reason is null)
  );
create policy job_time_entries_delete on job_time_entries for delete to lakeandpine_app
  using (private.can_access_team(organization_id, team_id, array['owner','gm']));

drop policy lakeandpine_app_all_compensation_rates on compensation_rates;
create policy compensation_rates_read on compensation_rates for select to lakeandpine_app
  using (
    private.can_manage_financial_subject(
      organization_id, team_id, workforce_membership_id
    )
    or private.is_current_membership(workforce_membership_id)
  );
create policy compensation_rates_insert on compensation_rates for insert to lakeandpine_app
  with check (private.can_manage_financial_subject(
    organization_id, team_id, workforce_membership_id
  ));
create policy compensation_rates_update on compensation_rates for update to lakeandpine_app
  using (private.can_manage_financial_subject(
    organization_id, team_id, workforce_membership_id
  ))
  with check (private.can_manage_financial_subject(
    organization_id, team_id, workforce_membership_id
  ));
create policy compensation_rates_delete on compensation_rates for delete to lakeandpine_app
  using (false);

drop policy lakeandpine_app_all_review_bonus_tiers on review_bonus_tiers;
create policy review_bonus_tiers_read on review_bonus_tiers for select to lakeandpine_app
  using (
    private.can_access_organization(organization_id, array['owner','gm'])
    or (team_id is null
      and private.can_access_organization(organization_id, array['manager']))
    or (team_id is not null
      and private.can_access_team(organization_id, team_id, array['manager']))
  );
create policy review_bonus_tiers_insert on review_bonus_tiers for insert to lakeandpine_app
  with check (
    private.can_access_organization(organization_id, array['owner','gm'])
    or (team_id is not null
      and private.can_access_team(organization_id, team_id, array['manager']))
  );
create policy review_bonus_tiers_update on review_bonus_tiers for update to lakeandpine_app
  using (
    private.can_access_organization(organization_id, array['owner','gm'])
    or (team_id is not null
      and private.can_access_team(organization_id, team_id, array['manager']))
  )
  with check (
    private.can_access_organization(organization_id, array['owner','gm'])
    or (team_id is not null
      and private.can_access_team(organization_id, team_id, array['manager']))
  );
create policy review_bonus_tiers_delete on review_bonus_tiers for delete to lakeandpine_app
  using (private.can_access_organization(organization_id, array['owner','gm']));

drop policy lakeandpine_app_all_quality_reviews on quality_reviews;
create policy quality_reviews_read on quality_reviews for select to lakeandpine_app
  using (private.can_access_team(organization_id, team_id, array['owner','gm','manager','shift_lead']));
create policy quality_reviews_insert on quality_reviews for insert to lakeandpine_app
  with check (private.can_access_team(organization_id, team_id, array['owner','gm','manager']));
create policy quality_reviews_update on quality_reviews for update to lakeandpine_app
  using (false) with check (false);
create policy quality_reviews_delete on quality_reviews for delete to lakeandpine_app
  using (false);

drop policy lakeandpine_app_all_bonus_awards on bonus_awards;
create policy bonus_awards_read on bonus_awards for select to lakeandpine_app
  using (
    private.can_manage_financial_subject(
      organization_id, team_id, workforce_membership_id
    )
    or private.is_current_membership(workforce_membership_id)
  );
create policy bonus_awards_insert on bonus_awards for insert to lakeandpine_app
  with check (private.can_manage_financial_subject(
    organization_id, team_id, workforce_membership_id
  ));
create policy bonus_awards_update on bonus_awards for update to lakeandpine_app
  using (private.can_manage_financial_subject(
    organization_id, team_id, workforce_membership_id
  ))
  with check (private.can_manage_financial_subject(
    organization_id, team_id, workforce_membership_id
  ));
create policy bonus_awards_delete on bonus_awards for delete to lakeandpine_app
  using (false);

drop policy lakeandpine_app_all_workforce_events on workforce_events;
create policy workforce_events_read on workforce_events for select to lakeandpine_app
  using (private.can_read_workforce_event(
    organization_id, team_id, subject_membership_id, event_type
  ));
create policy workforce_events_insert on workforce_events for insert to lakeandpine_app
  with check (private.can_create_workforce_event(
    organization_id, team_id, subject_membership_id, event_type,
    created_by_membership_id
  ));
create policy workforce_events_update on workforce_events for update to lakeandpine_app
  using (false) with check (false);
create policy workforce_events_delete on workforce_events for delete to lakeandpine_app
  using (false);

grant execute on function guard_compensation_rate_overlap() to lakeandpine_app;
grant execute on function guard_compensation_rate_history() to lakeandpine_app;
grant execute on function guard_workforce_membership_history() to lakeandpine_app;
grant execute on function validate_scoped_actor_membership() to lakeandpine_app;
grant execute on function validate_scoped_subject_membership() to lakeandpine_app;
grant execute on function validate_quality_review_evidence() to lakeandpine_app;
grant execute on function guard_bonus_award_transition() to lakeandpine_app;
grant execute on function guard_restock_request_lifecycle() to lakeandpine_app;
grant execute on function reject_workforce_event_mutation() to lakeandpine_app;
grant execute on function validate_team_job_allocation() to lakeandpine_app;
grant execute on function validate_team_assignment_membership() to lakeandpine_app;
grant execute on function validate_team_time_entry() to lakeandpine_app;
grant execute on function guard_inventory_stock_write() to lakeandpine_app;
grant execute on function apply_inventory_transaction() to lakeandpine_app;
grant execute on function create_threshold_restock_draft() to lakeandpine_app;
grant execute on function reject_inventory_transaction_mutation() to lakeandpine_app;
grant execute on function create_verified_review_bonus() to lakeandpine_app;
grant usage on schema private to lakeandpine_app;
grant execute on function private.current_customer_id() to lakeandpine_app;
grant execute on function private.current_cleaner_id() to lakeandpine_app;
grant execute on function private.can_access_organization(uuid, text[]) to lakeandpine_app;
grant execute on function private.can_access_team(uuid, uuid, text[]) to lakeandpine_app;
grant execute on function private.is_current_membership(uuid) to lakeandpine_app;
grant execute on function private.can_manage_financial_subject(uuid, uuid, uuid) to lakeandpine_app;
grant execute on function private.subject_available_to_local_team(uuid, uuid, uuid, uuid) to lakeandpine_app;
grant execute on function private.guard_team_assignment_clean_room() to lakeandpine_app;
grant execute on function private.can_read_workforce_event(uuid, uuid, uuid, text) to lakeandpine_app;
grant execute on function private.can_create_workforce_event(uuid, uuid, uuid, text, uuid) to lakeandpine_app;
grant execute on function private.lock_current_workforce_access(uuid) to lakeandpine_app;
grant execute on function private.lock_team_crew_memberships(uuid, uuid) to lakeandpine_app;
grant execute on function private.lock_active_team_territory_coverage(uuid, uuid, uuid) to lakeandpine_app;
grant execute on function private.bootstrap_lakeandpine_owner(uuid) to lakeandpine_app;
grant execute on function private.guard_crew_time_entry_update() to lakeandpine_app;
grant execute on function private.guard_self_financial_control() to lakeandpine_app;
grant execute on function private.validate_service_case_team_assignment() to lakeandpine_app;
grant execute on function private.assign_booking_cases_from_allocation() to lakeandpine_app;

comment on table workforce_memberships is
  'Effective operating access. Organization-wide owner/GM roles have no team; all other roles are team scoped.';
comment on table inventory_transactions is
  'Immutable team stock ledger. Correct errors with a new adjustment; never rewrite usage history.';
comment on table restock_requests is
  'Approval-gated replenishment drafts. Automatic thresholds never place an order or spend money.';
comment on table compensation_rates is
  'Effective-dated compensation control record only; no payroll funds are moved by this application.';
comment on table bonus_awards is
  'Bonus approval/export ledger. recorded_paid requires external evidence and does not move money.';
comment on table workforce_events is
  'Policy-neutral workforce evidence; incidents and warnings never trigger automatic termination.';
