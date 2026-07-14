import "server-only";

import type postgres from "postgres";

import { sql } from "./db";
import { getScheduleSuggestions } from "./operations-console-data";
import { requiredElapsedMinutes } from "./operations-scheduling";
import {
  canTransitionRecovery,
  canTransitionRefund,
  canTransitionSchedule,
  canTransitionServiceCase,
  type RecoveryStatus,
  type RefundStatus,
  type ScheduleStatus,
  type ServiceCaseStatus,
} from "./operations-workflows";
import {
  accessibleTeamIds,
  effectiveRoleForTeam,
  hasCapability,
  teamAttentionLevel,
  type OperationsCapability,
  type WorkforceMembership,
  type WorkforceRole,
} from "./team-operations";
import { localDateTimeToUtc, validateUtcInterval } from "./zoned-datetime";

type Transaction = postgres.TransactionSql;

export type OperationsAccess = {
  customerId: string;
  organizationId: string | null;
  organizationName: string | null;
  memberships: WorkforceMembership[];
  devOnly: boolean;
};

export type TeamSummary = {
  id: string;
  code: string;
  name: string;
  status: string;
  timezone: string;
  region_label: string | null;
  active_members: number;
  low_stock_items: number;
  open_restock: number;
  open_callouts: number;
  open_critical_events: number;
  open_service_cases: number;
  average_labor_variance_percent: number | null;
  attention: "healthy" | "watch" | "critical";
};

export type InventoryRow = {
  id: string;
  team_id: string;
  location_id: string;
  location_name: string;
  sku: string;
  name: string;
  category: string;
  unit_label: string;
  unit_cost_cents: number | null;
  preferred_vendor: string | null;
  purchase_url: string | null;
  image_url: string | null;
  on_hand: number;
  reorder_point: number;
  target_level: number;
  automatic_reorder_enabled: boolean;
};

export type RestockRow = {
  id: string;
  product_name: string;
  sku: string;
  location_name: string;
  request_source: string;
  quantity_requested: number;
  status: string;
  estimated_unit_cost_cents: number | null;
  purchase_url_snapshot: string | null;
  created_at: string;
  version: number;
};

export type InventoryTransactionRow = {
  id: string;
  product_name: string;
  location_name: string;
  transaction_type: string;
  quantity_delta: number;
  balance_after: number;
  performed_by: string;
  job_label: string | null;
  note: string | null;
  created_at: string;
};

export type MemberRow = {
  id: string;
  role: WorkforceRole;
  status: string;
  title: string | null;
  display_name: string;
  cleaner_id: string | null;
  customer_id: string | null;
};

export type TimeEntryRow = {
  id: string;
  cleaner_name: string;
  clock_in_at: string;
  clock_out_at: string | null;
  break_minutes: number;
  estimated_minutes_snapshot: number;
  actual_minutes: number | null;
  variance_percent: number | null;
  status: string;
  version: number;
};

export type WorkforceEventRow = {
  id: string;
  subject_name: string;
  event_type: string;
  severity: string;
  status: string;
  summary: string;
  occurred_at: string;
};

export type TeamTimeOffRow = {
  id: string;
  cleaner_name: string;
  start_at: string;
  end_at: string;
  reason_category: string;
  status: string;
};

export type CompensationRow = {
  id: string;
  member_name: string;
  workforce_membership_id: string;
  pay_basis: string;
  amount_cents: number;
  effective_from: string;
  effective_to: string | null;
  status: string;
};

export type BonusRow = {
  id: string;
  member_name: string;
  workforce_membership_id: string;
  amount_cents: number;
  reason: string;
  status: string;
  external_reference: string | null;
  version: number;
  created_at: string;
};

export type ReviewBonusTierRow = {
  id: string;
  name: string;
  minimum_rating: number;
  bonus_cents: number;
  active: boolean;
};

export type QualityReviewRow = {
  id: string;
  cleaner_name: string;
  rating: number;
  source: string;
  evidence_reference: string | null;
  created_at: string;
};

export type QualityReviewCandidate = {
  allocation_id: string;
  cleaner_id: string;
  membership_id: string;
  cleaner_name: string;
  job_label: string;
  customer_id: string;
};

export type ScheduleOption = {
  id: string;
  service_vertical: string;
  start_at: string;
  labor_minutes: number;
  territory_name: string;
};

export type TeamTerritoryCoverageRow = {
  id: string;
  code: string;
  name: string;
  status: string;
  covered: boolean;
  coverage_status: string | null;
};

export type TeamScheduleRow = ScheduleOption & {
  allocation_id: string;
  end_at: string;
  status: string;
  required_crew_size: number;
  assigned_cleaners: string[];
};

export type TeamServiceCaseRow = {
  id: string;
  public_reference: string;
  case_type: string;
  booking_id: string;
  contact_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  status: ServiceCaseStatus;
  priority: string;
  details: string;
  created_at: string;
  booking_mutation_eligible: boolean;
  has_scheduled_reclean: boolean;
  has_open_refund: boolean;
  refundable_balance_cents: number;
  refund_eligible: boolean;
  territory_timezone: string;
};

export type TeamRecoveryActionRow = {
  id: string;
  service_case_id: string;
  public_reference: string;
  action_type: string;
  status: RecoveryStatus;
  owner_label: string;
  scheduled_at: string;
  completed_at: string | null;
  notes: string | null;
  territory_timezone: string;
};

export type TeamRefundRow = {
  id: string;
  service_case_id: string;
  public_reference: string;
  amount_cents: number;
  status: RefundStatus;
  reason_code: string;
  provider: string;
  provider_refund_id: string | null;
  created_at: string;
};

export type TeamRecoveryDashboard = {
  serviceCases: TeamServiceCaseRow[];
  recoveries: TeamRecoveryActionRow[];
  refunds: TeamRefundRow[];
};

export type OperationsDashboard = {
  access: OperationsAccess;
  teams: TeamSummary[];
  selectedTeamId: string | null;
  selectedTeam: TeamSummary | null;
  inventory: InventoryRow[];
  inventoryTransactions: InventoryTransactionRow[];
  restocks: RestockRow[];
  members: MemberRow[];
  organizationMembers: MemberRow[];
  timeEntries: TimeEntryRow[];
  workforceEvents: WorkforceEventRow[];
  timeOffRequests: TeamTimeOffRow[];
  compensation: CompensationRow[];
  bonuses: BonusRow[];
  bonusTiers: ReviewBonusTierRow[];
  qualityReviews: QualityReviewRow[];
  qualityReviewCandidates: QualityReviewCandidate[];
  territoryCoverage: TeamTerritoryCoverageRow[];
  unallocatedSchedules: ScheduleOption[];
  teamSchedules: TeamScheduleRow[];
  staffCandidates: { id: string; label: string }[];
  generalManagerCandidates: { id: string; label: string }[];
  cleanerCandidates: { id: string; label: string }[];
};

export type CrewTeamOperations = {
  memberships: Array<{
    id: string;
    organization_id: string;
    team_id: string;
    team_name: string;
    role: WorkforceRole;
  }>;
  inventory: InventoryRow[];
  restocks: RestockRow[];
  assignments: Array<ScheduleOption & { allocation_id: string; open_time_entry_id: string | null }>;
  timeEntries: TimeEntryRow[];
  bonuses: BonusRow[];
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

async function loadAccess(
  transaction: Transaction,
  customerId: string,
  devOnly: boolean,
): Promise<OperationsAccess> {
  // Hold a shared lock on the actor's access rows for the whole transaction.
  // Revocation therefore either wins before this point (and access is denied)
  // or waits until the authorized operation commits. The lock is acquired by
  // an identity-bound security-definer function because ordinary FOR SHARE is
  // also filtered by UPDATE RLS and would hide manager memberships.
  await transaction`select private.lock_current_workforce_access(${customerId})`;
  const rows = await transaction<
    Array<{
      id: string;
      organization_id: string;
      organization_name: string;
      team_id: string | null;
      role: WorkforceRole;
    }>
  >`
    select membership.id, membership.organization_id,
           organization.name as organization_name,
           membership.team_id, membership.role
    from workforce_memberships membership
    join organizations organization on organization.id = membership.organization_id
    where membership.customer_id = ${customerId}
      and membership.status = 'active'
      and (${devOnly} = false or membership.is_dev_seed)
    order by case membership.role
      when 'owner' then 1 when 'gm' then 2 when 'manager' then 3 else 4 end,
      membership.created_at`;
  const first = rows[0];
  return {
    customerId,
    organizationId: first?.organization_id ?? null,
    organizationName: first?.organization_name ?? null,
    memberships: rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      teamId: row.team_id,
      role: row.role,
    })),
    devOnly,
  };
}

function requireOrganization(access: OperationsAccess) {
  if (!access.organizationId) {
    throw new Error("National owner setup is required before using team operations");
  }
  return access.organizationId;
}

function requireCapability(
  access: OperationsAccess,
  capability: OperationsCapability,
  teamId?: string | null,
) {
  const organizationId = requireOrganization(access);
  if (!hasCapability(access.memberships, capability, organizationId, teamId)) {
    throw new Error("Your current role does not permit this team operation");
  }
  return organizationId;
}

function actorMembershipId(access: OperationsAccess, teamId: string | null) {
  const membershipId = (
    access.memberships.find(
      (membership) =>
        membership.organizationId === access.organizationId &&
        membership.teamId === teamId,
    ) ??
    access.memberships.find(
      (membership) =>
        membership.organizationId === access.organizationId &&
        membership.teamId === null,
    )
  )?.id;
  if (!membershipId) {
    throw new Error("An active workforce membership is required for this operation");
  }
  return membershipId;
}

export async function getOperationsAccess(
  customerId: string,
  devOnly: boolean,
) {
  return withActorContext({ customerId }, (transaction) =>
    loadAccess(transaction, customerId, devOnly),
  );
}

export async function bootstrapNationalOwner(
  customerId: string,
  devOnly: boolean,
) {
  if (devOnly) throw new Error("Owner bootstrap is disabled in preview mode");
  return withActorContext({ customerId }, async (transaction) => {
    const rows = await transaction<{ membership_id: string }[]>`
      select private.bootstrap_lakeandpine_owner(${customerId}) as membership_id`;
    return rows[0]?.membership_id;
  });
}

export async function getOperationsDashboard(input: {
  customerId: string;
  devOnly: boolean;
  requestedTeamId?: string;
}): Promise<OperationsDashboard> {
  return withActorContext({ customerId: input.customerId }, async (transaction) => {
    const access = await loadAccess(transaction, input.customerId, input.devOnly);
    if (!access.organizationId) {
      return {
        access,
        teams: [],
        selectedTeamId: null,
        selectedTeam: null,
        inventory: [],
        inventoryTransactions: [],
        restocks: [],
        members: [],
        organizationMembers: [],
        timeEntries: [],
        workforceEvents: [],
        timeOffRequests: [],
        compensation: [],
        bonuses: [],
        bonusTiers: [],
        qualityReviews: [],
        qualityReviewCandidates: [],
        territoryCoverage: [],
        unallocatedSchedules: [],
        teamSchedules: [],
        staffCandidates: [],
        generalManagerCandidates: [],
        cleanerCandidates: [],
      };
    }

    const organizationId = access.organizationId;
    const rawTeams = await transaction<
      Array<Omit<TeamSummary, "attention">>
    >`
      select team.id, team.code, team.name, team.status, team.timezone,
        team.region_label,
        (select count(*)::int from workforce_memberships membership
          where membership.team_id = team.id and membership.status = 'active') as active_members,
        (select count(*)::int from inventory_stock stock
          where stock.team_id = team.id and stock.on_hand <= stock.reorder_point) as low_stock_items,
        (select count(*)::int from restock_requests restock
          where restock.team_id = team.id and restock.status in ('requested','approved','ordered')) as open_restock,
        (select count(*)::int from workforce_events event
          where event.team_id = team.id and event.event_type = 'callout'
            and event.status in ('open','acknowledged')) as open_callouts,
        (select count(*)::int from workforce_events event
          where event.team_id = team.id and event.severity = 'critical'
            and event.status in ('open','acknowledged')) as open_critical_events,
        (select count(*)::int from service_cases service_case
          join job_schedules schedule on schedule.booking_id = service_case.booking_id
          join team_job_allocations allocation on allocation.job_schedule_id = schedule.id
          where allocation.team_id = team.id
            and service_case.status not in ('resolved','closed','declined','canceled')) as open_service_cases,
        (select round(avg(
          ((extract(epoch from (entry.clock_out_at - entry.clock_in_at)) / 60 - entry.break_minutes)
            - entry.estimated_minutes_snapshot)
          / nullif(entry.estimated_minutes_snapshot, 0) * 100
        ))::int from job_time_entries entry
          where entry.team_id = team.id and entry.status = 'approved'
            and entry.clock_out_at is not null) as average_labor_variance_percent
      from cleaning_teams team
      where team.organization_id = ${organizationId}
        and (${input.devOnly} = false or team.is_dev_seed)
      order by team.status, team.name`;
    const allTeamIds = rawTeams.map((team) => team.id);
    const allowedTeamIds = accessibleTeamIds(
      access.memberships,
      organizationId,
      allTeamIds,
    );
    const teams = rawTeams
      .filter((team) => allowedTeamIds.includes(team.id))
      .map((team) => ({
        ...team,
        attention: teamAttentionLevel({
          lowStockItems: team.low_stock_items,
          openCallouts: team.open_callouts,
          openCriticalEvents: team.open_critical_events,
          averageLaborVariancePercent: team.average_labor_variance_percent,
          openServiceCases: team.open_service_cases,
        }),
      }));
    const selectedTeamId = input.requestedTeamId
      ? allowedTeamIds.includes(input.requestedTeamId)
        ? input.requestedTeamId
        : null
      : teams[0]?.id ?? null;
    if (input.requestedTeamId && !selectedTeamId) {
      throw new Error("That team is outside your active operating scope");
    }

    const canViewNetwork = hasCapability(
      access.memberships,
      "view_network",
      organizationId,
      null,
    );

    const [inventory, inventoryTransactions, restocks, members, timeEntries, workforceEvents, timeOffRequests, compensation, bonuses, bonusTiers, qualityReviews, qualityReviewCandidates, teamSchedules] =
      selectedTeamId
        ? await Promise.all([
            transaction<InventoryRow[]>`
              select product.id, product.team_id, stock.location_id, location.name as location_name,
                product.sku, product.name, product.category, product.unit_label,
                product.unit_cost_cents, product.preferred_vendor, product.purchase_url,
                product.image_url, stock.on_hand::float8, stock.reorder_point::float8,
                stock.target_level::float8, product.automatic_reorder_enabled
              from inventory_products product
              join inventory_stock stock on stock.product_id = product.id
              join inventory_locations location on location.id = stock.location_id
              where product.organization_id = ${organizationId}
                and product.team_id = ${selectedTeamId}
                and product.active
              order by (stock.on_hand <= stock.reorder_point) desc, product.name`,
            transaction<InventoryTransactionRow[]>`
              select movement.id, product.name as product_name,
                location.name as location_name, movement.transaction_type,
                movement.quantity_delta::float8, movement.balance_after::float8,
                coalesce(cleaner.full_name, actor_cleaner.full_name,
                  actor_customer.full_name, actor_customer.email, 'Automatic threshold')
                  as performed_by,
                case when schedule.id is null then null
                  else schedule.service_vertical || ' · ' || schedule.id::text end as job_label,
                movement.note, movement.created_at::text
              from inventory_transactions movement
              join inventory_products product on product.id = movement.product_id
              join inventory_locations location on location.id = movement.location_id
              left join cleaners cleaner on cleaner.id = movement.cleaner_id
              left join workforce_memberships actor on actor.id = movement.actor_membership_id
              left join cleaners actor_cleaner on actor_cleaner.id = actor.cleaner_id
              left join customers actor_customer on actor_customer.id = actor.customer_id
              left join team_job_allocations allocation
                on allocation.id = movement.team_job_allocation_id
              left join job_schedules schedule on schedule.id = allocation.job_schedule_id
              where movement.organization_id = ${organizationId}
                and movement.team_id = ${selectedTeamId}
              order by movement.created_at desc
              limit 200`,
            transaction<RestockRow[]>`
              select request.id, product.name as product_name, product.sku,
                location.name as location_name, request.request_source,
                request.quantity_requested::float8, request.status,
                request.estimated_unit_cost_cents, request.purchase_url_snapshot,
                request.created_at::text, request.version
              from restock_requests request
              join inventory_products product on product.id = request.product_id
              join inventory_locations location on location.id = request.location_id
              where request.organization_id = ${organizationId}
                and request.team_id = ${selectedTeamId}
              order by case request.status when 'requested' then 1 when 'approved' then 2
                when 'ordered' then 3 else 4 end, request.created_at desc
              limit 100`,
            transaction<MemberRow[]>`
              select membership.id, membership.role, membership.status, membership.title,
                coalesce(cleaner.full_name, customer.full_name, customer.email, 'Unnamed member') as display_name,
                membership.cleaner_id, membership.customer_id
              from workforce_memberships membership
              left join cleaners cleaner on cleaner.id = membership.cleaner_id
              left join customers customer on customer.id = membership.customer_id
              where membership.organization_id = ${organizationId}
                and membership.team_id = ${selectedTeamId}
              order by membership.status, case membership.role when 'manager' then 1
                when 'shift_lead' then 2 else 3 end, display_name`,
            transaction<TimeEntryRow[]>`
              select entry.id, cleaner.full_name as cleaner_name,
                entry.clock_in_at::text, entry.clock_out_at::text, entry.break_minutes,
                entry.estimated_minutes_snapshot,
                case when entry.clock_out_at is null then null else greatest(0,
                  round(extract(epoch from (entry.clock_out_at - entry.clock_in_at)) / 60)::int
                  - entry.break_minutes) end as actual_minutes,
                case when entry.clock_out_at is null then null else round((
                  (extract(epoch from (entry.clock_out_at - entry.clock_in_at)) / 60
                    - entry.break_minutes) - entry.estimated_minutes_snapshot
                  ) / nullif(entry.estimated_minutes_snapshot, 0) * 100)::int end as variance_percent,
                entry.status, entry.version
              from job_time_entries entry
              join cleaners cleaner on cleaner.id = entry.cleaner_id
              where entry.organization_id = ${organizationId}
                and entry.team_id = ${selectedTeamId}
              order by entry.clock_in_at desc
              limit 100`,
            transaction<WorkforceEventRow[]>`
              select event.id,
                coalesce(cleaner.full_name, customer.full_name, customer.email, 'Unnamed member') as subject_name,
                event.event_type, event.severity, event.status, event.summary,
                event.occurred_at::text
              from workforce_events event
              join workforce_memberships subject on subject.id = event.subject_membership_id
              left join cleaners cleaner on cleaner.id = subject.cleaner_id
              left join customers customer on customer.id = subject.customer_id
              where event.organization_id = ${organizationId}
                and event.team_id = ${selectedTeamId}
              order by event.occurred_at desc
              limit 100`,
            transaction<TeamTimeOffRow[]>`
              select time_off.id, cleaner.full_name as cleaner_name,
                time_off.start_at::text, time_off.end_at::text,
                time_off.reason_category, time_off.status
              from cleaner_time_off time_off
              join cleaners cleaner on cleaner.id = time_off.cleaner_id
              where time_off.organization_id = ${organizationId}
                and time_off.team_id = ${selectedTeamId}
                and time_off.end_at >= now() - interval '7 days'
              order by case time_off.status when 'requested' then 1 else 2 end,
                time_off.start_at
              limit 100`,
            transaction<CompensationRow[]>`
              select rate.id,
                coalesce(cleaner.full_name, customer.full_name, customer.email, 'Unnamed member') as member_name,
                rate.workforce_membership_id, rate.pay_basis, rate.amount_cents,
                rate.effective_from::text, rate.effective_to::text, rate.status
              from compensation_rates rate
              join workforce_memberships member on member.id = rate.workforce_membership_id
              left join cleaners cleaner on cleaner.id = member.cleaner_id
              left join customers customer on customer.id = member.customer_id
              where rate.organization_id = ${organizationId}
                and rate.team_id = ${selectedTeamId}
              order by rate.effective_from desc`,
            transaction<BonusRow[]>`
              select award.id,
                coalesce(cleaner.full_name, customer.full_name, customer.email, 'Unnamed member') as member_name,
                award.workforce_membership_id, award.amount_cents, award.reason,
                award.status, award.external_reference, award.version,
                award.created_at::text
              from bonus_awards award
              join workforce_memberships member on member.id = award.workforce_membership_id
              left join cleaners cleaner on cleaner.id = member.cleaner_id
              left join customers customer on customer.id = member.customer_id
              where award.organization_id = ${organizationId}
                and award.team_id = ${selectedTeamId}
              order by award.created_at desc
              limit 100`,
            transaction<ReviewBonusTierRow[]>`
              select tier.id, tier.name, tier.minimum_rating::float8,
                tier.bonus_cents, tier.active
              from review_bonus_tiers tier
              where tier.organization_id = ${organizationId}
                and (tier.team_id is null or tier.team_id = ${selectedTeamId})
              order by tier.active desc, tier.minimum_rating desc`,
            transaction<QualityReviewRow[]>`
              select review.id, cleaner.full_name as cleaner_name, review.rating,
                review.source, review.evidence_reference, review.created_at::text
              from quality_reviews review
              join cleaners cleaner on cleaner.id = review.cleaner_id
              where review.organization_id = ${organizationId}
                and review.team_id = ${selectedTeamId}
              order by review.created_at desc
              limit 100`,
            transaction<QualityReviewCandidate[]>`
              select allocation.id as allocation_id, cleaner.id as cleaner_id,
                membership.id as membership_id, cleaner.full_name as cleaner_name,
                schedule.service_vertical || ' · ' || schedule.id::text as job_label,
                booking.customer_id
              from team_job_allocations allocation
              join job_schedules schedule on schedule.id = allocation.job_schedule_id
              join bookings booking on booking.id = schedule.booking_id
              join job_assignments assignment
                on assignment.job_schedule_id = schedule.id
                and assignment.status in ('accepted','confirmed')
              join cleaners cleaner on cleaner.id = assignment.cleaner_id
              join workforce_memberships membership
                on membership.organization_id = allocation.organization_id
                and membership.team_id = allocation.team_id
                and membership.cleaner_id = cleaner.id
                and membership.role in ('cleaner','shift_lead')
                and membership.status = 'active'
              where allocation.organization_id = ${organizationId}
                and allocation.team_id = ${selectedTeamId}
                and schedule.status = 'completed'
                and booking.customer_id is not null
              order by schedule.start_at desc, cleaner.full_name`,
            transaction<TeamScheduleRow[]>`
              select schedule.id, allocation.id as allocation_id,
                schedule.service_vertical, schedule.start_at::text,
                schedule.end_at::text, schedule.labor_minutes,
                territory.name as territory_name, schedule.status,
                schedule.required_crew_size,
                coalesce(array_agg(cleaner.full_name order by cleaner.full_name)
                  filter (where assignment.status in ('proposed','accepted','confirmed')), '{}')
                  as assigned_cleaners
              from team_job_allocations allocation
              join job_schedules schedule on schedule.id = allocation.job_schedule_id
              join service_territories territory on territory.id = schedule.territory_id
              left join job_assignments assignment on assignment.job_schedule_id = schedule.id
                and assignment.team_id = allocation.team_id
              left join cleaners cleaner on cleaner.id = assignment.cleaner_id
              where allocation.organization_id = ${organizationId}
                and allocation.team_id = ${selectedTeamId}
              group by schedule.id, allocation.id, territory.name
              order by schedule.start_at desc
              limit 100`,
          ])
        : [[], [], [], [], [], [], [], [], [], [], [], [], []];

    const canManageMembers = selectedTeamId !== null && hasCapability(
      access.memberships,
      "manage_members",
      organizationId,
      selectedTeamId,
    );
    const canManageOrganizationRoles = hasCapability(
      access.memberships,
      "manage_organization_roles",
      organizationId,
      null,
    );
    const selectedTeamActorRole = selectedTeamId
      ? effectiveRoleForTeam(access.memberships, organizationId, selectedTeamId)
      : null;
    const canCrossAssignTeams = selectedTeamActorRole === "owner"
      || selectedTeamActorRole === "gm";
    const canAllocateSelectedTeam = selectedTeamId !== null && hasCapability(
      access.memberships,
      "allocate_jobs",
      organizationId,
      selectedTeamId,
    );
    const territoryCoverage = selectedTeamId
      ? await transaction<TeamTerritoryCoverageRow[]>`
          select territory.id, territory.code, territory.name, territory.status,
            (coverage.status = 'active') as covered,
            coverage.status as coverage_status
          from service_territories territory
          left join team_service_territories coverage
            on coverage.territory_id = territory.id
            and coverage.organization_id = ${organizationId}
            and coverage.team_id = ${selectedTeamId}
          where (${input.devOnly} = false or territory.is_dev_seed)
          order by (coverage.status = 'active') desc, territory.name`
      : [];
    const unallocatedSchedules = canAllocateSelectedTeam
      ? await transaction<ScheduleOption[]>`
            select schedule.id, schedule.service_vertical, schedule.start_at::text,
              schedule.labor_minutes, territory.name as territory_name
            from job_schedules schedule
            join service_territories territory on territory.id = schedule.territory_id
            join team_service_territories coverage
              on coverage.territory_id = schedule.territory_id
              and coverage.organization_id = ${organizationId}
              and coverage.team_id = ${selectedTeamId}
              and coverage.status = 'active'
            where not exists (
              select 1 from team_job_allocations allocation
              where allocation.job_schedule_id = schedule.id
            )
              and schedule.status in ('tentative','held','confirmed')
              and (${input.devOnly} = false or schedule.is_dev_seed)
            order by schedule.start_at
            limit 50`
      : [];
    const [staffCandidates, cleanerCandidates] = canManageMembers
      ? await Promise.all([
          transaction<{ id: string; label: string }[]>`
            select customer.id,
              coalesce(customer.full_name, customer.email, 'Unnamed staff account') as label
            from customers customer
            where customer.role = 'staff'
              and (${input.devOnly} = false or customer.is_dev_seed)
              and (${canCrossAssignTeams} or not exists (
                select 1 from workforce_memberships active_membership
                where active_membership.customer_id = customer.id
                  and active_membership.status = 'active'
              ))
              and not exists (
                select 1 from workforce_memberships membership
                where membership.organization_id = ${organizationId}
                  and membership.team_id = ${selectedTeamId}
                  and membership.customer_id = customer.id
                  and membership.status = 'active'
              )
            order by label`,
          transaction<{ id: string; label: string }[]>`
            select cleaner.id, cleaner.full_name as label
            from cleaners cleaner
            where cleaner.status in ('onboarding','active')
              and (${input.devOnly} = false or cleaner.is_dev_seed)
              and (${canCrossAssignTeams} or not exists (
                select 1 from workforce_memberships active_membership
                where active_membership.cleaner_id = cleaner.id
                  and active_membership.status = 'active'
              ))
              and not exists (
                select 1 from workforce_memberships membership
                where membership.organization_id = ${organizationId}
                  and membership.team_id = ${selectedTeamId}
                  and membership.cleaner_id = cleaner.id
                  and membership.status = 'active'
              )
            order by cleaner.full_name`,
        ])
      : [[], []];
    const generalManagerCandidates = canManageOrganizationRoles
      ? await transaction<{ id: string; label: string }[]>`
          select customer.id,
            coalesce(customer.full_name, customer.email, 'Unnamed staff account') as label
          from customers customer
          where customer.role = 'staff'
            and (${input.devOnly} = false or customer.is_dev_seed)
            and not exists (
              select 1 from workforce_memberships membership
              where membership.organization_id = ${organizationId}
                and membership.team_id is null
                and membership.customer_id = customer.id
                and membership.status = 'active'
            )
          order by label`
      : [];
    const organizationMembers = canViewNetwork
      ? await transaction<MemberRow[]>`
          select membership.id, membership.role, membership.status, membership.title,
            coalesce(customer.full_name, customer.email, 'Unnamed member') as display_name,
            null::uuid as cleaner_id, membership.customer_id
          from workforce_memberships membership
          join customers customer on customer.id = membership.customer_id
          where membership.organization_id = ${organizationId}
            and membership.team_id is null
          order by case membership.role when 'owner' then 1 else 2 end, display_name`
      : [];

    return {
      access,
      teams,
      selectedTeamId,
      selectedTeam: teams.find((team) => team.id === selectedTeamId) ?? null,
      inventory,
      inventoryTransactions,
      restocks,
      members,
      organizationMembers,
      timeEntries,
      workforceEvents,
      timeOffRequests,
      compensation,
      bonuses,
      bonusTiers,
      qualityReviews,
      qualityReviewCandidates,
      territoryCoverage,
      unallocatedSchedules,
      teamSchedules,
      staffCandidates,
      generalManagerCandidates,
      cleanerCandidates,
    };
  });
}

export async function getScopedTeamScheduleSuggestions(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  scheduleId: string;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "allocate_jobs", input.teamId);
    const allocations = await transaction<{ id: string }[]>`
      select id from team_job_allocations
      where organization_id = ${organizationId} and team_id = ${input.teamId}
        and job_schedule_id = ${input.scheduleId}`;
    if (!allocations[0]) throw new Error("Schedule is outside your team scope");
    const cleaners = await transaction<{ cleaner_id: string }[]>`
      select cleaner_id from workforce_memberships
      where organization_id = ${organizationId} and team_id = ${input.teamId}
        and role in ('cleaner','shift_lead') and status = 'active'
        and cleaner_id is not null`;
    return getScheduleSuggestions(
      input.scheduleId,
      input.devOnly,
      cleaners.map((cleaner) => cleaner.cleaner_id),
      transaction,
    );
  });
}

export async function proposeScopedTeamScheduleCandidate(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  scheduleId: string;
  candidateId: string;
}) {
  await withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "allocate_jobs", input.teamId);
    const allocations = await transaction<{ id: string }[]>`
      select allocation.id
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      where allocation.organization_id = ${organizationId}
        and allocation.team_id = ${input.teamId}
        and allocation.job_schedule_id = ${input.scheduleId}
        and schedule.status in ('tentative','held')
      for update of allocation, schedule`;
    if (!allocations[0]) throw new Error("Schedule is outside your team scope");
    await transaction`select private.lock_team_crew_memberships(
      ${organizationId}, ${input.teamId}
    )`;
    const cleaners = await transaction<{ cleaner_id: string }[]>`
      select cleaner_id from workforce_memberships
      where organization_id = ${organizationId} and team_id = ${input.teamId}
        and role in ('cleaner','shift_lead') and status = 'active'
        and cleaner_id is not null`;
    const allowedCleanerIds = cleaners.map((cleaner) => cleaner.cleaner_id);
    const suggestions = await getScheduleSuggestions(
      input.scheduleId,
      input.devOnly,
      allowedCleanerIds,
      transaction,
    );
    const candidate = suggestions.find(
      (suggestion) => suggestion.candidateId === input.candidateId && suggestion.eligible,
    );
    if (!candidate) {
      throw new Error("That scheduling recommendation is no longer eligible");
    }
    const allowed = new Set(allowedCleanerIds);
    if (!candidate.cleanerIds.every((cleanerId) => allowed.has(cleanerId))) {
      throw new Error("Every recommended cleaner must be active in this team");
    }
    const acceptedAssignments = await transaction<{ cleaner_id: string }[]>`
      select cleaner_id from job_assignments
      where job_schedule_id = ${input.scheduleId}
        and status in ('accepted','confirmed')`;
    if (acceptedAssignments.some(
      (assignment) => !candidate.cleanerIds.includes(assignment.cleaner_id),
    )) {
      throw new Error("The selected crew must retain every cleaner who already accepted");
    }
    await transaction`
      update job_assignments
      set status = 'removed', responded_at = now()
      where job_schedule_id = ${input.scheduleId}
        and status = 'proposed'
        and cleaner_id <> all(${candidate.cleanerIds}::uuid[])`;
    for (const [index, cleanerId] of candidate.cleanerIds.entries()) {
      await transaction`
        insert into job_assignments
          (job_schedule_id, cleaner_id, team_id, assignment_role, status,
           suggestion_score, suggestion_reasons, assigned_by_label, is_dev_seed)
        values (${input.scheduleId}, ${cleanerId}, ${input.teamId},
          ${index === 0 ? "lead" : "member"}, 'proposed', ${candidate.score},
          ${transaction.json(candidate.reasons as postgres.JSONValue)},
          'Scoped team operator', ${input.devOnly})
        on conflict (job_schedule_id, cleaner_id) do update set
          team_id = excluded.team_id,
          assignment_role = excluded.assignment_role,
          status = case
            when job_assignments.status in ('accepted','confirmed') then job_assignments.status
            else 'proposed'
          end,
          suggestion_score = excluded.suggestion_score,
          suggestion_reasons = excluded.suggestion_reasons,
          assigned_at = now()`;
    }
  });
}

export async function transitionScopedTeamSchedule(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  scheduleId: string;
  from: ScheduleStatus;
  to: ScheduleStatus;
}) {
  if (!canTransitionSchedule(input.from, input.to)) {
    throw new Error("Invalid schedule transition");
  }
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "allocate_jobs", input.teamId);
    const allocations = await transaction<{ id: string }[]>`
      select allocation.id
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      where allocation.organization_id = ${organizationId}
        and allocation.team_id = ${input.teamId}
        and schedule.id = ${input.scheduleId} and schedule.status = ${input.from}
        and (${input.devOnly} = false or (
          allocation.is_dev_seed and schedule.is_dev_seed
        ))
      for update of allocation, schedule`;
    if (!allocations[0]) throw new Error("Schedule changed or is outside your team");
    const rows = await transaction<{ id: string }[]>`
      update job_schedules
      set status = ${input.to}, version = version + 1
      where id = ${input.scheduleId} and status = ${input.from}
        and (${input.devOnly} = false or is_dev_seed)
      returning id`;
    if (!rows[0]) throw new Error("Schedule changed; refresh and retry");
  });
}

async function withStaffMutation<T>(
  input: { customerId: string; devOnly: boolean },
  run: (
    transaction: Transaction,
    access: OperationsAccess,
  ) => Promise<T>,
) {
  return withActorContext({ customerId: input.customerId }, async (transaction) => {
    const access = await loadAccess(transaction, input.customerId, input.devOnly);
    return run(transaction, access);
  });
}

export async function createOperatingTeam(input: {
  customerId: string;
  devOnly: boolean;
  code: string;
  name: string;
  timezone: string;
  regionLabel: string | null;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "manage_teams", null);
    const rows = await transaction<{ id: string }[]>`
      insert into cleaning_teams
        (organization_id, code, name, timezone, region_label, status, is_dev_seed)
      values (${organizationId}, ${input.code}, ${input.name}, ${input.timezone},
        ${input.regionLabel}, 'active', ${input.devOnly})
      returning id`;
    await transaction`
      insert into inventory_locations
        (organization_id, team_id, name, location_type)
      values (${organizationId}, ${rows[0].id}, 'Team supply room', 'supply_room')`;
    return rows[0].id;
  });
}

export async function setTeamTerritoryCoverage(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  territoryId: string;
  enabled: boolean;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "manage_teams", null);
    const territories = await transaction<{ id: string }[]>`
      select id from service_territories
      where id = ${input.territoryId} and status in ('active','paused')
        and (${input.devOnly} = false or is_dev_seed)`;
    if (!territories[0]) throw new Error("Choose an available service territory");
    await transaction`
      insert into team_service_territories
        (organization_id, team_id, territory_id, status, is_dev_seed)
      values (${organizationId}, ${input.teamId}, ${input.territoryId},
        ${input.enabled ? "active" : "paused"}, ${input.devOnly})
      on conflict (team_id, territory_id) do update
      set status = excluded.status, updated_at = now()`;
  });
}

export async function addWorkforceMembership(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  role: "manager" | "shift_lead" | "cleaner";
  subjectType: "staff" | "cleaner";
  subjectId: string;
  title: string | null;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "manage_members", input.teamId);
    const actorRole = effectiveRoleForTeam(access.memberships, organizationId, input.teamId);
    if (input.role === "manager") {
      requireCapability(access, "manage_teams", null);
    }
    if (
      (input.role === "manager" && input.subjectType !== "staff")
      || (input.role === "cleaner" && input.subjectType !== "cleaner")
    ) {
      throw new Error("That identity type cannot receive the selected role");
    }
    if (actorRole === "manager") {
      const [availability] = await transaction<{ available: boolean }[]>`
        select private.subject_available_to_local_team(
          ${organizationId}, ${input.teamId},
          ${input.subjectType === "staff" ? input.subjectId : null}::uuid,
          ${input.subjectType === "cleaner" ? input.subjectId : null}::uuid
        ) as available`;
      if (!availability?.available) {
        throw new Error("Local managers cannot transfer or cross-assign people from another team");
      }
    }
    const rows = await transaction<{ id: string }[]>`
      insert into workforce_memberships
        (organization_id, team_id, customer_id, cleaner_id, role, status, title,
         hired_at, is_dev_seed)
      values (${organizationId}, ${input.teamId},
        ${input.subjectType === "staff" ? input.subjectId : null},
        ${input.subjectType === "cleaner" ? input.subjectId : null},
        ${input.role}, 'active', ${input.title}, current_date, ${input.devOnly})
      returning id`;
    return rows[0]?.id;
  });
}

export async function addGeneralManagerMembership(input: {
  customerId: string;
  devOnly: boolean;
  subjectId: string;
  title: string | null;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(
      access,
      "manage_organization_roles",
      null,
    );
    const rows = await transaction<{ id: string }[]>`
      insert into workforce_memberships
        (organization_id, customer_id, role, status, title, hired_at, is_dev_seed)
      select ${organizationId}, customer.id, 'gm', 'active', ${input.title},
        current_date, ${input.devOnly}
      from customers customer
      where customer.id = ${input.subjectId} and customer.role = 'staff'
        and (${input.devOnly} = false or customer.is_dev_seed)
      returning id`;
    if (!rows[0]) throw new Error("Choose an eligible staff account");
    return rows[0].id;
  });
}

export async function updateWorkforceMembershipStatus(input: {
  customerId: string;
  devOnly: boolean;
  membershipId: string;
  teamId: string | null;
  from: "active" | "paused";
  to: "active" | "paused" | "ended";
  reason: string;
}) {
  if (
    input.from === input.to
    || (input.from === "active" && !["paused", "ended"].includes(input.to))
    || (input.from === "paused" && !["active", "ended"].includes(input.to))
  ) {
    throw new Error("Invalid workforce membership transition");
  }
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = input.teamId
      ? requireCapability(access, "manage_members", input.teamId)
      : requireCapability(access, "manage_organization_roles", null);
    const subjects = await transaction<{
      id: string;
      role: WorkforceRole;
      cleaner_id: string | null;
      is_dev_seed: boolean;
    }[]>`
      select id, role, cleaner_id, is_dev_seed
      from workforce_memberships
      where id = ${input.membershipId}
        and organization_id = ${organizationId}
        and team_id is not distinct from ${input.teamId}
        and status = ${input.from}
      for update`;
    const subject = subjects[0];
    if (!subject) throw new Error("Membership changed or is outside your scope");
    if (subject.role === "owner") throw new Error("Owner access cannot be ended here");
    if (subject.role === "gm" && input.teamId !== null) {
      throw new Error("General managers are organization-scoped");
    }
    if (subject.role === "manager") requireCapability(access, "manage_teams", null);
    const actorId = actorMembershipId(access, input.teamId);
    const rows = await transaction<{ id: string }[]>`
      update workforce_memberships
      set status = ${input.to},
        ended_at = case when ${input.to} = 'ended' then current_date else null end,
        status_reason = ${input.reason},
        status_changed_by_membership_id = ${actorId},
        status_changed_at = now()
      where id = ${input.membershipId} and status = ${input.from}
      returning id`;
    if (!rows[0]) throw new Error("Membership changed; refresh and retry");
    if (subject.cleaner_id) {
      if (input.to === "active") {
        await transaction`update cleaners set status = 'active'
          where id = ${subject.cleaner_id} and status in ('onboarding','inactive')`;
      } else if (input.to === "ended") {
        await transaction`update cleaners set status = 'inactive'
          where id = ${subject.cleaner_id}
            and not exists (
              select 1 from workforce_memberships other
              where other.cleaner_id = ${subject.cleaner_id}
                and other.id <> ${input.membershipId} and other.status = 'active'
            )`;
      }
    }
    if (input.teamId) {
      await transaction`
        insert into workforce_events
          (organization_id, team_id, subject_membership_id, event_type, severity,
           status, summary, created_by_membership_id, is_dev_seed)
        values (${organizationId}, ${input.teamId}, ${input.membershipId},
          ${input.to === "ended" ? "termination" : input.to === "active" ? "reactivation" : "suspension"},
          ${input.to === "ended" ? "high" : input.to === "active" ? "info" : "medium"},
          ${input.to === "active" ? "resolved" : "open"}, ${input.reason},
          ${actorId}, ${subject.is_dev_seed})`;
    }
  });
}

export async function createInventoryProduct(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  sku: string;
  name: string;
  category: string;
  unitLabel: string;
  unitCostCents: number | null;
  preferredVendor: string | null;
  purchaseUrl: string | null;
  imageUrl: string | null;
  initialCount: number;
  reorderPoint: number;
  targetLevel: number;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "manage_inventory", input.teamId);
    const actorId = actorMembershipId(access, input.teamId);
    const locations = await transaction<{ id: string }[]>`
      select id from inventory_locations
      where organization_id = ${organizationId} and team_id = ${input.teamId}
        and active
      order by created_at limit 1`;
    if (!locations[0]) throw new Error("Create an active team stock location first");
    const products = await transaction<{ id: string }[]>`
      insert into inventory_products
        (organization_id, team_id, sku, name, category, unit_label,
         unit_cost_cents, preferred_vendor, purchase_url, image_url,
         created_by_membership_id, is_dev_seed)
      values (${organizationId}, ${input.teamId}, ${input.sku}, ${input.name},
        ${input.category}, ${input.unitLabel}, ${input.unitCostCents},
        ${input.preferredVendor}, ${input.purchaseUrl}, ${input.imageUrl},
        ${actorId}, ${input.devOnly})
      returning id`;
    const productId = products[0].id;
    await transaction`
      insert into inventory_stock
        (organization_id, team_id, location_id, product_id, on_hand,
         reorder_point, target_level)
      values (${organizationId}, ${input.teamId}, ${locations[0].id}, ${productId},
        0, 0, 0)`;
    if (input.initialCount > 0) {
      await transaction`
        insert into inventory_transactions
          (organization_id, team_id, location_id, product_id, transaction_type,
           quantity_delta, balance_after, actor_membership_id, unit_cost_cents,
           note, is_dev_seed)
        values (${organizationId}, ${input.teamId}, ${locations[0].id}, ${productId},
          'receipt', ${input.initialCount}, 0, ${actorId}, ${input.unitCostCents},
          'Opening team stock count', ${input.devOnly})`;
    }
    await transaction`
      update inventory_stock set reorder_point = ${input.reorderPoint},
        target_level = ${input.targetLevel}
      where location_id = ${locations[0].id} and product_id = ${productId}`;
    return productId;
  });
}

export async function recordTeamInventoryUsage(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  productId: string;
  locationId: string;
  quantity: number;
  note: string | null;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "use_inventory", input.teamId);
    const rows = await transaction<{ id: string }[]>`
      insert into inventory_transactions
        (organization_id, team_id, location_id, product_id, transaction_type,
         quantity_delta, balance_after, actor_membership_id, note, is_dev_seed)
      values (${organizationId}, ${input.teamId}, ${input.locationId}, ${input.productId},
        'usage', ${-input.quantity}, 0, ${actorMembershipId(access, input.teamId)},
        ${input.note}, ${input.devOnly})
      returning id`;
    return rows[0]?.id;
  });
}

export async function reviewRestockRequest(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  restockId: string;
  from: string;
  to: "approved" | "ordered" | "received" | "declined" | "canceled";
  version: number;
  decisionNote: string | null;
}) {
  const allowedTransitions: Record<string, readonly string[]> = {
    requested: ["approved", "declined", "canceled"],
    approved: ["ordered", "canceled"],
    ordered: ["received", "canceled"],
  };
  if (!allowedTransitions[input.from]?.includes(input.to)) {
    throw new Error("Invalid restock transition");
  }
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "approve_restock", input.teamId);
    const requests = await transaction<
      Array<{
        id: string;
        location_id: string;
        product_id: string;
        quantity_requested: number;
        estimated_unit_cost_cents: number | null;
      }>
    >`
      select id, location_id, product_id, quantity_requested::float8,
        estimated_unit_cost_cents
      from restock_requests
      where id = ${input.restockId} and organization_id = ${organizationId}
        and team_id = ${input.teamId} and status = ${input.from}
        and version = ${input.version}
      for update`;
    if (!requests[0]) throw new Error("Restock request changed or is outside your team");
    const changed = await transaction<{ id: string }[]>`
      update restock_requests
      set status = ${input.to}, version = version + 1,
        decision_by_membership_id = ${actorMembershipId(access, input.teamId)},
        decision_note = ${input.decisionNote},
        decided_at = case when ${input.to} in ('approved','declined','canceled') then now() else decided_at end,
        ordered_at = case when ${input.to} = 'ordered' then now() else ordered_at end,
        received_at = case when ${input.to} = 'received' then now() else received_at end
      where id = ${input.restockId} and organization_id = ${organizationId}
        and team_id = ${input.teamId} and status = ${input.from}
        and version = ${input.version}
      returning id`;
    if (!changed[0]) throw new Error("Restock request changed; refresh and retry");
  });
}

export async function allocateScheduleToTeam(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  scheduleId: string;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "allocate_jobs", input.teamId);
    const schedules = await transaction<{ labor_minutes: number; territory_id: string }[]>`
      select schedule.labor_minutes, schedule.territory_id
      from job_schedules schedule
      join team_service_territories coverage
        on coverage.territory_id = schedule.territory_id
        and coverage.organization_id = ${organizationId}
        and coverage.team_id = ${input.teamId}
        and coverage.status = 'active'
      where schedule.id = ${input.scheduleId}
        and schedule.status in ('tentative','held','confirmed')
        and (${input.devOnly} = false or schedule.is_dev_seed)
      for update of schedule`;
    if (!schedules[0]) throw new Error("Schedule is no longer available for allocation");
    const coverage = await transaction<{ covered: boolean }[]>`
      select private.lock_active_team_territory_coverage(
        ${organizationId}, ${input.teamId}, ${schedules[0].territory_id}
      ) as covered`;
    if (!coverage[0]?.covered) {
      throw new Error("This team's territory coverage changed; refresh and retry");
    }
    await transaction`
      insert into team_job_allocations
        (organization_id, team_id, job_schedule_id, assigned_by_membership_id,
         estimated_labor_minutes, is_dev_seed)
      values (${organizationId}, ${input.teamId}, ${input.scheduleId},
        ${actorMembershipId(access, input.teamId)}, ${schedules[0].labor_minutes},
        ${input.devOnly})`;
  });
}

export async function reviewTimeEntry(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  entryId: string;
  to: "approved" | "rejected";
  version: number;
  reason: string | null;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "review_time", input.teamId);
    const rows = await transaction<{ id: string }[]>`
      update job_time_entries
      set status = ${input.to}, version = version + 1,
        approved_by_membership_id = ${actorMembershipId(access, input.teamId)},
        approved_at = case when ${input.to} = 'approved' then now() else null end,
        adjustment_reason = ${input.reason}
      where id = ${input.entryId} and organization_id = ${organizationId}
        and team_id = ${input.teamId} and status = 'submitted'
        and version = ${input.version}
      returning id`;
    if (!rows[0]) throw new Error("Time entry changed or is outside your team");
  });
}

export async function reviewTeamTimeOff(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  timeOffId: string;
  to: "approved" | "declined";
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "review_time", input.teamId);
    const actorId = actorMembershipId(access, input.teamId);
    const rows = await transaction<{ id: string }[]>`
      update cleaner_time_off
      set status = ${input.to}, reviewed_by_label = 'Scoped team manager',
        reviewed_by_membership_id = ${actorId}, reviewed_at = now()
      where id = ${input.timeOffId}
        and organization_id = ${organizationId} and team_id = ${input.teamId}
        and status = 'requested'
      returning id`;
    if (!rows[0]) throw new Error("Time-off request changed or is outside your team");
  });
}

export async function setCompensationRate(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  membershipId: string;
  payBasis: "hourly" | "salary" | "per_job";
  amountCents: number;
  effectiveFrom: string;
  reason: string;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "manage_compensation", input.teamId);
    const actorRole = effectiveRoleForTeam(access.memberships, organizationId, input.teamId);
    const subject = await transaction<{ id: string; role: WorkforceRole }[]>`
      select id, role from workforce_memberships
      where id = ${input.membershipId} and organization_id = ${organizationId}
        and team_id = ${input.teamId} and status = 'active'
      for update`;
    if (!subject[0]) throw new Error("Choose an active member of this team");
    if (actorRole === "manager" && !["shift_lead", "cleaner"].includes(subject[0].role)) {
      throw new Error("Managers may set pay only for shift leads and cleaners");
    }
    await transaction`
      update compensation_rates
      set status = 'ended', effective_to = ${input.effectiveFrom}::date - 1
      where workforce_membership_id = ${input.membershipId}
        and status = 'active' and effective_from < ${input.effectiveFrom}`;
    await transaction`
      insert into compensation_rates
        (organization_id, team_id, workforce_membership_id, pay_basis,
         amount_cents, effective_from, status, created_by_membership_id,
         reason, is_dev_seed)
      values (${organizationId}, ${input.teamId}, ${input.membershipId},
        ${input.payBasis}, ${input.amountCents}, ${input.effectiveFrom}, 'active',
        ${actorMembershipId(access, input.teamId)}, ${input.reason}, ${input.devOnly})`;
  });
}

export async function createBonusAward(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  membershipId: string;
  amountCents: number;
  reason: string;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "award_bonus", input.teamId);
    const actorRole = effectiveRoleForTeam(access.memberships, organizationId, input.teamId);
    const rows = await transaction<{ id: string }[]>`
      insert into bonus_awards
        (organization_id, team_id, workforce_membership_id, amount_cents,
         reason, status, is_dev_seed)
      select ${organizationId}, ${input.teamId}, membership.id, ${input.amountCents},
        ${input.reason}, 'proposed', ${input.devOnly}
      from workforce_memberships membership
      where membership.id = ${input.membershipId}
        and membership.organization_id = ${organizationId}
        and membership.team_id = ${input.teamId} and membership.status = 'active'
        and (${actorRole !== "manager"} or membership.role in ('shift_lead','cleaner'))
      returning id`;
    if (!rows[0]) throw new Error("Choose an active member of this team");
  });
}

export async function createReviewBonusTier(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  name: string;
  minimumRating: number;
  bonusCents: number;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "award_bonus", input.teamId);
    await transaction`
      insert into review_bonus_tiers
        (organization_id, team_id, name, minimum_rating, bonus_cents, is_dev_seed)
      values (${organizationId}, ${input.teamId}, ${input.name},
        ${input.minimumRating}, ${input.bonusCents}, ${input.devOnly})`;
  });
}

export async function createQualityReview(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  allocationId: string;
  cleanerId: string;
  source: "verified_customer" | "quality_inspection" | "manager_review";
  rating: number;
  evidenceReference: string | null;
  privateNote: string | null;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "award_bonus", input.teamId);
    const candidates = await transaction<{ customer_id: string }[]>`
      select booking.customer_id
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join bookings booking on booking.id = schedule.booking_id
      join job_assignments assignment
        on assignment.job_schedule_id = schedule.id
        and assignment.cleaner_id = ${input.cleanerId}
        and assignment.status in ('accepted','confirmed')
      where allocation.id = ${input.allocationId}
        and allocation.organization_id = ${organizationId}
        and allocation.team_id = ${input.teamId}
        and schedule.status in ('quality_review','completed')
      for update of allocation, schedule`;
    if (!candidates[0]?.customer_id) {
      throw new Error("Choose eligible team work and a cleaner who completed it");
    }
    await transaction`
      insert into quality_reviews
        (organization_id, team_id, team_job_allocation_id, cleaner_id,
         customer_id, rating, source, verified_at, evidence_reference,
         private_note, created_by_membership_id, is_dev_seed)
      values (${organizationId}, ${input.teamId}, ${input.allocationId},
        ${input.cleanerId},
        ${input.source === "verified_customer" ? candidates[0].customer_id : null},
        ${input.rating}, ${input.source},
        ${input.source === "verified_customer" ? new Date().toISOString() : null},
        ${input.evidenceReference}, ${input.privateNote},
        ${actorMembershipId(access, input.teamId)}, ${input.devOnly})`;
  });
}

export async function transitionBonusAward(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  bonusId: string;
  from: "proposed" | "approved" | "exported";
  to: "approved" | "exported" | "recorded_paid" | "canceled";
  version: number;
  externalReference: string | null;
}) {
  const transitions: Record<string, readonly string[]> = {
    proposed: ["approved", "canceled"],
    approved: ["exported", "canceled"],
    exported: ["recorded_paid", "canceled"],
  };
  if (!transitions[input.from]?.includes(input.to)) {
    throw new Error("Invalid bonus transition");
  }
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "award_bonus", input.teamId);
    const actorId = actorMembershipId(access, input.teamId);
    const rows = await transaction<{ id: string }[]>`
      update bonus_awards
      set status = ${input.to}, version = version + 1,
        approved_by_membership_id = case
          when ${input.to} in ('approved','exported','recorded_paid')
            then coalesce(approved_by_membership_id, ${actorId})
          else approved_by_membership_id end,
        approved_at = case
          when ${input.to} in ('approved','exported','recorded_paid')
            then coalesce(approved_at, now())
          else approved_at end,
        external_reference = case
          when ${input.to} in ('exported','recorded_paid') then ${input.externalReference}
          else external_reference end
      where id = ${input.bonusId} and organization_id = ${organizationId}
        and team_id = ${input.teamId} and status = ${input.from}
        and version = ${input.version}
      returning id`;
    if (!rows[0]) throw new Error("Bonus changed or is outside your team");
  });
}

export async function createWorkforceEvent(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  membershipId: string;
  eventType: string;
  severity: string;
  summary: string;
  privateDetails: string | null;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "manage_workforce_events", input.teamId);
    const actorRole = effectiveRoleForTeam(access.memberships, organizationId, input.teamId);
    const operationalEvent = ["callout", "late", "no_show", "safety", "recognition", "other"]
      .includes(input.eventType);
    const rows = await transaction<{ id: string }[]>`
      insert into workforce_events
        (organization_id, team_id, subject_membership_id, event_type, severity,
         summary, private_details, created_by_membership_id, is_dev_seed)
      select ${organizationId}, ${input.teamId}, membership.id, ${input.eventType},
        ${input.severity}, ${input.summary}, ${input.privateDetails},
        ${actorMembershipId(access, input.teamId)}, ${input.devOnly}
      from workforce_memberships membership
      where membership.id = ${input.membershipId}
        and membership.organization_id = ${organizationId}
        and membership.team_id = ${input.teamId}
        and (${actorRole !== "manager"} or membership.role in ('shift_lead','cleaner'))
        and (${actorRole !== "shift_lead"} or (
          membership.role in ('shift_lead','cleaner') and ${operationalEvent}
        ))
      returning id`;
    if (!rows[0]) throw new Error("Choose a member of this team");
  });
}

export async function getCrewTeamOperations(
  cleanerId: string,
  devOnly: boolean,
): Promise<CrewTeamOperations> {
  return withActorContext({ cleanerId }, async (transaction) => {
    const memberships = await transaction<CrewTeamOperations["memberships"]>`
      select membership.id, membership.organization_id, membership.team_id,
        team.name as team_name, membership.role
      from workforce_memberships membership
      join cleaning_teams team on team.id = membership.team_id
      where membership.cleaner_id = ${cleanerId}
        and membership.status = 'active'
        and (${devOnly} = false or membership.is_dev_seed)
      order by team.name`;
    const teamIds = memberships.map((membership) => membership.team_id);
    if (teamIds.length === 0) {
      return { memberships, inventory: [], restocks: [], assignments: [], timeEntries: [], bonuses: [] };
    }
    const [inventory, restocks, assignments, timeEntries, bonuses] = await Promise.all([
      transaction<InventoryRow[]>`
        select product.id, product.team_id, stock.location_id, location.name as location_name,
          product.sku, product.name, product.category, product.unit_label,
          product.unit_cost_cents, product.preferred_vendor, product.purchase_url,
          product.image_url, stock.on_hand::float8, stock.reorder_point::float8,
          stock.target_level::float8, product.automatic_reorder_enabled
        from inventory_products product
        join inventory_stock stock on stock.product_id = product.id
        join inventory_locations location on location.id = stock.location_id
        where product.team_id = any(${teamIds}::uuid[]) and product.active
        order by product.name`,
      transaction<RestockRow[]>`
        select request.id, product.name as product_name, product.sku,
          location.name as location_name, request.request_source,
          request.quantity_requested::float8, request.status,
          request.estimated_unit_cost_cents, request.purchase_url_snapshot,
          request.created_at::text, request.version
        from restock_requests request
        join inventory_products product on product.id = request.product_id
        join inventory_locations location on location.id = request.location_id
        join workforce_memberships membership on membership.id = request.requested_by_membership_id
        where membership.cleaner_id = ${cleanerId}
        order by request.created_at desc limit 30`,
      transaction<Array<ScheduleOption & { allocation_id: string; open_time_entry_id: string | null }>>`
        select schedule.id, allocation.id as allocation_id, schedule.service_vertical,
          schedule.start_at::text, schedule.labor_minutes,
          territory.name as territory_name, open_entry.id as open_time_entry_id
        from team_job_allocations allocation
        join job_schedules schedule on schedule.id = allocation.job_schedule_id
        join service_territories territory on territory.id = schedule.territory_id
        join job_assignments assignment on assignment.job_schedule_id = schedule.id
          and assignment.cleaner_id = ${cleanerId}
          and assignment.status in ('accepted','confirmed')
        left join job_time_entries open_entry on open_entry.team_job_allocation_id = allocation.id
          and open_entry.cleaner_id = ${cleanerId} and open_entry.status = 'open'
        where allocation.team_id = any(${teamIds}::uuid[])
          and schedule.status in ('confirmed','en_route','in_progress','quality_review')
        order by schedule.start_at`,
      transaction<TimeEntryRow[]>`
        select entry.id, cleaner.full_name as cleaner_name,
          entry.clock_in_at::text, entry.clock_out_at::text, entry.break_minutes,
          entry.estimated_minutes_snapshot,
          case when entry.clock_out_at is null then null else greatest(0,
            round(extract(epoch from (entry.clock_out_at - entry.clock_in_at)) / 60)::int
            - entry.break_minutes) end as actual_minutes,
          case when entry.clock_out_at is null then null else round((
            (extract(epoch from (entry.clock_out_at - entry.clock_in_at)) / 60
              - entry.break_minutes) - entry.estimated_minutes_snapshot
            ) / nullif(entry.estimated_minutes_snapshot, 0) * 100)::int end as variance_percent,
          entry.status, entry.version
        from job_time_entries entry
        join cleaners cleaner on cleaner.id = entry.cleaner_id
        where entry.cleaner_id = ${cleanerId}
        order by entry.clock_in_at desc limit 30`,
      transaction<BonusRow[]>`
        select award.id, cleaner.full_name as member_name,
          award.workforce_membership_id, award.amount_cents, award.reason,
          award.status, award.external_reference, award.version,
          award.created_at::text
        from bonus_awards award
        join workforce_memberships member on member.id = award.workforce_membership_id
        join cleaners cleaner on cleaner.id = member.cleaner_id
        where member.cleaner_id = ${cleanerId}
        order by award.created_at desc limit 30`,
    ]);
    return { memberships, inventory, restocks, assignments, timeEntries, bonuses };
  });
}

async function withCleanerMutation<T>(
  input: { cleanerId: string; devOnly: boolean },
  run: (transaction: Transaction) => Promise<T>,
) {
  if (input.devOnly) throw new Error("Crew operations writes are disabled in preview mode");
  return withActorContext({ cleanerId: input.cleanerId }, run);
}

export async function recordCleanerInventoryUsage(input: {
  cleanerId: string;
  devOnly: boolean;
  membershipId: string;
  productId: string;
  locationId: string;
  quantity: number;
  note: string | null;
}) {
  return withCleanerMutation(input, async (transaction) => {
    const memberships = await transaction<
      { organization_id: string; team_id: string }[]
    >`
      select organization_id, team_id from workforce_memberships
      where id = ${input.membershipId} and cleaner_id = ${input.cleanerId}
        and role in ('cleaner','shift_lead') and status = 'active'`;
    if (!memberships[0]) throw new Error("Choose one of your active teams");
    await transaction`
      insert into inventory_transactions
        (organization_id, team_id, location_id, product_id, transaction_type,
         quantity_delta, balance_after, actor_membership_id, cleaner_id, note)
      values (${memberships[0].organization_id}, ${memberships[0].team_id},
        ${input.locationId}, ${input.productId}, 'usage', ${-input.quantity}, 0,
        ${input.membershipId}, ${input.cleanerId}, ${input.note})`;
  });
}

export async function requestCleanerRestock(input: {
  cleanerId: string;
  devOnly: boolean;
  membershipId: string;
  productId: string;
  locationId: string;
  quantity: number;
}) {
  return withCleanerMutation(input, async (transaction) => {
    const memberships = await transaction<
      { organization_id: string; team_id: string }[]
    >`
      select organization_id, team_id from workforce_memberships
      where id = ${input.membershipId} and cleaner_id = ${input.cleanerId}
        and role in ('cleaner','shift_lead') and status = 'active'`;
    if (!memberships[0]) throw new Error("Choose one of your active teams");
    const rows = await transaction<
      { unit_cost_cents: number | null; purchase_url: string | null }[]
    >`
      select unit_cost_cents, purchase_url from inventory_products
      where id = ${input.productId} and organization_id = ${memberships[0].organization_id}
        and team_id = ${memberships[0].team_id} and active`;
    if (!rows[0]) throw new Error("Choose an active product from your team");
    await transaction`
      insert into restock_requests
        (organization_id, team_id, location_id, product_id,
         requested_by_membership_id, request_source, quantity_requested,
         estimated_unit_cost_cents, purchase_url_snapshot)
      values (${memberships[0].organization_id}, ${memberships[0].team_id},
        ${input.locationId}, ${input.productId}, ${input.membershipId}, 'cleaner',
        ${input.quantity}, ${rows[0].unit_cost_cents}, ${rows[0].purchase_url})`;
  });
}

export async function startCrewTimeEntry(input: {
  cleanerId: string;
  devOnly: boolean;
  allocationId: string;
}) {
  return withCleanerMutation(input, async (transaction) => {
    const rows = await transaction<
      Array<{ organization_id: string; team_id: string; expected_minutes: number }>
    >`
      select allocation.organization_id, allocation.team_id,
        greatest(1, ceil(schedule.labor_minutes::numeric / schedule.required_crew_size)::int)
          as expected_minutes
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join job_assignments assignment on assignment.job_schedule_id = schedule.id
      join workforce_memberships membership on membership.team_id = allocation.team_id
        and membership.organization_id = allocation.organization_id
        and membership.cleaner_id = ${input.cleanerId}
        and membership.role in ('cleaner','shift_lead') and membership.status = 'active'
      where allocation.id = ${input.allocationId}
        and assignment.cleaner_id = ${input.cleanerId}
        and assignment.status in ('accepted','confirmed')
        and schedule.status in ('confirmed','en_route','in_progress')
      for update of allocation, schedule`;
    if (!rows[0]) throw new Error("This assignment is not ready for your time clock");
    await transaction`
      insert into job_time_entries
        (organization_id, team_id, team_job_allocation_id, cleaner_id,
         clock_in_at, estimated_minutes_snapshot, status)
      values (${rows[0].organization_id}, ${rows[0].team_id}, ${input.allocationId},
        ${input.cleanerId}, now(), ${rows[0].expected_minutes}, 'open')`;
  });
}

export async function stopCrewTimeEntry(input: {
  cleanerId: string;
  devOnly: boolean;
  entryId: string;
  breakMinutes: number;
}) {
  return withCleanerMutation(input, async (transaction) => {
    const rows = await transaction<{ id: string }[]>`
      update job_time_entries
      set clock_out_at = now(), break_minutes = ${input.breakMinutes},
        status = 'submitted', version = version + 1
      where id = ${input.entryId} and cleaner_id = ${input.cleanerId}
        and status = 'open' and clock_in_at < now()
      returning id`;
    if (!rows[0]) throw new Error("No matching open time entry was found");
  });
}

export async function createCleanerCallout(input: {
  cleanerId: string;
  devOnly: boolean;
  membershipId: string;
  summary: string;
}) {
  return withCleanerMutation(input, async (transaction) => {
    const memberships = await transaction<
      { organization_id: string; team_id: string }[]
    >`
      select organization_id, team_id from workforce_memberships
      where id = ${input.membershipId} and cleaner_id = ${input.cleanerId}
        and role in ('cleaner','shift_lead') and status = 'active'`;
    if (!memberships[0]) throw new Error("Choose one of your active teams");
    await transaction`
      insert into workforce_events
        (organization_id, team_id, subject_membership_id, event_type,
         severity, summary, created_by_membership_id)
      values (${memberships[0].organization_id}, ${memberships[0].team_id},
        ${input.membershipId}, 'callout', 'high', ${input.summary},
        ${input.membershipId})`;
  });
}

async function staffActorLabel(
  transaction: Transaction,
  membershipId: string,
) {
  const rows = await transaction<{ label: string }[]>`
    select coalesce(cleaner.full_name, customer.full_name, customer.email,
      'Authorized team operator') as label
    from workforce_memberships membership
    left join cleaners cleaner on cleaner.id = membership.cleaner_id
    left join customers customer on customer.id = membership.customer_id
    where membership.id = ${membershipId}
    limit 1`;
  return rows[0]?.label ?? "Authorized team operator";
}

export async function getTeamRecoveryDashboard(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
}): Promise<TeamRecoveryDashboard> {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(
      access,
      "manage_service_recovery",
      input.teamId,
    );
    requireCapability(access, "manage_refunds", input.teamId);

    const serviceCases = await transaction<TeamServiceCaseRow[]>`
      select service_case.id, service_case.public_reference,
        service_case.case_type, service_case.booking_id,
        coalesce(nullif(service_case.contact ->> 'name', ''),
          nullif(booking.contact ->> 'name', ''), 'Unnamed customer') as contact_name,
        coalesce(nullif(service_case.contact ->> 'email', ''),
          nullif(booking.contact ->> 'email', '')) as contact_email,
        coalesce(nullif(service_case.contact ->> 'phone', ''),
          nullif(booking.contact ->> 'phone', '')) as contact_phone,
        service_case.status, service_case.priority, service_case.details,
        service_case.created_at::text,
        (booking.status in ('requested','reviewing','ready','confirmed','scheduled')
          and schedule.status in ('tentative','held','confirmed'))
          as booking_mutation_eligible,
        exists (
          select 1 from service_recovery_actions recovery
          where recovery.service_case_id = service_case.id
            and recovery.action_type = 'reclean'
            and recovery.status in ('scheduled','completed')
        ) as has_scheduled_reclean,
        exists (
          select 1 from refund_records refund
          where refund.service_case_id = service_case.id
            and refund.status in ('requested','approved','ready_for_manual_processing','failed')
        ) as has_open_refund,
        coalesce(refundable.balance_cents, 0)::int as refundable_balance_cents,
        (service_case.case_type in ('refund_review','complaint','reclean','damage')
          and service_case.status = 'refund_pending'
          and coalesce(refundable.balance_cents, 0) > 0
          and not exists (
            select 1 from refund_records open_refund
            where open_refund.service_case_id = service_case.id
              and open_refund.status in ('requested','approved','ready_for_manual_processing','failed')
          )) as refund_eligible,
        territory.timezone as territory_timezone
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join bookings booking on booking.id = schedule.booking_id
      join service_cases service_case on service_case.booking_id = booking.id
        and service_case.assigned_team_id = allocation.team_id
      join service_territories territory on territory.id = schedule.territory_id
      left join lateral (
        select sum(greatest(
          billing.amount_cents - coalesce(committed.amount_cents, 0), 0
        )) as balance_cents
        from billing_records billing
        left join lateral (
          select sum(refund.amount_cents) as amount_cents
          from refund_records refund
          where refund.billing_record_id = billing.id
            and refund.status not in ('declined','failed','canceled')
        ) committed on true
        where billing.booking_id = booking.id and billing.status = 'paid'
      ) refundable on true
      where allocation.organization_id = ${organizationId}
        and allocation.team_id = ${input.teamId}
        and (${input.devOnly} = false or (
          allocation.is_dev_seed and schedule.is_dev_seed
          and booking.is_dev_seed and service_case.is_dev_seed
        ))
        and service_case.status not in ('closed','canceled')
      order by case service_case.priority
        when 'urgent' then 1 when 'high' then 2 when 'normal' then 3 else 4 end,
        service_case.created_at
      limit 100`;

    const recoveries = await transaction<TeamRecoveryActionRow[]>`
      select recovery.id, recovery.service_case_id,
        service_case.public_reference, recovery.action_type, recovery.status,
        recovery.owner_label, recovery.scheduled_at::text,
        recovery.completed_at::text, recovery.notes,
        territory.timezone as territory_timezone
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join service_territories territory on territory.id = schedule.territory_id
      join service_cases service_case on service_case.booking_id = schedule.booking_id
        and service_case.assigned_team_id = allocation.team_id
      join service_recovery_actions recovery
        on recovery.service_case_id = service_case.id
      where allocation.organization_id = ${organizationId}
        and allocation.team_id = ${input.teamId}
        and (${input.devOnly} = false or (
          allocation.is_dev_seed and schedule.is_dev_seed
          and service_case.is_dev_seed and recovery.is_dev_seed
        ))
        and recovery.status not in ('completed','canceled')
      order by recovery.scheduled_at, recovery.created_at
      limit 100`;

    const refunds = await transaction<TeamRefundRow[]>`
      select refund.id, refund.service_case_id,
        service_case.public_reference, refund.amount_cents, refund.status,
        refund.reason_code, refund.provider, refund.provider_refund_id,
        refund.created_at::text
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join service_cases service_case on service_case.booking_id = schedule.booking_id
        and service_case.assigned_team_id = allocation.team_id
      join refund_records refund on refund.service_case_id = service_case.id
      where allocation.organization_id = ${organizationId}
        and allocation.team_id = ${input.teamId}
        and (${input.devOnly} = false or (
          allocation.is_dev_seed and schedule.is_dev_seed
          and service_case.is_dev_seed and refund.is_dev_seed
        ))
      order by refund.created_at desc
      limit 100`;

    return { serviceCases, recoveries, refunds };
  });
}

export async function transitionScopedServiceCase(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  caseId: string;
  from: ServiceCaseStatus;
  to: ServiceCaseStatus;
  resolutionSummary: string | null;
}) {
  if (!canTransitionServiceCase(input.from, input.to)) {
    throw new Error("Invalid service-case transition");
  }
  if (["resolved", "closed"].includes(input.to) && !input.resolutionSummary) {
    throw new Error("A customer-visible outcome is required to resolve or close a case");
  }
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(
      access,
      "manage_service_recovery",
      input.teamId,
    );
    const scoped = await transaction<{ id: string }[]>`
      select service_case.id
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join service_cases service_case on service_case.booking_id = schedule.booking_id
        and service_case.assigned_team_id = allocation.team_id
      where allocation.organization_id = ${organizationId}
        and allocation.team_id = ${input.teamId}
        and service_case.id = ${input.caseId}
        and service_case.status = ${input.from}
        and (${input.devOnly} = false or (
          allocation.is_dev_seed and schedule.is_dev_seed and service_case.is_dev_seed
        ))
      for update of service_case`;
    if (!scoped[0]) throw new Error("Service case changed or is outside your team");

    const rows = await transaction<{ id: string }[]>`
      update service_cases
      set status = ${input.to},
        resolution_summary = case
          when ${input.to} in ('resolved','closed') then ${input.resolutionSummary}
          when ${input.to} not in ('declined','canceled') then null
          else resolution_summary end,
        resolution_type = case
          when ${input.to} not in ('resolved','closed','declined','canceled') then null
          else resolution_type end,
        resolved_at = case
          when ${input.to} = 'resolved' then now()
          when ${input.to} not in ('resolved','closed','declined','canceled') then null
          else resolved_at end,
        closed_at = case
          when ${input.to} = 'closed' then now()
          when ${input.to} not in ('resolved','closed','declined','canceled') then null
          else closed_at end
      where id = ${input.caseId} and status = ${input.from}
      returning id`;
    if (!rows[0]) throw new Error("Service case changed; refresh and retry");
  });
}

export async function rescheduleScopedServiceCase(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  caseId: string;
  startLocal: string;
  endLocal: string;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(
      access,
      "manage_service_recovery",
      input.teamId,
    );
    const rows = await transaction<Array<{
      schedule_id: string;
      labor_minutes: number;
      required_crew_size: number;
      territory_timezone: string;
    }>>`
      select schedule.id as schedule_id, schedule.labor_minutes,
        schedule.required_crew_size, territory.timezone as territory_timezone
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join bookings booking on booking.id = schedule.booking_id
      join service_cases service_case on service_case.booking_id = booking.id
        and service_case.assigned_team_id = allocation.team_id
      join service_territories territory on territory.id = schedule.territory_id
      where allocation.organization_id = ${organizationId}
        and allocation.team_id = ${input.teamId}
        and service_case.id = ${input.caseId}
        and service_case.case_type = 'reschedule'
        and service_case.status = 'action_planned'
        and booking.status in ('requested','reviewing','ready','confirmed','scheduled')
        and schedule.status in ('tentative','held','confirmed')
        and (${input.devOnly} = false or (
          allocation.is_dev_seed and schedule.is_dev_seed
          and booking.is_dev_seed and service_case.is_dev_seed
        ))
      for update of service_case, booking, schedule`;
    if (!rows[0]) {
      throw new Error("Reschedule case changed or is outside your team");
    }
    const startAt = localDateTimeToUtc(input.startLocal, rows[0].territory_timezone);
    const endAt = localDateTimeToUtc(input.endLocal, rows[0].territory_timezone);
    validateUtcInterval(startAt, endAt, { maxMinutes: 24 * 60 });
    const elapsedMinutes = Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60_000);
    const minimumMinutes = requiredElapsedMinutes(
      rows[0].labor_minutes,
      rows[0].required_crew_size,
    );
    if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < minimumMinutes) {
      throw new Error(
        `Reschedule needs at least ${minimumMinutes} elapsed minutes for the existing labor plan`,
      );
    }
    await transaction`
      update job_schedules
      set start_at = ${startAt}, end_at = ${endAt}, version = version + 1
      where id = ${rows[0].schedule_id}`;
    await transaction`
      update service_cases
      set status = 'resolved', resolution_type = 'rescheduled',
        resolution_summary = 'Schedule updated by an authorized team operator after capacity validation.',
        resolved_at = now()
      where id = ${input.caseId} and status = 'action_planned'`;
  });
}

export async function cancelScopedServiceCaseBooking(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  caseId: string;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(
      access,
      "manage_service_recovery",
      input.teamId,
    );
    const rows = await transaction<Array<{
      booking_id: string;
      schedule_id: string;
      schedule_status: string;
    }>>`
      select booking.id as booking_id, schedule.id as schedule_id,
        schedule.status as schedule_status
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join bookings booking on booking.id = schedule.booking_id
      join service_cases service_case on service_case.booking_id = booking.id
        and service_case.assigned_team_id = allocation.team_id
      where allocation.organization_id = ${organizationId}
        and allocation.team_id = ${input.teamId}
        and service_case.id = ${input.caseId}
        and service_case.case_type = 'cancel'
        and service_case.status = 'action_planned'
        and booking.status in ('requested','reviewing','ready','confirmed','scheduled')
        and (${input.devOnly} = false or (
          allocation.is_dev_seed and schedule.is_dev_seed
          and booking.is_dev_seed and service_case.is_dev_seed
        ))
      for update of service_case, booking, schedule`;
    if (!rows[0]) {
      throw new Error("Cancellation case changed or is outside your team");
    }
    if (!["tentative", "held", "confirmed"].includes(rows[0].schedule_status)) {
      throw new Error("Service already started; use recovery controls instead");
    }
    await transaction`
      update job_schedules
      set status = 'canceled', version = version + 1
      where id = ${rows[0].schedule_id} and status = ${rows[0].schedule_status}`;
    const canceled = await transaction<{ id: string }[]>`
      select id from bookings
      where id = ${rows[0].booking_id} and status = 'canceled'`;
    if (!canceled[0]) throw new Error("Booking cancellation did not complete");
    await transaction`
      insert into booking_events (booking_id, type, data)
      values (${rows[0].booking_id}, 'canceled_from_service_case',
        ${transaction.json({ serviceCaseId: input.caseId } as postgres.JSONValue)})`;
    await transaction`
      update service_cases
      set status = 'resolved', resolution_type = 'canceled',
        resolution_summary = 'Booking and active schedule canceled by an authorized team operator.',
        resolved_at = now()
      where id = ${input.caseId} and status = 'action_planned'`;
  });
}

export async function createScopedRecoveryAction(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  caseId: string;
  actionType: string;
  scheduledLocal: string;
  notes: string | null;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(
      access,
      "manage_service_recovery",
      input.teamId,
    );
    const cases = await transaction<Array<{
      booking_id: string;
      timezone: string;
    }>>`
      select service_case.booking_id, territory.timezone
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join service_territories territory on territory.id = schedule.territory_id
      join service_cases service_case on service_case.booking_id = schedule.booking_id
        and service_case.assigned_team_id = allocation.team_id
      where allocation.organization_id = ${organizationId}
        and allocation.team_id = ${input.teamId}
        and service_case.id = ${input.caseId}
        and service_case.status not in ('resolved','closed','declined','canceled')
        and (${input.devOnly} = false or (
          allocation.is_dev_seed and schedule.is_dev_seed and service_case.is_dev_seed
        ))
      for update of service_case`;
    if (!cases[0]) throw new Error("Choose an open case in your team");
    const scheduledAt = localDateTimeToUtc(input.scheduledLocal, cases[0].timezone);
    if (Date.parse(scheduledAt) < Date.now() - 5 * 60_000) {
      throw new Error("Recovery target time must be in the future");
    }
    const actorId = actorMembershipId(access, input.teamId);
    const actor = await staffActorLabel(transaction, actorId);
    const rows = await transaction<{ id: string }[]>`
      insert into service_recovery_actions
        (service_case_id, booking_id, action_type, owner_label, scheduled_at,
         notes, status, is_dev_seed)
      values (${input.caseId}, ${cases[0].booking_id}, ${input.actionType},
        ${actor}, ${scheduledAt}, ${input.notes}, 'planned',
        ${input.devOnly})
      returning id`;
    return rows[0];
  });
}

export async function transitionScopedRecoveryAction(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  recoveryId: string;
  from: RecoveryStatus;
  to: RecoveryStatus;
}) {
  if (!canTransitionRecovery(input.from, input.to)) {
    throw new Error("Invalid recovery transition");
  }
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(
      access,
      "manage_service_recovery",
      input.teamId,
    );
    const scoped = await transaction<{ id: string }[]>`
      select recovery.id
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join service_cases service_case on service_case.booking_id = schedule.booking_id
        and service_case.assigned_team_id = allocation.team_id
      join service_recovery_actions recovery
        on recovery.service_case_id = service_case.id
      where allocation.organization_id = ${organizationId}
        and allocation.team_id = ${input.teamId}
        and recovery.id = ${input.recoveryId} and recovery.status = ${input.from}
        and (${input.devOnly} = false or (
          allocation.is_dev_seed and schedule.is_dev_seed
          and service_case.is_dev_seed and recovery.is_dev_seed
        ))
      for update of recovery`;
    if (!scoped[0]) throw new Error("Recovery changed or is outside your team");
    const actorId = actorMembershipId(access, input.teamId);
    const actor = await staffActorLabel(transaction, actorId);
    const rows = await transaction<{ id: string }[]>`
      update service_recovery_actions
      set status = ${input.to},
        approved_by_label = case
          when ${input.to} in ('approved','scheduled','completed')
            then coalesce(approved_by_label, ${actor})
          else approved_by_label end,
        completed_at = case when ${input.to} = 'completed' then now() else null end
      where id = ${input.recoveryId} and status = ${input.from}
      returning id`;
    if (!rows[0]) throw new Error("Recovery changed; refresh and retry");
  });
}

export async function createScopedRefundReview(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  caseId: string;
  amountCents: number;
  reasonCode: string;
}) {
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "manage_refunds", input.teamId);
    const rows = await transaction<Array<{
      booking_id: string;
      billing_record_id: string;
    }>>`
      select service_case.booking_id, billing.id as billing_record_id
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join service_cases service_case on service_case.booking_id = schedule.booking_id
        and service_case.assigned_team_id = allocation.team_id
      join billing_records billing on billing.booking_id = service_case.booking_id
        and billing.status = 'paid'
      where allocation.organization_id = ${organizationId}
        and allocation.team_id = ${input.teamId}
        and service_case.id = ${input.caseId}
        and service_case.case_type in ('refund_review','complaint','reclean','damage')
        and service_case.status = 'refund_pending'
        and not exists (
          select 1 from refund_records unfinished
          where unfinished.service_case_id = service_case.id
            and unfinished.status in ('requested','approved','ready_for_manual_processing','failed')
        )
        and billing.amount_cents - coalesce((
          select sum(existing.amount_cents) from refund_records existing
          where existing.billing_record_id = billing.id
            and existing.status not in ('declined','failed','canceled')
        ), 0) >= ${input.amountCents}
        and (${input.devOnly} = false or (
          allocation.is_dev_seed and schedule.is_dev_seed
          and service_case.is_dev_seed and billing.is_dev_seed
        ))
      order by billing.occurred_at desc
      limit 1
      for update of service_case, billing`;
    if (!rows[0]) {
      throw new Error(
        "Refund review requires an eligible team case and enough remaining paid balance",
      );
    }
    const actorId = actorMembershipId(access, input.teamId);
    const actor = await staffActorLabel(transaction, actorId);
    await transaction`
      insert into refund_records
        (service_case_id, booking_id, billing_record_id, amount_cents,
         reason_code, status, provider, requested_by_label, is_dev_seed)
      values (${input.caseId}, ${rows[0].booking_id}, ${rows[0].billing_record_id},
        ${input.amountCents}, ${input.reasonCode}, 'requested', 'manual',
        ${actor}, ${input.devOnly})`;
  });
}

export async function transitionScopedRefund(input: {
  customerId: string;
  devOnly: boolean;
  teamId: string;
  refundId: string;
  from: RefundStatus;
  to: RefundStatus;
  externalReference: string | null;
}) {
  if (!canTransitionRefund(input.from, input.to)) {
    throw new Error("Invalid refund transition");
  }
  if (
    input.to === "processed" &&
    (!input.externalReference || input.externalReference.length < 4)
  ) {
    throw new Error("Processed refunds require an external provider receipt");
  }
  return withStaffMutation(input, async (transaction, access) => {
    const organizationId = requireCapability(access, "manage_refunds", input.teamId);
    const scoped = await transaction<{ id: string }[]>`
      select refund.id
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join service_cases service_case on service_case.booking_id = schedule.booking_id
        and service_case.assigned_team_id = allocation.team_id
      join refund_records refund on refund.service_case_id = service_case.id
      where allocation.organization_id = ${organizationId}
        and allocation.team_id = ${input.teamId}
        and refund.id = ${input.refundId} and refund.status = ${input.from}
        and (${input.devOnly} = false or (
          allocation.is_dev_seed and schedule.is_dev_seed
          and service_case.is_dev_seed and refund.is_dev_seed
        ))
      for update of refund`;
    if (!scoped[0]) throw new Error("Refund changed or is outside your team");
    const actorId = actorMembershipId(access, input.teamId);
    const actor = await staffActorLabel(transaction, actorId);
    const rows = await transaction<{ id: string }[]>`
      update refund_records
      set status = ${input.to},
        approved_by_label = case
          when ${input.to} = 'approved' then ${actor}
          else approved_by_label end,
        approved_at = case
          when ${input.to} = 'approved' then now()
          else approved_at end,
        processed_at = case
          when ${input.to} = 'processed' then now()
          else processed_at end,
        provider_refund_id = case
          when ${input.to} = 'processed' then ${input.externalReference}
          else provider_refund_id end
      where id = ${input.refundId} and status = ${input.from}
      returning id`;
    if (!rows[0]) throw new Error("Refund changed; refresh and retry");
  });
}
