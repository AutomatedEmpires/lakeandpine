-- Guest booking management grants -------------------------------------------
--
-- The public booking reference is display-only. Guest self-service authority
-- is a separate, opaque token whose digest is stored here. Tokens expire and
-- can be revoked or rotated without changing the booking reference.

create table guest_booking_management_grants (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  token_digest text not null unique
    check (token_digest ~ '^[0-9a-f]{64}$'),
  reservation_request_hash text not null
    check (reservation_request_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'active'
    check (status in ('active', 'rotated', 'revoked', 'expired')),
  expires_at timestamptz not null,
  rotated_from_id uuid references guest_booking_management_grants(id),
  last_used_at timestamptz,
  revoked_at timestamptz,
  is_dev_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > created_at),
  check ((status = 'revoked') = (revoked_at is not null))
);

create unique index guest_booking_management_grants_one_active_idx
  on guest_booking_management_grants (booking_id)
  where status = 'active';
create index guest_booking_management_grants_expiration_idx
  on guest_booking_management_grants (expires_at)
  where status = 'active';
create index guest_booking_management_grants_rotated_from_idx
  on guest_booking_management_grants (rotated_from_id);

comment on table guest_booking_management_grants is
  'Revocable guest self-service authority. Raw tokens and public booking references are never stored here.';
comment on column guest_booking_management_grants.reservation_request_hash is
  'Server digest binding an idempotency key to one reservation payload.';

alter table guest_booking_management_grants enable row level security;
revoke all on guest_booking_management_grants from public;
grant select, insert, update, delete on guest_booking_management_grants to lakeandpine_app;

create policy lakeandpine_app_all_guest_booking_management_grants
  on guest_booking_management_grants for all to lakeandpine_app
  using (true) with check (true);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on guest_booking_management_grants from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on guest_booking_management_grants from authenticated;
  end if;
end
$$;
