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
const PUBLIC_CONTENT_FILTERS = {
  services: "active",
  addons: "active",
  plans: "true",
  service_areas: "active",
  faqs: "active",
  reviews: "published",
};
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
    const rawSource = await readFile(resolve(migrationsDirectory, name), "utf8");
    const source = rawSource.replaceAll("\r\n", "\n");
    invariant(
      !source.includes("\r"),
      `Migration ${name} contains an unsupported carriage return`,
    );
    invariant(source.trim().length > 0, `Migration ${name} is empty`);
    return {
      name,
      source,
      sha256: createHash("sha256").update(source).digest("hex"),
    };
  }));
}

async function readRole(sql, roleName = APP_ROLE) {
  const [role] = await sql`
    select rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin,
      rolinherit, rolreplication, rolbypassrls
    from pg_roles
    where rolname = ${roleName}`;
  return role;
}

async function assertSafeRole(sql, expectRuntimeGrant = false) {
  const role = await readRole(sql);
  invariant(role, `${APP_ROLE} was not created`);
  invariant(!role.rolsuper, `${APP_ROLE} must not be a superuser`);
  invariant(!role.rolcreaterole, `${APP_ROLE} must not have CREATEROLE`);
  invariant(!role.rolcreatedb, `${APP_ROLE} must not have CREATEDB`);
  invariant(role.rolcanlogin, `${APP_ROLE} must retain the production-compatible LOGIN attribute`);
  invariant(!role.rolinherit, `${APP_ROLE} must use NOINHERIT`);
  invariant(!role.rolreplication, `${APP_ROLE} must not have REPLICATION`);
  invariant(!role.rolbypassrls, `${APP_ROLE} must not have BYPASSRLS`);

  const memberships = await sql`
    select granted.rolname as granted_role, member.rolname as member_role,
      grantor.rolname as grantor_role, membership.admin_option,
      membership.inherit_option, membership.set_option
    from pg_auth_members membership
    join pg_roles granted on granted.oid = membership.roleid
    join pg_roles member on member.oid = membership.member
    join pg_roles grantor on grantor.oid = membership.grantor
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
        grantsToConnectionOwner.some(
          (membership) => membership.grantor_role === "supabase_admin",
        ) &&
        grantsToConnectionOwner.some(
          (membership) => membership.grantor_role === "postgres",
        ) &&
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

function readHostedRoleDdl(migrations) {
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
  return source.slice(start, end);
}

async function createHostedMigrationRunner(bootstrapSql, bootstrapUrl, database) {
  const [bootstrap] = await bootstrapSql`
    select current_user, rolsuper
    from pg_roles
    where rolname = current_user`;
  invariant(
    bootstrap.current_user === "supabase_admin" && bootstrap.rolsuper,
    "Migration verification must bootstrap as the supabase_admin superuser",
  );
  invariant(
    !(await readRole(bootstrapSql, "postgres")),
    "Disposable cluster must not pre-create the hosted postgres role",
  );

  await bootstrapSql.unsafe(
    "create role postgres login password 'lakeandpine-verifier-postgres' nosuperuser createdb createrole inherit replication bypassrls",
  );
  await bootstrapSql.unsafe("create role anon nologin");
  await bootstrapSql.unsafe("create role authenticated nologin");
  await bootstrapSql.unsafe(
    `alter database ${quoteIdentifier(database)} owner to postgres`,
  );
  await bootstrapSql.unsafe("alter schema public owner to postgres");

  const runnerUrl = new URL(bootstrapUrl);
  runnerUrl.username = "postgres";
  runnerUrl.password = "lakeandpine-verifier-postgres";
  const runnerSql = postgres(runnerUrl.toString(), { max: 4, onnotice: () => {} });
  const [runner] = await runnerSql`
    select current_user, rolsuper, rolcreaterole, rolcreatedb,
      rolreplication, rolbypassrls
    from pg_roles
    where rolname = current_user`;
  invariant(runner.current_user === "postgres", "Hosted migration runner must be postgres");
  invariant(!runner.rolsuper, "Hosted migration runner must not be a superuser");
  invariant(runner.rolcreaterole && runner.rolcreatedb,
    "Hosted migration runner must retain CREATEROLE and CREATEDB");
  invariant(runner.rolreplication && runner.rolbypassrls,
    "Hosted migration runner fixture must match production system attributes");
  return { runnerSql, runnerUrl: runnerUrl.toString() };
}

async function inspectHostedRoleCreationCompatibility(
  bootstrapSql,
  runnerSql,
  migrations,
) {
  invariant(!(await readRole(runnerSql)),
    "Role-creation compatibility probe requires lakeandpine_app to be absent");
  try {
    await runnerSql.unsafe(readHostedRoleDdl(migrations));
    const created = await readRole(runnerSql);
    invariant(
      created && !created.rolsuper && !created.rolcreaterole &&
        !created.rolcreatedb && created.rolcanlogin && !created.rolinherit &&
        !created.rolreplication && !created.rolbypassrls,
      "Hosted role-creation path produced unsafe application-role attributes",
    );
    const memberships = await runnerSql`
      select granted.rolname as granted_role, member.rolname as member_role,
        membership.inherit_option
      from pg_auth_members membership
      join pg_roles granted on granted.oid = membership.roleid
      join pg_roles member on member.oid = membership.member
      where granted.rolname = ${APP_ROLE} or member.rolname = ${APP_ROLE}`;
    invariant(
      memberships.length > 0 && memberships.every(
        (membership) =>
          membership.granted_role === APP_ROLE &&
          membership.member_role === "postgres" &&
          !membership.inherit_option,
      ),
      "Hosted role creator received an unsafe application-role membership",
    );
  } finally {
    if (await readRole(bootstrapSql)) {
      await runnerSql.unsafe(
        `revoke ${quoteIdentifier(APP_ROLE)} from postgres`,
      );
      await bootstrapSql.unsafe(`drop role ${quoteIdentifier(APP_ROLE)}`);
    }
  }
}

async function seedProductionLikeApplicationRole(bootstrapSql) {
  invariant(!(await readRole(bootstrapSql)),
    `${APP_ROLE} must be absent before the production fixture is seeded`);
  await bootstrapSql.unsafe(
    `create role ${quoteIdentifier(APP_ROLE)} inherit login nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
  );
  await bootstrapSql.unsafe(
    `grant ${quoteIdentifier(APP_ROLE)} to postgres with admin true, inherit false, set false`,
  );
  const grants = await bootstrapSql`
    select grantor.rolname as grantor_role, membership.admin_option,
      membership.inherit_option, membership.set_option
    from pg_auth_members membership
    join pg_roles granted on granted.oid = membership.roleid
    join pg_roles member on member.oid = membership.member
    join pg_roles grantor on grantor.oid = membership.grantor
    where granted.rolname = ${APP_ROLE} and member.rolname = 'postgres'`;
  invariant(
    grants.length === 1 && grants[0].grantor_role === "supabase_admin" &&
      grants[0].admin_option && !grants[0].inherit_option && !grants[0].set_option,
    "Production fixture must start with the exact supabase_admin grant row",
  );
}

async function inspectHostedRoleGuardRejections(
  bootstrapSql,
  runnerSql,
  migrations,
) {
  const roleDdl = readHostedRoleDdl(migrations);
  async function expectRejection(messageFragment, label) {
    let rejected = false;
    try {
      await runnerSql.unsafe(roleDdl);
    } catch (error) {
      rejected = String(error.message).includes(messageFragment);
    }
    invariant(rejected, `Hosted role guard did not reject ${label}`);
  }

  await bootstrapSql.unsafe("create role lakeandpine_unexpected_parent nologin");
  await bootstrapSql.unsafe(
    `grant lakeandpine_unexpected_parent to ${quoteIdentifier(APP_ROLE)} with admin false, inherit false, set true`,
  );
  try {
    await expectRejection("inherits or can set another role", "application-role membership");
  } finally {
    await bootstrapSql.unsafe(
      `revoke lakeandpine_unexpected_parent from ${quoteIdentifier(APP_ROLE)}`,
    );
    await bootstrapSql.unsafe("drop role lakeandpine_unexpected_parent");
  }

  await bootstrapSql.unsafe("create role lakeandpine_unexpected_member nologin");
  await bootstrapSql.unsafe(
    `grant ${quoteIdentifier(APP_ROLE)} to lakeandpine_unexpected_member with admin false, inherit false, set true`,
  );
  try {
    await expectRejection("granted to an unexpected member", "unexpected grantee");
  } finally {
    await bootstrapSql.unsafe(
      `revoke ${quoteIdentifier(APP_ROLE)} from lakeandpine_unexpected_member`,
    );
    await bootstrapSql.unsafe("drop role lakeandpine_unexpected_member");
  }

  await bootstrapSql.unsafe(
    `grant ${quoteIdentifier(APP_ROLE)} to postgres with admin true, inherit true, set false`,
  );
  try {
    await expectRejection(
      "must not inherit lakeandpine_app privileges automatically",
      "inheriting connection-owner membership",
    );
  } finally {
    await bootstrapSql.unsafe(
      `grant ${quoteIdentifier(APP_ROLE)} to postgres with admin true, inherit false, set false`,
    );
  }

  await bootstrapSql.unsafe(
    "create table public.lakeandpine_role_owner_probe (id integer primary key)",
  );
  await bootstrapSql.unsafe(
    `alter table public.lakeandpine_role_owner_probe owner to ${quoteIdentifier(APP_ROLE)}`,
  );
  try {
    await expectRejection("owns a public object", "application-owned relation");
  } finally {
    await bootstrapSql.unsafe("drop table public.lakeandpine_role_owner_probe");
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

async function inspectProductionHardening(sql) {
  const failures = [];
  const [postalFunction] = await sql`
    select procedure.oid::regprocedure::text as signature,
      coalesce(procedure.proconfig, array[]::text[]) as configuration
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'normalize_us_postal_code'
      and procedure.proargtypes = '25'::oidvector`;
  if (!postalFunction) {
    failures.push("public.normalize_us_postal_code(text) is missing");
  } else if (!postalFunction.configuration.includes("search_path=pg_catalog")) {
    failures.push(
      "public.normalize_us_postal_code(text) must pin search_path to pg_catalog",
    );
  }

  const policies = await sql`
    select tablename, policyname, cmd, permissive, roles::text[] as roles
    from pg_policies
    where schemaname = 'public'`;
  const policyTables = new Set(policies.map((policy) => policy.tablename));
  const duplicatePolicies = [];
  for (const table of policyTables) {
    for (const command of REQUIRED_PRIVILEGES) {
      const applicable = policies.filter((policy) =>
        policy.tablename === table &&
        policy.permissive === "PERMISSIVE" &&
        (policy.cmd === "ALL" || policy.cmd === command) &&
        (policy.roles.includes(APP_ROLE) || policy.roles.includes("public")));
      if (applicable.length > 1) {
        duplicatePolicies.push(
          `public.${table} ${command}: ${applicable.map((policy) => policy.policyname).join(", ")}`,
        );
      }
    }
  }
  if (duplicatePolicies.length > 0) {
    failures.push(
      `Redundant permissive policies apply to ${APP_ROLE}: ${duplicatePolicies.join("; ")}`,
    );
  }

  const publicCatalogAccess = await sql`
    select role_definition.rolname as role_name,
      content_table.table_name,
      has_table_privilege(
        role_definition.rolname,
        format('public.%I', content_table.table_name),
        'SELECT'
      ) as can_select
    from pg_roles role_definition
    cross join unnest(${sql.array([...PUBLIC_CONTENT_TABLES])}::text[])
      as content_table(table_name)
    where role_definition.rolname in ('anon', 'authenticated')
    order by role_definition.rolname, content_table.table_name`;
  const missingPublicCatalogAccess = publicCatalogAccess.filter((grant) => !grant.can_select);
  if (publicCatalogAccess.length !== PUBLIC_CONTENT_TABLES.size * 2) {
    failures.push("Hosted anon/authenticated role fixture is incomplete");
  } else if (missingPublicCatalogAccess.length > 0) {
    failures.push(
      `Supabase client roles lack public catalog reads: ${missingPublicCatalogAccess
        .map((grant) => `${grant.role_name}:public.${grant.table_name}`)
        .join(", ")}`,
    );
  }

  const expectedApplicationCatalogRows = {};
  for (const [table, predicate] of Object.entries(PUBLIC_CONTENT_FILTERS)) {
    const [expected] = await sql.unsafe(
      `select count(*)::integer as row_count from public.${quoteIdentifier(table)} where ${predicate}`,
    );
    expectedApplicationCatalogRows[table] = expected.row_count;
  }
  if (expectedApplicationCatalogRows.services === 0) {
    failures.push("The seeded services catalog is empty");
  }

  const applicationCatalogRows = {};
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    for (const table of PUBLIC_CONTENT_TABLES) {
      const [visibility] = await transaction.unsafe(
        `select count(*)::integer as row_count from public.${quoteIdentifier(table)}`,
      );
      applicationCatalogRows[table] = visibility.row_count;
    }
  });
  const hiddenApplicationCatalogTables = Object.entries(applicationCatalogRows)
    .filter(([table, rowCount]) => rowCount !== expectedApplicationCatalogRows[table])
    .map(([table]) => table);
  if (hiddenApplicationCatalogTables.length > 0) {
    failures.push(
      `${APP_ROLE} cannot read seeded public catalog rows from: ${hiddenApplicationCatalogTables.join(", ")}`,
    );
  }

  const unindexedForeignKeys = await sql`
    select constraint_definition.conrelid::regclass::text as table_name,
      constraint_definition.conname as constraint_name
    from pg_constraint constraint_definition
    where constraint_definition.contype = 'f'
      and constraint_definition.connamespace = 'public'::regnamespace
      and not exists (
        select 1
        from pg_index index_definition
        where index_definition.indrelid = constraint_definition.conrelid
          and index_definition.indisvalid
          and (index_definition.indkey::smallint[])[
            0:cardinality(constraint_definition.conkey) - 1
          ] = constraint_definition.conkey
      )
    order by constraint_definition.conrelid::regclass::text,
      constraint_definition.conname`;
  if (unindexedForeignKeys.length > 0) {
    failures.push(
      `Foreign keys lack covering indexes: ${unindexedForeignKeys
        .map((foreignKey) => `${foreignKey.table_name}.${foreignKey.constraint_name}`)
        .join(", ")}`,
    );
  }

  return {
    failures,
    functionSearchPath: postalFunction?.configuration || [],
    duplicatePermissivePolicies: duplicatePolicies.length,
    applicationCatalogTablesVisible: Object.keys(applicationCatalogRows).length,
    publicCatalogRoleReads: publicCatalogAccess.length,
    unindexedForeignKeys: unindexedForeignKeys.length,
  };
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

    await transaction.unsafe('reset role');
    const [timeOff] = await transaction`
      insert into cleaner_time_off
        (cleaner_id, start_at, end_at, status, is_dev_seed)
      values (${cleanerOne}, ${startAt}, ${endAt}, 'requested', true)
      returning id`;
    await expectDatabaseError(transaction, ['23P01'], 'time-off approval over accepted work', async (savepoint) => {
      await savepoint`update cleaner_time_off set status = 'approved' where id = ${timeOff.id}`;
    });
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);

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

async function inspectOwnerBootstrapConcurrency(sql) {
  const candidates = await sql`
    insert into customers (email, full_name, role, is_dev_seed)
    values
      ('owner-race-a@verify.invalid', 'Owner Race A', 'staff', true),
      ('owner-race-b@verify.invalid', 'Owner Race B', 'staff', true)
    returning id`;
  const attempts = await Promise.allSettled(candidates.map((candidate) =>
    sql.begin(async (transaction) => {
      await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
      await transaction`select set_config('lakeandpine.current_customer_id', ${candidate.id}, true)`;
      const [membership] = await transaction`
        select private.bootstrap_lakeandpine_owner(${candidate.id}) as id`;
      return membership.id;
    }),
  ));
  invariant(
    attempts.filter((attempt) => attempt.status === 'fulfilled').length === 1
      && attempts.filter((attempt) => attempt.status === 'rejected').length === 1,
    'Concurrent owner bootstrap must establish exactly one national owner',
  );
  const [ownerCount] = await sql`
    select count(*)::int as count from workforce_memberships
    where role = 'owner' and status = 'active'`;
  invariant(ownerCount.count === 1,
    'Database owner uniqueness invariant did not hold after concurrent bootstrap');
  await sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.dev_seed_purge', '1', true)`;
    await transaction`delete from workforce_memberships where role = 'owner' and status = 'active'`;
    await transaction`delete from customers where id = any(${candidates.map((candidate) => candidate.id)}::uuid[])`;
  });
}

async function inspectNationalTeamOperations(sql) {
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    const [owner] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('national-owner@verify.invalid', 'National Owner', 'staff', true)
      returning id`;
    const [manager] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('team-manager@verify.invalid', 'Team Manager', 'staff', true)
      returning id`;
    const [generalManager] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('general-manager@verify.invalid', 'General Manager', 'staff', true)
      returning id`;
    const [teamBManager] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('team-b-manager@verify.invalid', 'Team B Manager', 'staff', true)
      returning id`;
    const [candidateManager] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('candidate-manager@verify.invalid', 'Candidate Manager', 'staff', true)
      returning id`;
    const [peerManager] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('peer-manager@verify.invalid', 'Peer Team Manager', 'staff', true)
      returning id`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${owner.id}, true)`;
    const [ownerMembership] = await transaction`
      select private.bootstrap_lakeandpine_owner(${owner.id}) as id`;
    invariant(ownerMembership.id, 'National owner bootstrap did not return a membership');
    const [organization] = await transaction`
      select id from organizations where slug = 'lake-and-pine'`;
    invariant(organization, 'Bootstrapped owner cannot read the organization');

    const [teamA] = await transaction`
      insert into cleaning_teams
        (organization_id, code, name, timezone, status, is_dev_seed)
      values (${organization.id}, 'verify-team-a', 'Verifier Team A',
        'America/Los_Angeles', 'active', true)
      returning id`;
    const [teamB] = await transaction`
      insert into cleaning_teams
        (organization_id, code, name, timezone, status, is_dev_seed)
      values (${organization.id}, 'verify-team-b', 'Verifier Team B',
        'America/Los_Angeles', 'active', true)
      returning id`;
    const [locationA] = await transaction`
      insert into inventory_locations
        (organization_id, team_id, name, location_type)
      values (${organization.id}, ${teamA.id}, 'Team A supply room', 'supply_room')
      returning id`;
    const [locationB] = await transaction`
      insert into inventory_locations
        (organization_id, team_id, name, location_type)
      values (${organization.id}, ${teamB.id}, 'Team B supply room', 'supply_room')
      returning id`;
    const [managerMembership] = await transaction`
      insert into workforce_memberships
        (organization_id, team_id, customer_id, role, status, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${manager.id}, 'manager', 'active', true)
      returning id`;
    const [peerManagerMembership] = await transaction`
      insert into workforce_memberships
        (organization_id, team_id, customer_id, role, status, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${peerManager.id}, 'manager', 'active', true)
      returning id`;
    const [teamBManagerMembership] = await transaction`
      insert into workforce_memberships
        (organization_id, team_id, customer_id, role, status, is_dev_seed)
      values (${organization.id}, ${teamB.id}, ${teamBManager.id}, 'manager', 'active', true)
      returning id`;
    const [peerManagerRate] = await transaction`
      insert into compensation_rates
        (organization_id, team_id, workforce_membership_id, pay_basis,
         amount_cents, effective_from, status, created_by_membership_id,
         reason, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${peerManagerMembership.id}, 'salary',
        9000000, '2030-01-01', 'active', ${ownerMembership.id},
        'Verifier owner-only manager compensation', true)
      returning id`;
    const [peerManagerBonus] = await transaction`
      insert into bonus_awards
        (organization_id, team_id, workforce_membership_id, amount_cents,
         reason, status, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${peerManagerMembership.id}, 5000,
        'Verifier owner-only manager bonus', 'proposed', true)
      returning id`;
    const [peerManagerEvent] = await transaction`
      insert into workforce_events
        (organization_id, team_id, subject_membership_id, event_type, severity,
         summary, created_by_membership_id, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${peerManagerMembership.id},
        'performance_coaching', 'medium', 'Verifier owner-only manager event',
        ${ownerMembership.id}, true)
      returning id`;
    const [generalManagerMembership] = await transaction`
      insert into workforce_memberships
        (organization_id, customer_id, role, status, is_dev_seed)
      values (${organization.id}, ${generalManager.id}, 'gm', 'active', true)
      returning id`;
    invariant(generalManagerMembership.id,
      'Owner could not grant the organization-wide general-manager role');
    const [globalBonusTier] = await transaction`
      insert into review_bonus_tiers
        (organization_id, team_id, name, minimum_rating, bonus_cents, is_dev_seed)
      values (${organization.id}, null, 'Verifier national standard', 5, 1000, true)
      returning id`;
    const [teamBBonusTier] = await transaction`
      insert into review_bonus_tiers
        (organization_id, team_id, name, minimum_rating, bonus_cents, is_dev_seed)
      values (${organization.id}, ${teamB.id}, 'Verifier Team B standard', 5, 1100, true)
      returning id`;

    const [cleaner] = await transaction`
      insert into cleaners
        (full_name, email, status, screening_status, screening_verified_at,
         skills, vertical_experience, is_dev_seed)
      values ('Team A Cleaner', 'team-a-cleaner@verify.invalid', 'active',
        'verified', now(), array['estate_detail'], array['estate'], true)
      returning id`;
    const [cleanerMembership] = await transaction`
      insert into workforce_memberships
        (organization_id, team_id, cleaner_id, role, status, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${cleaner.id}, 'cleaner', 'active', true)
      returning id`;
    const [leadCleaner] = await transaction`
      insert into cleaners
        (full_name, email, status, screening_status, screening_verified_at,
         skills, vertical_experience, is_dev_seed)
      values ('Team A Shift Lead', 'team-a-lead@verify.invalid', 'active',
        'verified', now(), array['estate_detail'], array['estate'], true)
      returning id`;

    const [productA] = await transaction`
      insert into inventory_products
        (organization_id, team_id, sku, name, category, unit_label,
         automatic_reorder_enabled, is_dev_seed)
      values (${organization.id}, ${teamA.id}, 'VERIFY-A', 'Verifier Product A',
        'general', 'bottle', false, true)
      returning id`;
    const [productB] = await transaction`
      insert into inventory_products
        (organization_id, team_id, sku, name, category, unit_label,
         automatic_reorder_enabled, is_dev_seed)
      values (${organization.id}, ${teamB.id}, 'VERIFY-B', 'Verifier Product B',
        'general', 'bottle', true, true)
      returning id`;
    const [guardProduct] = await transaction`
      insert into inventory_products
        (organization_id, team_id, sku, name, category, unit_label, is_dev_seed)
      values (${organization.id}, ${teamA.id}, 'VERIFY-GUARD',
        'Verifier Guard Product', 'general', 'bottle', true)
      returning id`;
    await expectDatabaseError(transaction, ['42501'], 'nonzero opening stock', async (savepoint) => {
      await savepoint`
        insert into inventory_stock
          (organization_id, team_id, location_id, product_id, on_hand,
           reorder_point, target_level)
        values (${organization.id}, ${teamA.id}, ${locationA.id}, ${guardProduct.id},
          4, 0, 0)`;
    });
    await transaction`
      insert into inventory_stock
        (organization_id, team_id, location_id, product_id, reorder_point, target_level)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id}, 0, 0)`;
    await transaction`
      insert into inventory_stock
        (organization_id, team_id, location_id, product_id, reorder_point, target_level)
      values (${organization.id}, ${teamB.id}, ${locationB.id}, ${productB.id}, 0, 0)`;
    await transaction`
      insert into inventory_transactions
        (organization_id, team_id, location_id, product_id, transaction_type,
         quantity_delta, balance_after, actor_membership_id, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
        'receipt', 10, 0, ${ownerMembership.id}, true)`;
    await transaction`
      update inventory_stock set reorder_point = 5, target_level = 12
      where location_id = ${locationA.id} and product_id = ${productA.id}`;
    await transaction`
      update inventory_products set automatic_reorder_enabled = true
      where id = ${productA.id}`;
    await transaction`
      insert into inventory_transactions
        (organization_id, team_id, location_id, product_id, transaction_type,
         quantity_delta, balance_after, actor_membership_id, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
        'usage', -6, 0, ${ownerMembership.id}, true)`;
    await transaction`
      insert into inventory_transactions
        (organization_id, team_id, location_id, product_id, transaction_type,
         quantity_delta, balance_after, actor_membership_id, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
        'usage', -1, 0, ${ownerMembership.id}, true)`;
    const [stock] = await transaction`
      select on_hand::float8 from inventory_stock
      where location_id = ${locationA.id} and product_id = ${productA.id}`;
    invariant(stock.on_hand === 3, 'Inventory ledger did not reconcile team stock');
    await expectDatabaseError(transaction, ['42501'], 'stock identity rewrite', async (savepoint) => {
      await savepoint`
        update inventory_stock set product_id = ${guardProduct.id}
        where location_id = ${locationA.id} and product_id = ${productA.id}`;
    });
    const deletedStock = await transaction`
      delete from inventory_stock
      where location_id = ${locationA.id} and product_id = ${productA.id}
      returning product_id`;
    invariant(deletedStock.length === 0,
      'Stock deletion changed rows despite the ledger-controlled delete policy');
    const [automaticDrafts] = await transaction`
      select count(*)::int as count from restock_requests
      where location_id = ${locationA.id} and product_id = ${productA.id}
        and request_source = 'automatic_threshold'
        and status in ('requested','approved','ordered')`;
    invariant(automaticDrafts.count === 1,
      'Threshold usage must create exactly one open automatic restock draft');

    await expectDatabaseError(transaction, ['23514'], 'negative team inventory', async (savepoint) => {
      await savepoint`
        insert into inventory_transactions
          (organization_id, team_id, location_id, product_id, transaction_type,
           quantity_delta, balance_after, actor_membership_id, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
          'usage', -100, 0, ${ownerMembership.id}, true)`;
    });
    await expectDatabaseError(transaction, ['23503'], 'cross-team inventory reference', async (savepoint) => {
      await savepoint`
        insert into inventory_transactions
          (organization_id, team_id, location_id, product_id, transaction_type,
           quantity_delta, balance_after, actor_membership_id, is_dev_seed)
        values (${organization.id}, ${teamB.id}, ${locationB.id}, ${productA.id},
          'receipt', 1, 0, ${ownerMembership.id}, true)`;
    });
    await expectDatabaseError(transaction, ['42501'], 'direct stock balance mutation', async (savepoint) => {
      await savepoint`
        update inventory_stock set on_hand = 99
        where location_id = ${locationA.id} and product_id = ${productA.id}`;
    });
    const rewrittenLedger = await transaction`
      update inventory_transactions set note = 'rewritten'
      where product_id = ${productA.id}
      returning id`;
    invariant(rewrittenLedger.length === 0,
      'Inventory ledger rewrite changed rows despite immutable policy');

    await expectDatabaseError(transaction, ['23514'], 'cross-team actor attribution', async (savepoint) => {
      await savepoint`
        insert into inventory_transactions
          (organization_id, team_id, location_id, product_id, transaction_type,
           quantity_delta, balance_after, actor_membership_id, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
          'receipt', 1, 0, ${teamBManagerMembership.id}, true)`;
    });

    await transaction`select set_config('lakeandpine.current_customer_id', ${generalManager.id}, true)`;
    const [gmTeams] = await transaction`
      select count(*)::int as count from cleaning_teams
      where id in (${teamA.id}, ${teamB.id})`;
    invariant(gmTeams.count === 2, 'General manager cannot read organization teams');
    await expectDatabaseError(transaction, ['42501'], 'general manager granting another GM', async (savepoint) => {
      await savepoint`
        insert into workforce_memberships
          (organization_id, customer_id, role, status, is_dev_seed)
        values (${organization.id}, ${candidateManager.id}, 'gm', 'active', true)`;
    });

    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    const [managerTeamA] = await transaction`
      select count(*)::int as count from cleaning_teams where id = ${teamA.id}`;
    const [managerTeamB] = await transaction`
      select count(*)::int as count from cleaning_teams where id = ${teamB.id}`;
    invariant(managerTeamA.count === 1 && managerTeamB.count === 0,
      'Manager team isolation did not fail closed');
    const [leadMembership] = await transaction`
      insert into workforce_memberships
        (organization_id, team_id, cleaner_id, role, status, title, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${leadCleaner.id}, 'shift_lead',
        'active', 'Verifier shift lead', true)
      returning id`;
    invariant(leadMembership.id,
      'Manager could not grant the cleaner-backed shift-lead role');
    await expectDatabaseError(transaction, ['42501'], 'manager granting manager role', async (savepoint) => {
      await savepoint`
        insert into workforce_memberships
          (organization_id, team_id, customer_id, role, status, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${candidateManager.id},
          'manager', 'active', true)`;
    });
    const [staffLeadMembership] = await transaction`
      insert into workforce_memberships
        (organization_id, team_id, customer_id, role, status, title, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${candidateManager.id},
        'shift_lead', 'active', 'Verifier staff dispatch lead', true)
      returning id`;
    invariant(staffLeadMembership.id,
      'Manager could not grant a staff-backed shift-lead role');
    const [managerRoster] = await transaction`
      select count(*)::int as count from workforce_memberships
      where team_id = ${teamA.id}`;
    invariant(managerRoster.count === 5,
      'Manager cannot read the complete local team roster');
    const [hiddenPeerRate] = await transaction`
      select count(*)::int as count from compensation_rates where id = ${peerManagerRate.id}`;
    const [hiddenPeerBonus] = await transaction`
      select count(*)::int as count from bonus_awards where id = ${peerManagerBonus.id}`;
    const [hiddenPeerEvent] = await transaction`
      select count(*)::int as count from workforce_events where id = ${peerManagerEvent.id}`;
    invariant(hiddenPeerRate.count === 0 && hiddenPeerBonus.count === 0
      && hiddenPeerEvent.count === 0,
      'Manager visibility crossed peer-manager financial or workforce boundaries');
    await expectDatabaseError(transaction, ['42501'], 'manager changing peer manager pay', async (savepoint) => {
      await savepoint`
        insert into compensation_rates
          (organization_id, team_id, workforce_membership_id, pay_basis,
           amount_cents, effective_from, status, created_by_membership_id,
           reason, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${peerManagerMembership.id}, 'salary',
          9500000, '2031-01-01', 'active', ${managerMembership.id},
          'Forbidden peer manager pay change', true)`;
    });
    await expectDatabaseError(transaction, ['42501'], 'manager awarding peer manager bonus', async (savepoint) => {
      await savepoint`
        insert into bonus_awards
          (organization_id, team_id, workforce_membership_id, amount_cents,
           reason, status, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${peerManagerMembership.id}, 5000,
          'Forbidden peer manager bonus', 'proposed', true)`;
    });
    await expectDatabaseError(transaction, ['42501'], 'manager disciplining peer manager', async (savepoint) => {
      await savepoint`
        insert into workforce_events
          (organization_id, team_id, subject_membership_id, event_type, severity,
           summary, created_by_membership_id, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${peerManagerMembership.id},
          'termination', 'critical', 'Forbidden peer manager termination',
          ${managerMembership.id}, true)`;
    });
    await expectDatabaseError(transaction, ['42501'], 'manager cross-assigning Team B staff', async (savepoint) => {
      await savepoint`
        insert into workforce_memberships
          (organization_id, team_id, customer_id, role, status, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamBManager.id},
          'shift_lead', 'active', true)`;
    });
    const [managerGlobalTier] = await transaction`
      select count(*)::int as count from review_bonus_tiers
      where id = ${globalBonusTier.id}`;
    const [managerTeamBTier] = await transaction`
      select count(*)::int as count from review_bonus_tiers
      where id = ${teamBBonusTier.id}`;
    invariant(managerGlobalTier.count === 1 && managerTeamBTier.count === 0,
      'Team A manager bonus-tier visibility crossed the team boundary');
    await expectDatabaseError(transaction, ['42501'], 'manager cross-team automatic restock insert', async (savepoint) => {
      await savepoint`
        insert into restock_requests
          (organization_id, team_id, location_id, product_id, request_source,
           quantity_requested, is_dev_seed)
        values (${organization.id}, ${teamB.id}, ${locationB.id}, ${productB.id},
          'automatic_threshold', 2, true)`;
    });
    await expectDatabaseError(transaction, ['42501'], 'manager cross-team product insert', async (savepoint) => {
      await savepoint`
        insert into inventory_products
          (organization_id, team_id, sku, name, category, unit_label)
        values (${organization.id}, ${teamB.id}, 'VERIFY-CROSS', 'Cross team product',
          'general', 'each')`;
    });
    await expectDatabaseError(transaction, ['55000'], 'membership status rewrite without evidence', async (savepoint) => {
      await savepoint`
        update workforce_memberships set status = 'paused'
        where id = ${leadMembership.id}`;
    });
    await transaction`
      update workforce_memberships
      set status = 'paused', status_reason = 'Verifier access pause',
          status_changed_by_membership_id = ${managerMembership.id}, status_changed_at = now()
      where id = ${leadMembership.id}`;
    await transaction`
      update workforce_memberships
      set status = 'active', status_reason = 'Verifier access restored',
          status_changed_by_membership_id = ${managerMembership.id}, status_changed_at = now(),
          ended_at = null
      where id = ${leadMembership.id}`;

    const [jobCustomer] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('verified-job-customer@verify.invalid', 'Verified Job Customer',
        'customer', true)
      returning id`;
    const [wrongCustomer] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('wrong-review-customer@verify.invalid', 'Wrong Review Customer',
        'customer', true)
      returning id`;
    const [jobTerritory] = await transaction`
      insert into service_territories
        (code, name, timezone, status, travel_buffer_minutes, is_dev_seed)
      values ('national-verifier', 'National team verifier',
        'America/Los_Angeles', 'draft', 30, true)
      returning id`;
    const jobStart = '2030-08-05T16:00:00.000Z';
    const jobEnd = '2030-08-05T19:00:00.000Z';
    await transaction`
      insert into territory_postal_codes (territory_id, postal_code, status)
      values (${jobTerritory.id}, '83816', 'active')`;
    await transaction`
      update cleaners set home_territory_id = ${jobTerritory.id}
      where id in (${cleaner.id}, ${leadCleaner.id})`;
    await transaction`
      insert into cleaner_availability_rules
        (cleaner_id, territory_id, day_of_week, start_time, end_time,
         effective_from, status)
      values
        (${cleaner.id}, ${jobTerritory.id},
          extract(dow from ${jobStart}::timestamptz at time zone 'America/Los_Angeles')::integer,
          '08:00', '18:00', '2030-01-01', 'active'),
        (${leadCleaner.id}, ${jobTerritory.id},
          extract(dow from ${jobStart}::timestamptz at time zone 'America/Los_Angeles')::integer,
          '08:00', '18:00', '2030-01-01', 'active')`;
    await transaction`
      update service_territories set status = 'active'
      where id = ${jobTerritory.id}`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${owner.id}, true)`;
    await transaction`
      insert into team_service_territories
        (organization_id, team_id, territory_id, status, is_dev_seed)
      values
        (${organization.id}, ${teamA.id}, ${jobTerritory.id}, 'active', true),
        (${organization.id}, ${teamB.id}, ${jobTerritory.id}, 'active', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    const [teamBooking] = await transaction`
      insert into bookings
        (customer_id, service_id, scheduled_date, scheduled_window, status, contact,
         is_dev_seed, service_vertical, territory_id, qualification_status,
         estimated_duration_minutes, required_crew_size, required_skills)
      values (${jobCustomer.id}, 'estate', '2030-08-05', 'Verifier window', 'requested',
        ${transaction.json({ name: 'Verified Job Customer', email: 'verified-job-customer@verify.invalid', zip: '83816' })},
        true, 'estate', ${jobTerritory.id}, 'approved', 360, 2,
        array['estate_detail'])
      returning id`;
    const [teamSchedule] = await transaction`
      insert into job_schedules
        (booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${teamBooking.id}, ${jobTerritory.id}, 'estate', ${jobStart}, ${jobEnd},
        2, array['estate_detail'], 360, true)
      returning id`;
    await expectDatabaseError(transaction, ['23505'], 'second schedule for one booking', async (savepoint) => {
      await savepoint`
        insert into job_schedules
          (booking_id, territory_id, service_vertical, start_at, end_at,
           required_crew_size, required_skills, labor_minutes, is_dev_seed)
        values (${teamBooking.id}, ${jobTerritory.id}, 'estate',
          '2030-08-05T20:00:00.000Z', '2030-08-05T21:00:00.000Z',
          1, array['estate_detail'], 60, true)`;
    });
    const [staffLeadBooking] = await transaction`
      insert into bookings
        (customer_id, service_id, scheduled_date, scheduled_window, status, contact,
         is_dev_seed, service_vertical, territory_id, qualification_status,
         estimated_duration_minutes, required_crew_size, required_skills)
      values (${jobCustomer.id}, 'estate', '2030-08-05', 'Staff lead allocation', 'requested',
        ${transaction.json({ name: 'Staff lead allocation proof', email: 'verified-job-customer@verify.invalid', zip: '83816' })},
        true, 'estate', ${jobTerritory.id}, 'approved', 60, 1,
        array['estate_detail'])
      returning id`;
    const [staffLeadSchedule] = await transaction`
      insert into job_schedules
        (booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${staffLeadBooking.id}, ${jobTerritory.id}, 'estate',
        '2030-08-05T20:00:00.000Z', '2030-08-05T21:00:00.000Z',
        1, array['estate_detail'], 60, true)
      returning id`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${candidateManager.id}, true)`;
    await transaction`select private.lock_current_workforce_access(${candidateManager.id})`;
    await expectDatabaseError(transaction, ['42501'], 'shift lead creating disciplinary event', async (savepoint) => {
      await savepoint`
        insert into workforce_events
          (organization_id, team_id, subject_membership_id, event_type, severity,
           summary, created_by_membership_id, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${cleanerMembership.id},
          'termination', 'critical', 'Forbidden shift-lead disciplinary action',
          ${staffLeadMembership.id}, true)`;
    });
    await transaction`
      insert into workforce_events
        (organization_id, team_id, subject_membership_id, event_type, severity,
         summary, created_by_membership_id, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${cleanerMembership.id},
        'late', 'low', 'Verifier shift-lead operational observation',
        ${staffLeadMembership.id}, true)`;
    const [staffLeadCoverage] = await transaction`
      select private.lock_active_team_territory_coverage(
        ${organization.id}, ${teamA.id}, ${jobTerritory.id}
      ) as covered`;
    invariant(staffLeadCoverage.covered,
      'Staff-backed shift lead could not lock local territory coverage');
    const [staffLeadAllocation] = await transaction`
      insert into team_job_allocations
        (organization_id, team_id, job_schedule_id, assigned_by_membership_id,
         estimated_labor_minutes, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${staffLeadSchedule.id},
        ${staffLeadMembership.id}, 60, true)
      returning id`;
    const [staffLeadLockedAllocation] = await transaction`
      select id from team_job_allocations
      where id = ${staffLeadAllocation.id}
      for update`;
    invariant(staffLeadLockedAllocation.id === staffLeadAllocation.id,
      'Staff-backed shift lead could not allocate and lock local work');
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`
      insert into job_assignments
        (job_schedule_id, cleaner_id, team_id, assignment_role, status, is_dev_seed)
      values
        (${teamSchedule.id}, ${cleaner.id}, ${teamA.id}, 'member', 'accepted', true),
        (${teamSchedule.id}, ${leadCleaner.id}, ${teamA.id}, 'lead', 'accepted', true)`;
    await expectDatabaseError(transaction, ['23514'], 'cross-team schedule allocation', async (savepoint) => {
      await savepoint`
        insert into team_job_allocations
          (organization_id, team_id, job_schedule_id, assigned_by_membership_id,
           estimated_labor_minutes, is_dev_seed)
        values (${organization.id}, ${teamB.id}, ${teamSchedule.id},
          ${teamBManagerMembership.id}, 360, true)`;
    });
    const [teamAllocation] = await transaction`
      insert into team_job_allocations
        (organization_id, team_id, job_schedule_id, assigned_by_membership_id,
         estimated_labor_minutes, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamSchedule.id},
        ${managerMembership.id}, 360, true)
        returning id`;
    const [autoAssignedCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, contact, details, status, priority, is_dev_seed)
      values ('VERIFY-TEAM-CASE-A', 'complaint', ${teamBooking.id},
        ${transaction.json({ name: 'Verified Job Customer', email: 'verified-job-customer@verify.invalid' })},
        'Verifier team-isolation case', 'triaged', 'normal', true)
      returning id, assigned_team_id`;
    invariant(autoAssignedCase.assigned_team_id === teamA.id,
      'Allocated booking case did not inherit explicit Team A ownership');
    await expectDatabaseError(transaction, ['23514'], 'cross-team service-case ownership', async (savepoint) => {
      await savepoint`
        insert into service_cases
          (public_reference, case_type, booking_id, assigned_team_id, contact, details, status, priority, is_dev_seed)
        values ('VERIFY-TEAM-CASE-B', 'complaint', ${teamBooking.id}, ${teamB.id},
          ${savepoint.json({ name: 'Wrong team case' })}, 'Must be rejected',
          'triaged', 'normal', true)`;
    });
    const [bonusTier] = await transaction`
      insert into review_bonus_tiers
        (organization_id, team_id, name, minimum_rating, bonus_cents, is_dev_seed)
      values (${organization.id}, ${teamA.id}, 'Five-star verifier', 5, 2500, true)
      returning id`;
    await expectDatabaseError(transaction, ['23514'], 'review before job completion', async (savepoint) => {
      await savepoint`
        insert into quality_reviews
          (organization_id, team_id, team_job_allocation_id, cleaner_id, customer_id,
           rating, source, verified_at, evidence_reference,
           created_by_membership_id, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${cleaner.id},
          ${jobCustomer.id}, 5, 'verified_customer', now(), 'customer-response-early',
          ${managerMembership.id}, true)`;
    });
    await expectDatabaseError(transaction, ['23514'], 'review for cleaner who did not work job', async (savepoint) => {
      await savepoint`
        insert into quality_reviews
          (organization_id, team_id, team_job_allocation_id, cleaner_id,
           rating, source, verified_at, evidence_reference,
           created_by_membership_id, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${leadCleaner.id},
          5, 'quality_inspection', now(), 'inspection-without-assignment',
          ${managerMembership.id}, true)`;
    });

    await transaction`update job_schedules set status = 'held', version = version + 1
      where id = ${teamSchedule.id}`;
    await transaction`update job_schedules set status = 'confirmed', version = version + 1
      where id = ${teamSchedule.id}`;
    const [unassignedCleaner] = await transaction`
      insert into cleaners
        (full_name, email, status, screening_status, screening_verified_at,
         skills, vertical_experience, is_dev_seed)
      values ('Team A Unassigned Cleaner', 'team-a-unassigned@verify.invalid', 'active',
        'verified', now(), array['estate_detail'], array['estate'], true)
      returning id`;
    await transaction`
      insert into workforce_memberships
        (organization_id, team_id, cleaner_id, role, status, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${unassignedCleaner.id}, 'cleaner', 'active', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${unassignedCleaner.id}, true)`;
    await expectDatabaseError(transaction, ['42501'], 'unassigned cleaner forged time clock', async (savepoint) => {
      await savepoint`
        insert into job_time_entries
          (organization_id, team_id, team_job_allocation_id, cleaner_id,
           clock_in_at, estimated_minutes_snapshot, status, source, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${unassignedCleaner.id},
          clock_timestamp(), 180, 'open', 'crew_timer', true)`;
    });
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleaner.id}, true)`;
    const [cleanerTeamA] = await transaction`
      select count(*)::int as count from cleaning_teams where id = ${teamA.id}`;
    const [cleanerTeamB] = await transaction`
      select count(*)::int as count from cleaning_teams where id = ${teamB.id}`;
    invariant(cleanerTeamA.count === 1 && cleanerTeamB.count === 0,
      'Cleaner team isolation did not fail closed');
    await transaction`
      insert into inventory_transactions
        (organization_id, team_id, location_id, product_id, transaction_type,
         quantity_delta, balance_after, actor_membership_id, cleaner_id, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
        'usage', -1, 0, ${cleanerMembership.id}, ${cleaner.id}, true)`;
    await expectDatabaseError(transaction, ['42501'], 'cleaner forged inventory receipt', async (savepoint) => {
      await savepoint`
        insert into inventory_transactions
          (organization_id, team_id, location_id, product_id, transaction_type,
           quantity_delta, balance_after, actor_membership_id, cleaner_id, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
          'receipt', 5, 0, ${cleanerMembership.id}, ${cleaner.id}, true)`;
    });
    await expectDatabaseError(transaction, ['42501'], 'cleaner forged inventory adjustment', async (savepoint) => {
      await savepoint`
        insert into inventory_transactions
          (organization_id, team_id, location_id, product_id, transaction_type,
           quantity_delta, balance_after, actor_membership_id, cleaner_id, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
          'adjustment', 5, 0, ${cleanerMembership.id}, ${cleaner.id}, true)`;
    });
    const [cleanerLedger] = await transaction`
      select count(*)::int as count from inventory_transactions`;
    invariant(cleanerLedger.count === 1,
      'Cleaner must see only their own inventory ledger entries');
    await transaction`
      insert into restock_requests
        (organization_id, team_id, location_id, product_id,
         requested_by_membership_id, request_source, quantity_requested, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
        ${cleanerMembership.id}, 'cleaner', 4, true)`;
    const [cleanerRestocks] = await transaction`
      select count(*)::int as count,
        count(*) filter (where requested_by_membership_id = ${cleanerMembership.id})::int
          as own_count,
        count(*) filter (where request_source = 'automatic_threshold')::int
          as automatic_count
      from restock_requests`;
    invariant(
      cleanerRestocks.count === 2 && cleanerRestocks.own_count === 1 &&
        cleanerRestocks.automatic_count === 1,
      'Cleaner restock visibility must be limited to their request and team threshold drafts',
    );

    await expectDatabaseError(transaction, ['42501'], 'cleaner forged initial approval', async (savepoint) => {
      await savepoint`
        insert into job_time_entries
          (organization_id, team_id, team_job_allocation_id, cleaner_id,
           clock_in_at, clock_out_at, estimated_minutes_snapshot, status, source,
           approved_by_membership_id, approved_at, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${cleaner.id},
          clock_timestamp() - interval '1 hour', clock_timestamp(), 1, 'approved',
          'manager_entry', ${cleanerMembership.id}, clock_timestamp(), true)`;
    });
    await expectDatabaseError(transaction, ['42501'], 'cleaner forged initial estimate', async (savepoint) => {
      await savepoint`
        insert into job_time_entries
          (organization_id, team_id, team_job_allocation_id, cleaner_id,
           clock_in_at, estimated_minutes_snapshot, status, source, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${cleaner.id},
          clock_timestamp(), 60, 'open', 'crew_timer', true)`;
    });
    const [timeEntry] = await transaction`
      insert into job_time_entries
        (organization_id, team_id, team_job_allocation_id, cleaner_id,
         clock_in_at, estimated_minutes_snapshot, status, source, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${cleaner.id},
        clock_timestamp() - interval '4 minutes', 180, 'open', 'crew_timer', true)
      returning id`;
    await expectDatabaseError(transaction, ['42501'], 'cleaner self-approval of time', async (savepoint) => {
      await savepoint`
        update job_time_entries
        set clock_out_at = clock_timestamp(), status = 'approved',
            approved_by_membership_id = ${cleanerMembership.id}, approved_at = now(),
            version = version + 1
        where id = ${timeEntry.id}`;
    });
    await expectDatabaseError(transaction, ['42501'], 'cleaner rewriting time estimate', async (savepoint) => {
      await savepoint`
        update job_time_entries
        set clock_out_at = clock_timestamp(), status = 'submitted',
            estimated_minutes_snapshot = 60, version = version + 1
          where id = ${timeEntry.id}`;
    });
    await expectDatabaseError(transaction, ['23514'], 'break longer than elapsed shift', async (savepoint) => {
      await savepoint`
        update job_time_entries
        set clock_out_at = clock_timestamp(), break_minutes = 10,
            status = 'submitted', version = version + 1
        where id = ${timeEntry.id}`;
    });
    await transaction`
      update job_time_entries
      set clock_out_at = clock_timestamp(), break_minutes = 3,
          status = 'submitted', version = version + 1
      where id = ${timeEntry.id}`;
    const [teamTimeOff] = await transaction`
      insert into cleaner_time_off
        (organization_id, team_id, cleaner_id, start_at, end_at, status, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${cleaner.id},
        '2030-09-02T16:00:00.000Z', '2030-09-02T20:00:00.000Z',
        'requested', true)
      returning id`;
    await expectDatabaseError(transaction, ['42501'], 'cleaner cross-team time-off request', async (savepoint) => {
      await savepoint`
        insert into cleaner_time_off
          (organization_id, team_id, cleaner_id, start_at, end_at, status, is_dev_seed)
        values (${organization.id}, ${teamB.id}, ${cleaner.id},
          '2030-09-09T16:00:00.000Z', '2030-09-09T20:00:00.000Z',
          'requested', true)`;
    });

    await transaction`select set_config('lakeandpine.current_cleaner_id', ${leadCleaner.id}, true)`;
    await transaction`select private.lock_team_crew_memberships(
      ${organization.id}, ${teamA.id}
    )`;
    await expectDatabaseError(transaction, ['42501'], 'shift lead cross-team crew lock', async (savepoint) => {
      await savepoint`select private.lock_team_crew_memberships(
        ${organization.id}, ${teamB.id}
      )`;
    });
    await transaction`
      insert into inventory_transactions
        (organization_id, team_id, location_id, product_id, transaction_type,
         quantity_delta, balance_after, actor_membership_id, cleaner_id, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
        'usage', -1, 0, ${leadMembership.id}, ${leadCleaner.id}, true)`;
    await transaction`
      insert into restock_requests
        (organization_id, team_id, location_id, product_id,
         requested_by_membership_id, request_source, quantity_requested, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
        ${leadMembership.id}, 'cleaner', 2, true)`;
    await transaction`
      insert into workforce_events
        (organization_id, team_id, subject_membership_id, event_type, severity,
         summary, created_by_membership_id, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${leadMembership.id}, 'callout',
        'high', 'Verifier shift-lead callout', ${leadMembership.id}, true)`;
    const [leadTimeEntry] = await transaction`
      insert into job_time_entries
        (organization_id, team_id, team_job_allocation_id, cleaner_id,
         clock_in_at, estimated_minutes_snapshot, status, source, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${leadCleaner.id},
        clock_timestamp() - interval '4 minutes', 180, 'open', 'crew_timer', true)
      returning id`;
    await transaction`
      update job_time_entries
      set clock_out_at = clock_timestamp(), break_minutes = 3,
          status = 'submitted', version = version + 1
      where id = ${leadTimeEntry.id}`;

    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await expectDatabaseError(transaction, ['23514'], 'bonus inserted as already paid', async (savepoint) => {
      await savepoint`
        insert into bonus_awards
          (organization_id, team_id, workforce_membership_id, amount_cents,
           reason, status, approved_by_membership_id, approved_at,
           external_reference, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${cleanerMembership.id}, 500,
          'Forged paid bonus', 'recorded_paid', ${managerMembership.id}, now(),
          'FORGED-PAID', true)`;
    });
    await expectDatabaseError(transaction, ['42501'], 'manager self compensation control', async (savepoint) => {
      await savepoint`
        insert into compensation_rates
          (organization_id, team_id, workforce_membership_id, pay_basis,
           amount_cents, effective_from, status, created_by_membership_id,
           reason, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${managerMembership.id}, 'hourly',
          5000, current_date, 'active', ${managerMembership.id},
          'Forbidden self rate', true)`;
    });
    const [cleanerRestock] = await transaction`
      select id, version from restock_requests
      where requested_by_membership_id = ${cleanerMembership.id}
        and status = 'requested' limit 1`;
    await expectDatabaseError(transaction, ['55000'], 'restock lifecycle bypass', async (savepoint) => {
      await savepoint`
        update restock_requests
        set status = 'received', decision_by_membership_id = ${managerMembership.id},
            decided_at = now(), ordered_at = now(), received_at = now(),
            version = version + 1
        where id = ${cleanerRestock.id}`;
    });
    await transaction`
      update job_time_entries
      set status = 'approved', approved_by_membership_id = ${managerMembership.id},
          approved_at = now(), version = version + 1
      where id = ${timeEntry.id}`;
    await transaction`
      update job_time_entries
      set status = 'approved', approved_by_membership_id = ${managerMembership.id},
          approved_at = now(), version = version + 1
      where id = ${leadTimeEntry.id}`;
    await transaction`
      update cleaner_time_off
      set status = 'approved', reviewed_by_membership_id = ${managerMembership.id},
          reviewed_at = now(), reviewed_by_label = 'Verifier team manager'
      where id = ${teamTimeOff.id}`;
    const [approvedTeamTime] = await transaction`
      select status, approved_by_membership_id from job_time_entries
      where id = ${timeEntry.id}`;
    invariant(approvedTeamTime.status === 'approved' &&
      approvedTeamTime.approved_by_membership_id === managerMembership.id,
      'Manager could not approve submitted local-team time');

    for (const scheduleStatus of ['held', 'confirmed', 'en_route', 'in_progress',
      'quality_review', 'completed']) {
      await transaction`
        update job_schedules set status = ${scheduleStatus}, version = version + 1
        where id = ${teamSchedule.id}`;
    }
    await expectDatabaseError(transaction, ['23514'], 'verified review from wrong customer', async (savepoint) => {
      await savepoint`
        insert into quality_reviews
          (organization_id, team_id, team_job_allocation_id, cleaner_id, customer_id,
           rating, source, verified_at, evidence_reference,
           created_by_membership_id, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${cleaner.id},
          ${wrongCustomer.id}, 5, 'verified_customer', now(), 'wrong-customer-response',
          ${managerMembership.id}, true)`;
    });
    const [qualityReview] = await transaction`
      insert into quality_reviews
        (organization_id, team_id, team_job_allocation_id, cleaner_id, customer_id,
         rating, source, verified_at, evidence_reference,
         created_by_membership_id, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${cleaner.id},
        ${jobCustomer.id}, 5, 'verified_customer', now(), 'verified-customer-response',
        ${managerMembership.id}, true)
      returning id`;
    const [qualityBonus] = await transaction`
      select count(*)::int as count, max(amount_cents)::int as amount_cents
      from bonus_awards
      where quality_review_id = ${qualityReview.id} and bonus_tier_id = ${bonusTier.id}`;
    invariant(qualityBonus.count === 1 && qualityBonus.amount_cents === 2500,
      'Completed verified customer review did not create exactly one configured bonus');
  });
}

async function inspectAccessRevocationConcurrency(sql) {
  const [actor] = await sql`
    select customer.id as customer_id, membership.id as membership_id,
           membership.organization_id
    from customers customer
    join workforce_memberships membership on membership.customer_id = customer.id
    where customer.email = 'team-manager@verify.invalid'
      and membership.role = 'manager'
      and membership.status = 'active'`;
  invariant(actor, 'Revocation concurrency manager fixture is missing');
  const [owner] = await sql`
    select membership.id
    from workforce_memberships membership
    where membership.organization_id = ${actor.organization_id}
      and membership.role = 'owner'
      and membership.status = 'active'`;
  invariant(owner, 'Revocation concurrency owner fixture is missing');

  let confirmLock;
  const lockAcquired = new Promise((resolve) => { confirmLock = resolve; });
  let releaseLock;
  const mayCommit = new Promise((resolve) => { releaseLock = resolve; });
  const holder = sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', ${actor.customer_id}, true)`;
    await transaction`select private.lock_current_workforce_access(${actor.customer_id})`;
    confirmLock();
    await mayCommit;
  });

  await lockAcquired;
  const revoker = sql.begin(async (transaction) => {
    await transaction`
      update workforce_memberships
      set status = 'paused', status_reason = 'Verifier authorization revocation',
          status_changed_by_membership_id = ${owner.id}, status_changed_at = now()
      where id = ${actor.membership_id}`;
  });
  const earlyResult = await Promise.race([
    revoker.then(() => 'revoked'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
  ]);
  invariant(
    earlyResult === 'blocked',
    'Membership revocation must wait for an in-flight actor transaction',
  );
  releaseLock();
  await Promise.all([holder, revoker]);

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', ${actor.customer_id}, true)`;
    await transaction`select private.lock_current_workforce_access(${actor.customer_id})`;
    const [access] = await transaction`
      select count(*)::int as count
      from workforce_memberships
      where customer_id = ${actor.customer_id} and status = 'active'`;
    invariant(access.count === 0,
      'A revoked manager must not retain active access in the next transaction');
  });
}

async function inspectTeamAssignmentConcurrency(sql) {
  const managers = await sql`
    select customer.id as customer_id, membership.organization_id,
           membership.team_id
    from customers customer
    join workforce_memberships membership on membership.customer_id = customer.id
    where customer.email in ('team-manager@verify.invalid', 'team-b-manager@verify.invalid')
      and membership.role = 'manager' and membership.status = 'active'
    order by customer.email`;
  invariant(managers.length === 2,
    'Concurrent clean-room assignment managers are missing');
  const [candidate] = await sql`
    insert into customers (email, full_name, role, is_dev_seed)
    values ('assignment-race@verify.invalid', 'Assignment Race Candidate', 'staff', true)
    returning id`;

  let confirmIdentityLock;
  const identityLocked = new Promise((resolve) => { confirmIdentityLock = resolve; });
  let releaseIdentityLock;
  const mayRelease = new Promise((resolve) => { releaseIdentityLock = resolve; });
  const holder = sql.begin(async (transaction) => {
    await transaction`select id from customers where id = ${candidate.id} for update`;
    confirmIdentityLock();
    await mayRelease;
  });
  await identityLocked;

  const attemptsPromise = Promise.allSettled(managers.map((manager) =>
    sql.begin(async (transaction) => {
      await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
      await transaction`select set_config('lakeandpine.current_customer_id', ${manager.customer_id}, true)`;
      await transaction`
        insert into workforce_memberships
          (organization_id, team_id, customer_id, role, status, is_dev_seed)
        values (${manager.organization_id}, ${manager.team_id}, ${candidate.id},
          'shift_lead', 'active', true)`;
    }),
  ));
  const earlyResult = await Promise.race([
    attemptsPromise.then(() => 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
  ]);
  invariant(earlyResult === 'blocked',
    'Concurrent team assignments did not wait on the subject identity lock');
  releaseIdentityLock();
  const attempts = await attemptsPromise;
  await holder;
  invariant(
    attempts.filter((attempt) => attempt.status === 'fulfilled').length === 1
      && attempts.filter((attempt) => attempt.status === 'rejected').length === 1,
    'Concurrent local managers must not assign one person to two team clean rooms',
  );
  const [membershipCount] = await sql`
    select count(*)::int as count from workforce_memberships
    where customer_id = ${candidate.id} and status = 'active'`;
  invariant(membershipCount.count === 1,
    'Concurrent team assignment created more than one active membership');
}

const bootstrapUrl = process.env.MIGRATION_DATABASE_URL;
const { target, database } = validateTarget(bootstrapUrl);
const migrations = await loadMigrations();
const bootstrapSql = postgres(bootstrapUrl, { max: 1, onnotice: () => {} });
let sql;

try {
  const [server] = await bootstrapSql`
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

  const existingTables = await bootstrapSql`
    select table_class.relname as table_name
    from pg_class table_class
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relkind in ('r', 'p')`;
  invariant(
    existingTables.length === 0,
    `Verification requires a fresh database; found public tables: ${existingTables.map((row) => row.table_name).join(", ")}`,
  );
  const hosted = await createHostedMigrationRunner(
    bootstrapSql,
    bootstrapUrl,
    database,
  );
  sql = hosted.runnerSql;
  await inspectHostedRoleCreationCompatibility(bootstrapSql, sql, migrations);
  await seedProductionLikeApplicationRole(bootstrapSql);
  await inspectHostedRoleGuardRejections(bootstrapSql, sql, migrations);
  await applyMigrations(sql, migrations);
  await assertSafeRole(sql, true);

  const access = await inspectApplicationRoleAccess(sql);
  const hardening = await inspectProductionHardening(sql);
  const atomicIntake = await inspectAtomicIntakeFunctions(sql);
  const failures = [
    ...access.failures,
    ...hardening.failures,
    ...atomicIntake.failures,
  ];
  invariant(
    failures.length === 0,
    `Migration verification failed:\n- ${failures.join("\n- ")}`,
  );
  const runtimeIdentity = await inspectRuntimeConnection(
    hosted.runnerUrl,
    access.operationsTables,
  );
  await inspectOperationalInvariants(sql);
  await inspectOwnerBootstrapConcurrency(sql);
  await inspectNationalTeamOperations(sql);
  await inspectTeamAssignmentConcurrency(sql);
  await inspectAccessRevocationConcurrency(sql);

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
    productionHardening: {
      postalFunctionSearchPath: hardening.functionSearchPath,
      duplicatePermissivePolicies: hardening.duplicatePermissivePolicies,
      applicationCatalogTablesVisible: hardening.applicationCatalogTablesVisible,
      publicCatalogRoleReads: hardening.publicCatalogRoleReads,
      unindexedForeignKeys: hardening.unindexedForeignKeys,
    },
    atomicIntakeFunctions: atomicIntake.functions.length > 0
      ? atomicIntake.functions.map((candidate) => candidate.signature)
      : "none discovered; add a function name matching create*booking/booking*create or an 'atomic intake' function comment",
    operationalInvariants: "postal eligibility, team territory dispatch, case-team isolation, labor, schedule and recovery lifecycle, availability and approved PTO, cancellation, refunds, concurrent owner bootstrap, race-safe team clean rooms, owner/GM/manager hierarchy, downward-only financial and workforce authority, scoped actor attribution, team job allocation, ledger-controlled stock, guarded restock receipts, cleaner and shift-lead time with nonzero breaks, rejected forged time/bonus states, self-financial controls, and completed-job verified-review bonuses verified",
  }, null, 2));
} finally {
  if (sql) await sql.end({ timeout: 5 });
  await bootstrapSql.end({ timeout: 5 });
}
