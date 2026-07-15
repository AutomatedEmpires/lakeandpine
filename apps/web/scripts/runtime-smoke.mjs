// Non-production runtime smoke for premium public pages and the durable request path.
// Requires a fully migrated disposable DATABASE_URL and a running app at
// RUNTIME_SMOKE_BASE_URL. Synthetic rows are removed even when an assertion fails.
import { randomUUID } from "node:crypto";

import { connect } from "./_db.mjs";

const baseUrl = (process.env.RUNTIME_SMOKE_BASE_URL || "http://127.0.0.1:3010").replace(/\/$/, "");
const smokeToken = process.env.RUNTIME_SMOKE_TOKEN;
const forceFailure = process.env.RUNTIME_SMOKE_FORCE_FAILURE;
const runId = randomUUID();
const email = `runtime-smoke-${runId}@example.invalid`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(smokeToken && smokeToken.length >= 32, "RUNTIME_SMOKE_TOKEN must match the app server and contain at least 32 characters");
assert(!forceFailure || forceFailure === "after-booking", "RUNTIME_SMOKE_FORCE_FAILURE only supports after-booking");
assert(process.env.LAKEANDPINE_ALLOW_RUNTIME_SMOKE === "1", "Set LAKEANDPINE_ALLOW_RUNTIME_SMOKE=1 only for an explicitly selected disposable target");
assert(process.env.NODE_ENV !== "production" && process.env.VERCEL_ENV !== "production", "Runtime smoke is forbidden in production");
const smokeUrl = new URL(baseUrl);
assert(smokeUrl.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(smokeUrl.hostname), "Runtime smoke only accepts a local HTTP application target");
assert(Boolean(process.env.RUNTIME_SMOKE_DATABASE), "RUNTIME_SMOKE_DATABASE must exactly name the disposable database");

const sql = connect();

async function getPage(path, marker) {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.text();
  assert(response.ok, `GET ${path} returned ${response.status}`);
  if (marker) assert(body.includes(marker), `GET ${path} did not include ${marker}`);
  return { path, status: response.status, bytes: Buffer.byteLength(body) };
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lake-pine-runtime-smoke-token": smokeToken,
      "x-lake-pine-runtime-smoke-database": process.env.RUNTIME_SMOKE_DATABASE,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = JSON.parse(text);
  assert(response.ok, `POST ${path} returned ${response.status}: ${text.slice(0, 240)}`);
  return payload;
}

function planningDate(offset) {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function cleanup() {
  await sql`delete from operations_state_events where is_dev_seed
    and booking_id in (select id from bookings where contact ->> 'email' = ${email})`;
  await sql`delete from bookings where contact ->> 'email' = ${email}`;
}

try {
  const [target] = await sql`
    select current_database() as database_name,
      coalesce(inet_server_addr()::text, 'local-socket') as server_address`;
  assert(
    target.database_name === process.env.RUNTIME_SMOKE_DATABASE,
    `Runtime smoke database mismatch: expected ${process.env.RUNTIME_SMOKE_DATABASE}, connected to ${target.database_name}`,
  );
  console.log(`Runtime smoke target: ${target.database_name} @ ${target.server_address} via ${baseUrl}`);
  const pages = [];
  pages.push(await getPage("/", "Interior care"));
  pages.push(await getPage("/services", "Private Estate Care"));
  pages.push(await getPage("/who-we-serve", "Who we serve"));
  pages.push(await getPage("/pricing", "Custom"));
  pages.push(await getPage("/areas", "Service area planning"));
  pages.push(await getPage("/book", "Request"));
  pages.push(await getPage("/service-support", "Service Support"));
  pages.push(await getPage("/join", "Lake &amp; Pine"));
  pages.push(await getPage("/privacy", "Privacy"));
  pages.push(await getPage("/terms", "Terms"));

  const idempotencyKey = randomUUID();
  const payload = {
    idempotencyKey,
    companyWebsite: "",
    program: "construction",
    property: {
      sizeBand: "large",
      condition: "project",
      zoneCount: 14,
      context: "owner_handoff",
      cadence: "project",
    },
    scope: {
      priorities: "Synthetic final-clean handoff request for disposable runtime verification only.",
      finishNotes: "Synthetic specialty-finish note; no real property data.",
    },
    scheduling: {
      preferredDate: planningDate(5),
      alternateDates: [planningDate(6), planningDate(7)],
      windowPreference: "8:00–10:00 AM",
      deadlineCritical: true,
      accessComplex: false,
    },
    contact: {
      name: "Runtime Smoke",
      phone: "2085550100",
      email,
      street: "105 N 1st St",
      unit: "",
      city: "Coeur d'Alene",
      state: "ID",
      zip: "83814",
    },
    acknowledgements: {
      siteReady: true,
      privacyConsent: true,
      termsConsent: true,
      photoPermission: false,
      version: "2026-07-13",
    },
  };
  const booking = await postJson("/api/bookings", payload);
  assert(booking.id && /^LP-[A-F0-9-]+$/.test(booking.reference), "booking response did not include a protected public reference");
  assert(booking.planning?.reviewPath === "walkthrough recommended", "construction request did not route to walkthrough review");

  const duplicate = await postJson("/api/bookings", payload);
  assert(duplicate.id === booking.id && duplicate.duplicate === true, "idempotent retry created or returned a different booking");
  if (forceFailure === "after-booking") throw new Error("Forced runtime smoke failure after booking persistence");

  const [bookingRow] = await sql`
    select b.id::text, b.service_vertical, b.status, b.qualification_status,
      b.estimate_cents, b.required_crew_size, b.estimated_duration_minutes,
      exists(select 1 from booking_events e where e.booking_id = b.id and e.type = 'requested') as has_requested_event,
      (select count(*)::int from checklist_items c where c.booking_id = b.id) as checklist_count,
      (select count(*)::int from notification_outbox o where o.booking_id = b.id) as outbox_count,
      assessment.id::text as route_assessment_id,
      assessment.team_id::text as route_team_id,
      assessment.address_fingerprint,
      assessment.assessment_status as route_status,
      assessment.provider as route_provider,
      assessment.branch_origin_label,
      assessment.branch_origin_latitude::float8,
      assessment.branch_origin_longitude::float8,
      assessment.standard_radius_miles::float8
    from bookings b
    left join service_location_assessments assessment on assessment.booking_id = b.id
    where b.id = ${booking.id}`;
  assert(bookingRow?.service_vertical === "construction", "premium vertical was not persisted");
  assert(bookingRow?.status === "requested", "request did not stay unconfirmed");
  assert(bookingRow?.qualification_status === "walkthrough_needed", "qualification path was not persisted");
  assert(bookingRow?.estimate_cents == null, "custom-proposal request fabricated a price");
  assert(bookingRow?.required_crew_size > 0 && bookingRow?.estimated_duration_minutes > 0, "planning capacity was not persisted");
  assert(bookingRow?.has_requested_event && bookingRow?.checklist_count > 0, "atomic event/checklist evidence is missing");
  assert(bookingRow?.outbox_count === 2, "customer and operations notifications were not durably recorded");
  assert(bookingRow?.route_assessment_id, "route assessment was not created atomically");
  assert(bookingRow?.route_team_id == null, "intake route assessment was prematurely assigned to a team");
  assert(/^[0-9a-f]{64}$/.test(bookingRow?.address_fingerprint ?? ""), "route address fingerprint is invalid");
  assert(["manual_review", "inside_standard_radius", "outside_standard_radius"].includes(bookingRow?.route_status), "route assessment status is invalid");
  assert(["manual", "mapbox"].includes(bookingRow?.route_provider), "route provider evidence is invalid");
  assert(bookingRow?.branch_origin_label && Number.isFinite(bookingRow?.branch_origin_latitude) && Number.isFinite(bookingRow?.branch_origin_longitude) && bookingRow?.standard_radius_miles > 0, "route origin/radius evidence is incomplete");

  console.log(JSON.stringify({
    result: "PASS",
    database: "disposable/non-production target supplied through DATABASE_URL",
    pages,
    writes: {
      booking: {
        status: bookingRow.status,
        qualificationStatus: bookingRow.qualification_status,
        serviceVertical: bookingRow.service_vertical,
        requiredCrewSize: bookingRow.required_crew_size,
        estimatedDurationMinutes: bookingRow.estimated_duration_minutes,
        requestedEvent: bookingRow.has_requested_event,
        checklistCount: bookingRow.checklist_count,
        outboxCount: bookingRow.outbox_count,
        idempotentRetry: true,
        routeAssessment: {
          status: bookingRow.route_status,
          provider: bookingRow.route_provider,
          unallocated: bookingRow.route_team_id == null,
        },
      },
    },
    cleanup: "synthetic rows removed in finally",
  }, null, 2));
} finally {
  try {
    await cleanup();
  } finally {
    await sql.end({ timeout: 5 });
  }
}
