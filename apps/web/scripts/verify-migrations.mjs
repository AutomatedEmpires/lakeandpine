// Applies every repository migration to a fresh, disposable PostgreSQL 17 database,
// then proves that the server-side application role can reach private operations
// tables without owning them or bypassing row-level security.
//
// This script intentionally refuses remote hosts and database names that do not
// identify an isolated test target. It never reads DATABASE_URL or .env.local.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const APP_ROLE = "lakeandpine_app";
const REQUIRED_POSTGRES_MAJOR = 17;
const SAFE_DATABASE_NAME = /(ci|test|proof|disposable)/i;
const SAFE_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const REQUIRED_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const PUBLIC_CONTENT_TABLES = new Set([
  "services",
  "addons",
  "plans",
  "service_areas",
  "faqs",
  "reviews",
]);
const REQUIRED_SCHEMA = {
  bookings: [
    "id",
    "status",
    "scheduled_date",
    "scheduled_window",
    "contact",
    "property_profile",
    "room_plan",
    "planning_score",
    "contact_status",
  ],
  checklist_items: ["id", "booking_id", "label", "state"],
  internal_notes: ["id", "booking_id", "body"],
  follow_ups: ["id", "booking_id", "kind", "channel", "status"],
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function validateTarget(rawUrl) {
  invariant(
    rawUrl,
    "MIGRATION_DATABASE_URL is required and must point to a fresh, disposable local database",
  );

  const target = new URL(rawUrl);
  invariant(
    target.protocol === "postgres:" || target.protocol === "postgresql:",
    "MIGRATION_DATABASE_URL must use postgres:// or postgresql://",
  );
  invariant(
    SAFE_HOSTS.has(target.hostname),
    `Migration verification refuses non-local database host ${target.hostname}`,
  );

  const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
  invariant(database && SAFE_DATABASE_NAME.test(database),
    "Disposable database name must contain ci, test, proof, or disposable");

  return { target, database };
}

async function loadMigrations() {
  const migrationsDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations",
  );
  const names = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right, "en"));

  invariant(names.length > 0, `No SQL migrations found in ${migrationsDirectory}`);
  invariant(new Set(names).size === names.length, "Migration filenames must be unique");

  return Promise.all(names.map(async (name) => {
    const source = await readFile(resolve(migrationsDirectory, name), "utf8");
    invariant(source.trim().length > 0, `Migration ${name} is empty`);
    return {
      name,
      source,
      sha256: createHash("sha256").update(source).digest("hex"),
    };
  }));
}

async function readRole(sql) {
  const [role] = await sql`
    select rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin,
      rolreplication, rolbypassrls
    from pg_roles
    where rolname = ${APP_ROLE}`;
  return role;
}

async function assertSafeRole(sql, expectRuntimeGrant = false) {
  const role = await readRole(sql);
  invariant(role, `${APP_ROLE} was not created`);
  invariant(!role.rolsuper, `${APP_ROLE} must not be a superuser`);
  invariant(!role.rolcreaterole, `${APP_ROLE} must not have CREATEROLE`);
  invariant(!role.rolcreatedb, `${APP_ROLE} must not have CREATEDB`);
  invariant(role.rolcanlogin, `${APP_ROLE} must retain the production-compatible LOGIN attribute`);
  invariant(!role.rolreplication, `${APP_ROLE} must not have REPLICATION`);
  invariant(!role.rolbypassrls, `${APP_ROLE} must not have BYPASSRLS`);

  const memberships = await sql`
    select granted.rolname as granted_role, member.rolname as member_role,
      membership.admin_option, membership.inherit_option, membership.set_option
    from pg_auth_members membership
    join pg_roles granted on granted.oid = membership.roleid
    join pg_roles member on member.oid = membership.member
    where granted.rolname = ${APP_ROLE} or member.rolname = ${APP_ROLE}`;
  if (expectRuntimeGrant) {
    const grantsToConnectionOwner = memberships.filter(
      (membership) =>
        membership.granted_role === APP_ROLE &&
        membership.member_role === "postgres",
    );
    invariant(
      grantsToConnectionOwner.length > 0 &&
        grantsToConnectionOwner.every((membership) => !membership.inherit_option) &&
        grantsToConnectionOwner.some((membership) => membership.set_option) &&
        memberships.every(
          (membership) =>
            membership.granted_role === APP_ROLE &&
            membership.member_role === "postgres",
        ),
      `${APP_ROLE} must have effective SET TRUE/INHERIT FALSE access only from postgres and inherit no other role`,
    );
  } else {
    invariant(
      memberships.length === 0,
      `${APP_ROLE} must start without role memberships before migrations`,
    );
  }
}

async function seedProductionLikeApplicationRole(sql) {
  const existing = await readRole(sql);
  if (!existing) {
    await sql.unsafe(
      `create role ${quoteIdentifier(APP_ROLE)} inherit login nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
    );
  }
  // Reproduce production's separate grantor row. The migration runs as
  // postgres and must add an effective SET path without assuming it owns or can
  // rewrite a supabase_admin-style grant made by another grantor.
  await sql.unsafe('create role lakeandpine_verifier_grantor superuser nologin');
  await sql.unsafe('set role lakeandpine_verifier_grantor');
  try {
    await sql.unsafe(
      `grant ${quoteIdentifier(APP_ROLE)} to postgres with admin true, inherit false, set false`,
    );
  } finally {
    await sql.unsafe('reset role');
  }
}

async function inspectHostedRoleDdlCompatibility(
  sql,
  migrations,
  expectApplicationRole,
) {
  const startMarker = "-- hosted-role-compatibility:start";
  const endMarker = "-- hosted-role-compatibility:end";
  const candidates = migrations.filter(
    ({ source }) => source.includes(startMarker) || source.includes(endMarker),
  );
  invariant(
    candidates.length === 1 &&
      candidates[0].source.includes(startMarker) &&
      candidates[0].source.includes(endMarker),
    "Exactly one migration must contain the hosted role-compatibility block",
  );
  const source = candidates[0].source;
  const start = source.indexOf(startMarker) + startMarker.length;
  const end = source.indexOf(endMarker, start);
  invariant(end > start, "Hosted role-compatibility markers are malformed");
  const roleDdl = source.slice(start, end);
  const runner = "lakeandpine_migration_runner";

  invariant(
    Boolean(await readRole(sql)) === expectApplicationRole,
    expectApplicationRole
      ? "Existing-role compatibility probe requires lakeandpine_app"
      : "Role-creation compatibility probe requires lakeandpine_app to be absent",
  );

  // SET ROLE drops the disposable bootstrap superuser's effective privileges,
  // reproducing Supabase's CREATEROLE + ADMIN OPTION boundary without trying
  // to demote PostgreSQL's protected bootstrap role.
  await sql.unsafe(
    `create role ${quoteIdentifier(runner)} nologin nosuperuser createrole createdb noinherit noreplication nobypassrls`,
  );
  if (expectApplicationRole) {
    await sql.unsafe(
      `grant ${quoteIdentifier(APP_ROLE)} to ${quoteIdentifier(runner)} with admin true, inherit false, set false`,
    );
  }
  try {
    await sql.unsafe(`set role ${quoteIdentifier(runner)}`);
    try {
      await sql.unsafe(roleDdl);
    } finally {
      await sql.unsafe("reset role");
    }
  } finally {
    if (await readRole(sql)) {
      await sql.unsafe(
        `revoke ${quoteIdentifier(APP_ROLE)} from ${quoteIdentifier(runner)}`,
      );
      if (!expectApplicationRole) {
        await sql.unsafe(`drop role ${quoteIdentifier(APP_ROLE)}`);
      }
    }
    await sql.unsafe(`drop role ${quoteIdentifier(runner)}`);
  }
}

async function applyMigrations(sql, migrations) {
  await sql`create schema migration_verification`;
  await sql`
    create table migration_verification.applied_migrations (
      filename text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )`;

  for (const migration of migrations) {
    try {
      await sql.begin(async (transaction) => {
        await transaction.unsafe(migration.source);
        await transaction`
          insert into migration_verification.applied_migrations (filename, sha256)
          values (${migration.name}, ${migration.sha256})`;
      });
      console.log(`applied ${migration.name}`);
    } catch (error) {
      throw new Error(`Migration ${migration.name} failed: ${error.message}`, { cause: error });
    }
  }
}

async function inspectApplicationRoleAccess(sql) {
  const failures = [];
  const tableRows = await sql`
    select table_class.relname as table_name,
      table_class.relrowsecurity as rls_enabled,
      pg_get_userbyid(table_class.relowner) as owner
    from pg_class table_class
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relkind in ('r', 'p')
    order by table_class.relname`;
  const tableByName = new Map(tableRows.map((row) => [row.table_name, row]));

  const columns = await sql`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'`;
  const columnsByTable = new Map();
  for (const column of columns) {
    const names = columnsByTable.get(column.table_name) || new Set();
    names.add(column.column_name);
    columnsByTable.set(column.table_name, names);
  }

  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA)) {
    if (!tableByName.has(table)) {
      failures.push(`critical table public.${table} is missing`);
      continue;
    }
    for (const column of requiredColumns) {
      if (!columnsByTable.get(table)?.has(column)) {
        failures.push(`critical column public.${table}.${column} is missing`);
      }
    }
  }

  const operationsTables = tableRows
    .filter((table) => !PUBLIC_CONTENT_TABLES.has(table.table_name));
  invariant(operationsTables.length > 0, "No private operational tables were discovered");

  const [schemaAccess] = await sql`
    select has_schema_privilege(${APP_ROLE}, 'public', 'USAGE') as allowed`;
  if (!schemaAccess.allowed) failures.push(`${APP_ROLE} lacks USAGE on schema public`);

  for (const table of operationsTables) {
    if (!table.rls_enabled) failures.push(`public.${table.table_name} does not have RLS enabled`);
    if (table.owner === APP_ROLE) {
      failures.push(`public.${table.table_name} is owned by ${APP_ROLE}, which would bypass RLS`);
    }

    const missingPrivileges = [];
    for (const privilege of REQUIRED_PRIVILEGES) {
      const [access] = await sql`
        select has_table_privilege(
          ${APP_ROLE}, ${`public.${table.table_name}`}, ${privilege}
        ) as allowed`;
      if (!access.allowed) missingPrivileges.push(privilege);
    }
    if (missingPrivileges.length > 0) {
      failures.push(
        `${APP_ROLE} lacks ${missingPrivileges.join("/")} on public.${table.table_name}`,
      );
    }
  }

  const publicGrants = await sql`
    select table_name, privilege_type
    from information_schema.table_privileges
    where table_schema = 'public' and grantee = 'PUBLIC'`;
  const operationsNames = new Set(operationsTables.map((table) => table.table_name));
  for (const grant of publicGrants) {
    if (operationsNames.has(grant.table_name)) {
      failures.push(`PUBLIC has ${grant.privilege_type} on private table public.${grant.table_name}`);
    }
  }

  const policies = await sql`
    select tablename, policyname, cmd, roles::text[] as roles, qual, with_check
    from pg_policies
    where schemaname = 'public'`;
  for (const table of operationsTables) {
    const rolePolicies = policies.filter((policy) =>
      policy.tablename === table.table_name && policy.roles.includes(APP_ROLE));
    const missingPolicyCommands = [];
    for (const command of REQUIRED_PRIVILEGES) {
      const matching = rolePolicies.filter((policy) =>
        policy.cmd === "ALL" || policy.cmd === command);
      if (matching.length === 0) {
        missingPolicyCommands.push(command);
        continue;
      }
      if (command === "INSERT" && !matching.some((policy) => policy.with_check)) {
        failures.push(`public.${table.table_name} INSERT policy lacks WITH CHECK`);
      }
      if (command !== "INSERT" && !matching.some((policy) => policy.qual)) {
        failures.push(`public.${table.table_name} ${command} policy lacks USING`);
      }
    }
    if (missingPolicyCommands.length > 0) {
      failures.push(
        `public.${table.table_name} lacks ${missingPolicyCommands.join("/")}/ALL RLS policy coverage for ${APP_ROLE}`,
      );
    }
  }

  const identitySequences = await sql`
    select columns.table_name, columns.column_name,
      pg_get_serial_sequence(
        format('%I.%I', columns.table_schema, columns.table_name),
        columns.column_name
      ) as sequence_name
    from information_schema.columns
    where columns.table_schema = 'public' and columns.is_identity = 'YES'`;
  for (const identity of identitySequences) {
    if (!operationsNames.has(identity.table_name) || !identity.sequence_name) continue;
    const [sequenceAccess] = await sql`
      select has_sequence_privilege(
        ${APP_ROLE}, ${identity.sequence_name}, 'USAGE'
      ) as allowed`;
    if (!sequenceAccess.allowed) {
      failures.push(
        `${APP_ROLE} lacks USAGE on ${identity.sequence_name} for public.${identity.table_name}.${identity.column_name}`,
      );
    }
  }

  if (failures.length === 0) {
    await sql.begin(async (transaction) => {
      await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
      for (const table of operationsTables) {
        await transaction.unsafe(
          `select * from public.${quoteIdentifier(table.table_name)} limit 0`,
        );
      }
    });
  }

  return { failures, operationsTables: operationsTables.map((table) => table.table_name) };
}

async function inspectAtomicIntakeFunctions(sql) {
  const functions = await sql`
    select namespace.nspname as schema_name,
      procedure.proname as function_name,
      procedure.oid::regprocedure::text as signature,
      procedure.prosecdef as security_definer,
      has_schema_privilege(${APP_ROLE}, namespace.nspname, 'USAGE') as app_schema_usage,
      has_function_privilege(${APP_ROLE}, procedure.oid, 'EXECUTE') as app_execute,
      exists (
        select 1
        from aclexplode(coalesce(
          procedure.proacl,
          acldefault('f', procedure.proowner)
        )) as function_acl
        where function_acl.grantee = 0
          and function_acl.privilege_type = 'EXECUTE'
      ) as public_execute
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname not in ('pg_catalog', 'information_schema')
      and (
        procedure.proname ~* '(atomic.*intake|intake.*atomic|create.*booking|booking.*create)'
        or coalesce(obj_description(procedure.oid, 'pg_proc'), '') ~* 'atomic intake'
      )
    order by namespace.nspname, procedure.proname`;

  const failures = [];
  for (const candidate of functions) {
    if (candidate.security_definer) {
      failures.push(`${candidate.signature} must remain SECURITY INVOKER`);
    }
    if (!candidate.app_schema_usage) {
      failures.push(`${APP_ROLE} lacks USAGE on schema ${candidate.schema_name}`);
    }
    if (!candidate.app_execute) {
      failures.push(`${APP_ROLE} lacks EXECUTE on ${candidate.signature}`);
    }
    if (candidate.public_execute) {
      failures.push(`PUBLIC must not have EXECUTE on ${candidate.signature}`);
    }
  }

  return { failures, functions };
}

async function inspectRuntimeConnection(rawUrl, operationsTables) {
  const runtimeSql = postgres(rawUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    connection: {
      application_name: "lakeandpine_migration_verifier",
      role: APP_ROLE,
    },
  });
  try {
    const [identity] = await runtimeSql`
      select current_user, session_user,
        current_setting('application_name') as application_name`;
    invariant(
      identity.current_user === APP_ROLE,
      `Runtime startup role is ${identity.current_user}; expected ${APP_ROLE}`,
    );
    invariant(
      identity.session_user === "postgres",
      `Runtime session user is ${identity.session_user}; expected postgres`,
    );
    for (const table of operationsTables) {
      await runtimeSql.unsafe(
        `select * from public.${quoteIdentifier(table)} limit 0`,
      );
    }
    return identity;
  } finally {
    await runtimeSql.end({ timeout: 5 });
  }
}

async function expectDatabaseError(transaction, allowedCodes, label, operation) {
  let caught;
  try {
    await transaction.savepoint(operation);
  } catch (error) {
    caught = error;
  }
  invariant(caught, `${label} was accepted but must be rejected by the database`);
  invariant(
    allowedCodes.includes(caught.code),
    `${label} failed with ${caught.code || caught.message}; expected ${allowedCodes.join(" or ")}`,
  );
}

async function inspectOperationalInvariants(sql) {
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    const [territory] = await transaction`
      insert into service_territories
        (code, name, timezone, status, travel_buffer_minutes, is_dev_seed)
      values ('verifier', 'Verifier territory', 'America/Los_Angeles', 'draft', 30, true)
      returning id`;
    await expectDatabaseError(transaction, ['23514'], 'territory activation without postal capacity', async (savepoint) => {
      await savepoint`update service_territories set status = 'active' where id = ${territory.id}`;
    });
    await transaction`
      insert into territory_postal_codes (territory_id, postal_code, status)
      values (${territory.id}, '83814', 'active')`;
    await expectDatabaseError(transaction, ['23514'], 'malformed territory postal code', async (savepoint) => {
      await savepoint`
        insert into territory_postal_codes (territory_id, postal_code, status)
        values (${territory.id}, 'ABCDE', 'active')`;
    });
    const cleaners = await transaction`
      insert into cleaners
        (full_name, email, status, screening_status, screening_verified_at,
         home_territory_id, skills, vertical_experience, max_daily_minutes,
         max_weekly_minutes, max_daily_jobs, is_dev_seed)
      values
        ('Verifier One', 'one@verify.invalid', 'active', 'verified', now(),
          ${territory.id}, array['estate_detail'], array['estate'], 600, 2400, 3, true),
        ('Verifier Two', 'two@verify.invalid', 'active', 'verified', now(),
          ${territory.id}, array['delicate_finishes'], array['estate'], 600, 2400, 3, true),
        ('Verifier Capped', 'cap@verify.invalid', 'active', 'verified', now(),
          ${territory.id}, array['estate_detail'], array['estate'], 240, 240, 1, true),
        ('Verifier Overflow', 'overflow@verify.invalid', 'active', 'verified', now(),
          ${territory.id}, array['estate_detail'], array['estate'], 600, 2400, 3, true)
      returning id, email`;
    const cleanerByEmail = new Map(cleaners.map((cleaner) => [cleaner.email, cleaner.id]));
    const cleanerOne = cleanerByEmail.get('one@verify.invalid');
    const cleanerTwo = cleanerByEmail.get('two@verify.invalid');
    const cappedCleaner = cleanerByEmail.get('cap@verify.invalid');
    const overflowCleaner = cleanerByEmail.get('overflow@verify.invalid');

    const startAt = '2030-07-15T16:00:00.000Z';
    const endAt = '2030-07-15T21:00:00.000Z';
    await expectDatabaseError(transaction, ['23514'], 'territory activation without available cleaner capacity', async (savepoint) => {
      await savepoint`update service_territories set status = 'active' where id = ${territory.id}`;
    });
    for (const cleanerId of [cleanerOne, cappedCleaner, overflowCleaner]) {
      await transaction`
        insert into cleaner_availability_rules
          (cleaner_id, territory_id, day_of_week, start_time, end_time, effective_from, status)
        values (${cleanerId}, ${territory.id},
          extract(dow from ${startAt}::timestamptz at time zone 'America/Los_Angeles')::integer,
          '08:00', '18:00', '2030-01-01', 'active')`;
    }
    await transaction`update service_territories set status = 'active' where id = ${territory.id}`;
    await expectDatabaseError(transaction, ['23514'], 'last active territory postal removal', async (savepoint) => {
      await savepoint`
        update territory_postal_codes set status = 'excluded'
        where territory_id = ${territory.id} and postal_code = '83814'`;
    });

    const [mismatchedBooking] = await transaction`
      insert into bookings
        (service_id, scheduled_date, scheduled_window, status, contact, is_dev_seed,
         service_vertical, territory_id, qualification_status,
         estimated_duration_minutes, required_crew_size, required_skills)
      values ('estate', '2030-07-15', 'Preference only', 'requested',
        ${transaction.json({ name: 'Outside territory', email: 'outside@invalid.test', zip: '99999' })},
        true, 'estate', ${territory.id}, 'approved', 300, 1, array['estate_detail'])
      returning id`;
    await expectDatabaseError(transaction, ['23514'], 'schedule outside active territory postal codes', async (savepoint) => {
      await savepoint`
        insert into job_schedules
          (booking_id, territory_id, service_vertical, start_at, end_at, required_crew_size,
           required_skills, labor_minutes, is_dev_seed)
        values (${mismatchedBooking.id}, ${territory.id}, 'estate', ${startAt}, ${endAt}, 1,
          array['estate_detail'], 300, true)`;
    });

    const [booking] = await transaction`
      insert into bookings
        (service_id, scheduled_date, scheduled_window, status, contact, is_dev_seed,
         service_vertical, territory_id, qualification_status,
         estimated_duration_minutes, required_crew_size, required_skills)
      values ('estate', '2030-07-15', 'Preference only', 'requested',
        ${transaction.json({ name: 'Verifier', email: 'verify@invalid.test', zip: '83814' })},
        true, 'estate', ${territory.id}, 'approved', 600, 2,
        array['estate_detail', 'delicate_finishes'])
      returning id`;
    await expectDatabaseError(transaction, ['23514'], 'unlinked booking-mutating service case', async (savepoint) => {
      await savepoint`
        insert into service_cases
          (public_reference, case_type, contact, details, status, is_dev_seed)
        values ('LP-VERIFY-UNLINKED-1', 'cancel', '{}',
          'Unlinked cancellation must not be accepted.', 'submitted', true)`;
    });

    await expectDatabaseError(transaction, ['23514'], 'undersized labor window', async (savepoint) => {
      await savepoint`
        insert into job_schedules
          (booking_id, territory_id, service_vertical, start_at, end_at, required_crew_size,
           required_skills, labor_minutes, is_dev_seed)
        values (${booking.id}, ${territory.id}, 'estate', ${startAt},
          '2030-07-15T18:00:00.000Z', 2,
          array['estate_detail', 'delicate_finishes'], 600, true)`;
    });

    const [schedule] = await transaction`
      insert into job_schedules
        (booking_id, territory_id, service_vertical, start_at, end_at, required_crew_size,
         required_skills, labor_minutes, is_dev_seed)
      values (${booking.id}, ${territory.id}, 'estate', ${startAt}, ${endAt}, 2,
        array['estate_detail', 'delicate_finishes'], 600, true)
      returning id`;

    await expectDatabaseError(transaction, ['23514'], 'booking-only schedule transition', async (savepoint) => {
      await savepoint`update bookings set status = 'scheduled' where id = ${booking.id}`;
    });

    const [assignmentOne] = await transaction`
      insert into job_assignments
        (job_schedule_id, cleaner_id, assignment_role, status, is_dev_seed)
      values (${schedule.id}, ${cleanerOne}, 'lead', 'accepted', true)
      returning id`;

    await expectDatabaseError(transaction, ['23514'], 'assignment outside recurring availability', async (savepoint) => {
      await savepoint`
        insert into job_assignments
          (job_schedule_id, cleaner_id, assignment_role, status, is_dev_seed)
        values (${schedule.id}, ${cleanerTwo}, 'member', 'accepted', true)`;
    });
    await transaction`
      insert into cleaner_availability_rules
        (cleaner_id, territory_id, day_of_week, start_time, end_time, effective_from, status)
      values (${cleanerTwo}, ${territory.id},
        extract(dow from ${startAt}::timestamptz at time zone 'America/Los_Angeles')::integer,
        '08:00', '18:00', '2030-01-01', 'active')`;
    await transaction`
      insert into job_assignments
        (job_schedule_id, cleaner_id, assignment_role, status, is_dev_seed)
      values (${schedule.id}, ${cleanerTwo}, 'member', 'accepted', true)`;

    const [timeOff] = await transaction`
      insert into cleaner_time_off
        (cleaner_id, start_at, end_at, status, is_dev_seed)
      values (${cleanerOne}, ${startAt}, ${endAt}, 'requested', true)
      returning id`;
    await expectDatabaseError(transaction, ['23P01'], 'time-off approval over accepted work', async (savepoint) => {
      await savepoint`update cleaner_time_off set status = 'approved' where id = ${timeOff.id}`;
    });

    const [capacityBooking] = await transaction`
      insert into bookings
        (service_id, scheduled_date, scheduled_window, status, contact, is_dev_seed,
         service_vertical, territory_id, qualification_status,
         estimated_duration_minutes, required_crew_size, required_skills)
      values ('estate', '2030-07-15', 'Preference only', 'requested',
        ${transaction.json({ name: 'Capacity verifier', email: 'capacity@invalid.test', zip: '83814' })},
        true, 'estate', ${territory.id}, 'approved', 300, 1, array['estate_detail'])
      returning id`;
    const [capacitySchedule] = await transaction`
      insert into job_schedules
        (booking_id, territory_id, service_vertical, start_at, end_at, required_crew_size,
         required_skills, labor_minutes, is_dev_seed)
      values (${capacityBooking.id}, ${territory.id}, 'estate', ${startAt}, ${endAt}, 1,
        array['estate_detail'], 300, true)
      returning id`;
    await expectDatabaseError(transaction, ['23514'], 'daily and weekly cleaner cap', async (savepoint) => {
      await savepoint`
        insert into job_assignments
          (job_schedule_id, cleaner_id, assignment_role, status, is_dev_seed)
        values (${capacitySchedule.id}, ${cappedCleaner}, 'lead', 'accepted', true)`;
    });
    const [removableAssignment] = await transaction`
      insert into job_assignments
        (job_schedule_id, cleaner_id, assignment_role, status, is_dev_seed)
      values (${capacitySchedule.id}, ${overflowCleaner}, 'lead', 'accepted', true)
      returning id`;
    await transaction`
      update job_assignments set status = 'removed', responded_at = now()
      where id = ${removableAssignment.id}`;
    const [removedAssignment] = await transaction`
      select status from job_assignments where id = ${removableAssignment.id}`;
    invariant(
      removedAssignment.status === 'removed',
      'Accepted assignment could not be removed from a tentative schedule',
    );

    await transaction`update job_schedules set status = 'held' where id = ${schedule.id}`;
    await transaction`update job_schedules set status = 'confirmed' where id = ${schedule.id}`;
    const [scheduledBooking] = await transaction`
      select status, territory_id from bookings where id = ${booking.id}`;
    invariant(
      scheduledBooking.status === 'scheduled' && scheduledBooking.territory_id === territory.id,
      'Confirmed schedule did not synchronize booking status and territory',
    );
    await expectDatabaseError(transaction, ['23514'], 'accepted assignment downgrade on confirmed schedule', async (savepoint) => {
      await savepoint`update job_assignments set status = 'proposed' where id = ${assignmentOne.id}`;
    });
    await expectDatabaseError(transaction, ['23514'], 'accepted crew above exact schedule size', async (savepoint) => {
      await savepoint`
        insert into job_assignments
          (job_schedule_id, cleaner_id, assignment_role, status, is_dev_seed)
        values (${schedule.id}, ${overflowCleaner}, 'member', 'accepted', true)`;
    });
    await transaction`
      insert into territory_postal_codes (territory_id, postal_code, status)
      values (${territory.id}, '83815', 'active')`;
    await expectDatabaseError(transaction, ['23514'], 'removing postal eligibility from live work', async (savepoint) => {
      await savepoint`
        update territory_postal_codes set status = 'excluded'
        where territory_id = ${territory.id} and postal_code = '83814'`;
    });
    await expectDatabaseError(transaction, ['23514'], 'assigned cleaner deactivation', async (savepoint) => {
      await savepoint`update cleaners set status = 'paused' where id = ${cleanerOne}`;
    });
    await expectDatabaseError(transaction, ['23514'], 'required cleaner skill removal', async (savepoint) => {
      await savepoint`update cleaners set skills = '{}' where id = ${cleanerOne}`;
    });
    await expectDatabaseError(transaction, ['23514'], 'accepted cleaner availability removal', async (savepoint) => {
      await savepoint`
        update cleaner_availability_rules set status = 'paused'
        where cleaner_id = ${cleanerOne} and territory_id = ${territory.id}`;
    });
    await expectDatabaseError(transaction, ['23514'], 'pausing territory with confirmed work', async (savepoint) => {
      await savepoint`update service_territories set status = 'paused' where id = ${territory.id}`;
    });
    await expectDatabaseError(transaction, ['23514'], 'reschedule outside recurring availability', async (savepoint) => {
      await savepoint`
        update job_schedules
        set start_at = '2030-07-16T03:00:00.000Z', end_at = '2030-07-16T08:00:00.000Z'
        where id = ${schedule.id}`;
    });
    await transaction`update job_schedules set status = 'en_route' where id = ${schedule.id}`;
    await transaction`update job_schedules set status = 'in_progress' where id = ${schedule.id}`;
    await transaction`update job_schedules set status = 'quality_review' where id = ${schedule.id}`;
    await transaction`update job_schedules set status = 'completed' where id = ${schedule.id}`;
    const [completedBooking] = await transaction`
      select status from bookings where id = ${booking.id}`;
    invariant(completedBooking.status === 'completed', 'Completed schedule did not synchronize booking status');
    await expectDatabaseError(transaction, ['23514'], 'mutation of a completed schedule', async (savepoint) => {
      await savepoint`
        update job_schedules set start_at = start_at + interval '1 hour',
          end_at = end_at + interval '1 hour'
        where id = ${schedule.id}`;
    });
    await transaction`update service_territories set status = 'paused' where id = ${territory.id}`;
    await transaction`update job_schedules set status = 'canceled' where id = ${capacitySchedule.id}`;
    const [canceledCapacitySchedule] = await transaction`
      select status from job_schedules where id = ${capacitySchedule.id}`;
    invariant(
      canceledCapacitySchedule.status === 'canceled',
      'Cancellation must remain possible after territory capacity is paused',
    );
    await expectDatabaseError(transaction, ['23514'], 'resurrection of a canceled schedule', async (savepoint) => {
      await savepoint`
        update job_schedules set status = 'tentative' where id = ${capacitySchedule.id}`;
    });

    const [billing] = await transaction`
      insert into billing_records
        (booking_id, description, amount_cents, status, is_dev_seed)
      values (${booking.id}, 'Verifier paid invoice', 10000, 'paid', true)
      returning id`;
    const [refundCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, contact, details, status, is_dev_seed)
      values ('LP-VERIFY-REFUND-1', 'complaint', ${booking.id}, '{}',
        'Verifier refund case', 'refund_pending', true)
      returning id`;
    const [refund] = await transaction`
      insert into refund_records
        (service_case_id, booking_id, billing_record_id, amount_cents, reason_code,
         status, requested_by_label, is_dev_seed)
      values (${refundCase.id}, ${booking.id}, ${billing.id}, 6000, 'verifier',
        'requested', 'Verifier', true)
      returning id`;
    await expectDatabaseError(transaction, ['23514'], 'over-refund ledger entry', async (savepoint) => {
      await savepoint`
        insert into refund_records
          (service_case_id, booking_id, billing_record_id, amount_cents, reason_code,
           status, requested_by_label, is_dev_seed)
        values (${refundCase.id}, ${booking.id}, ${billing.id}, 5000, 'over_refund',
          'requested', 'Verifier', true)`;
    });
    await expectDatabaseError(transaction, ['23514'], 'service case leaving refund-pending with unfinished refund', async (savepoint) => {
      await savepoint`
        update service_cases set status = 'action_planned'
        where id = ${refundCase.id}`;
    });
    await transaction`update refund_records set status = 'approved', approved_by_label = 'Verifier', approved_at = now() where id = ${refund.id}`;
    await transaction`update refund_records set status = 'ready_for_manual_processing' where id = ${refund.id}`;
    await transaction`update refund_records set status = 'processed', provider_refund_id = 'verify-refund-1' where id = ${refund.id}`;
    const [resolvedCase] = await transaction`select status, resolution_type from service_cases where id = ${refundCase.id}`;
    invariant(
      resolvedCase.status === 'resolved' && resolvedCase.resolution_type === 'refund',
      'Processed refund did not resolve its service case',
    );
    const [recoveryCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, contact, details, status, is_dev_seed)
      values ('LP-VERIFY-RECLEAN-1', 'reclean', ${booking.id}, '{}',
        'Verifier reclean case', 'action_planned', true)
      returning id`;
    const [recovery] = await transaction`
      insert into service_recovery_actions
        (service_case_id, booking_id, action_type, owner_label, scheduled_at,
         status, notes, is_dev_seed)
      values (${recoveryCase.id}, ${booking.id}, 'reclean', 'Verifier operator',
        '2030-07-20T17:00:00.000Z', 'planned',
        'Separate recovery target; not a main appointment.', true)
      returning id`;
    await expectDatabaseError(transaction, ['23514'], 'reclean-scheduled case without scheduled recovery', async (savepoint) => {
      await savepoint`
        update service_cases set status = 'reclean_scheduled'
        where id = ${recoveryCase.id}`;
    });
    await expectDatabaseError(transaction, ['23514'], 'invalid recovery lifecycle jump', async (savepoint) => {
      await savepoint`
        update service_recovery_actions
        set status = 'completed', approved_by_label = 'Verifier', completed_at = now()
        where id = ${recovery.id}`;
    });
    await transaction`
      update service_recovery_actions
      set status = 'approved', approved_by_label = 'Verifier'
      where id = ${recovery.id}`;
    await transaction`
      update service_recovery_actions set status = 'scheduled'
      where id = ${recovery.id}`;
    await transaction`
      update service_recovery_actions set status = 'completed', completed_at = now()
      where id = ${recovery.id}`;
    const [completedRecovery] = await transaction`
      select status, completed_at from service_recovery_actions where id = ${recovery.id}`;
    invariant(
      completedRecovery.status === 'completed' && completedRecovery.completed_at,
      'Recovery action lifecycle did not preserve completion evidence',
    );
    await transaction`
      update service_cases set status = 'reclean_scheduled'
      where id = ${recoveryCase.id}`;
    await transaction`
      update service_cases set status = 'resolved', resolution_type = 'reclean',
        resolution_summary = 'Verifier recovery completed.', resolved_at = now()
      where id = ${recoveryCase.id}`;

    const [capacityTerritory] = await transaction`
      insert into service_territories
        (code, name, timezone, status, travel_buffer_minutes, is_dev_seed)
      values ('capacity-pause', 'Capacity pause territory', 'America/Los_Angeles', 'draft', 30, true)
      returning id`;
    await transaction`
      insert into territory_postal_codes (territory_id, postal_code, status)
      values (${capacityTerritory.id}, '83815', 'active')`;
    const [capacityCleaner] = await transaction`
      insert into cleaners
        (full_name, email, status, screening_status, screening_verified_at,
         home_territory_id, skills, vertical_experience, is_dev_seed)
      values ('Capacity Only', 'capacity-only@verify.invalid', 'active', 'verified', now(),
        ${capacityTerritory.id}, array['estate_detail'], array['estate'], true)
      returning id`;
    await transaction`
      insert into cleaner_availability_rules
        (cleaner_id, territory_id, day_of_week, start_time, end_time, effective_from, status)
      values (${capacityCleaner.id}, ${capacityTerritory.id}, 1, '08:00', '18:00', '2030-01-01', 'active')`;
    await transaction`update service_territories set status = 'active' where id = ${capacityTerritory.id}`;
    await transaction`update cleaners set status = 'paused' where id = ${capacityCleaner.id}`;
    const [pausedCapacityTerritory] = await transaction`
      select status from service_territories where id = ${capacityTerritory.id}`;
    invariant(
      pausedCapacityTerritory.status === 'paused',
      'Territory did not auto-pause after losing its last screened, available cleaner',
    );
  });
}

const rawUrl = process.env.MIGRATION_DATABASE_URL;
const { target, database } = validateTarget(rawUrl);
const migrations = await loadMigrations();
const sql = postgres(rawUrl, { max: 1, onnotice: () => {} });

try {
  const [server] = await sql`
    select current_user, current_database(),
      current_setting('server_version_num')::integer as server_version_num`;
  const major = Math.floor(server.server_version_num / 10000);
  invariant(
    major === REQUIRED_POSTGRES_MAJOR,
    `Migration verification requires PostgreSQL ${REQUIRED_POSTGRES_MAJOR}; received ${major}`,
  );
  invariant(
    server.current_database === database,
    `Connected database ${server.current_database} does not match guarded target ${database}`,
  );

  const existingTables = await sql`
    select table_class.relname as table_name
    from pg_class table_class
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relkind in ('r', 'p')`;
  invariant(
    existingTables.length === 0,
    `Verification requires a fresh database; found public tables: ${existingTables.map((row) => row.table_name).join(", ")}`,
  );
  await inspectHostedRoleDdlCompatibility(sql, migrations, false);
  await seedProductionLikeApplicationRole(sql);
  await inspectHostedRoleDdlCompatibility(sql, migrations, true);
  await applyMigrations(sql, migrations);
  await assertSafeRole(sql, true);

  const access = await inspectApplicationRoleAccess(sql);
  const atomicIntake = await inspectAtomicIntakeFunctions(sql);
  const failures = [...access.failures, ...atomicIntake.failures];
  invariant(
    failures.length === 0,
    `Migration verification failed:\n- ${failures.join("\n- ")}`,
  );
  const runtimeIdentity = await inspectRuntimeConnection(rawUrl, access.operationsTables);
  await inspectOperationalInvariants(sql);

  console.log(JSON.stringify({
    result: "PASS",
    target: {
      host: target.hostname,
      database,
      postgresMajor: major,
      disposableGuard: "local host plus ci/test/proof/disposable database name",
    },
    migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })),
    applicationRole: {
      name: APP_ROLE,
      nonSuperuser: true,
      bypassRls: false,
      ownsOperationalTables: false,
      startupRoleVerified: runtimeIdentity.current_user,
      sessionOwner: runtimeIdentity.session_user,
      verifiedPrivileges: REQUIRED_PRIVILEGES,
    },
    privateOperationalTables: access.operationsTables,
    atomicIntakeFunctions: atomicIntake.functions.length > 0
      ? atomicIntake.functions.map((candidate) => candidate.signature)
      : "none discovered; add a function name matching create*booking/booking*create or an 'atomic intake' function comment",
    operationalInvariants: "postal eligibility, territory capacity, labor, schedule and recovery lifecycle, availability, cancellation, time off, and refund guards verified",
  }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
