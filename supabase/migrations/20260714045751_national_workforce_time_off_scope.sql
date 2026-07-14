-- Create workforce scope, then extend the legacy time-off table under a short,
-- explicit lock. The bounded probe is lock-adjacent and cannot race writes.

set local lock_timeout = '5s';
set local statement_timeout = '2min';

create table workforce_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  team_id uuid,
  customer_id uuid references customers(id) on delete restrict,
  cleaner_id uuid references cleaners(id) on delete restrict,
  role text not null check (role in ('owner', 'gm', 'manager', 'shift_lead', 'cleaner')),
  status text not null default 'active'
    check (status in ('invited', 'active', 'paused', 'ended')),
  title text,
  hired_at date,
  ended_at date,
  status_reason text check (status_reason is null or char_length(status_reason) <= 1000),
  status_changed_by_membership_id uuid references workforce_memberships(id) on delete set null,
  status_changed_at timestamptz,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workforce_memberships_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id),
  constraint workforce_memberships_one_identity_check
    check ((customer_id is not null)::integer + (cleaner_id is not null)::integer = 1),
  constraint workforce_memberships_role_scope_check check (
    (role in ('owner', 'gm') and team_id is null and customer_id is not null)
    or (role = 'manager' and team_id is not null and customer_id is not null)
    -- Shift leads intentionally support two mutually exclusive identities:
    -- staff-backed dispatch supervisors and cleaner-backed field leads.
    or (role = 'shift_lead' and team_id is not null)
    or (role = 'cleaner' and team_id is not null and cleaner_id is not null)
  ),
  check (ended_at is null or hired_at is null or ended_at >= hired_at)
);

create unique index workforce_active_staff_team_idx
  on workforce_memberships (organization_id, team_id, customer_id)
  where status = 'active' and customer_id is not null;
create unique index workforce_active_staff_organization_idx
  on workforce_memberships (organization_id, customer_id)
  where status = 'active' and team_id is null and customer_id is not null;
create unique index workforce_active_cleaner_team_idx
  on workforce_memberships (organization_id, team_id, cleaner_id)
  where status = 'active' and cleaner_id is not null;
create unique index workforce_one_active_owner_idx
  on workforce_memberships (organization_id)
  where role = 'owner' and status = 'active';
create index workforce_customer_scope_idx
  on workforce_memberships (customer_id, status, organization_id, team_id)
  where customer_id is not null;
create index workforce_cleaner_scope_idx
  on workforce_memberships (cleaner_id, status, organization_id, team_id)
  where cleaner_id is not null;
create index workforce_status_actor_idx
  on workforce_memberships (status_changed_by_membership_id)
  where status_changed_by_membership_id is not null;
alter table workforce_memberships
  add constraint workforce_memberships_scope_id_key
  unique (organization_id, team_id, id);

insert into workforce_memberships
  (organization_id, team_id, cleaner_id, role, status, title, hired_at, is_dev_seed)
select team.organization_id, member.team_id, member.cleaner_id,
       case when member.team_role = 'lead' then 'shift_lead' else 'cleaner' end,
       'active', case when member.team_role = 'lead' then 'Legacy team lead' else 'Cleaner' end,
       member.effective_from, team.is_dev_seed or cleaner.is_dev_seed
from cleaning_team_members member
join cleaning_teams team on team.id = member.team_id
join cleaners cleaner on cleaner.id = member.cleaner_id
where member.effective_to is null
on conflict do nothing;

lock table cleaner_time_off in access exclusive mode;

do $$
begin
  if exists (select 1 from cleaner_time_off offset 100000 limit 1) then
    raise exception 'cleaner_time_off requires a separately reviewed online migration';
  end if;
end
$$;

alter table cleaner_time_off
  add column organization_id uuid,
  add column team_id uuid,
  add column reviewed_by_membership_id uuid,
  add constraint cleaner_time_off_organization_id_fkey
    foreign key (organization_id) references organizations(id) on delete cascade not valid,
  add constraint cleaner_time_off_reviewed_by_membership_id_fkey
    foreign key (reviewed_by_membership_id) references workforce_memberships(id)
    on delete set null not valid,
  add constraint cleaner_time_off_team_fkey
    foreign key (organization_id, team_id)
    references cleaning_teams (organization_id, id) not valid;

with first_membership as (
  select distinct on (candidate.cleaner_id)
    candidate.cleaner_id, candidate.organization_id, candidate.team_id
  from workforce_memberships candidate
  where candidate.team_id is not null and candidate.status = 'active'
  order by candidate.cleaner_id, candidate.created_at
)
update cleaner_time_off time_off
set organization_id = membership.organization_id,
    team_id = membership.team_id
from first_membership membership
where time_off.organization_id is null
  and membership.cleaner_id = time_off.cleaner_id;

alter table cleaner_time_off validate constraint cleaner_time_off_organization_id_fkey;
alter table cleaner_time_off validate constraint cleaner_time_off_reviewed_by_membership_id_fkey;
alter table cleaner_time_off validate constraint cleaner_time_off_team_fkey;

create index cleaner_time_off_team_status_idx
  on cleaner_time_off (organization_id, team_id, status, start_at)
  where organization_id is not null and team_id is not null;
create index cleaner_time_off_reviewer_idx
  on cleaner_time_off (reviewed_by_membership_id)
  where reviewed_by_membership_id is not null;

-- The new workforce table fails closed. Keep the legacy time-off policy until
-- the final cutover so the pre-national application remains a valid rollback
-- target before version 45753.
alter table workforce_memberships enable row level security;
alter table cleaner_time_off enable row level security;
