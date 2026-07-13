import { NextResponse } from "next/server";

import { DATABASE_RUNTIME_ROLE, sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [database] = await sql<
      { database_role: string; planning_schema_ready: boolean }[]
    >`select current_user as database_role,
        to_regclass('public.job_schedules') is not null
        and to_regclass('public.service_cases') is not null
        and to_regclass('public.cleaner_availability_rules') is not null
        as planning_schema_ready`;
    if (
      database?.database_role !== DATABASE_RUNTIME_ROLE ||
      !database.planning_schema_ready
    ) {
      throw new Error("Database role or planning schema is not ready");
    }
    // Exercise RLS-bound privileges against critical operational relations.
    await sql`select id from job_schedules limit 0`;
    await sql`select id from service_cases limit 0`;
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
