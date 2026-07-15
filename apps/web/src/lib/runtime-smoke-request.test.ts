import assert from "node:assert/strict";
import test from "node:test";

import {
  getRuntimeSmokeDisposition,
  isSafeRuntimeSmokeDatabase,
  RUNTIME_SMOKE_HEADER,
} from "./runtime-smoke-request.ts";

const TOKEN = "runtime-smoke-token-32-characters-minimum";

test("ordinary requests do not enter smoke mode", () => {
  assert.equal(getRuntimeSmokeDisposition(new Headers(), TOKEN), "ordinary");
});

test("smoke markers fail closed when the server token is absent or weak", () => {
  const headers = new Headers({ [RUNTIME_SMOKE_HEADER]: TOKEN });

  assert.equal(getRuntimeSmokeDisposition(headers, undefined), "rejected");
  assert.equal(getRuntimeSmokeDisposition(headers, "too-short"), "rejected");
});

test("smoke markers fail closed when the supplied token does not match", () => {
  const headers = new Headers({
    [RUNTIME_SMOKE_HEADER]: `${TOKEN.slice(0, -1)}x`,
  });

  assert.equal(getRuntimeSmokeDisposition(headers, TOKEN), "rejected");
});

test("only a strong matching token authorizes smoke suppression", () => {
  const headers = new Headers({ [RUNTIME_SMOKE_HEADER]: TOKEN });

  assert.equal(
    getRuntimeSmokeDisposition(headers, TOKEN, {
      nodeEnv: "test",
      vercelEnv: undefined,
      allowRuntimeSmoke: "1",
    }),
    "authorized",
  );
});

test("production rejects smoke mode even with the matching token", () => {
  const headers = new Headers({ [RUNTIME_SMOKE_HEADER]: TOKEN });

  assert.equal(
    getRuntimeSmokeDisposition(headers, TOKEN, {
      nodeEnv: "production",
      vercelEnv: undefined,
      allowRuntimeSmoke: "1",
    }),
    "rejected",
  );
});

test("smoke database handshake requires the same safe local database", () => {
  assert.equal(
    isSafeRuntimeSmokeDatabase({
      headerDatabase: "lakeandpine_proof",
      configuredDatabase: "lakeandpine_proof",
      connectedDatabase: "lakeandpine_proof",
      databaseUrl: "postgres://user:pass@127.0.0.1:55445/lakeandpine_proof",
      allowRemoteDatabase: false,
    }),
    true,
  );
  assert.equal(
    isSafeRuntimeSmokeDatabase({
      headerDatabase: "lakeandpine_proof",
      configuredDatabase: "lakeandpine_proof",
      connectedDatabase: "postgres",
      databaseUrl: "postgres://user:pass@production.example/postgres",
      allowRemoteDatabase: false,
    }),
    false,
  );
});
