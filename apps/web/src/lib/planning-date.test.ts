import assert from "node:assert/strict";
import test from "node:test";

import {
  getPlanningDateBounds,
  isPlanningDateAllowed,
} from "./planning-date.ts";

test("planning bounds follow the Los Angeles calendar day", () => {
  assert.deepEqual(
    getPlanningDateBounds(new Date("2026-07-14T06:59:59.000Z")),
    { min: "2026-07-13", max: "2028-01-13" },
  );
  assert.deepEqual(
    getPlanningDateBounds(new Date("2026-07-14T07:00:00.000Z")),
    { min: "2026-07-14", max: "2028-01-14" },
  );
});

test("planning bounds add 18 calendar months and clamp month-end", () => {
  assert.deepEqual(
    getPlanningDateBounds(new Date("2025-08-31T19:00:00.000Z")),
    { min: "2025-08-31", max: "2027-02-28" },
  );
});

test("planning dates must round-trip as real calendar dates inside the horizon", () => {
  const bounds = { min: "2026-07-14", max: "2028-01-14" };
  assert.equal(isPlanningDateAllowed("2026-07-14", bounds), true);
  assert.equal(isPlanningDateAllowed("2028-01-14", bounds), true);
  assert.equal(isPlanningDateAllowed("2026-02-30", bounds), false);
  assert.equal(isPlanningDateAllowed("2026-7-14", bounds), false);
  assert.equal(isPlanningDateAllowed("2026-07-13", bounds), false);
  assert.equal(isPlanningDateAllowed("2028-01-15", bounds), false);
});
