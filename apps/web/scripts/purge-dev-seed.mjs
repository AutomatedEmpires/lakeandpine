// Removes EVERY row marked is_dev_seed (demo customers, bookings, billing,
// support, placeholder reviews). Run before launch. FK-safe order.
import { connect } from "./_db.mjs";

const sql = connect();

const counts = {};
counts.booking_events = (await sql`
  delete from booking_events using bookings
  where booking_events.booking_id = bookings.id and bookings.is_dev_seed
  returning booking_events.id`).length;
counts.billing_records = (await sql`delete from billing_records where is_dev_seed returning id`).length;
counts.support_messages = (await sql`delete from support_messages where is_dev_seed returning id`).length;
counts.bookings = (await sql`delete from bookings where is_dev_seed returning id`).length;
counts.quotes = (await sql`delete from quotes where is_dev_seed returning id`).length;
counts.leads = (await sql`delete from leads where is_dev_seed returning id`).length;
counts.homes = (await sql`delete from homes where is_dev_seed returning id`).length;
counts.customers = (await sql`delete from customers where is_dev_seed returning id`).length;
counts.reviews = (await sql`delete from reviews where is_dev_seed returning id`).length;

console.table(counts);
await sql.end();
