-- Install legacy-table guards and replace broad policies only after the scoped
-- authorization functions exist. Traffic must remain drained across the complete
-- migration batch so no request can observe the short between-migration window.

set local lock_timeout = '5s';
set local statement_timeout = '2min';

lock table cleaner_time_off, cleaning_teams, job_assignments, service_cases
  in access exclusive mode;

create trigger service_cases_team_assignment_guard
  before insert or update of booking_id, assigned_team_id on public.service_cases
  for each row execute function private.validate_service_case_team_assignment();

create trigger job_assignments_team_membership_guard
  before insert or update of team_id, cleaner_id on public.job_assignments
  for each row execute function public.validate_team_assignment_membership();

update public.service_cases service_case
set assigned_team_id = allocation.team_id
from public.job_schedules schedule
join public.team_job_allocations allocation
  on allocation.job_schedule_id = schedule.id
where service_case.booking_id = schedule.booking_id
  and service_case.assigned_team_id is null;

drop policy lakeandpine_app_all_cleaner_time_off on cleaner_time_off;
create policy cleaner_time_off_read on cleaner_time_off for select to lakeandpine_app
  using (
    cleaner_id = private.current_cleaner_id()
    or (organization_id is not null and team_id is not null
      and private.can_access_team(
        organization_id, team_id, array['owner','gm','manager','shift_lead']))
  );
create policy cleaner_time_off_insert on cleaner_time_off for insert to lakeandpine_app
  with check (
    cleaner_id = private.current_cleaner_id()
    and organization_id is not null and team_id is not null
    and private.can_access_team(organization_id, team_id, array['cleaner','shift_lead'])
  );
create policy cleaner_time_off_update on cleaner_time_off for update to lakeandpine_app
  using (
    organization_id is not null and team_id is not null
    and private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
  )
  with check (
    organization_id is not null and team_id is not null
    and private.can_access_team(organization_id, team_id, array['owner','gm','manager'])
  );
create policy cleaner_time_off_delete on cleaner_time_off for delete to lakeandpine_app
  using (false);

drop policy lakeandpine_app_all_cleaning_teams on cleaning_teams;
create policy cleaning_teams_scoped_read on cleaning_teams for select to lakeandpine_app
  using (private.can_access_team(organization_id, id, array['owner','gm','manager','shift_lead','cleaner']));
create policy cleaning_teams_scoped_insert on cleaning_teams for insert to lakeandpine_app
  with check (private.can_access_organization(organization_id, array['owner','gm']));
create policy cleaning_teams_scoped_update on cleaning_teams for update to lakeandpine_app
  using (private.can_access_team(organization_id, id, array['owner','gm','manager']))
  with check (private.can_access_team(organization_id, id, array['owner','gm','manager']));
create policy cleaning_teams_scoped_delete on cleaning_teams for delete to lakeandpine_app
  using (private.can_access_team(organization_id, id, array['owner','gm']));
