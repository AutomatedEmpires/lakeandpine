// Non-production runtime smoke for the public conversion and booking paths.
// Requires a migrated disposable DATABASE_URL and a running app at
// RUNTIME_SMOKE_BASE_URL (defaults to http://127.0.0.1:3010).
// All synthetic rows are removed before the command exits, including on failure.
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

assert(
  smokeToken && smokeToken.length >= 32,
  "RUNTIME_SMOKE_TOKEN must be set to the same 32+ character value in the app server and smoke process",
);
assert(
  !forceFailure || forceFailure === "after-booking",
  "RUNTIME_SMOKE_FORCE_FAILURE only supports after-booking",
);

const sql = connect();

async function getPage(path, marker) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  assert(response.ok, `GET ${path} returned ${response.status}`);
  if (marker) assert(text.includes(marker), `GET ${path} did not include ${marker}`);
  return { path, status: response.status, bytes: Buffer.byteLength(text) };
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
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`POST ${path} returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }
  assert(response.ok, `POST ${path} returned ${response.status}: ${text.slice(0, 200)}`);
  return payload;
}

function nextBookableDate() {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + 2);
  while (date.getDay() === 0) date.setDate(date.getDate() + 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function cleanup() {
  await sql`
    delete from booking_events using bookings
    where booking_events.booking_id = bookings.id
      and bookings.contact ->> 'email' = ${email}`;
  await sql`delete from bookings where contact ->> 'email' = ${email}`;
  await sql`delete from quotes where email = ${email}`;
  await sql`delete from leads where email = ${email}`;
}

try {
  const pages = [];
  pages.push(await getPage("/"));
  pages.push(await getPage("/services", "Essential Home Reset"));
  pages.push(await getPage("/pricing", "Weekly"));
  pages.push(await getPage("/areas", "Coeur"));
  pages.push(await getPage("/areas/coeur-dalene", "Coeur"));
  pages.push(await getPage("/reviews"));
  pages.push(await getPage("/book", "Book"));

  const quote = await postJson("/api/quote", {
    sizeBand: "1200_2000",
    serviceId: "deep",
    bedrooms: "3",
    bathrooms: "2",
    frequency: "onetime",
    pets: "one",
    priorities: "Synthetic non-production runtime smoke",
    email,
  });
  assert(quote.id && quote.estimate === 377, "quote response did not match the canonical estimate");

  const lead = await postJson("/api/leads", {
    fullName: "Runtime Smoke",
    zip: "83814",
    serviceId: "deep",
    email,
    phone: "2085550100",
  });
  assert(lead.id, "lead response did not include an id");

  const scheduledDate = nextBookableDate();
  const booking = await postJson("/api/bookings", {
    serviceId: "deep",
    addonIds: ["fridge", "oven"],
    frequency: "onetime",
    scheduledDate,
    scheduledWindow: "10:00 AM",
    home: {
      propertyType: "house",
      sizeBand: "1200_2000",
      bedrooms: "3",
      bathrooms: "2",
      floors: "1",
      pets: "one",
      condition: "needs_detail",
    },
    rooms: [
      { id: "kitchen", label: "Kitchen", selected: true, note: "Synthetic smoke note" },
      { id: "bathroom", label: "Bathrooms", selected: true },
    ],
    preferences: ["Unscented products"],
    petNotes: "Synthetic smoke pet note",
    accessMethod: "coordinate_later",
    contact: {
      name: "Runtime Smoke",
      phone: "2085550100",
      email,
      zip: "83814",
    },
    accessNotes: "Synthetic non-production runtime smoke; discard",
    specialInstructions: "Synthetic non-production runtime smoke",
  });
  assert(booking.id && booking.estimate === 427, "booking response did not match the canonical estimate");
  if (forceFailure === "after-booking") {
    throw new Error("Forced runtime smoke failure after booking persistence");
  }

  const concierge = await postJson("/api/concierge", {
    message: "How much is a deep clean?",
  });
  assert(
    typeof concierge.reply === "string" && concierge.reply.includes("starting anchor"),
    "concierge response lost its starting-anchor qualification",
  );

  const [quoteRow] = await sql`
    select id::text, estimate_cents
    from quotes where id = ${quote.id}`;
  assert(quoteRow?.estimate_cents === 37700, "quote was not persisted at 37700 cents");

  const [leadRow] = await sql`
    select id::text, status
    from leads where id = ${lead.id}`;
  assert(leadRow?.status === "new", "lead was not persisted with new status");

  const [bookingRow] = await sql`
    select b.id::text, b.status, b.estimate_cents, b.planning_score,
      exists (
        select 1 from booking_events e
        where e.booking_id = b.id and e.type = 'requested'
      ) as has_requested_event,
      (select count(*)::int from checklist_items c where c.booking_id = b.id) as checklist_count
    from bookings b where b.id = ${booking.id}`;
  assert(bookingRow?.status === "requested", "booking was not persisted with requested status");
  assert(bookingRow?.estimate_cents === 42700, "booking was not persisted at 42700 cents");
  assert(bookingRow?.has_requested_event, "booking did not receive a requested event");
  assert(bookingRow?.planning_score > 0, "booking did not receive a planning score");
  assert(bookingRow?.checklist_count > 0, "booking did not receive a generated checklist");

  console.log(JSON.stringify({
    result: "PASS",
    database: "disposable/non-production target supplied through DATABASE_URL",
    pages,
    writes: {
      quote: { status: "persisted", estimateCents: quoteRow.estimate_cents },
      lead: { status: leadRow.status },
      booking: {
        status: bookingRow.status,
        estimateCents: bookingRow.estimate_cents,
        requestedEvent: bookingRow.has_requested_event,
        scheduledDate,
      },
    },
    concierge: "canonical starting-anchor language present",
    cleanup: "synthetic rows removed in finally",
  }, null, 2));
} finally {
  try {
    await cleanup();
  } finally {
    await sql.end({ timeout: 5 });
  }
}
