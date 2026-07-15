import assert from "node:assert/strict";
import test from "node:test";

import {
  arrivalWindowForStartMinutes,
  assessServiceRadius,
  canSendLateArrivalUpdate,
  evaluateLocalSchedule,
  feasibleArrivalWindows,
  haversineMiles,
  lateArrivalMessage,
  rescheduleProposalExpiry,
} from "./field-operations.ts";

test("arrival-window lookup is half-open except for the four PM branch cutoff", () => {
  assert.equal(arrivalWindowForStartMinutes(8 * 60)?.id, "08:00-10:00");
  assert.equal(arrivalWindowForStartMinutes(10 * 60)?.id, "10:00-12:00");
  assert.equal(arrivalWindowForStartMinutes(16 * 60)?.id, "14:00-16:00");
  assert.equal(arrivalWindowForStartMinutes(16 * 60 + 1), null);
});

test("a long visit keeps the latest feasible midday window without forcing morning", () => {
  const windows = feasibleArrivalWindows(6 * 60);
  assert.deepEqual(
    windows.filter((window) => window.eligible).map((window) => window.id),
    ["08:00-10:00", "10:00-12:00", "12:00-14:00"],
  );
  assert.equal(windows[2].latestStartMinutes, 13 * 60);
  assert.equal(windows[3].eligible, false);
});

test("short work can use the afternoon window but cannot arrive after four", () => {
  const windows = feasibleArrivalWindows(2 * 60);
  assert.equal(windows.at(-1)?.eligible, true);
  assert.equal(windows.at(-1)?.latestStartMinutes, 16 * 60);
  assert.deepEqual(evaluateLocalSchedule(16 * 60 + 1, 18 * 60).eligible, false);
});

test("the seven PM finish is a hard scheduling blocker", () => {
  const result = evaluateLocalSchedule(14 * 60, 19 * 60 + 1);
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.some((blocker) => blocker.includes("hard finish")));
});

test("work longer than one operating day exposes no false arrival window", () => {
  assert.equal(feasibleArrivalWindows(12 * 60).some((window) => window.eligible), false);
});

test("radius assessment flags rather than rejects an out-of-area request", () => {
  const outside = assessServiceRadius(32.4, 30);
  assert.equal(outside.status, "outside_standard_radius");
  assert.equal(outside.flagged, true);
  assert.match(outside.explanation, /remains open/);
  assert.equal(assessServiceRadius(null, 30).status, "manual_review");
});

test("straight-line distance is available as a provider-independent fallback", () => {
  const miles = haversineMiles(
    { latitude: 47.6777, longitude: -116.7805 },
    { latitude: 47.7178, longitude: -116.9516 },
  );
  assert.ok(miles > 7 && miles < 10);
});

test("audited late templates remain bounded and customer-safe", () => {
  assert.equal(
    lateArrivalMessage(15, "Avery"),
    "Hi Avery, your Lake & Pine team is running about 15 minutes behind. We’ll keep you updated here. Your service scope remains unchanged.",
  );
});

test("late templates cannot be sent for a future confirmed visit", () => {
  const start = "2030-08-05T16:00:00.000Z";
  const end = "2030-08-05T19:00:00.000Z";
  assert.equal(
    canSendLateArrivalUpdate(
      "confirmed",
      start,
      end,
      Date.parse("2030-08-04T16:00:00.000Z"),
    ),
    false,
  );
  assert.equal(
    canSendLateArrivalUpdate(
      "confirmed",
      start,
      end,
      Date.parse("2030-08-05T15:30:00.000Z"),
    ),
    true,
  );
  assert.equal(
    canSendLateArrivalUpdate(
      "en_route",
      start,
      end,
      Date.parse("2030-08-04T16:00:00.000Z"),
    ),
    true,
  );
});

test("a reschedule offer expires before either the old or replacement start", () => {
  assert.equal(
    rescheduleProposalExpiry(
      "2030-08-05T16:00:00.000Z",
      "2030-08-07T16:00:00.000Z",
    ),
    "2030-08-05T16:00:00.000Z",
  );
  assert.equal(
    rescheduleProposalExpiry(
      "2030-08-07T16:00:00.000Z",
      "2030-08-05T16:00:00.000Z",
    ),
    "2030-08-05T16:00:00.000Z",
  );
});
