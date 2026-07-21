import "server-only";

import { randomUUID } from "node:crypto";
import postgres from "postgres";

import { deriveBookingReference, hashBookingReference } from "./booking-reference";
import type {
  PublicAvailabilityResponse,
  PublicSchedulingSlot,
  ReservationRequestInput,
  SchedulingScopeInput,
} from "./customer-scheduling-contract";
import {
  classifySchedulingRequest,
  projectCapacityBackedAvailability,
  type SchedulingPolicy,
} from "./customer-scheduling";
import {
  deriveGuestManagementToken,
  derivePublicSlotId,
  guestManagementTokenDigest,
  reservationRequestDigest,
  sha256,
} from "./customer-scheduling-security";
import { sql } from "./db";
import {
  buildBoundedCrewGroups,
  type CleanerCapacity,
  type SchedulingJob,
} from "./operations-scheduling";

type TerritoryRow = {
  id: string;
  timezone: string;
};

type PolicyRow = {
  id: string;
  version: number;
  status: SchedulingPolicy["status"];
  territory_id: string;
  territory_timezone: string;
  service_id: SchedulingPolicy["serviceId"];
  scheduling_path: SchedulingPolicy["schedulingPath"];
  condition_key: string | null;
  condition_label: string | null;
  allowed_contexts: string[];
  allowed_size_bands: SchedulingPolicy["allowedSizeBands"];
  allowed_conditions: SchedulingPolicy["allowedConditions"];
  allowed_cadences: SchedulingPolicy["allowedCadences"];
  labor_minutes: number;
  required_crew_size: number;
  required_skills: string[];
  travel_buffer_minutes: number;
  minimum_lead_hours: number;
  horizon_days: number;
  slot_increment_minutes: number;
  operating_start: string;
  operating_end: string;
  selection_hold_minutes: number;
  conditional_hold_minutes: number;
};

type SlotRow = { start_at: string; end_at: string };
type CleanerRow = {
  id: string;
  skills: string[];
  vertical_experience: CleanerCapacity["verticalExperience"];
  max_daily_jobs: number;
  max_daily_minutes: number;
  max_weekly_minutes: number;
};
type AvailabilityRuleRow = {
  cleaner_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  effective_from: string;
  effective_to: string | null;
};
type SpanRow = { cleaner_id: string; start_at: string; end_at: string };

type ReservableSlot = {
  publicSlot: PublicSchedulingSlot;
  policy: SchedulingPolicy;
  cleanerIds: string[];
  score: number;
  reasons: string[];
};

type InternalAvailability = PublicAvailabilityResponse & {
  reservableSlots: Map<string, ReservableSlot>;
};

export class SchedulingReservationError extends Error {
  constructor(
    public readonly code:
      | "stale_slot"
      | "idempotency_mismatch"
      | "reservation_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SchedulingReservationError";
  }
}

function mapPolicy(row: PolicyRow): SchedulingPolicy {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    territoryId: row.territory_id,
    territoryTimeZone: row.territory_timezone,
    serviceId: row.service_id,
    schedulingPath: row.scheduling_path,
    conditionKey: row.condition_key,
    conditionLabel: row.condition_label,
    allowedContexts: row.allowed_contexts,
    allowedSizeBands: row.allowed_size_bands,
    allowedConditions: row.allowed_conditions,
    allowedCadences: row.allowed_cadences,
    laborMinutes: row.labor_minutes,
    requiredCrewSize: row.required_crew_size,
    requiredSkills: row.required_skills,
    travelBufferMinutes: row.travel_buffer_minutes,
    minimumLeadHours: row.minimum_lead_hours,
    horizonDays: row.horizon_days,
    operatingStart: row.operating_start,
    operatingEnd: row.operating_end,
    selectionHoldMinutes: row.selection_hold_minutes,
    conditionalHoldMinutes: row.conditional_hold_minutes,
  };
}

function localParts(instant: string, timeZone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const date = `${values.year}-${values.month}-${values.day}`;
  return {
    date,
    dayOfWeek: new Date(`${date}T12:00:00Z`).getUTCDay(),
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

function timeMinutes(value: string) {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
}

function arrivalWindow(start: string, end: string, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  return `${formatter.format(new Date(start))}–${formatter.format(new Date(end))}`;
}

function weekKey(date: string) {
  const day = new Date(`${date}T12:00:00Z`);
  const offset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - offset);
  return day.toISOString().slice(0, 10);
}

function durationMinutes(span: { start_at: string; end_at: string }) {
  return Math.max(
    0,
    Math.ceil((Date.parse(span.end_at) - Date.parse(span.start_at)) / 60_000),
  );
}

async function findTerritoryAndPolicy(scope: SchedulingScopeInput) {
  const territories = await sql<TerritoryRow[]>`
    select distinct territory.id, territory.timezone
    from service_territories territory
    join territory_postal_codes postal on postal.territory_id = territory.id
    where territory.status = 'active' and postal.status = 'active'
      and normalize_us_postal_code(postal.postal_code) =
          normalize_us_postal_code(${scope.postalCode})
    order by territory.id
    limit 2`;
  if (territories.length !== 1) {
    return { territoryEligible: territories.length > 0, policy: null };
  }
  const territory = territories[0];
  const policies = await sql<PolicyRow[]>`
    select policy.id, policy.version, policy.status,
      policy.territory_id, territory.timezone as territory_timezone,
      policy.service_id, policy.scheduling_path, policy.condition_key,
      policy.condition_label, policy.allowed_contexts,
      policy.allowed_size_bands, policy.allowed_conditions,
      policy.allowed_cadences, policy.labor_minutes,
      policy.required_crew_size, policy.required_skills,
      policy.travel_buffer_minutes, policy.minimum_lead_hours,
      policy.horizon_days, policy.slot_increment_minutes,
      policy.operating_start::text, policy.operating_end::text,
      policy.selection_hold_minutes, policy.conditional_hold_minutes
    from service_scheduling_policies policy
    join service_territories territory on territory.id = policy.territory_id
    where policy.territory_id = ${territory.id}
      and policy.service_id = ${scope.program}
      and policy.status = 'active'
    order by policy.version desc
    limit 2`;
  return {
    territoryEligible: true,
    policy: policies.length === 1 ? mapPolicy(policies[0]) : null,
    slotIncrementMinutes:
      policies.length === 1 ? policies[0].slot_increment_minutes : null,
  };
}

async function loadRawSlots(
  policy: SchedulingPolicy,
  slotIncrementMinutes: number,
) {
  const elapsedMinutes = Math.ceil(
    policy.laborMinutes / policy.requiredCrewSize / 30,
  ) * 30;
  const operatingStartMinutes = timeMinutes(policy.operatingStart);
  const operatingEndMinutes = timeMinutes(policy.operatingEnd);
  const finalSlotIndex = Math.floor(
    (operatingEndMinutes - operatingStartMinutes - elapsedMinutes) /
      slotIncrementMinutes,
  );
  if (finalSlotIndex < 0) return [];
  return sql<SlotRow[]>`
    with slot_days as (
      select day_value::date as local_date
      from generate_series(
        (now() at time zone ${policy.territoryTimeZone})::date,
        (now() at time zone ${policy.territoryTimeZone})::date
          + ${policy.horizonDays}::integer,
        interval '1 day'
      ) day_value
    ), local_slots as (
      select
        (local_date::timestamp
          + make_interval(mins => ${operatingStartMinutes}
            + slot_index * ${slotIncrementMinutes}))
          at time zone ${policy.territoryTimeZone} as start_at,
        (local_date::timestamp
          + make_interval(mins => ${operatingStartMinutes}
            + slot_index * ${slotIncrementMinutes} + ${elapsedMinutes}))
          at time zone ${policy.territoryTimeZone} as end_at
      from slot_days
      cross join lateral generate_series(0, ${finalSlotIndex}) slot_index
    )
    select start_at::text, end_at::text
    from local_slots
    where start_at >= now() + make_interval(hours => ${policy.minimumLeadHours})
      and start_at <= now() + make_interval(days => ${policy.horizonDays})
    order by start_at
    limit 360`;
}

async function loadCapacityFacts(policy: SchedulingPolicy) {
  const [cleaners, availability, timeOff, assignments] = await Promise.all([
    sql<CleanerRow[]>`
      select id, skills, vertical_experience, max_daily_jobs,
        max_daily_minutes, max_weekly_minutes
      from cleaners
      where status = 'active' and screening_status = 'verified'
        and home_territory_id = ${policy.territoryId}
      order by id`,
    sql<AvailabilityRuleRow[]>`
      select availability.cleaner_id, availability.day_of_week,
        availability.start_time::text, availability.end_time::text,
        availability.effective_from::text, availability.effective_to::text
      from cleaner_availability_rules availability
      join cleaners cleaner on cleaner.id = availability.cleaner_id
      where cleaner.status = 'active' and cleaner.screening_status = 'verified'
        and cleaner.home_territory_id = ${policy.territoryId}
        and availability.status = 'active'
        and (availability.territory_id is null
          or availability.territory_id = ${policy.territoryId})`,
    sql<SpanRow[]>`
      select time_off.cleaner_id, time_off.start_at::text, time_off.end_at::text
      from cleaner_time_off time_off
      join cleaners cleaner on cleaner.id = time_off.cleaner_id
      where cleaner.home_territory_id = ${policy.territoryId}
        and time_off.status = 'approved'
        and time_off.end_at > now()
        and time_off.start_at < now() + make_interval(days => ${policy.horizonDays + 1})`,
    sql<SpanRow[]>`
      select distinct assignment.cleaner_id,
        schedule.start_at::text, schedule.end_at::text
      from job_assignments assignment
      join job_schedules schedule on schedule.id = assignment.job_schedule_id
      left join capacity_holds hold on hold.job_schedule_id = schedule.id
      where schedule.territory_id = ${policy.territoryId}
        and schedule.status <> 'canceled'
        and schedule.end_at > now() - interval '7 days'
        and schedule.start_at < now() + make_interval(days => ${policy.horizonDays + 8})
        and (
          assignment.status in ('accepted', 'confirmed')
          or (assignment.status = 'reserved' and hold.status = 'active'
            and hold.expires_at > now())
        )`,
  ]);
  return { cleaners, availability, timeOff, assignments };
}

export async function getCustomerSchedulingAvailability(
  scope: SchedulingScopeInput,
): Promise<InternalAvailability> {
  const authority = await findTerritoryAndPolicy(scope);
  const initial = classifySchedulingRequest({
    scope,
    territoryEligible: authority.territoryEligible,
    policy: authority.policy,
  });
  if (
    !authority.policy ||
    !authority.slotIncrementMinutes ||
    !["direct", "conditional_hold"].includes(initial.path)
  ) {
    return {
      classification: {
        path: initial.path,
        publicReason: initial.publicReason,
        conditionLabel: initial.conditionLabel,
      },
      slots: [],
      reservableSlots: new Map(),
    };
  }

  const policy = authority.policy;
  const [rawSlots, facts] = await Promise.all([
    loadRawSlots(policy, authority.slotIncrementMinutes),
    loadCapacityFacts(policy),
  ]);
  const candidateMembers = new Map<string, string[]>();
  const candidateSlots = rawSlots.map((slot) => {
    const start = new Date(slot.start_at).toISOString();
    const end = new Date(slot.end_at).toISOString();
    const startLocal = localParts(start, policy.territoryTimeZone);
    const endLocal = localParts(end, policy.territoryTimeZone);
    const startWeek = weekKey(startLocal.date);
    const cleanerCapacity = facts.cleaners.map((cleaner): CleanerCapacity => {
      const rules = facts.availability.filter(
        (rule) =>
          rule.cleaner_id === cleaner.id &&
          rule.day_of_week === startLocal.dayOfWeek &&
          rule.effective_from <= startLocal.date &&
          (!rule.effective_to || rule.effective_to >= startLocal.date) &&
          timeMinutes(rule.start_time) <= startLocal.minutes &&
          timeMinutes(rule.end_time) >= endLocal.minutes,
      );
      const assignments = facts.assignments.filter(
        (assignment) => assignment.cleaner_id === cleaner.id,
      );
      const assignedToday = assignments.filter(
        (assignment) =>
          localParts(assignment.start_at, policy.territoryTimeZone).date ===
          startLocal.date,
      );
      const assignedThisWeek = assignments.filter(
        (assignment) =>
          weekKey(localParts(assignment.start_at, policy.territoryTimeZone).date) ===
          startWeek,
      );
      return {
        id: cleaner.id,
        active: true,
        skills: cleaner.skills,
        verticalExperience: cleaner.vertical_experience,
        availability: rules.length ? [{ start, end }] : [],
        timeOff: facts.timeOff
          .filter((item) => item.cleaner_id === cleaner.id)
          .map((item) => ({ start: item.start_at, end: item.end_at })),
        assignments: assignments.map((item) => ({
          start: item.start_at,
          end: item.end_at,
        })),
        assignedJobsToday: assignedToday.length,
        assignedMinutesToday: assignedToday.reduce(
          (total, item) => total + durationMinutes(item),
          0,
        ),
        assignedMinutesThisWeek: assignedThisWeek.reduce(
          (total, item) => total + durationMinutes(item),
          0,
        ),
        maxDailyJobs: cleaner.max_daily_jobs,
        maxDailyMinutes: cleaner.max_daily_minutes,
        maxWeeklyMinutes: cleaner.max_weekly_minutes,
      };
    });
    const job: SchedulingJob = {
      id: `public-availability:${start}`,
      vertical: scope.program,
      territoryId: policy.territoryId,
      start,
      end,
      requiredCrewSize: policy.requiredCrewSize,
      requiredSkills: policy.requiredSkills,
      qualificationApproved: true,
      safeAccessReady: !scope.accessComplex,
      utilitiesReady: scope.siteReady,
      constructionReady: scope.program === "construction" ? scope.siteReady : undefined,
      dockAccessReady: scope.program === "marine" ? !scope.accessComplex : undefined,
      finishRestrictionsAcknowledged: scope.finishRestrictionsAcknowledged,
    };
    const groups = buildBoundedCrewGroups({
      job,
      acceptedCleaners: [],
      availableCleaners: cleanerCapacity,
      travelBufferMinutes: policy.travelBufferMinutes,
      limit: 64,
    });
    const candidates = groups.map((members) => {
      const id = `crew:${sha256(members.map((member) => member.id).join("\n"))}`;
      candidateMembers.set(id, members.map((member) => member.id));
      return {
        id,
        territoryIds: [policy.territoryId],
        cleaners: members,
        estimatedTravelMinutes: 0,
        travelBufferMinutes: policy.travelBufferMinutes,
      };
    });
    return {
      id: derivePublicSlotId({
        policyId: policy.id,
        policyVersion: policy.version,
        start,
        end,
        scope,
      }),
      start,
      end,
      arrivalWindow: arrivalWindow(start, end, policy.territoryTimeZone),
      candidates,
    };
  });

  const projection = projectCapacityBackedAvailability({
    scope,
    territoryEligible: true,
    policy,
    slots: candidateSlots,
  });
  const reservableSlots = new Map<string, ReservableSlot>();
  for (const publicSlot of projection.publicSlots) {
    const evidence = projection.internalEvidence.find(
      (item) => item.slotId === publicSlot.id,
    );
    const cleanerIds = evidence ? candidateMembers.get(evidence.candidateId) : null;
    if (evidence && cleanerIds) {
      reservableSlots.set(publicSlot.id, {
        publicSlot,
        policy,
        cleanerIds,
        score: evidence.score,
        reasons: evidence.reasons,
      });
    }
  }
  return {
    classification: {
      path: projection.classification.path,
      publicReason: projection.classification.publicReason,
      conditionLabel: projection.classification.conditionLabel,
    },
    slots: projection.publicSlots,
    reservableSlots,
  };
}

export async function createCustomerSchedulingReservation(
  input: ReservationRequestInput,
) {
  const idempotencyKeyHash = sha256(input.idempotencyKey);
  const requestHash = reservationRequestDigest(input);
  const existing = await sql<
    Array<{
      booking_id: string;
      reservation_request_hash: string;
      scheduled_date: string;
      scheduled_window: string;
      start_at: string;
      end_at: string;
      time_zone: string;
      hold_kind: "direct" | "conditional";
      hold_minutes: number;
      condition_label: string | null;
    }>
  >`
    select booking.id as booking_id, guest_grant.reservation_request_hash,
      booking.scheduled_date::text, booking.scheduled_window,
      schedule.start_at::text, schedule.end_at::text,
      territory.timezone as time_zone, hold.hold_kind,
      greatest(1, ceil(extract(epoch from
        (hold.expires_at - hold.created_at)) / 60))::integer as hold_minutes,
      hold.condition_label
    from bookings booking
    join guest_booking_management_grants guest_grant
      on guest_grant.booking_id = booking.id and guest_grant.status = 'active'
    join job_schedules schedule on schedule.booking_id = booking.id
    join capacity_holds hold on hold.booking_id = booking.id
    join service_territories territory on territory.id = hold.territory_id
    where booking.idempotency_key = ${idempotencyKeyHash}
    limit 1`;
  if (existing[0]) {
    if (existing[0].reservation_request_hash !== requestHash) {
      throw new SchedulingReservationError(
        "idempotency_mismatch",
        "This submission key was already used for different reservation details.",
      );
    }
    const replayPath =
      existing[0].hold_kind === "direct" ? "direct" : "conditional_hold";
    return {
      bookingId: existing[0].booking_id,
      reference: deriveBookingReference(existing[0].booking_id),
      managementToken: deriveGuestManagementToken(
        existing[0].booking_id,
        idempotencyKeyHash,
      ),
      duplicate: true,
      status:
        replayPath === "direct" ? ("held" as const) : ("pending_scope" as const),
      slot: {
        id: input.slotId,
        date: existing[0].scheduled_date,
        start: new Date(existing[0].start_at).toISOString(),
        end: new Date(existing[0].end_at).toISOString(),
        arrivalWindow: existing[0].scheduled_window,
        timeZone: existing[0].time_zone,
        state: "available_to_hold" as const,
        schedulingPath: replayPath,
        holdMinutes: existing[0].hold_minutes,
        conditionLabel: existing[0].condition_label,
      },
    };
  }

  const availability = await getCustomerSchedulingAvailability(input.scope);
  const selected = availability.reservableSlots.get(input.slotId);
  if (!selected) {
    throw new SchedulingReservationError(
      "stale_slot",
      "That service window is no longer available. Refresh availability and choose another time.",
    );
  }

  const bookingId = randomUUID();
  const managementToken = deriveGuestManagementToken(
    bookingId,
    idempotencyKeyHash,
  );
  const publicReference = deriveBookingReference(bookingId);
  const holdKind =
    selected.publicSlot.schedulingPath === "direct" ? "direct" : "conditional";
  const qualificationStatus = holdKind === "direct" ? "approved" : "needs_information";
  const elapsedMinutes = Math.ceil(
    (Date.parse(selected.publicSlot.end) - Date.parse(selected.publicSlot.start)) /
      60_000,
  );
  const holdExpiresAt = new Date(
    Date.now() + selected.publicSlot.holdMinutes * 60_000,
  );
  const grantExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);

  try {
    return await sql.begin(async (transaction) => {
      const txJson = (value: unknown) =>
        transaction.json(value as postgres.JSONValue);
      const inserted = await transaction<{ id: string }[]>`
        insert into bookings (
          id, service_id, frequency, scheduled_date, scheduled_window,
          contact, home_details, property_profile, room_plan,
          cleaning_preferences, planning_direction, qualification_status,
          estimated_duration_minutes, required_crew_size, required_skills,
          qualification_requirements, service_vertical, territory_id,
          request_source, idempotency_key, public_reference_token_hash,
          consent_snapshot, consented_at, consent_version,
          consent_notice_date, is_dev_seed
        ) values (
          ${bookingId}, ${input.scope.program},
          ${["weekly", "biweekly", "monthly"].includes(input.scope.cadence) ? input.scope.cadence : "onetime"},
          ${selected.publicSlot.date}, ${selected.publicSlot.arrivalWindow},
          ${txJson({ ...input.contact, zip: input.scope.postalCode })},
          ${txJson({ postalCode: input.scope.postalCode })},
          ${txJson(input.scope)}, ${txJson([])}, ${[] as string[]},
          ${`${selected.publicSlot.schedulingPath} scheduling policy v${selected.policy.version}`},
          ${qualificationStatus}, ${elapsedMinutes},
          ${selected.policy.requiredCrewSize}, ${selected.policy.requiredSkills},
          ${txJson({
            schedulingPath: selected.publicSlot.schedulingPath,
            conditionKey: selected.policy.conditionKey,
            conditionLabel: selected.policy.conditionLabel,
          })},
          ${input.scope.program}, ${selected.policy.territoryId}, 'web_booking',
          ${idempotencyKeyHash}, ${hashBookingReference(publicReference)},
          ${txJson({
            privacy: true,
            schedulingTerms: true,
            siteReadiness: true,
            policyVersion: "2026-07-21-scheduling",
            privacyNoticeDate: "2026-07-13",
          })}, now(), '2026-07-21-scheduling', '2026-07-13', false
        )
        on conflict (idempotency_key) do nothing
        returning id`;

      if (!inserted[0]) {
        const existing = await transaction<
          { booking_id: string; reservation_request_hash: string }[]
        >`
          select booking.id as booking_id, guest_grant.reservation_request_hash
          from bookings booking
          join guest_booking_management_grants guest_grant
            on guest_grant.booking_id = booking.id and guest_grant.status = 'active'
          where booking.idempotency_key = ${idempotencyKeyHash}
          limit 1`;
        if (!existing[0]) {
          throw new SchedulingReservationError(
            "reservation_unavailable",
            "The earlier reservation could not be recovered safely.",
          );
        }
        if (existing[0].reservation_request_hash !== requestHash) {
          throw new SchedulingReservationError(
            "idempotency_mismatch",
            "This submission key was already used for different reservation details.",
          );
        }
        const replayToken = deriveGuestManagementToken(
          existing[0].booking_id,
          idempotencyKeyHash,
        );
        const replayReference = deriveBookingReference(existing[0].booking_id);
        return {
          bookingId: existing[0].booking_id,
          reference: replayReference,
          managementToken: replayToken,
          duplicate: true,
          status:
            selected.publicSlot.schedulingPath === "direct"
              ? ("held" as const)
              : ("pending_scope" as const),
          slot: selected.publicSlot,
        };
      }

      const [schedule] = await transaction<{ id: string }[]>`
        insert into job_schedules (
          booking_id, territory_id, service_vertical, start_at, end_at,
          status, required_crew_size, required_skills, labor_minutes,
          travel_buffer_minutes, created_by_label, is_dev_seed
        ) values (
          ${bookingId}, ${selected.policy.territoryId}, ${input.scope.program},
          ${selected.publicSlot.start}, ${selected.publicSlot.end}, 'held',
          ${selected.policy.requiredCrewSize}, ${selected.policy.requiredSkills},
          ${selected.policy.laborMinutes}, ${selected.policy.travelBufferMinutes},
          'Customer scheduling', false
        ) returning id`;
      const [hold] = await transaction<{ id: string }[]>`
        insert into capacity_holds (
          booking_id, job_schedule_id, policy_id, territory_id, service_id,
          hold_kind, status, start_at, end_at, expires_at, condition_key,
          condition_label, idempotency_key_hash, qualification_snapshot,
          is_dev_seed
        ) values (
          ${bookingId}, ${schedule.id}, ${selected.policy.id},
          ${selected.policy.territoryId}, ${input.scope.program}, ${holdKind},
          'active', ${selected.publicSlot.start}, ${selected.publicSlot.end},
          ${holdExpiresAt.toISOString()}, ${selected.policy.conditionKey},
          ${selected.policy.conditionLabel}, ${idempotencyKeyHash},
          ${txJson({
            requestHash,
            policyVersion: selected.policy.version,
            schedulingPath: selected.publicSlot.schedulingPath,
            score: selected.score,
            reasons: selected.reasons,
          })}, false
        ) returning id`;

      for (const [index, cleanerId] of selected.cleanerIds.entries()) {
        await transaction`
          insert into job_assignments (
            job_schedule_id, cleaner_id, assignment_role, status,
            suggestion_score, suggestion_reasons, assigned_by_label,
            is_dev_seed
          ) values (
            ${schedule.id}, ${cleanerId}, ${index === 0 ? "lead" : "member"},
            'reserved', ${selected.score}, ${txJson(selected.reasons)},
            'Customer scheduling', false
          )`;
      }
      await transaction`
        insert into schedule_events (
          booking_id, job_schedule_id, capacity_hold_id, event_type,
          actor_kind, new_start_at, new_end_at, reason_code, event_data
        ) values (
          ${bookingId}, ${schedule.id}, ${hold.id}, 'hold_created', 'guest',
          ${selected.publicSlot.start}, ${selected.publicSlot.end},
          ${holdKind === "direct" ? "capacity_reserved" : "condition_pending"},
          ${txJson({
            schedulingPath: selected.publicSlot.schedulingPath,
            policyVersion: selected.policy.version,
          })}
        )`;
      await transaction`
        insert into booking_events (booking_id, type, data)
        values (
          ${bookingId}, 'capacity_hold_created',
          ${txJson({
            scheduleId: schedule.id,
            capacityHoldId: hold.id,
            schedulingPath: selected.publicSlot.schedulingPath,
          })}
        )`;
      await transaction`
        insert into guest_booking_management_grants (
          booking_id, token_digest, reservation_request_hash,
          expires_at, is_dev_seed
        ) values (
          ${bookingId}, ${guestManagementTokenDigest(managementToken)},
          ${requestHash}, ${grantExpiresAt.toISOString()}, false
        )`;
      await transaction`
        insert into notification_outbox (
          booking_id, notification_type, channel, recipient_kind,
          recipient_address, template_key, template_data,
          deduplication_key, is_dev_seed
        ) values
          (
            ${bookingId}, 'customer_confirmation', 'email', 'customer',
            ${input.contact.email.toLowerCase()},
            ${holdKind === "direct" ? "booking-time-held" : "booking-condition-hold"},
            ${txJson({ bookingId, capacityHoldId: hold.id })},
            ${`booking:${bookingId}:scheduling-customer`}, false
          ),
          (
            ${bookingId}, 'ops_notification', 'email', 'ops', null,
            ${holdKind === "direct" ? "ops-direct-time-held" : "ops-condition-hold"},
            ${txJson({ bookingId, capacityHoldId: hold.id })},
            ${`booking:${bookingId}:scheduling-ops`}, false
          )`;

      return {
        bookingId,
        reference: publicReference,
        managementToken,
        duplicate: false,
        status:
          selected.publicSlot.schedulingPath === "direct"
            ? ("held" as const)
            : ("pending_scope" as const),
        slot: selected.publicSlot,
      };
    });
  } catch (error) {
    if (error instanceof SchedulingReservationError) throw error;
    const code =
      typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "";
    if (["23P01", "23514", "23505"].includes(code)) {
      if (process.env.NODE_ENV === "development" && error instanceof Error) {
        console.error("[customer-scheduling:capacity-conflict]", code, error.message);
      }
      throw new SchedulingReservationError(
        "stale_slot",
        "That service window was just taken or changed. Refresh availability and choose another time.",
      );
    }
    throw error;
  }
}

export async function getGuestManagedBooking(token: string) {
  const rows = await sql<
    Array<{
      grant_id: string;
      booking_id: string;
      service_title: string;
      booking_status: string;
      qualification_status: string;
      scheduled_window: string;
      start_at: string;
      end_at: string;
      time_zone: string;
      hold_status: string | null;
      hold_kind: string | null;
      expires_at: string | null;
      condition_label: string | null;
    }>
  >`
    select guest_grant.id as grant_id, booking.id as booking_id,
      service.title as service_title, booking.status as booking_status,
      booking.qualification_status, booking.scheduled_window,
      schedule.start_at::text, schedule.end_at::text,
      territory.timezone as time_zone, hold.status as hold_status,
      hold.hold_kind, hold.expires_at::text, hold.condition_label
    from guest_booking_management_grants guest_grant
    join bookings booking on booking.id = guest_grant.booking_id
    join services service on service.id = booking.service_id
    join job_schedules schedule on schedule.booking_id = booking.id
    join service_territories territory on territory.id = schedule.territory_id
    left join capacity_holds hold on hold.booking_id = booking.id
    where guest_grant.token_digest = ${guestManagementTokenDigest(token)}
      and guest_grant.status = 'active' and guest_grant.expires_at > now()
    limit 1`;
  const row = rows[0];
  if (!row) return null;
  await sql`
    update guest_booking_management_grants
    set last_used_at = now(), updated_at = now()
    where id = ${row.grant_id}`;
  const status =
    row.booking_status === "canceled" || row.hold_status === "canceled"
      ? "canceled"
      : row.hold_status === "confirmed"
        ? "confirmed"
        : row.hold_kind === "conditional"
          ? "pending_scope"
          : "held";
  return {
    reference: deriveBookingReference(row.booking_id),
    serviceTitle: row.service_title,
    status,
    start: new Date(row.start_at).toISOString(),
    end: new Date(row.end_at).toISOString(),
    arrivalWindow: row.scheduled_window,
    timeZone: row.time_zone,
    holdExpiresAt: row.expires_at
      ? new Date(row.expires_at).toISOString()
      : null,
    conditionLabel: row.condition_label,
  };
}
