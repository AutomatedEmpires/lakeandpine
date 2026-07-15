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
const INTELLIGENT_FIELD_MIGRATION = "20260714173819_intelligent_field_operations.sql";
const EXACT_FIELD_ACTOR_MIGRATION = "20260714223000_exact_field_actor_evidence.sql";
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
const RESTRICTED_APPLICATION_TABLE_ACCESS = {
  bookings: {
    tablePrivileges: ["SELECT", "INSERT", "DELETE"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      UPDATE: [
        "customer_id", "status", "qualification_status",
        "qualification_requirements", "scheduled_date", "scheduled_window",
      ],
    },
  },
  customers: {
    tablePrivileges: [],
    policyCommands: ["SELECT"],
    selectColumns: [
      "id", "email", "full_name", "phone", "role", "referral_credit_cents",
      "is_dev_seed", "created_at", "updated_at",
    ],
  },
  cleaners: {
    tablePrivileges: ["INSERT", "UPDATE"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    selectColumns: [
      "id", "full_name", "email", "phone", "status", "engagement_type",
      "screening_status", "screening_verified_at", "home_territory_id", "skills",
      "vertical_experience", "max_daily_minutes", "max_weekly_minutes",
      "max_daily_jobs", "travel_buffer_minutes", "is_dev_seed", "created_at",
      "updated_at",
    ],
  },
  cleaner_applications: {
    tablePrivileges: ["SELECT", "UPDATE"],
    policyCommands: ["SELECT", "UPDATE"],
  },
  request_rate_limits: { tablePrivileges: [], policyCommands: [] },
  homes: {
    tablePrivileges: ["SELECT", "UPDATE"],
    policyCommands: ["SELECT", "UPDATE"],
  },
  billing_records: {
    tablePrivileges: [],
    policyCommands: ["SELECT"],
    selectColumns: [
      "id", "customer_id", "booking_id", "description", "amount_cents",
      "status", "occurred_at", "is_dev_seed",
    ],
  },
  refund_records: {
    tablePrivileges: ["SELECT", "DELETE"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "service_case_id", "booking_id", "billing_record_id", "amount_cents",
        "reason_code",
      ],
      UPDATE: [
        "status", "provider_refund_id", "failure_code", "operator_note",
      ],
    },
  },
  support_messages: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT"],
    columnPrivileges: {
      INSERT: ["customer_id", "sender", "body"],
    },
  },
  internal_notes: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT"],
    columnPrivileges: {
      INSERT: ["booking_id", "body"],
    },
  },
  follow_ups: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE"],
    columnPrivileges: {
      INSERT: ["booking_id", "kind", "channel", "scheduled_for"],
      UPDATE: ["status"],
    },
  },
  service_territories: {
    tablePrivileges: ["INSERT", "UPDATE", "DELETE"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    selectColumns: [
      "id", "code", "name", "timezone", "status", "travel_buffer_minutes",
      "is_dev_seed", "created_at", "updated_at",
    ],
  },
  territory_postal_codes: {
    tablePrivileges: ["INSERT", "UPDATE", "DELETE"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    selectColumns: ["territory_id", "postal_code", "status", "created_at"],
  },
  cleaner_availability_rules: {
    tablePrivileges: ["SELECT", "INSERT", "UPDATE"],
    policyCommands: ["SELECT", "INSERT", "UPDATE"],
  },
  workforce_memberships: {
    tablePrivileges: ["SELECT", "INSERT", "DELETE"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      UPDATE: ["status", "ended_at", "status_reason"],
    },
  },
  job_time_entries: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "team_job_allocation_id", "cleaner_id",
        "clock_in_at", "clock_out_at", "break_minutes",
        "estimated_minutes_snapshot", "status", "source", "adjustment_reason",
      ],
      UPDATE: [
        "clock_out_at", "break_minutes", "status", "adjustment_reason",
        "review_reason",
      ],
    },
  },
  cleaner_time_off: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "cleaner_id", "start_at", "end_at",
        "reason_category", "private_note",
      ],
      UPDATE: ["status", "review_reason"],
    },
  },
  team_job_allocations: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: ["organization_id", "team_id", "job_schedule_id"],
    },
  },
  inventory_products: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "sku", "name", "brand", "category",
        "unit_label", "pack_size", "preferred_vendor", "purchase_url",
        "image_url", "safety_sheet_url", "unit_cost_cents",
        "automatic_reorder_enabled", "active",
      ],
      UPDATE: [
        "sku", "name", "brand", "category", "unit_label", "pack_size",
        "preferred_vendor", "purchase_url", "image_url", "safety_sheet_url",
        "unit_cost_cents", "automatic_reorder_enabled", "active",
      ],
    },
  },
  inventory_transactions: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "location_id", "product_id",
        "transaction_type", "quantity_delta", "team_job_allocation_id", "note",
      ],
    },
  },
  restock_requests: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "location_id", "product_id",
        "request_source", "quantity_requested",
      ],
      UPDATE: ["status", "decision_note"],
    },
  },
  compensation_rates: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "workforce_membership_id", "pay_basis",
        "amount_cents", "currency", "effective_from", "reason",
      ],
      UPDATE: ["status", "effective_to"],
    },
  },
  quality_reviews: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "team_job_allocation_id", "cleaner_id",
        "customer_id", "rating", "source", "evidence_reference",
        "private_note", "is_dev_seed",
      ],
    },
  },
  bonus_awards: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "workforce_membership_id",
        "quality_review_id", "bonus_tier_id", "amount_cents", "reason",
      ],
      UPDATE: ["status", "external_reference"],
    },
  },
  workforce_events: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "subject_membership_id", "event_type",
        "severity", "summary", "private_details",
      ],
      UPDATE: ["status", "appeal_note", "resolution_note"],
    },
  },
  service_location_assessments: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "booking_id", "organization_id", "address_fingerprint",
        "branch_origin_label", "branch_origin_latitude", "branch_origin_longitude",
        "property_latitude", "property_longitude", "distance_miles",
        "standard_radius_miles", "calculation_method", "assessment_status",
        "provider", "provider_resolved_address", "provider_match_confidence",
        "provider_coordinate_accuracy", "calculated_at", "is_dev_seed",
      ],
      UPDATE: ["assessment_status", "override_reason"],
    },
  },
  schedule_proposals: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "team_job_allocation_id",
        "job_schedule_id", "service_case_id", "proposed_start_at",
        "proposed_end_at", "customer_id", "arrival_window_start",
        "arrival_window_end", "proposal_note", "expires_at", "is_dev_seed",
      ],
      UPDATE: ["status", "customer_response_note"],
    },
  },
  job_communications: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "team_job_allocation_id", "customer_id",
        "sender_kind", "audience", "template_key", "body", "is_dev_seed",
      ],
    },
  },
  mileage_entries: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "cleaner_id", "team_job_allocation_id",
        "service_date", "miles", "purpose", "vehicle_label", "note",
        "is_dev_seed",
      ],
      UPDATE: [
        "service_date", "miles", "purpose", "vehicle_label", "note", "status",
        "review_note",
      ],
    },
  },
  job_issue_reports: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "team_job_allocation_id", "issue_type",
        "severity", "summary", "private_details", "is_dev_seed",
      ],
      UPDATE: ["status", "customer_visible", "resolution_note"],
    },
  },
  team_duty_assignments: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "workforce_membership_id", "starts_at",
        "ends_at", "duty_kind", "note", "is_dev_seed",
      ],
      UPDATE: ["status"],
    },
  },
  tip_intents: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    columnPrivileges: {
      INSERT: [
        "organization_id", "team_id", "team_job_allocation_id", "customer_id",
        "cleaner_id", "amount_cents", "note", "is_dev_seed",
      ],
      UPDATE: ["amount_cents", "note", "status", "provider_reference"],
    },
  },
  service_case_events: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT"],
  },
  service_recovery_actions: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT", "INSERT", "UPDATE"],
    columnPrivileges: {
      INSERT: [
        "service_case_id", "action_type", "scheduled_at", "value_cents",
        "notes",
      ],
      UPDATE: ["status"],
    },
  },
  booking_events: {
    tablePrivileges: ["SELECT", "INSERT"],
    policyCommands: ["SELECT", "INSERT"],
  },
  operations_state_events: { tablePrivileges: [], policyCommands: [] },
  quotes: { tablePrivileges: [], policyCommands: [] },
  leads: { tablePrivileges: [], policyCommands: [] },
  rooms: { tablePrivileges: [], policyCommands: [] },
  cleaning_team_members: { tablePrivileges: [], policyCommands: [] },
  notification_outbox: {
    tablePrivileges: ["SELECT"],
    policyCommands: ["SELECT"],
  },
  stripe_event_receipts: { tablePrivileges: [], policyCommands: [] },
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
  cleaning_teams: [
    "id", "organization_id", "service_radius_miles", "operating_start_time",
    "latest_arrival_time", "hard_finish_time",
  ],
  service_location_assessments: [
    "id", "booking_id", "organization_id", "team_id", "assessment_status",
    "distance_miles", "provider_resolved_address", "provider_match_confidence",
    "provider_coordinate_accuracy", "override_by_membership_id", "override_reason",
  ],
  schedule_proposals: [
    "id", "team_job_allocation_id", "job_schedule_id", "customer_id",
    "service_case_id", "proposed_start_at", "proposed_end_at",
    "arrival_window_start", "arrival_window_end", "status", "version",
  ],
  customer_cleaner_preferences: [
    "id", "team_id", "customer_id", "cleaner_id", "preference",
  ],
  job_communications: [
    "id", "team_job_allocation_id", "sender_kind", "audience", "body",
    "delivery_status",
  ],
  mileage_entries: [
    "id", "team_id", "cleaner_id", "miles", "purpose", "status",
  ],
  job_issue_reports: [
    "id", "team_id", "issue_type", "severity", "summary", "status",
  ],
  team_duty_assignments: [
    "id", "team_id", "workforce_membership_id", "starts_at", "ends_at",
  ],
  tip_intents: [
    "id", "team_job_allocation_id", "customer_id", "cleaner_id",
    "amount_cents", "status", "version", "provider_reference",
  ],
  service_case_events: [
    "id", "service_case_id", "actor_label", "actor_membership_id",
  ],
  operations_state_events: [
    "id", "entity_type", "entity_id", "actor_role", "actor_membership_id",
  ],
};
const REQUIRED_PRIVATE_SCHEMA = {
  legacy_field_execution_continuity: [
    "job_schedule_id", "organization_id", "team_id",
    "team_job_allocation_id", "original_status", "original_start_at",
    "original_end_at", "migration_key",
  ],
  service_location_assessment_decisions: [
    "id", "assessment_id", "booking_id", "organization_id", "team_id",
    "decision_kind", "prior_status", "resulting_status", "schedule_status",
    "actor_membership_id", "reason", "distance_miles",
    "standard_radius_miles", "branch_origin_label", "created_at",
  ],
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function routeAddressFingerprint(address) {
  const normalized = [
    address.street,
    address.unit,
    address.city,
    address.state,
    address.zip,
    "US",
  ]
    .filter(Boolean)
    .join(", ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
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
  await sql`create schema if not exists migration_verification`;
  await sql`
    create table if not exists migration_verification.applied_migrations (
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

async function seedIntelligentFieldUpgradeFixtures(sql) {
  return sql.begin(async (transaction) => {
    const [organization] = await transaction`
      select id from organizations where slug = 'lake-and-pine'`;
    invariant(organization?.id,
      'Pre-final migration organization is missing for staged-upgrade verification');
    const [team] = await transaction`
      insert into cleaning_teams
        (organization_id, code, name, timezone, status, is_dev_seed)
      values (${organization.id}, 'upgrade-field-team',
        'Upgrade field verifier team', 'America/Los_Angeles', 'active', true)
      returning id`;
    const [manager] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('upgrade-field-manager@verify.invalid',
        'Upgrade Field Manager', 'staff', true)
      returning id`;
    const [managerMembership] = await transaction`
      insert into workforce_memberships
        (organization_id, team_id, customer_id, role, status, is_dev_seed)
      values (${organization.id}, ${team.id}, ${manager.id}, 'manager', 'active', true)
      returning id`;
    const [territory] = await transaction`
      insert into service_territories
        (code, name, timezone, status, travel_buffer_minutes, is_dev_seed)
      values ('upgrade-field-territory', 'Upgrade field territory',
        'America/Los_Angeles', 'draft', 30, true)
      returning id`;
    await transaction`
      insert into territory_postal_codes (territory_id, postal_code, status)
      values (${territory.id}, '83815', 'active')`;
    const [cleaner] = await transaction`
      insert into cleaners
        (full_name, email, status, home_territory_id,
         screening_status, screening_verified_at, skills,
         vertical_experience, is_dev_seed)
      values ('Upgrade Field Cleaner', 'upgrade-field-cleaner@verify.invalid',
        'active', ${territory.id}, 'verified', now(), array['estate_detail'],
        array['estate'], true)
      returning id`;
    await transaction`
      insert into workforce_memberships
        (organization_id, team_id, cleaner_id, role, status, is_dev_seed)
      values (${organization.id}, ${team.id}, ${cleaner.id},
        'cleaner', 'active', true)`;
    await transaction`
      insert into cleaner_availability_rules
        (cleaner_id, territory_id, day_of_week, start_time, end_time,
         effective_from, status)
      values (${cleaner.id}, ${territory.id}, 1, '08:00', '18:00',
        '2030-01-01', 'active')`;
    await transaction`
      update service_territories set status = 'active' where id = ${territory.id}`;
    await transaction`
      insert into team_service_territories
        (organization_id, team_id, territory_id, status, is_dev_seed)
      values (${organization.id}, ${team.id}, ${territory.id}, 'active', true)`;
    const [customer] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('upgrade-field-customer@verify.invalid',
        'Upgrade Field Customer', 'customer', true)
      returning id`;

    const definitions = [
      {
        key: 'future_confirmed',
        date: '2031-01-06',
        startAt: '2031-01-06T17:00:00.000Z',
        endAt: '2031-01-06T18:00:00.000Z',
        finalStatus: 'confirmed',
      },
      {
        key: 'in_progress',
        date: '2031-01-13',
        startAt: '2031-01-13T17:00:00.000Z',
        endAt: '2031-01-13T18:00:00.000Z',
        finalStatus: 'in_progress',
      },
      {
        key: 'quality_review',
        date: '2031-01-20',
        startAt: '2031-01-20T17:00:00.000Z',
        endAt: '2031-01-20T18:00:00.000Z',
        finalStatus: 'quality_review',
      },
    ];
    const fixtures = {};
    for (const definition of definitions) {
      const [booking] = await transaction`
        insert into bookings
          (customer_id, service_id, scheduled_date, scheduled_window, status,
           contact, is_dev_seed, service_vertical, territory_id,
           qualification_status, estimated_duration_minutes,
           required_crew_size, required_skills)
        values (${customer.id}, 'estate', ${definition.date},
          ${`Upgrade ${definition.key}`}, 'requested',
          ${transaction.json({
            name: `Upgrade ${definition.key}`,
            email: 'upgrade-field-customer@verify.invalid',
            street: `${definition.date.slice(-2)} Upgrade Way`,
            city: "Coeur d'Alene",
            state: 'ID',
            zip: '83815',
          })}, true, 'estate', ${territory.id}, 'approved', 60, 1,
          array['estate_detail'])
        returning id`;
      const [schedule] = await transaction`
        insert into job_schedules
          (booking_id, territory_id, service_vertical, start_at, end_at,
           required_crew_size, required_skills, labor_minutes, is_dev_seed)
        values (${booking.id}, ${territory.id}, 'estate', ${definition.startAt},
          ${definition.endAt}, 1, array['estate_detail'], 60, true)
        returning id`;
      await transaction`
        insert into job_assignments
          (job_schedule_id, cleaner_id, team_id, assignment_role, status, is_dev_seed)
        values (${schedule.id}, ${cleaner.id}, ${team.id}, 'lead', 'accepted', true)`;
      if (definition.finalStatus === 'in_progress'
        || definition.finalStatus === 'quality_review') {
        await transaction`
          insert into checklist_items
            (booking_id, room_label, label, state, sort, completed_at, is_dev_seed)
          values (${booking.id}, 'Legacy verified scope',
            'Pre-upgrade field checklist evidence', 'completed', 0,
            ${definition.endAt}, true)`;
      }
      const [allocation] = await transaction`
        insert into team_job_allocations
          (organization_id, team_id, job_schedule_id, assigned_by_membership_id,
           estimated_labor_minutes, is_dev_seed)
        values (${organization.id}, ${team.id}, ${schedule.id},
          ${managerMembership.id}, 60, true)
        returning id`;
      const transitionPath = ['held', 'confirmed', 'en_route', 'in_progress', 'quality_review'];
      for (const status of transitionPath) {
        if (status === 'en_route' && definition.finalStatus === 'confirmed') break;
        if (status === 'quality_review' && definition.finalStatus === 'in_progress') break;
        await transaction`
          update job_schedules set status = ${status}, version = version + 1
          where id = ${schedule.id}`;
        if (status === definition.finalStatus) break;
      }
      fixtures[definition.key] = {
        bookingId: booking.id,
        scheduleId: schedule.id,
        allocationId: allocation.id,
      };
    }
    const legacyActiveReschedules = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, priority, is_dev_seed)
      values
        ('VERIFY-UPGRADE-RESCHEDULE-OLDER', 'reschedule',
          ${fixtures.future_confirmed.bookingId}, ${customer.id}, ${team.id},
          '{}'::jsonb, 'Older duplicate active upgrade reschedule',
          'submitted', 'normal', true),
        ('VERIFY-UPGRADE-RESCHEDULE-NEWER', 'reschedule',
          ${fixtures.future_confirmed.bookingId}, ${customer.id}, ${team.id},
          '{}'::jsonb, 'Newer duplicate active upgrade reschedule',
          'investigating', 'normal', true)
      returning id`;
    return {
      organizationId: organization.id,
      teamId: team.id,
      managerCustomerId: manager.id,
      managerMembershipId: managerMembership.id,
      legacyActiveRescheduleIds: legacyActiveReschedules.map((row) => row.id),
      ...fixtures,
    };
  });
}

async function inspectIntelligentFieldUpgradeBackfill(sql, fixture) {
  const fixtureScheduleIds = [
    fixture.future_confirmed.scheduleId,
    fixture.in_progress.scheduleId,
    fixture.quality_review.scheduleId,
  ];
  const assessments = await sql`
    select schedule.id as schedule_id, schedule.status,
      assessment.organization_id, assessment.team_id,
      assessment.calculation_method, assessment.assessment_status,
      assessment.provider, assessment.property_latitude,
      assessment.property_longitude, assessment.override_by_membership_id,
      assessment.override_reason
    from job_schedules schedule
    join service_location_assessments assessment
      on assessment.booking_id = schedule.booking_id
    where schedule.id in ${sql(fixtureScheduleIds)}`;
  invariant(
    assessments.length === 3
      && assessments.every((row) =>
        row.organization_id === fixture.organizationId
        && row.team_id === fixture.teamId
        && row.calculation_method === 'manual_review'
        && row.assessment_status === 'manual_review'
        && row.provider === 'manual'
        && row.property_latitude === null
        && row.property_longitude === null
        && row.override_by_membership_id === null
        && row.override_reason === null),
    'Upgrade backfill did not create one fail-closed manual-review assessment per allocated job',
  );

  const legacyReschedules = await sql`
    select id, status, resolution_type, resolution_summary
    from service_cases
    where id in ${sql(fixture.legacyActiveRescheduleIds)}`;
  const activeLegacyReschedules = legacyReschedules.filter((row) =>
    !['resolved', 'closed', 'declined', 'canceled'].includes(row.status));
  const canceledLegacyReschedules = legacyReschedules.filter((row) =>
    row.status === 'canceled');
  const [activeRescheduleIndex] = await sql`
    select indexdef
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'service_cases_one_active_reschedule_per_booking_idx'`;
  invariant(
    legacyReschedules.length === 2
      && activeLegacyReschedules.length === 1
      && canceledLegacyReschedules.length === 1
      && canceledLegacyReschedules[0].resolution_type === 'no_action'
      && canceledLegacyReschedules[0].resolution_summary
        === 'Superseded duplicate reschedule request during field-operations upgrade.'
      && activeRescheduleIndex?.indexdef.includes('UNIQUE')
      && activeRescheduleIndex.indexdef.includes("case_type = 'reschedule'")
      && activeRescheduleIndex.indexdef.includes("status <> ALL"),
    'Upgrade did not deduplicate legacy active reschedules before adding the partial unique invariant',
  );

  const continuity = await sql`
    select job_schedule_id, team_job_allocation_id, original_status,
      original_start_at::text, original_end_at::text, migration_key
    from private.legacy_field_execution_continuity
    where job_schedule_id in ${sql(fixtureScheduleIds)}
    order by original_status, job_schedule_id`;
  const continuityBySchedule = new Map(
    continuity.map((row) => [row.job_schedule_id, row]),
  );
  invariant(
    continuity.length === 2
      && !continuityBySchedule.has(fixture.future_confirmed.scheduleId)
      && continuityBySchedule.get(fixture.in_progress.scheduleId)?.original_status === 'in_progress'
      && continuityBySchedule.get(fixture.quality_review.scheduleId)?.original_status === 'quality_review'
      && continuity.every((row) =>
        row.migration_key === '20260714173819_intelligent_field_operations'),
    'Legacy execution continuity was not limited to physically under-way schedules',
  );
  const [privateAccess] = await sql`
    select has_table_privilege(
        ${APP_ROLE}, 'private.legacy_field_execution_continuity', 'SELECT'
      ) as table_select`;
  invariant(
    !privateAccess.table_select,
    'Application role can directly inspect the private legacy-continuity ledger',
  );

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.managerCustomerId}, true
      )`;
    await expectDatabaseError(transaction, ['P0001'], 'future confirmed upgrade job without real window approval', async (savepoint) => {
      await savepoint`
        update service_location_assessments
        set assessment_status = 'approved_exception',
            override_by_membership_id = ${fixture.managerMembershipId},
            override_reason = 'Upgrade verifier route exception only'
        where booking_id = ${fixture.future_confirmed.bookingId}`;
      await savepoint`
        update job_schedules set status = 'en_route', version = version + 1
        where id = ${fixture.future_confirmed.scheduleId}`;
    });
    await expectDatabaseError(transaction, ['P0001'], 'in-progress upgrade job before route review', async (savepoint) => {
      await savepoint`
        update job_schedules set status = 'quality_review', version = version + 1
        where id = ${fixture.in_progress.scheduleId}`;
    });
    await transaction`
      update service_location_assessments
      set assessment_status = 'approved_exception',
          override_by_membership_id = ${fixture.managerMembershipId},
          override_reason = 'Upgrade verifier in-progress route review'
      where booking_id = ${fixture.in_progress.bookingId}`;
    await expectDatabaseError(transaction, ['55000'], 'in-progress legacy route approval replay', async (savepoint) => {
      await savepoint`
        update service_location_assessments
        set override_reason = 'Forbidden replay of the in-progress route approval'
        where booking_id = ${fixture.in_progress.bookingId}`;
    });
    await transaction`
      update job_schedules set status = 'quality_review', version = version + 1
      where id = ${fixture.in_progress.scheduleId}`;
    await expectDatabaseError(transaction, ['P0001'], 'quality-review upgrade job before route review', async (savepoint) => {
      await savepoint`
        update job_schedules set status = 'completed', version = version + 1
        where id = ${fixture.quality_review.scheduleId}`;
    });
    await transaction`
      update service_location_assessments
      set assessment_status = 'approved_exception',
          override_by_membership_id = ${fixture.managerMembershipId},
          override_reason = 'Upgrade verifier quality-review route review'
      where booking_id = ${fixture.quality_review.bookingId}`;
    await transaction`
      update job_schedules set status = 'completed', version = version + 1
      where id = ${fixture.quality_review.scheduleId}`;
    await expectDatabaseError(transaction, ['55000'], 'completed legacy route decision rewrite', async (savepoint) => {
      await savepoint`
        update service_location_assessments
        set override_reason = 'Forbidden rewrite after legacy completion'
        where booking_id = ${fixture.quality_review.bookingId}`;
    });
    const [forwardState] = await transaction`
      select
        (select status from job_schedules
          where id = ${fixture.future_confirmed.scheduleId}) as confirmed_status,
        (select status from job_schedules
          where id = ${fixture.in_progress.scheduleId}) as in_progress_status,
        (select status from job_schedules
          where id = ${fixture.quality_review.scheduleId}) as quality_status`;
    invariant(
      forwardState.confirmed_status === 'confirmed'
        && forwardState.in_progress_status === 'quality_review'
        && forwardState.quality_status === 'completed',
      'Legacy continuity did not preserve only reviewed forward execution',
    );
    await transaction.unsafe('reset role');
    const legacyRouteDecisions = await transaction`
      select assessment.booking_id, decision.decision_kind,
        decision.prior_status, decision.resulting_status,
        decision.schedule_status, decision.actor_membership_id, decision.reason
      from private.service_location_assessment_decisions decision
      join service_location_assessments assessment
        on assessment.id = decision.assessment_id
      where assessment.booking_id in (
        ${fixture.future_confirmed.bookingId},
        ${fixture.in_progress.bookingId},
        ${fixture.quality_review.bookingId}
      )
      order by decision.id`;
    const legacyDecisionByBooking = new Map(
      legacyRouteDecisions.map((decision) => [decision.booking_id, decision]),
    );
    invariant(
      legacyRouteDecisions.length === 2
        && !legacyDecisionByBooking.has(fixture.future_confirmed.bookingId)
        && legacyDecisionByBooking.get(fixture.in_progress.bookingId)?.decision_kind
          === 'approved_exception'
        && legacyDecisionByBooking.get(fixture.in_progress.bookingId)?.prior_status
          === 'manual_review'
        && legacyDecisionByBooking.get(fixture.in_progress.bookingId)?.resulting_status
          === 'approved_exception'
        && legacyDecisionByBooking.get(fixture.in_progress.bookingId)?.schedule_status
          === 'in_progress'
        && legacyDecisionByBooking.get(fixture.in_progress.bookingId)?.actor_membership_id
          === fixture.managerMembershipId
        && legacyDecisionByBooking.get(fixture.in_progress.bookingId)?.reason
          === 'Upgrade verifier in-progress route review'
        && legacyDecisionByBooking.get(fixture.quality_review.bookingId)?.decision_kind
          === 'approved_exception'
        && legacyDecisionByBooking.get(fixture.quality_review.bookingId)?.prior_status
          === 'manual_review'
        && legacyDecisionByBooking.get(fixture.quality_review.bookingId)?.resulting_status
          === 'approved_exception'
        && legacyDecisionByBooking.get(fixture.quality_review.bookingId)?.schedule_status
          === 'quality_review'
        && legacyDecisionByBooking.get(fixture.quality_review.bookingId)?.actor_membership_id
          === fixture.managerMembershipId
        && legacyDecisionByBooking.get(fixture.quality_review.bookingId)?.reason
          === 'Upgrade verifier quality-review route review',
      'Legacy route review did not append exactly one immutable decision per underway job',
    );
  });
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

  const privateTableRows = await sql`
    select table_class.relname as table_name
    from pg_class table_class
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'private'
      and table_class.relkind in ('r', 'p')`;
  const privateTableNames = new Set(
    privateTableRows.map((table) => table.table_name),
  );
  const privateColumns = await sql`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'private'`;
  const privateColumnsByTable = new Map();
  for (const column of privateColumns) {
    const names = privateColumnsByTable.get(column.table_name) || new Set();
    names.add(column.column_name);
    privateColumnsByTable.set(column.table_name, names);
  }
  for (const [table, requiredColumns] of Object.entries(REQUIRED_PRIVATE_SCHEMA)) {
    if (!privateTableNames.has(table)) {
      failures.push(`critical table private.${table} is missing`);
      continue;
    }
    for (const column of requiredColumns) {
      if (!privateColumnsByTable.get(table)?.has(column)) {
        failures.push(`critical column private.${table}.${column} is missing`);
      }
    }
    for (const privilege of REQUIRED_PRIVILEGES) {
      const [access] = await sql`
        select has_table_privilege(
          ${APP_ROLE}, ${`private.${table}`}, ${privilege}
        ) as allowed`;
      if (access.allowed) {
        failures.push(
          `${APP_ROLE} unexpectedly has ${privilege} on private.${table}`,
        );
      }
    }
  }
  const publicPrivateGrants = await sql`
    select table_name, privilege_type
    from information_schema.table_privileges
    where table_schema = 'private'
      and grantee = 'PUBLIC'
      and table_name in ${sql(Object.keys(REQUIRED_PRIVATE_SCHEMA))}`;
  for (const grant of publicPrivateGrants) {
    failures.push(
      `PUBLIC has ${grant.privilege_type} on private.${grant.table_name}`,
    );
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

    const restrictedAccess = RESTRICTED_APPLICATION_TABLE_ACCESS[table.table_name];
    const expectedTablePrivileges = new Set(
      restrictedAccess?.tablePrivileges || REQUIRED_PRIVILEGES,
    );
    for (const privilege of REQUIRED_PRIVILEGES) {
      const [access] = await sql`
        select has_table_privilege(
          ${APP_ROLE}, ${`public.${table.table_name}`}, ${privilege}
        ) as allowed`;
      const expected = expectedTablePrivileges.has(privilege);
      if (access.allowed !== expected) {
        failures.push(
          `${APP_ROLE} ${access.allowed ? "unexpectedly has" : "lacks"} ${privilege} on public.${table.table_name}`,
        );
      }
    }

    if (restrictedAccess?.selectColumns) {
      const expectedSelectColumns = new Set(restrictedAccess.selectColumns);
      for (const column of columnsByTable.get(table.table_name) || []) {
        const [access] = await sql`
          select has_column_privilege(
            ${APP_ROLE}, ${`public.${table.table_name}`}, ${column}, 'SELECT'
          ) as allowed`;
        const expected = expectedSelectColumns.has(column);
        if (access.allowed !== expected) {
          failures.push(
            `${APP_ROLE} ${access.allowed ? "unexpectedly has" : "lacks"} SELECT on public.${table.table_name}.${column}`,
          );
        }
      }
    }
    for (const [privilege, expectedColumns] of Object.entries(
      restrictedAccess?.columnPrivileges || {},
    )) {
      const expectedColumnPrivileges = new Set(expectedColumns);
      for (const column of columnsByTable.get(table.table_name) || []) {
        const [access] = await sql`
          select has_column_privilege(
            ${APP_ROLE}, ${`public.${table.table_name}`}, ${column}, ${privilege}
          ) as allowed`;
        const expected = expectedColumnPrivileges.has(column);
        if (access.allowed !== expected) {
          failures.push(
            `${APP_ROLE} ${access.allowed ? "unexpectedly has" : "lacks"} ${privilege} on public.${table.table_name}.${column}`,
          );
        }
      }
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
    const expectedPolicyCommands = new Set(
      RESTRICTED_APPLICATION_TABLE_ACCESS[table.table_name]?.policyCommands
        || REQUIRED_PRIVILEGES,
    );
    const missingPolicyCommands = [];
    for (const command of expectedPolicyCommands) {
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
    const unexpectedPolicyCommands = REQUIRED_PRIVILEGES.filter(
      (command) => !expectedPolicyCommands.has(command)
        && rolePolicies.some((policy) => policy.cmd === command),
    );
    if (unexpectedPolicyCommands.length > 0) {
      failures.push(
        `public.${table.table_name} unexpectedly retains ${unexpectedPolicyCommands.join("/")} RLS policy coverage for ${APP_ROLE}`,
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

  const runtimeReadProbes = operationsTables.flatMap((table) => {
    const restrictedAccess = RESTRICTED_APPLICATION_TABLE_ACCESS[table.table_name];
    if (restrictedAccess?.selectColumns?.length > 0) {
      return [{ table: table.table_name, column: restrictedAccess.selectColumns[0] }];
    }
    if (restrictedAccess && !restrictedAccess.tablePrivileges.includes("SELECT")) {
      return [];
    }
    return [{ table: table.table_name, column: "*" }];
  });

  if (failures.length === 0) {
    await sql.begin(async (transaction) => {
      await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
      for (const probe of runtimeReadProbes) {
        await transaction.unsafe(
          `select ${probe.column === "*" ? "*" : quoteIdentifier(probe.column)} from public.${quoteIdentifier(probe.table)} limit 0`,
        );
      }
    });
  }

  return {
    failures,
    operationsTables: operationsTables.map((table) => table.table_name),
    runtimeReadProbes,
    protectedPrivateTables: Object.keys(REQUIRED_PRIVATE_SCHEMA),
  };
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

async function inspectClosedInheritedPolicyCatalog(sql) {
  const legacyPolicies = await sql`
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and policyname like 'lakeandpine_app_all_%'
    order by tablename, policyname`;
  invariant(
    legacyPolicies.length === 0,
    `Inherited full-access policies remain: ${legacyPolicies
      .map((policy) => `public.${policy.tablename}.${policy.policyname}`)
      .join(", ")}`,
  );

  const broadRestrictedPolicies = await sql`
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and cmd = 'ALL'
      and roles::text[] && array[${APP_ROLE}, 'public']::text[]
      and tablename in ${sql(Object.keys(RESTRICTED_APPLICATION_TABLE_ACCESS))}
    order by tablename, policyname`;
  invariant(
    broadRestrictedPolicies.length === 0,
    `Restricted tables retain broad ALL policies: ${broadRestrictedPolicies
      .map((policy) => `public.${policy.tablename}.${policy.policyname}`)
      .join(", ")}`,
  );

  const defaultGrants = await sql`
    select pg_get_userbyid(default_acl.defaclrole) as owner,
      default_acl.defaclobjtype as object_type,
      privilege.privilege_type
    from pg_default_acl default_acl
    cross join lateral aclexplode(default_acl.defaclacl) privilege
    join pg_roles grantee on grantee.oid = privilege.grantee
    where default_acl.defaclnamespace = 'public'::regnamespace
      and grantee.rolname = ${APP_ROLE}
      and (
        (default_acl.defaclobjtype = 'r'
          and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
        or (default_acl.defaclobjtype = 'S'
          and privilege.privilege_type in ('USAGE', 'SELECT'))
      )
    order by owner, object_type, privilege.privilege_type`;
  invariant(
    defaultGrants.length === 0,
    `Default public-schema privileges still auto-grant ${APP_ROLE}: ${defaultGrants
      .map((grant) => `${grant.owner}:${grant.object_type}:${grant.privilege_type}`)
      .join(", ")}`,
  );

  const [schemaCreate] = await sql`
    select has_schema_privilege(${APP_ROLE}, 'public', 'CREATE') as allowed`;
  invariant(
    !schemaCreate.allowed,
    `${APP_ROLE} can create public-schema objects and bypass the opt-in privilege model`,
  );

  return {
    legacyFullAccessPolicies: legacyPolicies.length,
    broadRestrictedPolicies: broadRestrictedPolicies.length,
    applicationDefaultGrants: defaultGrants.length,
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

async function inspectRuntimeConnection(rawUrl, runtimeReadProbes) {
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
    for (const probe of runtimeReadProbes) {
      await runtimeSql.unsafe(
        `select ${probe.column === "*" ? "*" : quoteIdentifier(probe.column)} from public.${quoteIdentifier(probe.table)} limit 0`,
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

async function expectDeniedMutation(transaction, allowedCodes, label, operation) {
  let caught;
  let rows;
  try {
    rows = await transaction.savepoint(operation);
  } catch (error) {
    caught = error;
  }
  if (caught) {
    invariant(
      allowedCodes.includes(caught.code),
      `${label} failed with ${caught.code || caught.message}; expected row-level denial or ${allowedCodes.join(" or ")}`,
    );
    return;
  }
  invariant(
    Array.isArray(rows) && rows.length === 0,
    `${label} changed ${Array.isArray(rows) ? rows.length : 'an unknown number of'} rows but must be denied`,
  );
}

async function inspectOperationalInvariants(sql) {
  await sql.begin(async (transaction) => {
    // Seed catalog/capacity prerequisites as the migration owner. Actor-scoped
    // runtime writes begin only after the branch manager fixture is established.
    const [intakeOrganization] = await transaction`
      select private.lakeandpine_intake_organization_id() as id`;
    invariant(
      intakeOrganization?.id,
      'Anonymous request intake cannot resolve the active Lake & Pine organization',
    );
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
    // Schedule RLS now requires a current branch staff actor even for tentative
    // planning. Establish that legitimate scope before exercising schedule
    // validity, staffing, and lifecycle constraints below.
    await transaction.unsafe('reset role');
    const [operationalOrganization] = await transaction`
      select id from organizations where slug = 'lake-and-pine'`;
    const [operationalTeam] = await transaction`
      insert into cleaning_teams
        (organization_id, code, name, timezone, status, territory_ids,
         is_dev_seed)
      values (${operationalOrganization.id}, 'verify-operational',
        'Verifier operational team', 'America/Los_Angeles', 'active',
        array[${territory.id}::uuid], true)
      returning id`;
    await transaction`
      insert into team_service_territories
        (organization_id, team_id, territory_id, status, is_dev_seed)
      values (${operationalOrganization.id}, ${operationalTeam.id},
        ${territory.id}, 'active', true)`;
    const [operationalManager] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('operational-manager@verify.invalid', 'Operational Manager',
        'staff', true) returning id`;
    const [operationalCustomer] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('operational-customer@verify.invalid', 'Operational Customer',
        'customer', true) returning id`;
    const [operationalManagerMembership] = await transaction`
      insert into workforce_memberships
        (organization_id, team_id, customer_id, role, status, is_dev_seed)
      values (${operationalOrganization.id}, ${operationalTeam.id},
        ${operationalManager.id}, 'manager', 'active', true)
      returning id`;
    const operationalCleanerMemberships = await transaction`
      insert into workforce_memberships
        (organization_id, team_id, cleaner_id, role, status, is_dev_seed)
      values
        (${operationalOrganization.id}, ${operationalTeam.id}, ${cleanerOne},
          'cleaner', 'active', true),
        (${operationalOrganization.id}, ${operationalTeam.id}, ${cleanerTwo},
          'cleaner', 'active', true)
      returning id, cleaner_id`;
    const operationalCleanerMembershipByCleaner = new Map(
      operationalCleanerMemberships.map((membership) => [
        membership.cleaner_id, membership.id,
      ]),
    );
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
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`
      select set_config('lakeandpine.current_customer_id', ${operationalManager.id}, true)`;
    await expectDatabaseError(transaction, ['23514'], 'schedule outside active territory postal codes', async (savepoint) => {
      await savepoint`
        insert into job_schedules
          (booking_id, territory_id, service_vertical, start_at, end_at, required_crew_size,
           required_skills, labor_minutes, is_dev_seed)
        values (${mismatchedBooking.id}, ${territory.id}, 'estate', ${startAt}, ${endAt}, 1,
          array['estate_detail'], 300, true)`;
    });

    await transaction.unsafe('reset role');
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
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`
      select set_config('lakeandpine.current_customer_id', ${operationalCustomer.id}, true)`;
    await expectDatabaseError(transaction, ['23514'], 'unlinked booking-mutating service case', async (savepoint) => {
      await savepoint`
        insert into service_cases
          (public_reference, case_type, customer_id, contact, details, status,
           is_dev_seed)
        values ('LP-VERIFY-UNLINKED-1', 'cancel', ${operationalCustomer.id}, '{}',
          'Unlinked cancellation must not be accepted.', 'submitted', true)`;
    });
    await transaction`
      select set_config('lakeandpine.current_customer_id', ${operationalManager.id}, true)`;

    await expectDatabaseError(transaction, ['23514'], 'undersized labor window', async (savepoint) => {
      await savepoint`
        insert into job_schedules
          (booking_id, territory_id, service_vertical, start_at, end_at, required_crew_size,
           required_skills, labor_minutes, is_dev_seed)
        values (${booking.id}, ${territory.id}, 'estate', ${startAt},
          '2030-07-15T18:00:00.000Z', 2,
          array['estate_detail', 'delicate_finishes'], 600, true)`;
    });

    // The app role may create a legitimate tentative plan, but it cannot read
    // the row until the plan has a branch allocation. Seed the invariant
    // fixture through the migration owner while retaining the manager actor
    // required by the schedule-creation trigger.
    await transaction.unsafe('reset role');
    const [schedule] = await transaction`
      insert into job_schedules
        (booking_id, territory_id, service_vertical, start_at, end_at, required_crew_size,
         required_skills, labor_minutes, is_dev_seed)
      values (${booking.id}, ${territory.id}, 'estate', ${startAt}, ${endAt}, 2,
        array['estate_detail', 'delicate_finishes'], 600, true)
      returning id`;

    await transaction.unsafe('reset role');
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

    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleanerOne}, true)`;
    const [timeOff] = await transaction`
      insert into cleaner_time_off
        (organization_id, team_id, cleaner_id, start_at, end_at)
      values (${operationalOrganization.id}, ${operationalTeam.id}, ${cleanerOne},
        ${startAt}, ${endAt})
      returning id, requested_by_membership_id`;
    invariant(
      timeOff.requested_by_membership_id
        === operationalCleanerMembershipByCleaner.get(cleanerOne),
      'Operational time-off fixture did not receive its cleaner membership evidence',
    );
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config('lakeandpine.current_customer_id', ${operationalManager.id}, true)`;
    await expectDatabaseError(transaction, ['23P01'], 'time-off approval over accepted work', async (savepoint) => {
      await savepoint`
        update cleaner_time_off set status = 'approved'
        where id = ${timeOff.id} and version = 1`;
    });
    await transaction.unsafe('reset role');

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

    // The intelligent field layer requires an allocated branch, an approved
    // route assessment, and a versioned customer approval before confirmation.
    // Complete that scope as the migration owner, then resume application-role
    // lifecycle checks below with the already-established manager actor.
    await transaction.unsafe('reset role');
    await transaction`update bookings set customer_id = ${operationalCustomer.id}
      where id = ${booking.id}`;
    const [operationalAllocation] = await transaction`
      insert into team_job_allocations
        (organization_id, team_id, job_schedule_id, assigned_by_membership_id,
         estimated_labor_minutes, is_dev_seed)
      values (${operationalOrganization.id}, ${operationalTeam.id},
        ${schedule.id}, ${operationalManagerMembership.id}, 600, true)
      returning id`;
    await transaction`
      insert into service_location_assessments
        (booking_id, organization_id, team_id, address_fingerprint,
         branch_origin_label, branch_origin_latitude, branch_origin_longitude,
         property_latitude, property_longitude, distance_miles,
         standard_radius_miles, calculation_method, assessment_status,
         provider, calculated_at, is_dev_seed)
      values (${booking.id}, ${operationalOrganization.id}, ${operationalTeam.id},
        ${'1'.repeat(64)}, 'Verifier origin', 47.677700, -116.780500,
        47.700000, -116.800000, 2.1, 30, 'straight_line',
        'inside_standard_radius', 'manual', now(), true)`;
    const [operationalProposal] = await transaction`
      insert into schedule_proposals
        (organization_id, team_id, team_job_allocation_id, job_schedule_id,
         customer_id, arrival_window_start, arrival_window_end, status,
         version, proposed_by_membership_id, proposal_note, is_dev_seed)
      values (${operationalOrganization.id}, ${operationalTeam.id},
        ${operationalAllocation.id}, ${schedule.id}, ${operationalCustomer.id},
        '2030-07-15T15:00:00.000Z', '2030-07-15T17:00:00.000Z',
        'pending_customer', 1, ${operationalManagerMembership.id},
        'Operational invariant approval', true)
      returning id`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id',
        ${operationalCustomer.id},
        true
      )`;
    await transaction`
      update schedule_proposals set status = 'approved'
      where id = ${operationalProposal.id}`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id',
        ${operationalManager.id},
        true
      )`;
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`
      update job_schedules set status = 'held', version = version + 1
      where id = ${schedule.id}`;
    await transaction`
      update job_schedules set status = 'confirmed', version = version + 1
      where id = ${schedule.id}`;
    const [scheduledBooking] = await transaction`
      select status, territory_id from bookings where id = ${booking.id}`;
    invariant(
      scheduledBooking.status === 'scheduled' && scheduledBooking.territory_id === territory.id,
      'Confirmed schedule did not synchronize booking status and territory',
    );
    await transaction.unsafe('reset role');
    await expectDatabaseError(transaction, ['23514'], 'accepted assignment downgrade on confirmed schedule', async (savepoint) => {
      await savepoint`update job_assignments set status = 'proposed' where id = ${assignmentOne.id}`;
    });
    await expectDatabaseError(transaction, ['23514'], 'accepted crew above exact schedule size', async (savepoint) => {
      await savepoint`
        insert into job_assignments
          (job_schedule_id, cleaner_id, assignment_role, status, is_dev_seed)
        values (${schedule.id}, ${overflowCleaner}, 'member', 'accepted', true)`;
    });
    await transaction.unsafe('reset role');
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
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`
      select set_config('lakeandpine.current_customer_id', ${operationalManager.id}, true)`;
    await expectDatabaseError(transaction, ['23514', 'P0001'], 'reschedule outside recurring availability', async (savepoint) => {
      await savepoint`
        update job_schedules
        set start_at = '2030-07-16T03:00:00.000Z',
          end_at = '2030-07-16T08:00:00.000Z', version = version + 1
        where id = ${schedule.id}`;
    });
    await expectDatabaseError(transaction, ['55000'], 'dispatch years before the approved arrival window', async (savepoint) => {
      await savepoint`
        update job_schedules set status = 'en_route', version = version + 1
        where id = ${schedule.id}`;
    });
    await transaction`
      update job_schedules set status = 'canceled', version = version + 1
      where id = ${schedule.id}`;
    const [canceledBooking] = await transaction`
      select status from bookings where id = ${booking.id}`;
    invariant(canceledBooking.status === 'canceled',
      'Canceled schedule did not synchronize booking status');
    await expectDatabaseError(transaction, ['23514', 'P0001', '55000'], 'mutation of a canceled schedule', async (savepoint) => {
      await savepoint`
        update job_schedules set start_at = start_at + interval '1 hour',
          end_at = end_at + interval '1 hour', version = version + 1
        where id = ${schedule.id}`;
    });
    await transaction.unsafe('reset role');
    await transaction`update service_territories set status = 'paused' where id = ${territory.id}`;
    await transaction`
      update job_schedules set status = 'canceled', version = version + 1
      where id = ${capacitySchedule.id}`;
    const [canceledCapacitySchedule] = await transaction`
      select status from job_schedules where id = ${capacitySchedule.id}`;
    invariant(
      canceledCapacitySchedule.status === 'canceled',
      'Cancellation must remain possible after territory capacity is paused',
    );
    await expectDatabaseError(transaction, ['23514', 'P0001', '55000'], 'resurrection of a canceled schedule', async (savepoint) => {
      await savepoint`
        update job_schedules set status = 'tentative', version = version + 1
        where id = ${capacitySchedule.id}`;
    });

    // Refunds now have a scoped, actor-stamped manual lifecycle. Its dedicated
    // proof runs after the national clean-room fixtures establish branch staff.
    const [recoveryCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, contact, details, status, is_dev_seed)
      values ('LP-VERIFY-RECLEAN-1', 'reclean', ${booking.id}, '{}',
        'Verifier reclean case', 'action_planned', true)
      returning id`;
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`
      select set_config('lakeandpine.current_customer_id', ${operationalManager.id}, true)`;
    await expectDatabaseError(transaction, ['42501'], 'recovery action forging a cross-booking scope', async (savepoint) => {
      await savepoint`
        insert into service_recovery_actions
          (service_case_id, booking_id, action_type, scheduled_at, notes)
        values (${recoveryCase.id}, ${capacityBooking.id}, 'reclean',
          '2030-07-20T17:00:00.000Z', 'Forbidden cross-booking recovery')`;
    });
    const [recovery] = await transaction`
      insert into service_recovery_actions
        (service_case_id, action_type, scheduled_at, notes)
      values (${recoveryCase.id}, 'reclean', '2030-07-20T17:00:00.000Z',
        'Separate recovery target; not a main appointment.')
      returning id, booking_id, status, owner_membership_id, owner_label,
        is_dev_seed`;
    invariant(
      recovery.booking_id === booking.id && recovery.status === 'planned'
        && recovery.owner_membership_id === operationalManagerMembership.id
        && recovery.owner_label === 'Operational Manager'
        && recovery.is_dev_seed,
      'Recovery creation did not derive exact case scope and owner evidence',
    );
    await expectDatabaseError(transaction, ['23514'], 'reclean-scheduled case without scheduled recovery', async (savepoint) => {
      await savepoint`
        update service_cases set status = 'reclean_scheduled'
        where id = ${recoveryCase.id}`;
    });
    await expectDatabaseError(transaction, ['55000'], 'invalid recovery lifecycle jump', async (savepoint) => {
      await savepoint`
        update service_recovery_actions set status = 'completed'
        where id = ${recovery.id}`;
    });
    await expectDatabaseError(transaction, ['42501'], 'recovery approval receipt spoof', async (savepoint) => {
      await savepoint`
        update service_recovery_actions
        set status = 'approved',
            approved_by_membership_id = ${operationalManagerMembership.id}
        where id = ${recovery.id}`;
    });
    await transaction`
      update service_recovery_actions set status = 'approved'
      where id = ${recovery.id}`;
    await transaction`
      update service_recovery_actions set status = 'scheduled'
      where id = ${recovery.id}`;
    await transaction`
      update service_recovery_actions set status = 'completed'
      where id = ${recovery.id}`;
    const [completedRecovery] = await transaction`
      select status, approved_by_membership_id,
        approved_at is not null as approved_at_set,
        completed_by_membership_id,
        completed_at is not null as completed_at_set
      from service_recovery_actions where id = ${recovery.id}`;
    invariant(
      completedRecovery.status === 'completed'
        && completedRecovery.approved_by_membership_id
          === operationalManagerMembership.id
        && completedRecovery.approved_at_set
        && completedRecovery.completed_by_membership_id
          === operationalManagerMembership.id
        && completedRecovery.completed_at_set,
      'Recovery action lifecycle did not preserve database-stamped evidence',
    );
    await expectDatabaseError(transaction, ['55000'], 'terminal recovery rewrite', async (savepoint) => {
      await savepoint`
        update service_recovery_actions set status = 'canceled'
        where id = ${recovery.id}`;
    });
    await transaction`
      update service_cases set status = 'reclean_scheduled'
      where id = ${recoveryCase.id}`;
    await transaction`
      update service_cases set status = 'resolved', resolution_type = 'reclean',
        resolution_summary = 'Verifier recovery completed.', resolved_at = now()
      where id = ${recoveryCase.id}`;

    await transaction.unsafe('reset role');
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
    await transaction.unsafe('reset role');
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`delete from schedule_proposals where id = ${operationalProposal.id}`;
    await transaction`delete from service_location_assessments where booking_id = ${booking.id}`;
    await transaction`delete from service_recovery_actions where id = ${recovery.id}`;
    await transaction`
      delete from operations_state_events
      where service_case_id = ${recoveryCase.id}
        or booking_id = ${booking.id}`;
    await transaction`delete from service_cases where id = ${recoveryCase.id}`;
    await transaction`delete from cleaner_time_off where id = ${timeOff.id}`;
    // Deleting the dev booking cascades the schedule, allocation, assignments,
    // and allocated checklist together. That nested cascade is the only
    // permitted deletion path for allocated checklist evidence.
    await transaction`delete from bookings where id = ${booking.id}`;
    await transaction`select set_config('lakeandpine.dev_seed_purge', '1', true)`;
    await transaction`delete from workforce_memberships
      where team_id = ${operationalTeam.id}`;
    await transaction`delete from team_service_territories
      where team_id = ${operationalTeam.id}`;
    await transaction`delete from cleaning_teams where id = ${operationalTeam.id}`;
    await transaction`update bookings set customer_id = null where id = ${booking.id}`;
    await transaction`delete from customers
      where id in (${operationalManager.id}, ${operationalCustomer.id})`;
  });
}

async function inspectOwnerBootstrapConcurrency(sql) {
  const candidates = await sql`
    insert into customers (email, full_name, role, is_dev_seed)
    values
      ('owner-race-a@verify.invalid', 'Owner Race A', 'staff', true),
      ('owner-race-b@verify.invalid', 'Owner Race B', 'staff', true)
    returning id`;
  await sql`
    insert into private.owner_bootstrap_authorizations (normalized_email)
    values ('owner-race-a@verify.invalid'), ('owner-race-b@verify.invalid')`;
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
    await transaction`
      delete from private.owner_bootstrap_authorizations
      where normalized_email in (
        'owner-race-a@verify.invalid', 'owner-race-b@verify.invalid'
      )`;
    await transaction`delete from customers where id = any(${candidates.map((candidate) => candidate.id)}::uuid[])`;
  });
}

async function inspectRouteEnrichmentBoundary(sql) {
  await sql.begin(async (transaction) => {
    const [organization] = await transaction`
      select id from organizations where slug = 'lake-and-pine'`;
    const [territory] = await transaction`
      insert into service_territories
        (code, name, timezone, status, travel_buffer_minutes, is_dev_seed)
      values ('route-enrichment-proof', 'Route enrichment proof territory',
        'America/Los_Angeles', 'draft', 30, true)
      returning id`;
    await transaction`
      insert into territory_postal_codes (territory_id, postal_code, status)
      values (${territory.id}, '83817', 'active')`;
    const [cleaner] = await transaction`
      insert into cleaners
        (full_name, email, status, screening_status, screening_verified_at,
         home_territory_id, skills, vertical_experience, is_dev_seed)
      values ('Route Enrichment Cleaner', 'route-enrichment-cleaner@verify.invalid',
        'active', 'verified', now(), ${territory.id}, array['estate_detail'],
        array['estate'], true)
      returning id`;
    await transaction`
      insert into cleaner_availability_rules
        (cleaner_id, territory_id, day_of_week, start_time, end_time,
         effective_from, status)
      values (${cleaner.id}, ${territory.id},
        extract(dow from '2031-03-03T17:00:00.000Z'::timestamptz
          at time zone 'America/Los_Angeles')::int,
        '08:00', '18:00', '2031-01-01', 'active')`;
    await transaction`
      update service_territories set status = 'active' where id = ${territory.id}`;
    const [team] = await transaction`
      insert into cleaning_teams
        (organization_id, code, name, timezone, status, origin_label,
         origin_latitude, origin_longitude, service_radius_miles, is_dev_seed)
      values (${organization.id}, 'route-enrichment-proof',
        'Route enrichment proof team', 'America/Los_Angeles', 'active',
        'Downtown Coeur d''Alene route proof', 47.677700, -116.780500,
        30, true)
      returning id`;
    await transaction`
      insert into team_service_territories
        (organization_id, team_id, territory_id, status, is_dev_seed)
      values (${organization.id}, ${team.id}, ${territory.id}, 'active', true)`;
    const [manager] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('route-enrichment-manager@verify.invalid',
        'Route Enrichment Manager', 'staff', true)
      returning id`;
    const [customer] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('route-enrichment-customer@verify.invalid',
        'Route Enrichment Customer', 'customer', true)
      returning id`;
    await transaction`
      insert into workforce_memberships
        (organization_id, team_id, customer_id, role, status, is_dev_seed)
      values (${organization.id}, ${team.id}, ${manager.id},
        'manager', 'active', true)`;
    const [otherManager] = await transaction`
      insert into customers (email, full_name, role, is_dev_seed)
      values ('route-enrichment-peer-manager@verify.invalid',
        'Route Enrichment Peer Manager', 'staff', true)
      returning id`;
    const [otherManagerMembership] = await transaction`
      insert into workforce_memberships
        (organization_id, team_id, customer_id, role, status, is_dev_seed)
      values (${organization.id}, ${team.id}, ${otherManager.id},
        'manager', 'active', true)
      returning id`;
    await transaction`
      insert into workforce_memberships
        (organization_id, team_id, cleaner_id, role, status, is_dev_seed)
      values (${organization.id}, ${team.id}, ${cleaner.id},
        'cleaner', 'active', true)`;

    const bookingDefinitions = [
      ['mapbox', 'Route enrichment mapbox proof'],
      ['manual', 'Route enrichment manual proof'],
      ['override', 'Route enrichment override proof'],
    ];
    const bookings = {};
    for (const [key, label] of bookingDefinitions) {
      const [booking] = await transaction`
        insert into bookings
          (customer_id, service_id, scheduled_date, scheduled_window, status,
           contact, is_dev_seed, service_vertical, territory_id,
           qualification_status, estimated_duration_minutes,
           required_crew_size, required_skills)
        values (${customer.id}, 'estate', '2031-03-03', ${label}, 'requested',
          ${transaction.json({
            name: label,
            email: 'route-enrichment-customer@verify.invalid',
            street: `${key} Route Proof Way`,
            city: "Coeur d'Alene",
            state: 'ID',
            zip: '83817',
          })}, true, 'estate', ${territory.id}, 'approved', 60, 1,
          array['estate_detail'])
        returning id`;
      bookings[key] = booking.id;
    }
    const mapboxFingerprint = routeAddressFingerprint({
      street: 'mapbox Route Proof Way',
      city: "Coeur d'Alene",
      state: 'ID',
      zip: '83817',
    });
    const manualFingerprint = routeAddressFingerprint({
      street: 'manual Route Proof Way',
      city: "Coeur d'Alene",
      state: 'ID',
      zip: '83817',
    });
    const overrideFingerprint = routeAddressFingerprint({
      street: 'override Route Proof Way',
      city: "Coeur d'Alene",
      state: 'ID',
      zip: '83817',
    });
    const [mapboxEvidence] = await transaction`
      select private.haversine_miles(
        47.677700, -116.780500, 47.700000, -116.800000
      )::float8 as distance_miles`;
    await transaction`
      insert into service_location_assessments
        (booking_id, organization_id, team_id, address_fingerprint,
         branch_origin_label, branch_origin_latitude, branch_origin_longitude,
         standard_radius_miles, calculation_method, assessment_status,
         provider, is_dev_seed)
      values
        (${bookings.mapbox}, ${organization.id}, null, ${mapboxFingerprint},
          'Downtown Coeur d''Alene route proof', 47.677700, -116.780500,
          30, 'manual_review', 'manual_review', 'manual', true),
        (${bookings.manual}, ${organization.id}, null, ${manualFingerprint},
          'Manual route fallback', null, null,
          30, 'manual_review', 'manual_review', 'manual', true),
        (${bookings.override}, ${organization.id}, ${team.id},
          ${overrideFingerprint}, 'Downtown Coeur d''Alene route proof',
          47.677700, -116.780500, 30, 'straight_line',
          'outside_standard_radius', 'manual', true)`;

    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await expectDatabaseError(transaction, ['23514'], 'internally inconsistent Mapbox route evidence', async (savepoint) => {
      await savepoint`
        select private.enrich_unallocated_service_location_assessment(
          ${bookings.mapbox}, ${mapboxFingerprint},
          'Downtown Coeur d''Alene route proof', 47.677700, -116.780500,
          47.700000, -116.800000, 99, 30, 'straight_line',
          'outside_standard_radius', 'mapbox',
          '123 Route Proof Way, Coeur d''Alene, Idaho 83817',
          'exact', 'rooftop', clock_timestamp()
        )`;
    });
    const [mapboxResult] = await transaction`
      select private.enrich_unallocated_service_location_assessment(
        ${bookings.mapbox}, ${mapboxFingerprint},
        'Downtown Coeur d''Alene route proof', 47.677700, -116.780500,
        47.700000, -116.800000, ${mapboxEvidence.distance_miles}, 30,
        'straight_line',
        'inside_standard_radius', 'mapbox',
        '123 Route Proof Way, Coeur d''Alene, Idaho 83817',
        'exact', 'rooftop', clock_timestamp()
      ) as id`;
    const [manualResult] = await transaction`
      select private.enrich_unallocated_service_location_assessment(
        ${bookings.manual}, ${manualFingerprint},
        'Manual route fallback', null, null, null, null, null, 30,
        'manual_review', 'manual_review', 'manual', null, null, null,
        null
      ) as id`;
    invariant(mapboxResult?.id && manualResult?.id,
      'Null-actor application route enrichment did not persist valid evidence');
    const directNullActorRewrite = await transaction`
      update service_location_assessments
      set provider_resolved_address = 'Forbidden direct null-actor evidence'
      where booking_id = ${bookings.manual}
      returning id`;
    invariant(directNullActorRewrite.length === 0,
      'Null application actor bypassed the narrow route-enrichment function');
    await transaction.unsafe('reset role');
    const [enrichedEvidence] = await transaction`
      select
        (select provider from service_location_assessments
          where booking_id = ${bookings.mapbox}) as mapbox_provider,
        (select assessment_status from service_location_assessments
          where booking_id = ${bookings.mapbox}) as mapbox_status,
        (select provider_resolved_address from service_location_assessments
          where booking_id = ${bookings.mapbox}) as mapbox_address,
        (select provider from service_location_assessments
          where booking_id = ${bookings.manual}) as manual_provider,
        (select calculation_method from service_location_assessments
          where booking_id = ${bookings.manual}) as manual_method,
        (select property_latitude from service_location_assessments
          where booking_id = ${bookings.manual}) as manual_latitude`;
    invariant(
      enrichedEvidence.mapbox_provider === 'mapbox'
        && enrichedEvidence.mapbox_status === 'inside_standard_radius'
        && enrichedEvidence.mapbox_address
          === '123 Route Proof Way, Coeur d\'Alene, Idaho 83817'
        && enrichedEvidence.manual_provider === 'manual'
        && enrichedEvidence.manual_method === 'manual_review'
        && enrichedEvidence.manual_latitude === null,
      'Trusted Mapbox or manual-fallback route evidence did not round-trip',
    );
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await expectDatabaseError(transaction, ['55000'], 'route enrichment with the wrong address fingerprint', async (savepoint) => {
      await savepoint`
        select private.enrich_unallocated_service_location_assessment(
          ${bookings.manual}, ${'d'.repeat(64)}, 'Wrong fingerprint', null, null,
          null, null, null, 30, 'manual_review', 'manual_review', 'manual',
          null, null, null, null
        )`;
    });
    await expectDatabaseError(transaction, ['23514'], 'route enrichment forging an approved exception', async (savepoint) => {
      await savepoint`
        select private.enrich_unallocated_service_location_assessment(
          ${bookings.manual}, ${manualFingerprint}, 'Forged exception',
          null, null, null, null, null, 30, 'manual_review',
          'approved_exception', 'manual', null, null, null, clock_timestamp()
        )`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', ${customer.id}, true)`;
    await expectDatabaseError(transaction, ['42501'], 'customer route enrichment actor', async (savepoint) => {
      await savepoint`
        select private.enrich_unallocated_service_location_assessment(
          ${bookings.manual}, ${manualFingerprint}, 'Customer actor', null, null,
          null, null, null, 30, 'manual_review', 'manual_review', 'manual',
          null, null, null, clock_timestamp()
        )`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleaner.id}, true)`;
    await expectDatabaseError(transaction, ['42501'], 'cleaner route enrichment actor', async (savepoint) => {
      await savepoint`
        select private.enrich_unallocated_service_location_assessment(
          ${bookings.manual}, ${manualFingerprint}, 'Cleaner actor', null, null,
          null, null, null, 30, 'manual_review', 'manual_review', 'manual',
          null, null, null, clock_timestamp()
        )`;
    });
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await expectDatabaseError(transaction, ['42501', '23514', '55000'], 'booking address rewrite with stale route evidence', async (savepoint) => {
      await savepoint`
        update bookings
        set contact = jsonb_set(
          contact, '{street}', to_jsonb('Changed Without Reassessment'::text)
        )
        where id = ${bookings.mapbox}`;
    });
    await transaction.unsafe('reset role');
    const [preservedAddressEvidence] = await transaction`
      select booking.contact->>'street' as street,
        assessment.address_fingerprint
      from bookings booking
      join service_location_assessments assessment
        on assessment.booking_id = booking.id
      where booking.id = ${bookings.mapbox}`;
    invariant(
      preservedAddressEvidence.street === 'mapbox Route Proof Way'
        && preservedAddressEvidence.address_fingerprint === mapboxFingerprint,
      'Rejected address rewrite changed booking or route-assessment evidence',
    );
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    const [allocatedSchedule] = await transaction`
      select gen_random_uuid() as id`;
    await transaction`
      insert into job_schedules
        (id, booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${allocatedSchedule.id}, ${bookings.mapbox}, ${territory.id}, 'estate',
        '2031-03-03T17:00:00.000Z', '2031-03-03T18:00:00.000Z',
        1, array['estate_detail'], 60, true)`;
    await expectDatabaseError(transaction, ['42501'], 'manager forging allocation actor evidence', async (savepoint) => {
      await savepoint`
        insert into team_job_allocations
          (organization_id, team_id, job_schedule_id, assigned_by_membership_id)
        values (${organization.id}, ${team.id}, ${allocatedSchedule.id},
          ${otherManagerMembership.id})`;
    });
    await transaction`
      insert into team_job_allocations
        (organization_id, team_id, job_schedule_id)
      values (${organization.id}, ${team.id}, ${allocatedSchedule.id})`;
    await expectDatabaseError(transaction, ['42501'], 'manager forging route override actor attribution', async (savepoint) => {
      await savepoint`
        update service_location_assessments
        set assessment_status = 'approved_exception',
            override_by_membership_id = ${otherManagerMembership.id},
            override_reason = 'Verifier forged peer-manager attribution'
        where booking_id = ${bookings.override}`;
    });
    await transaction`
      update service_location_assessments
      set assessment_status = 'approved_exception',
          override_reason = 'Verifier documented manual route exception'
      where booking_id = ${bookings.override}`;
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await expectDatabaseError(transaction, ['55000'], 'route enrichment after schedule allocation', async (savepoint) => {
      await savepoint`
        select private.enrich_unallocated_service_location_assessment(
          ${bookings.mapbox}, ${mapboxFingerprint}, 'Allocated rewrite', null,
          null, null, null, null, 30, 'manual_review', 'manual_review',
          'manual', null, null, null, null
        )`;
    });
    await expectDatabaseError(transaction, ['55000'], 'route enrichment after a manual override', async (savepoint) => {
      await savepoint`
        select private.enrich_unallocated_service_location_assessment(
          ${bookings.override}, ${overrideFingerprint}, 'Override rewrite',
          null, null, null, null, null, 30, 'manual_review',
          'manual_review', 'manual', null, null, null, null
        )`;
    });
  });

  const [overrideAttribution] = await sql`
    select decision.actor_membership_id, membership.customer_id,
      actor.email, (count(*) over ())::int as decision_count
    from private.service_location_assessment_decisions decision
    join service_location_assessments assessment
      on assessment.id = decision.assessment_id
    join bookings booking on booking.id = assessment.booking_id
    join workforce_memberships membership
      on membership.id = decision.actor_membership_id
    left join customers actor on actor.id = membership.customer_id
    where booking.scheduled_window = 'Route enrichment override proof'
      and decision.decision_kind = 'approved_exception'`;
  invariant(
    overrideAttribution?.email === 'route-enrichment-manager@verify.invalid'
      && overrideAttribution.decision_count === 1,
    'Route override audit did not preserve the authenticated manager actor',
  );
}

async function inspectNationalTeamOperations(sql) {
  await sql.begin(async (transaction) => {
    // Identity rows are fixture prerequisites; production runtime identity
    // creation is exercised only through the bounded Clerk definer functions.
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
    await transaction`
      insert into private.owner_bootstrap_authorizations (normalized_email)
      values ('national-owner@verify.invalid')`;
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
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
    await transaction`
      update cleaning_teams
      set origin_label = 'Downtown Coeur d''Alene verifier origin',
          origin_latitude = 47.677700,
          origin_longitude = -116.780500,
          service_radius_miles = 30,
          operating_start_time = '08:00',
          latest_arrival_time = '16:00',
          hard_finish_time = '19:00'
      where id = ${teamA.id}`;
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
         amount_cents, effective_from, reason)
      values (${organization.id}, ${teamA.id}, ${peerManagerMembership.id}, 'salary',
        9000000, '2030-01-01', 'Verifier owner-only manager compensation')
      returning id, status, created_by_membership_id, is_dev_seed`;
    invariant(
      peerManagerRate.status === 'active'
        && peerManagerRate.created_by_membership_id === ownerMembership.id
        && peerManagerRate.is_dev_seed,
      'Compensation creation evidence was not database-stamped',
    );
    const [peerManagerBonus] = await transaction`
      insert into bonus_awards
        (organization_id, team_id, workforce_membership_id, amount_cents,
         reason)
      values (${organization.id}, ${teamA.id}, ${peerManagerMembership.id}, 5000,
        'Verifier owner-only manager bonus')
      returning id, status, created_by_membership_id, is_dev_seed`;
    invariant(
      peerManagerBonus.status === 'proposed'
        && peerManagerBonus.created_by_membership_id === ownerMembership.id
        && peerManagerBonus.is_dev_seed,
      'Bonus creation evidence was not database-stamped',
    );
    const [peerManagerEvent] = await transaction`
      insert into workforce_events
        (organization_id, team_id, subject_membership_id, event_type, severity,
         summary)
      values (${organization.id}, ${teamA.id}, ${peerManagerMembership.id},
        'performance_coaching', 'medium', 'Verifier owner-only manager event')
      returning id, status, created_by_membership_id, is_dev_seed`;
    invariant(
      peerManagerEvent.status === 'open'
        && peerManagerEvent.created_by_membership_id === ownerMembership.id
        && peerManagerEvent.is_dev_seed,
      'Workforce-event creation evidence was not database-stamped',
    );
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
         automatic_reorder_enabled)
      values (${organization.id}, ${teamA.id}, 'VERIFY-A', 'Verifier Product A',
        'general', 'bottle', false)
      returning id, created_by_membership_id, is_dev_seed`;
    invariant(
      productA.created_by_membership_id === ownerMembership.id && productA.is_dev_seed,
      'Inventory product creation evidence was not database-stamped',
    );
    const [productB] = await transaction`
      insert into inventory_products
        (organization_id, team_id, sku, name, category, unit_label,
         automatic_reorder_enabled)
      values (${organization.id}, ${teamB.id}, 'VERIFY-B', 'Verifier Product B',
        'general', 'bottle', true)
      returning id`;
    const [guardProduct] = await transaction`
      insert into inventory_products
        (organization_id, team_id, sku, name, category, unit_label)
      values (${organization.id}, ${teamA.id}, 'VERIFY-GUARD',
        'Verifier Guard Product', 'general', 'bottle')
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
         quantity_delta)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
        'receipt', 10)`;
    await transaction`
      update inventory_stock set reorder_point = 5, target_level = 12
      where location_id = ${locationA.id} and product_id = ${productA.id}`;
    await transaction`
      update inventory_products set automatic_reorder_enabled = true
      where id = ${productA.id}`;
    await transaction`
      insert into inventory_transactions
        (organization_id, team_id, location_id, product_id, transaction_type,
         quantity_delta)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
        'usage', -6)`;
    await transaction`
      insert into inventory_transactions
        (organization_id, team_id, location_id, product_id, transaction_type,
         quantity_delta)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
        'usage', -1)`;
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
           quantity_delta)
        values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
          'usage', -100)`;
    });
    await expectDatabaseError(transaction, ['23503'], 'cross-team inventory reference', async (savepoint) => {
      await savepoint`
        insert into inventory_transactions
          (organization_id, team_id, location_id, product_id, transaction_type,
           quantity_delta)
        values (${organization.id}, ${teamB.id}, ${locationB.id}, ${productA.id},
          'receipt', 1)`;
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
    const [legacyCompletedSchedule] = await transaction`
      select schedule.id
      from job_schedules schedule
      join bookings booking on booking.id = schedule.booking_id
      where booking.contact ->> 'name' = 'Verifier'
        and schedule.status = 'completed'
        and booking.is_dev_seed and schedule.is_dev_seed
      limit 1`;
    invariant(legacyCompletedSchedule?.id,
      'Completed unallocated schedule fixture was not available for allocation-status verification');
    await expectDatabaseError(transaction, ['23514'], 'allocation after schedule execution', async (savepoint) => {
      await savepoint`
        insert into team_job_allocations
          (organization_id, team_id, job_schedule_id)
        values (${organization.id}, ${teamA.id}, ${legacyCompletedSchedule.id})`;
    });
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
           amount_cents, effective_from, reason)
        values (${organization.id}, ${teamA.id}, ${peerManagerMembership.id}, 'salary',
          9500000, '2031-01-01', 'Forbidden peer manager pay change')`;
    });
    await expectDatabaseError(transaction, ['42501'], 'manager awarding peer manager bonus', async (savepoint) => {
      await savepoint`
        insert into bonus_awards
          (organization_id, team_id, workforce_membership_id, amount_cents,
           reason)
        values (${organization.id}, ${teamA.id}, ${peerManagerMembership.id}, 5000,
          'Forbidden peer manager bonus')`;
    });
    await expectDatabaseError(transaction, ['42501'], 'manager disciplining peer manager', async (savepoint) => {
      await savepoint`
        insert into workforce_events
          (organization_id, team_id, subject_membership_id, event_type, severity,
           summary)
        values (${organization.id}, ${teamA.id}, ${peerManagerMembership.id},
          'termination', 'critical', 'Forbidden peer manager termination')`;
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
           quantity_requested)
        values (${organization.id}, ${teamB.id}, ${locationB.id}, ${productB.id},
          'automatic_threshold', 2)`;
    });
    await expectDatabaseError(transaction, ['42501'], 'manager cross-team product insert', async (savepoint) => {
      await savepoint`
        insert into inventory_products
          (organization_id, team_id, sku, name, category, unit_label)
        values (${organization.id}, ${teamB.id}, 'VERIFY-CROSS', 'Cross team product',
          'general', 'each')`;
    });
    await expectDeniedMutation(transaction, ['42501'], 'manager changing peer-manager status',
      async (savepoint) => savepoint`
        update workforce_memberships
        set status = 'paused', status_reason = 'Forbidden peer manager pause'
        where id = ${peerManagerMembership.id}
        returning id`);
    await expectDatabaseError(transaction, ['42501'], 'manager spoofing workforce status receipt', async (savepoint) => {
      await savepoint`
        update workforce_memberships
        set status = 'paused', status_reason = 'Forbidden forged receipt',
            status_changed_by_membership_id = ${ownerMembership.id},
            status_changed_at = now()
        where id = ${leadMembership.id}`;
    });
    const [managerPausedLead] = await transaction`
      update workforce_memberships
      set status = 'paused', status_reason = 'Verifier local lead pause'
      where id = ${leadMembership.id}
      returning status_changed_by_membership_id, status_changed_at, ended_at`;
    invariant(
      managerPausedLead.status_changed_by_membership_id === managerMembership.id
        && managerPausedLead.status_changed_at
        && managerPausedLead.ended_at === null,
      'Local manager status change did not receive a database-stamped receipt',
    );
    await transaction`
      update workforce_memberships
      set status = 'active', status_reason = 'Verifier local lead restore',
          ended_at = null
      where id = ${leadMembership.id}`;
    const [managerPausedCleaner] = await transaction`
      update workforce_memberships
      set status = 'paused', status_reason = 'Verifier local cleaner pause'
      where id = ${cleanerMembership.id}
      returning status_changed_by_membership_id, status_changed_at, ended_at`;
    invariant(
      managerPausedCleaner.status_changed_by_membership_id === managerMembership.id
        && managerPausedCleaner.status_changed_at
        && managerPausedCleaner.ended_at === null,
      'Local manager could not change the exact-team cleaner with a stamped receipt',
    );
    await transaction`
      update workforce_memberships
      set status = 'active', status_reason = 'Verifier local cleaner restore',
          ended_at = null
      where id = ${cleanerMembership.id}`;

    await transaction`select set_config('lakeandpine.current_customer_id', ${generalManager.id}, true)`;
    for (const [status, reason] of [
      ['paused', 'Forbidden GM self pause'],
      ['ended', 'Forbidden GM self termination'],
    ]) {
      await expectDeniedMutation(transaction, ['42501'], `general manager changing GM status to ${status}`,
        async (savepoint) => savepoint`
          update workforce_memberships
          set status = ${status}, status_reason = ${reason},
              ended_at = ${status === 'ended' ? '2030-01-01' : null}
          where id = ${generalManagerMembership.id}
          returning id`);
    }

    await transaction`select set_config('lakeandpine.current_customer_id', ${owner.id}, true)`;
    const [ownerPausedGm] = await transaction`
      update workforce_memberships
      set status = 'paused', status_reason = 'Verifier owner GM pause'
      where id = ${generalManagerMembership.id}
      returning status_changed_by_membership_id, status_changed_at`;
    invariant(
      ownerPausedGm.status_changed_by_membership_id === ownerMembership.id
        && ownerPausedGm.status_changed_at,
      'Owner could not change the GM with a database-stamped receipt',
    );
    await transaction`
      update workforce_memberships
      set status = 'active', status_reason = 'Verifier owner GM restore',
          ended_at = null
      where id = ${generalManagerMembership.id}`;
    const [ownerPausedManager] = await transaction`
      update workforce_memberships
      set status = 'paused', status_reason = 'Verifier owner manager pause'
      where id = ${peerManagerMembership.id}
      returning status_changed_by_membership_id, status_changed_at`;
    invariant(
      ownerPausedManager.status_changed_by_membership_id === ownerMembership.id
        && ownerPausedManager.status_changed_at,
      'Owner could not change a manager with a database-stamped receipt',
    );
    await transaction`
      update workforce_memberships
      set status = 'active', status_reason = 'Verifier owner manager restore',
          ended_at = null
      where id = ${peerManagerMembership.id}`;
    await transaction`
      update workforce_memberships
      set status = 'paused', status_reason = 'Verifier actor authority pause'
      where id = ${managerMembership.id}`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await expectDeniedMutation(transaction, ['42501'], 'paused manager changing local workforce status',
      async (savepoint) => savepoint`
        update workforce_memberships
        set status = 'paused', status_reason = 'Forbidden paused actor change'
        where id = ${leadMembership.id}
        returning id`);
    await transaction`select set_config('lakeandpine.current_customer_id', ${owner.id}, true)`;
    await transaction`
      update workforce_memberships
      set status = 'active', status_reason = 'Verifier actor authority restore',
          ended_at = null
      where id = ${managerMembership.id}`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;

    await transaction.unsafe('reset role');
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
    const [coverageProbeBooking] = await transaction`
      insert into bookings
        (customer_id, service_id, scheduled_date, scheduled_window, status,
         contact, is_dev_seed, service_vertical, territory_id,
         qualification_status, estimated_duration_minutes,
         required_crew_size, required_skills)
      values (${jobCustomer.id}, 'estate', '2030-08-06',
        'Coverage and stale-case allocation proof', 'requested',
        ${transaction.json({
          name: 'Coverage and stale-case allocation proof',
          email: 'verified-job-customer@verify.invalid',
          zip: '83816',
        })}, true, 'estate', ${jobTerritory.id}, 'approved', 60, 1,
        array['estate_detail'])
      returning id`;
    const [coverageProbeSchedule] = await transaction`
      insert into job_schedules
        (booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${coverageProbeBooking.id}, ${jobTerritory.id}, 'estate',
        '2030-08-06T16:00:00.000Z', '2030-08-06T17:00:00.000Z',
        1, array['estate_detail'], 60, true)
      returning id`;
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', ${owner.id}, true)`;
    await transaction`
      update team_service_territories set status = 'paused'
      where organization_id = ${organization.id} and team_id = ${teamA.id}
        and territory_id = ${jobTerritory.id}`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await expectDatabaseError(transaction, ['23514'], 'paused territory coverage allocation', async (savepoint) => {
      await savepoint`
        insert into team_job_allocations
          (organization_id, team_id, job_schedule_id)
        values (${organization.id}, ${teamA.id}, ${coverageProbeSchedule.id})`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', ${owner.id}, true)`;
    await transaction`
      update team_service_territories set status = 'active'
      where organization_id = ${organization.id} and team_id = ${teamA.id}
        and territory_id = ${jobTerritory.id}`;
    await transaction.unsafe('reset role');
    const [hiddenTeamBCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, is_dev_seed)
      values ('LP-VERIFY-HIDDEN-TEAM-B-CASE', 'complaint',
        ${coverageProbeBooking.id}, ${jobCustomer.id}, ${teamB.id}, '{}',
        'Stale Team B ownership must block a later Team A allocation.',
        'submitted', true)
      returning id`;
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    const [hiddenCaseVisibility] = await transaction`
      select count(*)::int as count from service_cases
      where id = ${hiddenTeamBCase.id}`;
    invariant(hiddenCaseVisibility.count === 0,
      'Team A manager could read the stale Team B service case');
    await expectDatabaseError(transaction, ['23514'], 'allocation conflicting with RLS-hidden service-case ownership', async (savepoint) => {
      await savepoint`
        insert into team_job_allocations
          (organization_id, team_id, job_schedule_id)
        values (${organization.id}, ${teamA.id}, ${coverageProbeSchedule.id})`;
    });
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
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
    const [teamSchedule] = await transaction`select gen_random_uuid() as id`;
    await transaction`
      insert into job_schedules
        (id, booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${teamSchedule.id}, ${teamBooking.id}, ${jobTerritory.id}, 'estate',
        ${jobStart}, ${jobEnd}, 2, array['estate_detail'], 360, true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`
      insert into service_location_assessments
        (booking_id, organization_id, team_id, address_fingerprint,
         property_latitude, property_longitude, standard_radius_miles,
         calculation_method, assessment_status, provider,
         provider_resolved_address, provider_match_confidence,
         provider_coordinate_accuracy, calculated_at, is_dev_seed)
      values (${teamBooking.id}, ${organization.id}, null, ${'0'.repeat(64)},
        47.700000, -116.800000, 30, 'route_provider',
        'outside_standard_radius', 'mapbox',
        '123 Verifier Way, Coeur d''Alene, Idaho 83814', 'high', 'rooftop',
        now(), true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${owner.id}, true)`;
    const [unallocatedAssessment] = await transaction`
      select id from service_location_assessments where booking_id = ${teamBooking.id}`;
    invariant(unallocatedAssessment?.id,
      'Organization owner could not read the newly captured unallocated assessment');
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
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
    const [staffLeadSchedule] = await transaction`select gen_random_uuid() as id`;
    await transaction`
      insert into job_schedules
        (id, booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${staffLeadSchedule.id}, ${staffLeadBooking.id}, ${jobTerritory.id}, 'estate',
        '2030-08-05T20:00:00.000Z', '2030-08-05T21:00:00.000Z',
        1, array['estate_detail'], 60, true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${candidateManager.id}, true)`;
    await transaction`select private.lock_current_workforce_access(${candidateManager.id})`;
    await expectDatabaseError(transaction, ['42501'], 'shift lead creating disciplinary event', async (savepoint) => {
      await savepoint`
        insert into workforce_events
          (organization_id, team_id, subject_membership_id, event_type, severity,
           summary)
        values (${organization.id}, ${teamA.id}, ${cleanerMembership.id},
          'termination', 'critical', 'Forbidden shift-lead disciplinary action')`;
    });
    await transaction`
      insert into workforce_events
        (organization_id, team_id, subject_membership_id, event_type, severity,
         summary)
      values (${organization.id}, ${teamA.id}, ${cleanerMembership.id},
        'late', 'low', 'Verifier shift-lead operational observation')`;
    const [staffLeadCoverage] = await transaction`
      select private.lock_active_team_territory_coverage(
        ${organization.id}, ${teamA.id}, ${jobTerritory.id}
      ) as covered`;
    invariant(staffLeadCoverage.covered,
      'Staff-backed shift lead could not lock local territory coverage');
    const [staffLeadAllocation] = await transaction`
      insert into team_job_allocations
        (organization_id, team_id, job_schedule_id)
      values (${organization.id}, ${teamA.id}, ${staffLeadSchedule.id})
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
      values (${staffLeadSchedule.id}, ${leadCleaner.id}, ${teamA.id},
        'lead', 'accepted', true)`;
    await transaction`
      insert into job_assignments
        (job_schedule_id, cleaner_id, team_id, assignment_role, status, is_dev_seed)
      values
        (${teamSchedule.id}, ${cleaner.id}, ${teamA.id}, 'member', 'accepted', true),
        (${teamSchedule.id}, ${leadCleaner.id}, ${teamA.id}, 'lead', 'accepted', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${teamBManager.id}, true)`;
    await expectDatabaseError(transaction, ['23514'], 'cross-team schedule allocation', async (savepoint) => {
      await savepoint`
        insert into team_job_allocations
          (organization_id, team_id, job_schedule_id)
        values (${organization.id}, ${teamB.id}, ${teamSchedule.id})`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    const [teamAllocation] = await transaction`
      insert into team_job_allocations
        (organization_id, team_id, job_schedule_id)
      values (${organization.id}, ${teamA.id}, ${teamSchedule.id})
        returning id`;
    const [allocatedAssessment] = await transaction`
      select team_id, branch_origin_label,
        branch_origin_latitude::float8 as branch_origin_latitude,
        branch_origin_longitude::float8 as branch_origin_longitude,
        distance_miles::float8 as distance_miles,
        standard_radius_miles::float8 as standard_radius_miles,
        calculation_method, assessment_status
      from service_location_assessments
      where id = ${unallocatedAssessment.id}`;
    invariant(
      allocatedAssessment.team_id === teamA.id
        && allocatedAssessment.branch_origin_label === "Downtown Coeur d'Alene verifier origin"
        && allocatedAssessment.branch_origin_latitude === 47.6777
        && allocatedAssessment.branch_origin_longitude === -116.7805
        && allocatedAssessment.distance_miles > 0
        && allocatedAssessment.standard_radius_miles === 30
        && allocatedAssessment.calculation_method === 'straight_line'
        && allocatedAssessment.assessment_status === 'inside_standard_radius',
      'Allocating an intake request did not recalculate it from the selected branch configuration',
    );
    await transaction`
      update cleaning_teams set service_radius_miles = 1 where id = ${teamA.id}`;
    const [outsideAfterBranchChange] = await transaction`
      select assessment_status, standard_radius_miles::float8 as standard_radius_miles
      from service_location_assessments where id = ${unallocatedAssessment.id}`;
    invariant(
      outsideAfterBranchChange.assessment_status === 'outside_standard_radius'
        && outsideAfterBranchChange.standard_radius_miles === 1,
      'A pending allocated request did not refresh after branch radius changed',
    );
    await transaction`
      update service_location_assessments
      set assessment_status = 'approved_exception',
          override_reason = 'Verifier manager approved a documented route exception'
      where id = ${unallocatedAssessment.id}`;
    const [approvedRouteException] = await transaction`
      select assessment_status, override_by_membership_id, override_reason
      from service_location_assessments where id = ${unallocatedAssessment.id}`;
    invariant(
      approvedRouteException.assessment_status === 'approved_exception'
        && approvedRouteException.override_by_membership_id === managerMembership.id
        && approvedRouteException.override_reason.includes('documented route exception'),
      'Manager route exception did not retain scoped approval evidence',
    );
    await expectDatabaseError(transaction, ['55000'], 'route exception approval replay', async (savepoint) => {
      await savepoint`
        update service_location_assessments
        set assessment_status = 'approved_exception',
            override_reason = 'Forbidden second approval over the current decision'
        where id = ${unallocatedAssessment.id}`;
    });
    await expectDatabaseError(transaction, ['42501'], 'application access to private route decision audit', async (savepoint) => {
      await savepoint`
        select id from private.service_location_assessment_decisions
        where assessment_id = ${unallocatedAssessment.id}`;
    });
    await transaction.unsafe('reset role');
    const initialRouteDecisions = await transaction`
      select decision_kind, prior_status, resulting_status, schedule_status,
        actor_membership_id, reason,
        distance_miles::float8 as distance_miles,
        standard_radius_miles::float8 as standard_radius_miles,
        branch_origin_label
      from private.service_location_assessment_decisions
      where assessment_id = ${unallocatedAssessment.id}
      order by id`;
    invariant(
      initialRouteDecisions.length === 1
        && initialRouteDecisions[0].decision_kind === 'approved_exception'
        && initialRouteDecisions[0].prior_status === 'outside_standard_radius'
        && initialRouteDecisions[0].resulting_status === 'approved_exception'
        && initialRouteDecisions[0].schedule_status === 'tentative'
        && initialRouteDecisions[0].actor_membership_id === managerMembership.id
        && initialRouteDecisions[0].reason
          === 'Verifier manager approved a documented route exception'
        && initialRouteDecisions[0].distance_miles > 1
        && initialRouteDecisions[0].standard_radius_miles === 1
        && initialRouteDecisions[0].branch_origin_label
          === "Downtown Coeur d'Alene verifier origin",
      'Route exception approval did not append an exact private audit decision',
    );
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${candidateManager.id}, true)`;
    const shiftLeadRouteOverride = await transaction`
      update service_location_assessments
      set override_reason = 'Forbidden shift-lead route exception rewrite'
      where id = ${unallocatedAssessment.id}
      returning id`;
    invariant(
      shiftLeadRouteOverride.length === 0,
      'Shift lead changed a manager-only route exception',
    );
    await transaction`select set_config('lakeandpine.current_customer_id', ${teamBManager.id}, true)`;
    const crossTeamRouteOverride = await transaction`
      update service_location_assessments
      set override_reason = 'Forbidden cross-team route exception rewrite'
      where id = ${unallocatedAssessment.id}
      returning id`;
    invariant(
      crossTeamRouteOverride.length === 0,
      'Another team manager changed the local route exception',
    );
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`
      update cleaning_teams set service_radius_miles = 30 where id = ${teamA.id}`;
    const [insideAfterBranchRestore] = await transaction`
      select assessment_status, standard_radius_miles::float8 as standard_radius_miles,
        override_by_membership_id, override_reason
      from service_location_assessments where id = ${unallocatedAssessment.id}`;
    invariant(
      insideAfterBranchRestore.assessment_status === 'inside_standard_radius'
        && insideAfterBranchRestore.standard_radius_miles === 30
        && insideAfterBranchRestore.override_by_membership_id === null
        && insideAfterBranchRestore.override_reason === null,
      'A pending allocated request did not return in-range after branch radius was restored',
    );
    await transaction.unsafe('reset role');
    const routeDecisionHistory = await transaction`
      select decision_kind, prior_status, resulting_status, schedule_status,
        actor_membership_id, reason
      from private.service_location_assessment_decisions
      where assessment_id = ${unallocatedAssessment.id}
      order by id`;
    invariant(
      routeDecisionHistory.length === 2
        && routeDecisionHistory[0].decision_kind === 'approved_exception'
        && routeDecisionHistory[0].prior_status === 'outside_standard_radius'
        && routeDecisionHistory[0].resulting_status === 'approved_exception'
        && routeDecisionHistory[1].decision_kind === 'invalidated'
        && routeDecisionHistory[1].prior_status === 'approved_exception'
        && routeDecisionHistory[1].resulting_status === 'inside_standard_radius'
        && routeDecisionHistory[1].schedule_status === 'tentative'
        && routeDecisionHistory[1].actor_membership_id === managerMembership.id
        && routeDecisionHistory[1].reason
          === 'Prior route exception invalidated by pre-confirmation route recalculation.',
      'Route recalculation did not preserve append-only approval and invalidation history',
    );
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await expectDatabaseError(transaction, ['55000'], 'allocation identity rebind', async (savepoint) => {
      await savepoint`
        update team_job_allocations set team_id = ${teamB.id}
        where id = ${teamAllocation.id}`;
    });
    const [fieldChecklist] = await transaction`
      insert into checklist_items
        (booking_id, organization_id, team_id, team_job_allocation_id,
         label, state, sort, is_dev_seed)
      values (${teamBooking.id}, ${organization.id}, ${teamA.id},
        ${teamAllocation.id}, 'Verifier premium finish check', 'pending', 1, true)
      returning id`;
    const [fieldSkippedChecklist] = await transaction`
      insert into checklist_items
        (booking_id, organization_id, team_id, team_job_allocation_id,
         label, state, sort, is_dev_seed)
      values (${teamBooking.id}, ${organization.id}, ${teamA.id},
        ${teamAllocation.id}, 'Verifier documented exception check', 'pending', 2, true)
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
           rating, source, evidence_reference, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${cleaner.id},
          ${jobCustomer.id}, 5, 'verified_customer', 'customer-response-early', true)`;
    });
    await expectDatabaseError(transaction, ['23514'], 'review for cleaner who did not work job', async (savepoint) => {
      await savepoint`
        insert into quality_reviews
          (organization_id, team_id, team_job_allocation_id, cleaner_id,
           rating, source, evidence_reference, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${leadCleaner.id},
          5, 'quality_inspection', 'inspection-without-assignment', true)`;
    });

    const [scheduleProposal] = await transaction`
      insert into schedule_proposals
        (organization_id, team_id, team_job_allocation_id, job_schedule_id,
         customer_id, arrival_window_start, arrival_window_end,
         proposal_note, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id},
        ${teamSchedule.id}, ${jobCustomer.id},
        '2030-08-05T15:00:00.000Z', '2030-08-05T17:00:00.000Z',
        'Verifier customer approval window', true)
      returning id, status, version, proposed_by_membership_id`;
    invariant(
      scheduleProposal.status === 'pending_customer'
        && scheduleProposal.version === 1
        && scheduleProposal.proposed_by_membership_id === managerMembership.id,
      'Schedule proposal did not receive database-stamped actor and lifecycle evidence',
    );
    await transaction`select set_config('lakeandpine.current_customer_id', ${jobCustomer.id}, true)`;
    await transaction`
      update schedule_proposals
      set status = 'approved', customer_response_note = 'Verifier approval'
      where id = ${scheduleProposal.id}`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`update job_schedules set status = 'held', version = version + 1
      where id = ${teamSchedule.id}`;
    await transaction`update job_schedules set status = 'confirmed', version = version + 1
      where id = ${teamSchedule.id}`;
    await transaction`
      update job_schedules set status = 'held', version = version + 1
      where id = ${teamSchedule.id}`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${candidateManager.id}, true)`;
    await expectDatabaseError(transaction, ['42501'], 'shift lead confirming customer-approved schedule', async (savepoint) => {
      await savepoint`
        update job_schedules set status = 'confirmed', version = version + 1
        where id = ${teamSchedule.id}`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', ${jobCustomer.id}, true)`;
    await expectDatabaseError(transaction, ['55000'], 'customer assigned-crew message while work is held', async (savepoint) => {
      await savepoint`
        insert into job_communications
          (organization_id, team_id, team_job_allocation_id, customer_id,
           sender_kind, audience, template_key, body,
           is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id},
          ${jobCustomer.id}, 'customer', 'assigned_crew',
          'access_question', 'Forbidden assigned-crew message before live work.',
          true)`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`
      update job_schedules set status = 'confirmed', version = version + 1
      where id = ${teamSchedule.id}`;
    await expectDatabaseError(transaction, ['P0001'], 'direct retime outside customer-approved window', async (savepoint) => {
      await savepoint`
        update job_schedules
        set start_at = '2030-08-05T17:30:00.000Z',
            end_at = '2030-08-05T20:30:00.000Z',
            version = version + 1
        where id = ${teamSchedule.id}`;
    });
    await expectDatabaseError(transaction, ['P0001'], 'direct retime before branch operating hours', async (savepoint) => {
      await savepoint`
        update job_schedules
        set start_at = '2030-08-05T14:00:00.000Z',
            end_at = '2030-08-05T17:00:00.000Z',
            version = version + 1
        where id = ${teamSchedule.id}`;
    });

    await transaction.unsafe('reset role');
    await transaction`
      insert into service_location_assessments
        (booking_id, organization_id, team_id, address_fingerprint,
         branch_origin_label, branch_origin_latitude, branch_origin_longitude,
         property_latitude, property_longitude, distance_miles,
         standard_radius_miles, calculation_method, assessment_status,
         provider, calculated_at, is_dev_seed)
      values (${staffLeadBooking.id}, ${organization.id}, ${teamA.id},
        ${'2'.repeat(64)}, 'Downtown Coeur d''Alene verifier origin',
        47.677700, -116.780500, 47.700000, -116.800000, 2.1, 30,
        'straight_line', 'inside_standard_radius', 'manual', now(), true)`;
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    const [expiringProposal] = await transaction`
      insert into schedule_proposals
        (organization_id, team_id, team_job_allocation_id, job_schedule_id,
         customer_id, arrival_window_start, arrival_window_end,
         expires_at, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${staffLeadAllocation.id},
        ${staffLeadSchedule.id}, ${jobCustomer.id},
        '2030-08-05T19:00:00.000Z', '2030-08-05T21:00:00.000Z',
        clock_timestamp() + interval '250 milliseconds', true)
      returning id`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${jobCustomer.id}, true)`;
    await transaction`
      update schedule_proposals set status = 'approved'
      where id = ${expiringProposal.id}`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`
      update job_schedules set status = 'held', version = version + 1
      where id = ${staffLeadSchedule.id}`;
    const [unassignedCleaner] = await transaction`
      insert into cleaners
        (full_name, email, status, screening_status, screening_verified_at,
         home_territory_id, skills, vertical_experience, is_dev_seed)
      values ('Team A Unassigned Cleaner', 'team-a-unassigned@verify.invalid', 'active',
        'verified', now(), ${jobTerritory.id}, array['estate_detail'],
        array['estate'], true)
      returning id`;
    const [unassignedMembership] = await transaction`
      insert into workforce_memberships
        (organization_id, team_id, cleaner_id, role, status, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${unassignedCleaner.id},
        'cleaner', 'active', true)
      returning id`;
    await transaction`
      insert into cleaner_availability_rules
        (cleaner_id, territory_id, day_of_week, start_time, end_time,
         effective_from, status)
      values (${unassignedCleaner.id}, ${jobTerritory.id},
        extract(dow from '2030-10-08T16:00:00.000Z'::timestamptz
          at time zone 'America/Los_Angeles')::integer,
        '08:00', '18:00', '2030-01-01', 'active')`;
    await expectDatabaseError(transaction, ['42501'], 'proposed assignment on confirmed work', async (savepoint) => {
      await savepoint`
        insert into job_assignments
          (job_schedule_id, cleaner_id, team_id, assignment_role, status,
           is_dev_seed)
        values (${teamSchedule.id}, ${unassignedCleaner.id}, ${teamA.id},
          'member', 'proposed', true)`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', ${jobCustomer.id}, true)`;
    await expectDatabaseError(transaction, ['P0001'], 'preference from non-completed shared service', async (savepoint) => {
      await savepoint`
        insert into customer_cleaner_preferences
          (organization_id, team_id, customer_id, cleaner_id,
           source_allocation_id, preference, note, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${jobCustomer.id}, ${leadCleaner.id},
          ${teamAllocation.id}, 'avoid',
          'Forbidden preference before completed service', true)`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    const [avoidBooking] = await transaction`
      insert into bookings
        (customer_id, service_id, scheduled_date, scheduled_window, status, contact,
         is_dev_seed, service_vertical, territory_id, qualification_status,
         estimated_duration_minutes, required_crew_size, required_skills)
      values (${jobCustomer.id}, 'estate', '2030-10-07', 'Avoid allocation proof',
        'requested',
        ${transaction.json({ name: 'Avoid allocation proof', email: 'verified-job-customer@verify.invalid', zip: '83816' })},
        true, 'estate', ${jobTerritory.id}, 'approved', 60, 1,
        array['estate_detail'])
      returning id`;
    const [avoidSchedule] = await transaction`select gen_random_uuid() as id`;
    await transaction`
      insert into job_schedules
        (id, booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${avoidSchedule.id}, ${avoidBooking.id}, ${jobTerritory.id}, 'estate',
        '2030-10-07T16:00:00.000Z', '2030-10-07T17:00:00.000Z',
        1, array['estate_detail'], 60, true)`;
    await transaction`
      insert into job_assignments
        (job_schedule_id, cleaner_id, assignment_role, status, is_dev_seed)
      values (${avoidSchedule.id}, ${leadCleaner.id}, 'lead', 'accepted', true)`;
    await transaction`
      update job_schedules set status = 'held', version = version + 1
      where id = ${avoidSchedule.id}`;
    await expectDatabaseError(transaction, ['23514', 'P0001'], 'confirmation without a team allocation', async (savepoint) => {
      await savepoint`
        update job_schedules set status = 'confirmed', version = version + 1
        where id = ${avoidSchedule.id}`;
    });
    await transaction`
      insert into cleaner_availability_rules
        (cleaner_id, territory_id, day_of_week, start_time, end_time,
         effective_from, status)
      values (${cleaner.id}, ${jobTerritory.id},
        extract(dow from '2030-10-08T16:00:00.000Z'::timestamptz
          at time zone 'America/Los_Angeles')::integer,
        '08:00', '18:00', '2030-01-01', 'active')`;
    const [crewRlsBooking] = await transaction`
      insert into bookings
        (customer_id, service_id, scheduled_date, scheduled_window, status,
         contact, is_dev_seed, service_vertical, territory_id,
         qualification_status, estimated_duration_minutes,
         required_crew_size, required_skills)
      values (${jobCustomer.id}, 'estate', '2030-10-08',
        'Crew RLS response proof', 'requested',
        ${transaction.json({
          name: 'Crew RLS response proof',
          email: 'verified-job-customer@verify.invalid',
          zip: '83816',
        })}, true, 'estate', ${jobTerritory.id}, 'approved', 120, 2,
        array['estate_detail'])
      returning id`;
    const [crewRlsSchedule] = await transaction`select gen_random_uuid() as id`;
    await transaction`
      insert into job_schedules
        (id, booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${crewRlsSchedule.id}, ${crewRlsBooking.id}, ${jobTerritory.id}, 'estate',
        '2030-10-08T16:00:00.000Z', '2030-10-08T17:00:00.000Z',
        2, array['estate_detail'], 120, true)`;
    await transaction`
      insert into job_assignments
        (job_schedule_id, cleaner_id, team_id, assignment_role, status,
         is_dev_seed)
      values (${crewRlsSchedule.id}, ${cleaner.id}, ${teamA.id},
        'member', 'accepted', true)`;
    const [crewRlsAssignment] = await transaction`
      insert into job_assignments
        (job_schedule_id, cleaner_id, team_id, assignment_role, status,
         is_dev_seed)
      values (${crewRlsSchedule.id}, ${unassignedCleaner.id}, ${teamA.id},
        'lead', 'proposed', true)
      returning id`;
    await transaction`
      insert into team_job_allocations
        (organization_id, team_id, job_schedule_id)
      values (${organization.id}, ${teamA.id}, ${crewRlsSchedule.id})`;
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    const [anonymousCrewProposal] = await transaction`
      select count(*)::int as count
      from job_assignments assignment
      join job_schedules schedule on schedule.id = assignment.job_schedule_id
      join bookings booking on booking.id = schedule.booking_id
      join service_territories territory on territory.id = schedule.territory_id
      join team_job_allocations allocation
        on allocation.job_schedule_id = schedule.id
       and allocation.team_id = assignment.team_id
      join workforce_memberships membership
        on membership.organization_id = allocation.organization_id
       and membership.team_id = allocation.team_id
       and membership.cleaner_id = assignment.cleaner_id
       and membership.status = 'active'
       and membership.role in ('cleaner', 'shift_lead')
      where assignment.id = ${crewRlsAssignment.id}`;
    const anonymousCrewResponse = await transaction`
      update job_assignments assignment
      set status = 'accepted', responded_at = now()
      from job_schedules schedule, team_job_allocations allocation,
        workforce_memberships membership
      where assignment.id = ${crewRlsAssignment.id}
        and assignment.job_schedule_id = schedule.id
        and allocation.job_schedule_id = schedule.id
        and allocation.team_id = assignment.team_id
        and membership.organization_id = allocation.organization_id
        and membership.team_id = allocation.team_id
        and membership.cleaner_id = assignment.cleaner_id
        and membership.status = 'active'
        and membership.role in ('cleaner', 'shift_lead')
        and assignment.status = 'proposed'
      returning assignment.id`;
    invariant(
      anonymousCrewProposal.count === 0 && anonymousCrewResponse.length === 0,
      'Null application actor could read or respond to a crew proposal',
    );
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${unassignedCleaner.id}, true)`;
    const [activeCrewProposal] = await transaction`
      select count(*)::int as count
      from job_assignments assignment
      join job_schedules schedule on schedule.id = assignment.job_schedule_id
      join team_job_allocations allocation
        on allocation.job_schedule_id = schedule.id
       and allocation.team_id = assignment.team_id
      join workforce_memberships membership
        on membership.organization_id = allocation.organization_id
       and membership.team_id = allocation.team_id
       and membership.cleaner_id = assignment.cleaner_id
       and membership.status = 'active'
       and membership.role in ('cleaner', 'shift_lead')
      where assignment.id = ${crewRlsAssignment.id}`;
    const activeCrewResponse = await transaction`
      update job_assignments assignment
      set status = 'accepted', responded_at = now()
      from job_schedules schedule, team_job_allocations allocation,
        workforce_memberships membership
      where assignment.id = ${crewRlsAssignment.id}
        and assignment.cleaner_id = ${unassignedCleaner.id}
        and assignment.job_schedule_id = schedule.id
        and allocation.job_schedule_id = schedule.id
        and allocation.team_id = assignment.team_id
        and membership.organization_id = allocation.organization_id
        and membership.team_id = allocation.team_id
        and membership.cleaner_id = assignment.cleaner_id
        and membership.status = 'active'
        and membership.role in ('cleaner', 'shift_lead')
        and assignment.status = 'proposed'
        and schedule.status in ('tentative', 'held')
      returning assignment.id`;
    invariant(
      activeCrewProposal.count === 1 && activeCrewResponse.length === 1,
      'Active assigned cleaner could not read and accept a crew proposal',
    );
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`
      update job_assignments set status = 'proposed', responded_at = null
      where id = ${crewRlsAssignment.id}`;
    await transaction`
      update workforce_memberships
      set status = 'paused', status_reason = 'Verifier crew RLS pause'
      where id = ${unassignedMembership.id}`;
    await expectDatabaseError(transaction, ['23514'], 'paused cleaner assignment reactivation', async (savepoint) => {
      await savepoint`
        update job_assignments set status = 'accepted', responded_at = now()
        where id = ${crewRlsAssignment.id}`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${unassignedCleaner.id}, true)`;
    const [pausedCrewProposal] = await transaction`
      select count(*)::int as count
      from job_assignments assignment
      join job_schedules schedule on schedule.id = assignment.job_schedule_id
      join team_job_allocations allocation
        on allocation.job_schedule_id = schedule.id
       and allocation.team_id = assignment.team_id
      join workforce_memberships membership
        on membership.organization_id = allocation.organization_id
       and membership.team_id = allocation.team_id
       and membership.cleaner_id = assignment.cleaner_id
       and membership.status = 'active'
       and membership.role in ('cleaner', 'shift_lead')
      where assignment.id = ${crewRlsAssignment.id}`;
    const pausedCrewResponse = await transaction`
      update job_assignments assignment
      set status = 'accepted', responded_at = now()
      from job_schedules schedule, team_job_allocations allocation,
        workforce_memberships membership
      where assignment.id = ${crewRlsAssignment.id}
        and assignment.cleaner_id = ${unassignedCleaner.id}
        and assignment.job_schedule_id = schedule.id
        and allocation.job_schedule_id = schedule.id
        and allocation.team_id = assignment.team_id
        and membership.organization_id = allocation.organization_id
        and membership.team_id = allocation.team_id
        and membership.cleaner_id = assignment.cleaner_id
        and membership.status = 'active'
        and assignment.status = 'proposed'
      returning assignment.id`;
    invariant(
      pausedCrewProposal.count === 0 && pausedCrewResponse.length === 0,
      'Paused cleaner retained crew proposal read or response access',
    );
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${unassignedCleaner.id}, true)`;
    await expectDatabaseError(transaction, ['42501'], 'unassigned cleaner forged time clock', async (savepoint) => {
      await savepoint`
        insert into job_time_entries
          (organization_id, team_id, team_job_allocation_id, cleaner_id,
           source)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${unassignedCleaner.id},
          'crew_timer')`;
    });
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`
      update workforce_memberships
      set status = 'active', status_reason = 'Verifier proposal guard restore',
          ended_at = null
      where id = ${unassignedMembership.id}`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleaner.id}, true)`;
    const [cleanerTeamA] = await transaction`
      select count(*)::int as count from cleaning_teams where id = ${teamA.id}`;
    const [cleanerTeamB] = await transaction`
      select count(*)::int as count from cleaning_teams where id = ${teamB.id}`;
    invariant(cleanerTeamA.count === 1 && cleanerTeamB.count === 0,
      'Cleaner team isolation did not fail closed');
    await expectDatabaseError(transaction, ['55000', 'P0001'], 'cleaner checklist completion before execution', async (savepoint) => {
      await savepoint`
        update checklist_items
        set state = 'completed', completion_note = 'Forbidden pre-execution evidence'
        where id = ${fieldChecklist.id}`;
    });
    const [pendingChecklist] = await transaction`
      select state, completed_by_cleaner_id, completed_at is not null as completed_at_set,
        version
      from checklist_items where id = ${fieldChecklist.id}`;
    invariant(
      pendingChecklist.state === 'pending'
        && pendingChecklist.completed_by_cleaner_id === null
        && !pendingChecklist.completed_at_set
        && pendingChecklist.version === 1,
      'Pre-execution cleaner checklist rejection changed evidence',
    );
    await transaction`
      insert into inventory_transactions
        (organization_id, team_id, location_id, product_id, transaction_type,
         quantity_delta)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
        'usage', -1)`;
    await expectDatabaseError(transaction, ['42501'], 'cleaner forged inventory receipt', async (savepoint) => {
      await savepoint`
        insert into inventory_transactions
          (organization_id, team_id, location_id, product_id, transaction_type,
           quantity_delta)
        values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
          'receipt', 5)`;
    });
    await expectDatabaseError(transaction, ['42501'], 'cleaner forged inventory adjustment', async (savepoint) => {
      await savepoint`
        insert into inventory_transactions
          (organization_id, team_id, location_id, product_id, transaction_type,
           quantity_delta)
        values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
          'adjustment', 5)`;
    });
    const [cleanerLedger] = await transaction`
      select count(*)::int as count from inventory_transactions`;
    invariant(cleanerLedger.count === 1,
      'Cleaner must see only their own inventory ledger entries');
    await transaction`
      insert into restock_requests
        (organization_id, team_id, location_id, product_id,
         request_source, quantity_requested)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
        'cleaner', 4)`;
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

    const [fieldCommunication] = await transaction`
      insert into job_communications
        (organization_id, team_id, team_job_allocation_id, customer_id,
         sender_kind, audience,
         template_key, body, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${jobCustomer.id},
        'cleaner', 'customer',
        'running_15_late', 'Verifier cleaner is running about 15 minutes late.', true)
      returning id, sender_membership_id, sender_cleaner_id, channel,
        delivery_status`;
    invariant(
      fieldCommunication.sender_membership_id === cleanerMembership.id
        && fieldCommunication.sender_cleaner_id === cleaner.id
        && fieldCommunication.channel === 'in_app'
        && fieldCommunication.delivery_status === 'recorded',
      'Cleaner communication actor and delivery evidence were not database-stamped',
    );
    const [cleanerOperationsCommunication] = await transaction`
      insert into job_communications
        (organization_id, team_id, team_job_allocation_id, customer_id,
         sender_kind, audience,
         template_key, body, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${jobCustomer.id},
        'cleaner', 'team_operations',
        'access_question', 'Verifier private operations escalation.', true)
      returning id`;
    const [fieldMileage] = await transaction`
      insert into mileage_entries
        (organization_id, team_id, cleaner_id,
         service_date, miles, purpose, is_dev_seed)
      select ${organization.id}, ${teamA.id}, ${cleaner.id},
        (clock_timestamp() at time zone team.timezone)::date,
        7.25, 'supply_run', true
      from cleaning_teams team
      where team.id = ${teamA.id} and team.organization_id = ${organization.id}
      returning id, workforce_membership_id, status, version,
        reviewed_by_membership_id, reviewed_at`;
    invariant(
      fieldMileage.workforce_membership_id === cleanerMembership.id
        && fieldMileage.status === 'submitted'
        && fieldMileage.version === 1
        && fieldMileage.reviewed_by_membership_id === null
        && fieldMileage.reviewed_at === null,
      'Mileage submission evidence was not database-stamped',
    );
    await expectDatabaseError(transaction, ['55000'], 'future unlinked mileage', async (savepoint) => {
      await savepoint`
        insert into mileage_entries
          (organization_id, team_id, cleaner_id,
           service_date, miles, purpose, is_dev_seed)
        select ${organization.id}, ${teamA.id}, ${cleaner.id},
          (clock_timestamp() at time zone team.timezone)::date + 1,
          1, 'supply_run', true
        from cleaning_teams team
        where team.id = ${teamA.id} and team.organization_id = ${organization.id}`;
    });
    await expectDatabaseError(transaction, ['55000'], 'stale unlinked mileage', async (savepoint) => {
      await savepoint`
        insert into mileage_entries
          (organization_id, team_id, cleaner_id,
           service_date, miles, purpose, is_dev_seed)
        select ${organization.id}, ${teamA.id}, ${cleaner.id},
          (clock_timestamp() at time zone team.timezone)::date - 32,
          1, 'supply_run', true
        from cleaning_teams team
        where team.id = ${teamA.id} and team.organization_id = ${organization.id}`;
    });
    await expectDatabaseError(transaction, ['55000'], 'linked mileage before travel window', async (savepoint) => {
      await savepoint`
        insert into mileage_entries
          (organization_id, team_id, cleaner_id,
           team_job_allocation_id, service_date, miles, purpose, is_dev_seed)
        select ${organization.id}, ${teamA.id}, ${cleaner.id},
          ${teamAllocation.id},
          (schedule.start_at at time zone team.timezone)::date,
          7.25, 'to_job', true
        from job_schedules schedule
        join cleaning_teams team on team.id = ${teamA.id}
          and team.organization_id = ${organization.id}
        where schedule.id = ${teamSchedule.id}`;
    });
    const [fieldIssue] = await transaction`
      insert into job_issue_reports
        (organization_id, team_id, team_job_allocation_id, issue_type,
         severity, summary, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, 'access',
        'medium', 'Verifier access escalation', true)
      returning id, reported_by_membership_id, reported_by_cleaner_id,
        status, customer_visible, version`;
    invariant(
      fieldIssue.reported_by_membership_id === cleanerMembership.id
        && fieldIssue.reported_by_cleaner_id === cleaner.id
        && fieldIssue.status === 'open'
        && !fieldIssue.customer_visible
        && fieldIssue.version === 1,
      'Field issue actor and lifecycle evidence were not database-stamped',
    );
    await expectDatabaseError(transaction, ['42501'], 'field issue inserted with forged resolution evidence', async (savepoint) => {
      await savepoint`
        insert into job_issue_reports
          (organization_id, team_id, team_job_allocation_id,
           reported_by_membership_id, reported_by_cleaner_id, issue_type,
           severity, summary, status, resolution_note, resolved_at,
           is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id},
          ${cleanerMembership.id}, ${cleaner.id}, 'access', 'medium',
          'Forged closed cleaner escalation', 'resolved',
          'Forged resolution evidence', now(), true)`;
    });
    const [hiddenCleanerIssue] = await transaction`
      select count(*)::int as count from job_issue_reports
      where id = ${fieldIssue.id}`;
    invariant(hiddenCleanerIssue.count === 0,
      'Cleaner retained raw issue-report visibility after submitting an escalation');
    await expectDeniedMutation(transaction, ['42501'], 'cleaner self-assigned their field escalation',
      async (savepoint) => savepoint`
        update job_issue_reports
        set assigned_to_membership_id = ${cleanerMembership.id},
            version = version + 1
        where id = ${fieldIssue.id}
        returning id`);
    const [cleanerRouteAssessment] = await transaction`
      select count(*)::int as count from service_location_assessments
      where booking_id = ${teamBooking.id}`;
    invariant(cleanerRouteAssessment.count === 1,
      'Assigned cleaner could not read the allocated job route assessment');
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`
      update workforce_memberships
      set status = 'paused', status_reason = 'Verifier immediate offboarding'
      where id = ${cleanerMembership.id}`;
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleaner.id}, true)`;
    const [offboardedFieldAccess] = await transaction`
      select
        (select count(*)::int from team_job_allocations
          where id = ${teamAllocation.id}) as allocation_count,
        (select count(*)::int from schedule_proposals
          where id = ${scheduleProposal.id}) as proposal_count,
        (select count(*)::int from job_communications
          where id in (${fieldCommunication.id}, ${cleanerOperationsCommunication.id}))
          as communication_count,
        (select count(*)::int from checklist_items
          where id = ${fieldChecklist.id}) as checklist_count,
        (select count(*)::int from service_location_assessments
          where id = ${unallocatedAssessment.id}) as assessment_count`;
    invariant(
      offboardedFieldAccess.allocation_count === 0
        && offboardedFieldAccess.proposal_count === 0
        && offboardedFieldAccess.communication_count === 0
        && offboardedFieldAccess.checklist_count === 0
        && offboardedFieldAccess.assessment_count === 0,
      'Paused cleaner retained allocated field-operation access',
    );
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    const [reconciledCrew] = await transaction`
      select schedule.status as schedule_status,
        assignment.status as assignment_status
      from job_schedules schedule
      join job_assignments assignment
        on assignment.job_schedule_id = schedule.id
       and assignment.cleaner_id = ${cleaner.id}
      where schedule.id = ${teamSchedule.id}`;
    invariant(
      reconciledCrew.schedule_status === 'held'
        && reconciledCrew.assignment_status === 'removed',
      'Pausing a cleaner did not hold confirmed work and remove the ghost assignment',
    );
    await transaction`
      update workforce_memberships
      set status = 'active', status_reason = 'Verifier access restored',
          ended_at = null
      where id = ${cleanerMembership.id}`;
    await transaction`
      update job_assignments set status = 'accepted', responded_at = now()
      where job_schedule_id = ${teamSchedule.id}
        and cleaner_id = ${cleaner.id} and status = 'removed'`;
    await transaction`
      update job_schedules set status = 'confirmed', version = version + 1
      where id = ${teamSchedule.id} and status = 'held'`;
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleaner.id}, true)`;
    await expectDatabaseError(transaction, ['42501'], 'cleaner self-approved mileage', async (savepoint) => {
      await savepoint`
        update mileage_entries set status = 'approved',
          reviewed_by_membership_id = ${cleanerMembership.id}, reviewed_at = now()
        where id = ${fieldMileage.id}`;
    });

    await expectDatabaseError(transaction, ['42501'], 'cleaner forged initial approval', async (savepoint) => {
      await savepoint`
        insert into job_time_entries
          (organization_id, team_id, team_job_allocation_id, cleaner_id,
           clock_in_at, clock_out_at, status, source,
           approved_by_membership_id, approved_at)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${cleaner.id},
          clock_timestamp() - interval '1 hour', clock_timestamp(), 'approved',
          'manager_entry', ${cleanerMembership.id}, clock_timestamp())`;
    });
    const [teamTimeOff] = await transaction`
      insert into cleaner_time_off
        (organization_id, team_id, cleaner_id, start_at, end_at)
      values (${organization.id}, ${teamA.id}, ${cleaner.id},
        '2030-09-02T16:00:00.000Z', '2030-09-02T20:00:00.000Z')
      returning id, status, requested_by_membership_id, is_dev_seed, version,
        reviewed_by_membership_id, reviewed_at`;
    invariant(
      teamTimeOff.status === 'requested'
        && teamTimeOff.requested_by_membership_id === cleanerMembership.id
        && teamTimeOff.is_dev_seed
        && teamTimeOff.version === 1
        && teamTimeOff.reviewed_by_membership_id === null
        && teamTimeOff.reviewed_at === null,
      'Cleaner time-off request did not receive trusted database evidence',
    );
    await expectDatabaseError(transaction, ['42501'], 'cleaner cross-team time-off request', async (savepoint) => {
      await savepoint`
        insert into cleaner_time_off
          (organization_id, team_id, cleaner_id, start_at, end_at)
        values (${organization.id}, ${teamB.id}, ${cleaner.id},
          '2030-09-09T16:00:00.000Z', '2030-09-09T20:00:00.000Z')`;
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
         quantity_delta)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
        'usage', -1)`;
    await transaction`
      insert into restock_requests
        (organization_id, team_id, location_id, product_id,
         request_source, quantity_requested)
      values (${organization.id}, ${teamA.id}, ${locationA.id}, ${productA.id},
        'cleaner', 2)`;
    await transaction`
      insert into workforce_events
        (organization_id, team_id, subject_membership_id, event_type, severity,
         summary)
      values (${organization.id}, ${teamA.id}, ${leadMembership.id}, 'callout',
        'high', 'Verifier shift-lead callout')`;

    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    const [staffOperationsCommunication] = await transaction`
      insert into job_communications
        (organization_id, team_id, team_job_allocation_id, customer_id,
         sender_kind, audience, template_key, body,
         is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${jobCustomer.id},
        'staff', 'team_operations', 'scope_issue',
        'Verifier manager-only operations note.', true)
      returning id`;
    await expectDatabaseError(transaction, ['23514'], 'communication linked to unrelated customer', async (savepoint) => {
      await savepoint`
        insert into job_communications
          (organization_id, team_id, team_job_allocation_id, customer_id,
           sender_kind, audience, template_key, body,
           is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${wrongCustomer.id},
          'staff', 'customer', 'custom',
          'Verifier must reject the wrong customer.', true)`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', ${jobCustomer.id}, true)`;
    const [customerIssueProjection] = await transaction`
      select count(*)::int as count, max(issue_type) as issue_type,
        max(severity) as severity, max(summary) as summary, max(status) as status
      from private.current_customer_visible_job_issues()
      where id = ${fieldIssue.id}`;
    const [hiddenCustomerIssue] = await transaction`
      select count(*)::int as count from job_issue_reports
      where id = ${fieldIssue.id}`;
    invariant(
      customerIssueProjection.count === 1
        && customerIssueProjection.issue_type === 'access'
        && customerIssueProjection.severity === 'medium'
        && customerIssueProjection.summary === 'Verifier access escalation'
        && customerIssueProjection.status === 'open'
        && hiddenCustomerIssue.count === 0,
      'Customer issue projection exposed manager-only report evidence or hid a visible issue',
    );
    const [customerCrewCommunication] = await transaction`
      insert into job_communications
        (organization_id, team_id, team_job_allocation_id, customer_id,
         sender_kind, audience, template_key, body,
         is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${jobCustomer.id},
        'customer', 'assigned_crew', 'access_question',
        'Verifier customer access note for assigned crew.', true)
      returning id`;
    const [customerOperationsCommunication] = await transaction`
      insert into job_communications
        (organization_id, team_id, team_job_allocation_id, customer_id,
         sender_kind, audience, template_key, body,
         is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${jobCustomer.id},
        'customer', 'team_operations', 'scope_issue',
        'Verifier customer escalation for operations.', true)
      returning id`;
    const [customerCommunicationVisibility] = await transaction`
      select count(*)::int as count from job_communications
      where id in (${fieldCommunication.id}, ${cleanerOperationsCommunication.id},
        ${staffOperationsCommunication.id}, ${customerCrewCommunication.id},
        ${customerOperationsCommunication.id})`;
    invariant(
      customerCommunicationVisibility.count === 3,
      'Customer communication visibility crossed audience boundaries',
    );
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleaner.id}, true)`;
    const [cleanerCommunicationVisibility] = await transaction`
      select count(*)::int as count from job_communications
      where id in (${fieldCommunication.id}, ${cleanerOperationsCommunication.id},
        ${staffOperationsCommunication.id}, ${customerCrewCommunication.id},
        ${customerOperationsCommunication.id})`;
    invariant(
      cleanerCommunicationVisibility.count === 3,
      'Cleaner communication visibility crossed assigned-crew or own-sender boundaries',
    );
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await expectDatabaseError(transaction, ['42501'], 'mileage approval rewriting submitted evidence', async (savepoint) => {
      await savepoint`
        update mileage_entries set status = 'approved', miles = 99,
          reviewed_by_membership_id = ${managerMembership.id},
          reviewed_at = now(), review_note = 'Forbidden evidence rewrite',
          version = version + 1
        where id = ${fieldMileage.id}`;
    });
    await transaction`
      update mileage_entries set status = 'approved',
        review_note = 'Verifier manager approval'
      where id = ${fieldMileage.id}`;
    await expectDatabaseError(transaction, ['P0001'], 'issue closure without resolution evidence', async (savepoint) => {
      await savepoint`
        update job_issue_reports
        set status = 'resolved', version = version + 1
        where id = ${fieldIssue.id}`;
    });
    await expectDatabaseError(transaction, ['42501'], 'issue decision with forged assignee evidence', async (savepoint) => {
      await savepoint`
        update job_issue_reports
        set status = 'acknowledged',
            assigned_to_membership_id = ${managerMembership.id}
        where id = ${fieldIssue.id}`;
    });
    await transaction`
      update job_issue_reports
      set status = 'acknowledged', customer_visible = true
      where id = ${fieldIssue.id}`;
    await expectDatabaseError(transaction, ['55000'], 'acknowledged issue reopened to open', async (savepoint) => {
      await savepoint`
        update job_issue_reports
        set status = 'open'
        where id = ${fieldIssue.id}`;
    });
    await transaction`
      update job_issue_reports set status = 'resolved',
        resolution_note = 'Verifier manager documented and resolved access.'
      where id = ${fieldIssue.id}`;
    await expectDatabaseError(transaction, ['55000'], 'terminal issue evidence rewrite', async (savepoint) => {
      await savepoint`
        update job_issue_reports
        set resolution_note = 'Forbidden terminal evidence rewrite'
        where id = ${fieldIssue.id}`;
    });
    const [fieldDuty] = await transaction`
      insert into team_duty_assignments
        (organization_id, team_id, workforce_membership_id, starts_at, ends_at,
         duty_kind, note, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${managerMembership.id},
        clock_timestamp() - interval '1 hour',
        clock_timestamp() + interval '8 hours',
        'manager_on_duty', 'Verifier local duty coverage', true)
      returning id, status, created_by_membership_id`;
    invariant(
      fieldDuty.status === 'active'
        && fieldDuty.created_by_membership_id === managerMembership.id,
      'Current duty coverage did not receive database-stamped creator evidence',
    );
    const [futureFieldDuty] = await transaction`
      insert into team_duty_assignments
        (organization_id, team_id, workforce_membership_id, starts_at, ends_at,
         duty_kind, note, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${managerMembership.id},
        clock_timestamp() + interval '9 hours',
        clock_timestamp() + interval '10 hours',
        'manager_on_duty',
        'Verifier future duty must remain outside the current projection', true)
      returning id`;
    const [longNoteDuty] = await transaction`
      insert into team_duty_assignments
        (organization_id, team_id, workforce_membership_id, starts_at, ends_at,
         duty_kind, note, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${managerMembership.id},
        clock_timestamp() + interval '11 hours',
        clock_timestamp() + interval '12 hours',
        'manager_on_duty', ${'x'.repeat(1000)}, true)
      returning id`;
    const [managedFieldState] = await transaction`
      select
        (select status from mileage_entries where id = ${fieldMileage.id}) as mileage_status,
        (select status from job_issue_reports where id = ${fieldIssue.id}) as issue_status,
        (select count(*)::int from job_communications where id = ${fieldCommunication.id}) as communication_count,
        (select count(*)::int from team_duty_assignments where id = ${fieldDuty.id}) as duty_count`;
    invariant(
      managedFieldState.mileage_status === 'approved'
        && managedFieldState.issue_status === 'resolved'
        && managedFieldState.communication_count === 1
        && managedFieldState.duty_count === 1,
      'Manager could not complete the team-scoped field operation lifecycle',
    );
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleaner.id}, true)`;
    const [cleanerDutyContact] = await transaction`
      select count(*)::int as count, max(display_name) as display_name,
        count(*) filter (where id in (${futureFieldDuty.id}, ${longNoteDuty.id}))::int
          as future_count
      from private.current_cleaner_duty_coverage()
      where id in (${fieldDuty.id}, ${futureFieldDuty.id}, ${longNoteDuty.id})`;
    const [hiddenDutyRows] = await transaction`
      select count(*)::int as count from team_duty_assignments
      where id in (${fieldDuty.id}, ${futureFieldDuty.id}, ${longNoteDuty.id})`;
    invariant(
      cleanerDutyContact.count === 1
        && cleanerDutyContact.display_name === 'Team Manager'
        && cleanerDutyContact.future_count === 0
        && hiddenDutyRows.count === 0,
      'Cleaner duty projection exposed future coverage or raw workforce metadata',
    );
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${owner.id}, true)`;
    await transaction`
      update workforce_memberships
      set status = 'paused', status_reason = 'Verifier duty authority revoked'
      where id = ${managerMembership.id}`;
    const [revokedDuty] = await transaction`
      select count(*)::int as count,
        bool_and(status = 'canceled') as all_canceled,
        bool_and(note like '%Automatically canceled%') as all_annotated
      from team_duty_assignments
      where id in (${fieldDuty.id}, ${futureFieldDuty.id}, ${longNoteDuty.id})`;
    const [longDutyAudit] = await transaction`
      select char_length(note)::int as note_length,
        note like '%Automatically canceled because the assigned membership became inactive or changed scope.'
          as retained_reason
      from team_duty_assignments where id = ${longNoteDuty.id}`;
    invariant(
      revokedDuty.count === 3 && revokedDuty.all_canceled && revokedDuty.all_annotated
        && longDutyAudit.note_length === 1000 && longDutyAudit.retained_reason,
      'Revoking a duty-holder membership did not cancel current coverage with audit context',
    );
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleaner.id}, true)`;
    const [revokedDutyContact] = await transaction`
      select count(*)::int as count
      from private.current_cleaner_duty_coverage()
      where id in (${fieldDuty.id}, ${futureFieldDuty.id}, ${longNoteDuty.id})`;
    invariant(
      revokedDutyContact.count === 0,
      'Cleaner retained a revoked manager-on-duty contact',
    );
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${owner.id}, true)`;
    await transaction`
      update workforce_memberships
      set status = 'active', status_reason = 'Verifier manager access restored',
          ended_at = null
      where id = ${managerMembership.id}`;
    await expectDatabaseError(transaction, ['55000'], 'reactivation of canceled duty coverage', async (savepoint) => {
      await savepoint`
        update team_duty_assignments set status = 'active'
        where id = ${fieldDuty.id}`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', ${teamBManager.id}, true)`;
    const [crossTeamFieldRows] = await transaction`
      select
        (select count(*)::int from service_location_assessments where team_id = ${teamA.id})
          + (select count(*)::int from schedule_proposals where team_id = ${teamA.id})
          + (select count(*)::int from job_communications where team_id = ${teamA.id})
          + (select count(*)::int from mileage_entries where team_id = ${teamA.id})
          + (select count(*)::int from job_issue_reports where team_id = ${teamA.id})
          + (select count(*)::int from team_duty_assignments where team_id = ${teamA.id})
          as count`;
    invariant(crossTeamFieldRows.count === 0,
      'A manager from another team could read local field-operation records');
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await expectDatabaseError(transaction, ['42501'], 'bonus inserted with forged payment evidence', async (savepoint) => {
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
           amount_cents, effective_from, reason)
        values (${organization.id}, ${teamA.id}, ${managerMembership.id}, 'hourly',
          5000, current_date, 'Forbidden self rate')`;
    });
    const [cleanerRestock] = await transaction`
      select id, version from restock_requests
      where requested_by_membership_id = ${cleanerMembership.id}
        and status = 'requested' limit 1`;
    await expectDatabaseError(transaction, ['55000'], 'restock lifecycle bypass', async (savepoint) => {
      await savepoint`
        update restock_requests
        set status = 'received'
        where id = ${cleanerRestock.id}`;
    });
    await transaction`
      update cleaner_time_off
      set status = 'approved', review_reason = null
      where id = ${teamTimeOff.id} and version = 1`;
    const [approvedTimeOff] = await transaction`
      select status, reviewed_by_membership_id, reviewed_by_label,
        reviewed_at is not null as reviewed_at_set, version
      from cleaner_time_off
      where id = ${teamTimeOff.id}`;
    invariant(
      approvedTimeOff.status === 'approved'
        && approvedTimeOff.reviewed_by_membership_id === managerMembership.id
        && approvedTimeOff.reviewed_by_label === 'Manager'
        && approvedTimeOff.reviewed_at_set
        && approvedTimeOff.version === 2,
      'Manager time-off review did not receive database-stamped evidence',
    );

    await transaction`select set_config('lakeandpine.current_customer_id', ${jobCustomer.id}, true)`;
    await expectDatabaseError(transaction, ['23514'], 'tip intent before completed service', async (savepoint) => {
      await savepoint`
        insert into tip_intents
          (organization_id, team_id, team_job_allocation_id, customer_id,
           cleaner_id, amount_cents, note, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${jobCustomer.id},
          ${cleaner.id}, 1000, 'Premature verifier tip', true)`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    const [rescheduleCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, priority, is_dev_seed)
      values ('VERIFY-TEAM-RESCHEDULE', 'reschedule', ${teamBooking.id},
        ${jobCustomer.id}, ${teamA.id},
        ${transaction.json({ name: 'Verified Job Customer', email: 'verified-job-customer@verify.invalid' })},
        'Verifier staged reschedule request', 'action_planned', 'normal', true)
      returning id`;
    const [rescheduleProposal] = await transaction`
      insert into schedule_proposals
        (organization_id, team_id, team_job_allocation_id, job_schedule_id,
         service_case_id, proposed_start_at, proposed_end_at, customer_id,
         arrival_window_start, arrival_window_end, proposal_note, expires_at,
         is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id},
        ${teamSchedule.id}, ${rescheduleCase.id},
        '2030-08-12T16:00:00.000Z', '2030-08-12T19:00:00.000Z',
        ${jobCustomer.id}, '2030-08-12T15:00:00.000Z',
        '2030-08-12T17:00:00.000Z', 'Verifier replacement window',
        '2030-08-12T16:00:00.000Z', true)
      returning id`;
    await transaction`
      update service_cases set status = 'awaiting_customer'
      where id = ${rescheduleCase.id}`;
    const [stagedRescheduleState] = await transaction`
      select schedule.start_at::text as start_at, schedule.end_at::text as end_at,
        schedule.status as schedule_status, proposal.status as proposal_status,
        service_case.status as case_status
      from job_schedules schedule
      join schedule_proposals proposal on proposal.id = ${rescheduleProposal.id}
      join service_cases service_case on service_case.id = ${rescheduleCase.id}
      where schedule.id = ${teamSchedule.id}`;
    invariant(
      Date.parse(stagedRescheduleState.start_at) === Date.parse(jobStart)
        && Date.parse(stagedRescheduleState.end_at) === Date.parse(jobEnd)
        && stagedRescheduleState.schedule_status === 'confirmed'
        && stagedRescheduleState.proposal_status === 'pending_customer'
        && stagedRescheduleState.case_status === 'awaiting_customer',
      'Staging a reschedule mutated the live confirmed schedule before customer approval',
    );
    await transaction`select set_config('lakeandpine.current_customer_id', ${jobCustomer.id}, true)`;
    await transaction`
      update schedule_proposals
      set status = 'approved', customer_response_note = 'Verifier replacement approved'
      where id = ${rescheduleProposal.id}`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`
      update schedule_proposals set status = 'superseded'
      where job_schedule_id = ${teamSchedule.id}
        and status = 'approved' and id <> ${rescheduleProposal.id}`;
    await transaction`
      update job_schedules
      set start_at = '2030-08-12T16:00:00.000Z',
          end_at = '2030-08-12T19:00:00.000Z',
          status = 'confirmed', version = version + 1
      where id = ${teamSchedule.id}`;
    await transaction`
      update service_cases
      set status = 'resolved', resolution_type = 'rescheduled',
          resolution_summary = 'Verifier customer approval applied by manager.',
          resolved_at = now(), closed_at = null
      where id = ${rescheduleCase.id} and status = 'awaiting_customer'`;
    const [appliedRescheduleState] = await transaction`
      select schedule.start_at::text as start_at, schedule.end_at::text as end_at,
        schedule.status as schedule_status, proposal.status as proposal_status,
        original.status as original_status, service_case.status as case_status,
        service_case.resolution_type
      from job_schedules schedule
      join schedule_proposals proposal on proposal.id = ${rescheduleProposal.id}
      join schedule_proposals original on original.id = ${scheduleProposal.id}
      join service_cases service_case on service_case.id = ${rescheduleCase.id}
      where schedule.id = ${teamSchedule.id}`;
    invariant(
      Date.parse(appliedRescheduleState.start_at) === Date.parse('2030-08-12T16:00:00.000Z')
        && Date.parse(appliedRescheduleState.end_at) === Date.parse('2030-08-12T19:00:00.000Z')
        && appliedRescheduleState.schedule_status === 'confirmed'
        && appliedRescheduleState.proposal_status === 'approved'
        && appliedRescheduleState.original_status === 'superseded'
        && appliedRescheduleState.case_status === 'resolved'
        && appliedRescheduleState.resolution_type === 'rescheduled',
      'Approved reschedule was not applied atomically with proposal and case state',
    );

    await expectDatabaseError(transaction, ['55000'], 'future dispatch before the approved travel-buffer boundary', async (savepoint) => {
      await savepoint`
        update job_schedules set status = 'en_route', version = version + 1
        where id = ${teamSchedule.id}`;
    });
    const [executionClock] = await transaction`
      select zone.name as timezone,
        (clock_timestamp() + interval '1 minute')::text as start_at,
        (clock_timestamp() + interval '181 minutes')::text as end_at,
        (clock_timestamp() - interval '1 minute')::text as window_start,
        (clock_timestamp() + interval '119 minutes')::text as window_end,
        (clock_timestamp() + interval '11 minutes')::text as early_start_at,
        (clock_timestamp() + interval '191 minutes')::text as early_end_at,
        (clock_timestamp() + interval '10 minutes')::text as early_window_start,
        (clock_timestamp() + interval '130 minutes')::text as early_window_end,
        (clock_timestamp() at time zone zone.name)::date::text as local_date,
        extract(dow from clock_timestamp() at time zone zone.name)::int
          as day_of_week,
        (clock_timestamp() at time zone territory.timezone)::date::text
          as territory_local_date,
        extract(dow from clock_timestamp() at time zone territory.timezone)::int
          as territory_day_of_week
      from pg_timezone_names zone
      cross join service_territories territory
      where (clock_timestamp() at time zone zone.name)::time
          between time '10:00' and time '11:59:59'
        and territory.id = ${jobTerritory.id}
        and not exists (
          select 1
          from team_job_allocations allocation
          join job_schedules schedule on schedule.id = allocation.job_schedule_id
          where allocation.organization_id = ${organization.id}
            and allocation.team_id = ${teamA.id}
            and schedule.status in (
              'tentative', 'held', 'confirmed', 'en_route',
              'in_progress', 'quality_review'
            )
            and (
              (schedule.start_at at time zone zone.name)::date
                <> (schedule.end_at at time zone zone.name)::date
              or (schedule.start_at at time zone zone.name)::time > time '23:00'
            )
        )
        and not exists (
          select 1
          from schedule_proposals proposal
          join job_schedules schedule on schedule.id = proposal.job_schedule_id
          where proposal.organization_id = ${organization.id}
            and proposal.team_id = ${teamA.id}
            and proposal.status in (
              'draft', 'pending_customer', 'approved', 'changes_requested'
            )
            and (
              (coalesce(proposal.proposed_start_at, schedule.start_at)
                at time zone zone.name)::date
                <> (coalesce(proposal.proposed_end_at, schedule.end_at)
                  at time zone zone.name)::date
              or (coalesce(proposal.proposed_start_at, schedule.start_at)
                at time zone zone.name)::time > time '23:00'
            )
        )
      order by zone.name
      limit 1`;
    invariant(executionClock?.timezone,
      'No verifier timezone could place the live execution fixture inside branch hours');
    await transaction`
      insert into cleaner_availability_rules
        (cleaner_id, territory_id, day_of_week, start_time, end_time,
         effective_from, status)
      select cleaner_id, ${jobTerritory.id}, day_of_week,
        '00:00', '23:59', '2020-01-01', 'active'
      from unnest(array[${cleaner.id}::uuid, ${leadCleaner.id}::uuid])
        as cleaners(cleaner_id)
      cross join generate_series(0, 6) as days(day_of_week)`;
    await transaction`
      update service_territories set timezone = ${executionClock.timezone}
      where id = ${jobTerritory.id}`;
    await transaction`
      update cleaning_teams
      set timezone = ${executionClock.timezone},
          operating_start_time = '00:00', latest_arrival_time = '23:00',
          hard_finish_time = '23:59'
      where id = ${teamA.id}`;
    const [executionCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, priority, is_dev_seed)
      values ('VERIFY-TEAM-EXECUTION-CLOCK', 'reschedule', ${teamBooking.id},
        ${jobCustomer.id}, ${teamA.id}, '{}'::jsonb,
        'Verifier current execution-window proposal', 'action_planned',
        'normal', true)
      returning id`;
    const [executionProposal] = await transaction`
      insert into schedule_proposals
        (organization_id, team_id, team_job_allocation_id, job_schedule_id,
         service_case_id, proposed_start_at, proposed_end_at, customer_id,
         arrival_window_start, arrival_window_end, proposal_note, expires_at,
         is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id},
        ${teamSchedule.id}, ${executionCase.id}, ${executionClock.early_start_at},
        ${executionClock.early_end_at}, ${jobCustomer.id},
        ${executionClock.early_window_start}, ${executionClock.early_window_end},
        'Verifier execution-window approval', clock_timestamp() + interval '1 day',
        true)
      returning id`;
    await transaction`
      update service_cases set status = 'awaiting_customer'
      where id = ${executionCase.id} and status = 'action_planned'`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${jobCustomer.id}, true)`;
    await transaction`
      update schedule_proposals set status = 'approved',
        customer_response_note = 'Verifier approved current execution window'
      where id = ${executionProposal.id}`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`
      update schedule_proposals set status = 'superseded'
      where job_schedule_id = ${teamSchedule.id}
        and id <> ${executionProposal.id}
        and status = 'approved'`;
    await transaction`
      update job_schedules
      set start_at = ${executionClock.early_start_at},
          end_at = ${executionClock.early_end_at},
          version = version + 1
      where id = ${teamSchedule.id} and status = 'confirmed'`;
    await transaction`
      update service_cases
      set status = 'resolved', resolution_type = 'rescheduled',
          resolution_summary = 'Verifier current execution window applied.',
          resolved_at = now()
      where id = ${executionCase.id} and status = 'awaiting_customer'`;
    await transaction`
      update job_schedules set status = 'en_route', version = version + 1
      where id = ${teamSchedule.id}`;
    await expectDatabaseError(transaction, ['55000'], 'service start before the approved arrival window', async (savepoint) => {
      await savepoint`
        update job_schedules set status = 'in_progress', version = version + 1
        where id = ${teamSchedule.id}`;
    });
    await transaction`
      update job_schedules set status = 'confirmed', version = version + 1
      where id = ${teamSchedule.id}`;
    const [liveExecutionCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, priority, is_dev_seed)
      values ('VERIFY-TEAM-LIVE-EXECUTION', 'reschedule', ${teamBooking.id},
        ${jobCustomer.id}, ${teamA.id}, '{}'::jsonb,
        'Verifier live execution-window proposal', 'action_planned',
        'normal', true)
      returning id`;
    const [liveExecutionProposal] = await transaction`
      insert into schedule_proposals
        (organization_id, team_id, team_job_allocation_id, job_schedule_id,
         service_case_id, proposed_start_at, proposed_end_at, customer_id,
         arrival_window_start, arrival_window_end, proposal_note, expires_at,
         is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id},
        ${teamSchedule.id}, ${liveExecutionCase.id}, ${executionClock.start_at},
        ${executionClock.end_at}, ${jobCustomer.id},
        ${executionClock.window_start}, ${executionClock.window_end},
        'Verifier live execution approval', clock_timestamp() + interval '1 day',
        true)
      returning id`;
    await transaction`
      update service_cases set status = 'awaiting_customer'
      where id = ${liveExecutionCase.id} and status = 'action_planned'`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${jobCustomer.id}, true)`;
    await transaction`
      update schedule_proposals set status = 'approved',
        customer_response_note = 'Verifier approved live execution window'
      where id = ${liveExecutionProposal.id}`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`
      update schedule_proposals set status = 'superseded'
      where job_schedule_id = ${teamSchedule.id}
        and id <> ${liveExecutionProposal.id}
        and status = 'approved'`;
    await transaction`
      update job_schedules
      set start_at = ${executionClock.start_at}, end_at = ${executionClock.end_at},
          version = version + 1
      where id = ${teamSchedule.id} and status = 'confirmed'`;
    await transaction`
      update service_cases
      set status = 'resolved', resolution_type = 'rescheduled',
          resolution_summary = 'Verifier live execution window applied.',
          resolved_at = now()
      where id = ${liveExecutionCase.id} and status = 'awaiting_customer'`;
    await transaction`
      update job_schedules set status = 'en_route', version = version + 1
      where id = ${teamSchedule.id}`;
    await transaction`
      update job_schedules set status = 'in_progress', version = version + 1
      where id = ${teamSchedule.id}`;
    await expectDatabaseError(transaction, ['42501'], 'proposed assignment on in-progress work', async (savepoint) => {
      await savepoint`
        insert into job_assignments
          (job_schedule_id, cleaner_id, team_id, assignment_role, status,
           is_dev_seed)
        values (${teamSchedule.id}, ${unassignedCleaner.id}, ${teamA.id},
          'member', 'proposed', true)`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleaner.id}, true)`;
    await expectDatabaseError(transaction, ['55000'], 'linked mileage with wrong team-local service date', async (savepoint) => {
      await savepoint`
        insert into mileage_entries
          (organization_id, team_id, cleaner_id,
           team_job_allocation_id, service_date, miles, purpose, is_dev_seed)
        select ${organization.id}, ${teamA.id}, ${cleaner.id},
          ${teamAllocation.id},
          (schedule.start_at at time zone team.timezone)::date + 1,
          8, 'to_job', true
        from job_schedules schedule
        join cleaning_teams team on team.id = ${teamA.id}
          and team.organization_id = ${organization.id}
        where schedule.id = ${teamSchedule.id}`;
    });
    const [linkedFieldMileage] = await transaction`
      insert into mileage_entries
        (organization_id, team_id, cleaner_id,
         team_job_allocation_id, service_date, miles, purpose, note, is_dev_seed)
      select ${organization.id}, ${teamA.id}, ${cleaner.id},
        ${teamAllocation.id},
        (schedule.start_at at time zone team.timezone)::date,
        8, 'to_job', 'Verifier linked mileage submission', true
      from job_schedules schedule
      join cleaning_teams team on team.id = ${teamA.id}
        and team.organization_id = ${organization.id}
      where schedule.id = ${teamSchedule.id}
      returning id`;
    await transaction`
      update mileage_entries
      set miles = 8.5, note = 'Verifier cleaner mileage revision'
      where id = ${linkedFieldMileage.id}`;
    const [revisedLinkedMileage] = await transaction`
      select status, miles::float8 as miles, note, version,
        reviewed_by_membership_id, reviewed_at
      from mileage_entries where id = ${linkedFieldMileage.id}`;
    invariant(
      revisedLinkedMileage.status === 'submitted'
        && revisedLinkedMileage.miles === 8.5
        && revisedLinkedMileage.note === 'Verifier cleaner mileage revision'
        && revisedLinkedMileage.version === 2
        && revisedLinkedMileage.reviewed_by_membership_id === null
        && revisedLinkedMileage.reviewed_at === null,
      'Cleaner could not revise linked mileage inside the visit evidence window',
    );
    await transaction`
      update checklist_items
      set state = 'completed', completion_note = 'Verifier cleaner evidence'
      where id = ${fieldChecklist.id}`;
    const [completedChecklist] = await transaction`
      select state, completed_by_membership_id, completed_by_cleaner_id,
        completed_at is not null as completed_at_set, version
      from checklist_items where id = ${fieldChecklist.id}`;
    invariant(
      completedChecklist.state === 'completed'
        && completedChecklist.completed_by_membership_id === cleanerMembership.id
        && completedChecklist.completed_by_cleaner_id === cleaner.id
        && completedChecklist.completed_at_set
        && completedChecklist.version === 2,
      'In-progress cleaner checklist completion did not record actor evidence',
    );
    await transaction`
      update checklist_items
      set state = 'skipped', completion_note = 'Customer asked us not to move the display.'
      where id = ${fieldSkippedChecklist.id}`;
    const [skippedChecklist] = await transaction`
      select state, completion_note, completed_by_membership_id,
        completed_by_cleaner_id, completed_at is not null as completed_at_set,
        version
      from checklist_items where id = ${fieldSkippedChecklist.id}`;
    invariant(
      skippedChecklist.state === 'skipped'
        && skippedChecklist.completion_note === 'Customer asked us not to move the display.'
        && skippedChecklist.completed_by_membership_id === cleanerMembership.id
        && skippedChecklist.completed_by_cleaner_id === cleaner.id
        && skippedChecklist.completed_at_set
        && skippedChecklist.version === 2,
      'Skipped in-progress checklist item did not retain cleaner exception evidence',
    );
    await transaction`
      update checklist_items
      set state = 'pending', completion_note = null
      where id = ${fieldSkippedChecklist.id}`;
    const [resetChecklist] = await transaction`
      select state, completion_note, completed_by_membership_id,
        completed_by_cleaner_id, completed_at, version
      from checklist_items where id = ${fieldSkippedChecklist.id}`;
    invariant(
      resetChecklist.state === 'pending'
        && resetChecklist.completion_note === null
        && resetChecklist.completed_by_membership_id === null
        && resetChecklist.completed_by_cleaner_id === null
        && resetChecklist.completed_at === null
        && resetChecklist.version === 3,
      'Returning a checklist item to pending did not clear prior actor evidence',
    );
    await transaction`
      update checklist_items
      set state = 'skipped', completion_note = 'Customer exception reconfirmed.'
      where id = ${fieldSkippedChecklist.id}`;
    const [reskippedChecklist] = await transaction`
      select state, completed_by_membership_id, completed_by_cleaner_id,
        completed_at is not null as completed_at_set, version
      from checklist_items where id = ${fieldSkippedChecklist.id}`;
    invariant(
      reskippedChecklist.state === 'skipped'
        && reskippedChecklist.completed_by_membership_id === cleanerMembership.id
        && reskippedChecklist.completed_by_cleaner_id === cleaner.id
        && reskippedChecklist.completed_at_set
        && reskippedChecklist.version === 4,
      'Checklist exception evidence was not re-stamped after a pending reset',
    );
    const [timeEntry] = await transaction`
      insert into job_time_entries
        (organization_id, team_id, team_job_allocation_id, cleaner_id, source)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${cleaner.id},
        'crew_timer')
      returning id, clock_in_at, estimated_minutes_snapshot,
        created_by_membership_id, status, version`;
    invariant(
      timeEntry.status === 'open' && timeEntry.version === 1
        && timeEntry.clock_in_at
        && timeEntry.estimated_minutes_snapshot === 180
        && timeEntry.created_by_membership_id === cleanerMembership.id,
      'Crew clock creation did not receive trusted database evidence',
    );
    await expectDatabaseError(transaction, ['42501'], 'cleaner self-approval of live time', async (savepoint) => {
      await savepoint`
        update job_time_entries
        set status = 'approved',
            approved_by_membership_id = ${cleanerMembership.id}, approved_at = now(),
            version = version + 1
        where id = ${timeEntry.id} and version = 1`;
    });
    await expectDatabaseError(transaction, ['42501'], 'cleaner rewriting live time estimate', async (savepoint) => {
      await savepoint`
        update job_time_entries
        set status = 'submitted', estimated_minutes_snapshot = 60
        where id = ${timeEntry.id} and version = 1`;
    });
    await expectDatabaseError(transaction, ['23514'], 'break longer than live elapsed shift', async (savepoint) => {
      await savepoint`
        update job_time_entries
        set break_minutes = 10, status = 'submitted'
        where id = ${timeEntry.id} and version = 1`;
    });
    await transaction`
      update job_time_entries
      set break_minutes = 0, status = 'submitted'
      where id = ${timeEntry.id} and version = 1`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${leadCleaner.id}, true)`;
    const [leadTimeEntry] = await transaction`
      insert into job_time_entries
        (organization_id, team_id, team_job_allocation_id, cleaner_id, source)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${leadCleaner.id},
        'crew_timer')
      returning id`;
    await transaction`
      update job_time_entries
      set break_minutes = 0, status = 'submitted'
      where id = ${leadTimeEntry.id} and version = 1`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleaner.id}, true)`;
    const [cleanerRawTimeScope] = await transaction`
      select
        (select count(*)::int from job_time_entries
          where id in (${timeEntry.id}, ${leadTimeEntry.id})) as time_entries,
        (select count(*)::int from cleaner_time_off
          where id = ${teamTimeOff.id}) as time_off`;
    invariant(
      cleanerRawTimeScope.time_entries === 1
        && cleanerRawTimeScope.time_off === 1,
      'Cleaner raw time access was not limited to their own evidence',
    );
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    const [managerRawTimeScope] = await transaction`
      select
        (select count(*)::int from job_time_entries
          where id in (${timeEntry.id}, ${leadTimeEntry.id})) as time_entries,
        (select count(*)::int from cleaner_time_off
          where id = ${teamTimeOff.id}) as time_off`;
    await transaction`
      select set_config('lakeandpine.current_customer_id', ${generalManager.id}, true)`;
    const [gmRawTimeScope] = await transaction`
      select
        (select count(*)::int from job_time_entries
          where id in (${timeEntry.id}, ${leadTimeEntry.id})) as time_entries,
        (select count(*)::int from cleaner_time_off
          where id = ${teamTimeOff.id}) as time_off`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${owner.id}, true)`;
    const [ownerRawTimeScope] = await transaction`
      select
        (select count(*)::int from job_time_entries
          where id in (${timeEntry.id}, ${leadTimeEntry.id})) as time_entries,
        (select count(*)::int from cleaner_time_off
          where id = ${teamTimeOff.id}) as time_off`;
    await transaction`
      select set_config('lakeandpine.current_customer_id', ${teamBManager.id}, true)`;
    const [foreignRawTimeScope] = await transaction`
      select
        (select count(*)::int from job_time_entries
          where id in (${timeEntry.id}, ${leadTimeEntry.id})) as time_entries,
        (select count(*)::int from cleaner_time_off
          where id = ${teamTimeOff.id}) as time_off`;
    invariant(
      managerRawTimeScope.time_entries === 2 && managerRawTimeScope.time_off === 1
        && gmRawTimeScope.time_entries === 2 && gmRawTimeScope.time_off === 1
        && ownerRawTimeScope.time_entries === 2 && ownerRawTimeScope.time_off === 1
        && foreignRawTimeScope.time_entries === 0
        && foreignRawTimeScope.time_off === 0,
      'Raw time or time-off access crossed owner/GM/exact-manager team scope',
    );
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`
      update mileage_entries
      set status = 'approved', review_note = 'Verifier linked-mileage approval'
      where id = ${linkedFieldMileage.id}`;
    const [approvedLinkedMileage] = await transaction`
      select status, miles::float8 as miles, note, review_note,
        reviewed_by_membership_id, reviewed_at is not null as reviewed_at_set,
        version
      from mileage_entries where id = ${linkedFieldMileage.id}`;
    invariant(
      approvedLinkedMileage.status === 'approved'
        && approvedLinkedMileage.miles === 8.5
        && approvedLinkedMileage.note === 'Verifier cleaner mileage revision'
        && approvedLinkedMileage.review_note === 'Verifier linked-mileage approval'
        && approvedLinkedMileage.reviewed_by_membership_id === managerMembership.id
        && approvedLinkedMileage.reviewed_at_set
        && approvedLinkedMileage.version === 3,
      'Manager review did not preserve the revised linked-mileage evidence',
    );
    const [expiredMileageClock] = await transaction`
      select
        ((date_trunc('day', clock_timestamp() at time zone team.timezone)
          - interval '20 days' + interval '12 hours')
          at time zone team.timezone)::text as start_at,
        ((date_trunc('day', clock_timestamp() at time zone team.timezone)
          - interval '20 days' + interval '13 hours')
          at time zone team.timezone)::text as end_at,
        (date_trunc('day', clock_timestamp() at time zone team.timezone)
          - interval '20 days')::date::text as local_date
      from cleaning_teams team
      where team.id = ${teamA.id} and team.organization_id = ${organization.id}`;
    const [expiredMileageBooking] = await transaction`
      insert into bookings
        (customer_id, service_id, scheduled_date, scheduled_window, status, contact,
         is_dev_seed, service_vertical, territory_id, qualification_status,
         estimated_duration_minutes, required_crew_size, required_skills)
      values (${jobCustomer.id}, 'estate', ${expiredMileageClock.local_date},
        'Expired mileage evidence window', 'requested',
        ${transaction.json({ name: 'Expired mileage verifier', email: 'verified-job-customer@verify.invalid', zip: '83816' })},
        true, 'estate', ${jobTerritory.id}, 'approved', 60, 1,
        array['estate_detail'])
      returning id`;
    const [expiredMileageSchedule] = await transaction`select gen_random_uuid() as id`;
    await transaction`
      insert into job_schedules
        (id, booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${expiredMileageSchedule.id}, ${expiredMileageBooking.id}, ${jobTerritory.id}, 'estate',
        ${expiredMileageClock.start_at}, ${expiredMileageClock.end_at},
        1, array['estate_detail'], 60, true)`;
    await transaction`
      insert into job_assignments
        (job_schedule_id, cleaner_id, team_id, assignment_role, status, is_dev_seed)
      values (${expiredMileageSchedule.id}, ${cleaner.id}, ${teamA.id},
        'member', 'accepted', true)`;
    const [expiredMileageAllocation] = await transaction`
      insert into team_job_allocations
        (organization_id, team_id, job_schedule_id)
      values (${organization.id}, ${teamA.id}, ${expiredMileageSchedule.id})
      returning id`;
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${cleaner.id}, true)`;
    await expectDatabaseError(transaction, ['55000'], 'linked mileage after fourteen-day evidence window', async (savepoint) => {
      await savepoint`
        insert into mileage_entries
          (organization_id, team_id, cleaner_id,
           team_job_allocation_id, service_date, miles, purpose, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${cleaner.id},
          ${expiredMileageAllocation.id}, ${expiredMileageClock.local_date},
          3.5, 'to_job', true)`;
    });
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`
      update job_schedules set status = 'canceled', version = version + 1
      where id = ${expiredMileageSchedule.id}`;
    await transaction`
      update job_time_entries
      set status = 'approved', review_reason = null
      where id in (${timeEntry.id}, ${leadTimeEntry.id}) and version = 2`;
    const [approvedTeamTime] = await transaction`
      select count(*)::int as count,
        bool_and(reviewed_at is not null) as reviewed,
        bool_and(version = 3) as versioned
      from job_time_entries
      where id in (${timeEntry.id}, ${leadTimeEntry.id})
        and status = 'approved'
        and approved_by_membership_id = ${managerMembership.id}`;
    invariant(
      approvedTeamTime.count === 2 && approvedTeamTime.reviewed
        && approvedTeamTime.versioned,
      'Manager time review did not receive database-stamped evidence',
    );
    await transaction`
      update job_schedules set status = 'quality_review', version = version + 1
      where id = ${teamSchedule.id}`;
    await expectDatabaseError(transaction, ['55000'], 'route decision rewrite after execution began', async (savepoint) => {
      await savepoint`
        update service_location_assessments
        set assessment_status = 'approved_exception',
            override_reason = 'Forbidden historical route decision rewrite'
        where id = ${unallocatedAssessment.id}`;
    });
    await expectDatabaseError(transaction, ['55000'], 'checklist rewrite after quality review', async (savepoint) => {
      await savepoint`
        update checklist_items
        set state = 'skipped', completion_note = 'Forbidden evidence rewrite'
        where id = ${fieldChecklist.id}`;
    });
    await transaction`
      update job_schedules set status = 'completed', version = version + 1
      where id = ${teamSchedule.id}`;
    await expectDatabaseError(transaction, ['42501'], 'proposed assignment on completed work', async (savepoint) => {
      await savepoint`
        insert into job_assignments
          (job_schedule_id, cleaner_id, team_id, assignment_role, status,
           is_dev_seed)
        values (${teamSchedule.id}, ${unassignedCleaner.id}, ${teamA.id},
          'member', 'proposed', true)`;
    });
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${wrongCustomer.id}, true
      )`;
    await expectDatabaseError(transaction, ['23514'], 'verified review from wrong customer', async (savepoint) => {
      await savepoint`
        insert into quality_reviews
          (organization_id, team_id, team_job_allocation_id, cleaner_id, customer_id,
           rating, source, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${cleaner.id},
          ${wrongCustomer.id}, 5, 'verified_customer', true)`;
    });
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${jobCustomer.id}, true
      )`;
    const [qualityReview] = await transaction`
      insert into quality_reviews
        (organization_id, team_id, team_job_allocation_id, cleaner_id, customer_id,
         rating, source, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${cleaner.id},
        ${jobCustomer.id}, 5, 'verified_customer', true)
      returning id, verified_at, evidence_reference, created_by_membership_id`;
    invariant(
      qualityReview?.verified_at
        && qualityReview.evidence_reference
          === `customer:${jobCustomer.id}:allocation:${teamAllocation.id}`
        && qualityReview.created_by_membership_id === null,
      'Customer review did not receive trusted verification evidence',
    );
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${manager.id}, true
      )`;
    const [qualityBonus] = await transaction`
      select count(*)::int as count, max(amount_cents)::int as amount_cents
      from bonus_awards
      where quality_review_id = ${qualityReview.id} and bonus_tier_id = ${bonusTier.id}`;
    invariant(qualityBonus.count === 1 && qualityBonus.amount_cents === 2500,
      'Completed verified customer review did not create exactly one configured bonus');

    await transaction`select set_config('lakeandpine.current_customer_id', ${jobCustomer.id}, true)`;
    await transaction`
      insert into customer_cleaner_preferences
        (organization_id, team_id, customer_id, cleaner_id,
         source_allocation_id, preference, note, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${jobCustomer.id}, ${cleaner.id},
        ${teamAllocation.id}, 'preferred', 'Verifier continuity preference', true)`;
    await expectDatabaseError(transaction, ['23514'], 'completed-source avoid while future assignment remains active', async (savepoint) => {
      await savepoint`
        insert into customer_cleaner_preferences
          (organization_id, team_id, customer_id, cleaner_id,
           source_allocation_id, preference, note, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${jobCustomer.id},
          ${leadCleaner.id}, ${teamAllocation.id}, 'avoid',
          'Must reassign the separate held job first', true)`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`
      update job_assignments set status = 'removed', responded_at = now()
      where job_schedule_id = ${staffLeadSchedule.id}
        and cleaner_id = ${leadCleaner.id}`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${jobCustomer.id}, true)`;
    await transaction`
      insert into customer_cleaner_preferences
        (organization_id, team_id, customer_id, cleaner_id,
         source_allocation_id, preference, note, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${jobCustomer.id},
        ${leadCleaner.id}, ${teamAllocation.id}, 'avoid',
        'Verifier completed-service do-not-schedule control', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await expectDatabaseError(transaction, ['23514'], 'allocation containing an avoided cleaner', async (savepoint) => {
      await savepoint`
        insert into team_job_allocations
          (organization_id, team_id, job_schedule_id)
        values (${organization.id}, ${teamA.id}, ${avoidSchedule.id})`;
    });
    await transaction`select set_config('lakeandpine.current_customer_id', ${jobCustomer.id}, true)`;
    await expectDatabaseError(transaction, ['23514'], 'tip attributed to cleaner who did not work the job', async (savepoint) => {
      await savepoint`
        insert into tip_intents
          (organization_id, team_id, team_job_allocation_id, customer_id,
           cleaner_id, amount_cents, note, is_dev_seed)
        values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${jobCustomer.id},
          ${unassignedCleaner.id}, 1500, 'Forged cleaner attribution', true)`;
    });
    const [tipIntent] = await transaction`
      insert into tip_intents
        (organization_id, team_id, team_job_allocation_id, customer_id,
         cleaner_id, amount_cents, note, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${jobCustomer.id},
        ${cleaner.id}, 2500, 'Verifier non-cash tip intent', true)
      returning id, status, provider, version, recorded_by_membership_id,
        decision_customer_id, decision_at`;
    invariant(
      tipIntent.status === 'pending_collection'
        && tipIntent.provider === 'manual'
        && tipIntent.version === 1
        && tipIntent.recorded_by_membership_id === null
        && tipIntent.decision_customer_id === null
        && tipIntent.decision_at === null,
      'Tip intent did not receive database-owned initial evidence',
    );
    const [leadTipIntent] = await transaction`
      insert into tip_intents
        (organization_id, team_id, team_job_allocation_id, customer_id,
         cleaner_id, amount_cents, note, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${teamAllocation.id}, ${jobCustomer.id},
        ${leadCleaner.id}, 1800, 'Verifier per-cleaner lead tip intent', true)
      returning id`;
    await expectDatabaseError(transaction, ['42501', '23514'],
      'customer forged a collected tip', async (savepoint) => {
        await savepoint`
          update tip_intents set status = 'recorded', provider_reference = 'forged'
          where id = ${tipIntent.id}`;
      });
    const [customerFieldState] = await transaction`
      select
        (select count(*)::int from team_job_allocations
          where id = ${teamAllocation.id}) as allocation_count,
        (select count(*)::int from private.current_customer_job_assignments()
          where team_job_allocation_id = ${teamAllocation.id}
            and cleaner_id = ${cleaner.id}) as assigned_cleaner_count,
        (select count(*)::int from schedule_proposals where id = ${scheduleProposal.id})
          as proposal_count,
        (select count(*)::int from schedule_proposals proposal
          join cleaning_teams team on team.id = proposal.team_id
          where proposal.id = ${scheduleProposal.id}) as proposal_team_count,
        (select count(*)::int from customer_cleaner_preferences
          where source_allocation_id = ${teamAllocation.id}) as preference_count,
        (select count(*)::int from tip_intents where id = ${tipIntent.id}
          and status = 'pending_collection') as pending_tip_count`;
    invariant(customerFieldState.allocation_count === 1
      && customerFieldState.assigned_cleaner_count === 1
      && customerFieldState.proposal_count === 1
      && customerFieldState.proposal_team_count === 1
      && customerFieldState.preference_count === 2
      && customerFieldState.pending_tip_count === 1,
      'Customer field controls did not preserve approval, continuity, and non-cash tip state');
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    const recordedTip = await transaction`
      update tip_intents
      set status = 'recorded', provider_reference = 'VERIFY-TIP-RECORDED-1'
      where id = ${tipIntent.id} and version = 1
      returning version`;
    invariant(
      recordedTip.length === 1 && recordedTip[0].version === 2,
      'Manager tip reconciliation did not atomically advance the evidence version',
    );
    const staleTipDecision = await transaction`
      update tip_intents
      set status = 'declined'
      where id = ${tipIntent.id} and version = 1
      returning id`;
    invariant(
      staleTipDecision.length === 0,
      'A stale tip reconciliation version overwrote the current decision',
    );
    await expectDatabaseError(transaction, ['42501'], 'terminal tip evidence rewrite', async (savepoint) => {
      await savepoint`
        update tip_intents
        set note = 'Forbidden terminal evidence rewrite'
        where id = ${tipIntent.id}`;
    });
    await expectDatabaseError(transaction, ['23505'], 'duplicate recorded tip provider reference', async (savepoint) => {
      await savepoint`
        update tip_intents
        set status = 'recorded', provider_reference = 'VERIFY-TIP-RECORDED-1'
        where id = ${leadTipIntent.id} and version = 1`;
    });
    const recordedLeadTip = await transaction`
      update tip_intents
      set status = 'recorded', provider_reference = 'VERIFY-TIP-RECORDED-2'
      where id = ${leadTipIntent.id} and version = 1
      returning version`;
    invariant(
      recordedLeadTip.length === 1 && recordedLeadTip[0].version === 2,
      'Independent per-cleaner tip reconciliation was not preserved',
    );

    // Commit an earlier-than-original recovery proposal whose short expiry can
    // be observed from a later request transaction. The follow-up verifier
    // proves a generic arrival-window action cannot detach this recovery case.
    const [expiredRescheduleCleaner] = await transaction`
      insert into cleaners
        (full_name, email, status, screening_status, screening_verified_at,
         home_territory_id, skills, vertical_experience, is_dev_seed)
      values ('Expired Reschedule Cleaner',
        'expired-reschedule-cleaner@verify.invalid', 'active', 'verified',
        now(), ${jobTerritory.id}, array['estate_detail'], array['estate'], true)
      returning id`;
    await transaction`
      insert into workforce_memberships
        (organization_id, team_id, cleaner_id, role, status, is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${expiredRescheduleCleaner.id},
        'cleaner', 'active', true)`;
    await transaction`
      insert into cleaner_availability_rules
        (cleaner_id, territory_id, day_of_week, start_time, end_time,
         effective_from, status)
      select ${expiredRescheduleCleaner.id}, ${jobTerritory.id}, day_of_week,
        '00:00', '23:59', '2020-01-01', 'active'
      from generate_series(0, 6) as days(day_of_week)`;
    const [expiredRescheduleBooking] = await transaction`
      insert into bookings
        (customer_id, service_id, scheduled_date, scheduled_window, status,
         contact, is_dev_seed, service_vertical, territory_id,
         qualification_status, estimated_duration_minutes,
         required_crew_size, required_skills)
      values (${jobCustomer.id}, 'estate', '2030-09-09',
        'Expired earlier reschedule proof', 'requested',
        ${transaction.json({
          name: 'Expired earlier reschedule proof',
          email: 'verified-job-customer@verify.invalid',
          street: '90 Recovery Way',
          city: "Coeur d'Alene",
          state: 'ID',
          zip: '83816',
        })}, true, 'estate', ${jobTerritory.id}, 'approved', 60, 1,
        array['estate_detail'])
      returning id`;
    const [expiredRescheduleSchedule] = await transaction`select gen_random_uuid() as id`;
    await transaction`
      insert into job_schedules
        (id, booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${expiredRescheduleSchedule.id}, ${expiredRescheduleBooking.id}, ${jobTerritory.id}, 'estate',
        '2030-09-09T16:00:00.000Z', '2030-09-09T17:00:00.000Z',
        1, array['estate_detail'], 60, true)`;
    await transaction`
      insert into job_assignments
        (job_schedule_id, cleaner_id, team_id, assignment_role, status, is_dev_seed)
      values (${expiredRescheduleSchedule.id}, ${expiredRescheduleCleaner.id}, ${teamA.id},
        'lead', 'accepted', true)`;
    const [expiredRescheduleAllocation] = await transaction`
      insert into team_job_allocations
        (organization_id, team_id, job_schedule_id)
      values (${organization.id}, ${teamA.id}, ${expiredRescheduleSchedule.id})
      returning id`;
    await transaction.unsafe('reset role');
    await transaction`
      insert into service_location_assessments
        (booking_id, organization_id, team_id, address_fingerprint,
         branch_origin_label, branch_origin_latitude, branch_origin_longitude,
         property_latitude, property_longitude, distance_miles,
         standard_radius_miles, calculation_method, assessment_status,
         provider, calculated_at, is_dev_seed)
      values (${expiredRescheduleBooking.id}, ${organization.id}, ${teamA.id},
        ${'2'.repeat(64)}, 'Downtown Coeur d''Alene verifier origin',
        47.677700, -116.780500, 47.700000, -116.800000, 2.1, 30,
        'straight_line', 'inside_standard_radius', 'manual', now(), true)`;
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    const [expiredRescheduleOriginalProposal] = await transaction`
      insert into schedule_proposals
        (organization_id, team_id, team_job_allocation_id, job_schedule_id,
         customer_id, arrival_window_start, arrival_window_end, proposal_note, expires_at,
         is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${expiredRescheduleAllocation.id},
        ${expiredRescheduleSchedule.id}, ${jobCustomer.id},
        '2030-09-09T15:00:00.000Z', '2030-09-09T17:00:00.000Z',
        'Verifier original arrival window', '2030-09-09T16:00:00.000Z', true)
      returning id`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${jobCustomer.id}, true)`;
    await transaction`
      update schedule_proposals
      set status = 'approved', customer_response_note = 'Original window approved'
      where id = ${expiredRescheduleOriginalProposal.id}`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    await transaction`
      update job_schedules set status = 'held', version = version + 1
      where id = ${expiredRescheduleSchedule.id}`;
    await transaction`
      update job_schedules set status = 'confirmed', version = version + 1
      where id = ${expiredRescheduleSchedule.id}`;
    const [expiredRescheduleCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, priority, is_dev_seed)
      values ('VERIFY-EXPIRED-EARLY-RESCHEDULE', 'reschedule',
        ${expiredRescheduleBooking.id}, ${jobCustomer.id}, ${teamA.id},
        ${transaction.json({
          name: 'Verified Job Customer',
          email: 'verified-job-customer@verify.invalid',
        })}, 'Verifier expired earlier-than-original recovery request',
        'action_planned', 'normal', true)
      returning id`;
    await transaction`
      insert into schedule_proposals
        (organization_id, team_id, team_job_allocation_id, job_schedule_id,
         service_case_id, proposed_start_at, proposed_end_at, customer_id,
         arrival_window_start, arrival_window_end, proposal_note, expires_at,
         is_dev_seed)
      values (${organization.id}, ${teamA.id}, ${expiredRescheduleAllocation.id},
        ${expiredRescheduleSchedule.id}, ${expiredRescheduleCase.id},
        '2030-09-02T16:00:00.000Z', '2030-09-02T17:00:00.000Z',
        ${jobCustomer.id}, '2030-09-02T15:00:00.000Z',
        '2030-09-02T17:00:00.000Z', 'Verifier expiring earlier recovery window',
        clock_timestamp() + interval '250 milliseconds', true)`;
    await transaction`
      update service_cases set status = 'awaiting_customer'
      where id = ${expiredRescheduleCase.id}`;

    await transaction`select set_config('lakeandpine.current_customer_id', ${wrongCustomer.id}, true)`;
    const [wrongCustomerAllocation] = await transaction`
      select
        (select count(*)::int from team_job_allocations
          where id = ${teamAllocation.id}) as allocation_count,
        (select count(*)::int from cleaning_teams where id = ${teamA.id}) as team_count`;
    invariant(wrongCustomerAllocation.allocation_count === 0
      && wrongCustomerAllocation.team_count === 0,
      'An unrelated customer could read another customer allocation or team');
  });
}

async function inspectLegacyChecklistActorBoundary(sql) {
  const [fixture] = await sql`
    select organization.id as organization_id,
      team.id as team_id, territory.id as territory_id,
      owner_actor.id as owner_id, gm_actor.id as gm_id,
      manager_actor.id as manager_id,
      manager_membership.id as manager_membership_id,
      booking_customer.id as booking_customer_id
    from organizations organization
    join cleaning_teams team on team.organization_id = organization.id
      and team.code = 'verify-team-a'
    join team_service_territories coverage
      on coverage.organization_id = organization.id
     and coverage.team_id = team.id
     and coverage.status = 'active'
    join service_territories territory on territory.id = coverage.territory_id
      and territory.code = 'national-verifier'
    cross join customers owner_actor
    cross join customers gm_actor
    cross join customers manager_actor
    cross join customers booking_customer
    join workforce_memberships manager_membership
      on manager_membership.organization_id = organization.id
     and manager_membership.team_id = team.id
     and manager_membership.customer_id = manager_actor.id
     and manager_membership.role = 'manager'
     and manager_membership.status = 'active'
    where organization.slug = 'lake-and-pine'
      and owner_actor.email = 'national-owner@verify.invalid'
      and gm_actor.email = 'general-manager@verify.invalid'
      and manager_actor.email = 'team-manager@verify.invalid'
      and booking_customer.email = 'verified-job-customer@verify.invalid'
    limit 1`;
  invariant(fixture?.organization_id && fixture.team_id && fixture.territory_id
    && fixture.owner_id && fixture.gm_id && fixture.manager_id
    && fixture.manager_membership_id && fixture.booking_customer_id,
  'Legacy checklist actor proof could not resolve national fixtures');
  const [planningWindow] = await sql`
    select make_timestamptz(2032, 1, 5, 12, 0, 0, timezone)::text as start_at,
      make_timestamptz(2032, 1, 5, 13, 0, 0, timezone)::text as end_at
    from cleaning_teams where id = ${fixture.team_id}`;
  const [legacyBooking] = await sql`
    insert into bookings
      (customer_id, service_id, scheduled_date, scheduled_window, status, contact,
       is_dev_seed, service_vertical, territory_id, qualification_status,
       estimated_duration_minutes, required_crew_size, required_skills)
    values (${fixture.booking_customer_id}, 'estate', '2032-01-05',
      'Legacy checklist intake verifier', 'requested',
      ${sql.json({ name: 'Legacy checklist verifier', email: 'verified-job-customer@verify.invalid', zip: '83816' })},
      true, 'estate', ${fixture.territory_id}, 'approved', 60, 1,
      array['estate_detail'])
    returning id`;

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      insert into checklist_items
        (booking_id, label, state, sort, is_dev_seed)
      values (${legacyBooking.id}, 'Verifier legacy owner checklist',
        'pending', 9001, true)`;
    await expectDatabaseError(transaction, ['23514', '42501', '55000'], 'system intake checklist with completion evidence', async (savepoint) => {
      await savepoint`
        insert into checklist_items
          (booking_id, label, state, sort, completion_note, is_dev_seed)
        values (${legacyBooking.id}, 'Forged pending intake evidence',
          'pending', 9002, 'Forbidden intake completion evidence', true)`;
    });
    await expectDatabaseError(transaction, ['23514', '42501', '55000'], 'system intake checklist inserted precompleted', async (savepoint) => {
      await savepoint`
        insert into checklist_items
          (booking_id, label, state, sort, completed_at,
           completed_by_membership_id, completion_note, is_dev_seed)
        values (${legacyBooking.id}, 'Forged completed intake item',
          'completed', 9003, now(), ${fixture.manager_membership_id},
          'Forbidden precompleted intake evidence', true)`;
    });
  });
  const [legacyChecklist] = await sql`
    select id from checklist_items
    where booking_id = ${legacyBooking.id}
      and label = 'Verifier legacy owner checklist'`;
  invariant(legacyChecklist?.id,
    'Null-actor intake did not create the one permitted pending checklist item');

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    const [nullActorRead] = await transaction`
      select count(*)::int as count from checklist_items
      where id = ${legacyChecklist.id}`;
    const nullActorUpdate = await transaction`
      update checklist_items set completion_note = 'Forbidden null actor write'
      where id = ${legacyChecklist.id} returning id`;
    invariant(nullActorRead.count === 0 && nullActorUpdate.length === 0,
      'Null application actor retained legacy checklist access');

    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.owner_id}, true)`;
    const [ownerRead] = await transaction`
      select count(*)::int as count from checklist_items
      where id = ${legacyChecklist.id}`;
    const ownerUpdate = await transaction`
      update checklist_items
      set sort = 9004
      where id = ${legacyChecklist.id}
      returning id`;
    invariant(ownerRead.count === 1 && ownerUpdate.length === 1,
      'National owner could not read and update a legacy checklist');

    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.gm_id}, true)`;
    const [gmRead] = await transaction`
      select count(*)::int as count from checklist_items
      where id = ${legacyChecklist.id}
        and sort = 9004`;
    invariant(gmRead.count === 1,
      'Organization-wide GM could not read a legacy checklist');

    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.manager_id}, true)`;
    const [managerRead] = await transaction`
      select count(*)::int as count from checklist_items
      where id = ${legacyChecklist.id}`;
    const managerUpdate = await transaction`
      update checklist_items set completion_note = 'Forbidden manager rewrite'
      where id = ${legacyChecklist.id} returning id`;
    invariant(managerRead.count === 0 && managerUpdate.length === 0,
      'Team manager crossed the owner/GM legacy-checklist boundary');
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.manager_id}, true)`;
    const [schedule] = await transaction`
      insert into job_schedules
        (booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${legacyBooking.id}, ${fixture.territory_id}, 'estate',
        ${planningWindow.start_at}, ${planningWindow.end_at},
        1, array['estate_detail'], 60, true)
      returning id`;
    const [allocation] = await transaction`
      insert into team_job_allocations
        (organization_id, team_id, job_schedule_id, assigned_by_membership_id,
         estimated_labor_minutes, is_dev_seed)
      values (${fixture.organization_id}, ${fixture.team_id}, ${schedule.id},
        ${fixture.manager_membership_id}, 60, true)
      returning id`;
    const [scopedLegacyChecklist] = await transaction`
      select organization_id, team_id, team_job_allocation_id, state, sort,
        completed_at, completed_by_membership_id, completed_by_cleaner_id,
        completion_note, version
      from checklist_items where id = ${legacyChecklist.id}`;
    invariant(
      scopedLegacyChecklist.organization_id === fixture.organization_id
        && scopedLegacyChecklist.team_id === fixture.team_id
        && scopedLegacyChecklist.team_job_allocation_id === allocation.id
        && scopedLegacyChecklist.state === 'pending'
        && scopedLegacyChecklist.sort === 9004
        && scopedLegacyChecklist.completed_at === null
        && scopedLegacyChecklist.completed_by_membership_id === null
        && scopedLegacyChecklist.completed_by_cleaner_id === null
        && scopedLegacyChecklist.completion_note === null
        && scopedLegacyChecklist.version === 1,
      'Allocation did not scope the pre-existing intake checklist without forging evidence',
    );
    const [managerChecklist] = await transaction`
      insert into checklist_items
        (booking_id, organization_id, team_id, team_job_allocation_id,
         label, state, sort, is_dev_seed)
      values (${legacyBooking.id}, ${fixture.organization_id}, ${fixture.team_id},
        ${allocation.id}, 'Verifier manager planning checklist', 'pending', 9005, true)
      returning id`;
    await expectDatabaseError(transaction, ['23514', '42501', '55000'], 'manager checklist inserted precompleted', async (savepoint) => {
      await savepoint`
        insert into checklist_items
          (booking_id, organization_id, team_id, team_job_allocation_id,
           label, state, sort, completed_at, completed_by_membership_id,
           completion_note, is_dev_seed)
        values (${legacyBooking.id}, ${fixture.organization_id}, ${fixture.team_id},
          ${allocation.id}, 'Forged manager completion', 'completed', 9006,
          now(), ${fixture.manager_membership_id}, 'Forbidden planning evidence', true)`;
    });
    await expectDatabaseError(transaction, ['55000', 'P0001'], 'manager checklist completion before execution', async (savepoint) => {
      await savepoint`
        update checklist_items
        set state = 'completed', completion_note = 'Forbidden planning completion'
        where id = ${managerChecklist.id}`;
    });

    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await expectDatabaseError(transaction, ['23514', '42501', '55000'], 'system appended unscoped checklist after allocation', async (savepoint) => {
      await savepoint`
        insert into checklist_items
          (booking_id, label, state, sort, is_dev_seed)
        values (${legacyBooking.id}, 'Forbidden post-allocation intake append',
          'pending', 9007, true)`;
    });
    await expectDatabaseError(transaction, ['23514', '42501', '55000'], 'system appended scoped checklist after allocation', async (savepoint) => {
      await savepoint`
        insert into checklist_items
          (booking_id, organization_id, team_id, team_job_allocation_id,
           label, state, sort, is_dev_seed)
        values (${legacyBooking.id}, ${fixture.organization_id}, ${fixture.team_id},
          ${allocation.id}, 'Forbidden system-scoped append', 'pending', 9008, true)`;
    });

    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.manager_id}, true)`;
    await transaction`
      update job_schedules set status = 'canceled', version = version + 1
      where id = ${schedule.id}`;
    await expectDatabaseError(transaction, ['23514', '42501', '55000'], 'manager checklist append outside planning state', async (savepoint) => {
      await savepoint`
        insert into checklist_items
          (booking_id, organization_id, team_id, team_job_allocation_id,
           label, state, sort, is_dev_seed)
        values (${legacyBooking.id}, ${fixture.organization_id}, ${fixture.team_id},
          ${allocation.id}, 'Forbidden canceled-schedule append', 'pending', 9009, true)`;
    });

    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.owner_id}, true)`;
    const deniedOwnerDelete = await transaction`
      delete from checklist_items where id = ${legacyChecklist.id}
      returning id`;
    const [survivingScopedChecklist] = await transaction`
      select count(*)::int as count from checklist_items
      where id = ${legacyChecklist.id}`;
    invariant(
      deniedOwnerDelete.length === 0 && survivingScopedChecklist.count === 1,
      'Application owner deleted allocated checklist evidence',
    );
  });
}

async function inspectScheduleActorBoundary(sql) {
  const [fixture] = await sql`
    select organization.id as organization_id,
      team_a.id as team_a_id, team_b.id as team_b_id,
      territory.id as team_a_territory_id,
      (select id from customers where email = 'national-owner@verify.invalid') as owner_id,
      (select id from customers where email = 'general-manager@verify.invalid') as gm_id,
      (select id from customers where email = 'team-manager@verify.invalid') as manager_id,
      (select id from customers where email = 'team-b-manager@verify.invalid') as team_b_manager_id,
      (select id from customers where email = 'candidate-manager@verify.invalid') as shift_lead_id,
      (select id from customers where email = 'verified-job-customer@verify.invalid') as customer_id,
      (select id from customers where email = 'wrong-review-customer@verify.invalid') as other_customer_id,
      (select id from cleaners where email = 'team-a-cleaner@verify.invalid') as cleaner_id,
      (select membership.id from workforce_memberships membership
        join customers actor on actor.id = membership.customer_id
        where actor.email = 'team-manager@verify.invalid'
          and membership.team_id = team_a.id and membership.role = 'manager'
          and membership.status = 'active') as manager_membership_id,
      (select membership.id from workforce_memberships membership
        join customers actor on actor.id = membership.customer_id
        where actor.email = 'team-b-manager@verify.invalid'
          and membership.team_id = team_b.id and membership.role = 'manager'
          and membership.status = 'active') as team_b_manager_membership_id
    from organizations organization
    join cleaning_teams team_a on team_a.organization_id = organization.id
      and team_a.code = 'verify-team-a'
    join cleaning_teams team_b on team_b.organization_id = organization.id
      and team_b.code = 'verify-team-b'
    join service_territories territory on territory.code = 'national-verifier'
    where organization.slug = 'lake-and-pine'`;
  invariant(
    fixture?.organization_id && fixture.team_a_id && fixture.team_b_id
      && fixture.team_a_territory_id && fixture.owner_id && fixture.gm_id
      && fixture.manager_id && fixture.team_b_manager_id && fixture.shift_lead_id
      && fixture.customer_id && fixture.other_customer_id && fixture.cleaner_id
      && fixture.manager_membership_id && fixture.team_b_manager_membership_id,
    'Schedule actor proof could not resolve national fixtures',
  );

  const [clock] = await sql`
    select
      (clock_timestamp() + interval '5 minutes')::text as live_start_at,
      (clock_timestamp() + interval '65 minutes')::text as live_end_at,
      (clock_timestamp() - interval '1 minute')::text as live_window_start,
      (clock_timestamp() + interval '119 minutes')::text as live_window_end,
      clock_timestamp()::text as past_boundary_start_at,
      (clock_timestamp() at time zone team_a.timezone)::date::text as live_local_date,
      make_timestamptz(2032, 2, 2, 14, 0, 0, team_a.timezone)::text
        as local_planning_start_at,
      make_timestamptz(2032, 2, 2, 15, 0, 0, team_a.timezone)::text
        as local_planning_end_at,
      make_timestamptz(2032, 2, 3, 12, 0, 0, team_b.timezone)::text
        as team_b_start_at,
      make_timestamptz(2032, 2, 3, 13, 0, 0, team_b.timezone)::text
        as team_b_end_at,
      make_timestamptz(2032, 2, 3, 14, 0, 0, team_b.timezone)::text
        as foreign_planning_start_at,
      make_timestamptz(2032, 2, 3, 15, 0, 0, team_b.timezone)::text
        as foreign_planning_end_at,
      make_timestamptz(2032, 2, 4, 12, 0, 0, team_a.timezone)::text
        as null_actor_start_at,
      make_timestamptz(2032, 2, 4, 13, 0, 0, team_a.timezone)::text
        as null_actor_end_at
    from cleaning_teams team_a
    cross join cleaning_teams team_b
    where team_a.id = ${fixture.team_a_id} and team_b.id = ${fixture.team_b_id}`;
  invariant(clock?.live_local_date,
    'Schedule actor proof could not derive branch-local fixture windows');

  const [foreignTerritory] = await sql`
    insert into service_territories
      (code, name, timezone, status, travel_buffer_minutes, is_dev_seed)
    values ('schedule-boundary-team-b', 'Schedule boundary Team B territory',
      'America/Los_Angeles', 'draft', 30, true)
    returning id`;
  await sql`
    insert into territory_postal_codes (territory_id, postal_code, status)
    values (${foreignTerritory.id}, '83991', 'active')`;
  const [foreignTerritoryCleaner] = await sql`
    insert into cleaners
      (full_name, email, status, screening_status, screening_verified_at,
       home_territory_id, skills, vertical_experience, is_dev_seed)
    values ('Schedule Boundary Team B Cleaner',
      'schedule-boundary-team-b-cleaner@verify.invalid', 'active', 'verified', now(),
      ${foreignTerritory.id}, array['estate_detail'], array['estate'], true)
    returning id`;
  await sql`
    insert into cleaner_availability_rules
      (cleaner_id, territory_id, day_of_week, start_time, end_time,
       effective_from, status)
    values (${foreignTerritoryCleaner.id}, ${foreignTerritory.id},
      extract(dow from ${clock.team_b_start_at}::timestamptz
        at time zone 'America/Los_Angeles')::integer,
      '08:00', '18:00', '2030-01-01', 'active')`;
  await sql`
    update service_territories set status = 'active'
    where id = ${foreignTerritory.id}`;
  await sql`
    insert into team_service_territories
      (organization_id, team_id, territory_id, status, is_dev_seed)
    values (${fixture.organization_id}, ${fixture.team_b_id},
      ${foreignTerritory.id}, 'active', true)`;

  const bookings = {};
  for (const [key, customerId, scheduledDate, label, territoryId, zip] of [
    ['current', fixture.customer_id, clock.live_local_date,
      'Schedule boundary current assigned', fixture.team_a_territory_id, '83816'],
    ['localPlanning', fixture.customer_id, '2032-02-02',
      'Schedule boundary Team A planning', fixture.team_a_territory_id, '83816'],
    ['teamB', fixture.other_customer_id, '2032-02-03',
      'Schedule boundary Team B allocated', foreignTerritory.id, '83991'],
    ['foreignPlanning', fixture.other_customer_id, '2032-02-03',
      'Schedule boundary Team B planning', foreignTerritory.id, '83991'],
    ['nullActor', fixture.customer_id, '2032-02-04',
      'Schedule boundary null actor', fixture.team_a_territory_id, '83816'],
    ['pastActor', fixture.customer_id, clock.live_local_date,
      'Schedule boundary past actor', fixture.team_a_territory_id, '83816'],
  ]) {
    const [booking] = await sql`
      insert into bookings
        (customer_id, service_id, scheduled_date, scheduled_window, status, contact,
         is_dev_seed, service_vertical, territory_id, qualification_status,
         estimated_duration_minutes, required_crew_size, required_skills)
      values (${customerId}, 'estate', ${scheduledDate}, ${label}, 'requested',
        ${sql.json({ name: label, email: 'schedule-boundary@verify.invalid', zip })},
        true, 'estate', ${territoryId}, 'approved', 60, 1,
        array['estate_detail'])
      returning id`;
    bookings[key] = booking.id;
  }

  const schedules = {};
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.manager_id}, true)`;
    const [currentSchedule] = await transaction`
      insert into job_schedules
        (booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${bookings.current}, ${fixture.team_a_territory_id}, 'estate',
        ${clock.live_start_at}, ${clock.live_end_at}, 1,
        array['estate_detail'], 60, true)
      returning id`;
    schedules.current = currentSchedule.id;
    await transaction`
      insert into job_assignments
        (job_schedule_id, cleaner_id, team_id, assignment_role, status, is_dev_seed)
      values (${currentSchedule.id}, ${fixture.cleaner_id}, ${fixture.team_a_id},
        'lead', 'accepted', true)`;
    const [currentAllocation] = await transaction`
      insert into team_job_allocations
        (organization_id, team_id, job_schedule_id, assigned_by_membership_id,
         estimated_labor_minutes, is_dev_seed)
      values (${fixture.organization_id}, ${fixture.team_a_id}, ${currentSchedule.id},
        ${fixture.manager_membership_id}, 60, true)
      returning id`;
    schedules.currentAllocation = currentAllocation.id;
    await expectDatabaseError(transaction, ['22007'], 'staff creating a schedule whose start is already past', async (savepoint) => {
      await savepoint`
        insert into job_schedules
          (booking_id, territory_id, service_vertical, start_at, end_at,
           required_crew_size, required_skills, labor_minutes, is_dev_seed)
        values (${bookings.pastActor}, ${fixture.team_a_territory_id}, 'estate',
          ${clock.past_boundary_start_at}, ${clock.live_end_at}, 1,
          array['estate_detail'], 60, true)`;
    });
    await expectDatabaseError(transaction, ['22007'], 'staff retiming tentative work to a past start', async (savepoint) => {
      await savepoint`
        update job_schedules
        set start_at = ${clock.past_boundary_start_at}, version = version + 1
        where id = ${currentSchedule.id}`;
    });
    const [preservedFuturePlan] = await transaction`
      select start_at::text, version from job_schedules
      where id = ${currentSchedule.id}`;
    invariant(
      Date.parse(preservedFuturePlan.start_at) === Date.parse(clock.live_start_at)
        && preservedFuturePlan.version === 1,
      'Rejected past retime changed the live schedule plan',
    );
    const [localPlanningSchedule] = await transaction`
      insert into job_schedules
        (booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${bookings.localPlanning}, ${fixture.team_a_territory_id}, 'estate',
        ${clock.local_planning_start_at}, ${clock.local_planning_end_at},
        1, array['estate_detail'], 60, true)
      returning id`;
    schedules.localPlanning = localPlanningSchedule.id;

    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.team_b_manager_id}, true)`;
    const [teamBSchedule] = await transaction`
      insert into job_schedules
        (booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${bookings.teamB}, ${foreignTerritory.id}, 'estate',
        ${clock.team_b_start_at}, ${clock.team_b_end_at},
        1, array['estate_detail'], 60, true)
      returning id`;
    schedules.teamB = teamBSchedule.id;
    await transaction`
      insert into team_job_allocations
        (organization_id, team_id, job_schedule_id, assigned_by_membership_id,
         estimated_labor_minutes, is_dev_seed)
      values (${fixture.organization_id}, ${fixture.team_b_id}, ${teamBSchedule.id},
        ${fixture.team_b_manager_membership_id}, 60, true)`;
    const [foreignPlanningSchedule] = await transaction`
      insert into job_schedules
        (booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${bookings.foreignPlanning}, ${foreignTerritory.id}, 'estate',
        ${clock.foreign_planning_start_at}, ${clock.foreign_planning_end_at},
        1, array['estate_detail'], 60, true)
      returning id`;
    schedules.foreignPlanning = foreignPlanningSchedule.id;
  });

  const [teamAOrigin] = await sql`
    select origin_label, origin_latitude, origin_longitude, service_radius_miles
    from cleaning_teams where id = ${fixture.team_a_id}`;
  await sql`
    insert into service_location_assessments
      (booking_id, organization_id, team_id, address_fingerprint,
       branch_origin_label, branch_origin_latitude, branch_origin_longitude,
       property_latitude, property_longitude, distance_miles,
       standard_radius_miles, calculation_method, assessment_status,
       provider, calculated_at, is_dev_seed)
    values (${bookings.current}, ${fixture.organization_id}, ${fixture.team_a_id},
      ${'8'.repeat(64)}, ${teamAOrigin.origin_label},
      ${teamAOrigin.origin_latitude}, ${teamAOrigin.origin_longitude},
      ${teamAOrigin.origin_latitude}, ${teamAOrigin.origin_longitude}, 0,
      ${teamAOrigin.service_radius_miles}, 'straight_line',
      'inside_standard_radius', 'manual', now(), true)`;

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.manager_id}, true)`;
    const [proposal] = await transaction`
      insert into schedule_proposals
        (organization_id, team_id, team_job_allocation_id, job_schedule_id,
         customer_id, arrival_window_start, arrival_window_end, status,
         version, proposed_by_membership_id, expires_at, is_dev_seed)
      values (${fixture.organization_id}, ${fixture.team_a_id},
        ${schedules.currentAllocation}, ${schedules.current}, ${fixture.customer_id},
        ${clock.live_window_start}, ${clock.live_window_end}, 'pending_customer',
        1, ${fixture.manager_membership_id}, clock_timestamp() + interval '1 day', true)
      returning id`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.customer_id}, true)`;
    await transaction`
      update schedule_proposals set status = 'approved',
        customer_response_note = 'Schedule boundary approval'
      where id = ${proposal.id}`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.manager_id}, true)`;
    await transaction`
      update job_schedules set status = 'held', version = version + 1
      where id = ${schedules.current}`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.shift_lead_id}, true)`;
    await expectDeniedMutation(transaction, ['42501'], 'shift lead confirming held work',
      async (savepoint) => savepoint`
        update job_schedules set status = 'confirmed', version = version + 1
        where id = ${schedules.current} returning id`);
    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.manager_id}, true)`;
    await transaction`
      update job_schedules set status = 'confirmed', version = version + 1
      where id = ${schedules.current}`;
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.customer_id}, true)`;
    const [customerScope] = await transaction`
      select
        (select count(*)::int from job_schedules where id = ${schedules.current})
          as own_current,
        (select count(*)::int from job_schedules where id = ${schedules.localPlanning})
          as own_planning,
        (select count(*)::int from job_schedules where id = ${schedules.teamB})
          as other_team,
        (select count(*)::int from job_schedules where id = ${schedules.foreignPlanning})
          as other_planning`;
    invariant(
      customerScope.own_current === 1 && customerScope.own_planning === 1
        && customerScope.other_team === 0 && customerScope.other_planning === 0,
      'Customer schedule reads crossed booking ownership',
    );
    await expectDeniedMutation(transaction, ['42501'], 'customer mutating their schedule',
      async (savepoint) => savepoint`
        update job_schedules set version = version + 1
        where id = ${schedules.current} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'customer deleting their schedule',
      async (savepoint) => savepoint`
        delete from job_schedules where id = ${schedules.current} returning id`);

    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', ${fixture.cleaner_id}, true)`;
    const [cleanerScope] = await transaction`
      select
        (select count(*)::int from job_schedules where id = ${schedules.current})
          as assigned_current,
        (select count(*)::int from job_schedules where id = ${schedules.localPlanning})
          as unallocated_planning,
        (select count(*)::int from job_schedules where id = ${schedules.teamB})
          as other_team`;
    invariant(
      cleanerScope.assigned_current === 1
        && cleanerScope.unallocated_planning === 0 && cleanerScope.other_team === 0,
      'Cleaner schedule reads crossed current assignment scope',
    );
    await expectDeniedMutation(transaction, ['42501'], 'cleaner mutating assigned schedule',
      async (savepoint) => savepoint`
        update job_schedules set version = version + 1
        where id = ${schedules.current} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'cleaner deleting assigned schedule',
      async (savepoint) => savepoint`
        delete from job_schedules where id = ${schedules.current} returning id`);

    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.manager_id}, true)`;
    const [managerScope] = await transaction`
      select
        (select count(*)::int from job_schedules where id = ${schedules.current})
          as allocated_local,
        (select count(*)::int from job_schedules where id = ${schedules.localPlanning})
          as planning_local,
        (select count(*)::int from job_schedules where id = ${schedules.teamB})
          as allocated_other,
        (select count(*)::int from job_schedules where id = ${schedules.foreignPlanning})
          as planning_other`;
    invariant(
      managerScope.allocated_local === 1 && managerScope.planning_local === 1
        && managerScope.allocated_other === 0 && managerScope.planning_other === 0,
      'Team A manager schedule reads crossed team or territory scope',
    );
    await expectDeniedMutation(transaction, ['42501'], 'Team A manager mutating Team B schedule',
      async (savepoint) => savepoint`
        update job_schedules set version = version + 1
        where id = ${schedules.teamB} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'manager deleting local schedule',
      async (savepoint) => savepoint`
        delete from job_schedules where id = ${schedules.current} returning id`);

    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.shift_lead_id}, true)`;
    const [shiftLeadScope] = await transaction`
      select
        (select count(*)::int from job_schedules where id = ${schedules.current})
          as allocated_local,
        (select count(*)::int from job_schedules where id = ${schedules.localPlanning})
          as planning_local,
        (select count(*)::int from job_schedules where id = ${schedules.teamB})
          as allocated_other,
        (select count(*)::int from job_schedules where id = ${schedules.foreignPlanning})
          as planning_other`;
    invariant(
      shiftLeadScope.allocated_local === 1 && shiftLeadScope.planning_local === 1
        && shiftLeadScope.allocated_other === 0 && shiftLeadScope.planning_other === 0,
      'Shift lead schedule reads crossed allocated team or covered planning scope',
    );
    await expectDeniedMutation(transaction, ['42501'], 'shift lead canceling local planning work',
      async (savepoint) => savepoint`
        update job_schedules set status = 'canceled', version = version + 1
        where id = ${schedules.localPlanning} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'shift lead rolling confirmed work back to held',
      async (savepoint) => savepoint`
        update job_schedules set status = 'held', version = version + 1
        where id = ${schedules.current} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'shift lead mutating Team B schedule',
      async (savepoint) => savepoint`
        update job_schedules set version = version + 1
        where id = ${schedules.teamB} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'shift lead deleting local schedule',
      async (savepoint) => savepoint`
        delete from job_schedules where id = ${schedules.current} returning id`);

    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.gm_id}, true)`;
    const [gmScope] = await transaction`
      select count(*)::int as count from job_schedules
      where id in (${schedules.current}, ${schedules.localPlanning},
        ${schedules.teamB}, ${schedules.foreignPlanning})`;
    invariant(gmScope.count === 4,
      'Organization GM could not read the national schedule queue');
    const gmUpdate = await transaction`
      update job_schedules set version = version + 1
      where id = ${schedules.teamB} returning id`;
    invariant(gmUpdate.length === 1,
      'Organization GM could not use the national schedule management path');
    await expectDeniedMutation(transaction, ['42501'], 'GM deleting a national schedule',
      async (savepoint) => savepoint`
        delete from job_schedules where id = ${schedules.teamB} returning id`);

    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.owner_id}, true)`;
    const [ownerScope] = await transaction`
      select count(*)::int as count from job_schedules
      where id in (${schedules.current}, ${schedules.localPlanning},
        ${schedules.teamB}, ${schedules.foreignPlanning})`;
    invariant(ownerScope.count === 4,
      'National owner could not read the full organization schedule queue');
    const ownerUpdate = await transaction`
      update job_schedules set version = version + 1
      where id = ${schedules.current} returning id`;
    invariant(ownerUpdate.length === 1,
      'National owner could not use the national schedule management path');
    await expectDeniedMutation(transaction, ['42501'], 'owner deleting a national schedule',
      async (savepoint) => savepoint`
        delete from job_schedules where id = ${schedules.current} returning id`);

    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    const [nullScope] = await transaction`
      select count(*)::int as count from job_schedules
      where id in (${schedules.current}, ${schedules.localPlanning},
        ${schedules.teamB}, ${schedules.foreignPlanning})`;
    invariant(nullScope.count === 0,
      'Null application actor retained schedule read access');
    await expectDeniedMutation(transaction, ['42501'], 'null actor mutating schedule',
      async (savepoint) => savepoint`
        update job_schedules set version = version + 1
        where id = ${schedules.current} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'null actor deleting schedule',
      async (savepoint) => savepoint`
        delete from job_schedules where id = ${schedules.current} returning id`);
    await expectDatabaseError(transaction, ['42501'], 'null actor creating schedule', async (savepoint) => {
      await savepoint`
        insert into job_schedules
          (booking_id, territory_id, service_vertical, start_at, end_at,
           required_crew_size, required_skills, labor_minutes, is_dev_seed)
        values (${bookings.nullActor}, ${fixture.team_a_territory_id}, 'estate',
          ${clock.null_actor_start_at}, ${clock.null_actor_end_at},
          1, array['estate_detail'], 60, true)`;
    });
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_customer_id', ${fixture.manager_id}, true)`;
    await transaction`
      update job_schedules set status = 'en_route', version = version + 1
      where id = ${schedules.current}`;
    await transaction`
      update job_schedules set status = 'in_progress', version = version + 1
      where id = ${schedules.current}`;
    let emptyChecklistError;
    try {
      await transaction.savepoint(async (savepoint) => {
        await savepoint`
          update job_schedules set status = 'quality_review', version = version + 1
          where id = ${schedules.current}`;
      });
    } catch (error) {
      emptyChecklistError = error;
    }
    invariant(
      emptyChecklistError?.code === '55000'
        && /checklist/i.test(emptyChecklistError.message),
      'An in-progress allocated job with zero checklist items advanced to quality review',
    );
  });
}

async function inspectDirectAssignmentAndCaseAccess(sql) {
  const [fixture] = await sql`
    select organization.id as organization_id,
      team_a.id as team_a_id, team_b.id as team_b_id,
      team_a_booking.id as team_a_booking_id,
      team_a_schedule.id as team_a_schedule_id,
      team_a_allocation.id as team_a_allocation_id,
      team_a_assignment.id as team_a_assignment_id,
      planning_schedule.id as team_a_planning_schedule_id,
      team_b_booking.id as team_b_booking_id,
      team_b_schedule.id as team_b_schedule_id,
      team_a_customer.id as team_a_customer_id,
      team_b_customer.id as team_b_customer_id,
      team_a_manager.id as team_a_manager_id,
      team_b_manager.id as team_b_manager_id,
      gm.id as gm_id,
      team_a_cleaner.id as team_a_cleaner_id,
      team_b_cleaner.id as team_b_cleaner_id
    from organizations organization
    join cleaning_teams team_a on team_a.organization_id = organization.id
      and team_a.code = 'verify-team-a'
    join cleaning_teams team_b on team_b.organization_id = organization.id
      and team_b.code = 'verify-team-b'
    join bookings team_a_booking
      on team_a_booking.scheduled_window = 'Schedule boundary current assigned'
    join job_schedules team_a_schedule
      on team_a_schedule.booking_id = team_a_booking.id
    join team_job_allocations team_a_allocation
      on team_a_allocation.job_schedule_id = team_a_schedule.id
    join job_assignments team_a_assignment
      on team_a_assignment.job_schedule_id = team_a_schedule.id
    join bookings planning_booking
      on planning_booking.scheduled_window = 'Schedule boundary Team A planning'
    join job_schedules planning_schedule
      on planning_schedule.booking_id = planning_booking.id
    join bookings team_b_booking
      on team_b_booking.scheduled_window = 'Schedule boundary Team B allocated'
    join job_schedules team_b_schedule
      on team_b_schedule.booking_id = team_b_booking.id
    join customers team_a_customer
      on team_a_customer.email = 'verified-job-customer@verify.invalid'
    join customers team_b_customer
      on team_b_customer.email = 'wrong-review-customer@verify.invalid'
    join customers team_a_manager
      on team_a_manager.email = 'team-manager@verify.invalid'
    join customers team_b_manager
      on team_b_manager.email = 'team-b-manager@verify.invalid'
    join customers gm
      on gm.email = 'general-manager@verify.invalid'
    join cleaners team_a_cleaner
      on team_a_cleaner.email = 'team-a-cleaner@verify.invalid'
    join cleaners team_b_cleaner
      on team_b_cleaner.email = 'schedule-boundary-team-b-cleaner@verify.invalid'
    where organization.slug = 'lake-and-pine'`;
  invariant(
    fixture?.team_a_assignment_id && fixture.team_a_planning_schedule_id
      && fixture.team_b_schedule_id && fixture.team_b_cleaner_id,
    'Direct assignment and service-case access fixtures are missing',
  );

  await sql`
    insert into workforce_memberships
      (organization_id, team_id, cleaner_id, role, status, is_dev_seed)
    values (${fixture.organization_id}, ${fixture.team_b_id},
      ${fixture.team_b_cleaner_id}, 'cleaner', 'active', true)`;

  let teamBAssignment;
  let teamBCase;
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.team_b_manager_id}, true
      )`;
    [teamBAssignment] = await transaction`
      insert into job_assignments
        (job_schedule_id, cleaner_id, team_id, assignment_role, status,
         assigned_by_label, is_dev_seed)
      values (${fixture.team_b_schedule_id}, ${fixture.team_b_cleaner_id},
        ${fixture.team_b_id}, 'lead', 'proposed', 'Team B verifier manager', true)
      returning id`;
    [teamBCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, priority, is_dev_seed)
      values ('VERIFY-DIRECT-CASE-TEAM-B', 'complaint',
        ${fixture.team_b_booking_id}, ${fixture.team_b_customer_id},
        ${fixture.team_b_id}, '{}'::jsonb,
        'Team B direct service-case scope proof', 'submitted', 'normal', true)
      returning id`;
  });
  invariant(teamBAssignment?.id && teamBCase?.id,
    'Team B manager could not create locally scoped operational records');

  let teamACase;
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.team_a_manager_id}, true
      )`;
    [teamACase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, priority, is_dev_seed)
      values ('VERIFY-DIRECT-CASE-TEAM-A', 'complaint',
        ${fixture.team_a_booking_id}, ${fixture.team_a_customer_id},
        ${fixture.team_a_id}, '{}'::jsonb,
        'Team A direct service-case scope proof', 'submitted', 'normal', true)
      returning id`;
  });
  invariant(teamACase?.id,
    'Team A manager could not create a locally scoped service case');

  let customerCase;
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.team_a_customer_id}, true
      )`;
    [customerCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, contact, details,
         status, priority, is_dev_seed)
      values ('VERIFY-DIRECT-CUSTOMER-CASE', 'complaint',
        ${fixture.team_a_booking_id}, ${fixture.team_a_customer_id}, '{}'::jsonb,
        'Authenticated customer direct submitted case', 'submitted', 'normal', true)
      returning id, assigned_team_id`;
    await expectDatabaseError(transaction, ['23514', '42501'], 'customer inserting a case for another customer', async (savepoint) => {
      await savepoint`
        insert into service_cases
          (public_reference, case_type, booking_id, customer_id, contact, details,
           status, priority, is_dev_seed)
        values ('VERIFY-DIRECT-CUSTOMER-FORGED', 'complaint',
          ${fixture.team_b_booking_id}, ${fixture.team_b_customer_id}, '{}'::jsonb,
          'Forbidden cross-customer case', 'submitted', 'normal', true)`;
    });
  });
  invariant(
    customerCase?.id && customerCase.assigned_team_id === fixture.team_a_id,
    'Customer-submitted service case did not retain safe automatic team scope',
  );

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.team_a_manager_id}, true
      )`;
    await transaction`
      update service_cases set status = 'awaiting_customer'
      where id = ${customerCase.id}`;
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.team_a_customer_id}, true
      )`;
    const [customerScope] = await transaction`
      select
        (select count(*)::int from service_cases
          where id in (${teamACase.id}, ${customerCase.id})) as own_cases,
        (select count(*)::int from service_cases
          where id = ${teamBCase.id}) as other_case,
        (select count(*)::int from job_assignments
          where id in (${fixture.team_a_assignment_id}, ${teamBAssignment.id}))
          as raw_assignments,
        (select count(*)::int from private.current_customer_job_assignments()
          where team_job_allocation_id = ${fixture.team_a_allocation_id}
            and cleaner_id = ${fixture.team_a_cleaner_id})
          as projected_assignments`;
    invariant(
      customerScope.own_cases === 2 && customerScope.other_case === 0
        && customerScope.raw_assignments === 0
        && customerScope.projected_assignments === 1,
      'Customer raw assignment or cross-customer service-case reads escaped scope',
    );
    await expectDatabaseError(transaction, ['42501', '55000'], 'customer changing case evidence while responding', async (savepoint) => {
      await savepoint`
        update service_cases
        set status = 'action_planned', details = 'Forbidden customer evidence rewrite'
        where id = ${customerCase.id}`;
    });
    await expectDatabaseError(transaction, ['42501', '55000'], 'customer terminalizing their service case', async (savepoint) => {
      await savepoint`
        update service_cases set status = 'resolved', resolution_type = 'no_action',
          resolution_summary = 'Forbidden customer resolution', resolved_at = now()
        where id = ${customerCase.id}`;
    });
    const response = await transaction`
      update service_cases set status = 'action_planned'
      where id = ${customerCase.id} and status = 'awaiting_customer'
      returning id`;
    invariant(response.length === 1,
      'Customer could not perform the narrow awaiting-customer response');
    await expectDeniedMutation(transaction, ['42501'], 'customer deleting their service case',
      async (savepoint) => savepoint`
        delete from service_cases where id = ${customerCase.id} returning id`);
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.team_a_manager_id}, true
      )`;
    const [teamAScope] = await transaction`
      select
        (select count(*)::int from job_assignments
          where id = ${fixture.team_a_assignment_id}) as local_assignment,
        (select count(*)::int from job_assignments
          where id = ${teamBAssignment.id}) as foreign_assignment,
        (select count(*)::int from service_cases
          where id in (${teamACase.id}, ${customerCase.id})) as local_cases,
        (select count(*)::int from service_cases
          where id = ${teamBCase.id}) as foreign_case`;
    invariant(
      teamAScope.local_assignment === 1 && teamAScope.foreign_assignment === 0
        && teamAScope.local_cases === 2 && teamAScope.foreign_case === 0,
      'Team A manager raw assignment or case reads crossed the team clean room',
    );
    const localAssignmentUpdate = await transaction`
      update job_assignments set status = status
      where id = ${fixture.team_a_assignment_id} returning id`;
    const foreignAssignmentUpdate = await transaction`
      update job_assignments set status = status
      where id = ${teamBAssignment.id} returning id`;
    const localCaseUpdate = await transaction`
      update service_cases set priority = priority
      where id = ${teamACase.id} returning id`;
    const foreignCaseUpdate = await transaction`
      update service_cases set priority = priority
      where id = ${teamBCase.id} returning id`;
    invariant(
      localAssignmentUpdate.length === 1 && foreignAssignmentUpdate.length === 0
        && localCaseUpdate.length === 1 && foreignCaseUpdate.length === 0,
      'Team A manager mutation scope did not fail closed across teams',
    );
    await expectDeniedMutation(transaction, ['42501'], 'manager deleting a local assignment',
      async (savepoint) => savepoint`
        delete from job_assignments
        where id = ${fixture.team_a_assignment_id} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'manager deleting a local service case',
      async (savepoint) => savepoint`
        delete from service_cases where id = ${teamACase.id} returning id`);
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.team_b_manager_id}, true
      )`;
    const [teamBScope] = await transaction`
      select
        (select count(*)::int from job_assignments
          where id = ${teamBAssignment.id}) as local_assignment,
        (select count(*)::int from job_assignments
          where id = ${fixture.team_a_assignment_id}) as foreign_assignment,
        (select count(*)::int from service_cases
          where id = ${teamBCase.id}) as local_case,
        (select count(*)::int from service_cases
          where id = ${teamACase.id}) as foreign_case`;
    invariant(
      teamBScope.local_assignment === 1 && teamBScope.foreign_assignment === 0
        && teamBScope.local_case === 1 && teamBScope.foreign_case === 0,
      'Team B manager raw assignment or case reads crossed the team clean room',
    );
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_cleaner_id', ${fixture.team_a_cleaner_id}, true
      )`;
    const [cleanerScope] = await transaction`
      select
        (select count(*)::int from job_assignments
          where id = ${fixture.team_a_assignment_id}) as own_assignment,
        (select count(*)::int from job_assignments
          where id = ${teamBAssignment.id}) as foreign_assignment`;
    invariant(
      cleanerScope.own_assignment === 1 && cleanerScope.foreign_assignment === 0,
      'Cleaner raw assignment reads crossed current cleaner scope',
    );
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config('lakeandpine.current_customer_id', ${fixture.gm_id}, true)`;
    const [nationalScope] = await transaction`
      select
        (select count(*)::int from job_assignments
          where id in (${fixture.team_a_assignment_id}, ${teamBAssignment.id}))
          as assignments,
        (select count(*)::int from service_cases
          where id in (${teamACase.id}, ${teamBCase.id}, ${customerCase.id}))
          as cases`;
    invariant(
      nationalScope.assignments === 2 && nationalScope.cases === 3,
      'Organization GM could not read national assignment and service-case scope',
    );
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    const [nullScope] = await transaction`
      select
        (select count(*)::int from job_assignments
          where id in (${fixture.team_a_assignment_id}, ${teamBAssignment.id}))
          as assignments,
        (select count(*)::int from service_cases
          where id in (${teamACase.id}, ${teamBCase.id}, ${customerCase.id}))
          as cases`;
    invariant(
      nullScope.assignments === 0 && nullScope.cases === 0,
      'Null application actor retained raw assignment or service-case reads',
    );
    await expectDatabaseError(transaction, ['42501'], 'null actor inserting an assignment', async (savepoint) => {
      await savepoint`
        insert into job_assignments
          (job_schedule_id, cleaner_id, team_id, assignment_role, status,
           assigned_by_label, is_dev_seed)
        values (${fixture.team_a_planning_schedule_id}, ${fixture.team_a_cleaner_id},
          ${fixture.team_a_id}, 'lead', 'proposed', 'Forbidden null actor', true)`;
    });
    await expectDatabaseError(transaction, ['42501'], 'null actor inserting a raw service case', async (savepoint) => {
      await savepoint`
        insert into service_cases
          (public_reference, case_type, booking_id, customer_id, contact, details,
           status, priority, is_dev_seed)
        values ('VERIFY-DIRECT-NULL-CASE', 'complaint',
          ${fixture.team_a_booking_id}, ${fixture.team_a_customer_id}, '{}'::jsonb,
          'Forbidden null actor raw case', 'submitted', 'normal', true)`;
    });
    await expectDeniedMutation(transaction, ['42501'], 'null actor updating an assignment',
      async (savepoint) => savepoint`
        update job_assignments set status = status
        where id = ${fixture.team_a_assignment_id} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'null actor updating a service case',
      async (savepoint) => savepoint`
        update service_cases set priority = priority
        where id = ${teamACase.id} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'null actor deleting an assignment',
      async (savepoint) => savepoint`
        delete from job_assignments
        where id = ${fixture.team_a_assignment_id} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'null actor deleting a service case',
      async (savepoint) => savepoint`
        delete from service_cases where id = ${teamACase.id} returning id`);
  });
}

async function seedLegacyPrivacyBoundaryFixtures(sql) {
  return sql.begin(async (transaction) => {
    const [scope] = await transaction`
      select organization.id as organization_id,
        team_a.id as team_a_id, team_b.id as team_b_id,
        team_a_manager.id as team_a_manager_id,
        team_b_manager.id as team_b_manager_id,
        national_owner.id as owner_id, general_manager.id as gm_id,
        (
          select booking.id
          from bookings booking
          join job_schedules schedule on schedule.booking_id = booking.id
          join team_job_allocations allocation
            on allocation.job_schedule_id = schedule.id
          where allocation.team_id = team_a.id
            and booking.customer_id is not null
            and char_length(trim(coalesce(booking.contact ->> 'email', '')))
              between 5 and 320
          order by (booking.scheduled_window = 'Staff lead allocation') desc,
            booking.created_at, booking.id
          limit 1
        ) as team_a_booking_id,
        (
          select booking.customer_id
          from bookings booking
          join job_schedules schedule on schedule.booking_id = booking.id
          join team_job_allocations allocation
            on allocation.job_schedule_id = schedule.id
          where allocation.team_id = team_a.id
            and booking.customer_id is not null
            and char_length(trim(coalesce(booking.contact ->> 'email', '')))
              between 5 and 320
          order by (booking.scheduled_window = 'Staff lead allocation') desc,
            booking.created_at, booking.id
          limit 1
        ) as team_a_booking_customer_id,
        (
          select booking.id
          from bookings booking
          join job_schedules schedule on schedule.booking_id = booking.id
          join team_job_allocations allocation
            on allocation.job_schedule_id = schedule.id
          where allocation.team_id = team_b.id
            and booking.customer_id is not null
          order by booking.created_at, booking.id
          limit 1
        ) as team_b_booking_id,
        (
          select service_case.id
          from service_cases service_case
          where service_case.public_reference = 'VERIFY-DIRECT-CUSTOMER-CASE'
          limit 1
        ) as customer_service_case_id,
        (
          select service_case.customer_id
          from service_cases service_case
          where service_case.public_reference = 'VERIFY-DIRECT-CUSTOMER-CASE'
          limit 1
        ) as customer_service_case_customer_id
      from organizations organization
      join cleaning_teams team_a
        on team_a.organization_id = organization.id
       and team_a.code = 'verify-team-a'
      join cleaning_teams team_b
        on team_b.organization_id = organization.id
       and team_b.code = 'verify-team-b'
      join customers team_a_manager
        on team_a_manager.email = 'team-manager@verify.invalid'
      join customers team_b_manager
        on team_b_manager.email = 'team-b-manager@verify.invalid'
      join customers national_owner
        on national_owner.email = 'national-owner@verify.invalid'
      join customers general_manager
        on general_manager.email = 'general-manager@verify.invalid'
      where organization.slug = 'lake-and-pine'`;
    invariant(
      scope?.organization_id && scope.team_a_id && scope.team_b_id
        && scope.team_a_manager_id && scope.team_b_manager_id
        && scope.owner_id && scope.gm_id && scope.team_a_booking_id
        && scope.team_a_booking_customer_id && scope.team_b_booking_id
        && scope.customer_service_case_id
        && scope.customer_service_case_customer_id,
      'Inherited-boundary verifier could not resolve national clean-room fixtures',
    );
    const [branchScope] = await transaction`
      select team_a_manager.id as team_a_manager_membership_id,
        team_b_manager.id as team_b_manager_membership_id,
        team_a_coverage.territory_id,
        postal.postal_code
      from workforce_memberships team_a_manager
      join workforce_memberships team_b_manager
        on team_b_manager.organization_id = team_a_manager.organization_id
       and team_b_manager.team_id = ${scope.team_b_id}
       and team_b_manager.customer_id = ${scope.team_b_manager_id}
       and team_b_manager.role = 'manager'
       and team_b_manager.status = 'active'
      join team_service_territories team_a_coverage
        on team_a_coverage.organization_id = team_a_manager.organization_id
       and team_a_coverage.team_id = ${scope.team_a_id}
       and team_a_coverage.status = 'active'
      join team_service_territories team_b_coverage
        on team_b_coverage.organization_id = team_a_coverage.organization_id
       and team_b_coverage.team_id = ${scope.team_b_id}
       and team_b_coverage.territory_id = team_a_coverage.territory_id
       and team_b_coverage.status = 'active'
      join territory_postal_codes postal
        on postal.territory_id = team_a_coverage.territory_id
       and postal.status = 'active'
      where team_a_manager.organization_id = ${scope.organization_id}
        and team_a_manager.team_id = ${scope.team_a_id}
        and team_a_manager.customer_id = ${scope.team_a_manager_id}
        and team_a_manager.role = 'manager'
        and team_a_manager.status = 'active'
      order by team_a_coverage.created_at, postal.postal_code
      limit 1`;
    invariant(
      branchScope?.team_a_manager_membership_id
        && branchScope.team_b_manager_membership_id
        && branchScope.territory_id && branchScope.postal_code,
      'Inherited-boundary verifier could not resolve shared branch coverage',
    );

    const [customer] = await transaction`
      insert into customers
        (email, full_name, phone, role, is_dev_seed)
      values ('privacy-customer@verify.invalid', 'Privacy Customer',
        '+1-208-555-0191', 'customer', false)
      returning id`;
    const [otherCustomer] = await transaction`
      insert into customers
        (clerk_user_id, email, full_name, role, is_dev_seed)
      values ('user_privacy_other', 'privacy-other@verify.invalid',
        'Privacy Other Customer', 'customer', false)
      returning id`;
    const [teamAStaff] = await transaction`
      insert into customers
        (clerk_user_id, email, full_name, role, is_dev_seed)
      values ('user_privacy_team_a', 'privacy-team-a@verify.invalid',
        'Privacy Team A Staff', 'staff', true)
      returning id`;
    const [teamBStaff] = await transaction`
      insert into customers
        (clerk_user_id, email, full_name, role, is_dev_seed)
      values ('user_privacy_team_b', 'privacy-team-b@verify.invalid',
        'Privacy Team B Staff', 'staff', true)
      returning id`;
    const [dualRoleStaff] = await transaction`
      insert into customers
        (clerk_user_id, email, full_name, role, is_dev_seed)
      values ('user_privacy_dual_role', 'privacy-dual-role@verify.invalid',
        'Privacy Dual Role Staff', 'staff', true)
      returning id`;
    await transaction`
      insert into workforce_memberships
        (organization_id, team_id, customer_id, role, status, is_dev_seed)
      values
        (${scope.organization_id}, ${scope.team_a_id}, ${teamAStaff.id},
          'shift_lead', 'active', true),
        (${scope.organization_id}, ${scope.team_b_id}, ${teamBStaff.id},
          'shift_lead', 'active', true)`;
    const dualRoleMemberships = await transaction`
      insert into workforce_memberships
        (organization_id, team_id, customer_id, role, status, is_dev_seed)
      values
        (${scope.organization_id}, ${scope.team_a_id}, ${dualRoleStaff.id},
          'manager', 'active', true),
        (${scope.organization_id}, ${scope.team_b_id}, ${dualRoleStaff.id},
          'shift_lead', 'active', true)
      returning id, team_id, role`;
    const dualRoleMembershipByTeam = new Map(
      dualRoleMemberships.map((membership) => [membership.team_id, membership]),
    );
    invariant(
      dualRoleMembershipByTeam.get(scope.team_a_id)?.role === 'manager'
        && dualRoleMembershipByTeam.get(scope.team_b_id)?.role === 'shift_lead',
      'Dual-role audit fixture did not retain exact Team A and Team B memberships',
    );

    await transaction`
      select set_config('lakeandpine.current_customer_id', ${scope.owner_id}, true)`;
    const [privacyTeamABooking] = await transaction`
      insert into bookings
        (customer_id, service_id, scheduled_date, scheduled_window, status,
         contact, is_dev_seed, service_vertical, territory_id,
         qualification_status, estimated_duration_minutes,
         required_crew_size, required_skills)
      values (${customer.id}, 'estate', '2032-03-04',
        'Privacy same-customer Team A billing', 'requested',
        ${transaction.json({
          name: 'Privacy Customer', email: 'privacy-customer@verify.invalid',
          street: '101 Private Way', city: "Coeur d'Alene", state: 'ID',
          zip: branchScope.postal_code,
        })}, false, 'estate', ${branchScope.territory_id}, 'approved', 60, 1,
        array['estate_detail'])
      returning id`;
    const [privacyTeamBBooking] = await transaction`
      insert into bookings
        (customer_id, service_id, scheduled_date, scheduled_window, status,
         contact, is_dev_seed, service_vertical, territory_id,
         qualification_status, estimated_duration_minutes,
         required_crew_size, required_skills)
      values (${customer.id}, 'estate', '2032-03-05',
        'Privacy same-customer Team B billing', 'requested',
        ${transaction.json({
          name: 'Privacy Customer', email: 'privacy-customer@verify.invalid',
          street: '101 Private Way', city: "Coeur d'Alene", state: 'ID',
          zip: branchScope.postal_code,
        })}, false, 'estate', ${branchScope.territory_id}, 'approved', 60, 1,
        array['estate_detail'])
      returning id`;
    const [privacyTeamASchedule] = await transaction`
      insert into job_schedules
        (booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${privacyTeamABooking.id}, ${branchScope.territory_id}, 'estate',
        '2032-03-04T16:00:00.000Z', '2032-03-04T17:00:00.000Z',
        1, array['estate_detail'], 60, false)
      returning id`;
    const [privacyTeamBSchedule] = await transaction`
      insert into job_schedules
        (booking_id, territory_id, service_vertical, start_at, end_at,
         required_crew_size, required_skills, labor_minutes, is_dev_seed)
      values (${privacyTeamBBooking.id}, ${branchScope.territory_id}, 'estate',
        '2032-03-05T16:00:00.000Z', '2032-03-05T17:00:00.000Z',
        1, array['estate_detail'], 60, false)
      returning id`;
    await transaction`
      insert into team_job_allocations
        (organization_id, team_id, job_schedule_id, assigned_by_membership_id,
         estimated_labor_minutes, is_dev_seed)
      values
        (${scope.organization_id}, ${scope.team_a_id}, ${privacyTeamASchedule.id},
          ${branchScope.team_a_manager_membership_id}, 60, false),
        (${scope.organization_id}, ${scope.team_b_id}, ${privacyTeamBSchedule.id},
          ${branchScope.team_b_manager_membership_id}, 60, false)`;
    const [teamASupportCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, is_dev_seed)
      values ('LP-PRIVACY-SAME-CUSTOMER-A', 'complaint',
        ${privacyTeamABooking.id}, ${customer.id}, ${scope.team_a_id}, '{}',
        'Privacy same-customer Team A support case', 'submitted', false)
      returning id`;
    const [teamBSupportCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, is_dev_seed)
      values ('LP-PRIVACY-SAME-CUSTOMER-B', 'complaint',
        ${privacyTeamBBooking.id}, ${customer.id}, ${scope.team_b_id}, '{}',
        'Privacy same-customer Team B support case', 'submitted', false)
      returning id`;

    const [teamACleaner] = await transaction`
      insert into cleaners
        (full_name, email, status, screening_status, screening_verified_at,
         skills, vertical_experience, is_dev_seed)
      values ('Privacy Team A Cleaner', 'privacy-cleaner-a@verify.invalid',
        'active', 'verified', now(), array['estate_detail'], array['estate'], true)
      returning id`;
    const [teamBCleaner] = await transaction`
      insert into cleaners
        (full_name, email, status, screening_status, screening_verified_at,
         skills, vertical_experience, is_dev_seed)
      values ('Privacy Team B Cleaner', 'privacy-cleaner-b@verify.invalid',
        'active', 'verified', now(), array['estate_detail'], array['estate'], true)
      returning id`;
    const privacyCleanerMemberships = await transaction`
      insert into workforce_memberships
        (organization_id, team_id, cleaner_id, role, status, is_dev_seed)
      values
        (${scope.organization_id}, ${scope.team_a_id}, ${teamACleaner.id},
          'cleaner', 'active', true),
        (${scope.organization_id}, ${scope.team_b_id}, ${teamBCleaner.id},
          'cleaner', 'active', true)
      returning id, cleaner_id`;
    const privacyCleanerMembershipByCleaner = new Map(
      privacyCleanerMemberships.map((membership) => [
        membership.cleaner_id, membership.id,
      ]),
    );

    const homes = await transaction`
      insert into homes
        (customer_id, label, address_line, city, state, zip, cleaner_notes,
         is_dev_seed)
      values
        (${customer.id}, 'Privacy home', '101 Private Way', 'Coeur d''Alene',
          'ID', '83814', 'Original customer care note', false),
        (${otherCustomer.id}, 'Other home', '202 Other Way', 'Hayden',
          'ID', '83835', 'Other customer note', false),
        (${teamAStaff.id}, 'Team A staff home', '303 Team A Way', 'Post Falls',
          'ID', '83854', 'Team A staff note', true),
        (${teamBStaff.id}, 'Team B staff home', '404 Team B Way', 'Rathdrum',
          'ID', '83858', 'Team B staff note', true)
      returning id, customer_id`;
    const homeByCustomer = new Map(homes.map((home) => [home.customer_id, home.id]));

    const billings = await transaction`
      insert into billing_records
        (customer_id, booking_id, description, amount_cents, status,
         stripe_payment_intent_id, stripe_invoice_id, is_dev_seed)
      values
        (${customer.id}, ${privacyTeamABooking.id}, 'Privacy Team A linked billing',
          24000, 'paid', 'pi_VerifyPrivacyTeamA1', 'in_VerifyPrivacyTeamA1', false),
        (${customer.id}, ${privacyTeamBBooking.id}, 'Privacy Team B linked billing',
          25000, 'paid', 'pi_VerifyPrivacyTeamB1', 'in_VerifyPrivacyTeamB1', false),
        (${customer.id}, null, 'Privacy national unlinked billing', 26000, 'paid',
          'pi_VerifyPrivacyNational1', 'in_VerifyPrivacyNational1', false),
        (${otherCustomer.id}, null, 'Other customer unlinked billing', 27000, 'paid',
          'pi_VerifyPrivacyOther1', 'in_VerifyPrivacyOther1', false)
      returning id, description`;
    const billingByDescription = new Map(
      billings.map((billing) => [billing.description, billing.id]),
    );

    const messages = await transaction`
      insert into support_messages
        (customer_id, service_case_id, sender, body, is_dev_seed)
      values
        (${customer.id}, ${teamASupportCase.id}, 'concierge',
          'Privacy Team A linked support fixture', false),
        (${customer.id}, ${teamBSupportCase.id}, 'concierge',
          'Privacy Team B linked support fixture', false),
        (${customer.id}, null, 'concierge',
          'Privacy national unlinked support fixture', false),
        (${otherCustomer.id}, null, 'concierge',
          'Other customer unlinked support fixture', false)
      returning id, body`;
    const messageByBody = new Map(
      messages.map((message) => [message.body, message.id]),
    );

    const [teamANote] = await transaction`
      insert into internal_notes (booking_id, author_label, body, is_dev_seed)
      values (${scope.team_a_booking_id}, 'Privacy verifier',
        'Team A scoped internal note', true)
      returning id`;
    const [teamBNote] = await transaction`
      insert into internal_notes (booking_id, author_label, body, is_dev_seed)
      values (${scope.team_b_booking_id}, 'Privacy verifier',
        'Team B scoped internal note', true)
      returning id`;
    await transaction`
      delete from follow_ups
      where booking_id = ${scope.team_a_booking_id}
        and kind = 'service_check_in'`;
    const [teamAFollowUp] = await transaction`
      insert into follow_ups
        (booking_id, kind, channel, status, scheduled_for, is_dev_seed)
      values (${scope.team_a_booking_id}, 'review_request', 'manual', 'planned',
        '2032-01-01T18:00:00Z', true)
      on conflict (booking_id, kind) do update
        set status = excluded.status, scheduled_for = excluded.scheduled_for
      returning id`;
    const [teamBFollowUp] = await transaction`
      insert into follow_ups
        (booking_id, kind, channel, status, scheduled_for, is_dev_seed)
      values (${scope.team_b_booking_id}, 'review_request', 'manual', 'planned',
        '2032-01-02T18:00:00Z', true)
      on conflict (booking_id, kind) do update
        set status = excluded.status, scheduled_for = excluded.scheduled_for
      returning id`;
    const [teamABookingEvent] = await transaction`
      insert into booking_events (booking_id, type, data)
      values (${scope.team_a_booking_id}, 'status_changed',
        '{"source":"privacy_verifier_team_a"}'::jsonb)
      returning id`;
    const [teamBBookingEvent] = await transaction`
      insert into booking_events (booking_id, type, data)
      values (${scope.team_b_booking_id}, 'status_changed',
        '{"source":"privacy_verifier_team_b"}'::jsonb)
      returning id`;

    return {
      ...scope,
      customer_id: customer.id,
      other_customer_id: otherCustomer.id,
      team_a_staff_id: teamAStaff.id,
      team_b_staff_id: teamBStaff.id,
      dual_role_staff_id: dualRoleStaff.id,
      dual_role_team_a_manager_membership_id:
        dualRoleMembershipByTeam.get(scope.team_a_id)?.id,
      dual_role_team_b_shift_membership_id:
        dualRoleMembershipByTeam.get(scope.team_b_id)?.id,
      team_a_manager_membership_id: branchScope.team_a_manager_membership_id,
      team_b_manager_membership_id: branchScope.team_b_manager_membership_id,
      privacy_team_a_booking_id: privacyTeamABooking.id,
      privacy_team_b_booking_id: privacyTeamBBooking.id,
      privacy_team_a_schedule_id: privacyTeamASchedule.id,
      privacy_team_b_schedule_id: privacyTeamBSchedule.id,
      team_a_cleaner_id: teamACleaner.id,
      team_b_cleaner_id: teamBCleaner.id,
      team_a_cleaner_membership_id:
        privacyCleanerMembershipByCleaner.get(teamACleaner.id),
      team_b_cleaner_membership_id:
        privacyCleanerMembershipByCleaner.get(teamBCleaner.id),
      customer_home_id: homeByCustomer.get(customer.id),
      other_home_id: homeByCustomer.get(otherCustomer.id),
      team_a_home_id: homeByCustomer.get(teamAStaff.id),
      team_b_home_id: homeByCustomer.get(teamBStaff.id),
      customer_billing_id: billingByDescription.get('Privacy Team A linked billing'),
      team_a_billing_id: billingByDescription.get('Privacy Team A linked billing'),
      team_b_billing_id: billingByDescription.get('Privacy Team B linked billing'),
      unlinked_billing_id: billingByDescription.get('Privacy national unlinked billing'),
      other_billing_id: billingByDescription.get('Other customer unlinked billing'),
      customer_message_id: messageByBody.get('Privacy national unlinked support fixture'),
      team_a_message_id: messageByBody.get('Privacy Team A linked support fixture'),
      team_b_message_id: messageByBody.get('Privacy Team B linked support fixture'),
      unlinked_message_id: messageByBody.get('Privacy national unlinked support fixture'),
      other_message_id: messageByBody.get('Other customer unlinked support fixture'),
      team_a_support_case_id: teamASupportCase.id,
      team_b_support_case_id: teamBSupportCase.id,
      team_a_note_id: teamANote.id,
      team_b_note_id: teamBNote.id,
      team_a_follow_up_id: teamAFollowUp.id,
      team_b_follow_up_id: teamBFollowUp.id,
      team_a_booking_event_id: teamABookingEvent.id,
      team_b_booking_event_id: teamBBookingEvent.id,
    };
  });
}

async function inspectClosedInheritedActorBoundaries(sql) {
  const fixture = await seedLegacyPrivacyBoundaryFixtures(sql);
  const applicationHash = 'a'.repeat(64);
  const rateHash = 'b'.repeat(64);
  const stripeHash = 'c'.repeat(64);

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;

    const verifiedCustomer = await transaction`
      select * from private.customer_identity_by_verified_email(
        'PRIVACY-CUSTOMER@VERIFY.INVALID'
      )`;
    invariant(
      verifiedCustomer.length === 1
        && verifiedCustomer[0].id === fixture.customer_id
        && verifiedCustomer[0].email === 'privacy-customer@verify.invalid'
        && !Object.hasOwn(verifiedCustomer[0], 'stripe_customer_id'),
      'Verified-email customer identity projection did not return one safe identity',
    );
    const claimedCustomer = await transaction`
      select * from private.upsert_customer_from_verified_clerk_identity(
        'user_privacy_customer', 'privacy-customer@verify.invalid',
        'Privacy Customer Updated', '+1-208-555-0192'
      )`;
    const clerkCustomer = await transaction`
      select * from private.customer_identity_by_clerk_id(
        'user_privacy_customer'
      )`;
    invariant(
      claimedCustomer.length === 1
        && claimedCustomer[0].id === fixture.customer_id
        && claimedCustomer[0].clerk_user_id === 'user_privacy_customer'
        && clerkCustomer.length === 1
        && clerkCustomer[0].id === fixture.customer_id
        && clerkCustomer[0].phone === '+1-208-555-0192',
      'Verified Clerk customer identity claim did not bind and round-trip safely',
    );

    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    const claimedCleaner = await transaction`
      select * from private.claim_cleaner_external_auth_id(
        'crew_privacy_cleaner_a', 'privacy-cleaner-a@verify.invalid'
      )`;
    const cleanerByExternalIdentity = await transaction`
      select * from private.cleaner_identity_by_external_auth_id(
        'crew_privacy_cleaner_a'
      )`;
    const replayedCleanerClaim = await transaction`
      select * from private.claim_cleaner_external_auth_id(
        'crew_privacy_cleaner_a', 'privacy-cleaner-a@verify.invalid'
      )`;
    const conflictingCleanerClaim = await transaction`
      select * from private.claim_cleaner_external_auth_id(
        'crew_privacy_cleaner_a_conflict', 'privacy-cleaner-a@verify.invalid'
      )`;
    invariant(
      claimedCleaner.length === 1
        && claimedCleaner[0].id === fixture.team_a_cleaner_id
        && claimedCleaner[0].external_auth_id === 'crew_privacy_cleaner_a'
        && cleanerByExternalIdentity.length === 1
        && cleanerByExternalIdentity[0].id === fixture.team_a_cleaner_id
        && replayedCleanerClaim.length === 1
        && replayedCleanerClaim[0].id === fixture.team_a_cleaner_id
        && conflictingCleanerClaim.length === 0,
      'Cleaner identity claim was not one-time, idempotent, and conflict-safe',
    );

    const firstApplication = await transaction`
      select * from private.create_public_cleaner_application(
        ${applicationHash}, 'TEAM-A1B2C3D4E5', 'Privacy Applicant',
        'privacy-applicant@verify.invalid', '+1-208-555-0193',
        'Coeur d''Alene, ID', array['estate']::text[],
        array['Coeur d''Alene']::text[], 'Weekday mornings',
        'Five years of premium residential care', true,
        ${transaction.json({
          privacy: true,
          policyVersion: 'privacy-verifier-v1',
          privacyNoticeDate: '2026-07-14',
        })}
      )`;
    const duplicateApplication = await transaction`
      select * from private.create_public_cleaner_application(
        ${applicationHash}, 'TEAM-A1B2C3D4E5', 'Privacy Applicant',
        'privacy-applicant@verify.invalid', '+1-208-555-0193',
        'Coeur d''Alene, ID', array['estate']::text[],
        array['Coeur d''Alene']::text[], 'Weekday mornings',
        'Five years of premium residential care', true,
        ${transaction.json({
          privacy: true,
          policyVersion: 'privacy-verifier-v1',
          privacyNoticeDate: '2026-07-14',
        })}
      )`;
    invariant(
      firstApplication.length === 1
        && firstApplication[0].public_reference === 'TEAM-A1B2C3D4E5'
        && firstApplication[0].duplicate === false
        && duplicateApplication.length === 1
        && duplicateApplication[0].public_reference === 'TEAM-A1B2C3D4E5'
        && duplicateApplication[0].duplicate === true,
      'Cleaner application intake did not preserve atomic idempotency',
    );

    const rateResults = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [result] = await transaction`
        select * from private.consume_request_rate_limit(
          'cleaner_application', ${rateHash}, 2, 3600
        )`;
      rateResults.push(result);
    }
    invariant(
      rateResults[0]?.allowed === true && rateResults[0].remaining === 1
        && rateResults[1]?.allowed === true && rateResults[1].remaining === 0
        && rateResults[2]?.allowed === false
        && rateResults[2].remaining === 0
        && rateResults[2].retry_after_seconds > 0,
      'Bounded request-rate function did not close the fixed window at its limit',
    );

    const [stripeClaim] = await transaction`
      select * from private.claim_stripe_event_receipt(
        'evt_VerifyPrivacyBoundary1', 'customer.subscription.updated',
        false, ${stripeHash}
      )`;
    const [stripeFinished] = await transaction`
      select private.finish_stripe_event_receipt(
        'evt_VerifyPrivacyBoundary1', ${stripeHash}, 'ignored', null
      ) as finished`;
    const [stripeReplay] = await transaction`
      select * from private.claim_stripe_event_receipt(
        'evt_VerifyPrivacyBoundary1', 'customer.subscription.updated',
        false, ${stripeHash}
      )`;
    invariant(
      stripeClaim?.claimed === true
        && stripeClaim.receipt_status === 'processing'
        && stripeFinished?.finished === true
        && stripeReplay?.claimed === false
        && stripeReplay.receipt_status === 'ignored',
      'Signed-event receipt functions did not preserve bounded idempotency',
    );
  });

  let bookingNotificationIds;
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id',
        ${fixture.team_a_booking_customer_id}, true
      )`;
    [bookingNotificationIds] = await transaction`
      select * from private.enqueue_booking_intake_notifications(
        ${fixture.team_a_booking_id}
      )`;
    invariant(
      bookingNotificationIds?.customer_notification_id
        && bookingNotificationIds.ops_notification_id
        && bookingNotificationIds.customer_notification_id
          !== bookingNotificationIds.ops_notification_id,
      'Booking notification enqueue did not return two durable capability IDs',
    );
  });

  let serviceCaseNotificationId;
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id',
        ${fixture.customer_service_case_customer_id}, true
      )`;
    const [notification] = await transaction`
      select private.enqueue_service_case_ops_notification(
        ${fixture.customer_service_case_id}
      ) as id`;
    serviceCaseNotificationId = notification?.id;
    invariant(
      serviceCaseNotificationId,
      'Service-case notification enqueue did not return a durable capability ID',
    );
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    const [wrongBookingCapability] = await transaction`
      select private.finish_initial_booking_notification_delivery(
        ${bookingNotificationIds.customer_notification_id},
        ${fixture.team_a_booking_id}, 'ops_notification', 'sent'
      ) as finished`;
    const [customerDelivery] = await transaction`
      select private.finish_initial_booking_notification_delivery(
        ${bookingNotificationIds.customer_notification_id},
        ${fixture.team_a_booking_id}, 'customer_confirmation', 'sent'
      ) as finished`;
    const [wrongCaseCapability] = await transaction`
      select private.finish_initial_service_case_notification_delivery(
        ${bookingNotificationIds.ops_notification_id},
        ${fixture.customer_service_case_id}, 'sent'
      ) as finished`;
    const [caseDelivery] = await transaction`
      select private.finish_initial_service_case_notification_delivery(
        ${serviceCaseNotificationId}, ${fixture.customer_service_case_id}, 'sent'
      ) as finished`;
    invariant(
      wrongBookingCapability?.finished === false
        && customerDelivery?.finished === true
        && wrongCaseCapability?.finished === false
        && caseDelivery?.finished === true,
      'Initial notification finish functions did not bind outcome to subject and capability ID',
    );
  });

  let claimedOpsNotification;
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.team_a_manager_id}, true
      )`;
    [claimedOpsNotification] = await transaction`
      select * from private.claim_notification_outbox_delivery(
        ${bookingNotificationIds.ops_notification_id}, true
      )`;
    invariant(
      claimedOpsNotification?.id === bookingNotificationIds.ops_notification_id
        && claimedOpsNotification.claim_locked_at,
      'Team manager could not claim a branch-scoped notification capability',
    );
    const [finished] = await transaction`
      select private.finish_notification_outbox_delivery(
        ${claimedOpsNotification.id}, ${claimedOpsNotification.claim_locked_at},
        'sent'
      ) as finished`;
    invariant(
      finished?.finished === true,
      'Team manager could not finish the exact claimed notification capability',
    );
  });

  const [boundedState] = await sql`
    select
      (select clerk_user_id from customers where id = ${fixture.customer_id})
        as customer_clerk_id,
      (select external_auth_id from cleaners
        where id = ${fixture.team_a_cleaner_id}) as cleaner_external_auth_id,
      (select count(*)::int from cleaner_applications
        where idempotency_key = ${applicationHash}) as application_count,
      (select request_count from request_rate_limits
        where scope = 'cleaner_application' and key_hash = ${rateHash}
        order by window_start desc limit 1) as request_count,
      (select status from stripe_event_receipts
        where event_id = 'evt_VerifyPrivacyBoundary1') as stripe_status,
      (select status from notification_outbox
        where id = ${bookingNotificationIds.customer_notification_id})
        as customer_notification_status,
      (select status from notification_outbox
        where id = ${bookingNotificationIds.ops_notification_id})
        as ops_notification_status,
      (select status from notification_outbox
        where id = ${serviceCaseNotificationId}) as case_notification_status`;
  invariant(
    boundedState.customer_clerk_id === 'user_privacy_customer'
      && boundedState.cleaner_external_auth_id === 'crew_privacy_cleaner_a'
      && boundedState.application_count === 1
      && boundedState.request_count === 3
      && boundedState.stripe_status === 'ignored'
      && boundedState.customer_notification_status === 'sent'
      && boundedState.ops_notification_status === 'sent'
      && boundedState.case_notification_status === 'sent',
    'Bounded identity, intake, rate, Stripe, or notification state did not persist',
  );

  // Actor-specific raw-table probes follow. Definer APIs above remain the only
  // path for pre-auth identity, intake, rate, Stripe, and outbox mutations.
  await inspectClosedInheritedNullActor(sql, fixture, bookingNotificationIds);
  await inspectClosedInheritedCustomerActor(sql, fixture, bookingNotificationIds);
  await inspectClosedInheritedCrossTeamActors(sql, fixture, bookingNotificationIds);
  await inspectAuditActorAttribution(sql, fixture);
}

async function inspectClosedInheritedNullActor(
  sql,
  fixture,
  bookingNotificationIds,
) {
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;

    const [visibility] = await transaction`
      select
        (select count(id)::int from customers
          where id in (${fixture.customer_id}, ${fixture.team_a_staff_id},
            ${fixture.team_b_staff_id})) as customers,
        (select count(id)::int from cleaners
          where id in (${fixture.team_a_cleaner_id}, ${fixture.team_b_cleaner_id}))
          as cleaners,
        (select count(id)::int from cleaner_applications
          where public_reference = 'TEAM-A1B2C3D4E5') as applications,
        (select count(id)::int from homes
          where id in (${fixture.customer_home_id}, ${fixture.other_home_id},
            ${fixture.team_a_home_id}, ${fixture.team_b_home_id})) as homes,
        (select count(id)::int from support_messages
          where id in (${fixture.customer_message_id}, ${fixture.other_message_id},
            ${fixture.team_a_message_id}, ${fixture.team_b_message_id}))
          as support_messages,
        (select count(id)::int from billing_records
          where id in (${fixture.customer_billing_id}, ${fixture.other_billing_id},
            ${fixture.team_a_billing_id}, ${fixture.team_b_billing_id}))
          as billing_records,
        (select count(id)::int from notification_outbox
          where id in (${bookingNotificationIds.customer_notification_id},
            ${bookingNotificationIds.ops_notification_id})) as notifications,
        (select count(id)::int from internal_notes
          where id in (${fixture.team_a_note_id}, ${fixture.team_b_note_id}))
          as internal_notes,
        (select count(id)::int from follow_ups
          where id in (${fixture.team_a_follow_up_id}, ${fixture.team_b_follow_up_id}))
          as follow_ups,
        (select count(id)::int from booking_events
          where id in (${fixture.team_a_booking_event_id},
            ${fixture.team_b_booking_event_id})) as booking_events`;
    invariant(
      Object.values(visibility).every((count) => count === 0),
      'Null application actor retained inherited raw reads on protected surfaces',
    );

    const inaccessibleReads = [
      ['request rate ledger', 'request_rate_limits', 'key_hash'],
      ['Stripe event ledger', 'stripe_event_receipts', 'event_id'],
      ['operations audit ledger', 'operations_state_events', 'id'],
      ['dormant quotes', 'quotes', 'id'],
      ['dormant leads', 'leads', 'id'],
      ['dormant rooms', 'rooms', 'id'],
      ['legacy cleaning team members', 'cleaning_team_members', 'team_id'],
    ];
    for (const [label, table, column] of inaccessibleReads) {
      await expectDatabaseError(
        transaction,
        ['42501'],
        `null actor reading ${label}`,
        async (savepoint) => savepoint.unsafe(
          `select ${quoteIdentifier(column)} from public.${quoteIdentifier(table)} limit 1`,
        ),
      );
    }

    const sensitiveReads = [
      ['customer Clerk identity', 'customers', 'clerk_user_id'],
      ['customer Stripe identity', 'customers', 'stripe_customer_id'],
      ['cleaner external identity', 'cleaners', 'external_auth_id'],
      ['cleaner operator notes', 'cleaners', 'operator_notes'],
      ['billing payment intent', 'billing_records', 'stripe_payment_intent_id'],
      ['territory qualification evidence', 'service_territories', 'qualification_notes'],
      ['postal qualification evidence', 'territory_postal_codes', 'evidence_note'],
    ];
    for (const [label, table, column] of sensitiveReads) {
      await expectDatabaseError(
        transaction,
        ['42501'],
        `null actor reading ${label}`,
        async (savepoint) => savepoint.unsafe(
          `select ${quoteIdentifier(column)} from public.${quoteIdentifier(table)} limit 1`,
        ),
      );
    }

    await expectDatabaseError(transaction, ['42501'], 'null actor inserting a customer',
      async (savepoint) => savepoint`
        insert into customers (email, full_name)
        values ('forbidden-null-customer@verify.invalid', 'Forbidden')`);
    await expectDatabaseError(transaction, ['42501'], 'null actor inserting a cleaner',
      async (savepoint) => savepoint`
        insert into cleaners (full_name, email)
        values ('Forbidden cleaner', 'forbidden-null-cleaner@verify.invalid')`);
    await expectDatabaseError(transaction, ['42501'], 'null actor inserting an application',
      async (savepoint) => savepoint`
        insert into cleaner_applications
          (public_reference, full_name, email, transportation_confirmed)
        values ('TEAM-FFFFFFFFFF', 'Forbidden applicant',
          'forbidden-applicant@verify.invalid', true)`);
    await expectDatabaseError(transaction, ['42501'], 'null actor inserting a home',
      async (savepoint) => savepoint`
        insert into homes (customer_id, label)
        values (${fixture.customer_id}, 'Forbidden null home')`);
    await expectDatabaseError(transaction, ['42501'], 'null actor inserting support',
      async (savepoint) => savepoint`
        insert into support_messages (customer_id, sender, body)
        values (${fixture.customer_id}, 'customer', 'Forbidden null support')`);
    await expectDatabaseError(transaction, ['42501'], 'null actor inserting billing',
      async (savepoint) => savepoint`
        insert into billing_records
          (customer_id, description, amount_cents, status)
        values (${fixture.customer_id}, 'Forbidden null billing', 100, 'due')`);
    await expectDatabaseError(transaction, ['42501'], 'null actor inserting outbox state',
      async (savepoint) => savepoint`
        insert into notification_outbox
          (customer_id, notification_type, channel, recipient_kind,
           template_key, deduplication_key)
        values (${fixture.customer_id}, 'ops_notification', 'email', 'ops',
          'forbidden', 'privacy:null:forbidden')`);
    await expectDatabaseError(transaction, ['42501'], 'null actor inserting rate state',
      async (savepoint) => savepoint`
        insert into request_rate_limits
          (scope, key_hash, window_start, window_seconds, expires_at)
        values ('booking', ${'d'.repeat(64)}, now(), 60, now() + interval '2 minutes')`);
    await expectDatabaseError(transaction, ['42501'], 'null actor inserting Stripe state',
      async (savepoint) => savepoint`
        insert into stripe_event_receipts
          (event_id, event_type, livemode, payload_sha256)
        values ('evt_ForbiddenNull', 'invoice.paid', false, ${'e'.repeat(64)})`);
    await expectDatabaseError(transaction, ['42501'], 'null actor inserting audit state',
      async (savepoint) => savepoint`
        insert into operations_state_events
          (entity_type, entity_id, field_name)
        values ('bookings', ${fixture.team_a_booking_id}, 'status')`);
    await expectDatabaseError(transaction, ['42501'], 'null actor appending a staff booking event',
      async (savepoint) => savepoint`
        insert into booking_events (booking_id, type, data)
        values (${fixture.team_a_booking_id}, 'status_changed', '{}'::jsonb)`);
    await expectDatabaseError(transaction, ['42501'], 'null actor inserting an internal note',
      async (savepoint) => savepoint`
        insert into internal_notes (booking_id, body)
        values (${fixture.team_a_booking_id}, 'Forbidden null note')`);
    await expectDatabaseError(transaction, ['42501'], 'null actor inserting a dormant lead',
      async (savepoint) => savepoint`
        insert into leads (full_name, zip)
        values ('Forbidden null lead', '83814')`);
  });
}

async function inspectClosedInheritedCustomerActor(
  sql,
  fixture,
  bookingNotificationIds,
) {
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.customer_id}, true
      )`;

    const billingHistory = await transaction`
      select * from private.current_customer_billing_history()`;
    const [visibility] = await transaction`
      select
        (select count(id)::int from customers
          where id = ${fixture.customer_id}) as own_customer,
        (select count(id)::int from customers
          where id in (${fixture.other_customer_id}, ${fixture.team_a_staff_id},
            ${fixture.team_b_staff_id})) as other_customers,
        (select count(id)::int from cleaners
          where id in (${fixture.team_a_cleaner_id}, ${fixture.team_b_cleaner_id}))
          as cleaners,
        (select count(id)::int from cleaner_applications
          where public_reference = 'TEAM-A1B2C3D4E5') as applications,
        (select count(id)::int from homes
          where id = ${fixture.customer_home_id}) as own_home,
        (select count(id)::int from homes
          where id in (${fixture.other_home_id}, ${fixture.team_a_home_id},
            ${fixture.team_b_home_id})) as other_homes,
        (select count(id)::int from support_messages
          where id in (${fixture.customer_message_id},
            ${fixture.team_a_message_id}, ${fixture.team_b_message_id}))
          as own_support,
        (select count(id)::int from support_messages
          where id = ${fixture.other_message_id}) as other_support,
        (select count(id)::int from billing_records
          where id in (${fixture.customer_billing_id}, ${fixture.other_billing_id},
            ${fixture.team_a_billing_id}, ${fixture.team_b_billing_id},
            ${fixture.unlinked_billing_id}))
          as raw_billing,
        (select count(id)::int from notification_outbox
          where id in (${bookingNotificationIds.customer_notification_id},
            ${bookingNotificationIds.ops_notification_id})) as notifications,
        (select count(id)::int from internal_notes
          where id in (${fixture.team_a_note_id}, ${fixture.team_b_note_id}))
          as internal_notes,
        (select count(id)::int from follow_ups
          where id in (${fixture.team_a_follow_up_id}, ${fixture.team_b_follow_up_id}))
          as follow_ups,
        (select count(id)::int from booking_events
          where id in (${fixture.team_a_booking_event_id},
            ${fixture.team_b_booking_event_id})) as booking_events`;
    invariant(
      visibility.own_customer === 1 && visibility.other_customers === 0
        && visibility.cleaners === 0 && visibility.applications === 0
        && visibility.own_home === 1 && visibility.other_homes === 0
        && visibility.own_support === 3 && visibility.other_support === 0
        && visibility.raw_billing === 0 && visibility.notifications === 0
        && visibility.internal_notes === 0 && visibility.follow_ups === 0
        && visibility.booking_events === 0
        && billingHistory.length === 3
        && new Set(billingHistory.map((billing) => billing.id)).size === 3
        && [fixture.team_a_billing_id, fixture.team_b_billing_id,
          fixture.unlinked_billing_id].every((billingId) =>
          billingHistory.some((billing) => billing.id === billingId))
        && billingHistory.every((billing) =>
          !Object.hasOwn(billing, 'stripe_payment_intent_id')),
      'Customer raw/projection visibility crossed a protected ownership boundary',
    );

    const inaccessibleReads = [
      ['request rate ledger', 'request_rate_limits', 'key_hash'],
      ['Stripe event ledger', 'stripe_event_receipts', 'event_id'],
      ['operations audit ledger', 'operations_state_events', 'id'],
      ['dormant quotes', 'quotes', 'id'],
      ['dormant leads', 'leads', 'id'],
      ['dormant rooms', 'rooms', 'id'],
      ['legacy cleaning team members', 'cleaning_team_members', 'team_id'],
    ];
    for (const [label, table, column] of inaccessibleReads) {
      await expectDatabaseError(
        transaction,
        ['42501'],
        `customer reading ${label}`,
        async (savepoint) => savepoint.unsafe(
          `select ${quoteIdentifier(column)} from public.${quoteIdentifier(table)} limit 1`,
        ),
      );
    }
    await expectDatabaseError(transaction, ['42501'], 'customer reading Clerk linkage',
      async (savepoint) => savepoint`
        select clerk_user_id from customers where id = ${fixture.customer_id}`);
    await expectDatabaseError(transaction, ['42501'], 'customer reading Stripe linkage',
      async (savepoint) => savepoint`
        select stripe_customer_id from customers where id = ${fixture.customer_id}`);
    await expectDatabaseError(transaction, ['42501'], 'customer reading billing provider IDs',
      async (savepoint) => savepoint`
        select stripe_payment_intent_id from billing_records
        where id = ${fixture.customer_billing_id}`);

    const updatedHome = await transaction`
      update homes set cleaner_notes = 'Customer-approved care note'
      where id = ${fixture.customer_home_id}
      returning id, cleaner_notes`;
    invariant(
      updatedHome.length === 1
        && updatedHome[0].cleaner_notes === 'Customer-approved care note',
      'Customer could not update the one permitted home care-note field',
    );
    await expectDatabaseError(transaction, ['42501'], 'customer rewriting a home address',
      async (savepoint) => savepoint`
        update homes set address_line = 'Forbidden rewritten address'
        where id = ${fixture.customer_home_id}`);
    await expectDeniedMutation(transaction, ['42501'], 'customer updating another home',
      async (savepoint) => savepoint`
        update homes set cleaner_notes = 'Forbidden cross-customer note'
        where id = ${fixture.other_home_id} returning id`);
    await expectDatabaseError(transaction, ['42501'], 'customer inserting a home',
      async (savepoint) => savepoint`
        insert into homes (customer_id, label)
        values (${fixture.customer_id}, 'Forbidden extra home')`);
    await expectDatabaseError(transaction, ['42501'], 'customer deleting their home',
      async (savepoint) => savepoint`
        delete from homes where id = ${fixture.customer_home_id}`);

    const ownSupport = await transaction`
      insert into support_messages (customer_id, sender, body)
      values (${fixture.customer_id}, 'customer',
        'Customer-authored privacy boundary message')
      returning id`;
    invariant(ownSupport.length === 1,
      'Customer could not append an audited message to their support thread');
    await expectDatabaseError(transaction, ['42501'], 'customer messaging for another customer',
      async (savepoint) => savepoint`
        insert into support_messages (customer_id, sender, body)
        values (${fixture.other_customer_id}, 'customer',
          'Forbidden cross-customer message')`);
    await expectDatabaseError(transaction, ['42501'], 'customer rewriting support history',
      async (savepoint) => savepoint`
        update support_messages set body = 'Forbidden rewrite'
        where id = ${fixture.customer_message_id}`);
    await expectDatabaseError(transaction, ['42501'], 'customer deleting support history',
      async (savepoint) => savepoint`
        delete from support_messages where id = ${fixture.customer_message_id}`);
    await expectDatabaseError(transaction, ['42501'], 'customer mutating their raw identity',
      async (savepoint) => savepoint`
        update customers set full_name = 'Forbidden raw identity rewrite'
        where id = ${fixture.customer_id}`);
    await expectDeniedMutation(transaction, ['42501'], 'customer updating a cleaner',
      async (savepoint) => savepoint`
        update cleaners set max_daily_jobs = max_daily_jobs
        where id = ${fixture.team_a_cleaner_id} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'customer reviewing an application',
      async (savepoint) => savepoint`
        update cleaner_applications set status = 'reviewing'
        where public_reference = 'TEAM-A1B2C3D4E5' returning id`);
    await expectDatabaseError(transaction, ['42501'], 'customer inserting billing state',
      async (savepoint) => savepoint`
        insert into billing_records
          (customer_id, description, amount_cents, status)
        values (${fixture.customer_id}, 'Forbidden customer billing', 1, 'due')`);
    await expectDatabaseError(transaction, ['42501'], 'customer mutating outbox state',
      async (savepoint) => savepoint`
        update notification_outbox set status = 'sent'
        where id = ${bookingNotificationIds.ops_notification_id}`);
    await expectDatabaseError(transaction, ['42501'], 'customer appending a staff audit event',
      async (savepoint) => savepoint`
        insert into booking_events (booking_id, type, data)
        values (${fixture.team_a_booking_id}, 'status_changed', '{}'::jsonb)`);
    await expectDatabaseError(transaction, ['42501'], 'customer inserting an internal note',
      async (savepoint) => savepoint`
        insert into internal_notes (booking_id, body)
        values (${fixture.team_a_booking_id}, 'Forbidden customer note')`);
  });
}

async function inspectClosedInheritedCrossTeamActors(
  sql,
  fixture,
  bookingNotificationIds,
) {
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.team_a_manager_id}, true
      )`;

    const [visibility] = await transaction`
      select
        (select count(id)::int from customers
          where id = ${fixture.team_a_staff_id}) as local_customer,
        (select count(id)::int from customers
          where id = ${fixture.team_b_staff_id}) as foreign_customer,
        (select count(id)::int from cleaners
          where id = ${fixture.team_a_cleaner_id}) as local_cleaner,
        (select count(id)::int from cleaners
          where id = ${fixture.team_b_cleaner_id}) as foreign_cleaner,
        (select count(id)::int from cleaner_applications
          where public_reference = 'TEAM-A1B2C3D4E5') as applications,
        (select count(id)::int from homes
          where id in (${fixture.team_a_home_id}, ${fixture.team_b_home_id}))
          as homes,
        (select count(id)::int from support_messages
          where id = ${fixture.team_a_message_id}) as local_support,
        (select count(id)::int from support_messages
          where id = ${fixture.team_b_message_id}) as foreign_support,
        (select count(id)::int from support_messages
          where id = ${fixture.unlinked_message_id}) as unlinked_support,
        (select count(id)::int from billing_records
          where id = ${fixture.team_a_billing_id}) as local_billing,
        (select count(id)::int from billing_records
          where id = ${fixture.team_b_billing_id}) as foreign_billing,
        (select count(id)::int from billing_records
          where id = ${fixture.unlinked_billing_id}) as unlinked_billing,
        (select count(id)::int from notification_outbox
          where id in (${bookingNotificationIds.customer_notification_id},
            ${bookingNotificationIds.ops_notification_id})) as notifications,
        (select count(id)::int from internal_notes
          where id = ${fixture.team_a_note_id}) as local_note,
        (select count(id)::int from internal_notes
          where id = ${fixture.team_b_note_id}) as foreign_note,
        (select count(id)::int from follow_ups
          where id = ${fixture.team_a_follow_up_id}) as local_follow_up,
        (select count(id)::int from follow_ups
          where id = ${fixture.team_b_follow_up_id}) as foreign_follow_up,
        (select count(id)::int from booking_events
          where id = ${fixture.team_a_booking_event_id}) as local_booking_event,
        (select count(id)::int from booking_events
          where id = ${fixture.team_b_booking_event_id}) as foreign_booking_event`;
    invariant(
      visibility.local_customer === 1 && visibility.foreign_customer === 0
        && visibility.local_cleaner === 1 && visibility.foreign_cleaner === 0
        && visibility.applications === 0 && visibility.homes === 0
        && visibility.local_support === 1 && visibility.foreign_support === 0
        && visibility.unlinked_support === 0
        && visibility.local_billing === 1 && visibility.foreign_billing === 0
        && visibility.unlinked_billing === 0
        && visibility.notifications === 0
        && visibility.local_note === 1 && visibility.foreign_note === 0
        && visibility.local_follow_up === 1 && visibility.foreign_follow_up === 0
        && visibility.local_booking_event === 1
        && visibility.foreign_booking_event === 0,
      'Team A manager visibility crossed a Team B identity, support, billing, or audit boundary',
    );

    await expectDatabaseError(transaction, ['42501'], 'manager reading customer Clerk linkage',
      async (savepoint) => savepoint`
        select clerk_user_id from customers where id = ${fixture.team_a_staff_id}`);
    await expectDatabaseError(transaction, ['42501'], 'manager reading cleaner external linkage',
      async (savepoint) => savepoint`
        select external_auth_id from cleaners where id = ${fixture.team_a_cleaner_id}`);
    await expectDatabaseError(transaction, ['42501'], 'manager reading provider billing linkage',
      async (savepoint) => savepoint`
        select stripe_payment_intent_id from billing_records
        where id = ${fixture.team_a_billing_id}`);
    const noRawTables = [
      ['request_rate_limits', 'key_hash'],
      ['stripe_event_receipts', 'event_id'],
      ['operations_state_events', 'id'],
      ['quotes', 'id'],
      ['leads', 'id'],
      ['rooms', 'id'],
      ['cleaning_team_members', 'team_id'],
    ];
    for (const [table, column] of noRawTables) {
      await expectDatabaseError(
        transaction,
        ['42501'],
        `manager reading raw ${table}`,
        async (savepoint) => savepoint.unsafe(
          `select ${quoteIdentifier(column)} from public.${quoteIdentifier(table)} limit 1`,
        ),
      );
    }

    const localCleanerUpdate = await transaction`
      update cleaners set max_daily_jobs = max_daily_jobs
      where id = ${fixture.team_a_cleaner_id} returning id`;
    const foreignCleanerUpdate = await transaction`
      update cleaners set max_daily_jobs = max_daily_jobs
      where id = ${fixture.team_b_cleaner_id} returning id`;
    invariant(
      localCleanerUpdate.length === 1 && foreignCleanerUpdate.length === 0,
      'Manager cleaner mutation scope did not fail closed at the team boundary',
    );
    await transaction`
      update workforce_memberships
      set status = 'paused', status_reason = 'Verifier inactive subject boundary'
      where id = ${fixture.team_a_cleaner_membership_id}`;
    const inactiveCleanerUpdate = await transaction`
      update cleaners set max_daily_jobs = max_daily_jobs
      where id = ${fixture.team_a_cleaner_id} returning id`;
    invariant(inactiveCleanerUpdate.length === 0,
      'Manager could mutate a cleaner profile through an inactive subject membership');
    await transaction`
      update workforce_memberships
      set status = 'active', status_reason = 'Verifier active subject restore',
          ended_at = null
      where id = ${fixture.team_a_cleaner_membership_id}`;
    await expectDeniedMutation(transaction, ['42501'], 'manager updating a foreign home',
      async (savepoint) => savepoint`
        update homes set cleaner_notes = 'Forbidden manager note'
        where id = ${fixture.team_b_home_id} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'manager reviewing a national application',
      async (savepoint) => savepoint`
        update cleaner_applications set status = 'reviewing'
        where public_reference = 'TEAM-A1B2C3D4E5' returning id`);
    await expectDatabaseError(transaction, ['42501'], 'manager writing unlinked national support',
      async (savepoint) => savepoint`
        insert into support_messages (customer_id, sender, body)
        values (${fixture.team_a_staff_id}, 'staff',
          'Forbidden unlinked manager support reply')`);
    await expectDatabaseError(transaction, ['42501'], 'manager writing cross-team support',
      async (savepoint) => savepoint`
        insert into support_messages (customer_id, sender, body)
        values (${fixture.team_b_staff_id}, 'staff',
          'Forbidden Team B support reply')`);
    await expectDatabaseError(transaction, ['42501'], 'manager inserting billing state',
      async (savepoint) => savepoint`
        insert into billing_records
          (customer_id, description, amount_cents, status)
        values (${fixture.team_a_staff_id}, 'Forbidden manager billing', 1, 'due')`);
    await expectDatabaseError(transaction, ['42501'], 'manager mutating outbox state directly',
      async (savepoint) => savepoint`
        update notification_outbox set status = 'failed'
        where id = ${bookingNotificationIds.customer_notification_id}`);

    const [localNote] = await transaction`
      insert into internal_notes (booking_id, body)
      values (${fixture.team_a_booking_id}, 'Team A manager scoped note')
      returning id, author_membership_id, author_label, is_dev_seed`;
    const [localNoteEvidence] = await transaction`
      select note.author_membership_id, note.author_label, note.is_dev_seed,
        booking.is_dev_seed as booking_is_dev_seed
      from internal_notes note
      join bookings booking on booking.id = note.booking_id
      where note.id = ${localNote.id}`;
    invariant(
      localNote.author_membership_id === fixture.team_a_manager_membership_id
        && localNoteEvidence.author_membership_id
          === fixture.team_a_manager_membership_id
        && localNoteEvidence.author_label?.trim().length > 0
        && localNoteEvidence.is_dev_seed
          === localNoteEvidence.booking_is_dev_seed,
      'Team A note did not receive exact database-derived actor and seed evidence',
    );
    await expectDatabaseError(transaction, ['42501'], 'manager spoofing internal-note actor evidence',
      async (savepoint) => savepoint`
        insert into internal_notes (booking_id, body, author_membership_id)
        values (${fixture.team_a_booking_id}, 'Forbidden forged note actor',
          ${fixture.dual_role_team_a_manager_membership_id})`);
    await expectDatabaseError(transaction, ['42501'], 'manager inserting a cross-team internal note',
      async (savepoint) => savepoint`
        insert into internal_notes (booking_id, body)
        values (${fixture.team_b_booking_id}, 'Forbidden Team B note')`);

    const [createdFollowUp] = await transaction`
      insert into follow_ups (booking_id, kind, channel, scheduled_for)
      values (${fixture.team_a_booking_id}, 'service_check_in', 'manual',
        '2032-01-03T18:00:00Z')
      returning id, status, completed_at, is_dev_seed`;
    const [followUpSeedTruth] = await transaction`
      select follow_up.status, follow_up.completed_at, follow_up.is_dev_seed,
        booking.is_dev_seed as booking_is_dev_seed
      from follow_ups follow_up
      join bookings booking on booking.id = follow_up.booking_id
      where follow_up.id = ${createdFollowUp.id}`;
    invariant(
      createdFollowUp.status === 'planned'
        && createdFollowUp.completed_at === null
        && followUpSeedTruth.status === 'planned'
        && followUpSeedTruth.completed_at === null
        && followUpSeedTruth.is_dev_seed === followUpSeedTruth.booking_is_dev_seed,
      'App follow-up insert did not begin with database-derived planned/seed evidence',
    );
    await expectDatabaseError(transaction, ['42501'], 'manager spoofing initial follow-up status',
      async (savepoint) => savepoint`
        insert into follow_ups
          (booking_id, kind, channel, scheduled_for, status)
        values (${fixture.team_a_booking_id}, 'review_request', 'manual',
          '2032-01-04T18:00:00Z', 'completed')`);
    await expectDatabaseError(transaction, ['42501'], 'manager inserting a cross-team follow-up',
      async (savepoint) => savepoint`
        insert into follow_ups (booking_id, kind, channel, scheduled_for)
        values (${fixture.team_b_booking_id}, 'service_check_in', 'manual',
          '2032-01-05T18:00:00Z')`);
    const [readyFollowUp] = await transaction`
      update follow_ups set status = 'ready'
      where id = ${createdFollowUp.id}
      returning id, status, completed_at`;
    const foreignFollowUp = await transaction`
      update follow_ups set status = 'ready'
      where id = ${fixture.team_b_follow_up_id} returning id`;
    invariant(
      readyFollowUp.status === 'ready' && readyFollowUp.completed_at === null
        && foreignFollowUp.length === 0,
      'Manager follow-up lifecycle or team boundary did not fail closed',
    );
    await expectDatabaseError(transaction, ['42501'], 'manager rewriting follow-up booking identity',
      async (savepoint) => savepoint`
        update follow_ups set booking_id = ${fixture.team_b_booking_id}
        where id = ${createdFollowUp.id}`);
    const [completedFollowUp] = await transaction`
      update follow_ups set status = 'completed'
      where id = ${createdFollowUp.id}
      returning status, completed_at is not null as completed_at_set`;
    invariant(
      completedFollowUp.status === 'completed'
        && completedFollowUp.completed_at_set,
      'Follow-up completion did not receive a database-stamped completion time',
    );
    await expectDatabaseError(transaction, ['55000'], 'terminal follow-up rewrite',
      async (savepoint) => savepoint`
        update follow_ups set status = 'canceled'
        where id = ${createdFollowUp.id}`);

    await expectDatabaseError(transaction, ['42501'], 'manager appending a fake booking status fact',
      async (savepoint) => savepoint`
        insert into booking_events (booking_id, type, data)
        values (${fixture.privacy_team_a_booking_id}, 'status_changed',
          '{"bookingStatus":"reviewing"}'::jsonb)`);
    await expectDatabaseError(transaction, ['42501'], 'manager appending a fake in-scope booking event',
      async (savepoint) => savepoint`
        insert into booking_events (booking_id, type, data)
        values (${fixture.privacy_team_a_booking_id}, 'preferred_date_changed',
          '{"source":"forbidden_fake_event"}'::jsonb)`);
    await expectDatabaseError(transaction, ['42501'], 'manager appending a fake case-cancellation fact',
      async (savepoint) => savepoint`
        insert into booking_events (booking_id, type, data)
        values (${fixture.privacy_team_a_booking_id}, 'canceled_from_service_case',
          '{"source":"forbidden_fake_cancel"}'::jsonb)`);
    await expectDatabaseError(transaction, ['42501'], 'manager appending a cross-team booking audit event',
      async (savepoint) => savepoint`
        insert into booking_events (booking_id, type, data)
        values (${fixture.team_b_booking_id}, 'preferred_date_changed',
          '{"source":"forbidden_cross_team"}'::jsonb)`);
    const [priorBookingState] = await transaction`
      select status, qualification_status, qualification_requirements,
        scheduled_date::text
      from bookings
      where id = ${fixture.privacy_team_a_booking_id}`;
    const [qualifiedBooking] = await transaction`
      update bookings
      set qualification_status = 'needs_information',
          qualification_requirements = '{"walkthrough":"requested"}'::jsonb
      where id = ${fixture.privacy_team_a_booking_id}
      returning qualification_status, qualification_requirements`;
    invariant(
      qualifiedBooking.qualification_status === 'needs_information'
        && qualifiedBooking.qualification_requirements?.walkthrough === 'requested',
      'Exact Team A manager could not update booking qualification fields',
    );
    await transaction`
      update bookings
      set qualification_status = ${priorBookingState.qualification_status},
          qualification_requirements = ${transaction.json(
            priorBookingState.qualification_requirements,
          )}
      where id = ${fixture.privacy_team_a_booking_id}`;
    const [changedBookingStatus] = await transaction`
      update bookings set status = 'reviewing'
      where id = ${fixture.privacy_team_a_booking_id}
      returning status`;
    const [derivedStatusEvent] = await transaction`
      select data
      from booking_events
      where booking_id = ${fixture.privacy_team_a_booking_id}
        and type = 'status_changed'
      order by created_at desc, id desc
      limit 1`;
    invariant(
      changedBookingStatus.status === 'reviewing'
        && derivedStatusEvent?.data?.bookingStatus === 'reviewing'
        && Object.keys(derivedStatusEvent.data).length === 1,
      'Permitted booking status change did not emit the exact derived audit fact',
    );
    await transaction`
      update bookings set status = ${priorBookingState.status}
      where id = ${fixture.privacy_team_a_booking_id}`;
    const [changedBookingDate] = await transaction`
      update bookings set scheduled_date = scheduled_date + 1
      where id = ${fixture.privacy_team_a_booking_id}
      returning scheduled_date::text`;
    const [derivedDateEvent] = await transaction`
      select data
      from booking_events
      where booking_id = ${fixture.privacy_team_a_booking_id}
        and type = 'preferred_date_changed'
      order by created_at desc, id desc
      limit 1`;
    invariant(
      changedBookingDate.scheduled_date !== priorBookingState.scheduled_date
        && derivedDateEvent?.data?.scheduledDate === changedBookingDate.scheduled_date
        && Object.keys(derivedDateEvent.data).length === 1,
      'Permitted booking date change did not emit the exact derived audit fact',
    );
    await transaction`
      update bookings set scheduled_date = ${priorBookingState.scheduled_date}
      where id = ${fixture.privacy_team_a_booking_id}`;
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.team_a_staff_id}, true
      )`;
    const [shiftScope] = await transaction`
      select
        (select count(id)::int from billing_records
          where id = ${fixture.team_a_billing_id}) as team_a_billing,
        (select count(id)::int from billing_records
          where id = ${fixture.team_b_billing_id}) as team_b_billing,
        (select count(id)::int from billing_records
          where id = ${fixture.unlinked_billing_id}) as unlinked_billing,
        (select count(id)::int from support_messages
          where id = ${fixture.team_a_message_id}) as team_a_support,
        (select count(id)::int from support_messages
          where id = ${fixture.team_b_message_id}) as team_b_support,
        (select count(id)::int from support_messages
          where id = ${fixture.unlinked_message_id}) as unlinked_support`;
    invariant(
      shiftScope.team_a_billing === 1 && shiftScope.team_b_billing === 0
        && shiftScope.unlinked_billing === 0
        && shiftScope.team_a_support === 1 && shiftScope.team_b_support === 0
        && shiftScope.unlinked_support === 0,
      'Team A shift lead crossed same-customer billing or support scope',
    );
    await expectDeniedMutation(transaction, ['42501'], 'shift lead mutating a cleaner profile',
      async (savepoint) => savepoint`
        update cleaners set max_daily_jobs = max_daily_jobs
        where id = ${fixture.team_a_cleaner_id} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'shift lead canceling a raw booking',
      async (savepoint) => savepoint`
        update bookings set status = 'canceled'
        where id = ${fixture.privacy_team_a_booking_id} returning id`);
    await expectDeniedMutation(transaction, ['42501'], 'shift lead changing raw booking qualification',
      async (savepoint) => savepoint`
        update bookings
        set qualification_status = 'needs_information',
            qualification_requirements = '{"forbidden":"shift_lead"}'::jsonb
        where id = ${fixture.privacy_team_a_booking_id} returning id`);
    await expectDatabaseError(transaction, ['42501'], 'shift lead changing raw booking contact',
      async (savepoint) => savepoint`
        update bookings
        set contact = contact || '{"forbidden":"shift_lead"}'::jsonb
        where id = ${fixture.privacy_team_a_booking_id}`);
    await expectDatabaseError(transaction, ['42501'], 'shift lead changing raw booking estimate',
      async (savepoint) => savepoint`
        update bookings set estimate_cents = 1
        where id = ${fixture.privacy_team_a_booking_id}`);
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.team_b_manager_id}, true
      )`;
    const [reciprocal] = await transaction`
      select
        (select count(id)::int from customers
          where id = ${fixture.team_a_staff_id}) as team_a_customer,
        (select count(id)::int from customers
          where id = ${fixture.team_b_staff_id}) as team_b_customer,
        (select count(id)::int from cleaners
          where id = ${fixture.team_a_cleaner_id}) as team_a_cleaner,
        (select count(id)::int from cleaners
          where id = ${fixture.team_b_cleaner_id}) as team_b_cleaner,
        (select count(id)::int from support_messages
          where id = ${fixture.team_a_message_id}) as team_a_support,
        (select count(id)::int from support_messages
          where id = ${fixture.team_b_message_id}) as team_b_support,
        (select count(id)::int from support_messages
          where id = ${fixture.unlinked_message_id}) as unlinked_support,
        (select count(id)::int from billing_records
          where id = ${fixture.team_a_billing_id}) as team_a_billing,
        (select count(id)::int from billing_records
          where id = ${fixture.team_b_billing_id}) as team_b_billing,
        (select count(id)::int from billing_records
          where id = ${fixture.unlinked_billing_id}) as unlinked_billing,
        (select count(id)::int from internal_notes
          where id = ${fixture.team_a_note_id}) as team_a_note,
        (select count(id)::int from internal_notes
          where id = ${fixture.team_b_note_id}) as team_b_note,
        (select count(id)::int from booking_events
          where id = ${fixture.team_a_booking_event_id}) as team_a_event,
        (select count(id)::int from booking_events
          where id = ${fixture.team_b_booking_event_id}) as team_b_event`;
    invariant(
      reciprocal.team_a_customer === 0 && reciprocal.team_b_customer === 1
        && reciprocal.team_a_cleaner === 0 && reciprocal.team_b_cleaner === 1
        && reciprocal.team_a_support === 0 && reciprocal.team_b_support === 1
        && reciprocal.unlinked_support === 0
        && reciprocal.team_a_billing === 0 && reciprocal.team_b_billing === 1
        && reciprocal.unlinked_billing === 0
        && reciprocal.team_a_note === 0 && reciprocal.team_b_note === 1
        && reciprocal.team_a_event === 0 && reciprocal.team_b_event === 1,
      'Team B manager reciprocal visibility did not preserve the clean-room boundary',
    );
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config('lakeandpine.current_customer_id', ${fixture.gm_id}, true)`;
    const [nationalVisibility] = await transaction`
      select
        (select count(id)::int from cleaner_applications
          where public_reference = 'TEAM-A1B2C3D4E5') as applications,
        (select count(id)::int from notification_outbox
          where id in (${bookingNotificationIds.customer_notification_id},
            ${bookingNotificationIds.ops_notification_id})) as notifications,
        (select count(id)::int from customers
          where id in (${fixture.team_a_staff_id}, ${fixture.team_b_staff_id}))
          as customers,
        (select count(id)::int from cleaners
          where id in (${fixture.team_a_cleaner_id}, ${fixture.team_b_cleaner_id}))
          as cleaners,
        (select count(id)::int from billing_records
          where id in (${fixture.team_a_billing_id}, ${fixture.team_b_billing_id},
            ${fixture.unlinked_billing_id})) as billing_records,
        (select count(id)::int from support_messages
          where id in (${fixture.team_a_message_id}, ${fixture.team_b_message_id},
            ${fixture.unlinked_message_id})) as support_messages`;
    invariant(
      nationalVisibility.applications === 1
        && nationalVisibility.notifications === 2
        && nationalVisibility.customers === 2
        && nationalVisibility.cleaners === 2
        && nationalVisibility.billing_records === 3
        && nationalVisibility.support_messages === 3,
      'Organization GM could not reach the intended national oversight projections',
    );
    const reviewedApplication = await transaction`
      update cleaner_applications set status = 'reviewing'
      where public_reference = 'TEAM-A1B2C3D4E5'
      returning id`;
    invariant(reviewedApplication.length === 1,
      'Organization GM could not review the national cleaner application queue');
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config('lakeandpine.current_customer_id', ${fixture.owner_id}, true)`;
    const [ownerFinancialSupportScope] = await transaction`
      select
        (select count(id)::int from billing_records
          where id in (${fixture.team_a_billing_id}, ${fixture.team_b_billing_id},
            ${fixture.unlinked_billing_id})) as billing_records,
        (select count(id)::int from support_messages
          where id in (${fixture.team_a_message_id}, ${fixture.team_b_message_id},
            ${fixture.unlinked_message_id})) as support_messages`;
    invariant(
      ownerFinancialSupportScope.billing_records === 3
        && ownerFinancialSupportScope.support_messages === 3,
      'National owner could not read linked and unlinked billing/support scope',
    );
  });
}

async function inspectAuditActorAttribution(sql, fixture) {
  const [ledgerCatalog] = await sql`
    select
      exists (
        select 1
        from pg_constraint constraint_definition
        where constraint_definition.conrelid = 'service_case_events'::regclass
          and constraint_definition.contype = 'f'
          and constraint_definition.conkey = array[
            (select attnum from pg_attribute
              where attrelid = 'service_case_events'::regclass
                and attname = 'actor_membership_id')
          ]::smallint[]
      ) as service_case_actor_fk,
      exists (
        select 1
        from pg_constraint constraint_definition
        where constraint_definition.conrelid = 'operations_state_events'::regclass
          and constraint_definition.contype = 'f'
          and constraint_definition.conkey = array[
            (select attnum from pg_attribute
              where attrelid = 'operations_state_events'::regclass
                and attname = 'actor_membership_id')
          ]::smallint[]
      ) as operations_actor_fk,
      to_regclass('public.service_case_events_actor_membership_idx') is not null
        as service_case_actor_index,
      to_regclass('public.operations_state_events_actor_membership_idx') is not null
        as operations_actor_index`;
  invariant(
    ledgerCatalog.service_case_actor_fk && ledgerCatalog.operations_actor_fk
      && ledgerCatalog.service_case_actor_index
      && ledgerCatalog.operations_actor_index,
    'Audit ledgers are missing actor-membership foreign keys or covering indexes',
  );

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.dual_role_staff_id}, true
      )`;
    const [changedSchedule] = await transaction`
      update job_schedules
      set status = 'held', version = version + 1
      where id = ${fixture.privacy_team_b_schedule_id}
        and status = 'tentative'
      returning status, version`;
    invariant(
      changedSchedule?.status === 'held' && changedSchedule.version === 2,
      'Dual-role Team B shift lead could not perform a locally authorized schedule update',
    );
  });
  const [teamBScheduleAudit] = await sql`
    select actor_membership_id, actor_role
    from operations_state_events
    where entity_type = 'job_schedules'
      and entity_id = ${fixture.privacy_team_b_schedule_id}
      and field_name = 'status'
      and from_state = 'tentative'
      and to_state = 'held'
    order by created_at desc, id desc
    limit 1`;
  invariant(
    teamBScheduleAudit?.actor_membership_id
      === fixture.dual_role_team_b_shift_membership_id
      && teamBScheduleAudit.actor_role === 'shift_lead',
    'Team B event selected a higher Team A role instead of the exact Team B shift membership',
  );

  await sql.begin(async (transaction) => {
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.dual_role_staff_id}, true
      )`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      update service_cases set status = 'investigating'
      where id = ${fixture.team_b_support_case_id}
        and status = 'submitted'`;
  });
  const [teamBCaseAudit] = await sql`
    select actor_membership_id, actor_label
    from service_case_events
    where service_case_id = ${fixture.team_b_support_case_id}
      and event_type = 'status_changed'
      and from_status = 'submitted'
      and to_status = 'investigating'
    order by created_at desc, id desc
    limit 1`;
  const [teamBCaseOperationsAudit] = await sql`
    select actor_membership_id, actor_role
    from operations_state_events
    where entity_type = 'service_cases'
      and entity_id = ${fixture.team_b_support_case_id}
      and field_name = 'status'
      and from_state = 'submitted'
      and to_state = 'investigating'
    order by created_at desc, id desc
    limit 1`;
  invariant(
    teamBCaseAudit?.actor_membership_id
      === fixture.dual_role_team_b_shift_membership_id
      && teamBCaseAudit.actor_label === 'shift_lead'
      && teamBCaseOperationsAudit?.actor_membership_id
        === fixture.dual_role_team_b_shift_membership_id
      && teamBCaseOperationsAudit.actor_role === 'shift_lead',
    'Service-case ledgers did not preserve exact Team B dual-role attribution',
  );

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.team_a_manager_id}, true
      )`;
    await transaction`
      update service_cases set status = 'awaiting_customer'
      where id = ${fixture.team_a_support_case_id}
        and status = 'submitted'`;
    await transaction`
      select set_config('lakeandpine.current_customer_id', ${fixture.customer_id}, true)`;
    await transaction`
      update service_cases set status = 'action_planned'
      where id = ${fixture.team_a_support_case_id}
        and status = 'awaiting_customer'`;
  });
  const [customerCaseAudit] = await sql`
    select actor_membership_id, actor_label
    from service_case_events
    where service_case_id = ${fixture.team_a_support_case_id}
      and event_type = 'status_changed'
      and to_status = 'action_planned'
    order by created_at desc, id desc
    limit 1`;
  invariant(
    customerCaseAudit?.actor_membership_id === null
      && customerCaseAudit.actor_label === 'customer',
    'Customer service-case event did not retain a null membership and customer label',
  );

  await sql.begin(async (transaction) => {
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      update bookings set qualification_status = 'needs_information'
      where id = ${fixture.privacy_team_a_booking_id}`;
  });
  const [systemOperationsAudit] = await sql`
    select actor_membership_id, actor_role
    from operations_state_events
    where entity_type = 'bookings'
      and entity_id = ${fixture.privacy_team_a_booking_id}
      and field_name = 'qualification_status'
      and to_state = 'needs_information'
    order by created_at desc, id desc
    limit 1`;
  invariant(
    systemOperationsAudit?.actor_membership_id === null
      && systemOperationsAudit.actor_role === 'system',
    'System operations event did not retain a null membership and system label',
  );
  await sql`
    update bookings set qualification_status = 'approved'
    where id = ${fixture.privacy_team_a_booking_id}`;
}

async function inspectRefundActorBoundary(sql) {
  const [fixture] = await sql`
    select booking.id as booking_id, booking.customer_id,
      booking.is_dev_seed, allocation.team_id,
      team_a_manager.id as team_a_manager_id,
      team_b_manager.id as team_b_manager_id
    from bookings booking
    join job_schedules schedule on schedule.booking_id = booking.id
    join team_job_allocations allocation
      on allocation.job_schedule_id = schedule.id
    join cleaning_teams team on team.id = allocation.team_id
    join customers team_a_manager
      on team_a_manager.email = 'team-manager@verify.invalid'
    join customers team_b_manager
      on team_b_manager.email = 'team-b-manager@verify.invalid'
    where team.code = 'verify-team-a'
      and booking.customer_id is not null
    order by (booking.scheduled_window = 'Staff lead allocation') desc,
      booking.created_at, booking.id
    limit 1`;
  invariant(
    fixture?.booking_id && fixture.customer_id && fixture.team_id
      && fixture.team_a_manager_id && fixture.team_b_manager_id,
    'Refund boundary could not resolve a Team A booking and scoped managers',
  );

  let billing;
  let serviceCase;
  await sql.begin(async (transaction) => {
    [billing] = await transaction`
      insert into billing_records
        (customer_id, booking_id, description, amount_cents, status, is_dev_seed)
      values (${fixture.customer_id}, ${fixture.booking_id},
        'Refund actor-boundary paid service', 10000, 'paid',
        ${fixture.is_dev_seed})
      returning id`;
    [serviceCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, priority, is_dev_seed)
      values ('VERIFY-REFUND-ACTOR-BOUNDARY', 'complaint',
        ${fixture.booking_id}, ${fixture.customer_id}, ${fixture.team_id},
        '{}'::jsonb, 'Scoped manual refund lifecycle verifier',
        'refund_pending', 'high', ${fixture.is_dev_seed})
      returning id`;
  });
  invariant(billing?.id && serviceCase?.id,
    'Refund boundary could not seed a paid bill and refund-pending case');

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_customer_id', '', true)`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    const [visibility] = await transaction`
      select count(*)::int as count from refund_records
      where service_case_id = ${serviceCase.id}`;
    invariant(visibility.count === 0,
      'Null application actor retained raw visibility into refund decisions');
    await expectDatabaseError(transaction, ['42501'], 'null actor creating a refund decision',
      async (savepoint) => savepoint`
        insert into refund_records
          (service_case_id, booking_id, billing_record_id, amount_cents, reason_code)
        values (${serviceCase.id}, ${fixture.booking_id}, ${billing.id},
          10000, 'forbidden_null_actor')`);
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.customer_id}, true
      )`;
    const [visibility] = await transaction`
      select count(*)::int as count from refund_records
      where service_case_id = ${serviceCase.id}`;
    invariant(visibility.count === 0,
      'Customer retained raw visibility into an operator refund decision');
    await expectDatabaseError(transaction, ['42501'], 'customer creating a refund decision',
      async (savepoint) => savepoint`
        insert into refund_records
          (service_case_id, booking_id, billing_record_id, amount_cents, reason_code)
        values (${serviceCase.id}, ${fixture.booking_id}, ${billing.id},
          10000, 'forbidden_customer')`);
  });

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.team_b_manager_id}, true
      )`;
    const [visibility] = await transaction`
      select count(*)::int as count from refund_records
      where service_case_id = ${serviceCase.id}`;
    invariant(visibility.count === 0,
      'Team B manager retained raw visibility into a Team A refund decision');
    await expectDatabaseError(transaction, ['42501'], 'cross-team manager creating a refund',
      async (savepoint) => savepoint`
        insert into refund_records
          (service_case_id, booking_id, billing_record_id, amount_cents, reason_code)
        values (${serviceCase.id}, ${fixture.booking_id}, ${billing.id},
          10000, 'forbidden_cross_team')`);
  });

  let refund;
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.team_a_manager_id}, true
      )`;

    await expectDatabaseError(transaction, ['42501'], 'manager forging refund request attribution',
      async (savepoint) => savepoint`
        insert into refund_records
          (service_case_id, booking_id, billing_record_id, amount_cents,
           reason_code, requested_by_label)
        values (${serviceCase.id}, ${fixture.booking_id}, ${billing.id},
          10000, 'forged_attribution', 'Forged requester')`);
    [refund] = await transaction`
      insert into refund_records
        (service_case_id, booking_id, billing_record_id, amount_cents, reason_code)
      values (${serviceCase.id}, ${fixture.booking_id}, ${billing.id},
        10000, 'service_recovery')
      returning id, status, provider, requested_by_customer_id,
        requested_by_label, requested_at, approved_by_customer_id,
        approved_by_label, approved_at, processed_at, is_dev_seed`;
    invariant(
      refund?.id && refund.status === 'requested' && refund.provider === 'manual'
        && refund.requested_by_customer_id === fixture.team_a_manager_id
        && refund.requested_by_label === 'Team Manager'
        && refund.requested_at && refund.approved_by_customer_id === null
        && refund.approved_by_label === null && refund.approved_at === null
        && refund.processed_at === null
        && refund.is_dev_seed === fixture.is_dev_seed,
      'Refund request was not database-stamped to the scoped manager actor',
    );

    await expectDatabaseError(transaction, ['23514'], 'over-refund request',
      async (savepoint) => savepoint`
        insert into refund_records
          (service_case_id, booking_id, billing_record_id, amount_cents, reason_code)
        values (${serviceCase.id}, ${fixture.booking_id}, ${billing.id},
          1, 'over_refund')`);
    await expectDatabaseError(transaction, ['55000'], 'direct requested-to-processed refund jump',
      async (savepoint) => savepoint`
        update refund_records
        set status = 'processed', provider_refund_id = 're_ForbiddenDirectJump'
        where id = ${refund.id}`);
    await expectDatabaseError(transaction, ['42501'], 'refund amount rewrite',
      async (savepoint) => savepoint`
        update refund_records set amount_cents = 1 where id = ${refund.id}`);
    await expectDatabaseError(transaction, ['42501'], 'refund subject rewrite',
      async (savepoint) => savepoint`
        update refund_records set service_case_id = ${serviceCase.id}
        where id = ${refund.id}`);
    await expectDatabaseError(transaction, ['42501'], 'manager forging refund approval attribution',
      async (savepoint) => savepoint`
        update refund_records
        set status = 'approved', approved_by_label = 'Forged approver'
        where id = ${refund.id}`);

    const [approved] = await transaction`
      update refund_records
      set status = 'approved', operator_note = 'Manager approved manual refund'
      where id = ${refund.id}
      returning status, approved_by_customer_id, approved_by_label, approved_at,
        requested_by_customer_id, amount_cents, reason_code`;
    invariant(
      approved?.status === 'approved'
        && approved.approved_by_customer_id === fixture.team_a_manager_id
        && approved.approved_by_label === 'Team Manager' && approved.approved_at
        && approved.requested_by_customer_id === fixture.team_a_manager_id
        && approved.amount_cents === 10000
        && approved.reason_code === 'service_recovery',
      'Refund approval did not preserve subject and database-stamped attribution',
    );
    await expectDatabaseError(transaction, ['55000'], 'direct approved-to-processed refund jump',
      async (savepoint) => savepoint`
        update refund_records
        set status = 'processed', provider_refund_id = 're_ForbiddenApprovedJump'
        where id = ${refund.id}`);
    const ready = await transaction`
      update refund_records
      set status = 'ready_for_manual_processing',
          operator_note = 'Queued for external manual processing'
      where id = ${refund.id} returning id`;
    invariant(ready.length === 1,
      'Approved refund could not enter manual-processing readiness');
    await expectDatabaseError(transaction, ['23514'], 'processed refund without provider receipt',
      async (savepoint) => savepoint`
        update refund_records set status = 'processed'
        where id = ${refund.id}`);
    const [failed] = await transaction`
      update refund_records
      set status = 'failed', failure_code = 'manual_provider_timeout',
          operator_note = 'First external attempt failed'
      where id = ${refund.id}
      returning status, failure_code, provider_refund_id, processed_at`;
    invariant(
      failed?.status === 'failed'
        && failed.failure_code === 'manual_provider_timeout'
        && failed.provider_refund_id === null && failed.processed_at === null,
      'Manual refund failure did not retain bounded retry evidence',
    );
    const [retried] = await transaction`
      update refund_records
      set status = 'ready_for_manual_processing',
          operator_note = 'Manual refund retry authorized'
      where id = ${refund.id}
      returning status, failure_code`;
    invariant(
      retried?.status === 'ready_for_manual_processing'
        && retried.failure_code === null,
      'Manual refund retry did not clear stale failure evidence',
    );
    const [processed] = await transaction`
      update refund_records
      set status = 'processed', provider_refund_id = 're_VerifyManualRefund1',
          operator_note = 'External receipt confirmed'
      where id = ${refund.id}
      returning status, provider, provider_refund_id, processed_at,
        requested_by_customer_id, approved_by_customer_id, amount_cents`;
    invariant(
      processed?.status === 'processed' && processed.provider === 'manual'
        && processed.provider_refund_id === 're_VerifyManualRefund1'
        && processed.processed_at
        && processed.requested_by_customer_id === fixture.team_a_manager_id
        && processed.approved_by_customer_id === fixture.team_a_manager_id
        && processed.amount_cents === 10000,
      'Manual refund did not reach processed with an immutable external receipt',
    );
    await expectDatabaseError(transaction, ['55000'], 'processed refund lifecycle replay',
      async (savepoint) => savepoint`
        update refund_records set status = 'canceled' where id = ${refund.id}`);
    await expectDeniedMutation(transaction, ['42501'], 'manager deleting a refund ledger row',
      async (savepoint) => savepoint`
        delete from refund_records where id = ${refund.id} returning id`);
  });

  const [resolved] = await sql`
    select refund.status, refund.requested_by_customer_id,
      refund.approved_by_customer_id, refund.provider_refund_id,
      service_case.status as case_status,
      service_case.resolution_type,
      billing.status as billing_status
    from refund_records refund
    join service_cases service_case on service_case.id = refund.service_case_id
    join billing_records billing on billing.id = refund.billing_record_id
    where refund.id = ${refund.id}`;
  invariant(
    resolved?.status === 'processed'
      && resolved.requested_by_customer_id === fixture.team_a_manager_id
      && resolved.approved_by_customer_id === fixture.team_a_manager_id
      && resolved.provider_refund_id === 're_VerifyManualRefund1'
      && resolved.case_status === 'resolved'
      && resolved.resolution_type === 'refund'
      && resolved.billing_status === 'refunded',
    'Processed refund did not reconcile the case and full paid billing record',
  );
}

async function inspectTerminalRescheduleCrewLossCleanup(sql) {
  const [fixture] = await sql`
    select schedule.id as schedule_id, schedule.booking_id,
      schedule.start_at::text, schedule.end_at::text,
      allocation.id as allocation_id, allocation.organization_id,
      allocation.team_id, booking.customer_id,
      assignment.id as assignment_id,
      membership.id as cleaner_membership_id,
      preference.id as preference_id,
      manager.id as manager_customer_id,
      manager_membership.id as manager_membership_id
    from bookings booking
    join job_schedules schedule on schedule.booking_id = booking.id
    join team_job_allocations allocation
      on allocation.job_schedule_id = schedule.id
    join job_assignments assignment
      on assignment.job_schedule_id = schedule.id
    join workforce_memberships membership
      on membership.organization_id = allocation.organization_id
     and membership.team_id = allocation.team_id
     and membership.cleaner_id = assignment.cleaner_id
     and membership.status = 'active'
    join customer_cleaner_preferences preference
      on preference.organization_id = allocation.organization_id
     and preference.team_id = allocation.team_id
     and preference.customer_id = booking.customer_id
     and preference.cleaner_id = assignment.cleaner_id
     and preference.preference = 'avoid' and preference.active
    join customers manager on manager.email = 'team-manager@verify.invalid'
    join workforce_memberships manager_membership
      on manager_membership.customer_id = manager.id
     and manager_membership.organization_id = allocation.organization_id
     and manager_membership.team_id = allocation.team_id
     and manager_membership.role = 'manager'
     and manager_membership.status = 'active'
    where booking.contact ->> 'name' = 'Staff lead allocation proof'
      and schedule.status = 'held' and assignment.status = 'removed'`;
  invariant(
    fixture?.preference_id && fixture.cleaner_membership_id
      && fixture.manager_membership_id,
    'Terminal reschedule crew-loss fixture is missing or unsafe',
  );

  const setManager = async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.manager_customer_id}, true
      )`;
  };
  const setCustomer = async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.customer_id}, true
      )`;
  };

  await sql.begin(async (transaction) => {
    await setCustomer(transaction);
    await transaction`
      update customer_cleaner_preferences set active = false
      where id = ${fixture.preference_id}`;
  });

  let serviceCase;
  let proposal;
  await sql.begin(async (transaction) => {
    await setManager(transaction);
    const restoredAssignment = await transaction`
      update job_assignments set status = 'accepted', responded_at = now()
      where id = ${fixture.assignment_id} and status = 'removed'
      returning id`;
    invariant(restoredAssignment.length === 1,
      'Terminal cleanup fixture could not restore a complete crew');
    [serviceCase] = await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, priority, is_dev_seed)
      values ('VERIFY-TERMINAL-RESCHEDULE-CREW-LOSS', 'reschedule',
        ${fixture.booking_id}, ${fixture.customer_id}, ${fixture.team_id},
        '{}'::jsonb, 'Terminal proposal cleanup after crew loss',
        'action_planned', 'normal', true)
      returning id`;
    const [version] = await transaction`
      select coalesce(max(version), 0)::int + 1 as value
      from schedule_proposals where job_schedule_id = ${fixture.schedule_id}`;
    [proposal] = await transaction`
      insert into schedule_proposals
        (organization_id, team_id, team_job_allocation_id, job_schedule_id,
         service_case_id, proposed_start_at, proposed_end_at, customer_id,
         arrival_window_start, arrival_window_end, status, version,
         proposed_by_membership_id, proposal_note, expires_at, is_dev_seed)
      values (${fixture.organization_id}, ${fixture.team_id},
        ${fixture.allocation_id}, ${fixture.schedule_id}, ${serviceCase.id},
        ${fixture.start_at}, ${fixture.end_at}, ${fixture.customer_id},
        ${fixture.start_at}::timestamptz - interval '1 hour',
        ${fixture.start_at}::timestamptz + interval '1 hour',
        'pending_customer', ${version.value}, ${fixture.manager_membership_id},
        'Verifier proposal must close even after crew disappears',
        ${fixture.start_at}, true)
      returning id`;
    await transaction`
      update service_cases set status = 'awaiting_customer'
      where id = ${serviceCase.id}`;
  });
  invariant(serviceCase?.id && proposal?.id,
    'Terminal reschedule cleanup fixture was not staged');

  await sql.begin(async (transaction) => {
    await setCustomer(transaction);
    const approved = await transaction`
      update schedule_proposals set status = 'approved',
        customer_response_note = 'Verifier approved before crew loss'
      where id = ${proposal.id} and status = 'pending_customer'
      returning id`;
    invariant(approved.length === 1,
      'Customer could not approve the terminal-cleanup proposal');
  });

  await sql.begin(async (transaction) => {
    await setManager(transaction);
    await transaction`
      update workforce_memberships
      set status = 'paused', status_reason = 'Verifier terminal cleanup crew loss'
      where id = ${fixture.cleaner_membership_id}`;
    const [crewLoss] = await transaction`
      select membership.status as membership_status,
        assignment.status as assignment_status,
        exists (
          select 1
          from job_assignments active_assignment
          join workforce_memberships active_membership
            on active_membership.organization_id = ${fixture.organization_id}
           and active_membership.team_id = ${fixture.team_id}
           and active_membership.cleaner_id = active_assignment.cleaner_id
           and active_membership.status = 'active'
          where active_assignment.job_schedule_id = ${fixture.schedule_id}
            and active_assignment.team_id = ${fixture.team_id}
            and active_assignment.status in ('accepted', 'confirmed')
        ) as crew_complete
      from workforce_memberships membership
      join job_assignments assignment on assignment.id = ${fixture.assignment_id}
      where membership.id = ${fixture.cleaner_membership_id}`;
    invariant(
      crewLoss.membership_status === 'paused'
        && crewLoss.assignment_status === 'removed' && !crewLoss.crew_complete,
      'Terminal cleanup fixture did not establish real crew loss',
    );
    const superseded = await transaction`
      update schedule_proposals set status = 'superseded'
      where id = ${proposal.id} and status = 'approved'
      returning id`;
    invariant(superseded.length === 1,
      'Crew loss prevented terminal cleanup of the reschedule proposal');
    const terminalized = await transaction`
      update service_cases set status = 'canceled'
      where id = ${serviceCase.id} and status = 'awaiting_customer'
      returning id`;
    invariant(terminalized.length === 1,
      'Crew loss prevented the authorized terminal service-case transition');
    const [terminalState] = await transaction`
      select service_case.status as case_status,
        proposal.status as proposal_status,
        assignment.status as assignment_status
      from service_cases service_case
      join schedule_proposals proposal on proposal.id = ${proposal.id}
      join job_assignments assignment on assignment.id = ${fixture.assignment_id}
      where service_case.id = ${serviceCase.id}`;
    invariant(
      terminalState.case_status === 'canceled'
        && terminalState.proposal_status === 'superseded'
        && terminalState.assignment_status === 'removed',
      'Terminal reschedule did not supersede its proposal after crew loss',
    );
    await transaction`
      update workforce_memberships
      set status = 'active', status_reason = 'Verifier terminal cleanup restore',
          ended_at = null
      where id = ${fixture.cleaner_membership_id}`;
  });

  await sql.begin(async (transaction) => {
    await setCustomer(transaction);
    await transaction`
      update customer_cleaner_preferences set active = true
      where id = ${fixture.preference_id}`;
  });
  const [restoredBaseline] = await sql`
    select membership.status as membership_status,
      assignment.status as assignment_status, schedule.status as schedule_status,
      preference.active as avoid_active
    from workforce_memberships membership
    join job_assignments assignment on assignment.id = ${fixture.assignment_id}
    join job_schedules schedule on schedule.id = ${fixture.schedule_id}
    join customer_cleaner_preferences preference
      on preference.id = ${fixture.preference_id}
    where membership.id = ${fixture.cleaner_membership_id}`;
  invariant(
    restoredBaseline.membership_status === 'active'
      && restoredBaseline.assignment_status === 'removed'
      && restoredBaseline.schedule_status === 'held'
      && restoredBaseline.avoid_active,
    'Terminal cleanup proof did not restore the shared concurrency baseline',
  );
}

async function inspectExpiredScheduleApproval(sql) {
  // `now()` is transaction-stable in PostgreSQL. Verify expiry in a new
  // transaction, matching the real request boundary between customer response
  // and a later manager confirmation attempt.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  await sql.begin(async (transaction) => {
    const [fixture] = await transaction`
      select manager.id as manager_id, schedule.id as schedule_id
      from customers manager
      cross join bookings booking
      join job_schedules schedule on schedule.booking_id = booking.id
      where manager.email = 'team-manager@verify.invalid'
        and booking.contact ->> 'name' = 'Staff lead allocation proof'
        and manager.is_dev_seed and booking.is_dev_seed`;
    invariant(fixture?.manager_id && fixture?.schedule_id,
      'Expired-approval fixture was not committed by national operations verification');
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`
      select set_config('lakeandpine.current_customer_id', ${fixture.manager_id}, true)`;
    const [expiredState] = await transaction`
      select schedule.status,
        bool_and(proposal.expires_at <= now()) as all_approvals_expired
      from job_schedules schedule
      join schedule_proposals proposal on proposal.job_schedule_id = schedule.id
        and proposal.status = 'approved'
      where schedule.id = ${fixture.schedule_id}
      group by schedule.status`;
    invariant(
      expiredState?.status === 'held' && expiredState.all_approvals_expired,
      'Expired-approval fixture did not cross a committed request boundary',
    );
    await expectDatabaseError(transaction, ['P0001'], 'confirmation with expired customer approval', async (savepoint) => {
      await savepoint`
        update job_schedules set status = 'confirmed', version = version + 1
        where id = ${fixture.schedule_id}`;
    });
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

async function inspectExpiredEarlierRescheduleIsolation(sql) {
  // Exercise the request boundary that exposed the stale-proposal collision:
  // the linked recovery expires before a still-future original appointment.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  await sql.begin(async (transaction) => {
    const [manager] = await transaction`
      select id from customers where email = 'team-manager@verify.invalid'`;
    invariant(manager?.id,
      'Expired earlier-reschedule manager fixture was not committed');
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`
      select set_config('lakeandpine.current_customer_id', ${manager.id}, true)`;
    const [fixture] = await transaction`
      select service_case.id as service_case_id,
        service_case.status as service_case_status,
        booking.customer_id,
        allocation.organization_id, allocation.team_id,
        allocation.id as allocation_id,
        schedule.id as schedule_id, schedule.status as schedule_status,
        schedule.start_at::text as original_start_at,
        schedule.end_at::text as original_end_at,
        proposal.id as proposal_id, proposal.status as proposal_status,
        proposal.version, proposal.proposed_start_at::text as proposed_start_at,
        proposal.proposed_end_at::text as proposed_end_at,
        proposal.expires_at::text as expires_at,
        membership.id as manager_membership_id
      from service_cases service_case
      join bookings booking on booking.id = service_case.booking_id
      join job_schedules schedule on schedule.booking_id = booking.id
      join team_job_allocations allocation
        on allocation.job_schedule_id = schedule.id
      join schedule_proposals proposal
        on proposal.service_case_id = service_case.id
       and proposal.version = 2
      join workforce_memberships membership
        on membership.organization_id = allocation.organization_id
       and membership.team_id = allocation.team_id
       and membership.customer_id = ${manager.id}
       and membership.role = 'manager' and membership.status = 'active'
      where service_case.public_reference = 'VERIFY-EXPIRED-EARLY-RESCHEDULE'`;
    invariant(
      fixture?.service_case_status === 'awaiting_customer'
        && fixture.schedule_status === 'confirmed'
        && fixture.proposal_status === 'pending_customer'
        && Date.parse(fixture.proposed_start_at)
          < Date.parse(fixture.original_start_at)
        && Date.parse(fixture.expires_at) <= Date.now()
        && Date.parse(fixture.original_start_at) > Date.now(),
      'Earlier-than-original linked reschedule did not expire across a committed request boundary',
    );

    // Mirror the captured generic action: supersede every open proposal, then
    // try to insert an unlinked base-window proposal. The savepoint must roll
    // the supersede back when the database rejects detaching the active case.
    await expectDatabaseError(transaction, ['P0001'], 'generic proposal during active reschedule recovery', async (savepoint) => {
      await savepoint`
        update schedule_proposals set status = 'superseded'
        where job_schedule_id = ${fixture.schedule_id}
          and status in ('draft', 'pending_customer', 'changes_requested')`;
      await savepoint`
        insert into schedule_proposals
          (organization_id, team_id, team_job_allocation_id, job_schedule_id,
           customer_id, arrival_window_start, arrival_window_end, status,
           version, proposed_by_membership_id, proposal_note, expires_at,
           is_dev_seed)
        values (${fixture.organization_id}, ${fixture.team_id},
          ${fixture.allocation_id}, ${fixture.schedule_id}, ${fixture.customer_id},
          '2030-09-09T15:00:00.000Z', '2030-09-09T17:00:00.000Z',
          'pending_customer', 3, ${fixture.manager_membership_id},
          'Forbidden generic proposal over active recovery',
          ${fixture.original_start_at}, true)`;
    });
    const [preserved] = await transaction`
      select service_case.status as service_case_status,
        schedule.status as schedule_status,
        schedule.start_at::text as original_start_at,
        schedule.end_at::text as original_end_at,
        linked.status as linked_status,
        (select count(*)::int from schedule_proposals generic
          where generic.job_schedule_id = schedule.id
            and generic.service_case_id is null and generic.version = 3)
          as generic_version_count
      from service_cases service_case
      join bookings booking on booking.id = service_case.booking_id
      join job_schedules schedule on schedule.booking_id = booking.id
      join schedule_proposals linked on linked.id = ${fixture.proposal_id}
      where service_case.id = ${fixture.service_case_id}`;
    invariant(
      preserved.service_case_status === 'awaiting_customer'
        && preserved.schedule_status === 'confirmed'
        && Date.parse(preserved.original_start_at)
          === Date.parse(fixture.original_start_at)
        && Date.parse(preserved.original_end_at)
          === Date.parse(fixture.original_end_at)
        && preserved.linked_status === 'pending_customer'
        && preserved.generic_version_count === 0,
      'Rejected generic proposal damaged the linked case, proposal, or live schedule',
    );

    await transaction`
      update schedule_proposals set status = 'superseded'
      where id = ${fixture.proposal_id}`;
    const [restageClock] = await transaction`
      select (clock_timestamp() + interval '1 minute')::text as start_at,
        (clock_timestamp() + interval '61 minutes')::text as end_at,
        (clock_timestamp() - interval '1 minute')::text as window_start,
        (clock_timestamp() + interval '119 minutes')::text as window_end,
        (clock_timestamp() + interval '1 day')::text as expires_at`;
    const [replacement] = await transaction`
      insert into schedule_proposals
        (organization_id, team_id, team_job_allocation_id, job_schedule_id,
         service_case_id, proposed_start_at, proposed_end_at, customer_id,
         arrival_window_start, arrival_window_end, status, version,
         proposed_by_membership_id, proposal_note, expires_at, is_dev_seed)
      values (${fixture.organization_id}, ${fixture.team_id},
        ${fixture.allocation_id}, ${fixture.schedule_id},
        ${fixture.service_case_id},
        ${restageClock.start_at}, ${restageClock.end_at},
        ${fixture.customer_id}, ${restageClock.window_start},
        ${restageClock.window_end}, 'pending_customer', 3,
        ${fixture.manager_membership_id},
        'Verifier replacement remains linked to recovery',
        ${restageClock.expires_at}, true)
      returning id`;
    const [restaged] = await transaction`
      select service_case.status as service_case_status,
        schedule.start_at::text as original_start_at,
        old_proposal.status as old_status,
        replacement.status as replacement_status,
        replacement.service_case_id as replacement_case_id
      from service_cases service_case
      join bookings booking on booking.id = service_case.booking_id
      join job_schedules schedule on schedule.booking_id = booking.id
      join schedule_proposals old_proposal
        on old_proposal.id = ${fixture.proposal_id}
      join schedule_proposals replacement on replacement.id = ${replacement.id}
      where service_case.id = ${fixture.service_case_id}`;
    invariant(
      restaged.service_case_status === 'awaiting_customer'
        && Date.parse(restaged.original_start_at)
          === Date.parse(fixture.original_start_at)
        && restaged.old_status === 'superseded'
        && restaged.replacement_status === 'pending_customer'
        && restaged.replacement_case_id === fixture.service_case_id,
      'Expired recovery could not be safely restaged on the same linked case',
    );

    await expectDatabaseError(transaction, ['55000'], 'branch policy invalidating an open replacement proposal', async (savepoint) => {
      await savepoint`
        update cleaning_teams set operating_start_time = '13:00'
        where id = ${fixture.team_id}`;
    });
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.customer_id}, true
      )`;
    await transaction`
      update schedule_proposals set status = 'approved',
        customer_response_note = 'Verifier approved executable restage'
      where id = ${replacement.id}`;
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${manager.id}, true
      )`;
    await transaction`
      update job_schedules
      set start_at = ${restageClock.start_at}, end_at = ${restageClock.end_at},
          version = version + 1
      where id = ${fixture.schedule_id} and status = 'confirmed'`;
    await transaction`
      update service_cases
      set status = 'resolved', resolution_type = 'rescheduled',
          resolution_summary = 'Verifier executable restage applied.',
          resolved_at = now()
      where id = ${fixture.service_case_id}
        and status = 'awaiting_customer'`;
    const lifecycleStates = [
      ['confirmed', 'en_route'],
      ['en_route', 'in_progress'],
      ['in_progress', 'quality_review'],
      ['quality_review', null],
    ];
    for (const [currentStatus, nextStatus] of lifecycleStates) {
      const [current] = await transaction`
        select status from job_schedules where id = ${fixture.schedule_id}`;
      invariant(
        current.status === currentStatus,
        `Branch-policy fixture expected ${currentStatus}; received ${current.status}`,
      );
      await expectDatabaseError(transaction, ['55000'], `branch clock tightening around ${currentStatus} work`, async (savepoint) => {
        await savepoint`
          update cleaning_teams set operating_start_time = '13:00'
          where id = ${fixture.team_id}`;
      });
      if (nextStatus) {
        await transaction`
          update job_schedules
          set status = ${nextStatus}, version = version + 1
          where id = ${fixture.schedule_id}`;
      }
    }
    const [expandedPolicy] = await transaction`
      update cleaning_teams
      set operating_start_time = '00:00', latest_arrival_time = '23:00',
          hard_finish_time = '23:59'
      where id = ${fixture.team_id}
      returning operating_start_time::text, latest_arrival_time::text,
        hard_finish_time::text`;
    invariant(
      expandedPolicy.operating_start_time === '00:00:00'
        && expandedPolicy.latest_arrival_time === '23:00:00'
        && expandedPolicy.hard_finish_time === '23:59:00',
      'A safe branch field-policy expansion was rejected or not persisted',
    );
  });
}

async function inspectFieldWriteConcurrency(sql) {
  const [fixture] = await sql`
    select schedule.id as schedule_id, schedule.booking_id,
      allocation.organization_id, allocation.team_id,
      allocation.id as allocation_id, booking.customer_id,
      assignment.id as assignment_id,
      cleaner_membership.id as cleaner_membership_id,
      preference.id as preference_id,
      manager.id as manager_customer_id,
      manager_membership.id as manager_membership_id
    from job_schedules schedule
    join bookings booking on booking.id = schedule.booking_id
    join team_job_allocations allocation
      on allocation.job_schedule_id = schedule.id
    join job_assignments assignment on assignment.job_schedule_id = schedule.id
    join workforce_memberships cleaner_membership
      on cleaner_membership.organization_id = allocation.organization_id
     and cleaner_membership.team_id = allocation.team_id
     and cleaner_membership.cleaner_id = assignment.cleaner_id
     and cleaner_membership.status = 'active'
    join customer_cleaner_preferences preference
      on preference.organization_id = allocation.organization_id
     and preference.team_id = allocation.team_id
     and preference.customer_id = booking.customer_id
     and preference.cleaner_id = assignment.cleaner_id
     and preference.preference = 'avoid' and preference.active
    join customers manager on manager.email = 'peer-manager@verify.invalid'
    join workforce_memberships manager_membership
      on manager_membership.customer_id = manager.id
     and manager_membership.organization_id = allocation.organization_id
     and manager_membership.team_id = allocation.team_id
     and manager_membership.role = 'manager'
     and manager_membership.status = 'active'
    where booking.contact ->> 'name' = 'Staff lead allocation proof'
      and schedule.status = 'held' and assignment.status = 'removed'`;
  invariant(fixture?.preference_id,
    'Field write-concurrency fixture is missing or unsafe');

  const setManager = async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.manager_customer_id}, true
      )`;
  };
  const setCustomer = async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.customer_id}, true
      )`;
  };
  const restoreMembership = () => sql.begin(async (transaction) => {
    await setManager(transaction);
    await transaction`
      update workforce_memberships
      set status = 'active', status_reason = 'Concurrency verifier restore',
          ended_at = null
      where id = ${fixture.cleaner_membership_id}`;
  });
  const pauseMembership = async (transaction) => {
    await setManager(transaction);
    return transaction`
      update workforce_memberships
      set status = 'paused', status_reason = 'Concurrency verifier pause'
      where id = ${fixture.cleaner_membership_id}
      returning id`;
  };
  const readCrewState = async () => {
    const [state] = await sql`
      select membership.status as membership_status,
        assignment.status as assignment_status,
        schedule.status as schedule_status
      from workforce_memberships membership
      join job_assignments assignment on assignment.id = ${fixture.assignment_id}
      join job_schedules schedule on schedule.id = ${fixture.schedule_id}
      where membership.id = ${fixture.cleaner_membership_id}`;
    return state;
  };

  // Activating an avoid and activating an assignment use one advisory scope.
  await sql`update customer_cleaner_preferences set active = false
    where id = ${fixture.preference_id}`;
  let releasePreference;
  const mayCommitPreference = new Promise((resolve) => {
    releasePreference = resolve;
  });
  let confirmPreference;
  const preferenceChanged = new Promise((resolve) => {
    confirmPreference = resolve;
  });
  const preferenceHolder = sql.begin(async (transaction) => {
    await setCustomer(transaction);
    const activated = await transaction`
      update customer_cleaner_preferences set active = true
      where id = ${fixture.preference_id} returning id`;
    invariant(activated.length === 1,
      'Concurrent avoid activation did not change its fixture');
    confirmPreference();
    await mayCommitPreference;
  });
  await preferenceChanged;
  const assignmentAgainstAvoid = sql.begin(async (transaction) => {
    await setManager(transaction);
    await transaction`
      update job_assignments set status = 'accepted', responded_at = now()
      where id = ${fixture.assignment_id}`;
  });
  const avoidEarly = await Promise.race([
    assignmentAgainstAvoid.then(() => 'finished', () => 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 150)),
  ]);
  releasePreference();
  const [preferenceResult, avoidedAssignmentResult] = await Promise.allSettled([
    preferenceHolder,
    assignmentAgainstAvoid,
  ]);
  invariant(
    avoidEarly === 'blocked'
      && preferenceResult.status === 'fulfilled'
      && avoidedAssignmentResult.status === 'rejected'
      && avoidedAssignmentResult.reason?.code === '23514',
    'Concurrent avoid activation and assignment activation did not serialize fail closed',
  );
  const [avoidState] = await sql`
    select preference.active, assignment.status as assignment_status
    from customer_cleaner_preferences preference
    join job_assignments assignment on assignment.id = ${fixture.assignment_id}
    where preference.id = ${fixture.preference_id}`;
  invariant(avoidState.active && avoidState.assignment_status === 'removed',
    'Concurrent avoid control left an executable conflicting assignment');

  // Membership offboarding and assignment activation share the membership row.
  await sql`update customer_cleaner_preferences set active = false
    where id = ${fixture.preference_id}`;
  let releaseAssignment;
  const mayCommitAssignment = new Promise((resolve) => {
    releaseAssignment = resolve;
  });
  let confirmAssignment;
  const assignmentChanged = new Promise((resolve) => {
    confirmAssignment = resolve;
  });
  const assignmentHolder = sql.begin(async (transaction) => {
    await setManager(transaction);
    const changed = await transaction`
      update job_assignments set status = 'accepted', responded_at = now()
      where id = ${fixture.assignment_id} returning id`;
    invariant(changed.length === 1,
      'Assignment-first concurrency fixture did not activate');
    confirmAssignment();
    await mayCommitAssignment;
  });
  await assignmentChanged;
  const pauseAfterAssignment = sql.begin(pauseMembership);
  const assignmentFirstEarly = await Promise.race([
    pauseAfterAssignment.then(() => 'finished', () => 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 150)),
  ]);
  releaseAssignment();
  const assignmentFirstResults = await Promise.allSettled([
    assignmentHolder,
    pauseAfterAssignment,
  ]);
  const assignmentFirstState = await readCrewState();
  invariant(
    assignmentFirstEarly === 'blocked'
      && assignmentFirstResults.every((result) => result.status === 'fulfilled')
      && assignmentFirstState.membership_status === 'paused'
      && assignmentFirstState.assignment_status === 'removed'
      && assignmentFirstState.schedule_status === 'held',
    'Assignment-first offboarding race did not reconcile to held work without ghost crew',
  );
  await restoreMembership();

  let releasePause;
  const mayCommitPause = new Promise((resolve) => {
    releasePause = resolve;
  });
  let confirmPause;
  const membershipPaused = new Promise((resolve) => {
    confirmPause = resolve;
  });
  const pauseHolder = sql.begin(async (transaction) => {
    const changed = await pauseMembership(transaction);
    invariant(changed.length === 1,
      'Pause-first concurrency fixture did not pause');
    confirmPause();
    await mayCommitPause;
  });
  await membershipPaused;
  const assignmentAfterPause = sql.begin(async (transaction) => {
    await setManager(transaction);
    await transaction`
      update job_assignments set status = 'accepted', responded_at = now()
      where id = ${fixture.assignment_id}`;
  });
  const pauseFirstEarly = await Promise.race([
    assignmentAfterPause.then(() => 'finished', () => 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 150)),
  ]);
  releasePause();
  const [pauseResult, pausedAssignmentResult] = await Promise.allSettled([
    pauseHolder,
    assignmentAfterPause,
  ]);
  const pauseFirstState = await readCrewState();
  invariant(
    pauseFirstEarly === 'blocked'
      && pauseResult.status === 'fulfilled'
      && pausedAssignmentResult.status === 'rejected'
      && pausedAssignmentResult.reason?.code === '23514'
      && pauseFirstState.membership_status === 'paused'
      && pauseFirstState.assignment_status === 'removed'
      && pauseFirstState.schedule_status === 'held',
    'Pause-first assignment race did not reject ghost-crew activation',
  );
  await restoreMembership();

  // Create a fresh, current base approval for both schedule/case lock orders.
  const proposal = await sql.begin(async (transaction) => {
    await setManager(transaction);
    await transaction`
      update job_assignments set status = 'accepted', responded_at = now()
      where id = ${fixture.assignment_id}`;
    const [version] = await transaction`
      select coalesce(max(version), 0)::int + 1 as value
      from schedule_proposals where job_schedule_id = ${fixture.schedule_id}`;
    const [created] = await transaction`
      insert into schedule_proposals
        (organization_id, team_id, team_job_allocation_id, job_schedule_id,
         customer_id, arrival_window_start, arrival_window_end, status,
         version, proposed_by_membership_id, proposal_note, expires_at,
         is_dev_seed)
      values (${fixture.organization_id}, ${fixture.team_id},
        ${fixture.allocation_id}, ${fixture.schedule_id}, ${fixture.customer_id},
        '2030-08-05T19:00:00.000Z', '2030-08-05T21:00:00.000Z',
        'pending_customer', ${version.value}, ${fixture.manager_membership_id},
        'Concurrency verifier current approval',
        '2030-08-05T20:00:00.000Z', true)
      returning id`;
    return created;
  });
  await sql.begin(async (transaction) => {
    await setCustomer(transaction);
    await transaction`update schedule_proposals set status = 'approved'
      where id = ${proposal.id}`;
  });

  // Confirmation-first: case insert waits and preserves already-confirmed work.
  let releaseConfirmation;
  const mayCommitConfirmation = new Promise((resolve) => {
    releaseConfirmation = resolve;
  });
  let confirmConfirmation;
  const scheduleConfirmed = new Promise((resolve) => {
    confirmConfirmation = resolve;
  });
  const confirmationHolder = sql.begin(async (transaction) => {
    await setManager(transaction);
    const changed = await transaction`
      update job_schedules set status = 'confirmed', version = version + 1
      where id = ${fixture.schedule_id} returning id`;
    invariant(changed.length === 1,
      'Confirmation-first concurrency fixture did not confirm');
    confirmConfirmation();
    await mayCommitConfirmation;
  });
  await scheduleConfirmed;
  const confirmFirstCase = sql.begin(async (transaction) => {
    await setManager(transaction);
    await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, priority, is_dev_seed)
      values ('VERIFY-CONCURRENCY-CONFIRM-FIRST', 'reschedule',
        ${fixture.booking_id}, ${fixture.customer_id}, ${fixture.team_id},
        '{}'::jsonb, 'Confirmation-first serialization proof',
        'submitted', 'normal', true)`;
  });
  const confirmFirstEarly = await Promise.race([
    confirmFirstCase.then(() => 'finished', () => 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 150)),
  ]);
  releaseConfirmation();
  const confirmFirstResults = await Promise.allSettled([
    confirmationHolder,
    confirmFirstCase,
  ]);
  const [confirmFirstState] = await sql`
    select schedule.status, proposal.status as proposal_status
    from job_schedules schedule
    join schedule_proposals proposal on proposal.id = ${proposal.id}
    where schedule.id = ${fixture.schedule_id}`;
  invariant(
    confirmFirstEarly === 'blocked'
      && confirmFirstResults.every((result) => result.status === 'fulfilled')
      && confirmFirstState.status === 'confirmed'
      && confirmFirstState.proposal_status === 'approved',
    'Confirmation-first reschedule race invalidated executable approved work',
  );
  await sql.begin(async (transaction) => {
    await setManager(transaction);
    await expectDatabaseError(transaction, ['55000'], 'concurrency fixture dispatch before its future window', async (savepoint) => {
      await savepoint`
        update job_schedules set status = 'en_route', version = version + 1
        where id = ${fixture.schedule_id}`;
    });
    await transaction`
      update service_cases set status = 'canceled'
      where public_reference = 'VERIFY-CONCURRENCY-CONFIRM-FIRST'`;
    await transaction`
      update job_schedules set status = 'held', version = version + 1
      where id = ${fixture.schedule_id}`;
  });

  // Case-first: confirmation waits, revalidates, and rejects stale evidence.
  let releaseCase;
  const mayCommitCase = new Promise((resolve) => {
    releaseCase = resolve;
  });
  let confirmCase;
  const caseInserted = new Promise((resolve) => {
    confirmCase = resolve;
  });
  const caseHolder = sql.begin(async (transaction) => {
    await setManager(transaction);
    await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, priority, is_dev_seed)
      values ('VERIFY-CONCURRENCY-CASE-FIRST', 'reschedule',
        ${fixture.booking_id}, ${fixture.customer_id}, ${fixture.team_id},
        '{}'::jsonb, 'Case-first serialization proof',
        'submitted', 'normal', true)`;
    confirmCase();
    await mayCommitCase;
  });
  await caseInserted;
  const confirmationAfterCase = sql.begin(async (transaction) => {
    await setManager(transaction);
    await transaction`
      update job_schedules set status = 'confirmed', version = version + 1
      where id = ${fixture.schedule_id}`;
  });
  const caseFirstEarly = await Promise.race([
    confirmationAfterCase.then(() => 'finished', () => 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 150)),
  ]);
  releaseCase();
  const [caseResult, staleConfirmationResult] = await Promise.allSettled([
    caseHolder,
    confirmationAfterCase,
  ]);
  const [caseFirstState] = await sql`
    select schedule.status, proposal.status as proposal_status
    from job_schedules schedule
    join schedule_proposals proposal on proposal.id = ${proposal.id}
    where schedule.id = ${fixture.schedule_id}`;
  invariant(
    caseFirstEarly === 'blocked'
      && caseResult.status === 'fulfilled'
      && staleConfirmationResult.status === 'rejected'
      && staleConfirmationResult.reason?.code === 'P0001'
      && caseFirstState.status === 'held'
      && caseFirstState.proposal_status === 'superseded',
    'Case-first reschedule race allowed confirmation from stale approval evidence',
  );

  await sql.begin(async (transaction) => {
    await setManager(transaction);
    await transaction`update job_assignments set status = 'removed'
      where id = ${fixture.assignment_id}`;
    await transaction`update service_cases set status = 'canceled'
      where public_reference = 'VERIFY-CONCURRENCY-CASE-FIRST'`;
  });
  await sql.begin(async (transaction) => {
    await setCustomer(transaction);
    await transaction`update customer_cleaner_preferences set active = true
      where id = ${fixture.preference_id}`;
  });
}

async function inspectActiveRescheduleUniqueness(sql) {
  const [fixture] = await sql`
    select booking.id as booking_id, booking.customer_id,
      schedule.id as schedule_id, allocation.id as allocation_id,
      allocation.organization_id, allocation.team_id,
      manager_actor.id as manager_customer_id
    from bookings booking
    join job_schedules schedule on schedule.booking_id = booking.id
    join team_job_allocations allocation
      on allocation.job_schedule_id = schedule.id
    cross join customers manager_actor
    where booking.scheduled_window = 'Staff lead allocation'
      and manager_actor.email = 'team-manager@verify.invalid'
    limit 1`;
  invariant(fixture?.booking_id && fixture.manager_customer_id,
    'Active-reschedule concurrency fixture is missing');
  const setManager = async (transaction) => {
    await transaction.unsafe(`set local role ${quoteIdentifier(APP_ROLE)}`);
    await transaction`
      select set_config(
        'lakeandpine.current_customer_id', ${fixture.manager_customer_id}, true
      )`;
    await transaction`select set_config('lakeandpine.current_cleaner_id', '', true)`;
  };
  const insertCase = async (transaction, reference, details) => {
    await transaction`
      insert into service_cases
        (public_reference, case_type, booking_id, customer_id, assigned_team_id,
         contact, details, status, priority, is_dev_seed)
      values (${reference}, 'reschedule', ${fixture.booking_id},
        ${fixture.customer_id}, ${fixture.team_id}, '{}'::jsonb, ${details},
        'submitted', 'normal', true)`;
  };

  let releaseDirect;
  const mayCommitDirect = new Promise((resolve) => {
    releaseDirect = resolve;
  });
  let signalDirect;
  const directInserted = new Promise((resolve) => {
    signalDirect = resolve;
  });
  const directHolder = sql.begin(async (transaction) => {
    await setManager(transaction);
    await insertCase(
      transaction,
      'VERIFY-RESCHEDULE-UNIQUE-DIRECT-A',
      'Direct active-reschedule uniqueness holder',
    );
    signalDirect();
    await mayCommitDirect;
  });
  await directInserted;
  const directCompetitor = sql.begin(async (transaction) => {
    await setManager(transaction);
    await insertCase(
      transaction,
      'VERIFY-RESCHEDULE-UNIQUE-DIRECT-B',
      'Direct active-reschedule uniqueness competitor',
    );
  });
  const directEarly = await Promise.race([
    directCompetitor.then(() => 'finished', () => 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 150)),
  ]);
  releaseDirect();
  const directResults = await Promise.allSettled([
    directHolder,
    directCompetitor,
  ]);
  invariant(
    directEarly === 'blocked'
      && directResults[0].status === 'fulfilled'
      && directResults[1].status === 'rejected'
      && directResults[1].reason?.code === '23505',
    'Concurrent direct reschedule creators did not serialize to one SQLSTATE 23505 loser',
  );
  const [directState] = await sql`
    select count(*)::int as count
    from service_cases
    where booking_id = ${fixture.booking_id}
      and case_type = 'reschedule'
      and status not in ('resolved', 'closed', 'declined', 'canceled')`;
  invariant(directState.count === 1,
    'Concurrent direct creators persisted more than one active reschedule');
  await sql.begin(async (transaction) => {
    await setManager(transaction);
    await transaction`
      update service_cases set status = 'canceled'
      where public_reference = 'VERIFY-RESCHEDULE-UNIQUE-DIRECT-A'`;
  });

  const lockAppRequestScope = async (transaction) => {
    await transaction`
      select allocation.id
      from team_job_allocations allocation
      join job_schedules schedule on schedule.id = allocation.job_schedule_id
      join bookings booking on booking.id = schedule.booking_id
      where allocation.id = ${fixture.allocation_id}
        and schedule.id = ${fixture.schedule_id}
        and booking.id = ${fixture.booking_id}
      for update of allocation, schedule, booking`;
  };
  let releaseApp;
  const mayCommitApp = new Promise((resolve) => {
    releaseApp = resolve;
  });
  let signalApp;
  const appInserted = new Promise((resolve) => {
    signalApp = resolve;
  });
  const appHolder = sql.begin(async (transaction) => {
    await setManager(transaction);
    await lockAppRequestScope(transaction);
    await insertCase(
      transaction,
      'VERIFY-RESCHEDULE-UNIQUE-APP-A',
      'App-style active-reschedule holder',
    );
    signalApp();
    await mayCommitApp;
  });
  await appInserted;
  const appCompetitor = sql.begin(async (transaction) => {
    await setManager(transaction);
    await lockAppRequestScope(transaction);
    await insertCase(
      transaction,
      'VERIFY-RESCHEDULE-UNIQUE-APP-B',
      'App-style active-reschedule competitor',
    );
  });
  const appEarly = await Promise.race([
    appCompetitor.then(() => 'finished', () => 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 150)),
  ]);
  releaseApp();
  const appResults = await Promise.allSettled([appHolder, appCompetitor]);
  invariant(
    appEarly === 'blocked'
      && appResults[0].status === 'fulfilled'
      && appResults[1].status === 'rejected'
      && appResults[1].reason?.code === '23505',
    'Concurrent app-style reschedule creators did not serialize to one SQLSTATE 23505 loser',
  );
  const [appState] = await sql`
    select count(*)::int as count
    from service_cases
    where booking_id = ${fixture.booking_id}
      and case_type = 'reschedule'
      and status not in ('resolved', 'closed', 'declined', 'canceled')`;
  invariant(appState.count === 1,
    'Concurrent app-style creators persisted more than one active reschedule');
  await sql.begin(async (transaction) => {
    await setManager(transaction);
    await transaction`
      update service_cases set status = 'canceled'
      where public_reference = 'VERIFY-RESCHEDULE-UNIQUE-APP-A'`;
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
  const intelligentFieldIndex = migrations.findIndex(
    (migration) => migration.name === INTELLIGENT_FIELD_MIGRATION,
  );
  const exactFieldActorIndex = migrations.findIndex(
    (migration) => migration.name === EXACT_FIELD_ACTOR_MIGRATION,
  );
  invariant(
    intelligentFieldIndex >= 0,
    `${INTELLIGENT_FIELD_MIGRATION} is required for staged-upgrade verification`,
  );
  invariant(
    exactFieldActorIndex > intelligentFieldIndex,
    `${EXACT_FIELD_ACTOR_MIGRATION} must follow ${INTELLIGENT_FIELD_MIGRATION}`,
  );
  await applyMigrations(sql, migrations.slice(0, intelligentFieldIndex));
  const intelligentFieldUpgradeFixture =
    await seedIntelligentFieldUpgradeFixtures(sql);
  await applyMigrations(sql, migrations.slice(intelligentFieldIndex));
  await inspectIntelligentFieldUpgradeBackfill(
    sql,
    intelligentFieldUpgradeFixture,
  );
  await assertSafeRole(sql, true);

  const access = await inspectApplicationRoleAccess(sql);
  const hardening = await inspectProductionHardening(sql);
  const closedInheritedPolicyCatalog =
    await inspectClosedInheritedPolicyCatalog(sql);
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
    access.runtimeReadProbes,
  );
  await inspectOperationalInvariants(sql);
  await inspectOwnerBootstrapConcurrency(sql);
  await inspectRouteEnrichmentBoundary(sql);
  await inspectNationalTeamOperations(sql);
  await inspectLegacyChecklistActorBoundary(sql);
  await inspectScheduleActorBoundary(sql);
  await inspectDirectAssignmentAndCaseAccess(sql);
  await inspectClosedInheritedActorBoundaries(sql);
  await inspectRefundActorBoundary(sql);
  await inspectExpiredScheduleApproval(sql);
  await inspectTerminalRescheduleCrewLossCleanup(sql);
  await inspectExpiredEarlierRescheduleIsolation(sql);
  await inspectFieldWriteConcurrency(sql);
  await inspectActiveRescheduleUniqueness(sql);
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
    protectedPrivateTables: access.protectedPrivateTables,
    productionHardening: {
      postalFunctionSearchPath: hardening.functionSearchPath,
      duplicatePermissivePolicies: hardening.duplicatePermissivePolicies,
      applicationCatalogTablesVisible: hardening.applicationCatalogTablesVisible,
      publicCatalogRoleReads: hardening.publicCatalogRoleReads,
      unindexedForeignKeys: hardening.unindexedForeignKeys,
    },
    closedInheritedPolicyCatalog,
    atomicIntakeFunctions: atomicIntake.functions.length > 0
      ? atomicIntake.functions.map((candidate) => candidate.signature)
      : "none discovered; add a function name matching create*booking/booking*create or an 'atomic intake' function comment",
    operationalInvariants: "postal eligibility, team territory dispatch, route approval, customer schedule approval, cross-team field isolation, audited job communication, mileage review, issue resolution, duty coverage, non-cash tip intent, customer cleaner continuity, labor, schedule and recovery lifecycle, availability and approved PTO, cancellation, refunds, concurrent owner bootstrap, race-safe team clean rooms, owner/GM/manager hierarchy, downward-only financial and workforce authority, scoped actor attribution, team job allocation, ledger-controlled stock, guarded restock receipts, cleaner and shift-lead time with nonzero breaks, rejected forged time/bonus states, self-financial controls, and completed-job verified-review bonuses verified",
  }, null, 2));
} finally {
  if (sql) await sql.end({ timeout: 5 });
  await bootstrapSql.end({ timeout: 5 });
}
