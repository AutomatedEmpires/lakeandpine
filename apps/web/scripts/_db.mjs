// Shared helper for ops scripts: loads DATABASE_URL (env first, then
// apps/web/.env.local) and returns a postgres.js client.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

export function getDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
  try {
    const content = readFileSync(envPath, "utf8");
    const match = content.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {}
  throw new Error("DATABASE_URL not set and apps/web/.env.local not found");
}

export function connect() {
  return postgres(getDatabaseUrl(), { max: 1, onnotice: () => {} });
}

export async function assertDevSeedSafety(sql, operation) {
  if (process.env.LAKEANDPINE_ALLOW_DEV_SEED !== "1") {
    throw new Error(
      `${operation} is disabled. Set LAKEANDPINE_ALLOW_DEV_SEED=1 only for an explicitly selected non-production database.`,
    );
  }
  if (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production"
  ) {
    throw new Error(`${operation} is forbidden in production`);
  }
  const expectedDatabase = process.env.LAKEANDPINE_DEV_SEED_DATABASE?.trim();
  if (!expectedDatabase) {
    throw new Error(
      `${operation} requires LAKEANDPINE_DEV_SEED_DATABASE to exactly name the selected disposable database.`,
    );
  }
  if (!/(^|[_-])(ci|test|proof|disposable|dev)([_-]|$)/i.test(expectedDatabase)) {
    throw new Error(
      `${operation} accepts only a database name explicitly marked ci, test, proof, disposable, or dev.`,
    );
  }
  const databaseUrl = new URL(getDatabaseUrl());
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(databaseUrl.hostname)) {
    throw new Error(`${operation} accepts only a loopback DATABASE_URL`);
  }
  const [target] = await sql`
    select current_database() as database_name,
      coalesce(inet_server_addr()::text, 'local-socket') as server_address`;
  if (!target || target.database_name !== expectedDatabase) {
    throw new Error(
      `${operation} database handshake failed; expected ${expectedDatabase}, received ${target?.database_name ?? "no database"}.`,
    );
  }
  console.log(`${operation} target: ${target.database_name} @ ${target.server_address}`);
}
