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
