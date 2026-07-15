import postgres from "postgres";

import { requireEnv } from "./env";

export const DATABASE_RUNTIME_ROLE =
  process.env.DATABASE_RUNTIME_ROLE?.trim() || "lakeandpine_app";

if (!/^[a-z_][a-z0-9_]{0,62}$/.test(DATABASE_RUNTIME_ROLE)) {
  throw new Error("DATABASE_RUNTIME_ROLE must be a valid PostgreSQL role name");
}

type SqlClient = ReturnType<typeof postgres>;

// One pool per server process; dev HMR reuses the instance stashed on globalThis.
// Creation is deliberately lazy: Next.js imports route modules while collecting
// build metadata, and a hermetic build must not require or contact a runtime DB.
const globalForDb = globalThis as unknown as { __lpSql?: SqlClient };
let moduleSql = globalForDb.__lpSql;

function createSqlClient(): SqlClient {
  return postgres(requireEnv("DATABASE_URL"), {
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
}

export function getSql(): SqlClient {
  if (moduleSql) return moduleSql;
  const client = createSqlClient();
  moduleSql = client;
  if (process.env.NODE_ENV !== "production") {
    globalForDb.__lpSql = client;
  }
  return client;
}

const lazySqlTarget = (() => undefined) as unknown as SqlClient;

// Preserve postgres.js's callable tagged-template API and its methods (`begin`,
// `unsafe`, `json`, and friends) without instantiating the pool at import time.
export const sql = new Proxy(lazySqlTarget, {
  apply(_target, _thisArg, argumentsList) {
    const client = getSql();
    return Reflect.apply(client, client, argumentsList);
  },
  get(_target, property) {
    const client = getSql();
    const value = Reflect.get(client, property, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as SqlClient;

export function jsonb(value: unknown) {
  return sql.json(value as postgres.JSONValue);
}
