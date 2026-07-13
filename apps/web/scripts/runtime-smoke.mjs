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
      windowPreference: "Morning",
      deadlineCritical: true,
      accessComplex: false,
    },
    contact: { name: "Runtime Smoke", phone: "2085550100", email, zip: "83814" },
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
      (select count(*)::int from notification_outbox o where o.booking_id = b.id) as outbox_count
    from bookings b where b.id = ${booking.id}`;
  assert(bookingRow?.service_vertical === "construction", "premium vertical was not persisted");
  assert(bookingRow?.status === "requested", "request did not stay unconfirmed");
  assert(bookingRow?.qualification_status === "walkthrough_needed", "qualification path was not persisted");
  assert(bookingRow?.estimate_cents == null, "custom-proposal request fabricated a price");
  assert(bookingRow?.required_crew_size > 0 && bookingRow?.estimated_duration_minutes > 0, "planning capacity was not persisted");
  assert(bookingRow?.has_requested_event && bookingRow?.checklist_count > 0, "atomic event/checklist evidence is missing");
  assert(bookingRow?.outbox_count === 2, "customer and operations notifications were not durably recorded");

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
