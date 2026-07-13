// Removes every synthetic row created by ops:seed-dev in foreign-key-safe order.
import { connect } from "./_db.mjs";

const sql = connect();
const counts = {};

counts.operations_state_events = (await sql`delete from operations_state_events where is_dev_seed returning id`).length;
counts.service_case_events = (await sql`delete from service_case_events where is_dev_seed returning id`).length;
counts.refund_records = (await sql`delete from refund_records where is_dev_seed returning id`).length;
counts.service_recovery_actions = (await sql`delete from service_recovery_actions where is_dev_seed returning id`).length;
counts.service_cases = (await sql`delete from service_cases where is_dev_seed returning id`).length;
counts.job_assignments = (await sql`delete from job_assignments where is_dev_seed returning id`).length;
counts.job_schedules = (await sql`delete from job_schedules where is_dev_seed returning id`).length;
counts.cleaner_time_off = (await sql`
  delete from cleaner_time_off o using cleaners c
  where o.cleaner_id = c.id and c.is_dev_seed returning o.id`).length;
counts.cleaner_availability_rules = (await sql`
  delete from cleaner_availability_rules a using cleaners c
  where a.cleaner_id = c.id and c.is_dev_seed returning a.id`).length;
counts.cleaning_team_members = (await sql`
  delete from cleaning_team_members m using cleaning_teams t
  where m.team_id = t.id and t.is_dev_seed returning m.team_id`).length;
counts.cleaning_teams = (await sql`delete from cleaning_teams where is_dev_seed returning id`).length;
counts.cleaner_applications = (await sql`delete from cleaner_applications where is_dev_seed returning id`).length;
counts.cleaners = (await sql`delete from cleaners where is_dev_seed returning id`).length;
counts.notification_outbox = (await sql`
  delete from notification_outbox o using bookings b
  where o.booking_id = b.id and b.is_dev_seed returning o.id`).length;
counts.booking_events = (await sql`
  delete from booking_events e using bookings b
  where e.booking_id = b.id and b.is_dev_seed returning e.id`).length;
counts.billing_records = (await sql`delete from billing_records where is_dev_seed returning id`).length;
counts.support_messages = (await sql`delete from support_messages where is_dev_seed returning id`).length;
counts.bookings = (await sql`delete from bookings where is_dev_seed returning id`).length;
counts.territory_postal_codes = (await sql`
  delete from territory_postal_codes p using service_territories t
  where p.territory_id = t.id and t.is_dev_seed returning p.territory_id`).length;
counts.service_territories = (await sql`delete from service_territories where is_dev_seed returning id`).length;
counts.quotes = (await sql`delete from quotes where is_dev_seed returning id`).length;
counts.leads = (await sql`delete from leads where is_dev_seed returning id`).length;
counts.homes = (await sql`delete from homes where is_dev_seed returning id`).length;
counts.customers = (await sql`delete from customers where is_dev_seed returning id`).length;
counts.reviews = (await sql`delete from reviews where is_dev_seed returning id`).length;

console.table(counts);
await sql.end();
