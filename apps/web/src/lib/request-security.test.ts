import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPrivateRequestKey,
  fixedWindowStart,
  isHoneypotFilled,
  readJsonBody,
  RequestBodyError,
} from "./request-security.ts";

const secret = "a-private-request-fingerprint-secret-that-is-long-enough";

test("request keys are stable, scoped, and contain no raw address", () => {
  const headers = new Headers({
    "x-forwarded-for": "203.0.113.9, 10.0.0.1",
    "user-agent": "test-browser",
  });
  const bookingKey = buildPrivateRequestKey(headers, "booking", secret);

  assert.equal(bookingKey, buildPrivateRequestKey(headers, "booking", secret));
  assert.notEqual(bookingKey, buildPrivateRequestKey(headers, "support", secret));
  assert.equal(bookingKey.length, 64);
  assert.equal(bookingKey.includes("203.0.113.9"), false);
});

test("request keys cannot be reset by rotating user agents", () => {
  const first = new Headers({
    "x-vercel-forwarded-for": "203.0.113.10",
    "user-agent": "browser-a",
  });
  const second = new Headers({
    "x-vercel-forwarded-for": "203.0.113.10",
    "user-agent": "browser-b",
  });
  assert.equal(
    buildPrivateRequestKey(first, "booking", secret),
    buildPrivateRequestKey(second, "booking", secret),
  );
});

test("Vercel's protected forwarding header wins over proxy headers", () => {
  const trusted = new Headers({
    "x-vercel-forwarded-for": "203.0.113.11",
    "x-forwarded-for": "198.51.100.22",
  });
  const direct = new Headers({ "x-forwarded-for": "203.0.113.11" });
  assert.equal(
    buildPrivateRequestKey(trusted, "booking", secret),
    buildPrivateRequestKey(direct, "booking", secret),
  );
});

test("request keys reject weak secrets", () => {
  assert.throws(
    () => buildPrivateRequestKey(new Headers(), "booking", "short"),
    /at least 32 characters/,
  );
});

test("honeypot only triggers on non-empty strings", () => {
  assert.equal(isHoneypotFilled("https://spam.example"), true);
  assert.equal(isHoneypotFilled("  "), false);
  assert.equal(isHoneypotFilled(undefined), false);
});

test("JSON reader enforces declared and actual byte limits", async () => {
  const valid = new Request("https://example.test", {
    method: "POST",
    body: JSON.stringify({ ok: true }),
  });
  assert.deepEqual(await readJsonBody(valid, 100), { ok: true });

  const oversized = new Request("https://example.test", {
    method: "POST",
    body: JSON.stringify({ value: "x".repeat(100) }),
  });
  await assert.rejects(
    () => readJsonBody(oversized, 20),
    (error: unknown) => error instanceof RequestBodyError && error.status === 413,
  );
});

test("fixed windows align without leaking across boundaries", () => {
  assert.equal(
    fixedWindowStart(new Date("2026-07-13T12:34:56.000Z"), 60 * 60 * 1000).toISOString(),
    "2026-07-13T12:00:00.000Z",
  );
});
