import postgres from "postgres";

import { requireEnv } from "./env";

export const DATABASE_RUNTIME_ROLE =
  process.env.DATABASE_RUNTIME_ROLE?.trim() || "lakeandpine_app";

if (!/^[a-z_][a-z0-9_]{0,62}$/.test(DATABASE_RUNTIME_ROLE)) {
  throw new Error("DATABASE_RUNTIME_ROLE must be a valid PostgreSQL role name");
}

// One pool per server process; dev HMR reuses the instance stashed on globalThis.
const globalForDb = globalThis as unknown as { __lpSql?: ReturnType<typeof postgres> };

export const sql =
  globalForDb.__lpSql ??
  postgres(requireEnv("DATABASE_URL"), {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // safe with transaction-pooled Supabase connections at go-live
    // PostgreSQL applies this startup parameter to every physical connection.
    // Production may connect directly as this role; owner-fallback connections
    // also select it explicitly. Every application query therefore runs as the
    // reviewed non-owner, RLS-bound role.
    connection: {
      application_name: "lakeandpine_web",
      role: DATABASE_RUNTIME_ROLE,
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__lpSql = sql;
}

export function jsonb(value: unknown) {
  return sql.json(value as postgres.JSONValue);
}
