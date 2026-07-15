-- Establish the national organization boundary in a short committed migration.
-- The explicit legacy-table lock is acquired only after the new organization
-- row exists, and the bounded probe runs while writes are blocked so its result
-- cannot race a concurrent insert.

set local lock_timeout = '5s';
set local statement_timeout = '2min';

create table organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null check (char_length(name) between 2 and 120),
  status text not null default 'active' check (status in ('active', 'paused')),
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into organizations (slug, name)
values ('lake-and-pine', 'Lake & Pine')
on conflict (slug) do nothing;

lock table cleaning_teams in access exclusive mode;

do $$
begin
  if exists (select 1 from cleaning_teams offset 10000 limit 1) then
    raise exception 'cleaning_teams requires a separately reviewed online migration';
  end if;
end
$$;

alter table cleaning_teams
  add column organization_id uuid,
  add column timezone text not null default 'America/Los_Angeles',
  add column region_label text;

update cleaning_teams
set organization_id = (select id from organizations where slug = 'lake-and-pine')
where organization_id is null;

alter table cleaning_teams
  add constraint cleaning_teams_organization_id_fkey
    foreign key (organization_id) references organizations(id) not valid,
  add constraint cleaning_teams_organization_id_not_null_check
    check (organization_id is not null) not valid;
alter table cleaning_teams validate constraint cleaning_teams_organization_id_fkey;
alter table cleaning_teams validate constraint cleaning_teams_organization_id_not_null_check;
alter table cleaning_teams alter column organization_id set not null;
alter table cleaning_teams drop constraint cleaning_teams_organization_id_not_null_check;
alter table cleaning_teams
  add constraint cleaning_teams_organization_id_id_key unique (organization_id, id);

-- The new table fails closed until the main migration installs actor-scoped
-- policies. The legacy team policy remains in place until the final cutover so
-- the pre-national application can still be restored before version 45753.
alter table organizations enable row level security;
alter table cleaning_teams enable row level security;
