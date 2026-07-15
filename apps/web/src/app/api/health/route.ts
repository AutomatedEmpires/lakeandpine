import { NextResponse } from "next/server";

import { DATABASE_RUNTIME_ROLE, sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [database] = await sql<
      {
        database_role: string;
        planning_schema_ready: boolean;
        field_schema_ready: boolean;
      }[]
    >`select current_user as database_role,
        to_regclass('public.job_schedules') is not null
        and to_regclass('public.service_cases') is not null
        and to_regclass('public.cleaner_availability_rules') is not null
        as planning_schema_ready,
        to_regclass('public.team_job_allocations') is not null
        and to_regclass('public.service_location_assessments') is not null
        and to_regclass('public.schedule_proposals') is not null
        and to_regclass('public.job_communications') is not null
        and to_regclass('public.job_issue_reports') is not null
        and to_regclass('public.team_duty_assignments') is not null
        and to_regprocedure('private.current_customer_job_assignments()') is not null
        and to_regprocedure('private.current_cleaner_duty_coverage()') is not null
        and to_regprocedure('private.create_public_service_case(text,text,text,text,jsonb,text,date,date,jsonb)') is not null
        as field_schema_ready`;
    if (
      database?.database_role !== DATABASE_RUNTIME_ROLE ||
      !database.planning_schema_ready ||
      !database.field_schema_ready
    ) {
      throw new Error("Database role or planning schema is not ready");
    }
    // Exercise RLS-bound privileges against critical operational relations.
    await sql`select id from job_schedules limit 0`;
    await sql`select id from service_cases limit 0`;
    await sql`select id from team_job_allocations limit 0`;
    await sql`select id from service_location_assessments limit 0`;
    await sql`select id from schedule_proposals limit 0`;
    await sql`select id from job_communications limit 0`;
    await sql`select id from job_issue_reports limit 0`;
    await sql`select id from team_duty_assignments limit 0`;
    return NextResponse.json(
      { status: "ready", databaseRole: database.database_role },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
