import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBoundedCrewGroups,
  cleanerMeetsIndividualSchedulingConstraints,
  estimateJobDuration,
  evaluateAssignment,
  rankAssignmentSuggestions,
  requiredElapsedMinutes,
  type AssignmentCandidate,
  type CleanerCapacity,
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
      assignedJobsToday: 0,
      assignedMinutesToday: 0,
      assignedMinutesThisWeek: 480,
      maxDailyJobs: 3,
      maxDailyMinutes: 540,
      maxWeeklyMinutes: 2_400,
    })),
    ...overrides,
  };
}

function cleaner(
  id: string,
  overrides: Partial<CleanerCapacity> = {},
): CleanerCapacity {
  return {
    ...candidate().cleaners[0],
    id,
    skills: [],
    assignedMinutesThisWeek: 0,
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

test("converts labor into a whole 30-minute crew window", () => {
  assert.equal(requiredElapsedMinutes(1_260, 4), 330);
  assert.equal(requiredElapsedMinutes(600, 2), 300);
  assert.throws(() => requiredElapsedMinutes(600, 0));
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

test("rejects a cleaner who has reached the daily job-count cap", () => {
  const result = evaluateAssignment(
    job,
    candidate({
      cleaners: candidate().cleaners.map((cleaner, index) =>
        index === 0
          ? { ...cleaner, assignedJobsToday: 3, maxDailyJobs: 3 }
          : cleaner,
      ),
    }),
  );

  assert.equal(result.eligible, false);
  assert.ok(
    result.blockers.includes("Cleaner cleaner-a would exceed daily job capacity"),
  );
});

test("filters hard-blocked cleaners before bounding the crew search", () => {
  const singleCleanerJob = {
    ...job,
    requiredCrewSize: 1,
    requiredSkills: ["estate_detail"],
  };
  const blocked = Array.from({ length: 18 }, (_, index) =>
    cleaner(`blocked-${index + 1}`, {
      skills: ["estate_detail"],
      availability: [],
    }),
  );
  const eligible = cleaner("eligible-19", { skills: ["estate_detail"] });

  assert.equal(
    cleanerMeetsIndividualSchedulingConstraints(singleCleanerJob, blocked[0], 30),
    false,
  );
  const groups = buildBoundedCrewGroups({
    job: singleCleanerJob,
    acceptedCleaners: [],
    availableCleaners: [...blocked, eligible],
    travelBufferMinutes: 30,
  });

  assert.equal(groups[0][0].id, "eligible-19");
});

test("keeps accepted cleaners fixed independently of the candidate pool", () => {
  const accepted = cleaner("accepted-outside-general-cap", {
    skills: ["delicate_finishes"],
  });
  const available = cleaner("available-partner", {
    skills: ["estate_detail"],
  });
  const groups = buildBoundedCrewGroups({
    job,
    acceptedCleaners: [accepted],
    availableCleaners: [available],
    travelBufferMinutes: 30,
  });

  assert.deepEqual(
    groups[0].map((member) => member.id),
    ["accepted-outside-general-cap", "available-partner"],
  );
});

test("rejects accepted cleaners who now violate a hard scheduling constraint", () => {
  const accepted = cleaner("accepted-on-pto", {
    skills: ["delicate_finishes"],
    timeOff: [{
      start: "2026-07-20T10:00:00-07:00",
      end: "2026-07-20T12:00:00-07:00",
    }],
  });
  const groups = buildBoundedCrewGroups({
    job,
    acceptedCleaners: [accepted],
    availableCleaners: [cleaner("available-partner", { skills: ["estate_detail"] })],
    travelBufferMinutes: 30,
  });

  assert.deepEqual(groups, []);
});

test("bounded pruning preserves requested continuity within equal skill coverage", () => {
  const oneCleanerJob: SchedulingJob = {
    ...job,
    requiredCrewSize: 1,
    requiredSkills: ["estate_detail"],
    recurringCleanerIds: ["recurring-request"],
    preferredCleanerIds: [],
  };
  const recurring = cleaner("recurring-request", {
    skills: ["estate_detail"],
    verticalExperience: [],
    assignedMinutesThisWeek: 2_000,
  });
  const otherwiseHigher = cleaner("otherwise-higher", {
    skills: ["estate_detail"],
    verticalExperience: ["estate"],
    assignedMinutesThisWeek: 0,
  });
  const recurringGroups = buildBoundedCrewGroups({
    job: oneCleanerJob,
    acceptedCleaners: [],
    availableCleaners: [otherwiseHigher, recurring],
    travelBufferMinutes: 30,
  });
  assert.equal(recurringGroups[0][0].id, "recurring-request");

  const preferredGroups = buildBoundedCrewGroups({
    job: {
      ...oneCleanerJob,
      recurringCleanerIds: [],
      preferredCleanerIds: ["preferred-request"],
    },
    acceptedCleaners: [],
    availableCleaners: [
      otherwiseHigher,
      { ...recurring, id: "preferred-request" },
    ],
    travelBufferMinutes: 30,
  });
  assert.equal(preferredGroups[0][0].id, "preferred-request");
});

test("finds complementary skills beyond the first 2,000 lexical combinations", () => {
  const requiredSkills = ["skill-a", "skill-b", "skill-c", "skill-d"];
  const largeCrewJob = {
    ...job,
    requiredCrewSize: 4,
    requiredSkills,
  };
  const generalists = Array.from({ length: 14 }, (_, index) =>
    cleaner(`cleaner-${String(index + 1).padStart(2, "0")}`),
  );
  const specialists = requiredSkills.map((skill, index) =>
    cleaner(`cleaner-${index + 15}`, { skills: [skill] }),
  );
  const groups = buildBoundedCrewGroups({
    job: largeCrewJob,
    acceptedCleaners: [],
    availableCleaners: [...generalists, ...specialists],
    travelBufferMinutes: 30,
    limit: 2_000,
  });
  const covered = new Set(groups[0].flatMap((member) => member.skills));

  assert.ok(requiredSkills.every((skill) => covered.has(skill)));
  assert.deepEqual(
    groups[0].map((member) => member.id).sort(),
    specialists.map((member) => member.id).sort(),
  );
});

test("bounds a ten-person, ten-skill search without losing specialists", () => {
  const requiredSkills = Array.from({ length: 10 }, (_, index) =>
    `specialty-${index + 1}`,
  );
  const largeCrewJob = {
    ...job,
    requiredCrewSize: 10,
    requiredSkills,
  };
  const cleaners = [
    ...Array.from({ length: 15 }, (_, index) => cleaner(`general-${index + 1}`)),
    ...requiredSkills.map((skill, index) =>
      cleaner(`specialist-${index + 1}`, { skills: [skill] }),
    ),
  ];

  const groups = buildBoundedCrewGroups({
    job: largeCrewJob,
    acceptedCleaners: [],
    availableCleaners: cleaners,
    travelBufferMinutes: 30,
  });
  const covered = new Set(groups[0].flatMap((member) => member.skills));

  assert.ok(requiredSkills.every((skill) => covered.has(skill)));
  assert.equal(groups[0].length, 10);
});
