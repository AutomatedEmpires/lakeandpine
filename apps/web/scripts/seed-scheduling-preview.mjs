// Seeds one synthetic, local-only direct-scheduling lane for browser proof.
import postgres from "postgres";

const SAFE_DATABASE_NAME = /(ci|test|proof|disposable)/i;
const SAFE_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const rawUrl = process.env.DATABASE_URL;
invariant(rawUrl, "DATABASE_URL is required");
const target = new URL(rawUrl);
const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
invariant(SAFE_HOSTS.has(target.hostname), "Preview seed refuses a non-local database");
invariant(SAFE_DATABASE_NAME.test(database), "Preview seed requires a disposable database name");

const sql = postgres(rawUrl, {
  max: 1,
  prepare: false,
  onnotice: () => {},
  connection: {
    application_name: "lakeandpine_scheduling_preview_seed",
    role: "lakeandpine_app",
  },
});

try {
  const result = await sql.begin(async (transaction) => {
    let [territory] = await transaction`
      select id from service_territories where code = 'preview-direct' limit 1`;
    if (!territory) {
      [territory] = await transaction`
        insert into service_territories (
          code, name, timezone, status, travel_buffer_minutes,
          qualification_notes, is_dev_seed
        ) values (
          'preview-direct', 'Synthetic scheduling preview',
          'America/Los_Angeles', 'draft', 15,
          'Local browser proof only', true
        ) returning id`;
    }
    await transaction`
      insert into territory_postal_codes (
        territory_id, postal_code, status, evidence_note
      ) values (
        ${territory.id}, '99997', 'active', 'Synthetic local browser proof only'
      ) on conflict (territory_id, postal_code) do update
        set status = excluded.status, evidence_note = excluded.evidence_note`;

    let [cleaner] = await transaction`
      select id from cleaners
      where external_auth_id = 'preview-scheduling-cleaner' limit 1`;
    if (!cleaner) {
      [cleaner] = await transaction`
        insert into cleaners (
          external_auth_id, full_name, email, status, screening_status,
          screening_verified_at, home_territory_id, skills,
          vertical_experience, max_daily_minutes, max_weekly_minutes,
          max_daily_jobs, travel_buffer_minutes, is_dev_seed
        ) values (
          'preview-scheduling-cleaner', 'Synthetic Preview Cleaner',
          'scheduling-preview@example.invalid', 'active', 'verified', now(),
          ${territory.id}, ${["estate-care", "finish-awareness"]},
          ${["estate"]}, 480, 2400, 3, 15, true
        ) returning id`;
    }
    for (let day = 0; day < 7; day += 1) {
      await transaction`
        insert into cleaner_availability_rules (
          cleaner_id, territory_id, day_of_week, start_time, end_time,
          effective_from, status
        ) select
          ${cleaner.id}, ${territory.id}, ${day}, '08:00', '17:00',
          current_date, 'active'
        where not exists (
          select 1 from cleaner_availability_rules
          where cleaner_id = ${cleaner.id} and territory_id = ${territory.id}
            and day_of_week = ${day} and status = 'active'
        )`;
    }
    await transaction`
      update service_territories set status = 'active'
      where id = ${territory.id} and status <> 'active'`;

    let [policy] = await transaction`
      select id from service_scheduling_policies
      where service_id = 'estate' and territory_id = ${territory.id}
        and status = 'active' limit 1`;
    if (!policy) {
      [policy] = await transaction`
        insert into service_scheduling_policies (
          service_id, territory_id, version, status, scheduling_path,
          allowed_contexts, allowed_size_bands, allowed_conditions,
          allowed_cadences, labor_minutes, required_crew_size,
          required_skills, travel_buffer_minutes, minimum_lead_hours,
          horizon_days, slot_increment_minutes, operating_start,
          operating_end, selection_hold_minutes, is_dev_seed
        ) values (
          'estate', ${territory.id}, 1, 'active', 'direct',
          ${["primary_home"]}, ${["standard"]}, ${["maintained"]},
          ${["project"]}, 240, 1,
          ${["estate-care", "finish-awareness"]}, 15, 1, 35, 60,
          '08:00', '17:00', 15, true
        ) returning id`;
    }
    return { territoryId: territory.id, cleanerId: cleaner.id, policyId: policy.id };
  });
  console.log(JSON.stringify({
    result: "PASS",
    fixture: "synthetic local scheduling preview",
    postalCode: "99997",
    ...result,
  }, null, 2));
} finally {
  await sql.end();
}
