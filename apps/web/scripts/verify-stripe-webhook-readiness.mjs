import { connect } from "./_db.mjs";

const APP_ROLE = "lakeandpine_app";

if (process.env.LAKEANDPINE_STRIPE_READINESS_CHECK !== "1") {
  throw new Error(
    "Stripe webhook readiness is disabled. Select the intended database and set LAKEANDPINE_STRIPE_READINESS_CHECK=1.",
  );
}

const expectedModeValue = process.env.LAKEANDPINE_EXPECTED_STRIPE_LIVEMODE;
if (expectedModeValue !== "true" && expectedModeValue !== "false") {
  throw new Error(
    "Set LAKEANDPINE_EXPECTED_STRIPE_LIVEMODE to exactly true or false.",
  );
}
const expectedLivemode = expectedModeValue === "true";
const sql = connect();

try {
  const [target] = await sql`
    select current_database() as database_name,
      current_user as database_user,
      coalesce(inet_server_addr()::text, 'local-socket') as server_address`;
  console.log(
    `Stripe readiness target: ${target.database_name} @ ${target.server_address} as ${target.database_user}`,
  );

  const [runtimeRole] = await sql`
    select rolname, rolsuper, rolbypassrls, rolcanlogin
    from pg_roles
    where rolname = ${APP_ROLE}`;
  if (!runtimeRole || runtimeRole.rolsuper || runtimeRole.rolbypassrls) {
    throw new Error("The runtime role is absent or has unsafe role attributes");
  }

  const [configuration] = await sql`
    select count(*)::integer as config_count,
      count(*) filter (
        where octet_length(webhook_secret) between 16 and 512
          and webhook_secret !~ '[[:space:][:cntrl:]]'
      )::integer as valid_secret_count,
      bool_and(expected_livemode = ${expectedLivemode}) as mode_matches,
      min(signature_tolerance_seconds)::integer as signature_tolerance_seconds,
      min(capability_ttl_seconds)::integer as capability_ttl_seconds
    from private.stripe_webhook_config`;
  if (
    configuration.config_count !== 1 ||
    configuration.valid_secret_count !== 1 ||
    configuration.mode_matches !== true
  ) {
    throw new Error(
      "Stripe DB verification is absent, invalid, or configured for the wrong mode",
    );
  }

  const privateTables = await sql`
    select c.relname as table_name,
      c.relrowsecurity as rls_enabled,
      owner_role.rolname as owner_name,
      pg_has_role(current_user, c.relowner, 'MEMBER') as current_admin_can_configure,
      has_table_privilege(${APP_ROLE}, c.oid, 'SELECT')
        or has_table_privilege(${APP_ROLE}, c.oid, 'INSERT')
        or has_table_privilege(${APP_ROLE}, c.oid, 'UPDATE')
        or has_table_privilege(${APP_ROLE}, c.oid, 'DELETE') as app_has_table_access
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles owner_role on owner_role.oid = c.relowner
    where n.nspname = 'private'
      and c.relname in (
        'stripe_webhook_config',
        'stripe_event_processing_capabilities'
      )
      and c.relkind in ('r', 'p')
    order by c.relname`;
  if (
    privateTables.length !== 2 ||
    privateTables.some(
      (table) =>
        !table.rls_enabled ||
        table.owner_name === APP_ROLE ||
        table.app_has_table_access ||
        !table.current_admin_can_configure,
    )
  ) {
    throw new Error("Stripe private-table ownership, RLS, or grants are unsafe");
  }

  const signatures = [
    ["private.claim_stripe_event_receipt(text,text,boolean,text)", false],
    ["private.complete_stripe_checkout_session(text,text,uuid,text,text,integer,text)", false],
    ["private.complete_stripe_invoice_paid(text,text,uuid,text,text,integer,text)", false],
    ["private.complete_stripe_payment_failed(text,text,uuid,text,text)", false],
    ["private.finish_stripe_event_receipt(text,text,text,text)", false],
    ["private.consume_verified_stripe_capability(uuid)", false],
    ["private.verify_and_claim_stripe_event(text,text)", true],
    ["private.complete_verified_stripe_event(uuid)", true],
    ["private.ignore_verified_stripe_event(uuid)", true],
    ["private.fail_verified_stripe_event(uuid,text)", true],
  ];
  for (const [signature, expectedExecute] of signatures) {
    const [permission] = await sql`
      select to_regprocedure(${signature}) is not null as function_exists,
        case when to_regprocedure(${signature}) is null then false
          else has_function_privilege(
            ${APP_ROLE}, to_regprocedure(${signature}), 'EXECUTE'
          )
        end as app_can_execute`;
    if (
      !permission.function_exists ||
      permission.app_can_execute !== expectedExecute
    ) {
      throw new Error(`Unexpected runtime execute boundary for ${signature}`);
    }
  }

  console.log(
    `Stripe webhook readiness PASS: DB signature verification is configured for ${expectedLivemode ? "live" : "test"} mode with ${configuration.signature_tolerance_seconds}s signature and ${configuration.capability_ttl_seconds}s capability bounds.`,
  );
} finally {
  await sql.end({ timeout: 5 });
}
