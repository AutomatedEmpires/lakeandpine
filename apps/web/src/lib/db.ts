import postgres from "postgres";

import { requireEnv } from "./env";

// One pool per server process; dev HMR reuses the instance stashed on globalThis.
const globalForDb = globalThis as unknown as { __lpSql?: ReturnType<typeof postgres> };

export const sql =
  globalForDb.__lpSql ??
  postgres(requireEnv("DATABASE_URL"), {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // safe with transaction-pooled Supabase connections at go-live
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__lpSql = sql;
}

export function jsonb(value: unknown) {
  return sql.json(value as postgres.JSONValue);
}
