-- Forward-only production hardening after the premium operations release.
-- Keep public catalog reads available to Supabase browser clients while avoiding
-- redundant permissive-policy evaluation for the server-only application role.

alter function public.normalize_us_postal_code(text)
  set search_path = pg_catalog;

drop policy if exists app_all_billing_records on public.billing_records;
drop policy if exists app_all_booking_events on public.booking_events;
drop policy if exists app_all_bookings on public.bookings;
drop policy if exists app_all_customers on public.customers;
drop policy if exists app_all_homes on public.homes;
drop policy if exists app_all_leads on public.leads;
drop policy if exists app_all_quotes on public.quotes;
drop policy if exists app_all_support_messages on public.support_messages;

do $$
declare
  public_catalog_policy record;
begin
  -- Hosted Supabase projects always provide both roles. The conditional keeps the
  -- portable PostgreSQL verifier compatible without creating provider-owned roles.
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on table
      public.addons,
      public.faqs,
      public.plans,
      public.reviews,
      public.service_areas,
      public.services
    to anon, authenticated;

    for public_catalog_policy in
      select *
      from (values
        ('addons', 'addons_public_read'),
        ('faqs', 'faqs_public_read'),
        ('plans', 'plans_public_read'),
        ('reviews', 'reviews_public_read'),
        ('service_areas', 'service_areas_public_read'),
        ('services', 'services_public_read')
      ) as policies(table_name, policy_name)
    loop
      execute format(
        'alter policy %I on public.%I to anon, authenticated',
        public_catalog_policy.policy_name,
        public_catalog_policy.table_name
      );
    end loop;
  end if;
end
$$;

-- Cover every foreign key reported by the production performance advisor. These
-- indexes support schedule, case, refund, and outbox joins and reduce lock-scan cost
-- when parent records are updated or removed.
create index billing_records_booking_idx
  on public.billing_records (booking_id);
create index bookings_home_idx
  on public.bookings (home_id);
create index bookings_quote_idx
  on public.bookings (quote_id);
create index bookings_service_idx
  on public.bookings (service_id);
create index checklist_room_idx
  on public.checklist_items (room_id);
create index cleaner_availability_territory_idx
  on public.cleaner_availability_rules (territory_id);
create index cleaners_home_territory_idx
  on public.cleaners (home_territory_id);
create index job_assignments_team_idx
  on public.job_assignments (team_id);
create index leads_service_idx
  on public.leads (service_id);
create index notification_outbox_booking_idx
  on public.notification_outbox (booking_id);
create index notification_outbox_customer_idx
  on public.notification_outbox (customer_id);
create index notification_outbox_case_idx
  on public.notification_outbox (service_case_id);
create index operations_state_case_idx
  on public.operations_state_events (service_case_id);
create index quotes_customer_idx
  on public.quotes (customer_id);
create index quotes_service_idx
  on public.quotes (service_id);
create index refund_records_billing_idx
  on public.refund_records (billing_record_id);
create index service_cases_assigned_cleaner_idx
  on public.service_cases (assigned_cleaner_id);
create index service_cases_assigned_team_idx
  on public.service_cases (assigned_team_id);
create index service_cases_customer_idx
  on public.service_cases (customer_id);
create index service_recovery_booking_idx
  on public.service_recovery_actions (booking_id);
