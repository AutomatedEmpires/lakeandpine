import assert from "node:assert/strict";
import test from "node:test";

import {
  getRuntimeSmokeDisposition,
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

  assert.equal(getRuntimeSmokeDisposition(headers, TOKEN), "authorized");
});
