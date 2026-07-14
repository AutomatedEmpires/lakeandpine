// Removes every synthetic row created by ops:seed-dev in foreign-key-safe order.
import { connect } from "./_db.mjs";

const sql = connect();
const counts = {};

await sql`select set_config('lakeandpine.dev_seed_purge', '1', false)`;

counts.bonus_awards = (await sql`delete from bonus_awards where is_dev_seed returning id`).length;
counts.quality_reviews = (await sql`delete from quality_reviews where is_dev_seed returning id`).length;
counts.review_bonus_tiers = (await sql`delete from review_bonus_tiers where is_dev_seed returning id`).length;
counts.workforce_events = (await sql`delete from workforce_events where is_dev_seed returning id`).length;
counts.compensation_rates = (await sql`delete from compensation_rates where is_dev_seed returning id`).length;
counts.job_time_entries = (await sql`delete from job_time_entries where is_dev_seed returning id`).length;
counts.inventory_transactions = (await sql`delete from inventory_transactions where is_dev_seed returning id`).length;
counts.restock_requests = (await sql`delete from restock_requests where is_dev_seed returning id`).length;
counts.inventory_stock = (await sql`
  delete from inventory_stock stock using cleaning_teams team
  where stock.team_id = team.id and team.is_dev_seed returning stock.product_id`).length;
counts.inventory_products = (await sql`delete from inventory_products where is_dev_seed returning id`).length;
counts.inventory_locations = (await sql`
  delete from inventory_locations location using cleaning_teams team
  where location.team_id = team.id and team.is_dev_seed returning location.id`).length;
counts.team_job_allocations = (await sql`
  delete from team_job_allocations where is_dev_seed returning id`).length;
counts.team_service_territories = (await sql`
  delete from team_service_territories where is_dev_seed returning territory_id`).length;
await sql`update service_cases set assigned_team_id = null
  where is_dev_seed and assigned_team_id in (select id from cleaning_teams where is_dev_seed)`;
counts.workforce_memberships = (await sql`
  delete from workforce_memberships where is_dev_seed returning id`).length;

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

await sql`select set_config('lakeandpine.dev_seed_purge', '0', false)`;

console.table(counts);
await sql.end();
