-- Lake & Pine core domain schema.
-- Applies to any Postgres (local dev container now, dedicated Supabase project at go-live).
-- Server-only data access: RLS is enabled everywhere with public-read policies ONLY on
-- published content tables; transactional tables have no policies (deny by default —
-- the app reaches them through a server-side connection that owns the tables).

create table services (
  id text primary key,
  title text not null,
  icon text not null,
  blurb text not null,
  price_label text not null,
  starting_price_cents integer,
  tags text[] not null default '{}',
  bookable boolean not null default true,
  sort integer not null default 0,
  active boolean not null default true
);

create table addons (
  id text primary key,
  title text not null,
  price_label text not null,
  price_cents integer,
  sort integer not null default 0,
  active boolean not null default true
);

create table plans (
  id text primary key,
  name text not null,
  price_cents integer not null,
  save_label text not null,
  popular boolean not null default false,
  features text[] not null default '{}',
  sort integer not null default 0
);

create table service_areas (
  slug text primary key,
  city text not null,
  state text not null,
  seo_phrase text not null,
  headline text not null,
  intro text not null,
  neighborhoods text[] not null default '{}',
  highlights jsonb not null default '[]',
  faqs jsonb not null default '[]',
  lat double precision,
  lng double precision,
  sort integer not null default 0,
  active boolean not null default true
);

create table faqs (
  id bigint generated always as identity primary key,
  question text not null,
  answer text not null,
  sort integer not null default 0,
  active boolean not null default true
);

create table reviews (
  id uuid primary key default gen_random_uuid(),
  author_initial text not null,
  author_name text not null,
  city text not null,
  body text not null,
  rating integer not null default 5 check (rating between 1 and 5),
  source text not null default 'placeholder',
  published boolean not null default true,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now()
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text unique,
  email text unique,
  full_name text,
  phone text,
  role text not null default 'customer' check (role in ('customer', 'staff')),
  referral_credit_cents integer not null default 0,
  stripe_customer_id text unique,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table homes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  label text not null default 'Home',
  address_line text,
  city text,
  state text,
  zip text,
  size_band text,
  bedrooms text,
  bathrooms text,
  pets text,
  condition text,
  access_notes text,
  preference_tags text[] not null default '{}',
  cleaner_notes text,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table quotes (
  id uuid primary key default gen_random_uuid(),
  service_id text references services(id),
  inputs jsonb not null,
  estimate_cents integer not null,
  email text,
  customer_id uuid references customers(id),
  source text not null default 'estimate_studio',
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now()
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  zip text not null,
  service_id text references services(id),
  preferred_date date,
  email text,
  phone text,
  status text not null default 'new' check (status in ('new', 'contacted', 'converted', 'closed')),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now()
);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id),
  home_id uuid references homes(id),
  service_id text not null references services(id),
  addon_ids text[] not null default '{}',
  frequency text not null default 'onetime'
    check (frequency in ('weekly', 'biweekly', 'monthly', 'onetime')),
  scheduled_date date not null,
  scheduled_window text not null,
  status text not null default 'requested'
    check (status in ('requested', 'confirmed', 'completed', 'canceled')),
  estimate_cents integer,
  quote_id uuid references quotes(id),
  contact jsonb not null,
  home_details jsonb not null default '{}',
  access_notes text,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table booking_events (
  id bigint generated always as identity primary key,
  booking_id uuid not null references bookings(id) on delete cascade,
  type text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table billing_records (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id),
  booking_id uuid references bookings(id),
  description text not null,
  amount_cents integer not null,
  status text not null default 'due' check (status in ('due', 'paid', 'refunded', 'void')),
  stripe_payment_intent_id text,
  stripe_invoice_id text,
  occurred_at timestamptz not null default now(),
  is_dev_seed boolean not null default false
);

create table support_messages (
  id bigint generated always as identity primary key,
  customer_id uuid not null references customers(id) on delete cascade,
  sender text not null check (sender in ('customer', 'staff', 'concierge')),
  body text not null,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now()
);

create index bookings_customer_idx on bookings (customer_id, scheduled_date);
create index bookings_status_idx on bookings (status, scheduled_date);
create index booking_events_booking_idx on booking_events (booking_id, created_at);
create index quotes_created_idx on quotes (created_at);
create index leads_status_idx on leads (status, created_at);
create index support_customer_idx on support_messages (customer_id, created_at);
create index billing_customer_idx on billing_records (customer_id, occurred_at);
create index homes_customer_idx on homes (customer_id);

create function set_updated_at() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

create trigger customers_updated_at before update on customers
  for each row execute function set_updated_at();
create trigger homes_updated_at before update on homes
  for each row execute function set_updated_at();
create trigger bookings_updated_at before update on bookings
  for each row execute function set_updated_at();

alter table services enable row level security;
alter table addons enable row level security;
alter table plans enable row level security;
alter table service_areas enable row level security;
alter table faqs enable row level security;
alter table reviews enable row level security;
alter table customers enable row level security;
alter table homes enable row level security;
alter table quotes enable row level security;
alter table leads enable row level security;
alter table bookings enable row level security;
alter table booking_events enable row level security;
alter table billing_records enable row level security;
alter table support_messages enable row level security;

create policy services_public_read on services for select using (active);
create policy addons_public_read on addons for select using (active);
create policy plans_public_read on plans for select using (true);
create policy service_areas_public_read on service_areas for select using (active);
create policy faqs_public_read on faqs for select using (active);
create policy reviews_public_read on reviews for select using (published);
