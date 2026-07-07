// Seeds a DEV-ONLY demo customer with bookings, billing history, home notes,
// and a support thread so the dashboard is verifiable end-to-end before Clerk
// keys exist. Everything is marked is_dev_seed=true; ops:purge-dev-seed removes it.
import { connect } from "./_db.mjs";

const sql = connect();
const EMAIL = "dev-preview@lakepinecleaning.com";

// customers has no BEFORE INSERT triggers, but keep the sibling-venture rule
// anyway: select-then-insert instead of relying on ON CONFLICT.
let [customer] = await sql`select id from customers where email = ${EMAIL}`;
if (!customer) {
  [customer] = await sql`
    insert into customers (email, full_name, phone, referral_credit_cents, is_dev_seed)
    values (${EMAIL}, 'Devon Preview', '(208) 555-0142', 2500, true)
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

const existingBookings = await sql`select 1 from bookings where customer_id = ${customer.id}`;
if (existingBookings.length === 0) {
  const contact = {
    name: "Devon Preview",
    phone: "(208) 555-0142",
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

console.log(`dev-seed ready: customer ${customer.id} (${EMAIL})`);
await sql.end();
