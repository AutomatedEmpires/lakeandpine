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

async function assertSafeRole(sql) {
  const role = await readRole(sql);
  invariant(role, `${APP_ROLE} was not created`);
  invariant(!role.rolsuper, `${APP_ROLE} must not be a superuser`);
  invariant(!role.rolcreaterole, `${APP_ROLE} must not have CREATEROLE`);
  invariant(!role.rolcreatedb, `${APP_ROLE} must not have CREATEDB`);
  invariant(!role.rolcanlogin, `${APP_ROLE} must remain NOLOGIN in disposable verification`);
  invariant(!role.rolreplication, `${APP_ROLE} must not have REPLICATION`);
  invariant(!role.rolbypassrls, `${APP_ROLE} must not have BYPASSRLS`);

  const memberships = await sql`
    select granted.rolname as granted_role, member.rolname as member_role
    from pg_auth_members membership
    join pg_roles granted on granted.oid = membership.roleid
    join pg_roles member on member.oid = membership.member
    where granted.rolname = ${APP_ROLE} or member.rolname = ${APP_ROLE}`;
  invariant(
    memberships.length === 0,
    `${APP_ROLE} must not inherit from or be granted to another role in verification`,
  );
}

async function createSafeApplicationRole(sql) {
  const existing = await readRole(sql);
  if (!existing) {
    await sql.unsafe(
      `create role ${quoteIdentifier(APP_ROLE)} noinherit nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
    );
  }
  await assertSafeRole(sql);
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

  await createSafeApplicationRole(sql);
  await applyMigrations(sql, migrations);
  await assertSafeRole(sql);

  const access = await inspectApplicationRoleAccess(sql);
  const atomicIntake = await inspectAtomicIntakeFunctions(sql);
  const failures = [...access.failures, ...atomicIntake.failures];
  invariant(
    failures.length === 0,
    `Migration verification failed:\n- ${failures.join("\n- ")}`,
  );

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
      verifiedPrivileges: REQUIRED_PRIVILEGES,
    },
    privateOperationalTables: access.operationsTables,
    atomicIntakeFunctions: atomicIntake.functions.length > 0
      ? atomicIntake.functions.map((candidate) => candidate.signature)
      : "none discovered; add a function name matching create*booking/booking*create or an 'atomic intake' function comment",
  }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
