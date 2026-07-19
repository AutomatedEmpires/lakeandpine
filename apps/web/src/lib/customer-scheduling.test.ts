import assert from "node:assert/strict";
import test from "node:test";

import type { AssignmentCandidate, CleanerCapacity } from "./operations-scheduling.ts";
import {
  classifySchedulingRequest,
  projectCapacityBackedAvailability,
  type SchedulingPolicy,
  type SchedulingScope,
} from "./customer-scheduling.ts";

const scope: SchedulingScope = {
  program: "estate",
  postalCode: "83814",
  context: "primary_home",
  sizeBand: "standard",
  condition: "maintained",
  cadence: "project",
  zoneCount: 6,
  siteReady: true,
  accessComplex: false,
  finishSensitive: false,
  finishRestrictionsAcknowledged: true,
};

const policy: SchedulingPolicy = {
  id: "policy-estate-cda",
  version: 3,
  status: "active",
  territoryId: "territory-cda",
  territoryTimeZone: "America/Los_Angeles",
  serviceId: "estate",
  schedulingPath: "direct",
  conditionKey: null,
  conditionLabel: null,
  allowedContexts: ["primary_home"],
  allowedSizeBands: ["compact", "standard"],
  allowedConditions: ["maintained"],
  allowedCadences: ["project", "weekly"],
  laborMinutes: 240,
  requiredCrewSize: 1,
  requiredSkills: ["estate-care", "finish-awareness"],
  travelBufferMinutes: 30,
  minimumLeadHours: 24,
  horizonDays: 35,
  operatingStart: "09:00:00",
  operatingEnd: "23:00:00",
  selectionHoldMinutes: 15,
  conditionalHoldMinutes: 1440,
};

function cleaner(overrides: Partial<CleanerCapacity> = {}): CleanerCapacity {
  return {
    id: "private-cleaner-id",
    active: true,
    skills: ["estate-care", "finish-awareness"],
    verticalExperience: ["estate"],
    availability: [{ start: "2026-07-21T16:00:00.000Z", end: "2026-07-22T00:00:00.000Z" }],
    timeOff: [],
    assignments: [],
    assignedJobsToday: 0,
    assignedMinutesToday: 0,
    assignedMinutesThisWeek: 0,
    maxDailyJobs: 3,
    maxDailyMinutes: 480,
    maxWeeklyMinutes: 2400,
    ...overrides,
  };
}

function candidate(member = cleaner()): AssignmentCandidate {
  return {
    id: "private-team-candidate",
    territoryIds: [policy.territoryId],
    cleaners: [member],
    estimatedTravelMinutes: 10,
    travelBufferMinutes: 30,
  };
}

test("classifies standardized scope as direct only with active policy and territory", () => {
  assert.equal(
    classifySchedulingRequest({ scope, territoryEligible: true, policy }).path,
    "direct",
  );
  assert.equal(
    classifySchedulingRequest({ scope, territoryEligible: false, policy }).path,
    "unsupported_territory",
  );
  assert.equal(
    classifySchedulingRequest({ scope, territoryEligible: true, policy: null }).path,
    "consultation",
  );
  assert.equal(
    classifySchedulingRequest({
      scope,
      territoryEligible: true,
      policy: { ...policy, status: "draft" },
    }).path,
    "consultation",
  );
});

test("routes exceptional or access-complex work to consultation", () => {
  assert.equal(
    classifySchedulingRequest({
      scope: { ...scope, sizeBand: "exceptional" },
      territoryEligible: true,
      policy,
    }).path,
    "consultation",
  );
  const access = classifySchedulingRequest({
    scope: { ...scope, accessComplex: true },
    territoryEligible: true,
    policy,
  });
  assert.equal(access.path, "consultation");
  assert.match(access.publicReason, /Access or safety/);
});

test("keeps conditional holds distinct from consultation", () => {
  const holdPolicy: SchedulingPolicy = {
    ...policy,
    schedulingPath: "conditional_hold",
    conditionKey: "property_photo_review",
    conditionLabel: "Property photos need operator review",
  };
  const result = classifySchedulingRequest({
    scope,
    territoryEligible: true,
    policy: holdPolicy,
  });
  assert.equal(result.path, "conditional_hold");
  assert.equal(result.conditionKey, "property_photo_review");
});

test("projects only slots backed by the operator assignment engine", () => {
  const projection = projectCapacityBackedAvailability({
    scope,
    territoryEligible: true,
    policy,
    now: "2026-07-19T12:00:00.000Z",
    slots: [
      {
        id: "opaque-slot-a",
        start: "2026-07-21T16:00:00.000Z",
        end: "2026-07-21T20:00:00.000Z",
        arrivalWindow: "9:00 AM–1:00 PM",
        candidates: [candidate()],
      },
      {
        id: "opaque-slot-b",
        start: "2026-07-21T20:00:00.000Z",
        end: "2026-07-22T00:00:00.000Z",
        arrivalWindow: "1:00 PM–5:00 PM",
        candidates: [candidate(cleaner({ timeOff: [{ start: "2026-07-21T19:00:00.000Z", end: "2026-07-22T01:00:00.000Z" }] }))],
      },
    ],
  });
  assert.equal(projection.classification.path, "direct");
  assert.deepEqual(projection.publicSlots.map((slot) => slot.id), ["opaque-slot-a"]);
  assert.equal(projection.internalEvidence[0].candidateId, "private-team-candidate");
});

test("does not leak workforce-private capacity evidence publicly", () => {
  const projection = projectCapacityBackedAvailability({
    scope,
    territoryEligible: true,
    policy,
    now: "2026-07-19T12:00:00.000Z",
    slots: [{
      id: "opaque-slot-a",
      start: "2026-07-21T16:00:00.000Z",
      end: "2026-07-21T20:00:00.000Z",
      arrivalWindow: "9:00 AM–1:00 PM",
      candidates: [candidate()],
    }],
  });
  const publicPayload = JSON.stringify(projection.publicSlots);
  assert.doesNotMatch(publicPayload, /private-cleaner-id|private-team-candidate|score|skills/);
});

test("projects slot dates in territory time instead of UTC", () => {
  const projection = projectCapacityBackedAvailability({
    scope,
    territoryEligible: true,
    policy,
    now: "2026-07-19T12:00:00.000Z",
    slots: [{
      id: "opaque-slot-evening",
      start: "2026-07-22T02:00:00.000Z",
      end: "2026-07-22T06:00:00.000Z",
      arrivalWindow: "7:00 PM–11:00 PM",
      candidates: [candidate(cleaner({
        availability: [{ start: "2026-07-22T01:00:00.000Z", end: "2026-07-22T07:00:00.000Z" }],
      }))],
    }],
  });
  assert.equal(projection.publicSlots[0].date, "2026-07-21");
});

test("filters slots outside authoritative policy timing and blackout facts", () => {
  const projection = projectCapacityBackedAvailability({
    scope,
    territoryEligible: true,
    policy,
    now: "2026-07-19T12:00:00.000Z",
    blackoutWindows: [{
      start: "2026-07-21T15:30:00.000Z",
      end: "2026-07-21T20:30:00.000Z",
    }],
    slots: [
      {
        id: "blackout-slot",
        start: "2026-07-21T16:00:00.000Z",
        end: "2026-07-21T20:00:00.000Z",
        arrivalWindow: "9:00 AM–1:00 PM",
        candidates: [candidate()],
      },
      {
        id: "wrong-duration-slot",
        start: "2026-07-22T16:00:00.000Z",
        end: "2026-07-22T18:00:00.000Z",
        arrivalWindow: "9:00 AM–11:00 AM",
        candidates: [candidate(cleaner({
          availability: [{ start: "2026-07-22T15:00:00.000Z", end: "2026-07-22T20:00:00.000Z" }],
        }))],
      },
    ],
  });
  assert.equal(projection.publicSlots.length, 0);
  assert.equal(projection.classification.path, "no_capacity");
});

test("reports no capacity without mislabeling the scope as consultation", () => {
  const projection = projectCapacityBackedAvailability({
    scope,
    territoryEligible: true,
    policy,
    now: "2026-07-19T12:00:00.000Z",
    slots: [{
      id: "opaque-slot-a",
      start: "2026-07-21T16:00:00.000Z",
      end: "2026-07-21T20:00:00.000Z",
      arrivalWindow: "9:00 AM–1:00 PM",
      candidates: [candidate(cleaner({ active: false }))],
    }],
  });
  assert.equal(projection.publicSlots.length, 0);
  assert.equal(projection.classification.path, "no_capacity");
  assert.match(projection.classification.publicReason, /No capacity-backed times/);
});
