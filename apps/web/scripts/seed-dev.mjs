// Seeds a DEV-ONLY demo customer with bookings, billing history, home notes,
// and a support thread so the dashboard is verifiable end-to-end before Clerk
// keys exist. Everything is marked is_dev_seed=true; ops:purge-dev-seed removes it.
import { connect } from "./_db.mjs";

const sql = connect();
const EMAIL = "dev-preview@lakeandpinecleaning.com";
const OPERATOR_EMAIL = "operator-preview@lakeandpinecleaning.com";

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

console.log(`dev-seed ready: customer ${customer.id} (${EMAIL}); operator ${operator.id} (${OPERATOR_EMAIL})`);
await sql.end();
