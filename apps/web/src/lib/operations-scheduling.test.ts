import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateJobDuration,
  evaluateAssignment,
  rankAssignmentSuggestions,
  type AssignmentCandidate,
  type SchedulingJob,
} from "./operations-scheduling.ts";

const job: SchedulingJob = {
  id: "job-estate-1",
  vertical: "estate",
  territoryId: "territory-north",
  start: "2026-07-20T09:00:00-07:00",
  end: "2026-07-20T13:00:00-07:00",
  requiredCrewSize: 2,
  requiredSkills: ["delicate_finishes", "estate_detail"],
  qualificationApproved: true,
  safeAccessReady: true,
  utilitiesReady: true,
  finishRestrictionsAcknowledged: true,
  recurringCleanerIds: ["cleaner-a"],
  preferredCleanerIds: ["cleaner-a"],
};

function candidate(overrides: Partial<AssignmentCandidate> = {}): AssignmentCandidate {
  return {
    id: "team-pine",
    territoryIds: ["territory-north"],
    estimatedTravelMinutes: 15,
    travelBufferMinutes: 30,
    cleaners: ["cleaner-a", "cleaner-b"].map((id) => ({
      id,
      active: true,
      skills: id === "cleaner-a" ? ["delicate_finishes"] : ["estate_detail"],
      verticalExperience: ["estate"],
      availability: [{ start: "2026-07-20T08:00:00-07:00", end: "2026-07-20T17:00:00-07:00" }],
      timeOff: [],
      assignments: [],
      assignedMinutesToday: 0,
      assignedMinutesThisWeek: 480,
      maxDailyMinutes: 540,
      maxWeeklyMinutes: 2_400,
    })),
    ...overrides,
  };
}

test("estimates premium labor and flags walkthrough-scale work", () => {
  const estate = estimateJobDuration({
    vertical: "estate",
    squareFeet: 6_500,
    serviceUnits: 2,
    complexity: "detailed",
    crewSize: 3,
  });

  assert.equal(estate.requiresWalkthrough, true);
  assert.ok(estate.laborMinutes > estate.elapsedMinutes);
  assert.equal(estate.elapsedMinutes % 30, 0);
});

test("rejects assignments when any hard access or capacity rule fails", () => {
  const blocked = evaluateAssignment(
    { ...job, vertical: "marine", dockAccessReady: false },
    candidate({
      cleaners: candidate().cleaners.map((cleaner, index) =>
        index === 0
          ? { ...cleaner, assignments: [{ start: "2026-07-20T08:30:00-07:00", end: "2026-07-20T09:00:00-07:00" }] }
          : cleaner,
      ),
    }),
  );

  assert.equal(blocked.eligible, false);
  assert.ok(blocked.blockers.includes("Dock or vessel access is not confirmed"));
  assert.ok(blocked.blockers.some((reason) => reason.includes("travel buffer")));
});

test("scores continuity, experience, travel, and balanced capacity after feasibility", () => {
  const preferred = candidate();
  const distant = candidate({
    id: "team-cedar",
    estimatedTravelMinutes: 55,
    cleaners: candidate().cleaners.map((cleaner) => ({
      ...cleaner,
      id: `${cleaner.id}-other`,
      assignedMinutesThisWeek: 1_800,
    })),
  });

  const ranked = rankAssignmentSuggestions(job, [distant, preferred]);
  assert.equal(ranked[0].candidateId, "team-pine");
  assert.equal(ranked[0].eligible, true);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[0].reasons.includes("Preserves recurring crew continuity"));
});

test("construction work cannot be suggested before site readiness", () => {
  const result = evaluateAssignment(
    { ...job, vertical: "construction", constructionReady: false },
    candidate(),
  );

  assert.equal(result.eligible, false);
  assert.ok(result.blockers.includes("Construction readiness is not confirmed"));
});

test("rejects malformed or reversed work intervals", () => {
  const result = evaluateAssignment(
    { ...job, start: "2026-07-20T13:00:00-07:00", end: "2026-07-20T09:00:00-07:00" },
    candidate(),
  );

  assert.equal(result.eligible, false);
  assert.ok(result.blockers.includes("Job start and end must define a valid positive interval"));
});
