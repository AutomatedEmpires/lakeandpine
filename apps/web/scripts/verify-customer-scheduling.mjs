// Proves that customer capacity reservations serialize at the database boundary.
// Run only after every migration has been applied to a disposable local database.
import { createHash, randomUUID } from "node:crypto";

import postgres from "postgres";

const APP_ROLE = "lakeandpine_app";
const SAFE_DATABASE_NAME = /(ci|test|proof|disposable)/i;
const SAFE_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function validateTarget(rawUrl) {
  invariant(rawUrl, "MIGRATION_DATABASE_URL is required");
  const target = new URL(rawUrl);
  invariant(
    target.protocol === "postgres:" || target.protocol === "postgresql:",
    "MIGRATION_DATABASE_URL must use postgres:// or postgresql://",
  );
  invariant(
    SAFE_HOSTS.has(target.hostname),
    `Scheduling proof refuses non-local database host ${target.hostname}`,
  );
  const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
  invariant(
    database && SAFE_DATABASE_NAME.test(database),
    "Disposable database name must contain ci, test, proof, or disposable",
  );
  return target.toString();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

const rawUrl = validateTarget(process.env.MIGRATION_DATABASE_URL);
const sql = postgres(rawUrl, {
  max: 6,
  prepare: false,
  onnotice: () => {},
  connection: {
    application_name: "lakeandpine_scheduling_concurrency_proof",
    role: APP_ROLE,
  },
});

const runId = randomUUID().slice(0, 8);
const territoryCode = `proof-${runId}`;
const postalCode = "99998";
const startAt = new Date();
startAt.setUTCDate(startAt.getUTCDate() + 7);
startAt.setUTCHours(10, 0, 0, 0);
const endAt = new Date(startAt.getTime() + 4 * 60 * 60 * 1000);
const dayOfWeek = startAt.getUTCDay();

async function createReservation(label, fixture, options = {}) {
  const reservationStart = options.startAt ?? startAt;
  const reservationEnd = options.endAt ?? endAt;
  return sql.begin(async (transaction) => {
    const [booking] = await transaction`
      insert into bookings (
        service_id, frequency, scheduled_date, scheduled_window, contact,
        service_vertical, territory_id, qualification_status,
        estimated_duration_minutes, required_crew_size, required_skills,
        request_source, idempotency_key, is_dev_seed
      ) values (
        'estate', 'onetime', ${reservationStart.toISOString().slice(0, 10)}, 'capacity proof',
        ${transaction.json({ name: `Concurrency ${label}`, email: `${label}@example.invalid`, zip: postalCode })},
        'estate', ${fixture.territoryId}, 'approved', 240, 1,
        ${["estate-care"]}, 'runtime_smoke', ${digest(`${runId}:booking:${label}`)}, true
      ) returning id`;
    const [schedule] = await transaction`
      insert into job_schedules (
        booking_id, territory_id, service_vertical, start_at, end_at, status,
        required_crew_size, required_skills, labor_minutes,
        travel_buffer_minutes, created_by_label, is_dev_seed
      ) values (
        ${booking.id}, ${fixture.territoryId}, 'estate', ${reservationStart}, ${reservationEnd}, 'held',
        1, ${["estate-care"]}, 240, 0, 'Concurrency proof', true
      ) returning id`;
    const [hold] = await transaction`
      insert into capacity_holds (
        booking_id, job_schedule_id, policy_id, territory_id, service_id,
        hold_kind, status, start_at, end_at, expires_at,
        idempotency_key_hash, qualification_snapshot, is_dev_seed
      ) values (
        ${booking.id}, ${schedule.id}, ${fixture.policyId}, ${fixture.territoryId}, 'estate',
        'direct', 'active', ${reservationStart}, ${reservationEnd}, now() + interval '15 minutes',
        ${digest(`${runId}:hold:${label}`)}, ${transaction.json({ proof: true })}, true
      ) returning id`;
    let assignment;
    if (!options.omitAssignment) {
      [assignment] = await transaction`
        insert into job_assignments (
          job_schedule_id, cleaner_id, assignment_role, status,
          assigned_by_label, is_dev_seed
        ) values (
          ${schedule.id}, ${fixture.cleanerId}, 'lead', 'reserved',
          'Concurrency proof', true
        ) returning id`;
    }
    return {
      bookingId: booking.id,
      scheduleId: schedule.id,
      holdId: hold.id,
      assignmentId: assignment?.id ?? null,
    };
  });
}

try {
  const [identity] = await sql`select current_user, session_user`;
  invariant(identity.current_user === APP_ROLE, `Expected current_user ${APP_ROLE}`);

  const [territory] = await sql`
    insert into service_territories (code, name, timezone, status, travel_buffer_minutes, is_dev_seed)
    values (${territoryCode}, 'Scheduling proof', 'Etc/UTC', 'draft', 0, true)
    returning id`;
  await sql`
    insert into territory_postal_codes (territory_id, postal_code, status, evidence_note)
    values (${territory.id}, ${postalCode}, 'active', 'Disposable concurrency proof')`;
  const [cleaner] = await sql`
    insert into cleaners (
      full_name, status, screening_status, screening_verified_at,
      home_territory_id, skills, vertical_experience,
      max_daily_minutes, max_weekly_minutes, max_daily_jobs, travel_buffer_minutes,
      is_dev_seed
    ) values (
      'Scheduling Proof Cleaner', 'active', 'verified', now(),
      ${territory.id}, ${["estate-care"]}, ${["estate"]},
      550, 2400, 3, 0, true
    ) returning id`;
  const [alternateCleaner] = await sql`
    insert into cleaners (
      full_name, status, screening_status, screening_verified_at,
      home_territory_id, skills, vertical_experience,
      max_daily_minutes, max_weekly_minutes, max_daily_jobs, travel_buffer_minutes,
      is_dev_seed
    ) values (
      'Alternate Proof Cleaner', 'active', 'verified', now(),
      ${territory.id}, ${["estate-care"]}, ${["estate"]},
      550, 2400, 3, 0, true
    ) returning id`;
  const [availability] = await sql`
    insert into cleaner_availability_rules (
      cleaner_id, territory_id, day_of_week, start_time, end_time,
      effective_from, status
    ) values (
      ${cleaner.id}, ${territory.id}, ${dayOfWeek}, '00:01', '23:59',
      current_date, 'active'
    ) returning id`;
  await sql`update service_territories set status = 'active' where id = ${territory.id}`;
  const [policy] = await sql`
    insert into service_scheduling_policies (
      service_id, territory_id, version, status, scheduling_path,
      allowed_contexts, allowed_size_bands, allowed_conditions, allowed_cadences,
      labor_minutes, required_crew_size, required_skills,
      travel_buffer_minutes, minimum_lead_hours, horizon_days,
      operating_start, operating_end
    ) values (
      'estate', ${territory.id}, 1, 'active', 'direct',
      ${["primary_residence"]}, ${["standard"]}, ${["maintained"]}, ${["project"]},
      240, 1, ${["estate-care"]}, 0, 1, 35, '00:01', '23:59'
    ) returning id`;

  const fixture = { territoryId: territory.id, cleanerId: cleaner.id, policyId: policy.id };
  const acceptedStart = new Date(startAt.getTime() - 3 * 60 * 60 * 1_000);
  const acceptedEnd = new Date(startAt.getTime() - 1 * 60 * 60 * 1_000);
  await sql.begin(async (transaction) => {
    const [booking] = await transaction`
      insert into bookings (
        service_id, frequency, scheduled_date, scheduled_window, contact,
        service_vertical, territory_id, qualification_status,
        estimated_duration_minutes, required_crew_size, required_skills,
        request_source, idempotency_key, is_dev_seed
      ) values (
        'estate', 'onetime', ${acceptedStart.toISOString().slice(0, 10)}, 'accepted capacity proof',
        ${transaction.json({ name: 'Accepted work', email: 'accepted@example.invalid', zip: postalCode })},
        'estate', ${territory.id}, 'approved', 120, 1, ${["estate-care"]},
        'runtime_smoke', ${digest(`${runId}:accepted-booking`)}, true
      ) returning id`;
    const [schedule] = await transaction`
      insert into job_schedules (
        booking_id, territory_id, service_vertical, start_at, end_at, status,
        required_crew_size, required_skills, labor_minutes,
        travel_buffer_minutes, created_by_label, is_dev_seed
      ) values (
        ${booking.id}, ${territory.id}, 'estate', ${acceptedStart}, ${acceptedEnd}, 'held',
        1, ${["estate-care"]}, 120, 0, 'Accepted capacity proof', true
      ) returning id`;
    await transaction`
      insert into job_assignments (
        job_schedule_id, cleaner_id, assignment_role, status,
        assigned_by_label, is_dev_seed
      ) values (
        ${schedule.id}, ${cleaner.id}, 'lead', 'accepted',
        'Accepted capacity proof', true
      )`;
  });

  let missingCrewError;
  try {
    await createReservation("missing-crew", fixture, { omitAssignment: true });
  } catch (error) {
    missingCrewError = error;
  }
  invariant(
    missingCrewError?.code === "23514",
    `Expected missing reserved crew to fail with 23514; received ${missingCrewError?.code ?? "no SQLSTATE"}`,
  );
  const [partialRows] = await sql`
    select count(*)::integer as count from bookings
    where idempotency_key = ${digest(`${runId}:booking:missing-crew`)}`;
  invariant(partialRows.count === 0, "Rejected reservation left partial booking rows");

  const contenders = await Promise.allSettled([
    createReservation("alpha", fixture),
    createReservation("bravo", fixture),
  ]);
  const winners = contenders.filter((result) => result.status === "fulfilled");
  const rejected = contenders.filter((result) => result.status === "rejected");
  invariant(winners.length === 1, `Expected one reservation winner; found ${winners.length}`);
  invariant(rejected.length === 1, `Expected one conflicting reservation rejection; found ${rejected.length}`);
  invariant(
    ["23P01", "23514"].includes(rejected[0].reason?.code),
    `Expected a database capacity conflict; received ${rejected[0].reason?.code ?? "no SQLSTATE"}`,
  );
  let aggregateCapacityError;
  try {
    await createReservation("aggregate-limit", fixture, {
      startAt: endAt,
      endAt: new Date(endAt.getTime() + 4 * 60 * 60 * 1_000),
    });
  } catch (error) {
    aggregateCapacityError = error;
  }
  invariant(
    aggregateCapacityError?.code === "23514" && /including holds/.test(aggregateCapacityError.message),
    `Expected combined accepted-plus-reserved limit rejection; received ${aggregateCapacityError?.message ?? "no error"}`,
  );

  const winner = winners[0].value;
  let forgedHoldError;
  try {
    await sql`
      update capacity_holds
      set service_id = 'commercial'
      where id = ${winner.holdId}`;
  } catch (error) {
    forgedHoldError = error;
  }
  invariant(
    forgedHoldError?.code === "23514",
    `Expected mismatched hold authority to fail with 23514; received ${forgedHoldError?.code ?? "no SQLSTATE"}`,
  );
  let reverseScheduleError;
  try {
    await sql`
      update job_schedules
      set start_at = start_at + interval '1 hour', end_at = end_at + interval '1 hour'
      where id = ${winner.scheduleId}`;
  } catch (error) {
    reverseScheduleError = error;
  }
  invariant(
    reverseScheduleError?.code === "23514",
    `Expected reverse schedule mutation to fail with 23514; received ${reverseScheduleError?.code ?? "no SQLSTATE"}`,
  );
  let coherentRescheduleConflict;
  const conflictingStart = new Date(startAt.getTime() - 2 * 60 * 60 * 1_000);
  const conflictingEnd = new Date(conflictingStart.getTime() + 4 * 60 * 60 * 1_000);
  try {
    await sql.begin(async (transaction) => {
      await transaction`
        update job_schedules set start_at = ${conflictingStart}, end_at = ${conflictingEnd}
        where id = ${winner.scheduleId}`;
      await transaction`
        update capacity_holds set start_at = ${conflictingStart}, end_at = ${conflictingEnd}
        where id = ${winner.holdId}`;
    });
  } catch (error) {
    coherentRescheduleConflict = error;
  }
  invariant(
    coherentRescheduleConflict?.code === "23P01",
    `Expected coherent reschedule into accepted work to fail with 23P01; received ${coherentRescheduleConflict?.code ?? "no SQLSTATE"}`,
  );
  let cleanerEligibilityError;
  try {
    await sql`update cleaners set skills = '{}' where id = ${cleaner.id}`;
  } catch (error) {
    cleanerEligibilityError = error;
  }
  invariant(
    cleanerEligibilityError?.code === "23514",
    `Expected reserved cleaner invalidation to fail with 23514; received ${cleanerEligibilityError?.code ?? "no SQLSTATE"}`,
  );
  let availabilityReassignmentError;
  try {
    await sql`
      update cleaner_availability_rules set cleaner_id = ${alternateCleaner.id}
      where id = ${availability.id}`;
  } catch (error) {
    availabilityReassignmentError = error;
  }
  invariant(
    availabilityReassignmentError?.code === "23514",
    `Expected availability reassignment to revalidate the old cleaner; received ${availabilityReassignmentError?.code ?? "no SQLSTATE"}`,
  );
  let capacityReductionError;
  try {
    await sql`update cleaners set max_daily_minutes = 300 where id = ${cleaner.id}`;
  } catch (error) {
    capacityReductionError = error;
  }
  invariant(
    capacityReductionError?.code === "23514" && /daily minute capacity/.test(capacityReductionError.message),
    `Expected cleaner capacity reduction to fail against holds; received ${capacityReductionError?.message ?? "no error"}`,
  );
  await sql`
    update capacity_holds
    set expires_at = now() + interval '1 second'
    where id = ${winner.holdId}`;
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const replacement = await createReservation("charlie", fixture);
  const [activeReservation] = await sql`
    select count(*)::integer as count
    from job_assignments assignment
    join job_schedules schedule on schedule.id = assignment.job_schedule_id
    join capacity_holds hold on hold.job_schedule_id = schedule.id
    where assignment.cleaner_id = ${cleaner.id}
      and assignment.status = 'reserved'
      and hold.status = 'active'
      and hold.expires_at > now()
      and schedule.start_at = ${startAt}`;
  invariant(activeReservation.count === 1, `Expected one live reservation; found ${activeReservation.count}`);

  await sql.begin(async (transaction) => {
    await transaction`
      update job_assignments set status = 'accepted', responded_at = now()
      where id = ${replacement.assignmentId}`;
    await transaction`
      update job_schedules set status = 'confirmed', version = version + 1
      where id = ${replacement.scheduleId}`;
    await transaction`
      update capacity_holds set status = 'confirmed', updated_at = now()
      where id = ${replacement.holdId}`;
  });
  const [confirmedLifecycle] = await sql`
    select hold.status as hold_status, schedule.status as schedule_status,
      assignment.status as assignment_status
    from capacity_holds hold
    join job_schedules schedule on schedule.id = hold.job_schedule_id
    join job_assignments assignment on assignment.job_schedule_id = schedule.id
    where hold.id = ${replacement.holdId}`;
  invariant(
    confirmedLifecycle.hold_status === "confirmed" &&
      confirmedLifecycle.schedule_status === "confirmed" &&
      confirmedLifecycle.assignment_status === "accepted",
    "Confirmed hold lifecycle did not converge atomically",
  );

  const [expiredCleanup] = await sql`select expire_customer_capacity_holds() as count`;
  invariant(expiredCleanup.count >= 1, "Expired hold cleanup did not process the elapsed hold");
  let reactivationError;
  try {
    await sql`update capacity_holds set status = 'active' where id = ${winner.holdId}`;
  } catch (error) {
    reactivationError = error;
  }
  invariant(
    reactivationError?.code === "23514",
    `Expected terminal hold reactivation to fail with 23514; received ${reactivationError?.code ?? "no SQLSTATE"}`,
  );

  console.log(JSON.stringify({
    applicationRole: identity.current_user,
    winnerScheduleId: winner.scheduleId,
    replacementScheduleId: replacement.scheduleId,
    conflictSqlState: rejected[0].reason.code,
    aggregateCapacitySqlState: aggregateCapacityError.code,
    forgedHoldSqlState: forgedHoldError.code,
    missingCrewSqlState: missingCrewError.code,
    reverseScheduleSqlState: reverseScheduleError.code,
    coherentRescheduleSqlState: coherentRescheduleConflict.code,
    cleanerEligibilitySqlState: cleanerEligibilityError.code,
    availabilityReassignmentSqlState: availabilityReassignmentError.code,
    capacityReductionSqlState: capacityReductionError.code,
    reactivationSqlState: reactivationError.code,
    rejectedReservationPartialRows: partialRows.count,
    expiredHoldIgnoredBeforeCleanup: true,
    confirmedLifecycle,
  }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
