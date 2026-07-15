import "server-only";

import type postgres from "postgres";

import {
  arrivalWindowForStartMinutes,
  canSendLateArrivalUpdate,
  lateArrivalMessage,
  STANDARD_ARRIVAL_WINDOWS,
  type ArrivalWindowId,
} from "./field-operations";
import { sql } from "./db";
import {
  membershipForCapability,
  type OperationsCapability,
  type WorkforceMembership,
} from "./team-operations";
import { localDateTimeToUtc } from "./zoned-datetime";

type Transaction = postgres.TransactionSql;

export type FieldCommunication = {
  id: string;
  team_job_allocation_id: string;
  sender_kind: string;
  audience: string;
  template_key: string | null;
  body: string;
  channel: string;
  delivery_status: string;
  created_at: string;
  customer_name?: string | null;
  service_vertical?: string | null;
  job_start_at?: string | null;
  service_location?: string | null;
};

export type CustomerScheduleProposal = {
  id: string;
  team_job_allocation_id: string;
  booking_id: string;
  service_vertical: string;
  team_name: string;
  timezone: string;
  schedule_start_at: string;
  schedule_end_at: string;
  arrival_window_start: string;
  arrival_window_end: string;
  status: string;
  version: number;
  proposal_note: string | null;
  customer_response_note: string | null;
  expires_at: string | null;
  proposal_expired: boolean;
  response_open: boolean;
};

export type CustomerCleanerChoice = {
  team_job_allocation_id: string;
  cleaner_id: string;
  cleaner_name: string;
  assignment_role: string;
  preference: string | null;
  schedule_status: string;
  service_vertical: string;
  schedule_start_at: string;
  timezone: string;
  service_location: string;
  crew_message_open: boolean;
};

export type CustomerFieldDashboard = {
  proposals: CustomerScheduleProposal[];
  cleaners: CustomerCleanerChoice[];
  communications: FieldCommunication[];
  reviews: Array<{
    id: string;
    team_job_allocation_id: string;
    cleaner_id: string;
    rating: number;
  }>;
  tips: Array<{
    id: string;
    team_job_allocation_id: string;
    cleaner_id: string | null;
    amount_cents: number;
    status: string;
    note: string | null;
    updated_at: string;
  }>;
  issues: Array<{
    id: string;
    team_job_allocation_id: string | null;
    issue_type: string;
    severity: string;
    summary: string;
    status: string;
  }>;
};

export type CrewFieldJob = {
  team_job_allocation_id: string;
  membership_id: string;
  team_name: string;
  service_vertical: string;
  timezone: string;
  start_at: string;
  end_at: string;
  schedule_status: string;
  customer_id: string;
  customer_first_name: string | null;
  street: string | null;
  unit: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  route_status: string | null;
  arrival_window_start: string | null;
  arrival_window_end: string | null;
};

export type CrewChecklistItem = {
  id: string;
  team_job_allocation_id: string;
  room_label: string | null;
  label: string;
  state: string;
  completion_note: string | null;
  version: number;
};

export type CrewFieldDashboard = {
  jobs: CrewFieldJob[];
  checklist: CrewChecklistItem[];
  communications: FieldCommunication[];
  mileage: Array<{
    id: string;
    team_job_allocation_id: string | null;
    service_date: string;
    miles: number;
    purpose: string;
    status: string;
  }>;
  issues: Array<{
    id: string;
    team_job_allocation_id: string | null;
    issue_type: string;
    severity: string;
    summary: string;
    status: string;
  }>;
  duty: Array<{
    id: string;
    team_id: string;
    duty_kind: string;
    display_name: string;
    starts_at: string;
    ends_at: string;
  }>;
};

export type TeamFieldDashboard = {
  team: {
    id: string;
    organization_id: string;
    name: string;
    timezone: string;
    origin_label: string | null;
    origin_latitude: number | null;
    origin_longitude: number | null;
    service_radius_miles: number;
    operating_start_time: string;
    latest_arrival_time: string;
    hard_finish_time: string;
    support_email: string | null;
    public_phone: string | null;
  };
  jobs: Array<{
    allocation_id: string;
    booking_id: string;
    schedule_id: string;
    service_vertical: string;
    start_at: string;
    end_at: string;
    schedule_status: string;
    local_date: string;
    customer_id: string | null;
    customer_name: string;
    route_assessment_id: string | null;
    route_status: string | null;
    distance_miles: number | null;
    route_override_reason: string | null;
    service_address: string | null;
    property_latitude: number | null;
    property_longitude: number | null;
    branch_origin_label: string | null;
    branch_origin_latitude: number | null;
    branch_origin_longitude: number | null;
    standard_radius_miles: number | null;
    calculation_method: string | null;
    route_provider: string | null;
    provider_resolved_address: string | null;
    provider_match_confidence: string | null;
    provider_coordinate_accuracy: string | null;
    calculated_at: string | null;
    proposal_still_future: boolean;
    proposal_is_current: boolean;
    has_active_reschedule_case: boolean;
    proposal_id: string | null;
    proposal_status: string | null;
    proposal_window_start: string | null;
    proposal_window_end: string | null;
    proposal_service_case_id: string | null;
    proposal_start_at: string | null;
    proposal_end_at: string | null;
  }>;
  mileage: Array<{
    id: string;
    cleaner_name: string;
    service_date: string;
    miles: number;
    purpose: string;
    status: string;
    version: number;
    team_job_allocation_id: string | null;
    vehicle_label: string | null;
    note: string | null;
    created_at: string;
    customer_name: string | null;
    service_vertical: string | null;
    job_start_at: string | null;
    service_location: string | null;
  }>;
  issues: Array<{
    id: string;
    team_job_allocation_id: string | null;
    reporter_name: string;
    customer_name: string | null;
    service_vertical: string | null;
    job_start_at: string | null;
    service_location: string | null;
    issue_type: string;
    severity: string;
    summary: string;
    private_details: string | null;
    status: string;
    customer_visible: boolean;
    version: number;
  }>;
  duty: Array<{
    id: string;
    workforce_membership_id: string;
    display_name: string;
    duty_kind: string;
    starts_at: string;
    ends_at: string;
    status: string;
    membership_status: string;
  }>;
  dutyCandidates: Array<{
    id: string;
    display_name: string;
    role: string;
  }>;
  communications: FieldCommunication[];
  tips: Array<{
    id: string;
    amount_cents: number;
    status: string;
    version: number;
    team_job_allocation_id: string;
    customer_name: string;
    cleaner_name: string | null;
    note: string | null;
    provider: string;
    provider_reference: string | null;
    recorded_by: string | null;
    updated_at: string;
  }>;
};

async function setActorContext(
  transaction: Transaction,
  actor: { customerId?: string; cleanerId?: string },
) {
  await transaction`select set_config(
    'lakeandpine.current_customer_id', ${actor.customerId ?? ""}, true
  )`;
  await transaction`select set_config(
    'lakeandpine.current_cleaner_id', ${actor.cleanerId ?? ""}, true
  )`;
}

async function withActorContext<T>(
  actor: { customerId?: string; cleanerId?: string },
  run: (transaction: Transaction) => Promise<T>,
) {
  return sql.begin(async (transaction) => {
    await setActorContext(transaction, actor);
    return run(transaction);
  });
}

async function operatorAccess(transaction: Transaction, customerId: string) {
  await transaction`select private.lock_current_workforce_access(${customerId})`;
  return transaction<WorkforceMembership[]>`
    select id, organization_id as "organizationId", team_id as "teamId", role
    from workforce_memberships
    where customer_id = ${customerId} and status = 'active'`;
}

function requireCapability(
  memberships: WorkforceMembership[],
  capability: OperationsCapability,
  organizationId: string,
  teamId: string,
) {
  const membership = membershipForCapability(
    memberships,
    capability,
    organizationId,
    teamId,
  );
  if (!membership) {
    throw new Error("Your current role does not permit this field operation");
  }
  return membership.id;
}

async function withCustomerMutation<T>(
  input: { customerId: string; devOnly: boolean },
  run: (transaction: Transaction) => Promise<T>,
) {
  if (input.devOnly) throw new Error("Customer field writes are disabled in preview mode");
  return withActorContext({ customerId: input.customerId }, run);
}

async function withCleanerMutation<T>(
  input: { cleanerId: string; devOnly: boolean },
  run: (transaction: Transaction) => Promise<T>,
) {
  if (input.devOnly) throw new Error("Cleaner field writes are disabled in preview mode");
  return withActorContext({ cleanerId: input.cleanerId }, run);
}

async function withOperatorMutation<T>(
  input: { customerId: string; devOnly: boolean },
  run: (
    transaction: Transaction,
    memberships: WorkforceMembership[],
  ) => Promise<T>,
) {
  if (input.devOnly) throw new Error("Operator field writes are disabled in preview mode");
  return withActorContext({ customerId: input.customerId }, async (transaction) => {
    const memberships = await operatorAccess(transaction, input.customerId);
    return run(transaction, memberships);
  });
}

export async function getCustomerFieldDashboard(
  customerId: string,
  devOnly: boolean,
): Promise<CustomerFieldDashboard> {
  return withActorContext({ customerId }, async (transaction) => {
    const seedFilter = devOnly ? transaction`and proposal.is_dev_seed` : transaction``;
    const [proposals, cleaners, communications, reviews, tips, issues] =
      await Promise.all([
        transaction<CustomerScheduleProposal[]>`
          select proposal.id, proposal.team_job_allocation_id,
            schedule.booking_id, schedule.service_vertical, team.name as team_name,
            team.timezone,
            coalesce(proposal.proposed_start_at, schedule.start_at)::text
              as schedule_start_at,
            coalesce(proposal.proposed_end_at, schedule.end_at)::text
              as schedule_end_at,
            proposal.arrival_window_start::text, proposal.arrival_window_end::text,
            proposal.status, proposal.version, proposal.proposal_note,
            proposal.customer_response_note, proposal.expires_at::text,
            (proposal.expires_at is not null and proposal.expires_at <= now())
              as proposal_expired,
            (proposal.expires_at is null or proposal.expires_at > now())
              and not exists (
                select 1 from service_cases active_case
                where active_case.booking_id = booking.id
                  and active_case.case_type = 'reschedule'
                  and active_case.status not in (
                    'resolved', 'closed', 'declined', 'canceled'
                  )
                  and active_case.id is distinct from proposal.service_case_id
              )
              and (
                (
                  proposal.service_case_id is not null
                  and exists (
                    select 1 from service_cases linked_case
                    where linked_case.id = proposal.service_case_id
                      and linked_case.status = 'awaiting_customer'
                  )
                )
                or (
                  proposal.service_case_id is null
                  and not exists (
                  select 1 from service_cases service_case
                  where service_case.booking_id = schedule.booking_id
                    and service_case.case_type = 'reschedule'
                    and service_case.status not in (
                      'resolved', 'closed', 'declined', 'canceled'
                    )
                  )
                )
              )
              as response_open
          from schedule_proposals proposal
          join team_job_allocations allocation
            on allocation.id = proposal.team_job_allocation_id
          join job_schedules schedule on schedule.id = allocation.job_schedule_id
          join cleaning_teams team on team.id = proposal.team_id
          where proposal.customer_id = ${customerId} ${seedFilter}
          order by proposal.created_at desc`,
        transaction<CustomerCleanerChoice[]>`
          select * from private.current_customer_job_assignments()`,
        transaction<FieldCommunication[]>`
          select id, team_job_allocation_id, sender_kind, audience,
            template_key, body, channel, delivery_status, created_at::text
          from job_communications
          where customer_id = ${customerId}
            and (audience = 'customer' or sender_customer_id = ${customerId})
            and (${devOnly} = false or is_dev_seed)
          order by created_at desc limit 100`,
        transaction<CustomerFieldDashboard["reviews"]>`
          select id, team_job_allocation_id, cleaner_id, rating
          from private.current_customer_quality_reviews()
          where (${devOnly} = false or is_dev_seed)`,
        transaction<CustomerFieldDashboard["tips"]>`
          select id, team_job_allocation_id, cleaner_id, amount_cents, status,
            note, updated_at::text
          from tip_intents where customer_id = ${customerId}
            and (${devOnly} = false or is_dev_seed)
          order by created_at desc`,
        transaction<CustomerFieldDashboard["issues"]>`
          select id, team_job_allocation_id, issue_type, severity, summary, status
          from private.current_customer_visible_job_issues()
          where (${devOnly} = false or is_dev_seed)`,
      ]);
    return { proposals, cleaners, communications, reviews, tips, issues };
  });
}

export async function respondToScheduleProposal(input: {
  customerId: string;
  devOnly: boolean;
  proposalId: string;
  response: "approved" | "changes_requested";
  note: string | null;
}) {
  return withCustomerMutation(input, async (transaction) => {
    const rows = await transaction<
      Array<{
        team_job_allocation_id: string;
        organization_id: string;
        team_id: string;
        service_case_id: string | null;
      }>
    >`
      update schedule_proposals
      set status = ${input.response}, customer_response_note = ${input.note}
      where id = ${input.proposalId} and customer_id = ${input.customerId}
        and status = 'pending_customer'
        and (expires_at is null or expires_at > now())
      returning team_job_allocation_id, organization_id, team_id,
        service_case_id`;
    if (!rows[0]) throw new Error("This proposal is no longer awaiting your response");
    await transaction`
      insert into job_communications
        (organization_id, team_id, team_job_allocation_id, customer_id,
         sender_kind, audience, template_key, body)
      values (${rows[0].organization_id}, ${rows[0].team_id},
        ${rows[0].team_job_allocation_id}, ${input.customerId}, 'customer',
        'team_operations', 'custom',
        ${input.response === "approved"
          ? "Customer approved the proposed arrival window."
          : `Customer requested a schedule change${input.note ? `: ${input.note}` : "."}`})`;
    if (input.response === "changes_requested" && rows[0].service_case_id) {
      const reopened = await transaction<{ id: string }[]>`
        update service_cases
        set status = 'action_planned', resolution_type = null,
            resolution_summary = null, resolved_at = null, closed_at = null
        where id = ${rows[0].service_case_id}
          and status = 'awaiting_customer'
        returning id`;
      if (!reopened[0]) {
        throw new Error("The linked reschedule case changed; refresh and try again");
      }
    }
  });
}

export async function saveCustomerCleanerPreference(input: {
  customerId: string;
  devOnly: boolean;
  allocationId: string;
  cleanerId: string;
  preference: "preferred" | "avoid";
  note: string | null;
}) {
  return withCustomerMutation(input, async (transaction) => {
    const scopes = await transaction<
      Array<{ organization_id: string; team_id: string }>
    >`
      select allocation.organization_id, allocation.team_id
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join bookings booking on booking.id = schedule.booking_id
      where allocation.id = ${input.allocationId}
        and booking.customer_id = ${input.customerId}
        and schedule.status = 'completed'
        and private.current_customer_allocation_has_cleaner(
          allocation.id, ${input.cleanerId}
        )`;
    if (!scopes[0]) throw new Error("Choose one of your completed service teams");
    if (input.preference === "avoid") {
      const activeAssignments = await transaction<{ id: string }[]>`
        select allocation.id
        from team_job_allocations allocation
        join job_schedules schedule on schedule.id = allocation.job_schedule_id
        join bookings booking on booking.id = schedule.booking_id
        where allocation.organization_id = ${scopes[0].organization_id}
          and allocation.team_id = ${scopes[0].team_id}
          and booking.customer_id = ${input.customerId}
          and schedule.status in (
            'tentative', 'held', 'confirmed', 'en_route', 'in_progress', 'quality_review'
          )
          and private.current_customer_allocation_has_cleaner(
            allocation.id, ${input.cleanerId}
          )
        limit 1`;
      if (activeAssignments[0]) {
        throw new Error(
          "This cleaner is assigned to active work. Ask the service team to replan it before saving Do not schedule.",
        );
      }
    }
    await transaction`
      insert into customer_cleaner_preferences
        (organization_id, team_id, customer_id, cleaner_id,
         source_allocation_id, preference, note)
      values (${scopes[0].organization_id}, ${scopes[0].team_id},
        ${input.customerId}, ${input.cleanerId}, ${input.allocationId},
        ${input.preference}, ${input.note})
      on conflict (team_id, customer_id, cleaner_id) do update
      set source_allocation_id = excluded.source_allocation_id,
          preference = excluded.preference, note = excluded.note,
          active = true, updated_at = now()`;
  });
}

export async function sendCustomerJobMessage(input: {
  customerId: string;
  devOnly: boolean;
  allocationId: string;
  body: string;
}) {
  return withCustomerMutation(input, async (transaction) => {
    const scopes = await transaction<
      Array<{ organization_id: string; team_id: string }>
    >`
      select allocation.organization_id, allocation.team_id
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join bookings booking on booking.id = schedule.booking_id
        where allocation.id = ${input.allocationId}
          and booking.customer_id = ${input.customerId}
          and schedule.status in ('confirmed','en_route','in_progress','quality_review')
          and private.current_customer_allocation_has_active_crew(allocation.id)`;
    if (!scopes[0]) {
      throw new Error("Crew messaging opens for a confirmed or active service job");
    }
    await transaction`
      insert into job_communications
        (organization_id, team_id, team_job_allocation_id, customer_id,
         sender_kind, audience, template_key, body)
      values (${scopes[0].organization_id}, ${scopes[0].team_id},
        ${input.allocationId}, ${input.customerId}, 'customer',
        'assigned_crew', 'custom', ${input.body})`;
  });
}

export async function submitCustomerReview(input: {
  customerId: string;
  devOnly: boolean;
  allocationId: string;
  cleanerId: string;
  rating: number;
  note: string | null;
}) {
  return withCustomerMutation(input, async (transaction) => {
    const scopes = await transaction<
      Array<{ organization_id: string; team_id: string }>
    >`
      select allocation.organization_id, allocation.team_id
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join bookings booking on booking.id = schedule.booking_id
      where allocation.id = ${input.allocationId}
        and booking.customer_id = ${input.customerId}
        and schedule.status = 'completed'
        and private.current_customer_allocation_has_cleaner(
          allocation.id, ${input.cleanerId}
        )`;
    if (!scopes[0]) throw new Error("Reviews open after assigned work is completed");
    await transaction`
      insert into quality_reviews
        (organization_id, team_id, team_job_allocation_id, cleaner_id,
         customer_id, rating, source, private_note, is_dev_seed)
      values (${scopes[0].organization_id}, ${scopes[0].team_id},
        ${input.allocationId}, ${input.cleanerId}, ${input.customerId},
        ${input.rating}, 'verified_customer', ${input.note}, ${input.devOnly})
      on conflict (team_job_allocation_id, cleaner_id, source) do nothing`;
  });
}

export async function submitTipIntent(input: {
  customerId: string;
  devOnly: boolean;
  allocationId: string;
  cleanerId: string | null;
  amountCents: number;
  note: string | null;
}) {
  return withCustomerMutation(input, async (transaction) => {
    const scopes = await transaction<
      Array<{ organization_id: string; team_id: string }>
    >`
      select allocation.organization_id, allocation.team_id
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join bookings booking on booking.id = schedule.booking_id
      where allocation.id = ${input.allocationId}
        and booking.customer_id = ${input.customerId}
        and schedule.status = 'completed'
        and (
          ${input.cleanerId}::uuid is null
          or private.current_customer_allocation_has_cleaner(
            allocation.id, ${input.cleanerId}
          )
        )`;
    if (!scopes[0]) throw new Error("Tip intent opens after service is completed");
    const existing = await transaction<Array<{ status: string }>>`
      select status from tip_intents
      where team_job_allocation_id = ${input.allocationId}
        and customer_id = ${input.customerId}
        and cleaner_id is not distinct from ${input.cleanerId}::uuid
      for update`;
    if (existing[0] && !["pending_collection", "canceled"].includes(existing[0].status)) {
      throw new Error("A finalized tip decision cannot be replaced");
    }
    await transaction`
      insert into tip_intents
        (organization_id, team_id, team_job_allocation_id, customer_id,
         cleaner_id, amount_cents, note, is_dev_seed)
      values (${scopes[0].organization_id}, ${scopes[0].team_id},
        ${input.allocationId}, ${input.customerId}, ${input.cleanerId},
        ${input.amountCents}, ${input.note}, ${input.devOnly})
      on conflict (team_job_allocation_id, customer_id, cleaner_id) do update
      set amount_cents = excluded.amount_cents,
          note = excluded.note, status = 'pending_collection', updated_at = now()`;
  });
}

export async function getCrewFieldDashboard(
  cleanerId: string,
  devOnly: boolean,
): Promise<CrewFieldDashboard> {
  return withActorContext({ cleanerId }, async (transaction) => {
    const [jobs, checklist, communications, mileage, issues, duty] =
      await Promise.all([
        transaction<CrewFieldJob[]>`
          select allocation.id as team_job_allocation_id,
            membership.id as membership_id, team.name as team_name,
            schedule.service_vertical, team.timezone, schedule.start_at::text,
            schedule.end_at::text, schedule.status as schedule_status,
            booking.customer_id, split_part(booking.contact->>'name', ' ', 1)
              as customer_first_name,
            booking.contact->>'street' as street,
            booking.contact->>'unit' as unit,
            booking.contact->>'city' as city,
            booking.contact->>'state' as state,
            booking.contact->>'zip' as zip,
            assessment.assessment_status as route_status,
            proposal.arrival_window_start::text,
            proposal.arrival_window_end::text
          from team_job_allocations allocation
          join cleaning_teams team on team.id = allocation.team_id
          join workforce_memberships membership
            on membership.organization_id = allocation.organization_id
           and membership.team_id = allocation.team_id
           and membership.cleaner_id = ${cleanerId}
           and membership.status = 'active'
          join job_schedules schedule on schedule.id = allocation.job_schedule_id
          join bookings booking on booking.id = schedule.booking_id
          join job_assignments assignment on assignment.job_schedule_id = schedule.id
            and assignment.cleaner_id = ${cleanerId}
            and assignment.status in ('accepted','confirmed')
          left join service_location_assessments assessment
            on assessment.booking_id = booking.id
          left join lateral (
            select candidate.arrival_window_start, candidate.arrival_window_end
            from schedule_proposals candidate
            where candidate.job_schedule_id = schedule.id
              and candidate.status = 'approved'
              and (candidate.expires_at is null or candidate.expires_at > now())
              and schedule.start_at >= candidate.arrival_window_start
              and (
                schedule.start_at < candidate.arrival_window_end
                or (
                  schedule.start_at = candidate.arrival_window_end
                  and (schedule.start_at at time zone team.timezone)::time
                    = team.latest_arrival_time
                )
              )
            order by candidate.version desc limit 1
          ) proposal on true
          where schedule.status in ('confirmed','en_route','in_progress','quality_review')
            and (${devOnly} = false or allocation.is_dev_seed)
          order by schedule.start_at`,
        transaction<CrewChecklistItem[]>`
          select id, team_job_allocation_id, room_label, label, state,
            completion_note, version
          from checklist_items
          where team_job_allocation_id is not null
            and private.cleaner_assigned_to_allocation(team_job_allocation_id)
            and (${devOnly} = false or is_dev_seed)
          order by team_job_allocation_id, sort`,
        transaction<FieldCommunication[]>`
          select id, team_job_allocation_id, sender_kind, audience,
            template_key, body, channel, delivery_status, created_at::text
          from job_communications
          where private.cleaner_assigned_to_allocation(team_job_allocation_id)
            and (audience = 'assigned_crew' or sender_cleaner_id = ${cleanerId})
            and (${devOnly} = false or is_dev_seed)
          order by created_at desc limit 100`,
        transaction<CrewFieldDashboard["mileage"]>`
          select id, team_job_allocation_id, service_date::text,
            miles::float8, purpose, status
          from mileage_entries where cleaner_id = ${cleanerId}
            and (${devOnly} = false or is_dev_seed)
          order by service_date desc, created_at desc limit 100`,
        transaction<CrewFieldDashboard["issues"]>`
          select id, team_job_allocation_id, issue_type, severity, summary, status
          from private.current_cleaner_job_issue_reports()
          where (${devOnly} = false or is_dev_seed)
          order by created_at desc limit 100`,
        transaction<CrewFieldDashboard["duty"]>`
          select id, team_id, duty_kind, display_name,
            starts_at::text, ends_at::text
          from private.current_cleaner_duty_coverage()`,
      ]);
    return { jobs, checklist, communications, mileage, issues, duty };
  });
}

async function cleanerAllocationScope(
  transaction: Transaction,
  cleanerId: string,
  allocationId: string,
) {
  const rows = await transaction<
    Array<{
      organization_id: string;
      team_id: string;
      membership_id: string;
      customer_id: string;
      customer_first_name: string | null;
      schedule_status: string;
      start_at: string;
      end_at: string;
    }>
  >`
    select allocation.organization_id, allocation.team_id,
      membership.id as membership_id, booking.customer_id,
      split_part(booking.contact->>'name', ' ', 1) as customer_first_name,
      schedule.status as schedule_status, schedule.start_at::text,
      schedule.end_at::text
    from team_job_allocations allocation
    join job_schedules schedule on schedule.id = allocation.job_schedule_id
    join bookings booking on booking.id = schedule.booking_id
    join job_assignments assignment on assignment.job_schedule_id = schedule.id
      and assignment.cleaner_id = ${cleanerId}
      and assignment.status in ('accepted','confirmed')
    join workforce_memberships membership
      on membership.organization_id = allocation.organization_id
     and membership.team_id = allocation.team_id
     and membership.cleaner_id = ${cleanerId}
     and membership.status = 'active'
    where allocation.id = ${allocationId}`;
  if (!rows[0] || !rows[0].customer_id) {
    throw new Error("Choose an assigned customer job");
  }
  return rows[0];
}

export async function sendCleanerJobMessage(input: {
  cleanerId: string;
  devOnly: boolean;
  allocationId: string;
  template: "running_15_late" | "running_30_late" | "custom";
  body: string | null;
}) {
  return withCleanerMutation(input, async (transaction) => {
    const scope = await cleanerAllocationScope(
      transaction,
      input.cleanerId,
      input.allocationId,
    );
    if (!['confirmed', 'en_route', 'in_progress'].includes(scope.schedule_status)) {
      throw new Error("Customer updates open when the assignment is confirmed");
    }
    if (
      input.template !== "custom" &&
      !canSendLateArrivalUpdate(
        scope.schedule_status,
        scope.start_at,
        scope.end_at,
      )
    ) {
      throw new Error("Late-arrival templates open within one hour of the planned visit");
    }
    const body = input.template === "running_15_late"
      ? lateArrivalMessage(15, scope.customer_first_name)
      : input.template === "running_30_late"
        ? lateArrivalMessage(30, scope.customer_first_name)
        : input.body;
    if (!body) throw new Error("Add a message");
    await transaction`
      insert into job_communications
        (organization_id, team_id, team_job_allocation_id, customer_id,
         sender_kind, audience, template_key, body)
      values (${scope.organization_id}, ${scope.team_id}, ${input.allocationId},
        ${scope.customer_id}, 'cleaner', 'customer', ${input.template}, ${body})`;
  });
}

export async function recordCleanerMileage(input: {
  cleanerId: string;
  devOnly: boolean;
  membershipId: string;
  allocationId: string | null;
  serviceDate: string;
  miles: number;
  purpose: string;
  vehicleLabel: string | null;
  note: string | null;
}) {
  return withCleanerMutation(input, async (transaction) => {
    const memberships = await transaction<
      Array<{ organization_id: string; team_id: string }>
    >`
      select organization_id, team_id from workforce_memberships
      where id = ${input.membershipId} and cleaner_id = ${input.cleanerId}
        and status = 'active' and role in ('cleaner','shift_lead')`;
    if (!memberships[0]) throw new Error("Choose one of your active teams");
    if (input.allocationId) {
      await cleanerAllocationScope(transaction, input.cleanerId, input.allocationId);
    }
    await transaction`
      insert into mileage_entries
        (organization_id, team_id, cleaner_id, team_job_allocation_id,
         service_date, miles, purpose,
         vehicle_label, note, is_dev_seed)
      values (${memberships[0].organization_id}, ${memberships[0].team_id},
        ${input.cleanerId}, ${input.allocationId},
        ${input.serviceDate}, ${input.miles}, ${input.purpose},
        ${input.vehicleLabel}, ${input.note}, ${input.devOnly})`;
  });
}

export async function reportCleanerIssue(input: {
  cleanerId: string;
  devOnly: boolean;
  membershipId: string;
  allocationId: string | null;
  issueType: string;
  severity: string;
  summary: string;
  privateDetails: string | null;
}) {
  return withCleanerMutation(input, async (transaction) => {
    const memberships = await transaction<
      Array<{ organization_id: string; team_id: string }>
    >`
      select organization_id, team_id from workforce_memberships
      where id = ${input.membershipId} and cleaner_id = ${input.cleanerId}
        and status = 'active' and role in ('cleaner','shift_lead')`;
    if (!memberships[0]) throw new Error("Choose one of your active teams");
    if (input.allocationId) {
      await cleanerAllocationScope(transaction, input.cleanerId, input.allocationId);
    }
    await transaction`
      insert into job_issue_reports
        (organization_id, team_id, team_job_allocation_id, issue_type,
         severity, summary, private_details, is_dev_seed)
      values (${memberships[0].organization_id}, ${memberships[0].team_id},
        ${input.allocationId}, ${input.issueType}, ${input.severity}, ${input.summary},
        ${input.privateDetails}, ${input.devOnly})`;
  });
}

export async function updateCleanerChecklistItem(input: {
  cleanerId: string;
  devOnly: boolean;
  allocationId: string;
  itemId: string;
  state: "pending" | "completed" | "skipped";
  note: string | null;
  version: number;
}) {
  return withCleanerMutation(input, async (transaction) => {
    const scope = await cleanerAllocationScope(
      transaction,
      input.cleanerId,
      input.allocationId,
    );
    if (scope.schedule_status !== "in_progress") {
      throw new Error("Checklist evidence opens only while service is in progress");
    }
    const rows = await transaction<{ id: string }[]>`
      update checklist_items
      set state = ${input.state}, completion_note = ${input.note}
      where id = ${input.itemId}
        and team_job_allocation_id = ${input.allocationId}
        and version = ${input.version}
        and exists (
          select 1 from team_job_allocations allocation
          join job_schedules schedule on schedule.id = allocation.job_schedule_id
          where allocation.id = ${input.allocationId}
            and schedule.status = 'in_progress'
        )
      returning id`;
    if (!rows[0]) throw new Error("Checklist item changed; refresh and try again");
  });
}

export async function getTeamFieldDashboard(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
}): Promise<TeamFieldDashboard> {
  return withActorContext({ customerId: input.customerId }, async (transaction) => {
    const memberships = await operatorAccess(transaction, input.customerId);
    const teamRows = await transaction<TeamFieldDashboard["team"][]>`
      select id, organization_id, name, timezone, origin_label,
        origin_latitude::float8, origin_longitude::float8,
        service_radius_miles::float8, operating_start_time::text,
        latest_arrival_time::text, hard_finish_time::text,
        support_email, public_phone
      from cleaning_teams where id = ${input.teamId}
        and (${input.devOnly} = false or is_dev_seed)`;
    const team = teamRows[0];
    if (!team) throw new Error("Choose an accessible team");
    requireCapability(
      memberships,
      "manage_field_operations",
      team.organization_id,
      team.id,
    );
    const [jobs, mileage, issues, duty, dutyCandidates, communications, tips] =
      await Promise.all([
        transaction<TeamFieldDashboard["jobs"]>`
          select allocation.id as allocation_id, booking.id as booking_id,
            schedule.id as schedule_id, schedule.service_vertical,
            schedule.start_at::text, schedule.end_at::text,
            schedule.status as schedule_status,
            to_char(schedule.start_at at time zone team.timezone, 'YYYY-MM-DD') as local_date,
            booking.customer_id, coalesce(booking.contact->>'name', 'Unlinked request') as customer_name,
            assessment.id as route_assessment_id,
            assessment.assessment_status as route_status,
            assessment.distance_miles::float8,
            assessment.override_reason as route_override_reason,
            nullif(concat_ws(', ', booking.contact->>'street',
              nullif(booking.contact->>'unit', ''), booking.contact->>'city',
              booking.contact->>'state', booking.contact->>'zip'), '') as service_address,
            assessment.property_latitude::float8,
            assessment.property_longitude::float8,
            assessment.branch_origin_label,
            assessment.branch_origin_latitude::float8,
            assessment.branch_origin_longitude::float8,
            assessment.standard_radius_miles::float8,
            assessment.calculation_method,
            assessment.provider as route_provider,
            assessment.provider_resolved_address,
            assessment.provider_match_confidence,
            assessment.provider_coordinate_accuracy,
            assessment.calculated_at::text,
            schedule.start_at > now() as proposal_still_future,
            (proposal.expires_at is null or proposal.expires_at > now())
              and (
                proposal.service_case_id is null
                or exists (
                  select 1 from service_cases linked_case
                  where linked_case.id = proposal.service_case_id
                    and linked_case.status = 'awaiting_customer'
                )
              )
              as proposal_is_current,
            exists (
              select 1 from service_cases active_case
              where active_case.booking_id = booking.id
                and active_case.case_type = 'reschedule'
                and active_case.status not in (
                  'resolved', 'closed', 'declined', 'canceled'
                )
            ) as has_active_reschedule_case,
            proposal.id as proposal_id, proposal.status as proposal_status,
            proposal.arrival_window_start::text as proposal_window_start,
            proposal.arrival_window_end::text as proposal_window_end,
            proposal.service_case_id as proposal_service_case_id,
            proposal.proposed_start_at::text as proposal_start_at,
            proposal.proposed_end_at::text as proposal_end_at
          from team_job_allocations allocation
          join cleaning_teams team on team.id = allocation.team_id
          join job_schedules schedule on schedule.id = allocation.job_schedule_id
          join bookings booking on booking.id = schedule.booking_id
          left join service_location_assessments assessment
            on assessment.booking_id = booking.id
          left join lateral (
            select candidate.* from schedule_proposals candidate
            where candidate.job_schedule_id = schedule.id
            order by candidate.version desc limit 1
          ) proposal on true
          where allocation.team_id = ${input.teamId}
            and (${input.devOnly} = false or allocation.is_dev_seed)
          order by schedule.start_at`,
        transaction<TeamFieldDashboard["mileage"]>`
          select entry.id, cleaner.full_name as cleaner_name,
            entry.service_date::text, entry.miles::float8, entry.purpose,
            entry.status, entry.version, entry.team_job_allocation_id,
            entry.vehicle_label, entry.note, entry.created_at::text,
            booking.contact->>'name' as customer_name,
            schedule.service_vertical, schedule.start_at::text as job_start_at,
            nullif(concat_ws(', ', booking.contact->>'street',
              nullif(booking.contact->>'unit', ''), booking.contact->>'city',
              booking.contact->>'state', booking.contact->>'zip'), '') as service_location
          from mileage_entries entry
          join cleaners cleaner on cleaner.id = entry.cleaner_id
          left join team_job_allocations allocation
            on allocation.id = entry.team_job_allocation_id
          left join job_schedules schedule on schedule.id = allocation.job_schedule_id
          left join bookings booking on booking.id = schedule.booking_id
          where entry.team_id = ${input.teamId}
            and (${input.devOnly} = false or entry.is_dev_seed)
          order by entry.status, entry.service_date desc`,
        transaction<TeamFieldDashboard["issues"]>`
          select issue.id, issue.team_job_allocation_id,
            coalesce(cleaner.full_name, customer.full_name, customer.email,
              'Team operator') as reporter_name,
            booking.contact->>'name' as customer_name,
            schedule.service_vertical,
            schedule.start_at::text as job_start_at,
            nullif(concat_ws(', ', booking.contact->>'street',
              booking.contact->>'city', booking.contact->>'state',
              booking.contact->>'zip'), '') as service_location,
            issue.issue_type, issue.severity, issue.summary,
            issue.private_details, issue.status,
            issue.customer_visible, issue.version
          from job_issue_reports issue
          join workforce_memberships membership
            on membership.id = issue.reported_by_membership_id
          left join cleaners cleaner on cleaner.id = membership.cleaner_id
          left join customers customer on customer.id = membership.customer_id
          left join team_job_allocations allocation
            on allocation.id = issue.team_job_allocation_id
          left join job_schedules schedule on schedule.id = allocation.job_schedule_id
          left join bookings booking on booking.id = schedule.booking_id
          where issue.team_id = ${input.teamId}
            and (${input.devOnly} = false or issue.is_dev_seed)
          order by case issue.severity when 'critical' then 1 when 'high' then 2 else 3 end,
            issue.created_at desc`,
        transaction<TeamFieldDashboard["duty"]>`
          select duty.id, duty.workforce_membership_id,
            coalesce(cleaner.full_name, customer.full_name, customer.email,
              'Team operator') as display_name,
            duty.duty_kind, duty.starts_at::text, duty.ends_at::text, duty.status,
            membership.status as membership_status
          from team_duty_assignments duty
          join workforce_memberships membership
            on membership.id = duty.workforce_membership_id
          left join cleaners cleaner on cleaner.id = membership.cleaner_id
          left join customers customer on customer.id = membership.customer_id
          where duty.team_id = ${input.teamId}
            and (${input.devOnly} = false or duty.is_dev_seed)
          order by duty.starts_at desc limit 50`,
        transaction<TeamFieldDashboard["dutyCandidates"]>`
          select membership.id,
            coalesce(cleaner.full_name, customer.full_name, customer.email,
              'Team operator') as display_name,
            membership.role
          from workforce_memberships membership
          left join cleaners cleaner on cleaner.id = membership.cleaner_id
          left join customers customer on customer.id = membership.customer_id
          where membership.organization_id = ${team.organization_id}
            and membership.status = 'active'
            and (
              (membership.team_id = ${input.teamId}
                and membership.role in ('manager','shift_lead'))
              or (membership.team_id is null and membership.role in ('owner','gm'))
            )
          order by membership.role, display_name`,
        transaction<FieldCommunication[]>`
          select communication.id, communication.team_job_allocation_id,
            communication.sender_kind, communication.audience,
            communication.template_key, communication.body,
            communication.channel, communication.delivery_status,
            communication.created_at::text,
            booking.contact->>'name' as customer_name,
            schedule.service_vertical, schedule.start_at::text as job_start_at,
            nullif(concat_ws(', ', booking.contact->>'street',
              nullif(booking.contact->>'unit', ''), booking.contact->>'city',
              booking.contact->>'state', booking.contact->>'zip'), '') as service_location
          from job_communications communication
          join team_job_allocations allocation
            on allocation.id = communication.team_job_allocation_id
          join job_schedules schedule on schedule.id = allocation.job_schedule_id
          join bookings booking on booking.id = schedule.booking_id
          where communication.team_id = ${input.teamId}
            and (${input.devOnly} = false or communication.is_dev_seed)
          order by communication.created_at desc limit 100`,
        transaction<TeamFieldDashboard["tips"]>`
          select tip.id, tip.amount_cents, tip.status, tip.version,
            tip.team_job_allocation_id, tip.note, tip.provider,
            tip.provider_reference, tip.updated_at::text,
            coalesce(customer.full_name, customer.email, 'Customer') as customer_name,
            cleaner.full_name as cleaner_name,
            coalesce(recorder_cleaner.full_name, recorder_customer.full_name,
              recorder_customer.email) as recorded_by
          from tip_intents tip
          join customers customer on customer.id = tip.customer_id
          left join cleaners cleaner on cleaner.id = tip.cleaner_id
          left join workforce_memberships recorder
            on recorder.id = tip.recorded_by_membership_id
          left join cleaners recorder_cleaner on recorder_cleaner.id = recorder.cleaner_id
          left join customers recorder_customer on recorder_customer.id = recorder.customer_id
          where tip.team_id = ${input.teamId}
            and (${input.devOnly} = false or tip.is_dev_seed)
          order by tip.created_at desc`,
      ]);
    return { team, jobs, mileage, issues, duty, dutyCandidates, communications, tips };
  });
}

export async function updateBranchFieldRules(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  originLabel: string;
  originLatitude: number;
  originLongitude: number;
  serviceRadiusMiles: number;
  operatingStartTime: string;
  latestArrivalTime: string;
  hardFinishTime: string;
  supportEmail: string | null;
  publicPhone: string | null;
}) {
  return withOperatorMutation(input, async (transaction, memberships) => {
    const teams = await transaction<
      Array<{ organization_id: string }>
    >`select organization_id from cleaning_teams where id = ${input.teamId} for update`;
    if (!teams[0]) throw new Error("Choose an active team");
    requireCapability(
      memberships,
      "manage_field_operations",
      teams[0].organization_id,
      input.teamId,
    );
    await transaction`
      update cleaning_teams
      set origin_label = ${input.originLabel},
          origin_latitude = ${input.originLatitude},
          origin_longitude = ${input.originLongitude},
          service_radius_miles = ${input.serviceRadiusMiles},
          operating_start_time = ${input.operatingStartTime},
          latest_arrival_time = ${input.latestArrivalTime},
          hard_finish_time = ${input.hardFinishTime},
          support_email = ${input.supportEmail}, public_phone = ${input.publicPhone}
      where id = ${input.teamId}`;
  });
}

export async function sendStaffJobMessage(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  allocationId: string;
  body: string;
}) {
  return withOperatorMutation(input, async (transaction, memberships) => {
    const rows = await transaction<Array<{
      organization_id: string;
      customer_id: string;
    }>>`
      select allocation.organization_id, booking.customer_id
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join bookings booking on booking.id = schedule.booking_id
      where allocation.id = ${input.allocationId}
        and allocation.team_id = ${input.teamId}
        and booking.customer_id is not null
        and schedule.status <> 'canceled'
      for update of allocation`;
    if (!rows[0]) throw new Error("Choose an active customer job from this team");
    requireCapability(
      memberships,
      "communicate_with_customers",
      rows[0].organization_id,
      input.teamId,
    );
    await transaction`
      insert into job_communications
        (organization_id, team_id, team_job_allocation_id, customer_id,
         sender_kind, audience, template_key, body, is_dev_seed)
      values (${rows[0].organization_id}, ${input.teamId}, ${input.allocationId},
        ${rows[0].customer_id}, 'staff', 'customer', 'custom',
        ${input.body}, ${input.devOnly})`;
  });
}

export async function approveRouteException(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  assessmentId: string;
  reason: string;
}) {
  return withOperatorMutation(input, async (transaction, memberships) => {
    const rows = await transaction<
      Array<{ organization_id: string; assessment_status: string; schedule_status: string }>
    >`
      select assessment.organization_id, assessment.assessment_status,
        schedule.status as schedule_status
      from service_location_assessments assessment
      join job_schedules schedule on schedule.booking_id = assessment.booking_id
      where assessment.id = ${input.assessmentId}
        and assessment.team_id = ${input.teamId}
      for update of assessment, schedule`;
    if (!rows[0]) throw new Error("Choose a route review from this team");
    if (!['manual_review', 'outside_standard_radius'].includes(rows[0].assessment_status)
      || ![
        'tentative', 'held', 'confirmed', 'en_route', 'in_progress', 'quality_review',
      ].includes(rows[0].schedule_status)) {
      throw new Error("Route exceptions are limited to current reviews");
    }
    requireCapability(
      memberships,
      "manage_route_exceptions",
      rows[0].organization_id,
      input.teamId,
    );
    const changed = await transaction<{ id: string }[]>`
      update service_location_assessments
      set assessment_status = 'approved_exception',
          override_reason = ${input.reason}
      where id = ${input.assessmentId}
        and assessment_status in ('manual_review','outside_standard_radius')
      returning id`;
    if (!changed[0]) throw new Error("Route review changed; refresh and try again");
  });
}

export async function createCustomerScheduleProposal(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  allocationId: string;
  windowId: ArrivalWindowId;
  note: string | null;
}) {
  return withOperatorMutation(input, async (transaction, memberships) => {
    const rows = await transaction<
      Array<{
        organization_id: string;
        job_schedule_id: string;
        customer_id: string | null;
        timezone: string;
        local_date: string;
        local_start_minutes: number;
        start_at: string;
        status: string;
        has_open_reschedule_case: boolean;
      }>
    >`
      select allocation.organization_id, allocation.job_schedule_id,
        booking.customer_id, team.timezone,
        to_char(schedule.start_at at time zone team.timezone, 'YYYY-MM-DD') as local_date,
        (extract(hour from schedule.start_at at time zone team.timezone)::int * 60
          + extract(minute from schedule.start_at at time zone team.timezone)::int)
          as local_start_minutes,
        schedule.start_at::text,
        schedule.status,
        exists (
          select 1 from service_cases service_case
          where service_case.booking_id = booking.id
            and service_case.case_type = 'reschedule'
            and service_case.status not in ('resolved', 'closed', 'declined', 'canceled')
        ) as has_open_reschedule_case
      from team_job_allocations allocation
      join cleaning_teams team on team.id = allocation.team_id
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join bookings booking on booking.id = schedule.booking_id
      where allocation.id = ${input.allocationId}
        and allocation.team_id = ${input.teamId}
      for update of allocation, schedule`;
    const row = rows[0];
    if (!row || !row.customer_id) {
      throw new Error("Link the request to an authenticated customer before proposing a window");
    }
    if (!['tentative', 'held', 'confirmed'].includes(row.status)) {
      throw new Error("Only planning-stage or legacy confirmed work can receive a proposal");
    }
    if (row.has_open_reschedule_case) {
      throw new Error(
        "Return to service recovery and send a replacement linked to the active reschedule case",
      );
    }
    if (row.status === 'confirmed' && Date.parse(row.start_at) <= Date.now()) {
      throw new Error(
        "Work at or past its planned start cannot receive a retroactive customer approval",
      );
    }
    requireCapability(
      memberships,
      "manage_schedule_approvals",
      row.organization_id,
      input.teamId,
    );
    const window = STANDARD_ARRIVAL_WINDOWS.find((item) => item.id === input.windowId);
    if (!window) throw new Error("Choose a supported arrival window");
    if (arrivalWindowForStartMinutes(row.local_start_minutes)?.id !== window.id) {
      throw new Error("Choose the arrival window containing the planned start time");
    }
    const clock = (minutes: number) =>
      `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const arrivalWindowStart = localDateTimeToUtc(
      `${row.local_date}T${clock(window.startMinutes)}`,
      row.timezone,
    );
    const arrivalWindowEnd = localDateTimeToUtc(
      `${row.local_date}T${clock(window.endMinutes)}`,
      row.timezone,
    );
    await transaction`
      update schedule_proposals set status = 'superseded'
      where job_schedule_id = ${row.job_schedule_id}
        and status in ('draft','pending_customer','changes_requested')`;
    await transaction`
      insert into schedule_proposals
        (organization_id, team_id, team_job_allocation_id, job_schedule_id,
         customer_id, arrival_window_start, arrival_window_end, proposal_note,
         expires_at, is_dev_seed)
      values (${row.organization_id}, ${input.teamId}, ${input.allocationId},
        ${row.job_schedule_id}, ${row.customer_id}, ${arrivalWindowStart},
        ${arrivalWindowEnd}, ${input.note}, ${row.start_at}, ${input.devOnly})`;
    await transaction`
      update job_schedules set status = 'held', version = version + 1
      where id = ${row.job_schedule_id} and status = 'tentative'`;
    await transaction`
      insert into job_communications
        (organization_id, team_id, team_job_allocation_id, customer_id,
         sender_kind, audience, template_key, body, is_dev_seed)
      values (${row.organization_id}, ${input.teamId}, ${input.allocationId},
        ${row.customer_id}, 'staff', 'customer', 'arrival_update',
        ${`Lake & Pine proposed ${window.label}. Please approve it or request a change in your dashboard.`},
        ${input.devOnly})`;
  });
}

export async function confirmApprovedSchedule(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  scheduleId: string;
}) {
  return withOperatorMutation(input, async (transaction, memberships) => {
    const rows = await transaction<Array<{
      organization_id: string;
      proposal_id: string;
      service_case_id: string | null;
      proposed_start_at: string | null;
      proposed_end_at: string | null;
      schedule_status: string;
    }>>`
      select allocation.organization_id, proposal.id as proposal_id,
        proposal.service_case_id, proposal.proposed_start_at::text,
        proposal.proposed_end_at::text, schedule.status as schedule_status
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join schedule_proposals proposal on proposal.job_schedule_id = schedule.id
        and proposal.status = 'approved'
        and (proposal.expires_at is null or proposal.expires_at > now())
        and not exists (
          select 1 from service_cases active_case
          where active_case.booking_id = schedule.booking_id
            and active_case.case_type = 'reschedule'
            and active_case.status not in ('resolved', 'closed', 'declined', 'canceled')
            and active_case.id is distinct from proposal.service_case_id
        )
      where allocation.team_id = ${input.teamId}
        and schedule.id = ${input.scheduleId}
        and schedule.status in ('tentative','held','confirmed')
      order by proposal.version desc
      limit 1
      for update of schedule, proposal`;
    if (!rows[0]) throw new Error("Choose work with a current customer approval");
    requireCapability(
      memberships,
      "manage_schedule_approvals",
      rows[0].organization_id,
      input.teamId,
    );
    if (rows[0].service_case_id) {
      if (!rows[0].proposed_start_at || !rows[0].proposed_end_at) {
        throw new Error("The approved reschedule is missing replacement timing");
      }
      await transaction`
        update schedule_proposals
        set status = 'superseded'
        where job_schedule_id = ${input.scheduleId}
          and status = 'approved' and id <> ${rows[0].proposal_id}`;
    }
    if (rows[0].schedule_status === "tentative") {
      await transaction`
        update job_schedules set status = 'held', version = version + 1
        where id = ${input.scheduleId} and status = 'tentative'`;
    }
    const updated = await transaction<{ id: string }[]>`
      update job_schedules
      set start_at = coalesce(${rows[0].proposed_start_at}::timestamptz, start_at),
          end_at = coalesce(${rows[0].proposed_end_at}::timestamptz, end_at),
          status = 'confirmed', version = version + 1
      where id = ${input.scheduleId} and status in ('held','confirmed')
      returning id`;
    if (!updated[0]) throw new Error("Schedule changed; refresh and try again");
    if (rows[0].service_case_id) {
      const resolved = await transaction<{ id: string }[]>`
        update service_cases
        set status = 'resolved', resolution_type = 'rescheduled',
            resolution_summary = 'Customer approved the proposed arrival window and an authorized manager confirmed it.',
            resolved_at = now(), closed_at = null
        where id = ${rows[0].service_case_id}
          and status = 'awaiting_customer'
        returning id`;
      if (!resolved[0]) {
        throw new Error("The linked reschedule case changed; refresh and try again");
      }
    }
  });
}

export async function reviewMileageEntry(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  mileageId: string;
  version: number;
  status: "approved" | "rejected";
  note: string | null;
}) {
  return withOperatorMutation(input, async (transaction, memberships) => {
    const rows = await transaction<
      Array<{ organization_id: string }>
    >`
      select organization_id from mileage_entries
      where id = ${input.mileageId} and team_id = ${input.teamId}
        and status = 'submitted' and version = ${input.version}
      for update`;
    if (!rows[0]) throw new Error("Mileage entry changed; refresh and try again");
    requireCapability(
      memberships,
      "approve_mileage",
      rows[0].organization_id,
      input.teamId,
    );
    await transaction`
      update mileage_entries set status = ${input.status},
        review_note = ${input.note}
      where id = ${input.mileageId}`;
  });
}

export async function resolveFieldIssue(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  issueId: string;
  version: number;
  status: "acknowledged" | "resolved" | "dismissed";
  note: string | null;
  customerVisible: boolean;
}) {
  return withOperatorMutation(input, async (transaction, memberships) => {
    const rows = await transaction<
      Array<{ organization_id: string; status: string }>
    >`
      select organization_id, status from job_issue_reports
      where id = ${input.issueId} and team_id = ${input.teamId}
        and version = ${input.version} for update`;
    if (!rows[0]) throw new Error("Issue changed; refresh and try again");
    if (["resolved", "dismissed"].includes(rows[0].status)) {
      throw new Error(
        "Closed issue evidence is immutable; create a new linked issue for follow-up",
      );
    }
    requireCapability(
      memberships,
      "manage_field_operations",
      rows[0].organization_id,
      input.teamId,
    );
    await transaction`
      update job_issue_reports set status = ${input.status},
        customer_visible = ${input.customerVisible},
        resolution_note = ${input.note}
      where id = ${input.issueId}
        and status not in ('resolved','dismissed')
        and version = ${input.version}`;
  });
}

export async function assignTeamDuty(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  membershipId: string;
  startsAt: string;
  endsAt: string;
  dutyKind: "manager_on_duty" | "shift_lead_on_duty";
  note: string | null;
}) {
  return withOperatorMutation(input, async (transaction, memberships) => {
    const teams = await transaction<
      Array<{ organization_id: string; timezone: string }>
    >`select organization_id, timezone from cleaning_teams where id = ${input.teamId}`;
    if (!teams[0]) throw new Error("Choose an active team");
    requireCapability(
      memberships,
      "manage_duty_roster",
      teams[0].organization_id,
      input.teamId,
    );
    const startsAt = localDateTimeToUtc(input.startsAt, teams[0].timezone);
    const endsAt = localDateTimeToUtc(input.endsAt, teams[0].timezone);
    if (Date.parse(endsAt) <= Date.parse(startsAt)
      || Date.parse(endsAt) <= Date.now()
      || Date.parse(endsAt) - Date.parse(startsAt) > 24 * 60 * 60_000) {
      throw new Error("Duty coverage must end after it starts and stay within 24 hours");
    }
    await transaction`
      insert into team_duty_assignments
        (organization_id, team_id, workforce_membership_id, starts_at,
         ends_at, duty_kind, note, is_dev_seed)
      values (${teams[0].organization_id}, ${input.teamId},
        ${input.membershipId}, ${startsAt}, ${endsAt}, ${input.dutyKind},
        ${input.note}, ${input.devOnly})`;
  });
}

export async function cancelTeamDuty(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  dutyId: string;
}) {
  return withOperatorMutation(input, async (transaction, memberships) => {
    const rows = await transaction<Array<{ organization_id: string }>>`
      select organization_id from team_duty_assignments
      where id = ${input.dutyId} and team_id = ${input.teamId}
        and status in ('scheduled', 'active')
        and (${input.devOnly} = false or is_dev_seed)
      for update`;
    if (!rows[0]) throw new Error("Duty coverage changed; refresh and try again");
    requireCapability(
      memberships,
      "manage_duty_roster",
      rows[0].organization_id,
      input.teamId,
    );
    const canceled = await transaction<{ id: string }[]>`
      update team_duty_assignments set status = 'canceled'
      where id = ${input.dutyId} and team_id = ${input.teamId}
        and status in ('scheduled', 'active')
      returning id`;
    if (!canceled[0]) throw new Error("Duty coverage changed; refresh and try again");
  });
}

export async function recordTipIntentStatus(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  tipId: string;
  version: number;
  status: "recorded" | "declined" | "canceled";
  providerReference: string | null;
}) {
  return withOperatorMutation(input, async (transaction, memberships) => {
    const rows = await transaction<
      Array<{ organization_id: string }>
    >`select organization_id from tip_intents
      where id = ${input.tipId} and team_id = ${input.teamId}
        and status = 'pending_collection' and version = ${input.version}
      for update`;
    if (!rows[0]) throw new Error("Choose a tip intent from this team");
    requireCapability(
      memberships,
      "manage_field_operations",
      rows[0].organization_id,
      input.teamId,
    );
    if (input.status === 'recorded' && !input.providerReference) {
      throw new Error("Record the external payment reference before marking a tip recorded");
    }
    const updated = await transaction<{ id: string }[]>`
      update tip_intents set status = ${input.status},
        provider_reference = ${input.status === "recorded" ? input.providerReference : null}
      where id = ${input.tipId} and status = 'pending_collection'
        and version = ${input.version}
      returning id`;
    if (!updated[0]) throw new Error("Tip intent changed; refresh and try again");
  });
}
