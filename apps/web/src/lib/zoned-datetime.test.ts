import assert from "node:assert/strict";
import test from "node:test";

import { localDateTimeToUtc } from "./zoned-datetime.ts";

test("converts territory wall-clock time without using the server timezone", () => {
  assert.equal(
    localDateTimeToUtc("2026-07-20T09:00", "America/Los_Angeles"),
    "2026-07-20T16:00:00.000Z",
  );
  assert.equal(
    localDateTimeToUtc("2026-01-20T09:00", "America/Los_Angeles"),
    "2026-01-20T17:00:00.000Z",
  );
});

test("rejects nonexistent and ambiguous daylight-saving wall-clock times", () => {
  assert.throws(
    () => localDateTimeToUtc("2026-03-08T02:30", "America/Los_Angeles"),
    /does not exist/,
  );
  assert.throws(
    () => localDateTimeToUtc("2026-11-01T01:30", "America/Los_Angeles"),
    /occurs twice/,
  );
});

test("rejects malformed dates and unknown territory timezones", () => {
  assert.throws(
    () => localDateTimeToUtc("2026-02-30T09:00", "America/Los_Angeles"),
    /invalid/,
  );
  assert.throws(
    () => localDateTimeToUtc("2026-07-20T09:00", "Not/A_Zone"),
    /timezone is invalid/,
  );
});
