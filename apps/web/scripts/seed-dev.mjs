// Seeds a DEV-ONLY demo customer with bookings, billing history, home notes,
// and a support thread so the dashboard is verifiable end-to-end before Clerk
// keys exist. Everything is marked is_dev_seed=true; ops:purge-dev-seed removes it.
import { connect } from "./_db.mjs";

const sql = connect();
const EMAIL = "dev-preview@lakeandpinecleaning.com";
const OPERATOR_EMAIL = "operator-preview@lakeandpinecleaning.com";
const CLEANER_EMAIL = "cleaner-preview@lakeandpinecleaning.com";

// customers has no BEFORE INSERT triggers, but keep the sibling-venture rule
// anyway: select-then-insert instead of relying on ON CONFLICT.
let [customer] = await sql`select id from customers where email = ${EMAIL}`;
if (!customer) {
  [customer] = await sql`
    insert into customers (email, full_name, phone, referral_credit_cents, is_dev_seed)
    values (${EMAIL}, 'Devon Preview', null, 2500, true)
    returning id`;
}

let [operator] = await sql`select id from customers where email = ${OPERATOR_EMAIL}`;
if (!operator) {
  [operator] = await sql`
    insert into customers (email, full_name, role, is_dev_seed)
    values (${OPERATOR_EMAIL}, 'Pine Operator', 'staff', true)
    returning id`;
}

let [home] = await sql`select id from homes where customer_id = ${customer.id}`;
if (!home) {
  [home] = await sql`
    insert into homes
      (customer_id, label, city, state, zip, size_band, bedrooms, bathrooms, pets,
       condition, preference_tags, cleaner_notes, is_dev_seed)
    values
      (${customer.id}, 'Lake home', 'Coeur d''Alene', 'ID', '83814', '1200_2000', '3', '2',
       'one', 'maintained',
       ${["Unscented products", "Dog friendly", "Focus glass", "Side entrance"]},
       'Use side entrance. Dog is friendly. Prioritize kitchen floor, primary bath glass, and lake-room dusting.',
       true)
    returning id`;
}

const existingRooms = await sql`select 1 from rooms where home_id = ${home.id}`;
if (existingRooms.length === 0) {
  await sql`
    insert into rooms (home_id, name, room_type, notes, priority, is_dev_seed) values
      (${home.id}, 'Kitchen', 'kitchen', 'Prioritize floors and cabinet fronts.', 3, true),
      (${home.id}, 'Primary bathroom', 'bathroom', 'Use unscented products on glass.', 2, true),
      (${home.id}, 'Lake room', 'living_room', 'Dust open shelving carefully.', 2, true)`;
}

const existingBookings = await sql`select 1 from bookings where customer_id = ${customer.id}`;
if (existingBookings.length === 0) {
  const contact = {
    name: "Devon Preview",
    phone: "",
    email: EMAIL,
    zip: "83814",
  };
  const homeDetails = {
    sizeBand: "1200_2000",
    bedrooms: "3",
    bathrooms: "2",
    pets: "one",
    condition: "maintained",
  };
  const [upcoming] = await sql`
    insert into bookings
      (customer_id, home_id, service_id, frequency, scheduled_date, scheduled_window,
       status, estimate_cents, contact, home_details, is_dev_seed)
    values
      (${customer.id}, ${home.id}, 'essential', 'biweekly',
       current_date + interval '9 days', '10:00 AM', 'confirmed', 13900,
       ${sql.json(contact)}, ${sql.json(homeDetails)}, true)
    returning id`;
  await sql`
    insert into booking_events (booking_id, type, data)
    values (${upcoming.id}, 'requested', ${sql.json({ via: "dev-seed" })}),
           (${upcoming.id}, 'confirmed', ${sql.json({ via: "dev-seed" })})`;

  for (const daysAgo of [5, 19]) {
    const [done] = await sql`
      insert into bookings
        (customer_id, home_id, service_id, frequency, scheduled_date, scheduled_window,
         status, estimate_cents, contact, home_details, is_dev_seed)
      values
        (${customer.id}, ${home.id}, 'essential', 'biweekly',
         current_date - ${daysAgo}::int, '10:00 AM', 'completed', 13900,
         ${sql.json(contact)}, ${sql.json(homeDetails)}, true)
      returning id`;
    await sql`
      insert into billing_records
        (customer_id, booking_id, description, amount_cents, status, occurred_at, is_dev_seed)
      values
        (${customer.id}, ${done.id}, 'Essential Home Reset — bi-weekly visit', 13900, 'paid',
         now() - make_interval(days => ${daysAgo}), true)`;
  }

  await sql`
    insert into support_messages (customer_id, sender, body, is_dev_seed) values
    (${customer.id}, 'customer', 'Can I add inside oven next time?', true),
    (${customer.id}, 'staff', 'Yes — inside oven is +$25. I can add it to your next visit; just confirm here.', true)`;
}

const roomPlan = [
  { id: "kitchen", label: "Kitchen", selected: true, note: "Prioritize floors and cabinet fronts" },
  { id: "bathroom", label: "Bathrooms", selected: true, note: "Focus primary shower glass" },
  { id: "living_room", label: "Living room", selected: true, note: "Dust lake-room shelving" },
  { id: "primary_bedroom", label: "Primary bedroom", selected: true },
];
const propertyProfile = {
  propertyType: "house",
  sizeBand: "1200_2000",
  bedrooms: "3",
  bathrooms: "2",
  floors: "1",
  condition: "maintained",
};

const demoBookings = await sql`
  select id, status from bookings where customer_id = ${customer.id} and is_dev_seed`;
for (const booking of demoBookings) {
  await sql`
    update bookings set
      property_profile = ${sql.json(propertyProfile)},
      room_plan = ${sql.json(roomPlan)},
      cleaning_preferences = ${["Unscented products", "Prioritize floors", "Shoes off indoors"]},
      pet_notes = 'Friendly dog named Cedar; keep exterior doors closed.',
      special_instructions = 'Use care around the open lake-room shelving.',
      planning_direction = 'Standard plan · 4 rooms · focus: Kitchen, Bathrooms, Living room',
      planning_score = 38
    where id = ${booking.id}`;

  const existingChecklist = await sql`select 1 from checklist_items where booking_id = ${booking.id}`;
  if (existingChecklist.length === 0) {
    const tasks = [
      [null, "Confirm agreed scope before starting"],
      ["Kitchen", "Clean counters, backsplash, sink, and appliance exteriors"],
      ["Kitchen", "Finish floors and review cabinet-front note"],
      ["Bathrooms", "Clean sinks, mirrors, toilets, tubs, and showers"],
      ["Living room", "Dust reachable surfaces and open shelving"],
      ["Primary bedroom", "Dust surfaces and finish floors"],
      [null, "Complete final walkthrough and reset waste bins"],
    ];
    for (const [sort, task] of tasks.entries()) {
      await sql`
        insert into checklist_items (booking_id, room_label, label, sort, is_dev_seed)
        values (${booking.id}, ${task[0]}, ${task[1]}, ${sort}, true)`;
    }
  }
}

let [intakeRequest] = await sql`
  select id from bookings
  where customer_id = ${customer.id} and is_dev_seed and status = 'requested'`;
if (!intakeRequest) {
  [intakeRequest] = await sql`
    insert into bookings
      (customer_id, home_id, service_id, frequency, scheduled_date, scheduled_window,
       status, estimate_cents, contact, home_details, property_profile, room_plan,
       cleaning_preferences, pet_notes, access_notes, special_instructions,
       planning_direction, planning_score, is_dev_seed)
    values
      (${customer.id}, ${home.id}, 'deep', 'onetime', current_date + interval '14 days',
       '12:00 PM', 'requested', 33700,
       ${sql.json({ name: "Devon Preview", phone: "208-555-0100", email: EMAIL, zip: "83814" })},
       ${sql.json({ ...propertyProfile, pets: "one" })}, ${sql.json(propertyProfile)},
       ${sql.json(roomPlan)}, ${["Unscented products", "Prioritize dusting"]},
       'Friendly dog named Cedar; keep exterior doors closed.',
       'Coordinate entry after the plan is reviewed.',
       'Review buildup around kitchen cabinets and primary shower glass.',
       'Extended plan · 4 rooms · focus: Kitchen, Bathrooms, Living room', 58, true)
    returning id`;
  await sql`
    insert into booking_events (booking_id, type, data)
    values (${intakeRequest.id}, 'requested', ${sql.json({ via: "dev-seed" })})`;
  const intakeTasks = [
    [null, "Confirm agreed scope before starting"],
    ["Kitchen", "Detail cabinet fronts and backsplash"],
    ["Bathrooms", "Detail primary shower glass"],
    ["Living room", "Dust reachable surfaces and shelving"],
    [null, "Complete final walkthrough"],
  ];
  for (const [sort, task] of intakeTasks.entries()) {
    await sql`
      insert into checklist_items (booking_id, room_label, label, sort, is_dev_seed)
      values (${intakeRequest.id}, ${task[0]}, ${task[1]}, ${sort}, true)`;
  }
  await sql`
    insert into internal_notes (booking_id, body, is_dev_seed)
    values (${intakeRequest.id}, 'Demo note: verify cabinet buildup and whether shower glass needs hard-water treatment.', true)`;
}

// Premium operations demo: one capacity-backed territory, one verified cleaner,
// one qualification-approved estate request, a tentative job, an application,
// and an open service case/refund review. No provider action is performed.
let [territory] = await sql`select id from service_territories where code = 'dev_cda_core'`;
if (!territory) {
  [territory] = await sql`insert into service_territories
    (code, name, status, travel_buffer_minutes, is_dev_seed)
    values ('dev_cda_core', 'Demo Coeur d''Alene Core', 'draft', 30, true) returning id`;
  await sql`insert into territory_postal_codes (territory_id, postal_code, status, evidence_note)
    values (${territory.id}, '83814', 'active', 'Synthetic preview coverage only')`;
}

let [cleaner] = await sql`select id from cleaners where email = ${CLEANER_EMAIL}`;
if (!cleaner) {
  [cleaner] = await sql`insert into cleaners
    (full_name, email, status, screening_status, screening_verified_at,
     home_territory_id, skills, vertical_experience, is_dev_seed)
    values ('Cedar Crew Preview', ${CLEANER_EMAIL}, 'active', 'verified', now(),
      ${territory.id}, ${["estate-care", "finish-awareness", "quality-review"]},
      ${["estate"]}, true) returning id`;
  const scheduleDay = await sql`select extract(dow from current_date + 5)::int as day`;
  await sql`insert into cleaner_availability_rules
    (cleaner_id, territory_id, day_of_week, start_time, end_time, status)
    values (${cleaner.id}, ${territory.id}, ${scheduleDay[0].day}, '08:00', '17:30', 'active')`;
}
await sql`update service_territories set status = 'active' where id = ${territory.id}`;

if ((await sql`select 1 from cleaner_applications where public_reference = 'TEAM-DEMO-001'`).length === 0) {
  await sql`insert into cleaner_applications
    (public_reference, full_name, email, home_base, transportation_confirmed,
     service_interests, territory_interests, availability_summary, experience_summary,
     status, consent_snapshot, consented_at, is_dev_seed)
    values ('TEAM-DEMO-001', 'Applicant Preview', 'applicant-preview@example.invalid',
      'Post Falls', true, ${["estate", "construction"]}, ${["Coeur d'Alene"]},
      'Weekdays and selected weekends', 'Synthetic premium property experience summary.',
      'reviewing', ${sql.json({ privacy: true, version: "dev-seed" })}, now(), true)`;
}

let [premiumBooking] = await sql`select id from bookings
  where customer_id = ${customer.id} and service_vertical = 'estate' and is_dev_seed`;
if (!premiumBooking) {
  [premiumBooking] = await sql`insert into bookings
    (customer_id, home_id, service_id, service_vertical, frequency, scheduled_date,
     scheduled_window, status, contact, home_details, property_profile, room_plan,
     cleaning_preferences, special_instructions, planning_direction, planning_score,
     qualification_status, estimated_duration_minutes, required_crew_size, required_skills,
     qualification_requirements, request_source, consent_snapshot, consented_at,
     consent_version, consent_notice_date, is_dev_seed)
    values (${customer.id}, ${home.id}, 'estate', 'estate', 'monthly', current_date + 5,
      'Morning', 'requested',
      ${sql.json({ name: "Devon Preview", phone: "", email: EMAIL, zip: "83814" })},
      ${sql.json({ requestedCadence: "monthly", alternateDates: [] })},
      ${sql.json({ program: "estate", context: "seasonal_home", sizeBand: "large", condition: "maintained", zoneCount: 12 })},
      ${sql.json([{ id: "property_scope", label: "Approved property scope", selected: true, note: "Seasonal arrival reset" }])},
      ${["finish-sensitive scope"]}, 'Synthetic natural-stone and millwork care note.',
      'operator call · 360 labor minutes · 1 suggested crew', 58, 'approved', 360, 1,
      ${["estate-care", "finish-awareness"]},
      ${sql.json({ siteReady: true, utilitiesReady: true, finishRestrictionsAcknowledged: true, deadlineCritical: false })},
      'import', ${sql.json({ privacy: true, requestTerms: true })}, now(), 'dev-seed',
      current_date, true) returning id`;
  await sql`insert into booking_events (booking_id, type, data)
    values (${premiumBooking.id}, 'requested', ${sql.json({ via: "dev-seed-premium" })})`;
  await sql`insert into checklist_items (booking_id, room_label, label, sort, is_dev_seed) values
    (${premiumBooking.id}, null, 'Confirm scope, access, and finish plan', 0, true),
    (${premiumBooking.id}, null, 'Complete approved estate-care scope', 1, true),
    (${premiumBooking.id}, null, 'Operator quality review', 2, true)`;
}

let [demoSchedule] = await sql`select id from job_schedules where booking_id = ${premiumBooking.id}`;
if (!demoSchedule) {
  [demoSchedule] = await sql`insert into job_schedules
    (booking_id, territory_id, service_vertical, start_at, end_at, status,
     required_crew_size, required_skills, labor_minutes, travel_buffer_minutes, is_dev_seed)
    values (${premiumBooking.id}, ${territory.id}, 'estate',
      ((current_date + 5) + time '09:00') at time zone 'America/Los_Angeles',
      ((current_date + 5) + time '15:00') at time zone 'America/Los_Angeles',
      'tentative', 1, ${["estate-care", "finish-awareness"]}, 360, 30, true) returning id`;
}

let [demoCase] = await sql`select id from service_cases where public_reference = 'LP-CASE-DEMO-001'`;
if (!demoCase) {
  [demoCase] = await sql`insert into service_cases
    (public_reference, case_type, booking_id, customer_id, contact, details, status,
     priority, consent_snapshot, consented_at, is_dev_seed)
    values ('LP-CASE-DEMO-001', 'complaint', ${premiumBooking.id}, ${customer.id},
      ${sql.json({ name: "Devon Preview", email: EMAIL })},
      'Synthetic preview: entry stone was not closed out to the agreed finish standard.',
      'triaged', 'high', ${sql.json({ privacy: true, version: "dev-seed" })}, now(), true)
    returning id`;
}
if ((await sql`select 1 from refund_records where service_case_id = ${demoCase.id}`).length === 0) {
  await sql`insert into refund_records
    (service_case_id, booking_id, amount_cents, reason_code, status, provider,
     requested_by_label, is_dev_seed)
    values (${demoCase.id}, ${premiumBooking.id}, 12500, 'scope_exception_review',
      'requested', 'manual', 'Demo operator', true)`;
}

console.log(`dev-seed ready: customer ${customer.id}; operator ${operator.id}; cleaner ${cleaner.id}`);
await sql.end();
