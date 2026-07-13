# Disposable database migration verification

`pnpm quality:verify-migrations` is the required schema and authorization gate for every
pull request. It proves the repository migration chain against a fresh PostgreSQL 17
database; it does not connect to Supabase or any production environment.

## What the gate proves

The verifier:

1. refuses any non-loopback host and any database name that does not contain `ci`, `test`,
   `proof`, or `disposable`;
2. refuses a database that already contains public tables;
3. bootstraps as the distinct `supabase_admin` superuser, creates a production-shaped
   non-superuser `postgres` owner, and applies the complete migration chain through that
   owner. It seeds the exact `supabase_admin`-granted `lakeandpine_app` membership, proves
   the migration adds a separate effective `postgres` `SET TRUE` / `INHERIT FALSE` row,
   exercises absent-role creation under the same hosted boundary, and proves the role
   guard rejects unsafe memberships, grantees, inheritance, and owned relations;
4. applies every `supabase/migrations/*.sql` file in filename order, with one transaction
   per file and a SHA-256 record of the canonical LF-normalized SQL applied; repository
   attributes enforce LF for migration files, the verifier normalizes an existing Windows
   CRLF checkout, and unsupported standalone carriage returns fail the gate;
5. fails if the current booking spine is incomplete: `bookings`, `checklist_items`,
   `internal_notes`, and `follow_ups`, including their critical columns, must exist;
6. discovers every public table other than the explicit content catalog (`services`,
   `addons`, `plans`, `service_areas`, `faqs`, and `reviews`) as a private operational
   table. New cleaner, capacity, schedule, complaint, refund, or assignment tables are
   therefore covered automatically;
7. requires RLS, explicit `lakeandpine_app` CRUD grants, role-targeted CRUD/`ALL` policies,
   identity-sequence `USAGE`, an explicit `SET ROLE` read probe, and a second physical
   Postgres.js connection whose startup `role` parameter must report `current_user =
   lakeandpine_app` while reading every private table;
8. fails if `lakeandpine_app` owns an operational table, gains a privileged attribute,
   inherits another role, is granted to an unexpected member, lacks an effective
   non-inheriting `postgres` SET grant, or if `PUBLIC` receives a table grant; and
9. detects atomic-intake functions by a `create*booking` / `booking*create` name or an
   `atomic intake` function comment. A detected function must be `SECURITY INVOKER`, be
   executable by `lakeandpine_app`, and not be executable by `PUBLIC`.

Function privilege and isolation are checked here. Request/quote/booking/event/checklist
atomicity remains an end-to-end responsibility of the non-production runtime smoke. If a
future function does not match the naming convention, add an `atomic intake` comment to
the function so the verifier discovers it without coupling CI to a single signature.

## Run locally

Create a new disposable database. The verifier never drops objects, never cleans an
existing database, and never falls back to `DATABASE_URL` or `.env.local`.

```bash
docker run --rm --name lakeandpine-migration-test \
  -e POSTGRES_USER=supabase_admin \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=lakeandpine_test \
  -p 55442:5432 \
  -d postgres:17-alpine

MIGRATION_DATABASE_URL=postgresql://supabase_admin:postgres@127.0.0.1:55442/lakeandpine_test \
  pnpm quality:verify-migrations

docker stop lakeandpine-migration-test
```

Use a newly created database for another run. A refusal caused by existing public tables
is a safety feature, not a cleanup request.

## CI behavior

The `validate` job starts `postgres:17-alpine` with a `supabase_admin` bootstrap role.
The verifier creates the production-shaped non-superuser `postgres` migration owner and
runs the full chain through that role after the frozen dependency install and whitespace
check. The job then runs
unit tests, lint, typecheck, and the optimized build. No provider key, customer record,
email delivery, auth identity, payment, DNS setting, or production data is involved.

## Failure ownership

- Migration syntax/order failures belong in a new forward migration; never edit an
  already-applied production migration merely to make CI green.
- Missing grants, policies, or sequence access must be fixed in migration SQL. Do not
  weaken the verifier or give `lakeandpine_app` table ownership/BYPASSRLS.
- A missing critical table or column means the application and migration chain disagree.
  Reconcile them before deployment.
- A detected atomic intake function with `PUBLIC` execution or `SECURITY DEFINER` is a
  privilege boundary failure. Revoke `PUBLIC`, grant only the application role, and keep
  the function invoker-secured unless a separately reviewed design proves otherwise.

The relevant current guidance is the
[Supabase RLS documentation](https://supabase.com/docs/guides/database/postgres/row-level-security)
and [PostgreSQL privilege model](https://www.postgresql.org/docs/17/ddl-priv.html). New
tables in an exposed schema still require explicit grants and RLS; the gate validates the
server-side application role separately from Data API exposure.
