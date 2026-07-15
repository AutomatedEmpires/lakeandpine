-- Exact field actor evidence -------------------------------------------------
-- Browser code may select a target record, but it may not select the employee
-- identity or evidence timestamp recorded for an action. Derive those facts
-- from the authenticated database context and expose only the columns each
-- workflow is allowed to propose.

create function private.stamp_schedule_proposal_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor record;
begin
  if not private.application_role_is_active() then
    return new;
  end if;
  if private.current_cleaner_id() is not null
    or private.current_customer_id() is null then
    raise exception 'Schedule proposals require one authenticated staff actor'
      using errcode = '42501';
  end if;
  select * into actor
  from private.current_actor_for_scope(new.organization_id, new.team_id);
  if actor.actor_membership_id is null
    or actor.actor_role not in ('owner', 'gm', 'manager') then
    raise exception 'Schedule proposals require exact scoped scheduling authority'
      using errcode = '42501';
  end if;
  perform schedule.id
  from public.job_schedules schedule
  where schedule.id = new.job_schedule_id
  for update;
  if not found then
    raise exception 'Schedule proposal job does not exist'
      using errcode = '23503';
  end if;
  new.status := 'pending_customer';
  new.version := (
    select coalesce(max(proposal.version), 0)::integer + 1
    from public.schedule_proposals proposal
    where proposal.job_schedule_id = new.job_schedule_id
  );
  new.proposed_by_membership_id := actor.actor_membership_id;
  new.customer_response_note := null;
  new.responded_at := null;
  return new;
end
$$;

create trigger aaa_schedule_proposals_exact_actor
  before insert on public.schedule_proposals for each row
  execute function private.stamp_schedule_proposal_evidence();

create function private.stamp_job_communication_actor() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor record;
begin
  if not private.application_role_is_active() then
    return new;
  end if;
  new.sender_membership_id := null;
  new.sender_cleaner_id := null;
  new.sender_customer_id := null;
  if new.sender_kind = 'customer' then
    if private.current_customer_id() is null
      or private.current_cleaner_id() is not null then
      raise exception 'Customer communication requires one customer actor'
        using errcode = '42501';
    end if;
    new.sender_customer_id := private.current_customer_id();
  elsif new.sender_kind = 'cleaner' then
    if private.current_cleaner_id() is null
      or private.current_customer_id() is not null then
      raise exception 'Cleaner communication requires one cleaner actor'
        using errcode = '42501';
    end if;
    select * into actor
    from private.current_actor_for_scope(new.organization_id, new.team_id);
    if actor.actor_membership_id is null
      or actor.actor_role not in ('cleaner', 'shift_lead') then
      raise exception 'Cleaner communication requires an exact active branch membership'
        using errcode = '42501';
    end if;
    new.sender_membership_id := actor.actor_membership_id;
    new.sender_cleaner_id := private.current_cleaner_id();
  elsif new.sender_kind = 'staff' then
    if private.current_customer_id() is null
      or private.current_cleaner_id() is not null then
      raise exception 'Staff communication requires one staff actor'
        using errcode = '42501';
    end if;
    select * into actor
    from private.current_actor_for_scope(new.organization_id, new.team_id);
    if actor.actor_membership_id is null
      or actor.actor_role not in ('owner', 'gm', 'manager', 'shift_lead') then
      raise exception 'Staff communication requires exact branch authority'
        using errcode = '42501';
    end if;
    new.sender_membership_id := actor.actor_membership_id;
  elsif new.sender_kind = 'system' then
    if private.current_customer_id() is not null
      or private.current_cleaner_id() is not null then
      raise exception 'System communication cannot be selected by an application actor'
        using errcode = '42501';
    end if;
  end if;
  -- Direct application messages are durable in-app records. A future delivery
  -- worker must use a bounded definer function to add provider receipts.
  new.channel := 'in_app';
  new.delivery_status := 'recorded';
  new.provider_message_id := null;
  new.delivery_error := null;
  return new;
end
$$;

create trigger aaa_job_communications_exact_actor
  before insert on public.job_communications for each row
  execute function private.stamp_job_communication_actor();

create function private.stamp_location_exception_actor() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor record;
begin
  if not private.application_role_is_active() then
    return new;
  end if;
  if new.assessment_status = 'approved_exception'
    and old.assessment_status <> 'approved_exception' then
    select * into actor
    from private.current_actor_for_scope(new.organization_id, new.team_id);
    if actor.actor_membership_id is null
      or actor.actor_role not in ('owner', 'gm', 'manager') then
      raise exception 'Route exceptions require exact branch management authority'
        using errcode = '42501';
    end if;
    new.override_by_membership_id := actor.actor_membership_id;
  elsif old.assessment_status = 'approved_exception'
    and new.assessment_status <> 'approved_exception' then
    new.override_by_membership_id := null;
    new.override_reason := null;
  end if;
  return new;
end
$$;

create trigger aaa_service_location_exception_exact_actor
  before update of assessment_status, override_by_membership_id, override_reason
  on public.service_location_assessments for each row
  execute function private.stamp_location_exception_actor();

create function private.stamp_mileage_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor_membership record;
  actor record;
begin
  if not private.application_role_is_active() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if private.current_cleaner_id() is null
      or private.current_customer_id() is not null
      or new.cleaner_id is distinct from private.current_cleaner_id() then
      raise exception 'Mileage submission requires its authenticated cleaner'
        using errcode = '42501';
    end if;
    select membership.id, membership.role into actor_membership
    from public.workforce_memberships membership
    where membership.organization_id = new.organization_id
      and membership.team_id = new.team_id
      and membership.cleaner_id = private.current_cleaner_id()
      and membership.status = 'active'
      and membership.role in ('cleaner', 'shift_lead')
    order by case membership.role when 'shift_lead' then 0 else 1 end,
      membership.id
    limit 1
    for share of membership;
    if not found then
      raise exception 'Mileage submission requires an exact active branch membership'
        using errcode = '42501';
    end if;
    new.workforce_membership_id := actor_membership.id;
    new.status := 'submitted';
    new.reviewed_by_membership_id := null;
    new.reviewed_at := null;
    new.review_note := null;
    new.version := 1;
    return new;
  end if;
  if private.current_cleaner_id() = old.cleaner_id
    and private.current_customer_id() is null then
    return new;
  end if;
  if private.current_cleaner_id() is not null
    or private.current_customer_id() is null then
    raise exception 'Mileage review requires one authenticated manager'
      using errcode = '42501';
  end if;
  select * into actor
  from private.current_actor_for_scope(old.organization_id, old.team_id);
  if actor.actor_membership_id is null
    or actor.actor_role not in ('owner', 'gm', 'manager') then
    raise exception 'Mileage review requires exact branch management authority'
      using errcode = '42501';
  end if;
  new.reviewed_by_membership_id := actor.actor_membership_id;
  new.reviewed_at := clock_timestamp();
  new.version := old.version + 1;
  return new;
end
$$;

create trigger aaa_mileage_entries_exact_evidence
  before insert or update on public.mileage_entries for each row
  execute function private.stamp_mileage_evidence();

drop policy mileage_entries_read on public.mileage_entries;
create policy mileage_entries_read
  on public.mileage_entries for select to lakeandpine_app using (
    private.can_access_team(
      organization_id, team_id, array['owner', 'gm', 'manager']
    )
    or (cleaner_id = private.current_cleaner_id()
      and private.current_customer_id() is null)
  );

create function private.stamp_job_issue_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor_membership record;
  actor record;
begin
  if not private.application_role_is_active() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if private.current_cleaner_id() is not null
      and private.current_customer_id() is null then
      select membership.id, membership.role into actor_membership
      from public.workforce_memberships membership
      where membership.organization_id = new.organization_id
        and membership.team_id = new.team_id
        and membership.cleaner_id = private.current_cleaner_id()
        and membership.status = 'active'
        and membership.role in ('cleaner', 'shift_lead')
      order by case membership.role when 'shift_lead' then 0 else 1 end,
        membership.id
      limit 1
      for share of membership;
      if not found then
        raise exception 'Field issue requires an exact active cleaner membership'
          using errcode = '42501';
      end if;
      new.reported_by_membership_id := actor_membership.id;
      new.reported_by_cleaner_id := private.current_cleaner_id();
    elsif private.current_cleaner_id() is null
      and private.current_customer_id() is not null then
      select * into actor
      from private.current_actor_for_scope(new.organization_id, new.team_id);
      if actor.actor_membership_id is null
        or actor.actor_role not in ('owner', 'gm', 'manager', 'shift_lead') then
        raise exception 'Staff field issue requires exact branch authority'
          using errcode = '42501';
      end if;
      new.reported_by_membership_id := actor.actor_membership_id;
      new.reported_by_cleaner_id := null;
    else
      raise exception 'Field issue requires exactly one authenticated actor'
        using errcode = '42501';
    end if;
    new.status := 'open';
    new.customer_visible := false;
    new.assigned_to_membership_id := null;
    new.resolution_note := null;
    new.resolved_at := null;
    new.version := 1;
    return new;
  end if;
  if private.current_cleaner_id() is not null then
    raise exception 'Submitted field issues are immutable for the reporting cleaner'
      using errcode = '42501';
  end if;
  if private.current_customer_id() is null then
    raise exception 'Field issue decisions require one authenticated manager'
      using errcode = '42501';
  end if;
  select * into actor
  from private.current_actor_for_scope(old.organization_id, old.team_id);
  if actor.actor_membership_id is null
    or actor.actor_role not in ('owner', 'gm', 'manager') then
    raise exception 'Field issue decisions require exact branch management authority'
      using errcode = '42501';
  end if;
  new.assigned_to_membership_id := actor.actor_membership_id;
  new.resolved_at := case
    when new.status in ('resolved', 'dismissed') then clock_timestamp()
    else null
  end;
  new.version := old.version + 1;
  return new;
end
$$;

create trigger aaa_job_issue_reports_exact_evidence
  before insert or update on public.job_issue_reports for each row
  execute function private.stamp_job_issue_evidence();

create function private.audit_job_issue_state() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  booking_ref uuid;
  actor record;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  select schedule.booking_id into booking_ref
  from public.team_job_allocations allocation
  join public.job_schedules schedule on schedule.id = allocation.job_schedule_id
  where allocation.id = new.team_job_allocation_id
    and allocation.organization_id = new.organization_id
    and allocation.team_id = new.team_id;
  select * into actor
  from private.current_actor_for_scope(new.organization_id, new.team_id);
  insert into public.operations_state_events
    (entity_type, entity_id, booking_id, field_name, from_state, to_state,
     actor_role, actor_membership_id, event_data, is_dev_seed)
  values (
    'job_issue_reports', new.id, booking_ref, 'status',
    case when tg_op = 'INSERT' then null else old.status end,
    new.status, actor.actor_role,
    coalesce(
      actor.actor_membership_id,
      new.assigned_to_membership_id,
      new.reported_by_membership_id
    ),
    jsonb_build_object(
      'severity', new.severity,
      'customer_visible', new.customer_visible,
      'resolution_note', new.resolution_note
    ),
    new.is_dev_seed
  );
  return new;
end
$$;

create trigger job_issue_reports_state_audit
  after insert or update of status on public.job_issue_reports for each row
  execute function private.audit_job_issue_state();

create function private.stamp_team_duty_creator() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor record;
begin
  if not private.application_role_is_active() then
    return new;
  end if;
  if private.current_customer_id() is null
    or private.current_cleaner_id() is not null then
    raise exception 'Duty coverage requires one authenticated manager'
      using errcode = '42501';
  end if;
  select * into actor
  from private.current_actor_for_scope(new.organization_id, new.team_id);
  if actor.actor_membership_id is null
    or actor.actor_role not in ('owner', 'gm', 'manager') then
    raise exception 'Duty coverage requires exact branch management authority'
      using errcode = '42501';
  end if;
  new.created_by_membership_id := actor.actor_membership_id;
  new.status := case when new.starts_at <= clock_timestamp()
    then 'active' else 'scheduled' end;
  return new;
end
$$;

create trigger aaa_team_duty_assignments_exact_creator
  before insert on public.team_duty_assignments for each row
  execute function private.stamp_team_duty_creator();

alter table public.tip_intents
  drop constraint tip_intents_recorded_by_membership_id_fkey,
  add constraint tip_intents_recorded_by_membership_id_fkey
    foreign key (recorded_by_membership_id)
    references public.workforce_memberships(id) on delete restrict,
  add column decision_customer_id uuid
    references public.customers(id) on delete restrict,
  add column decision_at timestamptz;

update public.tip_intents
set decision_at = coalesce(decision_at, updated_at),
    decision_customer_id = case
      when recorded_by_membership_id is null then customer_id
      else null
    end
where status <> 'pending_collection' and decision_at is null;

alter table public.tip_intents
  add constraint tip_intents_decision_actor_check check (
    (status = 'pending_collection'
      and recorded_by_membership_id is null
      and decision_customer_id is null
      and decision_at is null)
    or (status <> 'pending_collection'
      and decision_at is not null
      and ((recorded_by_membership_id is not null)::integer
        + (decision_customer_id is not null)::integer = 1))
  );
create index tip_intents_decision_customer_idx
  on public.tip_intents (decision_customer_id, decision_at desc)
  where decision_customer_id is not null;

create function private.stamp_tip_decision_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor record;
begin
  if not private.application_role_is_active() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.status := 'pending_collection';
    new.provider := 'manual';
    new.provider_reference := null;
    new.recorded_by_membership_id := null;
    new.decision_customer_id := null;
    new.decision_at := null;
    new.version := 1;
    return new;
  end if;
  if private.current_cleaner_id() is not null then
    raise exception 'Cleaners cannot decide tip collection state'
      using errcode = '42501';
  end if;
  if private.current_customer_id() = old.customer_id then
    if new.status = 'pending_collection' then
      new.recorded_by_membership_id := null;
      new.decision_customer_id := null;
      new.decision_at := null;
    elsif new.status = 'canceled' then
      new.recorded_by_membership_id := null;
      new.decision_customer_id := private.current_customer_id();
      new.decision_at := clock_timestamp();
    end if;
    return new;
  end if;
  if private.current_customer_id() is null then
    raise exception 'Tip decisions require one authenticated manager or customer'
      using errcode = '42501';
  end if;
  select * into actor
  from private.current_actor_for_scope(old.organization_id, old.team_id);
  if actor.actor_membership_id is null
    or actor.actor_role not in ('owner', 'gm', 'manager') then
    raise exception 'Tip decisions require exact branch management authority'
      using errcode = '42501';
  end if;
  new.recorded_by_membership_id := actor.actor_membership_id;
  new.decision_customer_id := null;
  new.decision_at := clock_timestamp();
  return new;
end
$$;

create trigger aaa_tip_intents_exact_decision_actor
  before insert or update on public.tip_intents for each row
  execute function private.stamp_tip_decision_evidence();

revoke insert, update, delete on table public.schedule_proposals
  from lakeandpine_app;
grant insert (
  organization_id, team_id, team_job_allocation_id, job_schedule_id,
  service_case_id, proposed_start_at, proposed_end_at, customer_id,
  arrival_window_start, arrival_window_end, proposal_note, expires_at,
  is_dev_seed
) on table public.schedule_proposals to lakeandpine_app;
grant update (status, customer_response_note)
  on table public.schedule_proposals to lakeandpine_app;

revoke insert, update, delete on table public.service_location_assessments
  from lakeandpine_app;
grant insert (
  booking_id, organization_id, address_fingerprint, branch_origin_label,
  branch_origin_latitude, branch_origin_longitude, property_latitude,
  property_longitude, distance_miles, standard_radius_miles,
  calculation_method, assessment_status, provider,
  provider_resolved_address, provider_match_confidence,
  provider_coordinate_accuracy, calculated_at, is_dev_seed
) on table public.service_location_assessments to lakeandpine_app;
grant update (assessment_status, override_reason)
  on table public.service_location_assessments to lakeandpine_app;

revoke insert, update, delete on table public.job_communications
  from lakeandpine_app;
grant insert (
  organization_id, team_id, team_job_allocation_id, customer_id,
  sender_kind, audience, template_key, body, is_dev_seed
) on table public.job_communications to lakeandpine_app;

revoke insert, update, delete on table public.mileage_entries
  from lakeandpine_app;
grant insert (
  organization_id, team_id, cleaner_id, team_job_allocation_id,
  service_date, miles, purpose, vehicle_label, note, is_dev_seed
) on table public.mileage_entries to lakeandpine_app;
grant update (
  service_date, miles, purpose, vehicle_label, note, status, review_note
) on table public.mileage_entries to lakeandpine_app;

revoke insert, update, delete on table public.job_issue_reports
  from lakeandpine_app;
grant insert (
  organization_id, team_id, team_job_allocation_id, issue_type, severity,
  summary, private_details, is_dev_seed
) on table public.job_issue_reports to lakeandpine_app;
grant update (status, customer_visible, resolution_note)
  on table public.job_issue_reports to lakeandpine_app;

revoke insert, update, delete on table public.team_duty_assignments
  from lakeandpine_app;
grant insert (
  organization_id, team_id, workforce_membership_id, starts_at, ends_at,
  duty_kind, note, is_dev_seed
) on table public.team_duty_assignments to lakeandpine_app;
grant update (status) on table public.team_duty_assignments to lakeandpine_app;

revoke insert, update, delete on table public.tip_intents
  from lakeandpine_app;
grant insert (
  organization_id, team_id, team_job_allocation_id, customer_id, cleaner_id,
  amount_cents, note, is_dev_seed
) on table public.tip_intents to lakeandpine_app;
grant update (amount_cents, note, status, provider_reference)
  on table public.tip_intents to lakeandpine_app;

revoke all on function private.stamp_schedule_proposal_evidence()
  from public, lakeandpine_app;
revoke all on function private.stamp_job_communication_actor()
  from public, lakeandpine_app;
revoke all on function private.stamp_location_exception_actor()
  from public, lakeandpine_app;
revoke all on function private.stamp_mileage_evidence()
  from public, lakeandpine_app;
revoke all on function private.stamp_job_issue_evidence()
  from public, lakeandpine_app;
revoke all on function private.audit_job_issue_state()
  from public, lakeandpine_app;
revoke all on function private.stamp_team_duty_creator()
  from public, lakeandpine_app;
revoke all on function private.stamp_tip_decision_evidence()
  from public, lakeandpine_app;
