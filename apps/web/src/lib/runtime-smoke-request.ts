import { timingSafeEqual } from "node:crypto";

export const RUNTIME_SMOKE_HEADER = "x-lake-pine-runtime-smoke-token";
export const RUNTIME_SMOKE_DATABASE_HEADER =
  "x-lake-pine-runtime-smoke-database";
export const MIN_RUNTIME_SMOKE_TOKEN_LENGTH = 32;

export type RuntimeSmokeDisposition = "ordinary" | "authorized" | "rejected";

// A smoke marker is never trusted on its own. If a caller presents the header,
// the server must also have a sufficiently strong token and the values must
// match. Rejected smoke requests stop before database writes or email delivery.
export function getRuntimeSmokeDisposition(
  headers: Pick<Headers, "get">,
  configuredToken = process.env.RUNTIME_SMOKE_TOKEN,
  deployment = {
    nodeEnv: process.env.NODE_ENV,
    vercelEnv: process.env.VERCEL_ENV,
    allowRuntimeSmoke: process.env.LAKEANDPINE_ALLOW_RUNTIME_SMOKE,
  },
): RuntimeSmokeDisposition {
  const providedToken = headers.get(RUNTIME_SMOKE_HEADER);
  if (providedToken === null) return "ordinary";

  if (
    deployment.nodeEnv === "production" ||
    deployment.vercelEnv === "production" ||
    deployment.allowRuntimeSmoke !== "1"
  ) {
    return "rejected";
  }

  if (
    !configuredToken ||
    configuredToken.length < MIN_RUNTIME_SMOKE_TOKEN_LENGTH ||
    providedToken.length < MIN_RUNTIME_SMOKE_TOKEN_LENGTH
  ) {
    return "rejected";
  }

  const expected = Buffer.from(configuredToken);
  const provided = Buffer.from(providedToken);
  if (expected.length !== provided.length) return "rejected";

  return timingSafeEqual(expected, provided) ? "authorized" : "rejected";
}

export function isSafeRuntimeSmokeDatabase(input: {
  headerDatabase: string | null;
  configuredDatabase: string | undefined;
  connectedDatabase: string;
  databaseUrl: string | undefined;
  allowRemoteDatabase: boolean;
}) {
  if (
    !input.headerDatabase ||
    !input.configuredDatabase ||
    input.headerDatabase !== input.configuredDatabase ||
    input.connectedDatabase !== input.configuredDatabase ||
    !/(?:^|[_-])(proof|test|testing|dev|development|local|preview|smoke)(?:$|[_-])/i.test(
      input.connectedDatabase,
    ) ||
    !input.databaseUrl
  ) {
    return false;
  }
  try {
    const hostname = new URL(input.databaseUrl).hostname;
    return (
      ["127.0.0.1", "localhost", "::1"].includes(hostname) ||
      input.allowRemoteDatabase
    );
  } catch {
    return false;
  }
}
